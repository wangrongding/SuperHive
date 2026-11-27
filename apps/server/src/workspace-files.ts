import { spawn } from "node:child_process";
import { userFs, userFsPromises } from "./user-fs.js";
import { PassThrough, type Readable } from "node:stream";
import path from "node:path";
import type {
  WorkspaceChange,
  WorkspaceChangeSet,
  WorkspaceChangeStatus,
  WorkspaceCommit,
  WorkspaceDiff,
  WorkspaceFile,
  WorkspaceSearch,
  WorkspaceStatus,
  WorkspaceTree,
  WorkspaceTreeEntry,
} from "@superhive/protocol";
import { HiveError } from "./database.js";
import { gitOperationName, slowOps } from "./slow-ops.js";
import { decodeDiff, decodeText, diffTexts, type TextEncodingLabel } from "./workspace-text.js";

const { createReadStream } = userFs;
const { lstat, open, readdir, realpath, stat } = userFsPromises;

/**
 * 房间工作区的只读浏览：文件树、预览、git 状态、diff、提交。
 *
 * - 只跑只读的 git 子命令，参数数组传给 spawn（不经 shell）；带超时与输出上限。
 *   GIT_OPTIONAL_LOCKS=0 让 status 不去刷新 index，不和 Agent 正在做的 git 操作抢锁；钩子与 fsmonitor 关掉，
 *   diff 不用外部 diff 与 textconv。
 * - 路径先按 POSIX 相对路径校验（不能是绝对路径、不能有 .. 和 .git 段），再 realpath 确认仍在根目录内，
 *   指向外面的符号链接一律拒绝。
 * - 疑似密钥文件只列出，内容和 diff 要 reveal 才给（只有房主能 reveal，由路由校验）。
 */

export const WORKSPACE_LIMITS = {
  /** 文件预览最多读这么多字节，超过的截断 */
  previewBytes: 512 * 1024,
  /** 单个文件的 diff 文本上限，超过只提示不返回 */
  diffBytes: 1024 * 1024,
  /** 一个目录最多列这么多条 */
  treeEntries: 2000,
  /** git status 最多返回这么多条改动 */
  changes: 3000,
  /** 统计未跟踪文件行数：只看前这么多个、每个不超过 previewBytes */
  untrackedLineCounts: 300,
  searchResults: 100,
  gitTimeoutMs: 10_000,
  gitOutputBytes: 32 * 1024 * 1024,
} as const;

/** 疑似密钥：按文件名或所在目录判断（.env.example 之类的样例不算） */
const SENSITIVE_NAMES = [
  /^\.env(\..+)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|asc|gpg|ppk)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/i,
  /^(credentials|credential)(\.(json|ya?ml|toml|ini|txt|xml))?$/i,
  /^secrets?(\..+)?$/i,
  /^\.(npmrc|pypirc|netrc|htpasswd|git-credentials|pgpass|dockercfg)$/i,
  /^(auth|token|tokens)\.json$/i,
  /^service[-_]?account.*\.json$/i,
  /^.*\.secrets?\.(json|ya?ml|toml)$/i,
];
const SAMPLE_NAME = /\.(example|sample|template|dist|defaults?)$/i;
const SENSITIVE_DIRS = new Set([".ssh", ".aws", ".gnupg", ".docker", ".kube"]);

export function isSensitivePath(relative: string): boolean {
  const parts = relative.split("/").filter(Boolean);
  const name = parts.at(-1) ?? "";
  if (parts.slice(0, -1).some((part) => SENSITIVE_DIRS.has(part.toLowerCase()))) return true;
  if (SAMPLE_NAME.test(name)) return false;
  return SENSITIVE_NAMES.some((pattern) => pattern.test(name));
}

function fail(code: string, message: string): never {
  throw new HiveError(code, message);
}

/** 校验相对路径，返回规范化后的 POSIX 形式（"" 是根目录） */
export function normalizeRelative(input: string): string {
  if (
    input.includes("\0") ||
    input.includes("\\") ||
    input.startsWith("/") ||
    /^[A-Za-z]:/.test(input)
  )
    fail("WORKSPACE_PATH_INVALID", "Invalid path");
  const parts = input.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.some((part) => part === ".." || part.toLowerCase() === ".git"))
    fail("WORKSPACE_PATH_INVALID", "Invalid path");
  return parts.join("/");
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** 相对路径 → 真实路径；不在根目录内（含符号链接指出去的）拒绝 */
export async function resolveInside(root: string, relative: string): Promise<string> {
  const normalized = normalizeRelative(relative);
  const target = path.resolve(root, ...normalized.split("/").filter(Boolean));
  if (!isInside(root, target)) fail("WORKSPACE_PATH_INVALID", "Invalid path");
  let real: string;
  try {
    real = await realpath(target);
  } catch {
    fail("WORKSPACE_PATH_NOT_FOUND", "Path not found");
  }
  if (!isInside(root, real)) fail("WORKSPACE_PATH_OUTSIDE", "Path points outside the workspace");
  return real;
}

/** 「整份上下文」的行数：比任何能在上限内显示的文件都长 */
const FULL_CONTEXT = 1_000_000;

/** 改动列表里最多为这么多个被 git 当成二进制的文件检查是不是 UTF-16 */
const RECOUNT_LIMIT = 50;

type GitOutput = { code: number; stdout: Buffer; stderr: string };

/** 只读 git：不经 shell、去掉继承的 GIT_* 变量、不抢可选锁、不跑钩子；超时或输出超限报错 */
export async function readOnlyGit(
  cwd: string,
  args: string[],
  options: { maxBytes?: number; timeoutMs?: number; input?: string } = {},
): Promise<GitOutput> {
  const started = performance.now();
  let failed = false;
  try {
    return await spawnReadOnlyGit(cwd, args, options);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    slowOps.record({
      kind: "git",
      name: gitOperationName(args),
      durationMs: performance.now() - started,
      repo: cwd,
      ...(failed ? { failed } : {}),
    });
  }
}

function spawnReadOnlyGit(
  cwd: string,
  args: string[],
  options: { maxBytes?: number; timeoutMs?: number; input?: string },
): Promise<GitOutput> {
  const maxBytes = options.maxBytes ?? WORKSPACE_LIMITS.gitOutputBytes;
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
    );
    const child = spawn(
      "git",
      [
        "-c",
        `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.quotepath=off",
        "-c",
        "color.ui=false",
        "-c",
        "diff.external=",
        "--no-pager",
        "-C",
        cwd,
        ...args,
      ],
      {
        env: {
          ...env,
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_NOSYSTEM: "1",
          LC_ALL: "C",
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderr = "";
    let settled = false;
    const finish = (error?: HiveError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        child.kill("SIGKILL");
        reject(error);
      }
    };
    const timer = setTimeout(
      () => finish(new HiveError("WORKSPACE_GIT_TIMEOUT", "Git took too long")),
      options.timeoutMs ?? WORKSPACE_LIMITS.gitTimeoutMs,
    );
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) return finish(new HiveError("WORKSPACE_TOO_LARGE", "Output too large"));
      chunks.push(chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 4000) stderr += chunk;
    });
    child.stdin.on("error", () => undefined);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: Buffer.concat(chunks), stderr });
    });
    child.stdin.end(options.input);
  });
}

async function gitText(cwd: string, args: string[], maxBytes?: number): Promise<string> {
  const result = await readOnlyGit(cwd, args, maxBytes ? { maxBytes } : {});
  if (result.code !== 0)
    fail("WORKSPACE_GIT_FAILED", result.stderr.trim().slice(0, 500) || `git exit ${result.code}`);
  return result.stdout.toString("utf8");
}

/** 字面路径的 pathspec：不让 *、? 之类被当成通配 */
const literal = (relative: string) => `:(literal)${relative}`;

/** 提交号：只接受十六进制（git 的短号或全长），先挡住选项和范围写法 */
function commitArg(input: string): string {
  if (!/^[0-9a-f]{4,64}$/i.test(input)) fail("WORKSPACE_REF_INVALID", "Invalid commit");
  return input;
}

type RepoInfo = { toplevel: string; prefix: string };

/** 一个根目录（工作区或 worktree）上的只读视图 */
export class WorkspaceView {
  private repoInfo: Promise<RepoInfo | undefined> | undefined;

  constructor(readonly root: string) {}

  /** 根目录所在的 git 仓库；不是仓库返回 undefined。工作区可以是仓库的子目录 */
  repo(): Promise<RepoInfo | undefined> {
    this.repoInfo ??= (async () => {
      const result = await readOnlyGit(this.root, [
        "rev-parse",
        "--show-toplevel",
        "--show-prefix",
      ]);
      if (result.code !== 0) return undefined;
      const [toplevel = "", prefix = ""] = result.stdout.toString("utf8").split("\n");
      if (!toplevel) return undefined;
      return { toplevel, prefix };
    })().catch(() => undefined);
    return this.repoInfo;
  }

  /** 仓库根相对的路径 → 本视图根相对；不在本视图里的返回 undefined */
  private local(repoPath: string, prefix: string): string | undefined {
    if (!prefix) return repoPath;
    return repoPath.startsWith(prefix) ? repoPath.slice(prefix.length) : undefined;
  }

  /**
   * 最近有没有人在这里改：未提交文件数与它们的最晚修改时间，相对 base 领先的提交数与最新提交时间。
   * 「代码」面板据此默认打开最近有动静的那份代码。
   */
  async activity(
    base?: string,
  ): Promise<{ changeCount: number; ahead: number; activeAt?: string }> {
    const status = await this.status({ counts: false });
    if (!status.git) return { changeCount: 0, ahead: 0 };
    const paths = [...new Set(status.changes.map((item) => item.path))];
    let latest = 0;
    await Promise.all(
      paths.slice(0, 200).map(async (file) => {
        const info = await lstat(path.join(this.root, file)).catch(() => undefined);
        if (info && info.mtimeMs > latest) latest = info.mtimeMs;
      }),
    );
    let ahead = 0;
    if (base && !base.startsWith("-") && !/[\0\s:]/.test(base)) {
      const counted = await readOnlyGit(this.root, [
        "rev-list",
        "--count",
        "--end-of-options",
        `${base}..HEAD`,
      ]);
      if (counted.code === 0) ahead = Number(counted.stdout.toString("utf8").trim()) || 0;
      if (ahead > 0) {
        const time = await readOnlyGit(this.root, ["log", "-1", "--format=%ct", "HEAD"]);
        const seconds = Number(time.stdout.toString("utf8").trim());
        if (seconds * 1000 > latest) latest = seconds * 1000;
      }
    }
    return {
      changeCount: paths.length,
      ahead,
      ...(latest ? { activeAt: new Date(latest).toISOString() } : {}),
    };
  }

  async status(options: { counts?: boolean } = {}): Promise<WorkspaceStatus> {
    const repo = await this.repo();
    if (!repo) return { git: false, changes: [] };
    const output = await gitText(this.root, [
      "status",
      "--porcelain=v2",
      "--branch",
      "-z",
      "--untracked-files=all",
      "--no-renames",
      "--",
      ".",
    ]);
    const fields = output.split("\0");
    const result: WorkspaceStatus = { git: true, changes: [] };
    let truncated = false;
    let oid: string | undefined;
    for (let index = 0; index < fields.length; index++) {
      const field = fields[index]!;
      if (!field) continue;
      if (field.startsWith("# ")) {
        const [, key, ...rest] = field.split(" ");
        const value = rest.join(" ");
        if (key === "branch.head") {
          if (value === "(detached)") result.detached = true;
          else result.branch = value;
        } else if (key === "branch.oid" && value !== "(initial)") oid = value;
        else if (key === "branch.upstream") result.upstream = value;
        else if (key === "branch.ab") {
          const match = /^\+(\d+) -(\d+)$/.exec(value);
          if (match) {
            result.ahead = Number(match[1]);
            result.behind = Number(match[2]);
          }
        }
        continue;
      }
      if (result.changes.length >= WORKSPACE_LIMITS.changes) {
        truncated = true;
        continue;
      }
      const kind = field[0];
      if (kind === "?") {
        const local = this.local(field.slice(2), repo.prefix);
        if (local !== undefined) result.changes.push(change(local, "untracked", "?"));
      } else if (kind === "1" || kind === "2") {
        const parts = field.split(" ");
        const xy = parts[1] ?? "..";
        const repoPath = parts.slice(kind === "1" ? 8 : 9).join(" ");
        if (kind === "2") index++; // 原路径（--no-renames 时不会出现，保险起见跳过）
        const local = this.local(repoPath, repo.prefix);
        if (local === undefined) continue;
        if (xy[0] !== ".") result.changes.push(change(local, "staged", statusLetter(xy[0]!)));
        if (xy[1] !== ".") result.changes.push(change(local, "unstaged", statusLetter(xy[1]!)));
      } else if (kind === "u") {
        const repoPath = field.split(" ").slice(10).join(" ");
        const local = this.local(repoPath, repo.prefix);
        if (local !== undefined) result.changes.push(change(local, "conflict", "U"));
      }
    }
    if (result.detached && oid) result.branch = oid.slice(0, 7);
    if (truncated) result.truncated = true;
    if (options.counts !== false) await this.addCounts(result.changes);
    return result;
  }

  /** 给改动补上增删行数：暂存、未暂存各一次 numstat，未跟踪的自己数行 */
  private async addCounts(changes: WorkspaceChange[]): Promise<void> {
    const apply = (group: "staged" | "unstaged", stats: Map<string, Numstat>) => {
      for (const item of changes)
        if (item.group === group) Object.assign(item, countsOf(stats.get(item.path)));
    };
    if (changes.some((item) => item.group === "staged")) {
      apply("staged", await this.numstat(["diff", "--cached"]));
      await this.recountDecoded(
        changes.filter((item) => item.group === "staged"),
        ["--cached"],
      );
    }
    if (changes.some((item) => item.group === "unstaged")) {
      apply("unstaged", await this.numstat(["diff"]));
      await this.recountDecoded(
        changes.filter((item) => item.group === "unstaged"),
        [],
      );
    }
    let counted = 0;
    for (const item of changes) {
      if (item.group !== "untracked") continue;
      if (counted++ >= WORKSPACE_LIMITS.untrackedLineCounts) break;
      const text = await this.readText(item.path).catch(() => undefined);
      if (text === undefined) continue;
      if (text === null) item.binary = true;
      else item.additions = lineCount(text);
    }
  }

  private async numstat(args: string[]): Promise<Map<string, Numstat>> {
    const output = await gitText(this.root, [
      ...args,
      "--numstat",
      "-z",
      "-M",
      "--relative",
      "--no-ext-diff",
      "--no-textconv",
    ]);
    return parseNumstat(output);
  }

  /** 两个版本之间的改动文件（name-status + numstat），路径相对本视图根 */
  private async changeList(
    range: string[],
  ): Promise<{ changes: WorkspaceChange[]; truncated: boolean }> {
    const common = ["-M", "-z", "--relative", "--no-ext-diff", "--no-textconv"];
    const [names, stats] = await Promise.all([
      gitText(this.root, ["diff", "--name-status", ...common, ...range]),
      gitText(this.root, ["diff", "--numstat", ...common, ...range]).then(parseNumstat),
    ]);
    const fields = names.split("\0");
    const changes: WorkspaceChange[] = [];
    let truncated = false;
    for (let index = 0; index < fields.length; index++) {
      const code = fields[index];
      if (!code) continue;
      const letter = statusLetter(code[0]!);
      let oldPath: string | undefined;
      if (letter === "R" || letter === "C") oldPath = fields[++index];
      const file = fields[++index];
      if (!file) continue;
      if (changes.length >= WORKSPACE_LIMITS.changes) {
        truncated = true;
        continue;
      }
      changes.push({
        ...change(file, "unstaged", letter),
        ...(oldPath && oldPath !== file ? { oldPath } : {}),
        ...countsOf(stats.get(file)),
      });
    }
    await this.recountDecoded(changes, range);
    return { changes, truncated };
  }

  /**
   * numstat 把 UTF-16 文件算成二进制：工作区里这个文件以 UTF-16 BOM 开头的，解码两侧后重新数增删行，
   * 和点开看到的 diff 一致。只看前 RECOUNT_LIMIT 个二进制改动。
   */
  private async recountDecoded(changes: WorkspaceChange[], range: string[]): Promise<void> {
    let checked = 0;
    for (const item of changes) {
      if (!item.binary || item.status === "D") continue;
      if (checked++ >= RECOUNT_LIMIT) break;
      if (!(await this.startsWithUtf16Bom(item.path))) continue;
      const diffed = await this.decodedDiff(
        range,
        item.path,
        item.oldPath ?? item.path,
        false,
      ).catch(() => null);
      if (diffed?.patch === undefined) continue;
      delete item.binary;
      Object.assign(item, patchCounts(diffed.patch));
    }
  }

  private async startsWithUtf16Bom(relative: string): Promise<boolean> {
    try {
      const { data } = await readHeadBytes(await resolveInside(this.root, relative), 2);
      return (data[0] === 0xff && data[1] === 0xfe) || (data[0] === 0xfe && data[1] === 0xff);
    } catch {
      return false;
    }
  }

  async log(options: { skip?: number; limit?: number } = {}): Promise<WorkspaceCommit[]> {
    if (!(await this.repo())) fail("WORKSPACE_NOT_GIT", "Not a git repository");
    const head = await readOnlyGit(this.root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    if (head.code !== 0) return [];
    const output = await gitText(this.root, [
      "log",
      `--max-count=${Math.min(Math.max(options.limit ?? 30, 1), 100)}`,
      `--skip=${Math.max(options.skip ?? 0, 0)}`,
      "--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1e",
      "HEAD",
      "--",
      ".",
    ]);
    return parseLog(output);
  }

  /** 查看单个提交：说明与改动文件（合并提交相对第一个父提交） */
  async commit(input: string): Promise<WorkspaceChangeSet> {
    if (!(await this.repo())) fail("WORKSPACE_NOT_GIT", "Not a git repository");
    const hash = await this.resolveCommit(input);
    const [info, parent] = await Promise.all([
      gitText(this.root, ["log", "-1", "--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1f%b%x1e", hash]),
      this.parentOf(hash),
    ]);
    const [fields] = info.split("\x1e");
    const [full = hash, short = hash.slice(0, 7), subject = "", author = "", date = "", body = ""] =
      (fields ?? "").replace(/^\n/, "").split("\x1f");
    const { changes, truncated } = await this.changeList([parent, hash]);
    return {
      commit: { hash: full, shortHash: short, subject, author, date },
      ...(body.trim() ? { body: body.trim().slice(0, 20_000) } : {}),
      changes,
      ...(truncated ? { truncated } : {}),
    };
  }

  /** 相对 base 的全部改动：分叉点到工作区（含未提交改动）加上未跟踪文件，及这条线上的提交 */
  async compare(base: string): Promise<WorkspaceChangeSet> {
    const mergeBase = await this.mergeBase(base);
    const [{ changes, truncated }, status, commits] = await Promise.all([
      this.changeList([mergeBase]),
      this.status({ counts: false }),
      gitText(this.root, [
        "log",
        "--max-count=100",
        "--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1e",
        `${mergeBase}..HEAD`,
        "--",
        ".",
      ]).then(parseLog),
    ]);
    const known = new Set(changes.map((item) => item.path));
    for (const item of status.changes)
      if (item.group === "untracked" && !known.has(item.path))
        changes.push({ ...item, status: "A" });
    let counted = 0;
    for (const item of changes) {
      if (item.group !== "untracked") continue;
      item.group = "unstaged";
      if (counted++ >= WORKSPACE_LIMITS.untrackedLineCounts) continue;
      const text = await this.readText(item.path).catch(() => undefined);
      if (text === null) item.binary = true;
      else if (text !== undefined) item.additions = lineCount(text);
    }
    return {
      base,
      mergeBase,
      commits,
      changes: changes.sort((a, b) => a.path.localeCompare(b.path)),
      ...(truncated ? { truncated } : {}),
    };
  }

  async diff(input: {
    path: string;
    oldPath?: string | undefined;
    mode: "staged" | "unstaged" | "untracked" | "conflict" | "commit" | "base";
    commit?: string | undefined;
    base?: string | undefined;
    reveal: boolean;
    /** 带上整份文件作上下文（网页据此折叠、展开未改动的部分）；太大时退回默认 3 行 */
    full?: boolean;
  }): Promise<WorkspaceDiff> {
    const relative = normalizeRelative(input.path);
    const oldPath = input.oldPath ? normalizeRelative(input.oldPath) : undefined;
    const sensitive = isSensitivePath(relative) || (oldPath ? isSensitivePath(oldPath) : false);
    const result: WorkspaceDiff = { path: relative, ...(sensitive ? { sensitive } : {}) };
    if (sensitive && !input.reveal) return result;
    if (!(await this.repo())) fail("WORKSPACE_NOT_GIT", "Not a git repository");
    const pathspec = ["--", literal(relative), ...(oldPath ? [literal(oldPath)] : [])];
    let range: string[];
    switch (input.mode) {
      case "untracked":
        return { ...result, ...(await this.newFileDiff(relative)), full: true };
      case "staged":
        range = ["--cached"];
        break;
      case "unstaged":
      case "conflict":
        range = [];
        break;
      case "commit": {
        const hash = await this.resolveCommit(input.commit ?? "");
        range = [await this.parentOf(hash), hash];
        break;
      }
      case "base": {
        if (!input.base) fail("WORKSPACE_REF_INVALID", "Missing base");
        range = [await this.mergeBase(input.base)];
        // 还没被 git 跟踪的新文件：按新增整份显示
        const tracked = await readOnlyGit(this.root, [
          "ls-files",
          "--error-unmatch",
          "--",
          literal(relative),
        ]);
        if (tracked.code !== 0) {
          const inBase = await readOnlyGit(this.root, [
            "cat-file",
            "-e",
            `${range[0]}:./${relative}`,
          ]);
          if (inBase.code !== 0)
            return { ...result, ...(await this.newFileDiff(relative)), full: true };
        }
        break;
      }
    }
    for (const full of input.full ? [true, false] : [false]) {
      let output: GitOutput;
      try {
        output = await readOnlyGit(
          this.root,
          [
            "diff",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "-M",
            "--relative",
            ...(full ? [`--unified=${FULL_CONTEXT}`] : []),
            ...range,
            ...pathspec,
          ],
          { maxBytes: WORKSPACE_LIMITS.diffBytes },
        );
      } catch (error) {
        if (error instanceof HiveError && error.code === "WORKSPACE_TOO_LARGE") continue;
        throw error;
      }
      if (output.code !== 0)
        fail(
          "WORKSPACE_GIT_FAILED",
          output.stderr.trim().slice(0, 500) || `git exit ${output.code}`,
        );
      const decoded = decodeDiff(output.stdout);
      const hunks = hunksOf(decoded.text);
      if (hunks.binary && input.mode !== "conflict") {
        // git 看到 NUL 就当二进制：UTF-16 文件取出新旧两侧解码后再比
        const text = await this.decodedDiff(range, relative, oldPath ?? relative, full);
        if (text?.tooLarge) continue;
        if (text) return { ...result, ...text };
      }
      return {
        ...result,
        ...hunks,
        ...(full ? { full } : {}),
        ...(decoded.encoding && hunks.patch ? { encoding: decoded.encoding } : {}),
      };
    }
    return { ...result, tooLarge: true };
  }

  /** 未跟踪的新文件：整份按新增行显示 */
  private async newFileDiff(relative: string): Promise<Partial<WorkspaceDiff>> {
    const real = await resolveInside(this.root, relative);
    const info = await stat(real);
    if (!info.isFile()) return { binary: true };
    if (info.size > WORKSPACE_LIMITS.diffBytes) return { tooLarge: true };
    const decoded = await this.readDecoded(relative);
    if (decoded === null) return { binary: true };
    const { text, encoding } = decoded;
    const withEncoding = encoding ? { encoding } : {};
    if (text === "") return { patch: "", ...withEncoding };
    const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
    const noNewline = text.endsWith("\n") ? "" : "\n\\ No newline at end of file";
    return {
      patch: `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}${noNewline}\n`,
      ...withEncoding,
    };
  }

  /**
   * git 判成二进制的改动：取出新旧两侧按 decodeText 解码，两侧都是文本、且有一侧是 UTF-16 时，
   * 转成 UTF-8 再让 git 比（别的二进制照旧不显示）。range 同 git diff 的参数：
   * ["--cached"] 是 HEAD→暂存区，[] 是暂存区→工作区，[a] 是 a→工作区，[a, b] 是 a→b。
   */
  private async decodedDiff(
    range: string[],
    relative: string,
    oldPath: string,
    full: boolean,
  ): Promise<Partial<WorkspaceDiff> | null> {
    const [before, after] =
      range[0] === "--cached"
        ? ["HEAD", ""]
        : range.length === 2
          ? [range[0]!, range[1]!]
          : [range[0] ?? "", undefined];
    let sides: [Buffer | null, Buffer | null];
    try {
      sides = await Promise.all([
        this.blobBytes(before, oldPath),
        after === undefined ? this.worktreeBytes(relative) : this.blobBytes(after, relative),
      ]);
    } catch (error) {
      if (error instanceof HiveError && error.code === "WORKSPACE_TOO_LARGE")
        return { tooLarge: true };
      throw error;
    }
    if (!sides[0] && !sides[1]) return null;
    const decoded = sides.map((side) => (side ? decodeText(side) : { text: "" }));
    if (decoded.some((side) => side === null)) return null;
    const [old, next] = decoded as [
      { text: string; encoding?: TextEncodingLabel },
      { text: string; encoding?: TextEncodingLabel },
    ];
    const encoding = next.encoding ?? old.encoding;
    if (encoding !== "utf-16") return null;
    const diffed = await diffTexts(old.text, next.text, full ? FULL_CONTEXT : undefined, (args) =>
      readOnlyGit(this.root, args, { maxBytes: WORKSPACE_LIMITS.diffBytes }),
    );
    if (diffed === null) return { tooLarge: true };
    return { ...hunksOf(diffed), ...(full ? { full } : {}), encoding };
  }

  /** git 里某个版本（rev 为空是暂存区）的文件字节；不存在返回 null，超过 diff 上限报 WORKSPACE_TOO_LARGE */
  private async blobBytes(rev: string, relative: string): Promise<Buffer | null> {
    const shown = await readOnlyGit(this.root, ["cat-file", "blob", `${rev}:./${relative}`], {
      maxBytes: WORKSPACE_LIMITS.diffBytes,
    });
    return shown.code === 0 ? shown.stdout : null;
  }

  private async worktreeBytes(relative: string): Promise<Buffer | null> {
    let real: string;
    try {
      real = await resolveInside(this.root, relative);
    } catch {
      return null;
    }
    const info = await stat(real);
    if (!info.isFile()) return null;
    if (info.size > WORKSPACE_LIMITS.diffBytes) fail("WORKSPACE_TOO_LARGE", "File too large");
    return (await readHeadBytes(real, Math.max(1, info.size))).data;
  }

  private async resolveCommit(input: string): Promise<string> {
    const arg = commitArg(input);
    const result = await readOnlyGit(this.root, [
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${arg}^{commit}`,
    ]);
    if (result.code !== 0) fail("WORKSPACE_REF_NOT_FOUND", "Commit not found");
    return result.stdout.toString("utf8").trim();
  }

  /** 第一个父提交；根提交用空树 */
  private async parentOf(hash: string): Promise<string> {
    const parents = (await gitText(this.root, ["rev-list", "--parents", "-n", "1", hash]))
      .trim()
      .split(" ");
    if (parents[1]) return parents[1];
    return (await gitText(this.root, ["hash-object", "-t", "tree", "--stdin"])).trim();
  }

  /** base 分支（或提交）与 HEAD 的分叉点 */
  private async mergeBase(base: string): Promise<string> {
    if (base.startsWith("-") || /[\0\s~^:?*[\\]/.test(base) || base.includes(".."))
      fail("WORKSPACE_REF_INVALID", "Invalid base");
    const result = await readOnlyGit(this.root, ["merge-base", "--end-of-options", base, "HEAD"]);
    if (result.code !== 0) fail("WORKSPACE_REF_NOT_FOUND", "Base not found");
    return result.stdout.toString("utf8").trim();
  }

  /** 读文本：不存在或不是普通文件抛错，二进制返回 null，超过预览上限截断 */
  private async readText(relative: string): Promise<string | null> {
    return (await this.readDecoded(relative))?.text ?? null;
  }

  private async readDecoded(
    relative: string,
  ): Promise<{ text: string; encoding?: TextEncodingLabel } | null> {
    const real = await resolveInside(this.root, relative);
    const { content, binary, encoding } = await readHead(real, WORKSPACE_LIMITS.previewBytes);
    return binary ? null : { text: content, ...(encoding ? { encoding } : {}) };
  }

  /**
   * 批量确认哪些短哈希是这个仓库里真实存在的提交（聊天消息、白板里的提交号变成链接用）：
   * 一次 cat-file --batch-check，不存在、有歧义或不是提交的都不返回。返回 输入 → 完整提交号。
   */
  async resolveCommits(candidates: string[]): Promise<Map<string, string>> {
    const hashes = [...new Set(candidates.filter((item) => /^[0-9a-f]{7,40}$/i.test(item)))];
    const found = new Map<string, string>();
    if (!hashes.length || !(await this.repo())) return found;
    const result = await readOnlyGit(this.root, ["cat-file", "--batch-check"], {
      input: hashes.map((hash) => `${hash}^{commit}`).join("\n") + "\n",
      maxBytes: 1024 * 1024,
    });
    const lines = result.stdout.toString("utf8").split("\n");
    hashes.forEach((hash, index) => {
      const [sha, type] = (lines[index] ?? "").split(" ");
      if (type === "commit" && sha && /^[0-9a-f]{40,64}$/.test(sha)) found.set(hash, sha);
    });
    return found;
  }

  /**
   * 原始字节：工作区里的文件，或 git 里某个版本的 blob。返回大小和按区间打开的流（视频拖进度要 Range）。
   * ref：worktree 当前文件、index 暂存区、HEAD、提交号、parent:<提交号>（它的第一个父提交）、base:<分支>（与 HEAD 的分叉点）
   */
  async blob(
    relative: string,
    ref: string,
  ): Promise<{ size: number; open: (start: number, end: number) => Readable }> {
    const normalized = normalizeRelative(relative);
    if (!normalized) fail("WORKSPACE_PATH_INVALID", "Invalid path");
    if (ref === "worktree") {
      const real = await resolveInside(this.root, normalized);
      const info = await stat(real);
      if (!info.isFile()) fail("WORKSPACE_NOT_FILE", "Not a file");
      return {
        size: info.size,
        open: (start, end) => createReadStream(real, { start, end }),
      };
    }
    if (!(await this.repo())) fail("WORKSPACE_NOT_GIT", "Not a git repository");
    let rev: string;
    if (ref === "index") rev = "";
    else if (ref === "HEAD") rev = "HEAD";
    else if (ref.startsWith("parent:"))
      rev = await this.parentOf(await this.resolveCommit(ref.slice(7)));
    else if (ref.startsWith("base:")) rev = await this.mergeBase(ref.slice(5));
    else rev = await this.resolveCommit(ref);
    const spec = `${rev}:./${normalized}`;
    const sized = await readOnlyGit(this.root, ["cat-file", "-s", spec]);
    if (sized.code !== 0) fail("WORKSPACE_PATH_NOT_FOUND", "Path not found");
    const type = await readOnlyGit(this.root, ["cat-file", "-t", spec]);
    if (type.stdout.toString("utf8").trim() !== "blob") fail("WORKSPACE_NOT_FILE", "Not a file");
    return {
      size: Number(sized.stdout.toString("utf8").trim()),
      open: (start, end) => gitBlobStream(this.root, spec, start, end),
    };
  }

  async file(relative: string, reveal: boolean): Promise<WorkspaceFile> {
    const normalized = normalizeRelative(relative);
    const real = await resolveInside(this.root, normalized);
    const info = await stat(real);
    if (!info.isFile()) fail("WORKSPACE_NOT_FILE", "Not a file");
    const sensitive = isSensitivePath(normalized);
    const result: WorkspaceFile = {
      path: normalized,
      size: info.size,
      ...(sensitive ? { sensitive } : {}),
    };
    if (sensitive && !reveal) return result;
    const { content, binary, encoding } = await readHead(real, WORKSPACE_LIMITS.previewBytes);
    if (binary) return { ...result, binary };
    return {
      ...result,
      content,
      ...(encoding ? { encoding } : {}),
      ...(info.size > WORKSPACE_LIMITS.previewBytes ? { truncated: true } : {}),
    };
  }

  async tree(relative: string, options: { ignored: boolean }): Promise<WorkspaceTree> {
    const normalized = normalizeRelative(relative);
    const directory = await resolveInside(this.root, normalized);
    if (!(await stat(directory)).isDirectory()) fail("WORKSPACE_NOT_DIRECTORY", "Not a directory");
    const dirents = (await readdir(directory, { withFileTypes: true })).filter(
      (item) => item.name !== ".git",
    );
    const join = (name: string) => (normalized ? `${normalized}/${name}` : name);
    const entries: WorkspaceTreeEntry[] = [];
    for (const dirent of dirents) {
      const entryPath = join(dirent.name);
      const absolute = path.join(directory, dirent.name);
      const entry: WorkspaceTreeEntry = { name: dirent.name, path: entryPath, type: "other" };
      try {
        const info = await lstat(absolute);
        if (info.isSymbolicLink()) {
          entry.symlink = true;
          const target = await realpath(absolute).catch(() => undefined);
          if (!target || !isInside(this.root, target)) entry.outside = true;
          else {
            const targetInfo = await stat(target);
            entry.type = targetInfo.isDirectory()
              ? "directory"
              : targetInfo.isFile()
                ? "file"
                : "other";
            if (targetInfo.isFile()) entry.size = targetInfo.size;
          }
        } else if (info.isDirectory()) entry.type = "directory";
        else if (info.isFile()) {
          entry.type = "file";
          entry.size = info.size;
        }
      } catch {
        entry.outside = true;
      }
      if (isSensitivePath(entryPath)) entry.sensitive = true;
      entries.push(entry);
    }
    const repo = await this.repo();
    if (repo && entries.length) {
      const ignored = await this.ignoredOf(entries);
      for (const entry of entries) if (ignored.has(entry.path)) entry.ignored = true;
      const status = await this.status({ counts: false }).catch(() => undefined);
      if (status) {
        for (const entry of entries) {
          const prefix = `${entry.path}/`;
          const hit = status.changes.find((item) =>
            entry.type === "directory" ? item.path.startsWith(prefix) : item.path === entry.path,
          );
          if (hit) entry.status = hit.status;
        }
      }
    }
    const visible = entries
      .filter((entry) => options.ignored || !entry.ignored)
      .sort(
        (a, b) =>
          Number(b.type === "directory") - Number(a.type === "directory") ||
          a.name.localeCompare(b.name),
      );
    const truncated = visible.length > WORKSPACE_LIMITS.treeEntries;
    return {
      path: normalized,
      entries: visible.slice(0, WORKSPACE_LIMITS.treeEntries),
      ...(truncated ? { truncated } : {}),
    };
  }

  /** 哪些条目被 .gitignore 忽略（已跟踪的不算） */
  private async ignoredOf(entries: WorkspaceTreeEntry[]): Promise<Set<string>> {
    const input = entries
      .map((entry) => (entry.type === "directory" ? `${entry.path}/` : entry.path))
      .join("\0");
    const result = await readOnlyGit(this.root, ["check-ignore", "-z", "--stdin"], {
      input: `${input}\0`,
    }).catch(() => undefined);
    if (!result || (result.code !== 0 && result.code !== 1)) return new Set();
    return new Set(
      result.stdout
        .toString("utf8")
        .split("\0")
        .filter(Boolean)
        .map((item) => item.replace(/\/$/, "")),
    );
  }

  /** 按文件名搜索：git 仓库里是已跟踪 + 未忽略的文件，其他目录按层遍历 */
  async search(query: string): Promise<WorkspaceSearch> {
    const needle = query.trim().toLowerCase();
    if (!needle) return { paths: [] };
    const candidates = (await this.repo()) ? await this.gitFiles() : await this.walkFiles();
    const scored: Array<{ path: string; score: number }> = [];
    for (const file of candidates.files) {
      const lower = file.toLowerCase();
      const name = lower.slice(lower.lastIndexOf("/") + 1);
      const score =
        name === needle
          ? 0
          : name.startsWith(needle)
            ? 1
            : name.includes(needle)
              ? 2
              : lower.includes(needle)
                ? 3
                : subsequence(lower, needle)
                  ? 4
                  : -1;
      if (score >= 0) scored.push({ path: file, score });
    }
    scored.sort(
      (a, b) => a.score - b.score || a.path.length - b.path.length || a.path.localeCompare(b.path),
    );
    const truncated = scored.length > WORKSPACE_LIMITS.searchResults || candidates.truncated;
    return {
      paths: scored.slice(0, WORKSPACE_LIMITS.searchResults).map((item) => item.path),
      ...(truncated ? { truncated } : {}),
    };
  }

  private async gitFiles(): Promise<{ files: string[]; truncated: boolean }> {
    try {
      const output = await gitText(this.root, [
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
        "--deduplicate",
      ]);
      return { files: output.split("\0").filter(Boolean), truncated: false };
    } catch (error) {
      if (error instanceof HiveError && error.code === "WORKSPACE_TOO_LARGE")
        return { files: [], truncated: true };
      throw error;
    }
  }

  private async walkFiles(): Promise<{ files: string[]; truncated: boolean }> {
    const files: string[] = [];
    const queue = [""];
    let visited = 0;
    while (queue.length) {
      const directory = queue.shift()!;
      const dirents = await readdir(path.join(this.root, directory), { withFileTypes: true }).catch(
        () => [],
      );
      for (const dirent of dirents) {
        if (++visited > 50_000) return { files, truncated: true };
        if (dirent.name === ".git" || dirent.name === "node_modules") continue;
        const relative = directory ? `${directory}/${dirent.name}` : dirent.name;
        if (dirent.isDirectory()) queue.push(relative);
        else if (dirent.isFile()) files.push(relative);
      }
    }
    return { files, truncated: false };
  }
}

type Numstat = { additions?: number; deletions?: number; binary?: boolean };

function change(
  filePath: string,
  group: WorkspaceChange["group"],
  status: WorkspaceChangeStatus,
): WorkspaceChange {
  return {
    path: filePath,
    group,
    status,
    ...(isSensitivePath(filePath) ? { sensitive: true } : {}),
  };
}

function statusLetter(letter: string): WorkspaceChangeStatus {
  return (["M", "A", "D", "R", "C", "T", "U"] as const).find((item) => item === letter) ?? "M";
}

function countsOf(stats: Numstat | undefined): Numstat {
  if (!stats) return {};
  return stats.binary ? { binary: true } : { ...stats };
}

/** git diff --numstat -z：「增\t删\t路径\0」，重命名是「增\t删\t\0旧\0新\0」，二进制的增删是 - */
export function parseNumstat(output: string): Map<string, Numstat> {
  const stats = new Map<string, Numstat>();
  const fields = output.split("\0");
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (!field) continue;
    const [added = "", deleted = "", ...rest] = field.split("\t");
    let file = rest.join("\t");
    if (!file) {
      index++; // 旧路径
      file = fields[++index] ?? "";
    }
    if (!file) continue;
    stats.set(
      file,
      added === "-"
        ? { binary: true }
        : { additions: Number(added) || 0, deletions: Number(deleted) || 0 },
    );
  }
  return stats;
}

function parseLog(output: string): WorkspaceCommit[] {
  return output
    .split("\x1e")
    .map((record) => record.replace(/^\n/, ""))
    .filter(Boolean)
    .map((record) => {
      const [hash = "", shortHash = "", subject = "", author = "", date = ""] =
        record.split("\x1f");
      return { hash, shortHash, subject, author, date };
    });
}

/** 从 git diff 输出里取出 hunk 部分；二进制改动只给标记 */
export function hunksOf(output: string): Partial<WorkspaceDiff> {
  if (/^Binary files .* differ$/m.test(output) || /^GIT binary patch$/m.test(output))
    return { binary: true };
  const start = output.search(/^@@/m);
  return { patch: start < 0 ? "" : output.slice(start) };
}

/** 统一格式 diff 里的增删行数（不算 @@ 行和「No newline」标记） */
function patchCounts(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

function lineCount(text: string): number {
  if (!text) return 0;
  const lines = text.split("\n").length;
  return text.endsWith("\n") ? lines - 1 : lines;
}

function subsequence(haystack: string, needle: string): boolean {
  let index = 0;
  for (const char of haystack) if (char === needle[index] && ++index === needle.length) return true;
  return false;
}

/** 读文件开头并解码（规则见 workspace-text.ts 的 decodeText） */
async function readHead(
  file: string,
  limit: number,
): Promise<{ content: string; binary: boolean; encoding?: TextEncodingLabel }> {
  const { data, partial } = await readHeadBytes(file, limit);
  const decoded = decodeText(data, { partial });
  if (!decoded) return { content: "", binary: true };
  return {
    content: decoded.text,
    binary: false,
    ...(decoded.encoding ? { encoding: decoded.encoding } : {}),
  };
}

/** 文件开头最多 limit 字节；partial：读满了上限（后面可能还有） */
async function readHeadBytes(
  file: string,
  limit: number,
): Promise<{ data: Buffer; partial: boolean }> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(limit);
    const { bytesRead } = await handle.read(buffer, 0, limit, 0);
    return { data: buffer.subarray(0, bytesRead), partial: bytesRead === limit };
  } finally {
    await handle.close();
  }
}

/**
 * 按扩展名映射的可在页面里直接显示的类型；不在表里的一律当下载（application/octet-stream）。
 * 只认扩展名、不看内容，配合 nosniff，浏览器不会把别的东西当成 HTML 执行。
 */
export const INLINE_MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  m4a: "audio/mp4",
  flac: "audio/flac",
  pdf: "application/pdf",
};

export function inlineMediaType(relative: string): string | undefined {
  const name = relative.slice(relative.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 ? INLINE_MEDIA_TYPES[name.slice(dot + 1)] : undefined;
}

/** ref 的写法：worktree、index、HEAD、提交号、parent:<提交号>、base:<分支> */
export function isBlobRef(ref: string): boolean {
  if (ref === "worktree" || ref === "index" || ref === "HEAD") return true;
  if (/^(parent:)?[0-9a-f]{4,64}$/i.test(ref)) return true;
  return /^base:[^\0\s~^:?*[\\-][^\0\s~^:?*[\\]{0,199}$/.test(ref) && !ref.includes("..");
}

/** git 里一个 blob 的 [start, end] 区间：跳过前面的字节，够了就停 */
function gitBlobStream(cwd: string, spec: string, start: number, end: number): Readable {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const child = spawn(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "--no-pager",
      "-C",
      cwd,
      "cat-file",
      "blob",
      spec,
    ],
    {
      env: { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" },
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    },
  );
  const output = new PassThrough();
  let position = 0;
  const stop = () => {
    child.stdout.removeAllListeners("data");
    child.kill("SIGKILL");
    output.end();
  };
  child.stdout.on("data", (chunk: Buffer) => {
    const from = Math.max(0, start - position);
    const to = Math.min(chunk.length, end + 1 - position);
    position += chunk.length;
    if (to > from && !output.write(chunk.subarray(from, to))) {
      child.stdout.pause();
      output.once("drain", () => child.stdout.resume());
    }
    if (position > end) stop();
  });
  child.stdout.on("end", () => output.end());
  child.on("error", (error) => output.destroy(error));
  output.on("close", () => child.kill("SIGKILL"));
  return output;
}
