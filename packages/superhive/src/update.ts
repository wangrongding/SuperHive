import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { superhiveHome } from "./home-dir.js";
import { shellQuote } from "./service.js";

const PACKAGE = "superhive";
const DEFAULT_REGISTRY = "https://registry.npmjs.org/";
/** 每次在终端运行 hive 时查新版最多等这么久；查不到不影响命令本身 */
export const QUICK_CHECK_TIMEOUT_MS = 1_500;
/** 查到的结果缓存这么久，连着敲几个命令不用每次都等网络 */
export const CHECK_CACHE_MS = 60 * 60 * 1000;

/** 这份 superhive 是怎么装的，决定 hive update 用哪个包管理器 */
export type InstallKind =
  | { kind: "npm"; prefix: string }
  | { kind: "pnpm" }
  | { kind: "bun" }
  | { kind: "yarn" }
  | { kind: "npx" }
  | { kind: "source" };

/**
 * 按这份 superhive 的真实位置判断安装方式（参考 cc-switch 按路径认安装来源）：
 * npx 缓存、bun / pnpm / yarn 的全局目录、npm 全局（<prefix>/lib/node_modules/superhive，
 * Windows 是 <prefix>/node_modules/superhive）；都不是就当源码运行（pnpm link、仓库里 tsx）。
 */
export function detectInstall(
  packageRoot: string,
  platform: NodeJS.Platform = process.platform,
): InstallKind {
  const p = packageRoot.replace(/\\/g, "/");
  const lower = p.toLowerCase();
  if (lower.includes("/_npx/")) return { kind: "npx" };
  if (!lower.endsWith("/node_modules/superhive")) return { kind: "source" };
  if (lower.includes("/.bun/install/global/")) return { kind: "bun" };
  if (lower.includes("/pnpm/global/") || lower.includes("/.pnpm/")) return { kind: "pnpm" };
  if (lower.includes("/yarn/global/")) return { kind: "yarn" };
  const paths = platform === "win32" ? path.win32 : path.posix;
  const parent = paths.dirname(paths.dirname(packageRoot));
  if (platform === "win32") return { kind: "npm", prefix: parent };
  // <prefix>/lib/node_modules/superhive
  if (paths.basename(parent) !== "lib") return { kind: "source" };
  return { kind: "npm", prefix: paths.dirname(parent) };
}

/** 升级要跑的命令（给人看的整行 + 实际执行的程序和参数） */
export function upgradeCommand(
  install: InstallKind,
  options: {
    execPath?: string;
    platform?: NodeJS.Platform;
    exists?: (file: string) => boolean;
  } = {},
): { display: string; file: string; args: string[] } | undefined {
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  const spec = `${PACKAGE}@latest`;
  const win = platform === "win32";
  switch (install.kind) {
    case "npm": {
      // 用跑 hive 的这份 node 旁边的 npm，并锁定到这份 superhive 所在的全局目录，不会装到别处去
      const dir = path.dirname(options.execPath ?? process.execPath);
      const sibling = path.join(dir, win ? "npm.cmd" : "npm");
      const npm = exists(sibling) ? sibling : win ? "npm.cmd" : "npm";
      const args = ["install", "-g", "--prefix", install.prefix, spec];
      return {
        display: [npm, ...args].map((part) => shellQuote(part, platform)).join(" "),
        file: npm,
        args,
      };
    }
    case "pnpm":
      return {
        display: `pnpm add -g ${spec}`,
        file: win ? "pnpm.cmd" : "pnpm",
        args: ["add", "-g", spec],
      };
    case "bun":
      return { display: `bun add -g ${spec}`, file: "bun", args: ["add", "-g", spec] };
    case "yarn":
      return {
        display: `yarn global add ${spec}`,
        file: win ? "yarn.cmd" : "yarn",
        args: ["global", "add", spec],
      };
    default:
      return undefined;
  }
}

/** a 比 b 新返回正数；带预发布后缀的比同号正式版旧 */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => {
    const [core = "", pre] = value.trim().replace(/^v/, "").split("-", 2);
    return { parts: core.split(".").map((part) => Number.parseInt(part, 10) || 0), pre };
  };
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < 3; index += 1) {
    const diff = (left.parts[index] ?? 0) - (right.parts[index] ?? 0);
    if (diff !== 0) return diff;
  }
  if (left.pre && !right.pre) return -1;
  if (!left.pre && right.pre) return 1;
  return (left.pre ?? "").localeCompare(right.pre ?? "");
}

/** npm 源：环境变量 > ~/.npmrc 里的 registry= > 官方源（国内镜像用户照样查得到） */
export function npmRegistry(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const fromEnv = env.npm_config_registry ?? env.NPM_CONFIG_REGISTRY;
  let registry = fromEnv;
  if (!registry) {
    try {
      const match = /^\s*registry\s*=\s*(\S+)\s*$/m.exec(
        readFileSync(path.join(home, ".npmrc"), "utf8"),
      );
      registry = match?.[1];
    } catch {
      // 没有 .npmrc
    }
  }
  if (!registry || !/^https?:\/\//.test(registry)) registry = DEFAULT_REGISTRY;
  return registry.endsWith("/") ? registry : `${registry}/`;
}

export async function fetchLatestVersion(
  timeoutMs: number,
  options: { registry?: string; fetchImpl?: typeof fetch } = {},
): Promise<string | undefined> {
  const registry = options.registry ?? npmRegistry();
  try {
    const response = await (options.fetchImpl ?? fetch)(
      new URL(`-/package/${PACKAGE}/dist-tags`, registry),
      { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } },
    );
    if (!response.ok) return undefined;
    const latest = ((await response.json()) as { latest?: unknown }).latest;
    return typeof latest === "string" && /^\d+\.\d+\.\d+/.test(latest) ? latest : undefined;
  } catch {
    return undefined;
  }
}

type CheckCache = { checkedAt: number; latest: string };

function cachePath(): string {
  return path.join(superhiveHome(), "update-check.json");
}

function readCache(file: string): CheckCache | undefined {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<CheckCache>;
    return typeof value.checkedAt === "number" && typeof value.latest === "string"
      ? { checkedAt: value.checkedAt, latest: value.latest }
      : undefined;
  } catch {
    return undefined;
  }
}

/** 有没有比当前更新的版本：1 小时内查过就用缓存，否则联网查（限时），查不到返回 undefined */
export async function checkLatest(
  current: string,
  options: {
    now?: number;
    file?: string;
    timeoutMs?: number;
    fetchLatest?: (timeoutMs: number) => Promise<string | undefined>;
  } = {},
): Promise<string | undefined> {
  const now = options.now ?? Date.now();
  const file = options.file ?? cachePath();
  const cached = readCache(file);
  let latest =
    cached && now - cached.checkedAt >= 0 && now - cached.checkedAt < CHECK_CACHE_MS
      ? cached.latest
      : undefined;
  if (!latest) {
    latest = await (options.fetchLatest ?? fetchLatestVersion)(
      options.timeoutMs ?? QUICK_CHECK_TIMEOUT_MS,
    );
    if (latest) {
      try {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, `${JSON.stringify({ checkedAt: now, latest })}\n`);
      } catch {
        // 写不了缓存下次再查
      }
    }
  }
  return latest && compareVersions(latest, current) > 0 ? latest : undefined;
}

/** 终端里给人看的才查：管道、CI、关掉提示时不查，不拖慢脚本 */
export function shouldCheckForUpdate(
  env: NodeJS.ProcessEnv = process.env,
  isTTY = Boolean(process.stdout.isTTY),
): boolean {
  if (!isTTY) return false;
  if (env.CI || env.NO_UPDATE_NOTIFIER || env.SUPERHIVE_NO_UPDATE_CHECK) return false;
  return true;
}

export function updateNotice(current: string, latest: string, install: InstallKind): string {
  const how =
    install.kind === "npx"
      ? "在启动服务的电脑运行 npx superhive@latest restart 更新"
      : install.kind === "source"
        ? "当前是源码运行，git pull 后重启即可"
        : "运行 hive update 更新（会自动用新版本重启正在运行的 Server）";
  return `\n[hive] SuperHive 有新版本：${current} → ${latest}\n[hive] ${how}\n`;
}

export function packageRootOf(moduleFile: string): string {
  // dist/update.js 或 src/update.ts 的上一级就是包根目录；跟随符号链接拿真实位置
  const root = path.dirname(path.dirname(moduleFile));
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}

function runInherit(file: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      stdio: "inherit",
      shell: process.platform === "win32",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

const updateUsage = `
用法：
  hive update [选项]

说明：
  查 npm 上的最新版，用你安装 superhive 时的那个包管理器（npm / pnpm / bun / yarn 全局）装到最新版；
  Hive Server 正在运行时自动用新版本重启，沿用原来的启动配置。
  重启时本机 Agent 不下线，正在跑的任务继续做完（见 hive restart --help）。

选项：
  --check           只检查有没有新版本，不安装
  --force           已是最新版也重新安装一遍
  --wait            重启交接不了时不问，等本机 Agent 手上的任务做完再重启
  --force-restart   重启交接不了时不问也不等，立即重启（会中断正在跑的任务）
`;

/** hive update 装好新版后调 hive restart 带的参数 */
export function restartArgsFor(options: { wait?: boolean; "force-restart"?: boolean }): string[] {
  if (options["force-restart"]) return ["restart", "--force"];
  if (options.wait) return ["restart", "--wait"];
  return ["restart"];
}

export async function updateCommand(
  args: string[],
  context: {
    version: string;
    packageRoot: string;
    serviceRunning: () => boolean;
  },
): Promise<void> {
  const parsed = parseArgs({
    args,
    options: {
      check: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      wait: { type: "boolean", default: false },
      "force-restart": { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
  });
  if (parsed.values.help) {
    console.log(updateUsage);
    return;
  }
  const install = detectInstall(context.packageRoot);
  console.log(`[hive] 当前版本 ${context.version}，正在查询最新版…`);
  const latest = await fetchLatestVersion(10_000);
  if (!latest) {
    throw new Error(`查不到 npm 上 superhive 的最新版（源：${npmRegistry()}），请检查网络后重试。`);
  }
  const newer = compareVersions(latest, context.version) > 0;
  if (!newer && !parsed.values.force) {
    console.log(`[hive] 已经是最新版 ${context.version}。`);
    return;
  }
  if (parsed.values.check) {
    console.log(`[hive] 有新版本：${context.version} → ${latest}，运行 hive update 安装。`);
    return;
  }
  if (install.kind === "npx") {
    throw new Error(
      "当前是用 npx 临时运行的，没有全局安装可更新。运行 npx superhive@latest restart 用最新版重启，或者 npm i -g superhive 全局安装后用 hive。",
    );
  }
  if (install.kind === "source") {
    throw new Error(
      `当前是源码运行（${context.packageRoot}），不是 npm 全局安装的，git pull 后重新构建即可。`,
    );
  }
  const command = upgradeCommand(install)!;
  console.log(
    `[hive] ${newer ? `更新 ${context.version} → ${latest}` : `重新安装 ${latest}`}：${command.display}`,
  );
  let code: number;
  try {
    code = await runInherit(command.file, command.args);
  } catch (error) {
    throw new Error(
      `没能运行 ${command.file}：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (code !== 0) {
    throw new Error(
      `安装失败（退出码 ${code}）。` +
        (install.kind === "npm"
          ? "如果是权限不足（EACCES），不要用 sudo，参考 https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally 把全局目录改到自己的目录。"
          : ""),
    );
  }
  console.log(`[hive] 已更新到 ${latest}。`);
  if (!context.serviceRunning()) {
    console.log("[hive] Hive Server 没在运行，下次 hive 启动时就是新版本。");
    return;
  }
  // 当前进程还是旧代码：起一个新的 hive 进程（新版本）来重启 Server
  console.log("[hive] 正在用新版本重启 Hive Server…");
  // npm 全局装的直接用那个全局目录里的 hive，其他包管理器用 PATH 里的 hive
  const win = process.platform === "win32";
  const anchored =
    install.kind === "npm"
      ? path.join(install.prefix, win ? "hive.cmd" : path.join("bin", "hive"))
      : undefined;
  const hive = anchored && existsSync(anchored) ? anchored : win ? "hive.cmd" : "hive";
  const restartArgs = restartArgsFor(parsed.values);
  const restart = await runInherit(hive, restartArgs).catch(() =>
    runInherit(process.execPath, [process.argv[1]!, ...restartArgs]),
  );
  if (restart !== 0)
    throw new Error("新版本已装好，但 Server 没有重启（原因见上面），稍后手动运行 hive restart。");
}
