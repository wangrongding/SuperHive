import { spawn } from "node:child_process";
import { userFsPromises } from "./user-fs.js";
import path from "node:path";
import type { WorktreeDependencies } from "@superhive/protocol";
import { commandFor } from "./windows-command.js";

const { lstat, mkdir, readdir, readlink, rm, stat, symlink } = userFsPromises;

/**
 * 新任务目录的依赖准备：先按锁文件安装（pnpm 用共享 store，几秒就好）；装不上就退回软链主目录的
 * node_modules，并把指向 workspace 内部包的链接改指本任务线，免得测到主目录的旧代码。
 */

export type DependencyManager = NonNullable<WorktreeDependencies["manager"]>;
export type DependencyPlan = { manager: DependencyManager; command: string; args: string[] };
export type DependencyOutcome = Pick<
  WorktreeDependencies,
  "state" | "manager" | "command" | "output"
> & {
  /** 失败或跳过的原因，给 Agent 看 */
  reason?: string;
};

export type InstallResult = { code: number | null; output: string; timedOut?: boolean };
export type InstallRunner = (
  plan: DependencyPlan,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
) => Promise<InstallResult>;

const OUTPUT_TAIL = 4000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;

async function exists(file: string): Promise<boolean> {
  return lstat(file).then(
    () => true,
    () => false,
  );
}

/** 按锁文件选安装命令；都是「只按锁文件装、不改锁文件」的写法。没有锁文件就不装 */
export async function dependencyPlan(dir: string): Promise<DependencyPlan | undefined> {
  const has = (name: string) => exists(path.join(dir, name));
  if (await has("pnpm-lock.yaml"))
    return {
      manager: "pnpm",
      command: "pnpm",
      args: ["install", "--frozen-lockfile", "--prefer-offline"],
    };
  if ((await has("bun.lock")) || (await has("bun.lockb")))
    return { manager: "bun", command: "bun", args: ["install", "--frozen-lockfile"] };
  if (await has("yarn.lock"))
    return (await has(".yarnrc.yml"))
      ? { manager: "yarn", command: "yarn", args: ["install", "--immutable"] }
      : {
          manager: "yarn",
          command: "yarn",
          args: ["install", "--frozen-lockfile", "--prefer-offline"],
        };
  if ((await has("package-lock.json")) || (await has("npm-shrinkwrap.json")))
    return {
      manager: "npm",
      command: "npm",
      args: ["ci", "--prefer-offline", "--no-audit", "--no-fund"],
    };
  return undefined;
}

export function planCommand(plan: DependencyPlan): string {
  return [plan.command, ...plan.args].join(" ");
}

function tail(text: string): string {
  return text.length > OUTPUT_TAIL ? text.slice(-OUTPUT_TAIL) : text;
}

/** 真正跑安装：子进程单独成组，超时连同它拉起的安装脚本一起结束 */
export const runInstall: InstallRunner = (plan, cwd, timeoutMs, signal) =>
  new Promise((resolve) => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        // 不带上 Server 自己被 pnpm 拉起时继承的 npm_* 配置和 GIT_* 变量
        ([key]) => !key.startsWith("GIT_") && !key.toLowerCase().startsWith("npm_"),
      ),
    );
    let resolved;
    try {
      resolved = commandFor(plan.command, plan.args);
    } catch (error) {
      // 例如 Windows 桌面端没装 Node.js：按启动失败处理，照常退回软链主目录依赖
      resolve({ code: null, output: error instanceof Error ? error.message : String(error) });
      return;
    }
    let output = "";
    let settled = false;
    const finish = (result: InstallResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn(resolved.command, resolved.args, {
      cwd,
      env: { ...env, CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const collect = (chunk: Buffer) => {
      output = tail(output + chunk.toString("utf8"));
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const kill = (name: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, name);
        else child.kill(name);
      } catch {
        // 已经退出
      }
    };
    const stop = (result: InstallResult) => {
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 5000).unref();
      finish(result);
    };
    const timer = setTimeout(() => stop({ code: null, output, timedOut: true }), timeoutMs);
    // Server 关闭时一起结束：安装进程单独成组，不会随 Server 退出，留着会和之后的安装抢着写目录
    if (signal?.aborted) stop({ code: null, output });
    signal?.addEventListener("abort", () => stop({ code: null, output }), { once: true });
    child.on("error", (error) =>
      finish({ code: null, output: tail(`${output}\n${error.message}`) }),
    );
    child.on("close", (code) => finish({ code, output }));
  });

/** 失败的安装可能留下半截 node_modules：只删本次准备时新出现的那些 */
async function removeCreated(worktree: string, packageDirs: string[]): Promise<void> {
  for (const dir of packageDirs)
    await rm(path.join(worktree, dir, "node_modules"), { recursive: true, force: true });
}

/**
 * 软链主目录的依赖：每个 node_modules 建成真目录，里面逐项链到主目录对应的条目；
 * 原本指向主目录 workspace 包（node_modules 以外）的链接，改指本任务线里的同一目录。
 */
export async function linkFromPrimary(
  worktree: string,
  primary: string,
  packageDirs: string[],
): Promise<number> {
  let linked = 0;
  const windows = process.platform === "win32";
  const mapped = async (target: string): Promise<string | undefined> => {
    const relative = path.relative(primary, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
    if (relative.split(path.sep).includes("node_modules")) return undefined;
    const local = path.join(worktree, relative);
    return (await exists(local)) ? local : undefined;
  };
  const link = async (target: string, at: string, directory: boolean) => {
    if (windows) await symlink(target, at, directory ? "junction" : "file");
    // 本任务线里的包用相对链接（跟 pnpm 一样）；指到主目录的用绝对路径
    else if (path.relative(worktree, target).startsWith("..")) await symlink(target, at);
    else await symlink(path.relative(path.dirname(at), target), at);
  };
  const entries = async (from: string, to: string, scoped: boolean): Promise<void> => {
    await mkdir(to, { recursive: true });
    for (const entry of await readdir(from, { withFileTypes: true })) {
      const source = path.join(from, entry.name);
      const at = path.join(to, entry.name);
      if (!scoped && entry.name.startsWith("@") && entry.isDirectory()) {
        await entries(source, at, true);
        continue;
      }
      let target = source;
      if (entry.isSymbolicLink()) {
        const local = await mapped(path.resolve(from, await readlink(source)));
        if (local) target = local;
      }
      const directory = await stat(target).then(
        (info) => info.isDirectory(),
        () => false,
      );
      await link(target, at, directory);
      linked++;
    }
  };
  for (const dir of packageDirs) {
    const source = path.join(primary, dir, "node_modules");
    const info = await stat(source).catch(() => undefined);
    if (!info?.isDirectory() || !(await exists(path.join(worktree, dir)))) continue;
    await entries(source, path.join(worktree, dir, "node_modules"), false);
  }
  return linked;
}

export async function prepareDependencies(options: {
  worktree: string;
  primary: string;
  /** 仓库里登记的 package.json 所在目录（相对路径，"" 是根目录） */
  packageDirs: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
  run?: InstallRunner;
}): Promise<DependencyOutcome> {
  const { worktree, primary } = options;
  if (!(await exists(path.join(worktree, "package.json"))))
    return { state: "skipped", reason: "notNode" };
  const packageDirs = [...new Set(["", ...options.packageDirs])];
  // 已经有依赖（复用的目录、Agent 自己装过）就不碰，失败清理也只会删本次新建的
  for (const dir of packageDirs)
    if (await exists(path.join(worktree, dir, "node_modules")))
      return { state: "skipped", reason: "present" };
  const plan = await dependencyPlan(worktree);
  let failure = "noLockfile";
  let output: string | undefined;
  if (plan) {
    const result = await (options.run ?? runInstall)(
      plan,
      worktree,
      options.timeoutMs ?? INSTALL_TIMEOUT_MS,
      options.signal,
    );
    if (result.code === 0)
      return { state: "installed", manager: plan.manager, command: planCommand(plan) };
    failure = result.timedOut ? "timeout" : result.code === null ? "spawn" : "exit";
    output = result.output.trim() ? tail(result.output.trim()) : undefined;
    await removeCreated(worktree, packageDirs);
    // Server 在关：不再退回软链，下次由 Agent 自己装
    if (options.signal?.aborted) return { state: "failed", reason: "error" };
  }
  const common = {
    ...(plan ? { manager: plan.manager, command: planCommand(plan) } : {}),
    ...(output ? { output } : {}),
    reason: failure,
  };
  if (path.resolve(primary) === path.resolve(worktree)) return { state: "failed", ...common };
  try {
    if (!(await stat(path.join(primary, "node_modules")).catch(() => undefined))?.isDirectory())
      return { state: "failed", ...common };
    await linkFromPrimary(worktree, primary, packageDirs);
    return { state: "linked", ...common };
  } catch (error) {
    await removeCreated(worktree, packageDirs);
    return {
      state: "failed",
      ...common,
      output: tail(
        [output, error instanceof Error ? error.message : String(error)].filter(Boolean).join("\n"),
      ),
    };
  }
}
