import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { userFsPromises } from "./user-fs.js";
import path from "node:path";
import {
  managedWorktreeSchema,
  createWorktreeRequestSchema,
  worktreeDependenciesSchema,
  serverText,
  zhText,
  type CreateWorktreeRequest,
  type ManagedWorktree,
  type Participant,
  type ServerText,
  type WorktreeDependencies,
  type WorktreeDiscardPreview,
  type WorktreeStatus,
} from "@superhive/protocol";
import { HiveDatabase, HiveError } from "./database.js";
import { gitOperationName, slowOps } from "./slow-ops.js";
import {
  dependencyPlan,
  planCommand,
  prepareDependencies,
  type DependencyOutcome,
} from "./worktree-deps.js";

const { lstat, mkdir, realpath } = userFsPromises;

type GitResult = { code: number; stdout: string; stderr: string };

/**
 * 任务目录和登记的对不上。switched：同一个 checkout，只是被人切到了另一条（有名字的）分支，
 * 这种情况房主可以就地修好（切回或按当前分支重新登记）。
 */
export class WorktreeIdentityError extends HiveError {
  constructor(
    text: ServerText,
    readonly switched?: { registered: string; current: string },
  ) {
    super("WORKTREE_IDENTITY", text);
  }
}

/** 没沿用「上次用的任务目录」的原因，交给 Bridge 写进这次开工的提示和任务卡片 */
export type FocusDropped = {
  focusDropped: { worktreeId: string; path: string; branch: string; reason: string };
};
type Checkout = { path: string; branch: string | undefined; locked: boolean };
type Repository = { repo: string; commonDir: string; target: string };

type RuntimeTask = {
  ownerName: string;
  invocationId: string;
  /** 同一件活的上游：子任务回执、回复唤醒的那一轮沿用它们的任务目录 */
  ancestorIds?: string[];
  /** 委派链更上面、这个 Agent 之前的别的活：它们的目录被清理了不影响这件新活，只告诉 Agent 一声 */
  earlierIds?: string[];
};
type RemovedWorktree = ManagedWorktree & { removed: true };

export type DependencySettings = {
  /** 测试注入；默认按锁文件安装，失败退回软链主目录 */
  prepare?: typeof prepareDependencies;
  /** hive_worktree_create 最多等多久；没装完就转后台，Agent 之后用 hive_worktree_list 查 */
  waitMs?: number;
  /** 安装命令的总时限 */
  timeoutMs?: number;
  /** 同时最多几条任务线在装依赖 */
  concurrency?: number;
};

export type WorktreeCleanupBatch = {
  id: string;
  roomId: string;
  ownerName: string;
  automatic: boolean;
  state: "available" | "queued" | "running" | "completed" | "expired";
  items: Array<{ id: string; repo: string; path: string; branch: string; headCommit: string }>;
  results?: Array<{ path: string; removed: boolean; branchDeleted?: boolean; error?: string }>;
};

/** 单条 git 命令的时限：建、删任务目录这类写操作在大仓库上可能要十几秒 */
const GIT_TIMEOUT_MS = 20_000;

/**
 * Bridge 查任务目录（开工前选目录、一轮跑完复核）整个请求的时限：排队等仓库锁加上里面所有 git 命令。
 * Bridge 每次只等 17 秒（packages/superhive 的 task-workspace.ts），Server 得比它先放弃、回 503 和原因，
 * 不然 Bridge 只看得到自己的超时。留 7 秒给负载高时请求排队进来、计时器晚触发和回包
 * （故障单 3493d392 那次，同一时刻 ls 都要 12 秒）；正常一次查询的 git 只要几十毫秒。
 */
export const LOOKUP_DEADLINE_MS = 10_000;

/** 查任务目录这一次请求的截止时间（performance.now()）：这次查询里起的 git 都不许超过它，建、删任务目录不受影响 */
const lookupDeadline = new AsyncLocalStorage<{ at: number; ms: number }>();

function lookupTimeout(ms: number): HiveError {
  return new HiveError(
    "WORKTREE_GIT_LIMIT",
    serverText("error.worktree.lookupTimeout", { seconds: String(Math.round(ms / 1000)) }),
  );
}

/**
 * 查任务目录超过截止时间就先回「忙」。没做完的那份在后台收尾：正在跑的 git 到点被结束；还在排队等锁的，
 * 排到时第一条 git 就直接报超时（spawnGit 不再起新进程），不会白跑一遍
 */
function beforeLookupDeadline<Result>(work: Promise<Result>, ms: number): Promise<Result> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(lookupTimeout(ms)), ms);
    timer.unref?.();
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

export async function worktreeGit(cwd: string, args: string[], input?: string): Promise<GitResult> {
  const started = performance.now();
  let failed = false;
  try {
    return await spawnGit(cwd, args, input);
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

function spawnGit(cwd: string, args: string[], input?: string): Promise<GitResult> {
  const deadline = lookupDeadline.getStore();
  const limitMs =
    deadline === undefined
      ? GIT_TIMEOUT_MS
      : Math.min(GIT_TIMEOUT_MS, deadline.at - performance.now());
  // 这次查询已经到点：不再起新的 git
  if (deadline && limitMs <= 0) return Promise.reject(lookupTimeout(deadline.ms));
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
        "-C",
        cwd,
        ...args,
      ],
      {
        env: { ...env, GIT_TERMINAL_PROMPT: "0" },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let stopped = false;
    const stop = (timedOut: boolean) => {
      if (stopped) return;
      stopped = true;
      child.kill("SIGKILL");
      reject(
        timedOut && deadline && limitMs < GIT_TIMEOUT_MS
          ? lookupTimeout(deadline.ms)
          : new HiveError(
              "WORKTREE_GIT_LIMIT",
              serverText("error.worktree.operation", { reason: "Git timeout/output limit" }),
            ),
      );
    };
    const timer = setTimeout(() => stop(true), limitMs);
    const collect = (chunk: string, target: "stdout" | "stderr") => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 16 * 1024 * 1024) return stop(false);
      if (target === "stdout") stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => collect(chunk, "stdout"));
    child.stderr.on("data", (chunk: string) => collect(chunk, "stderr"));
    child.stdin.on("error", () => undefined);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!stopped) resolve({ code: code ?? -1, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

async function git(cwd: string, args: string[], input?: string): Promise<string> {
  const result = await worktreeGit(cwd, args, input);
  if (result.code !== 0) {
    throw new HiveError(
      "WORKTREE_GIT_FAILED",
      serverText("error.worktree.operation", {
        reason: result.stderr.trim().slice(0, 1000) || `Git exit ${result.code}`,
      }),
    );
  }
  return result.stdout;
}

async function checkouts(repo: string): Promise<Checkout[]> {
  const output = await git(repo, ["worktree", "list", "--porcelain", "-z"]);
  return output
    .split("\0\0")
    .filter(Boolean)
    .map((block) => {
      const fields = block.split("\0");
      return {
        path: path.normalize(fields.find((field) => field.startsWith("worktree "))!.slice(9)),
        branch: fields.find((field) => field.startsWith("branch refs/heads/"))?.slice(18),
        locked: fields.some((field) => field === "locked" || field.startsWith("locked ")),
      };
    });
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  const result = await worktreeGit(repo, [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ]);
  if (result.code !== 0 && result.code !== 1)
    await git(repo, ["show-ref", "--verify", `refs/heads/${branch}`]);
  return result.code === 0;
}

async function validateBranch(repo: string, branch: string): Promise<void> {
  if (
    branch.startsWith("-") ||
    branch === "HEAD" ||
    (await worktreeGit(repo, ["check-ref-format", `refs/heads/${branch}`])).code !== 0
  ) {
    throw new HiveError(
      "WORKTREE_INVALID_REF",
      serverText("error.worktree.invalidRef", { ref: branch }),
    );
  }
}

async function commit(repo: string, ref: string): Promise<string> {
  if (ref.startsWith("-") || /[\0\r\n]/.test(ref)) {
    throw new HiveError("WORKTREE_INVALID_REF", serverText("error.worktree.invalidRef", { ref }));
  }
  return (await git(repo, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).trim();
}

export async function worktreeRepository(workspace: string): Promise<Repository> {
  try {
    const cwd = await realpath(workspace);
    if ((await git(cwd, ["rev-parse", "--is-bare-repository"])).trim() !== "false")
      throw new Error("Bare repository");
    const commonDir = await realpath(
      (await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim(),
    );
    const listed = await checkouts(cwd);
    const repo = await realpath(listed[0]!.path);
    let target: string | undefined;
    const remoteHead = await worktreeGit(repo, [
      "symbolic-ref",
      "--quiet",
      "refs/remotes/origin/HEAD",
    ]);
    const remoteBranch =
      remoteHead.code === 0
        ? remoteHead.stdout.trim().replace(/^refs\/remotes\/origin\//, "")
        : undefined;
    for (const name of [
      ...new Set(
        [remoteBranch, "main", "master"].filter((value): value is string => Boolean(value)),
      ),
    ]) {
      if (await branchExists(repo, name)) {
        target = name;
        break;
      }
    }
    if (!target) throw new Error("No local default branch (origin/HEAD, main or master)");
    return { repo, commonDir, target };
  } catch (error) {
    // git 超时只说明机器忙，不说明仓库有问题：原样抛出，调用方据此判断可以稍后重试
    if (error instanceof HiveError && error.code === "WORKTREE_GIT_LIMIT") throw error;
    throw new HiveError(
      "WORKTREE_REPOSITORY_INVALID",
      serverText("error.worktree.repository", {
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

/** fingerprint：目标分支名和两边分支的提交；有人提交或合入就对不上，立刻重新检查 */
type CachedStatus = { status: WorktreeStatus; at: number; fingerprint: string };

/** 同时检查几条任务线：一条要跑十几个 git 进程，全部并发会把机器拖慢，逐条串行又太久 */
const STATUS_CONCURRENCY = 4;
/** 合入判断按（分支提交, 目标提交）缓存：两边都没动结论就不会变，上限防止无限增长 */
const MERGE_CACHE_LIMIT = 1_000;

/** 列出的挡住清理的忽略文件最多几条：够人看清是什么，不把整个目录树塞进状态 */
const IGNORED_FILES_LIMIT = 20;
/** 丢弃前给房主看的提交最多列几条 */
const DISCARD_PREVIEW_LIMIT = 20;

/**
 * 能重新生成、清理时不用保护的忽略文件：任意层级的依赖目录（真实目录或软链，pnpm workspace
 * 各包下的也算）和构建产物。.env、本地配置等其余被忽略的文件照旧挡住清理。
 */
const DISPOSABLE_DIRECTORIES = new Set(["node_modules", "dist", "coverage", ".astro"]);

function disposableIgnored(entry: string): boolean {
  const parts = entry.replace(/\/$/, "").split("/");
  return parts.some((part) => DISPOSABLE_DIRECTORIES.has(part)) || entry.endsWith(".tsbuildinfo");
}

/**
 * `git ls-files --ignored --directory` 的输出里挡住清理的那些。只装着忽略文件的未跟踪目录会
 * 连同里面的条目一起列出（`apps/`、`apps/a/node_modules/`），这种外层目录只是容器，不单独算。
 */
export function blockingIgnored(entries: string[]): string[] {
  return entries.filter(
    (entry) =>
      !disposableIgnored(entry) &&
      !(entry.endsWith("/") && entries.some((other) => other !== entry && other.startsWith(entry))),
  );
}

function dependencyMessage(outcome: DependencyOutcome, durationMs: number) {
  const reason = serverText(
    `worktree.deps.reason.${outcome.reason ?? "error"}` as "worktree.deps.reason.error",
    { manager: outcome.manager ?? "npm" },
  );
  switch (outcome.state) {
    case "installed":
      return serverText("worktree.deps.installed", {
        command: outcome.command ?? "",
        seconds: String(Math.max(1, Math.round(durationMs / 1000))),
      });
    case "linked":
      return outcome.command
        ? serverText("worktree.deps.linked", { command: outcome.command, reason })
        : serverText("worktree.deps.linkedNoInstall");
    case "skipped":
      return serverText(
        outcome.reason === "present" ? "worktree.deps.present" : "worktree.deps.notNode",
      );
    default:
      return serverText("worktree.deps.failed", { reason });
  }
}

/**
 * 上次建立或清理半途而废（git 被杀、Server 重启）的目录。只在写锁里或 status 判断时用：
 * 写锁外看到的 creating/removing 可能正在进行，所以这里只认 removing 和 error
 */
function unfinished(record: ManagedWorktree): boolean {
  return record.phase === "removing" || record.phase === "error";
}

/** 尚未合入、但能确认后整条丢弃：目录完好、干净、没有任务占用（是否还在装依赖由调用方再看） */
function discardable(status: WorktreeStatus): boolean {
  return (
    !status.merged &&
    !status.error &&
    !status.missing &&
    !status.branchSwitched &&
    Boolean(status.headCommit) &&
    !status.dirty &&
    !status.untracked &&
    !status.ignored &&
    status.activeInvocationIds.length === 0 &&
    !unfinished(status.worktree)
  );
}

export class WorktreeManager {
  /** 写操作（建、删、选目录绑定任务）按仓库串行；只读的状态查询不进这个队列 */
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly statusCache = new Map<string, CachedStatus>();
  /** 每条任务线的写版本：写操作前后各加一，算到一半版本变了的状态不进缓存 */
  private readonly statusEpochs = new Map<string, number>();
  private readonly statusInflight = new Map<string, Promise<WorktreeStatus>>();
  /** 正在被写操作改动的任务线（id → 进行中的写操作数）：这期间读到的状态不算可清理、也不进缓存 */
  private readonly writes = new Map<string, number>();
  private readonly mergeCache = new Map<
    string,
    { merged: boolean; mergeMethod?: WorktreeStatus["mergeMethod"] }
  >();
  private scanning: Promise<void> | undefined;
  private closed = false;
  /** 正在准备依赖的任务线：装的时候目录在变，不算可清理 */
  private readonly dependencyJobs = new Map<string, Promise<WorktreeDependencies>>();
  /** 接着清理没做完的目录时上次失败的原因，同样的原因不重复记审计日志 */
  private readonly resumeFailures = new Map<string, string>();
  private installing = 0;
  private readonly installQueue: Array<() => void> = [];
  private readonly stopInstalls = new AbortController();

  constructor(
    private readonly options: {
      database: HiveDatabase;
      activeInvocations: (worktree: ManagedWorktree) => string[];
      onBoardChanged?: (roomId: string) => void;
      /**
       * 后台扫描发现任务线的分支已合入（分支上有过提交、不只是停在起点）：白板据此把对应条目转成已完成。
       * clean = 目录里没有未提交、未跟踪的改动
       */
      onMerged?: (record: ManagedWorktree, headCommit: string, clean: boolean) => void;
      onCleanup?: (batch: WorktreeCleanupBatch) => void;
      /** Server 替人做了决定（比如不再沿用某个任务目录）：记审计日志 */
      audit?: (message: string, details: Record<string, string>) => void;
      /** 只读状态（未提交/未跟踪/忽略文件）的缓存时长；写操作会立即作废对应任务线的缓存 */
      statusCacheMs?: number;
      /**
       * 沙箱预览：数据库是副本，但登记的路径指向真实仓库。只许读状态，不建、不删、不自动清理，
       * 免得副本里的记录把真实的任务目录删掉。
       */
      readOnly?: boolean;
      /** 新任务目录自动准备依赖；省略或 false 不准备 */
      dependencies?: DependencySettings | false;
      /** 查任务目录整个请求的时限；默认 LOOKUP_DEADLINE_MS，测试注入 */
      lookupDeadlineMs?: number;
    },
  ) {
    options.database.connection().exec(`CREATE TABLE IF NOT EXISTS managed_worktrees (
      id TEXT PRIMARY KEY, repo TEXT NOT NULL, agent_name TEXT NOT NULL, slug TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE, branch TEXT NOT NULL, record TEXT NOT NULL,
      UNIQUE(repo, agent_name, slug), UNIQUE(repo, branch)
    )`);
    options.database.connection().exec(`CREATE TABLE IF NOT EXISTS managed_worktree_focus (
      room_id TEXT NOT NULL, agent_name TEXT NOT NULL, worktree_id TEXT NOT NULL,
      PRIMARY KEY(room_id, agent_name)
    )`);
    options.database.connection().exec(`CREATE TABLE IF NOT EXISTS managed_worktree_bindings (
      invocation_id TEXT PRIMARY KEY, worktree_id TEXT NOT NULL
    )`);
    options.database.connection().exec(`CREATE TABLE IF NOT EXISTS managed_worktree_removals (
      id TEXT PRIMARY KEY, repo TEXT NOT NULL, record TEXT NOT NULL
    )`);
    options.database.connection().exec(`CREATE TABLE IF NOT EXISTS managed_worktree_notices (
      worktree_id TEXT PRIMARY KEY, head_commit TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS managed_worktree_cleanup (
      id TEXT PRIMARY KEY, record TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS managed_worktree_preferences (
      room_id TEXT PRIMARY KEY, auto_cleanup INTEGER NOT NULL DEFAULT 0
    ); CREATE TABLE IF NOT EXISTS managed_worktree_dependencies (
      worktree_id TEXT PRIMARY KEY, record TEXT NOT NULL
    )`);
    // 上次没装完 Server 就退出了：装到一半的状态不能一直挂着「准备中」
    for (const row of options.database
      .connection()
      .prepare("SELECT worktree_id, record FROM managed_worktree_dependencies")
      .all() as Array<{ worktree_id: string; record: string }>) {
      const record = worktreeDependenciesSchema.parse(JSON.parse(row.record));
      if (record.state !== "preparing") continue;
      this.saveDependencies(row.worktree_id, {
        ...record,
        state: "failed",
        finishedAt: new Date().toISOString(),
        message: zhText(serverText("worktree.deps.interrupted")),
      });
    }
  }

  allRecords(): ManagedWorktree[] {
    return (
      this.options.database
        .connection()
        .prepare("SELECT record FROM managed_worktrees ORDER BY rowid")
        .all() as Array<{ record: string }>
    ).map((row) => managedWorktreeSchema.parse(JSON.parse(row.record)));
  }

  autoCleanup(roomId: string): boolean {
    return Boolean(
      (
        this.options.database
          .connection()
          .prepare("SELECT auto_cleanup FROM managed_worktree_preferences WHERE room_id = ?")
          .get(roomId) as { auto_cleanup: number } | undefined
      )?.auto_cleanup,
    );
  }

  setAutoCleanup(roomId: string, enabled: boolean): void {
    this.options.database
      .connection()
      .prepare(
        "INSERT INTO managed_worktree_preferences (room_id, auto_cleanup) VALUES (?, ?) ON CONFLICT(room_id) DO UPDATE SET auto_cleanup = excluded.auto_cleanup",
      )
      .run(roomId, enabled ? 1 : 0);
    for (const batch of this.roomBatches(roomId)) {
      if (enabled && batch.state === "available") {
        batch.automatic = true;
        batch.state = "queued";
        this.saveBatch(batch);
      } else if (!enabled && batch.automatic && batch.state === "queued") {
        batch.automatic = false;
        batch.state = "available";
        this.saveBatch(batch);
      }
    }
  }

  cleanupBatch(id: string): WorktreeCleanupBatch | undefined {
    const row = this.options.database
      .connection()
      .prepare("SELECT record FROM managed_worktree_cleanup WHERE id = ?")
      .get(id) as { record: string } | undefined;
    return row ? (JSON.parse(row.record) as WorktreeCleanupBatch) : undefined;
  }

  roomBatches(roomId: string, statuses?: WorktreeStatus[]): WorktreeCleanupBatch[] {
    const batches = (
      this.options.database
        .connection()
        .prepare("SELECT record FROM managed_worktree_cleanup ORDER BY rowid DESC")
        .all() as Array<{ record: string }>
    )
      .map((row) => JSON.parse(row.record) as WorktreeCleanupBatch)
      .filter(
        (batch) => batch.roomId === roomId && !["completed", "expired"].includes(batch.state),
      );
    if (!statuses) return batches;
    const current = new Map(statuses.map((item) => [item.worktree.id, item]));
    return batches
      .filter((batch) => batch.state === "available")
      .map((batch) => ({
        ...batch,
        items: batch.items.filter((item) => {
          const status = current.get(item.id);
          return status?.removable && status.headCommit === item.headCommit;
        }),
      }))
      .filter((batch) => batch.items.length > 0);
  }

  private pruneCleanupBatches(statuses: WorktreeStatus[] = []): void {
    const records = new Set(this.allRecords().map((item) => item.id));
    const current = new Map(statuses.map((item) => [item.worktree.id, item]));
    const rows = this.options.database
      .connection()
      .prepare("SELECT record FROM managed_worktree_cleanup")
      .all() as Array<{ record: string }>;
    for (const row of rows) {
      const batch = JSON.parse(row.record) as WorktreeCleanupBatch;
      if (batch.state !== "available") continue;
      const items = batch.items.filter(
        (item) =>
          records.has(item.id) &&
          (!current.get(item.id)?.headCommit ||
            current.get(item.id)?.headCommit === item.headCommit),
      );
      if (items.length === batch.items.length) continue;
      batch.items = items;
      if (!items.length) batch.state = "expired";
      this.saveBatch(batch);
      this.options.onCleanup?.(batch);
    }
  }

  private saveBatch(batch: WorktreeCleanupBatch): void {
    this.options.database
      .connection()
      .prepare(
        "INSERT INTO managed_worktree_cleanup (id, record) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET record = excluded.record",
      )
      .run(batch.id, JSON.stringify(batch));
  }

  requestCleanup(id: string, ownerName: string): boolean {
    const batch = this.cleanupBatch(id);
    if (!batch || batch.ownerName !== ownerName || ["completed", "expired"].includes(batch.state))
      return false;
    if (batch.state !== "available") return true;
    batch.state = "queued";
    this.saveBatch(batch);
    return true;
  }

  scan(): Promise<void> {
    if (this.closed || this.options.readOnly) return Promise.resolve();
    if (this.scanning) return this.scanning;
    this.scanning = this.scanInner().finally(() => {
      this.scanning = undefined;
    });
    return this.scanning;
  }

  private async scanInner(): Promise<void> {
    const groups = new Map<string, WorktreeCleanupBatch>();
    const statuses: WorktreeStatus[] = [];
    for (const record of this.allRecords()) {
      if (this.closed) return;
      // 后台定时扫描，不在写锁里，也不急：每次都重新检查，不用缓存
      const status = await this.status(record);
      statuses.push(status);
      // 被换了分支的目录：不清理，只在白板上提示房主
      if (status.branchSwitched) this.markSwitched(record, status.branchSwitched.current);
      if (
        status.merged &&
        status.headCommit &&
        status.headCommit !== record.baseCommit &&
        !status.error
      )
        this.options.onMerged?.(record, status.headCommit, !status.dirty && !status.untracked);
      if (!status.removable || !status.headCommit) continue;
      if (unfinished(record)) {
        await this.resumeRemoval(record, status.headCommit);
        continue;
      }
      const notice = this.options.database
        .connection()
        .prepare("SELECT head_commit FROM managed_worktree_notices WHERE worktree_id = ?")
        .get(record.id) as { head_commit: string } | undefined;
      if (notice?.head_commit === status.headCommit) continue;
      const key = `${record.roomId}\0${record.ownerName}`;
      const automatic = this.autoCleanup(record.roomId);
      const batch = groups.get(key) ?? {
        id: randomUUID(),
        roomId: record.roomId,
        ownerName: record.ownerName,
        automatic,
        state: automatic ? ("queued" as const) : ("available" as const),
        items: [],
      };
      batch.items.push({
        id: record.id,
        repo: record.repo,
        path: record.path,
        branch: record.branch,
        headCommit: status.headCommit,
      });
      groups.set(key, batch);
    }
    this.pruneCleanupBatches(statuses);
    for (const batch of groups.values()) {
      if (this.closed) return;
      this.options.database.connection().transaction(() => {
        this.saveBatch(batch);
        const statement = this.options.database
          .connection()
          .prepare(
            "INSERT INTO managed_worktree_notices (worktree_id, head_commit) VALUES (?, ?) ON CONFLICT(worktree_id) DO UPDATE SET head_commit = excluded.head_commit",
          );
        for (const item of batch.items) statement.run(item.id, item.headCommit);
      })();
      if (!batch.automatic) this.options.onCleanup?.(batch);
    }
    const pending = this.options.database
      .connection()
      .prepare("SELECT record FROM managed_worktree_cleanup")
      .all() as Array<{ record: string }>;
    for (const row of pending) {
      if (this.closed) return;
      const batch = JSON.parse(row.record) as WorktreeCleanupBatch;
      if (!["queued", "running"].includes(batch.state)) continue;
      batch.state = "running";
      this.saveBatch(batch);
      batch.results ??= [];
      for (const item of batch.items) {
        if (this.closed) return;
        if (batch.automatic && !this.autoCleanup(batch.roomId)) {
          batch.automatic = false;
          batch.state = "available";
          this.saveBatch(batch);
          break;
        }
        if (batch.results.some((result) => result.path === item.path)) continue;
        try {
          const result = await this.remove(item.repo, {
            path: item.path,
            expectedCommit: item.headCommit,
          });
          batch.results.push({
            path: item.path,
            removed: true,
            branchDeleted: result.branchDeleted,
            ...(result.branchError ? { error: result.branchError } : {}),
          });
        } catch (error) {
          batch.results.push({
            path: item.path,
            removed: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        this.saveBatch(batch);
      }
      if (batch.state === "available") continue;
      batch.state = "completed";
      this.saveBatch(batch);
      this.options.onCleanup?.(batch);
    }
  }

  /**
   * 接着清理上次没做完的目录（#4274：清理时 git 被中途杀掉，目录停在删了一半）。已合入、
   * 只缺了已跟踪的文件、没有任务在用才会走到这里，删掉不会丢东西，不再等房主确认；
   * 结果写进审计日志，失败就留着，下次扫描再试
   */
  private async resumeRemoval(record: ManagedWorktree, headCommit: string): Promise<void> {
    try {
      await this.remove(record.repo, { path: record.path, expectedCommit: headCommit });
      this.options.audit?.(zhText(serverText("worktree.removalResumed", { path: record.path })), {
        roomId: record.roomId,
        agentName: record.agentName,
        worktreeId: record.id,
      });
    } catch (error) {
      // 扫描期间已被别的清理删掉的，不用再提
      if (error instanceof HiveError && error.code === "WORKTREE_UNREGISTERED") return;
      const reason = error instanceof Error ? error.message : String(error);
      // 每次扫描都会重试，同样的原因只记一次
      if (this.resumeFailures.get(record.id) === reason) return;
      this.resumeFailures.set(record.id, reason);
      this.options.audit?.(
        zhText(
          serverText("worktree.removalResumeFailed", {
            path: record.path,
            reason,
          }),
        ),
        { roomId: record.roomId, agentName: record.agentName, worktreeId: record.id },
      );
    }
  }

  dependencies(id: string): WorktreeDependencies | undefined {
    const row = this.options.database
      .connection()
      .prepare("SELECT record FROM managed_worktree_dependencies WHERE worktree_id = ?")
      .get(id) as { record: string } | undefined;
    return row ? worktreeDependenciesSchema.parse(JSON.parse(row.record)) : undefined;
  }

  private saveDependencies(id: string, record: WorktreeDependencies): void {
    this.options.database
      .connection()
      .prepare(
        "INSERT INTO managed_worktree_dependencies (worktree_id, record) VALUES (?, ?) ON CONFLICT(worktree_id) DO UPDATE SET record = excluded.record",
      )
      .run(id, JSON.stringify(record));
  }

  /**
   * 建好（或复用）任务线后准备依赖，不占仓库写锁。最多等 waitMs，没装完就返回「准备中」，
   * 后台接着装，结果之后在 hive_worktree_list 里看。
   */
  private async prepareDependenciesFor(
    record: ManagedWorktree,
  ): Promise<WorktreeDependencies | undefined> {
    const settings = this.options.dependencies;
    if (!settings || this.options.readOnly) return undefined;
    let job = this.dependencyJobs.get(record.id);
    if (!job) {
      const known = this.dependencies(record.id);
      // 复用的目录准备过就不再重来（Agent 之后自己改依赖、重装都由它决定）
      if (known) return known;
      job = this.startDependencies(record, settings);
    }
    // Codex 的 MCP 工具默认 60 秒超时，留出建目录的时间
    const waitMs = settings.waitMs ?? 30_000;
    let timer: NodeJS.Timeout | undefined;
    const finished = await Promise.race([
      job,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), waitMs);
      }),
    ]).finally(() => clearTimeout(timer));
    return finished ?? this.dependencies(record.id);
  }

  private startDependencies(
    record: ManagedWorktree,
    settings: DependencySettings,
  ): Promise<WorktreeDependencies> {
    const startedAt = new Date();
    const job = (async () => {
      const plan = await dependencyPlan(record.path).catch(() => undefined);
      const command = plan ? planCommand(plan) : undefined;
      this.saveDependencies(record.id, {
        state: "preparing",
        ...(plan ? { manager: plan.manager, command } : {}),
        startedAt: startedAt.toISOString(),
        message: zhText(
          serverText("worktree.deps.preparing", { command: command ?? "node_modules" }),
        ),
      });
      this.invalidate(record.id);
      await this.installSlot(settings.concurrency ?? 3);
      let outcome: DependencyOutcome;
      try {
        outcome = await (settings.prepare ?? prepareDependencies)({
          worktree: record.path,
          primary: record.repo,
          packageDirs: await this.packageDirs(record),
          signal: this.stopInstalls.signal,
          ...(settings.timeoutMs ? { timeoutMs: settings.timeoutMs } : {}),
        });
      } catch (error) {
        outcome = {
          state: "failed",
          reason: "error",
          output: error instanceof Error ? error.message : String(error),
        };
      } finally {
        this.installing--;
        this.installQueue.shift()?.();
      }
      const finishedAt = new Date();
      const result: WorktreeDependencies = {
        state: outcome.state,
        ...(outcome.manager ? { manager: outcome.manager } : {}),
        ...(outcome.command ? { command: outcome.command } : {}),
        ...(outcome.output ? { output: outcome.output } : {}),
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        message: zhText(dependencyMessage(outcome, finishedAt.getTime() - startedAt.getTime())),
      };
      // 装的过程中任务线被清理、或 Server 在关：不再写回
      if (!this.closed && this.records(record.repo).some((item) => item.id === record.id))
        this.saveDependencies(record.id, result);
      this.invalidate(record.id);
      return result;
    })().finally(() => this.dependencyJobs.delete(record.id));
    this.dependencyJobs.set(record.id, job);
    return job;
  }

  private installSlot(limit: number): Promise<void> {
    if (this.installing < limit) {
      this.installing++;
      return Promise.resolve();
    }
    return new Promise((resolve) =>
      this.installQueue.push(() => {
        this.installing++;
        resolve();
      }),
    );
  }

  /** 仓库里登记的 package.json 所在目录：monorepo 的每个包各有一份 node_modules */
  private async packageDirs(record: ManagedWorktree): Promise<string[]> {
    const files = (await git(record.path, ["ls-files", "-z", "--", "*package.json"]))
      .split("\0")
      .filter(
        (file) =>
          path.posix.basename(file) === "package.json" && !file.split("/").includes("node_modules"),
      );
    return [
      ...new Set(
        files.map((file) => path.posix.dirname(file)).map((dir) => (dir === "." ? "" : dir)),
      ),
    ];
  }

  private assertWritable(): void {
    if (this.options.readOnly)
      throw new HiveError("SANDBOX_DISABLED", serverText("error.sandbox.disabled"));
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopInstalls.abort();
    await this.scanning;
  }

  records(repo: string): ManagedWorktree[] {
    const rows = this.options.database
      .connection()
      .prepare("SELECT record FROM managed_worktrees WHERE repo = ? ORDER BY rowid")
      .all(repo) as Array<{ record: string }>;
    return rows.map((row) => managedWorktreeSchema.parse(JSON.parse(row.record)));
  }

  private save(record: ManagedWorktree): void {
    this.options.database
      .connection()
      .prepare("UPDATE managed_worktrees SET record = ? WHERE id = ?")
      .run(JSON.stringify(record), record.id);
  }

  private focus(record: ManagedWorktree): void {
    this.options.database
      .connection()
      .prepare(
        `INSERT INTO managed_worktree_focus (room_id, agent_name, worktree_id) VALUES (?, ?, ?)
         ON CONFLICT(room_id, agent_name) DO UPDATE SET worktree_id = excluded.worktree_id`,
      )
      .run(record.roomId, record.agentName, record.id);
  }

  /**
   * 不再把这个 Agent 的新任务默认放进这个目录。写一条审计日志（谁、哪个目录、为什么），
   * 返回给 Bridge 的说明会写进这次开工的提示和任务卡片。
   */
  private dropFocus(actor: Participant, record: ManagedWorktree, reason: string): FocusDropped {
    this.options.database
      .connection()
      .prepare(
        "DELETE FROM managed_worktree_focus WHERE room_id = ? AND agent_name = ? AND worktree_id = ?",
      )
      .run(actor.roomId, actor.username, record.id);
    this.options.audit?.(
      zhText(
        serverText("worktree.focusDropped", {
          agent: actor.username,
          path: record.path,
          reason,
        }),
      ),
      { roomId: actor.roomId, agentName: actor.username, worktreeId: record.id },
    );
    return {
      focusDropped: { worktreeId: record.id, path: record.path, branch: record.branch, reason },
    };
  }

  /** 白板上这条任务目录标成阻塞：写明登记的、现在的分支和房主能做的事。没变就不重写 */
  private markSwitched(record: ManagedWorktree, current: string): void {
    const author = this.options.database.findParticipant(record.roomId, record.agentName);
    if (!author) return;
    try {
      const board = this.options.database.upsertWhiteboardEntry(author, {
        key: `worktree:${record.id}`,
        slot: "blocked",
        summary: zhText(
          serverText("worktree.branchSwitched", {
            registered: record.branch,
            current,
            path: record.path,
          }),
        ).slice(0, 500),
        repo: path.basename(record.repo),
        branch: record.branch,
        claim: { repo: record.repo, branch: record.branch },
      });
      if (board.changed) this.options.onBoardChanged?.(record.roomId);
    } catch {
      // 白板只是提示；写不进去（比如别人占着这个 key）不影响任务目录本身的判断
    }
  }

  /** 恢复正常后白板上的这条回到进行中 */
  private markRegistered(record: ManagedWorktree): void {
    const author = this.options.database.findParticipant(record.roomId, record.agentName);
    if (!author) return;
    const board = this.options.database.upsertWhiteboardEntry(author, {
      key: `worktree:${record.id}`,
      slot: "in_progress",
      summary: zhText(
        serverText("worktree.created", { branch: record.branch, path: record.path }),
      ).slice(0, 500),
      repo: path.basename(record.repo),
      branch: record.branch,
      claim: { repo: record.repo, branch: record.branch },
    });
    if (board.changed) this.options.onBoardChanged?.(record.roomId);
  }

  private bind(record: ManagedWorktree, invocationIds: string[]): void {
    const statement = this.options.database.connection().prepare(
      `INSERT INTO managed_worktree_bindings (invocation_id, worktree_id) VALUES (?, ?)
       ON CONFLICT(invocation_id) DO UPDATE SET worktree_id = excluded.worktree_id`,
    );
    for (const id of invocationIds) statement.run(id, record.id);
  }

  private removedRecords(repo?: string): RemovedWorktree[] {
    return (
      this.options.database
        .connection()
        .prepare(
          "SELECT record FROM managed_worktree_removals WHERE (? IS NULL OR repo = ?) ORDER BY rowid DESC",
        )
        .all(repo ?? null, repo ?? null) as Array<{ record: string }>
    ).map((row) => ({ ...managedWorktreeSchema.parse(JSON.parse(row.record)), removed: true }));
  }

  confirmedRemoval(actor: Participant, invocationIds: string[]): RemovedWorktree | undefined {
    return this.removedRecords().find(
      (record) =>
        record.roomId === actor.roomId &&
        record.agentName === actor.username &&
        invocationIds.some((id) => record.invocationIds.includes(id)),
    );
  }

  private finishRemoval(record: ManagedWorktree, missing = false): RemovedWorktree {
    this.invalidate(record.id);
    this.options.database.connection().transaction(() => {
      this.options.database
        .connection()
        .prepare("INSERT INTO managed_worktree_removals (id, repo, record) VALUES (?, ?, ?)")
        .run(record.id, record.repo, JSON.stringify(record));
      this.options.database
        .connection()
        .prepare("DELETE FROM managed_worktree_focus WHERE worktree_id = ?")
        .run(record.id);
      this.options.database
        .connection()
        .prepare("DELETE FROM managed_worktree_bindings WHERE worktree_id = ?")
        .run(record.id);
      this.options.database
        .connection()
        .prepare("DELETE FROM managed_worktree_dependencies WHERE worktree_id = ?")
        .run(record.id);
      this.options.database
        .connection()
        .prepare("DELETE FROM managed_worktrees WHERE id = ?")
        .run(record.id);
      const summary = zhText(
        serverText(missing ? "worktree.missingReleased" : "worktree.cleaned", {
          path: record.path,
        }),
      );
      this.options.database
        .connection()
        .prepare(
          // updated_at 是白板归档/清空的版本号：状态变了就得跟着变
          "UPDATE whiteboard_entries SET slot = 'milestone', summary = ?, updated_at = ? WHERE key = ? AND claim_repo = ? AND claim_branch = ?",
        )
        .run(
          summary,
          new Date().toISOString(),
          `worktree:${record.id}`,
          record.repo,
          record.branch,
        );
    })();
    this.options.onBoardChanged?.(record.roomId);
    this.pruneCleanupBatches();
    return { ...record, removed: true };
  }

  async runtimeWorkspace(
    workspace: string,
    actor: Participant,
    ownerName: string,
    invocationId: string,
  ): Promise<ManagedWorktree | RemovedWorktree | FocusDropped | undefined> {
    return (await this.runtimeWorkspaces(workspace, actor, [{ ownerName, invocationId }])).get(
      invocationId,
    );
  }

  /**
   * 给 Bridge 选或复核任务目录。整个请求（排队等仓库锁、里面所有 git）在 lookupDeadlineMs 内答不上来就报
   * WORKTREE_GIT_LIMIT（接口回 503），比 Bridge 自己的超时先到，它拿得到明确的原因、稍后再问。
   */
  async runtimeWorkspaces(
    workspace: string,
    actor: Participant,
    tasks: RuntimeTask[],
  ): Promise<Map<string, ManagedWorktree | RemovedWorktree | FocusDropped | undefined>> {
    const ms = this.options.lookupDeadlineMs ?? LOOKUP_DEADLINE_MS;
    const work = lookupDeadline.run({ at: performance.now() + ms, ms }, () =>
      this.selectRuntimeWorkspaces(workspace, actor, tasks),
    );
    return beforeLookupDeadline(work, ms);
  }

  private async selectRuntimeWorkspaces(
    workspace: string,
    actor: Participant,
    tasks: RuntimeTask[],
  ): Promise<Map<string, ManagedWorktree | RemovedWorktree | FocusDropped | undefined>> {
    const binding = this.options.database
      .connection()
      .prepare("SELECT worktree_id FROM managed_worktree_bindings WHERE invocation_id = ?");
    const focus = this.options.database
      .connection()
      .prepare(
        "SELECT worktree_id FROM managed_worktree_focus WHERE room_id = ? AND agent_name = ?",
      )
      .get(actor.roomId, actor.username) as { worktree_id: string } | undefined;
    const selections = tasks.map((task) => {
      const bound = binding.get(task.invocationId) as { worktree_id: string } | undefined;
      return { ...task, bound, selected: bound ?? focus };
    });
    const result = new Map<string, ManagedWorktree | RemovedWorktree | FocusDropped | undefined>(
      tasks.map((task) => [task.invocationId, undefined]),
    );
    if (
      !selections.some((task) => task.selected) &&
      !this.confirmedRemoval(
        actor,
        tasks.flatMap((task) => [
          task.invocationId,
          ...(task.ancestorIds ?? []),
          ...(task.earlierIds ?? []),
        ]),
      )
    )
      return result;
    const repository = await worktreeRepository(workspace);
    return this.serial(repository.repo, "runtimeWorkspaces", async () => {
      const records = new Map(this.records(repository.repo).map((record) => [record.id, record]));
      const removed = this.removedRecords(repository.repo);
      const occupants = new Map<ManagedWorktree, string[]>();
      // 只是沿用「上次用的任务目录」（没绑定、也不是接着上游的那条）选中的任务
      const viaFocus = new Set<string>();
      for (const task of selections) {
        const previous = removed.find(
          (record) =>
            record.agentName === actor.username &&
            record.roomId === actor.roomId &&
            [task.invocationId, ...(task.ancestorIds ?? [])].some((id) =>
              record.invocationIds.includes(id),
            ),
        );
        const inherited = previous
          ? (task.ancestorIds ?? [])
              .map((id) => {
                const bound = binding.get(id) as { worktree_id: string } | undefined;
                return bound ? records.get(bound.worktree_id) : undefined;
              })
              .find(
                (record) => record?.agentName === actor.username && record.roomId === actor.roomId,
              )
          : undefined;
        const record =
          (task.bound ? records.get(task.bound.worktree_id) : undefined) ??
          inherited ??
          previous ??
          (task.selected ? records.get(task.selected.worktree_id) : undefined);
        if (!record) {
          if (
            !task.bound &&
            task.selected &&
            removed.some(
              (item) =>
                item.id === task.selected!.worktree_id &&
                item.ownerName === task.ownerName &&
                item.agentName === actor.username &&
                item.roomId === actor.roomId,
            )
          )
            continue;
          if (task.selected)
            throw new HiveError(
              "WORKTREE_IDENTITY",
              serverText("error.worktree.identity", { path: task.selected.worktree_id }),
            );
          // 上一件活的目录已经合入清理，这是派来的新活：回默认目录开工，并告诉 Agent 那个目录不在了
          const earlier = removed.find(
            (item) =>
              item.agentName === actor.username &&
              item.roomId === actor.roomId &&
              (task.earlierIds ?? []).some((id) => item.invocationIds.includes(id)),
          );
          if (earlier)
            result.set(
              task.invocationId,
              this.dropFocus(actor, earlier, zhText(serverText("worktree.focusCleaned"))),
            );
          continue;
        }
        if (
          record.ownerName !== task.ownerName ||
          record.agentName !== actor.username ||
          record.roomId !== actor.roomId
        )
          throw new HiveError(
            "WORKTREE_UNSAFE",
            serverText("error.worktree.unsafe", { path: record.path }),
          );
        if (!task.bound && !inherited && !previous) viaFocus.add(task.invocationId);
        if ("removed" in record) result.set(task.invocationId, record);
        else occupants.set(record, [...(occupants.get(record) ?? []), task.invocationId]);
      }
      const missing = new Set<ManagedWorktree>();
      const stale = new Map<ManagedWorktree, string>();
      for (const record of occupants.keys()) {
        if (await this.missingCheckout(record, repository.target)) {
          if (
            this.options
              .activeInvocations(record)
              .some((id) => !tasks.some((task) => task.invocationId === id))
          )
            throw new HiveError(
              "WORKTREE_UNSAFE",
              serverText("error.worktree.unsafe", { path: record.path }),
            );
          missing.add(record);
        } else {
          if (record.phase !== "ready") {
            const error = new HiveError(
              "WORKTREE_UNSAFE",
              serverText("error.worktree.unfinished", { path: record.path }),
            );
            // 和换了分支一样：上次建或清理没做完的目录，只是被默认沿用时去掉这个选择，回默认目录开工
            if (!occupants.get(record)!.every((id) => viaFocus.has(id))) throw error;
            stale.set(record, error.message);
            continue;
          }
          try {
            await this.identity(record);
          } catch (error) {
            if (!(error instanceof WorktreeIdentityError)) throw error;
            if (error.switched) this.markSwitched(record, error.switched.current);
            // 绑定在这个目录上的任务照旧失败，原因写清楚。只是沿用「上次用的任务目录」的新任务不再被它卡住
            // （否则这个 Agent 之后每次派活都会失败）：去掉这个默认选择，并把原因带给 Agent，不静默落到默认目录
            if (!occupants.get(record)!.every((id) => viaFocus.has(id))) throw error;
            stale.set(record, error.message);
          }
        }
      }
      for (const [record, reason] of stale) {
        for (const id of occupants.get(record)!)
          result.set(id, this.dropFocus(actor, record, reason));
        occupants.delete(record);
      }
      for (const [record, ids] of occupants) {
        if (missing.has(record)) {
          if (
            !(await this.missingCheckout(record, repository.target)) ||
            this.options
              .activeInvocations(record)
              .some((id) => !tasks.some((task) => task.invocationId === id))
          )
            throw new HiveError(
              "WORKTREE_IDENTITY",
              serverText("error.worktree.identity", { path: record.path }),
            );
          const released = this.finishRemoval(record, true);
          for (const id of ids) {
            const task = selections.find((task) => task.invocationId === id)!;
            if (
              task.bound ||
              [id, ...(task.ancestorIds ?? [])].some((ancestor) =>
                record.invocationIds.includes(ancestor),
              )
            )
              result.set(id, released);
          }
          continue;
        }
        record.invocationIds = [...new Set([...record.invocationIds, ...ids])];
        this.save(record);
        this.bind(record, ids);
        for (const id of ids) result.set(id, record);
      }
      return result;
    });
  }

  /**
   * 仓库级写锁：同一仓库的建、删、选目录一个一个来。排队和持有的时长合起来超过阈值就记一条慢操作，
   * 看得出是谁占着锁、别人等了多久。
   */
  private async serial<Result>(
    repo: string,
    name: string,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const previous = this.queues.get(repo) ?? Promise.resolve();
    const queued = performance.now();
    let acquired: number | undefined;
    const next = previous
      .catch(() => undefined)
      .then(() => {
        acquired = performance.now();
        return operation();
      });
    this.queues.set(repo, next);
    let failed = false;
    try {
      return await next;
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      if (this.queues.get(repo) === next) this.queues.delete(repo);
      const released = performance.now();
      slowOps.record({
        kind: "lock",
        name: `worktrees.lock ${name}`,
        waitMs: (acquired ?? released) - queued,
        durationMs: acquired === undefined ? 0 : released - acquired,
        repo,
        ...(failed ? { failed } : {}),
      });
    }
  }

  async create(
    workspace: string,
    actor: Participant,
    ownerName: string,
    invocationIds: string[],
    input: CreateWorktreeRequest,
  ): Promise<{
    worktree: ManagedWorktree;
    reused: boolean;
    dependencies?: WorktreeDependencies;
  }> {
    this.assertWritable();
    input = createWorktreeRequestSchema.parse(input);
    const repository = await worktreeRepository(workspace);
    const created = await this.createIn(repository, actor, ownerName, invocationIds, input);
    const dependencies = await this.prepareDependenciesFor(created.worktree);
    return { ...created, ...(dependencies ? { dependencies } : {}) };
  }

  private createIn(
    repository: Repository,
    actor: Participant,
    ownerName: string,
    invocationIds: string[],
    input: CreateWorktreeRequest,
  ): Promise<{ worktree: ManagedWorktree; reused: boolean }> {
    return this.serial(repository.repo, "create", async () => {
      const existing = this.records(repository.repo).find(
        (record) => record.agentName === actor.username && record.slug === input.slug,
      );
      if (existing) {
        if (
          existing.roomId !== actor.roomId ||
          existing.ownerName !== ownerName ||
          (input.branch && existing.branch !== input.branch) ||
          (input.base && existing.base !== input.base)
        ) {
          throw new HiveError(
            "WORKTREE_CONFLICT",
            serverText("error.worktree.conflict", { path: existing.path }),
          );
        }
        return this.writing(existing.id, async () => {
          try {
            await this.identity(existing);
          } catch (error) {
            if (!(error instanceof WorktreeIdentityError) || !error.switched) throw error;
            this.markSwitched(existing, error.switched.current);
            throw new WorktreeIdentityError(
              serverText("error.worktree.reuseSwitched", {
                slug: existing.slug,
                path: existing.path,
                branch: existing.branch,
                current: error.switched.current,
              }),
              error.switched,
            );
          }
          existing.phase = "ready";
          existing.invocationIds = [...new Set([...existing.invocationIds, ...invocationIds])];
          const board = this.options.database.upsertWhiteboardEntry(actor, {
            key: `worktree:${existing.id}`,
            slot: "in_progress",
            summary: zhText(
              serverText("worktree.created", { branch: existing.branch, path: existing.path }),
            ).slice(0, 500),
            repo: path.basename(existing.repo),
            branch: existing.branch,
            claim: { repo: existing.repo, branch: existing.branch },
          });
          this.save(existing);
          this.focus(existing);
          this.bind(existing, invocationIds);
          if (board.changed) this.options.onBoardChanged?.(actor.roomId);
          return { worktree: existing, reused: true };
        });
      }
      const agentSlug = actor.username
        .toLowerCase()
        .replace(/[^\p{L}\p{N}_.-]/gu, "-")
        .replace(/^-+|-+$/g, "");
      if (!agentSlug)
        throw new HiveError(
          "WORKTREE_INVALID_REF",
          serverText("error.worktree.invalidRef", { ref: actor.username }),
        );
      const branch = input.branch ?? `feat/${agentSlug}-${input.slug}`;
      await validateBranch(repository.repo, branch);
      const base = input.base ?? repository.target;
      const baseCommit = await commit(
        repository.repo,
        input.base ?? `refs/heads/${repository.target}`,
      );
      const root = path.join(path.dirname(repository.repo), `${path.basename(repository.repo)}-wt`);
      await mkdir(root, { recursive: true });
      if ((await realpath(root)) !== root)
        throw new HiveError(
          "WORKTREE_IDENTITY",
          serverText("error.worktree.identity", { path: root }),
        );
      const worktreePath = path.join(root, `${agentSlug}-${input.slug}`);
      const present = await lstat(worktreePath).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
          return false;
        },
      );
      if (present || (await branchExists(repository.repo, branch))) {
        throw new HiveError(
          "WORKTREE_CONFLICT",
          serverText("error.worktree.conflict", { path: worktreePath }),
        );
      }
      const record: ManagedWorktree = {
        ...repository,
        id: randomUUID(),
        path: worktreePath,
        branch,
        base,
        baseCommit,
        slug: input.slug,
        roomId: actor.roomId,
        agentName: actor.username,
        ownerName,
        invocationIds,
        createdAt: new Date().toISOString(),
        phase: "creating",
      };
      return this.writing(record.id, async () => {
        this.options.database.connection().transaction(() => {
          this.options.database.assertBranchClaimAvailable(repository.repo, branch);
          this.options.database
            .connection()
            .prepare(
              `INSERT INTO managed_worktrees
          (id, repo, agent_name, slug, path, branch, record) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              record.id,
              record.repo,
              record.agentName,
              record.slug,
              record.path,
              record.branch,
              JSON.stringify(record),
            );
          this.options.database.upsertWhiteboardEntry(actor, {
            key: `worktree:${record.id}`,
            slot: "in_progress",
            summary: zhText(
              serverText("worktree.created", { branch: record.branch, path: record.path }),
            ).slice(0, 500),
            repo: path.basename(record.repo),
            branch,
            claim: { repo: record.repo, branch },
          });
        })();
        this.options.onBoardChanged?.(actor.roomId);
        try {
          await git(repository.repo, [
            "worktree",
            "add",
            "-b",
            branch,
            "--",
            worktreePath,
            baseCommit,
          ]);
          await this.identity(record);
          record.phase = "ready";
          this.focus(record);
          this.bind(record, invocationIds);
          this.save(record);
          return { worktree: record, reused: false };
        } catch (error) {
          record.phase = "error";
          this.save(record);
          throw error;
        }
      });
    });
  }

  /** 任务目录还是登记的那一个：路径、仓库、分支都对得上。对不上时说清楚是哪一种 */
  private async identity(record: ManagedWorktree): Promise<void> {
    const params = { path: record.path, branch: record.branch };
    const stat = await lstat(record.path).catch(() => undefined);
    if (!stat?.isDirectory() && !stat?.isSymbolicLink())
      throw new WorktreeIdentityError(serverText("error.worktree.missingDirectory", params));
    if (stat.isSymbolicLink() || (await realpath(record.path)) !== record.path)
      throw new WorktreeIdentityError(serverText("error.worktree.replaced", params));
    const checkout = (await checkouts(record.repo)).find((item) => item.path === record.path);
    if (!checkout)
      throw new WorktreeIdentityError(serverText("error.worktree.notCheckout", params));
    const commonDir = await git(record.path, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ])
      .then((output) => realpath(output.trim()))
      .catch((error: unknown) => {
        // 机器忙（git 超时）照旧抛出，可以稍后重试；目录里根本不是 Git 仓库就是被换掉了
        if (error instanceof HiveError && error.code === "WORKTREE_GIT_LIMIT") throw error;
        throw new WorktreeIdentityError(serverText("error.worktree.replaced", params));
      });
    if (commonDir !== record.commonDir)
      throw new WorktreeIdentityError(serverText("error.worktree.otherRepository", params));
    if (checkout.locked)
      throw new WorktreeIdentityError(serverText("error.worktree.locked", params));
    if (!checkout.branch)
      throw new WorktreeIdentityError(serverText("error.worktree.detached", params));
    // 最常见的：有人在任务目录里直接 git checkout/switch 到了别的分支
    if (checkout.branch !== record.branch)
      throw new WorktreeIdentityError(
        serverText("error.worktree.branchChanged", { ...params, current: checkout.branch }),
        { registered: record.branch, current: checkout.branch },
      );
  }

  private async missingCheckout(record: ManagedWorktree, expectedTarget: string): Promise<boolean> {
    const present = await lstat(record.path).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    );
    if (present) return false;
    const repository = await worktreeRepository(record.repo);
    if (
      repository.repo !== record.repo ||
      repository.commonDir !== record.commonDir ||
      repository.target !== expectedTarget ||
      record.target !== expectedTarget
    )
      throw new HiveError(
        "WORKTREE_IDENTITY",
        serverText("error.worktree.identity", { path: record.path }),
      );
    return (
      !(await checkouts(record.repo)).some((checkout) => checkout.path === record.path) &&
      !(await branchExists(record.repo, record.branch))
    );
  }

  private async merged(
    record: ManagedWorktree,
  ): Promise<{ merged: boolean; mergeMethod?: WorktreeStatus["mergeMethod"] }> {
    const tip = await commit(record.repo, `refs/heads/${record.branch}`);
    const target = await commit(record.repo, `refs/heads/${record.target}`);
    const key = `${record.repo}\0${tip}\0${target}`;
    const known = this.mergeCache.get(key);
    if (known) return known;
    const result = await slowOps.track("worktrees.merged", { repo: record.path }, () =>
      this.mergedBetween(record, tip, target),
    );
    if (this.mergeCache.size >= MERGE_CACHE_LIMIT)
      this.mergeCache.delete(this.mergeCache.keys().next().value!);
    this.mergeCache.set(key, result);
    return result;
  }

  private async mergedBetween(
    record: ManagedWorktree,
    tip: string,
    target: string,
  ): Promise<{ merged: boolean; mergeMethod?: WorktreeStatus["mergeMethod"] }> {
    const ancestor = await worktreeGit(record.repo, ["merge-base", "--is-ancestor", tip, target]);
    if (ancestor.code === 0) return { merged: true, mergeMethod: "ancestor" };
    if (ancestor.code !== 1) await git(record.repo, ["merge-base", "--is-ancestor", tip, target]);
    const fork = (await git(record.repo, ["merge-base", tip, target])).trim();
    const cherry = (await git(record.repo, ["cherry", target, tip]))
      .trim()
      .split("\n")
      .filter(Boolean);
    const merges = (await git(record.repo, ["rev-list", "--merges", `${fork}..${tip}`])).trim();
    if (!merges && cherry.length > 0 && cherry.every((line) => line.startsWith("- "))) {
      return { merged: true, mergeMethod: "patches" };
    }
    const diff = await git(record.repo, [
      "diff",
      "--binary",
      "--no-ext-diff",
      "--no-textconv",
      fork,
      tip,
      "--",
    ]);
    const patch = (await git(record.repo, ["patch-id", "--stable"], diff)).trim().split(" ")[0];
    if (!patch) return { merged: false };
    const history = (
      await git(record.repo, [
        "rev-list",
        "--first-parent",
        "--max-count=500",
        `${fork}..${target}`,
      ])
    )
      .trim()
      .split("\n")
      .filter(Boolean);
    for (const revision of history) {
      const parent = await commit(record.repo, `${revision}^1`);
      const change = await git(record.repo, [
        "diff",
        "--binary",
        "--no-ext-diff",
        "--no-textconv",
        parent,
        revision,
        "--",
      ]);
      const candidate = (await git(record.repo, ["patch-id", "--stable"], change))
        .trim()
        .split(" ")[0];
      if (candidate === patch) return { merged: true, mergeMethod: "squash" };
    }
    return { merged: false };
  }

  async status(record: ManagedWorktree, expectedTarget = record.target): Promise<WorktreeStatus> {
    const status = await slowOps.track("worktrees.status", { repo: record.path }, () =>
      this.inspect(record, expectedTarget),
    );
    const dependencies = this.dependencies(record.id);
    const settled = !this.dependencyJobs.has(record.id);
    return {
      ...status,
      ...(dependencies ? { dependencies } : {}),
      removable: status.removable && settled,
      discardable: discardable(status) && settled,
    };
  }

  private async inspect(record: ManagedWorktree, expectedTarget: string): Promise<WorktreeStatus> {
    const activeInvocationIds = this.options.activeInvocations(record);
    try {
      if (record.target !== expectedTarget)
        throw new HiveError(
          "WORKTREE_IDENTITY",
          serverText("error.worktree.identity", { path: record.path }),
        );
      if (await this.missingCheckout(record, expectedTarget))
        return {
          worktree: record,
          dirty: false,
          untracked: false,
          ignored: false,
          merged: false,
          missing: true,
          activeInvocationIds,
          removable: activeInvocationIds.length === 0,
        };
      await this.identity(record);
      const { dirty, untracked } = await this.changes(record.path, unfinished(record));
      // --directory：整个被忽略的目录只列一行，node_modules 里成千上万个文件不用逐个列出
      const ignoredFiles = blockingIgnored(
        (
          await git(record.path, [
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "--directory",
            "-z",
          ])
        )
          .split("\0")
          .filter(Boolean),
      );
      const ignored = ignoredFiles.length > 0;
      const merged = await this.merged(record);
      return {
        worktree: record,
        dirty,
        untracked,
        ignored,
        ...(ignored ? { ignoredFiles: ignoredFiles.slice(0, IGNORED_FILES_LIMIT) } : {}),
        headCommit: await commit(record.repo, `refs/heads/${record.branch}`),
        ...merged,
        activeInvocationIds,
        removable:
          !dirty && !untracked && !ignored && merged.merged && activeInvocationIds.length === 0,
      };
    } catch (error) {
      const switched = error instanceof WorktreeIdentityError ? error.switched : undefined;
      // 只是换了分支：目录本身是好的，照常看有没有未提交的文件（房主据此判断能不能切回）
      const changes = switched ? await this.changes(record.path).catch(() => undefined) : undefined;
      return {
        worktree: record,
        dirty: changes?.dirty ?? false,
        untracked: changes?.untracked ?? false,
        ignored: false,
        merged: false,
        activeInvocationIds,
        removable: false,
        error: error instanceof Error ? error.message : String(error),
        ...(switched ? { branchSwitched: switched } : {}),
      };
    }
  }

  /**
   * leftoverDeletions：上次建立或清理半途而废的目录里，已跟踪文件被删掉是 git 删到一半留下的，
   * 内容都还在分支提交里，不算改动；改了、新加的文件照旧算
   */
  private async changes(
    directory: string,
    leftoverDeletions = false,
  ): Promise<{ dirty: boolean; untracked: boolean }> {
    const entries = (
      await git(directory, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
    )
      .split("\0")
      .filter(Boolean);
    return {
      dirty: entries.some(
        (entry) => !entry.startsWith("?? ") && !(leftoverDeletions && /^[ D]{2} /.test(entry)),
      ),
      untracked: entries.some((entry) => entry.startsWith("?? ")),
    };
  }

  /**
   * 列出任务线状态。只读，不进写锁：建、删、选目录不会排在这一长串 git 检查后面（#3944：
   * 一次扫 17 条约 110 秒，期间 Agent 开工前选目录全部超时）。读到的可能是写操作进行中的
   * 中间状态，所以正在建/删的一律不算可清理；真正删除时 remove() 会在写锁里重新确认。
   */
  async list(workspace: string): Promise<WorktreeStatus[]> {
    const repository = await worktreeRepository(workspace);
    return slowOps.track("worktrees.list", { repo: repository.repo }, () =>
      this.listIn(repository),
    );
  }

  private async listIn(repository: Repository): Promise<WorktreeStatus[]> {
    const records = this.records(repository.repo);
    // 一次读出所有分支的提交，用来判断缓存是否还对得上（比逐条 rev-parse 省得多）
    const tips = new Map(
      (
        await git(repository.repo, [
          "for-each-ref",
          "--format=%(refname)%00%(objectname)",
          "refs/heads/",
        ])
      )
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split("\0") as [string, string]),
    );
    const statuses: Array<WorktreeStatus | undefined> = Array.from({ length: records.length });
    let next = 0;
    const worker = async () => {
      while (next < records.length) {
        const index = next++;
        const record = records[index]!;
        const fingerprint = [
          repository.target,
          tips.get(`refs/heads/${record.branch}`) ?? "",
          tips.get(`refs/heads/${repository.target}`) ?? "",
        ].join("\0");
        statuses[index] = await this.cachedStatus(record, repository.target, fingerprint);
      }
    };
    await Promise.all(Array.from({ length: Math.min(STATUS_CONCURRENCY, records.length) }, worker));
    const current = new Map(this.records(repository.repo).map((record) => [record.id, record]));
    const result = statuses
      .filter((status): status is WorktreeStatus => Boolean(status))
      .flatMap((status) => {
        // 检查期间被删掉的不再列出；记录本身（阶段、绑定的任务）以最新的为准
        const record = current.get(status.worktree.id);
        return record ? [this.live(status, record)] : [];
      });
    this.pruneCleanupBatches(result);
    return result;
  }

  /** 缓存里的 git 检查结果配上最新的记录和正在执行的任务，重新判断能不能清理 */
  private live(status: WorktreeStatus, record: ManagedWorktree): WorktreeStatus {
    const activeInvocationIds = this.options.activeInvocations(record);
    const idle = activeInvocationIds.length === 0;
    const clean = status.missing
      ? true
      : !status.error && !status.dirty && !status.untracked && !status.ignored && status.merged;
    const dependencies = this.dependencies(record.id);
    return {
      ...status,
      worktree: record,
      activeInvocationIds,
      ...(dependencies ? { dependencies } : {}),
      removable:
        clean && idle && !this.writes.has(record.id) && !this.dependencyJobs.has(record.id),
      discardable:
        discardable({ ...status, worktree: record, activeInvocationIds }) &&
        !this.writes.has(record.id) &&
        !this.dependencyJobs.has(record.id),
    };
  }

  private invalidate(id: string): void {
    this.statusEpochs.set(id, (this.statusEpochs.get(id) ?? 0) + 1);
    this.statusCache.delete(id);
  }

  /** 在写锁里改动一条任务线：前后都作废它的状态缓存，进行中的只读检查结果也不会被留下 */
  private async writing<Result>(id: string, operation: () => Promise<Result>): Promise<Result> {
    this.writes.set(id, (this.writes.get(id) ?? 0) + 1);
    this.invalidate(id);
    try {
      return await operation();
    } finally {
      const left = (this.writes.get(id) ?? 1) - 1;
      if (left > 0) this.writes.set(id, left);
      else this.writes.delete(id);
      this.invalidate(id);
    }
  }

  private async cachedStatus(
    record: ManagedWorktree,
    expectedTarget: string,
    fingerprint: string,
  ): Promise<WorktreeStatus> {
    const ttl = this.options.statusCacheMs ?? 15_000;
    const cached = this.statusCache.get(record.id);
    if (cached && cached.fingerprint === fingerprint && Date.now() - cached.at < ttl)
      return this.live(cached.status, record);
    // 同一时刻几个人同时打开列表：同一条任务线只检查一次，大家共用结果
    const key = `${record.id}\0${fingerprint}`;
    const pending = this.statusInflight.get(key);
    if (pending) return this.live(await pending, record);
    const epoch = this.statusEpochs.get(record.id) ?? 0;
    const started = Date.now();
    const running = this.status(record, expectedTarget);
    this.statusInflight.set(key, running);
    try {
      const status = await running;
      // 检查期间有写操作（建、删）碰过这条任务线，结果可能是中间状态，不留给后面的人用
      if (
        ttl > 0 &&
        (this.statusEpochs.get(record.id) ?? 0) === epoch &&
        !this.writes.has(record.id)
      )
        this.statusCache.set(record.id, { status, at: started, fingerprint });
      return this.live(status, record);
    } finally {
      if (this.statusInflight.get(key) === running) this.statusInflight.delete(key);
    }
  }

  /**
   * 房主修好「被换了分支」的任务目录：
   * - restore：在目录里切回登记的分支。只在工作区干净（没有未提交、未跟踪的文件）时做，免得把改动带过去或弄丢；
   * - adopt：按目录现在的分支重新登记。新分支不能已被别的任务线登记或占用。
   * 两种都要等绑定在这个目录上的任务全部结束，免得 Agent 正在里面干活时目录变了。
   */
  async repair(
    workspace: string,
    id: string,
    action: "restore" | "adopt",
  ): Promise<WorktreeStatus> {
    this.assertWritable();
    const repository = await worktreeRepository(workspace);
    return this.serial(repository.repo, `repair ${action}`, async () => {
      const record = this.records(repository.repo).find((item) => item.id === id);
      if (!record)
        throw new HiveError(
          "WORKTREE_UNREGISTERED",
          serverText("error.worktree.unregistered", { path: id }),
        );
      return this.writing(record.id, async () => {
        const status = await this.status(record, repository.target);
        const switched = status.branchSwitched;
        if (!switched)
          throw new HiveError(
            "WORKTREE_NOT_SWITCHED",
            serverText("error.worktree.notSwitched", { path: record.path }),
          );
        const active = this.options.activeInvocations(record);
        if (active.length)
          throw new HiveError(
            "WORKTREE_BUSY",
            serverText("error.worktree.repairBusy", { path: record.path, count: active.length }),
          );
        if (action === "restore") {
          const changes = await this.changes(record.path);
          if (changes.dirty || changes.untracked)
            throw new HiveError(
              "WORKTREE_DIRTY",
              serverText("error.worktree.restoreDirty", {
                path: record.path,
                branch: record.branch,
              }),
            );
          const elsewhere = (await checkouts(record.repo)).some(
            (item) => item.branch === record.branch && item.path !== record.path,
          );
          if (elsewhere || !(await branchExists(record.repo, record.branch)))
            throw new HiveError(
              "WORKTREE_BRANCH_GONE",
              serverText("error.worktree.restoreBranchGone", { branch: record.branch }),
            );
          await validateBranch(record.repo, record.branch);
          // 分支名已核对过合法、存在、不以 - 开头
          await git(record.path, ["switch", "--no-guess", record.branch]);
        } else {
          const branch = switched.current;
          await validateBranch(record.repo, branch);
          const taken = this.records(record.repo).some(
            (item) => item.id !== record.id && item.branch === branch,
          );
          if (taken)
            throw new HiveError(
              "WORKTREE_CLAIM_CONFLICT",
              serverText("error.worktree.adoptTaken", { branch, path: record.path }),
            );
          try {
            this.options.database.assertBranchClaimAvailable(
              record.repo,
              branch,
              (
                this.options.database
                  .connection()
                  .prepare("SELECT id FROM whiteboard_entries WHERE room_id = ? AND key = ?")
                  .get(record.roomId, `worktree:${record.id}`) as { id: string } | undefined
              )?.id,
            );
          } catch {
            throw new HiveError(
              "WORKTREE_CLAIM_CONFLICT",
              serverText("error.worktree.adoptTaken", { branch, path: record.path }),
            );
          }
          const previous = record.branch;
          record.branch = branch;
          this.options.database
            .connection()
            .prepare("UPDATE managed_worktrees SET branch = ?, record = ? WHERE id = ?")
            .run(branch, JSON.stringify(record), record.id);
          this.options.audit?.(
            `任务目录 ${record.path} 按当前分支重新登记：${previous} → ${branch}`,
            {
              roomId: record.roomId,
              agentName: record.agentName,
              worktreeId: record.id,
            },
          );
        }
        await this.identity(record);
        this.markRegistered(record);
        return this.status(record, repository.target);
      });
    });
  }

  async remove(
    workspace: string,
    input: { path: string; deleteBranch?: boolean; expectedCommit?: string },
  ): Promise<{ removed: true; branchDeleted: boolean; branchError?: string }> {
    this.assertWritable();
    const repository = await worktreeRepository(workspace);
    return this.serial(repository.repo, "remove", async () => {
      const record = this.records(repository.repo).find((item) => item.path === input.path);
      if (!record)
        throw new HiveError(
          "WORKTREE_UNREGISTERED",
          serverText("error.worktree.unregistered", { path: input.path }),
        );
      return this.writing(record.id, async () => {
        const status = await this.status(record, repository.target);
        if (!status.removable || this.dependencyJobs.has(record.id))
          throw new HiveError(
            "WORKTREE_UNSAFE",
            serverText("error.worktree.unsafe", { path: input.path }),
          );
        if (status.missing) {
          if (
            input.expectedCommit ||
            !(await this.missingCheckout(record, repository.target)) ||
            this.options.activeInvocations(record).length
          )
            throw new HiveError(
              "WORKTREE_UNSAFE",
              serverText("error.worktree.unsafe", { path: record.path }),
            );
          this.finishRemoval(record, true);
          return { removed: true, branchDeleted: true };
        }
        const tip = await commit(record.repo, `refs/heads/${record.branch}`);
        if (input.expectedCommit && tip !== input.expectedCommit)
          throw new HiveError(
            "WORKTREE_UNSAFE",
            serverText("error.worktree.unsafe", { path: record.path }),
          );
        const resuming = unfinished(record);
        record.phase = "removing";
        this.save(record);
        try {
          await this.identity(record);
          if (
            this.options.activeInvocations(record).length !== 0 ||
            (await commit(record.repo, `refs/heads/${record.branch}`)) !== tip
          ) {
            throw new HiveError(
              "WORKTREE_UNSAFE",
              serverText("error.worktree.unsafe", { path: record.path }),
            );
          }
          // 上次没删完的目录里缺的文件会被 git 当成改动而拒绝；上面已确认只缺了已跟踪的文件，可以强制删
          await git(record.repo, [
            "worktree",
            "remove",
            ...(resuming ? ["--force"] : []),
            "--",
            record.path,
          ]);
        } catch (error) {
          record.phase = "error";
          this.save(record);
          throw error;
        }
        let branchDeleted = false;
        let branchError: string | undefined;
        if (input.deleteBranch !== false) {
          try {
            if ((await commit(record.repo, `refs/heads/${record.branch}`)) !== tip) {
              branchError = zhText(serverText("error.worktree.identity", { path: record.path }));
            } else {
              const deletion = await worktreeGit(record.repo, [
                "branch",
                "-d",
                "--",
                record.branch,
              ]);
              branchDeleted = deletion.code === 0;
              if (!branchDeleted)
                branchError = zhText(
                  serverText("error.worktree.branchRetained", { branch: record.branch }),
                );
            }
          } catch (error) {
            branchError = error instanceof Error ? error.message : String(error);
          }
        }
        this.finishRemoval(record);
        return { removed: true, branchDeleted, ...(branchError ? { branchError } : {}) };
      });
    });
  }

  /** 「丢弃并删除」前给房主看：这条分支上有、目标分支上没有的提交 */
  async discardPreview(workspace: string, path: string): Promise<WorktreeDiscardPreview> {
    const repository = await worktreeRepository(workspace);
    const record = this.records(repository.repo).find((item) => item.path === path);
    if (!record)
      throw new HiveError(
        "WORKTREE_UNREGISTERED",
        serverText("error.worktree.unregistered", { path }),
      );
    const headCommit = await commit(record.repo, `refs/heads/${record.branch}`);
    const { total, commits } = await this.unmergedCommits(
      record,
      headCommit,
      DISCARD_PREVIEW_LIMIT,
    );
    return { headCommit, total, commits };
  }

  private async unmergedCommits(
    record: ManagedWorktree,
    tip: string,
    limit?: number,
  ): Promise<{ total: number; commits: Array<{ hash: string; subject: string }> }> {
    const range = [tip, "--not", `refs/heads/${record.target}`, "--"];
    const total = Number((await git(record.repo, ["rev-list", "--count", ...range])).trim());
    const commits = (
      await git(record.repo, [
        "log",
        "--format=%H%x1f%s%x1e",
        ...(limit ? [`--max-count=${limit}`] : []),
        ...range,
      ])
    )
      .split("\x1e")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [hash = "", subject = ""] = entry.split("\x1f");
        return { hash, subject };
      });
    return { total, commits };
  }

  /**
   * 房主确认后丢弃一条尚未合入的任务线：删目录，分支用 -D 删（合入前被变基、git 认不出已合入的
   * 也能清掉）。只在目录干净、没有任务占用、分支还停在房主看到的那个提交时才删；丢掉的提交号写进审计日志
   */
  async discard(
    workspace: string,
    input: { path: string; expectedCommit: string; by: string },
  ): Promise<{
    removed: true;
    branchDeleted: boolean;
    branchError?: string;
    discarded: string[];
  }> {
    this.assertWritable();
    const repository = await worktreeRepository(workspace);
    return this.serial(repository.repo, "discard", async () => {
      const record = this.records(repository.repo).find((item) => item.path === input.path);
      if (!record)
        throw new HiveError(
          "WORKTREE_UNREGISTERED",
          serverText("error.worktree.unregistered", { path: input.path }),
        );
      const unsafe = () =>
        new HiveError(
          "WORKTREE_UNSAFE",
          serverText("error.worktree.discardUnsafe", { path: record.path }),
        );
      return this.writing(record.id, async () => {
        const status = await this.status(record, repository.target);
        if (!status.discardable || status.headCommit !== input.expectedCommit) throw unsafe();
        const tip = input.expectedCommit;
        const { commits } = await this.unmergedCommits(record, tip);
        const discarded = commits.map((item) => item.hash);
        record.phase = "removing";
        this.save(record);
        try {
          await this.identity(record);
          if (
            this.options.activeInvocations(record).length !== 0 ||
            (await commit(record.repo, `refs/heads/${record.branch}`)) !== tip
          )
            throw unsafe();
          // 不加 --force：目录里这时冒出改动，git 会拒绝，宁可不删
          await git(record.repo, ["worktree", "remove", "--", record.path]);
        } catch (error) {
          record.phase = "error";
          this.save(record);
          throw error;
        }
        let branchDeleted = false;
        let branchError: string | undefined;
        try {
          if ((await commit(record.repo, `refs/heads/${record.branch}`)) !== tip) {
            branchError = zhText(serverText("error.worktree.identity", { path: record.path }));
          } else {
            const deletion = await worktreeGit(record.repo, ["branch", "-D", "--", record.branch]);
            branchDeleted = deletion.code === 0;
            if (!branchDeleted)
              branchError = zhText(
                serverText("error.worktree.branchRetained", { branch: record.branch }),
              );
          }
        } catch (error) {
          branchError = error instanceof Error ? error.message : String(error);
        }
        this.finishRemoval(record);
        this.options.audit?.(
          zhText(
            serverText("worktree.discarded", {
              by: input.by,
              path: record.path,
              branch: record.branch,
              count: discarded.length,
            }),
          ),
          {
            roomId: record.roomId,
            agentName: record.agentName,
            worktreeId: record.id,
            branch: record.branch,
            headCommit: tip,
            by: input.by,
            discardedCommits: discarded.join(","),
          },
        );
        return {
          removed: true,
          branchDeleted,
          ...(branchError ? { branchError } : {}),
          discarded,
        };
      });
    });
  }
}
