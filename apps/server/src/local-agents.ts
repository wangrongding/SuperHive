import { serverText } from "@superhive/protocol";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { spawnBackground } from "./background-process.js";
import {
  closeSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  maskProxyUrl,
  isAgentOutdated,
  runtimeReasoningEfforts,
  supportsClaudeContextSettings,
  supportsReasoningEffort,
  type ClaudeCacheTtl,
  type ClaudeCompactWindow,
} from "@superhive/protocol";
import type {
  AgentCodeVersion,
  CreateLocalAgentRequest,
  LocalAgent,
  LocalAgentMcpResponse,
  LocalAgentModelsResponse,
  LocalAgentProvider,
  LocalAgentStatus,
  LocalProviderInfo,
} from "@superhive/protocol";
import { codeVersionAt, packageRootOfCli } from "./code-version.js";
import { HiveError, type HiveDatabase, type LocalAgentConfig } from "./database.js";
import { expandHome, homeDirectory, isDesktopInstallDirectory } from "./local-directories.js";
import { slowOps } from "./slow-ops.js";
import { applyProxyEnv, type ProxyEnvPatch } from "./network-proxy.js";
import { commandFor } from "./windows-command.js";

/**
 * 本机 Agent 管家：在 Hive Server 所在电脑上，按房主在网页上的选择拉起 `hive join` 子进程。
 * 只负责进程生命周期（启动、崩溃重启、停止、退出清理），Agent 的行为仍完全由 CLI 决定。
 * 鉴权与"是否本机请求"的判断在路由层（local-access.ts），这里假定调用方已通过校验。
 */

/** superhive CLI 的启动方式：打包后是 node + dist/cli.js，开发时是 node + tsx + src/cli.ts */
export type AgentCli = { command: string; args: string[] };

export type ChildHandle = {
  pid: number | undefined;
  /** pid 要稍后才知道时（Windows 上由 PowerShell 代为拉起）：拿到后 resolve；拉起失败时 resolve undefined */
  pidReady?: Promise<number | undefined>;
  onOutput(listener: (chunk: string) => void): void;
  onExit(listener: (code: number | null, error?: Error) => void): void;
  kill(signal: NodeJS.Signals): void;
  /** 交接给下一个 Server：停止跟踪输出和退出，但不结束进程 */
  release?(): void;
};

export type SpawnAgent = (
  command: string,
  args: string[],
  /** logFile：输出写到这个文件而不是管道，Server 退出后 Agent 仍能继续运行 */
  options: {
    env: Record<string, string>;
    /** 先从继承的环境里去掉的变量（不分大小写），例如「不用代理」时的 HTTPS_PROXY */
    unsetEnv?: readonly string[];
    cwd: string;
    logFile?: string;
  },
) => ChildHandle;

/** 接管上一个 Server 留下的 Agent 进程；进程已不在或不是这个 Agent 时返回 undefined */
export type AdoptAgent = (
  pid: number,
  options: { name: string; logFile?: string },
) => ChildHandle | undefined;

export type ProviderProbe = (
  command: string,
) => Promise<{ installed: boolean; version: string | null }>;

export type LocalAgentSupervisorOptions = {
  database: HiveDatabase;
  cli: AgentCli;
  /** Agent 连接 Hive 用的地址（本机回环） */
  serverUrl: string;
  joinToken: string;
  /** 该名字的 Agent 是否已在任一房间在线，用来区分"启动中"与"运行中" */
  isAgentOnline: (name: string) => boolean;
  /** 该名字是否已被其他在线成员占用（不含本机 Agent 自己） */
  isNameInUse: (name: string) => boolean;
  /** 经 WebSocket 请这个名字的 Agent 自行退出；发出了就返回 true（Windows 上用来代替结束信号） */
  requestShutdown?: (name: string) => boolean;
  /** 在线的这个名字的 Agent 上报的代码版本；不在线或旧版 Bridge 没报时为 undefined */
  runningVersion?: (name: string) => AgentCodeVersion | undefined;
  /** 手上有没结束调用的 Agent 名字（小写，跨所有房间）：忙的不重启 */
  busyAgentNames?: () => ReadonlySet<string>;
  /** 本机 Agent 那份代码现在的版本（测试注入）；默认按 cli 入口所在的包现算 */
  currentVersion?: () => Promise<AgentCodeVersion | undefined>;
  /** 隔多久检查一次要不要自动更新（默认 60 秒）；调用结束时另会尽快检查一次 */
  updateCheckMs?: number;
  /** 当前代码版本变了（合入、升级）：成员列表里谁是旧版本跟着变 */
  onCurrentVersionChange?: () => void;
  /**
   * Server 主动结束了这个 Agent 的进程（停止、重启、删除、Server 自己停下；交接给下一个 Server 不算）：
   * 它手上没做完的调用不会再有结果，交给调用方立即标为已中断，不等卡住超时判「结果未知」
   */
  onAgentEnded?: (name: string, reason: LocalAgentEndReason) => void;
  log?: (message: string) => void;
  spawn?: SpawnAgent;
  adopt?: AdoptAgent;
  /**
   * 找没被跟踪的同一个本机 Agent 进程（命令行里带着它的设置文件，测试注入）：Server 交接没接上时
   * 旧进程会留下来占着名字；默认按 ps / Win32_Process 的命令行找
   */
  findStrays?: (settingsFile: string) => number[];
  /** 残留进程是否还活着（测试注入）；默认 process.kill(pid, 0) */
  isStrayAlive?: (pid: number) => boolean;
  /** 结束找到的残留进程（测试注入）；默认 SIGTERM，Windows 上结束进程树 */
  killStray?: (pid: number, signal: NodeJS.Signals) => void;
  /** Agent 输出日志的目录；设置后 Agent 以独立进程组运行，Server 交接重启时不随之退出 */
  logDir?: string;
  /** Agent 设置文件目录（网页上勾选的 MCP 等）；Agent 每一轮读取，改动不必重启 */
  settingsDir?: string;
  /** 网络代理：启动 Agent 时要补上、去掉的环境变量（设置 → 这台电脑 → 网络代理） */
  proxyEnv?: () => ProxyEnvPatch | undefined;
  /** 列出 Agent 会加载的本机 MCP（测试注入）；默认运行 `hive mcp list` */
  listMcp?: McpLister;
  /** 列出运行时能用的模型（测试注入）；默认运行 `hive models --provider X --json` */
  listModels?: ModelLister;
  probe?: ProviderProbe;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => { cancel(): void };
  /** 工作目录用不了时退回的主目录（测试注入） */
  home?: () => string;
};

const LOG_LINES = 500;
const BACKOFF_MAX_MS = 60_000;
/** 10 分钟内意外退出 5 次即熔断，避免未登录等配置错误导致无限重启 */
const CRASH_WINDOW_MS = 10 * 60_000;
const CRASH_LIMIT = 5;
/** 连续运行超过 1 分钟视为稳定，之后再退出时退避从头计算 */
const STABLE_RUN_MS = 60_000;
const STOP_GRACE_MS = 5_000;
/** 启动前等旧进程退出时，多久看一次 */
const STRAY_POLL_MS = 200;
/** 服务启动时要重新拉起多个 Agent：逐个错开，免得一下子起一堆 CLI 抢 CPU、同时去刷登录态 */
const RESTORE_STAGGER_MS = 2_000;
const PROBE_CACHE_MS = 60_000;
/** 单个 Agent 日志超过这个大小时，下次启动先轮转为 .1 */
const LOG_FILE_MAX_BYTES = 5 * 1024 * 1024;
const TAIL_INTERVAL_MS = 1_000;
/** 当前代码版本的缓存：合入后最多这么久就能看出 Agent 落后了 */
const VERSION_CACHE_MS = 10_000;
const UPDATE_CHECK_MS = 60_000;
/** 调用结束后稍等再查忙闲：同一轮里紧接着可能还有排队的调用被派出 */
const IDLE_CHECK_DELAY_MS = 3_000;
/** 同一个 Agent 两次自动重启至少隔这么久，免得版本判断出了岔子时反复重启 */
export const AUTO_RESTART_COOLDOWN_MS = 10 * 60_000;
/** 自动更新开关（设置项，默认开） */
export const AUTO_UPDATE_SETTING = "local-agents:auto-update";

/** `hive mcp list` 子进程失败时给人看的原因：超时单独说；否则取它 stderr 最后一行（不带命令行） */
export function mcpListError(error: unknown): HiveError {
  const failure = error as { killed?: boolean; signal?: string | null; stderr?: unknown };
  if (failure?.killed && failure.signal) {
    return new HiveError(
      "LOCAL_AGENT_MCP_LIST_FAILED",
      serverText("error.localAgent.mcpListTimedOut", { seconds: MCP_LIST_TIMEOUT_MS / 1000 }),
    );
  }
  const stderr = typeof failure?.stderr === "string" ? failure.stderr : "";
  const reason = stderr
    .replace(ANSI_PATTERN, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1)
    ?.slice(0, 300);
  return new HiveError(
    "LOCAL_AGENT_MCP_LIST_FAILED",
    reason
      ? serverText("error.localAgent.mcpListFailedReason", { reason })
      : serverText("error.localAgent.mcpListFailed"),
  );
}

export type LocalAgentEndReason = "stopped" | "restarted" | "removed" | "serverStopped";

export type McpLister = (args: string[]) => Promise<string>;
/** cwd：Agent 的工作目录（Claude 的项目级配置会盖过全局配置，决定它实际用的接口和密钥） */
export type ModelLister = (
  provider: LocalAgentProvider,
  context: { cwd?: string },
) => Promise<LocalAgentModelsResponse>;
/** 模型列表缓存：起 Codex app-server、跑 opencode models 都要几秒 */
const MODELS_CACHE_MS = 10 * 60_000;

/** 支持按勾选加载 MCP 的 provider */
const MCP_SELECTABLE: ReadonlySet<LocalAgentProvider> = new Set(["claude", "codex"]);
/** 实测：Claude Code 不带任何 MCP 时开局约 4 万 token（系统提示与内置工具） */
const CLAUDE_BASELINE_TOKENS = 40_000;
const MCP_MEASURE_CACHE_MS = 10 * 60_000;
/** `hive mcp list`（测量时逐个连上 MCP）最多等这么久 */
const MCP_LIST_TIMEOUT_MS = 90_000;

export const PROVIDER_COMMANDS: Record<LocalAgentProvider, string> = {
  codex: "codex",
  claude: "claude",
  copilot: "copilot",
  opencode: "opencode",
  omp: "omp",
  openclaw: "openclaw",
  gemini: "gemini",
  agy: "agy",
};

type Runtime = {
  config: LocalAgentConfig;
  child?: ChildHandle | undefined;
  pid: number | null;
  startedAt: number | null;
  lastExitCode: number | null;
  lastError: string | null;
  restarts: number;
  /** 近期意外退出的时间戳 */
  failures: number[];
  consecutiveFailures: number;
  phase: "running" | "restarting" | "stopped" | "crashed";
  /** 启动前在等上一个 Server 留下的旧进程退出（见 launchAfterStrays） */
  waitingStrays?: boolean;
  /** 主动停止中：退出不算失败 */
  stopping: boolean;
  timer?: { cancel(): void } | undefined;
  logs: string[];
  pendingLine: string;
  exited?: Promise<void> | undefined;
  /** 当前进程启动时带了设置文件：之后的勾选改动下一轮就生效；否则要重启一次 */
  settingsApplied: boolean;
  /** 正在重启（等旧进程退出）：这期间不接受设置改动，免得新进程用上没批准过的配置 */
  transitioning?: boolean;
  /** 人点了「重启」但它正忙：等手上的调用都结束再重启；guard 是批准单绑定的配置核对 */
  pendingRestart?: { guard?: ((agent: LocalAgent) => boolean) | undefined } | undefined;
  /** 上次自动更新重启时的目标版本：同一个目标只自动重启一次，重启后仍判为旧就不再重试 */
  autoRestartedFor?: string | undefined;
  lastAutoRestartAt?: number | undefined;
  /** 这次启动没能用配置里的工作目录、退回了主目录（见 checkCwd） */
  cwdFallback?: CwdFallback | undefined;
};

export type CwdFallback = NonNullable<LocalAgent["cwdFallback"]>;

/**
 * 配置里的工作目录还能不能用。桌面端早先把安装目录当成默认工作目录，Squirrel 升级后旧的 app-<版本>
 * 会被删掉，Agent 就起不来了，所以：
 * - 指向桌面端安装目录（不管还在不在）：换成主目录，并改掉配置——那里本来就不该是工作目录；
 * - 目录不在了（外接盘没插、网络盘没挂上也是这样）：这次先在主目录启动，不改配置，目录回来后重启即恢复。
 * 只读档没有工作目录，不检查。
 */
export function checkCwd(
  cwd: string | null,
  home: string = homeDirectory(),
): CwdFallback | undefined {
  if (!cwd) return undefined;
  if (isDesktopInstallDirectory(cwd)) return { reason: "installDir", from: cwd, to: home };
  try {
    if (statSync(cwd).isDirectory()) return undefined;
  } catch {
    /* 不存在或没权限：都当作用不了 */
  }
  return { reason: "missing", from: cwd, to: home };
}

/** 用来判断「同一个目标版本」的键 */
function versionKey(version: AgentCodeVersion): string {
  return version.fingerprint ?? version.package;
}

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** 持续读取日志文件新增的内容（从 offset 开始），返回停止函数 */
function tailFile(file: string, offset: number, listener: (chunk: string) => void): () => void {
  let position = offset;
  const buffer = Buffer.alloc(64 * 1024);
  const read = () => {
    let fd: number | undefined;
    try {
      if (statSync(file).size < position) position = 0;
      fd = openSync(file, "r");
      for (;;) {
        const bytes = readSync(fd, buffer, 0, buffer.length, position);
        if (bytes <= 0) break;
        position += bytes;
        listener(buffer.subarray(0, bytes).toString("utf8"));
      }
    } catch {
      /* 文件还没建好或已被轮转，下次再读 */
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };
  const timer = setInterval(read, TAIL_INTERVAL_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
    read();
  };
}

function fileSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

export const defaultSpawnAgent: SpawnAgent = (command, args, options) => {
  const logFile = options.logFile;
  const inherited = options.unsetEnv?.length
    ? applyProxyEnv(process.env, { set: {}, unset: [...options.unsetEnv] })
    : process.env;
  const env = { ...inherited, ...options.env };
  if (!logFile) {
    // 输出走管道：随 Server 一起结束；windowsHide 且不继承句柄，Windows 上得到一个看不见的控制台
    const child = spawn(command, args, {
      cwd: options.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    return pipedChild(child);
  }
  if (fileSize(logFile) > LOG_FILE_MAX_BYTES) {
    try {
      renameSync(logFile, `${logFile}.1`);
    } catch {
      // Windows 上旧进程还开着这个文件时不能改名：本次接着追加，下次再轮转
    }
  }
  const fd = openSync(logFile, "a");
  const offset = fileSize(logFile);
  let launched: ReturnType<typeof spawnBackground>;
  try {
    // 写日志文件的 Agent 是后台常驻进程：Server 退出、交接重启时它照样活着，Windows 上也不弹窗
    launched = spawnBackground(command, args, { cwd: options.cwd, env, logFd: fd });
  } finally {
    closeSync(fd);
  }
  return backgroundChild(launched, logFile, offset);
};

function pipedChild(child: ChildProcess): ChildHandle {
  let exited = false;
  const exitListeners: Array<(code: number | null, error?: Error) => void> = [];
  const emitExit = (code: number | null, error?: Error) => {
    if (exited) return;
    exited = true;
    for (const listener of exitListeners) listener(code, error);
  };
  child.on("error", (error) => emitExit(null, error));
  child.on("close", (code) => emitExit(code));
  return {
    pid: child.pid,
    onOutput(listener) {
      child.stdout?.setEncoding("utf8").on("data", listener);
      child.stderr?.setEncoding("utf8").on("data", listener);
    },
    onExit(listener) {
      exitListeners.push(listener);
    },
    kill(signal) {
      if (exited) return;
      if (child.pid && process.platform === "win32") killTree(child.pid);
      else child.kill(signal);
    },
    release() {
      exited = true;
      child.removeAllListeners();
    },
  };
}

/**
 * 后台常驻的 Agent：输出从日志文件末尾读。macOS / Linux 上能直接拿到子进程的退出码；
 * Windows 上进程由 PowerShell 代为拉起，pid 稍后才知道，退出靠轮询发现（同接管的进程）。
 */
function backgroundChild(
  launched: ReturnType<typeof spawnBackground>,
  logFile: string,
  offset: number,
): ChildHandle {
  const exitListeners: Array<(code: number | null, error?: Error) => void> = [];
  const outputListeners: Array<(chunk: string) => void> = [];
  let exited = false;
  let released = false;
  let pid: number | undefined;
  let pendingSignal: NodeJS.Signals | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  const stopTail = tailFile(logFile, offset, (chunk) => {
    for (const listener of outputListeners) listener(chunk);
  });
  const emitExit = (code: number | null, error?: Error) => {
    if (exited || released) return;
    exited = true;
    if (poll) clearInterval(poll);
    stopTail();
    for (const listener of exitListeners) listener(code, error);
  };
  const signal = (value: NodeJS.Signals) => {
    if (!pid) return;
    if (process.platform === "win32") {
      killTree(pid);
      return;
    }
    try {
      process.kill(pid, value);
    } catch {
      /* 已经退出 */
    }
  };
  const child = launched.child;
  if (child) {
    pid = child.pid;
    child.on("error", (error) => emitExit(null, error));
    child.on("close", (code) => emitExit(code));
  }
  const pidReady = launched.pid.then(
    (value) => {
      pid = value;
      if (!child) {
        poll = setInterval(() => {
          if (!isAlive(value)) emitExit(null);
        }, 1_000);
        poll.unref();
      }
      if (pendingSignal && !exited) signal(pendingSignal);
      return value as number | undefined;
    },
    (error: Error) => {
      emitExit(null, error);
      return undefined;
    },
  );
  return {
    get pid() {
      return pid;
    },
    pidReady,
    onOutput(listener) {
      outputListeners.push(listener);
    },
    onExit(listener) {
      exitListeners.push(listener);
    },
    kill(value) {
      if (exited) return;
      if (!pid) {
        pendingSignal = value;
        return;
      }
      if (child && process.platform !== "win32") child.kill(value);
      else signal(value);
    },
    release() {
      released = true;
      if (poll) clearInterval(poll);
      stopTail();
      child?.removeAllListeners();
    },
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * 拉起 superhive CLI 时字符串选项一律写成 `--key=value`：桌面端在 Windows 上用 Electron 跑 CLI，
 * Electron 发现命令行里「像网址的参数后面还跟着 `--` 开关」会直接退出（防协议处理器注入），
 * `--server http://127.0.0.1:8787 --name x` 正好命中；写成一个参数就不会。node 的 parseArgs 两种都认。
 */
export function cliOption(key: string, value: string): string {
  return `--${key}=${value}`;
}

/** 从 `hive join` 命令行里取 Agent 名字：新的 `--name=X` 和老进程的 `--name X` 都认 */
export function joinArgumentName(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--name") return args[i + 1];
    if (arg.startsWith("--name=")) return arg.slice("--name=".length);
  }
  return undefined;
}

/**
 * 按 pid 接管：进程还在，并且命令行确实是这个名字的 `hive join`（防止 pid 被别的进程复用），
 * 之后靠轮询发现它退出、靠信号结束它，输出从日志文件末尾接着读。
 */
export const defaultAdoptAgent: AdoptAgent = (pid, options) => {
  if (!isAlive(pid)) return undefined;
  const commandLine = processCommandLine(pid);
  if (!commandLine) return undefined;
  const args = commandLine.trim().split(/\s+/);
  if (!args.includes("join") || joinArgumentName(args) !== options.name) return undefined;
  const exitListeners: Array<(code: number | null, error?: Error) => void> = [];
  const outputListeners: Array<(chunk: string) => void> = [];
  let exited = false;
  const stopTail = options.logFile
    ? tailFile(options.logFile, fileSize(options.logFile), (chunk) => {
        for (const listener of outputListeners) listener(chunk);
      })
    : undefined;
  const poll = setInterval(() => {
    if (isAlive(pid)) return;
    clearInterval(poll);
    if (exited) return;
    exited = true;
    stopTail?.();
    for (const listener of exitListeners) listener(null);
  }, 1_000);
  poll.unref();
  return {
    pid,
    onOutput(listener) {
      outputListeners.push(listener);
    },
    onExit(listener) {
      exitListeners.push(listener);
    },
    kill(signal) {
      if (exited) return;
      if (process.platform === "win32") {
        killTree(pid);
        return;
      }
      try {
        process.kill(pid, signal);
      } catch {
        /* 已经退出 */
      }
    },
    release() {
      exited = true;
      clearInterval(poll);
      stopTail?.();
    },
  };
};

export const defaultProbe: ProviderProbe = (command) =>
  new Promise((resolve) => {
    let probe;
    try {
      probe = commandFor(command, ["--version"]);
    } catch {
      resolve({ installed: true, version: null });
      return;
    }
    execFile(
      probe.command,
      probe.args,
      { timeout: 5_000, encoding: "utf8", windowsHide: true },
      (error, stdout) => {
        if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
          resolve({ installed: false, version: null });
          return;
        }
        const version = stdout.trim().split("\n")[0]?.trim() || null;
        resolve({ installed: true, version: error ? null : version });
      },
    );
  });

/** 「人发的消息在它忙时自动引导」开关：按 Agent 名字存（各房间通用） */
export function autoSteerKey(name: string): string {
  return `auto-steer:${name.toLocaleLowerCase()}`;
}

export class LocalAgentSupervisor {
  private readonly runtimes = new Map<string, Runtime>();
  private readonly spawnAgent: SpawnAgent;
  private readonly adoptAgent: AdoptAgent;
  private readonly probe: ProviderProbe;
  private readonly now: () => number;
  private readonly setTimer: NonNullable<LocalAgentSupervisorOptions["setTimer"]>;
  private readonly log: (message: string) => void;
  private probeCache?: { at: number; result: Promise<LocalProviderInfo[]> };
  private readonly measureCache = new Map<string, { at: number; result: LocalAgentMcpResponse }>();
  private readonly listMcp: McpLister;
  private readonly listModels: ModelLister;
  /** 按 provider 缓存；Claude 再按工作目录分（项目配置可能换了接口和密钥） */
  private readonly modelsCache = new Map<
    string,
    { at: number; result: Promise<LocalAgentModelsResponse> }
  >();
  private shuttingDown = false;
  private current?: { at: number; version: AgentCodeVersion | undefined };
  private refreshing?: Promise<AgentCodeVersion | undefined> | undefined;
  private readonly currentVersion: () => Promise<AgentCodeVersion | undefined>;
  private updateTimer?: { cancel(): void } | undefined;
  private idleTimer?: { cancel(): void } | undefined;
  private checking = false;

  constructor(private readonly options: LocalAgentSupervisorOptions) {
    this.spawnAgent = options.spawn ?? defaultSpawnAgent;
    this.adoptAgent = options.adopt ?? defaultAdoptAgent;
    this.probe = options.probe ?? defaultProbe;
    this.now = options.now ?? Date.now;
    this.setTimer =
      options.setTimer ??
      ((callback, ms) => {
        const timer = setTimeout(callback, ms);
        timer.unref();
        return { cancel: () => clearTimeout(timer) };
      });
    this.log = options.log ?? (() => undefined);
    const packageRoot = packageRootOfCli(options.cli.args);
    this.currentVersion =
      options.currentVersion ??
      (() => (packageRoot ? codeVersionAt(packageRoot) : Promise.resolve(undefined)));
    this.listMcp =
      options.listMcp ??
      ((args) =>
        new Promise((resolve, reject) =>
          execFile(
            options.cli.command,
            [...options.cli.args, ...args],
            { timeout: MCP_LIST_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
            (error, stdout, stderr) =>
              error ? reject(Object.assign(error, { stderr })) : resolve(stdout),
          ),
        ));
    this.listModels =
      options.listModels ??
      (async (provider, context) => {
        const args = [
          ...options.cli.args,
          "models",
          cliOption("provider", provider),
          ...(context.cwd ? [cliOption("cwd", context.cwd)] : []),
          "--json",
        ];
        // 和 Agent 启动时同样的网络代理：Claude 要连它的接口地址
        let proxy: ProxyEnvPatch | undefined;
        try {
          proxy = options.proxyEnv?.();
        } catch {
          proxy = undefined;
        }
        const env = applyProxyEnv({ ...process.env }, proxy) as NodeJS.ProcessEnv;
        const stdout = await new Promise<string>((resolve, reject) =>
          execFile(
            options.cli.command,
            args,
            { timeout: MCP_LIST_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env },
            (error, out, stderr) =>
              error ? reject(Object.assign(error, { stderr })) : resolve(out),
          ),
        );
        const line = stdout.trim().split("\n").at(-1) ?? "";
        const parsed = JSON.parse(line) as LocalAgentModelsResponse;
        return {
          source: parsed.source === "runtime" ? "runtime" : "preset",
          models: Array.isArray(parsed.models) ? parsed.models : [],
          // 旧版 hive 不报思考强度：按 provider 用协议里的档位
          efforts: Array.isArray(parsed.efforts)
            ? parsed.efforts
            : [...runtimeReasoningEfforts(provider)],
          ...(parsed.error ? { error: parsed.error } : {}),
          ...(parsed.presetReason === "oauth" || parsed.presetReason === "cloud"
            ? { presetReason: parsed.presetReason }
            : {}),
        };
      });
  }

  /**
   * 服务启动时恢复上次保存的本机 Agent；手动停止过的保持停止。
   * 上一个 Server 交接时留下的进程还在跑的，直接接管（它手上的任务不中断），不再另起一个；
   * 需要重新拉起的按顺序错开 RESTORE_STAGGER_MS 逐个启动，排队期间显示「启动中」。
   */
  start(): void {
    let queued = 0;
    for (const config of this.options.database.listLocalAgents()) {
      const runtime = this.track(config);
      const previous = config.pid
        ? this.adoptAgent(config.pid, {
            name: config.name,
            ...(this.logFile(config) ? { logFile: this.logFile(config)! } : {}),
          })
        : undefined;
      if (previous && config.autostart) {
        this.appendLog(runtime, `[hive] 接管仍在运行的 ${config.name}（pid ${previous.pid}）\n`);
        this.attach(
          runtime,
          previous,
          config.pidStartedAt ? Date.parse(config.pidStartedAt) : this.now(),
        );
        runtime.settingsApplied = processHasArgument(previous.pid, "--agent-settings");
        continue;
      }
      // 不该再运行的（已手动停止）结束掉；已经不在的清掉记录
      previous?.kill("SIGTERM");
      if (config.pid) this.options.database.setLocalAgentProcess(config.id, null, null);
      if (!config.autostart) continue;
      const delay = queued * RESTORE_STAGGER_MS;
      queued += 1;
      if (delay === 0) {
        this.launch(runtime);
        continue;
      }
      this.appendLog(runtime, `[hive] 恢复上次在运行的 Agent，${delay / 1000} 秒后启动\n`);
      // 停止、启动、重启、删除都会先取消这个定时器
      runtime.timer = this.setTimer(() => {
        runtime.timer = undefined;
        if (runtime.phase === "running") this.launch(runtime);
      }, delay);
    }
    // 能拿到 Agent 上报的版本才做自动更新
    if (this.options.runningVersion) {
      void this.refreshVersion();
      this.scheduleUpdateCheck();
    }
  }

  /**
   * 交接给下一个 Server（开发时代码更新、Server 换代）：不结束 Agent 进程，只停止跟踪。
   * 进程号已经落库，新 Server 启动时接管；Agent 断线期间会自行重连，正在跑的任务继续做完。
   */
  detach(): void {
    this.shuttingDown = true;
    this.cancelUpdateTimers();
    for (const runtime of this.runtimes.values()) {
      runtime.timer?.cancel();
      runtime.timer = undefined;
      runtime.child?.release?.();
    }
  }

  /** 所有 provider 都有设置文件：模型每一轮从这里读；MCP 勾选只有 claude、codex 用得上 */
  private settingsFile(config: LocalAgentConfig): string | undefined {
    return this.options.settingsDir
      ? path.join(this.options.settingsDir, `${config.id}.json`)
      : undefined;
  }

  private writeSettings(config: LocalAgentConfig): string | undefined {
    const file = this.settingsFile(config);
    if (!file) return undefined;
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify({
        mcpDisabled: config.mcpDisabled ?? [],
        ...(config.model ? { model: config.model } : {}),
        ...(config.effort ? { effort: config.effort } : {}),
        // 只写 Claude 的：没设过就不写，Bridge 按默认 20 万压缩、缓存时长交给 Claude Code
        ...(config.compactWindow ? { compactWindow: config.compactWindow } : {}),
        ...(config.cacheTtl ? { cacheTtl: config.cacheTtl } : {}),
      }),
      { mode: 0o600 },
    );
    // 先写临时文件再改名：Agent 随时可能在读，不能读到写了一半的内容
    renameSync(tmp, file);
    return file;
  }

  /** 保存网页上的勾选；已带设置文件启动的 Agent 下一轮就按新的勾选加载 */
  updateSettings(
    id: string,
    settings: {
      mcpDisabled?: string[] | undefined;
      autoSteer?: boolean | undefined;
      model?: string | null | undefined;
      effort?: string | null | undefined;
      compactWindow?: ClaudeCompactWindow | null | undefined;
      cacheTtl?: ClaudeCacheTtl | null | undefined;
    },
  ): LocalAgent {
    const runtime = this.require(id);
    // 自动压缩阈值、缓存时长：只有 Claude Code 有，写进设置文件，下一轮生效
    if (settings.compactWindow !== undefined || settings.cacheTtl !== undefined) {
      if (!supportsClaudeContextSettings(runtime.config.provider)) {
        throw new HiveError(
          "LOCAL_AGENT_CONTEXT_UNSUPPORTED",
          serverText("error.localAgent.contextUnsupported"),
        );
      }
      const compactWindow =
        settings.compactWindow !== undefined
          ? settings.compactWindow
          : (runtime.config.compactWindow ?? null);
      const cacheTtl =
        settings.cacheTtl !== undefined ? settings.cacheTtl : (runtime.config.cacheTtl ?? null);
      this.options.database.setLocalAgentContext(id, compactWindow, cacheTtl);
      runtime.config.compactWindow = compactWindow;
      runtime.config.cacheTtl = cacheTtl;
      this.writeSettings(runtime.config);
    }
    // 思考强度同样写进设置文件，下一轮生效；运行时不支持的不让设（网页上也不显示）
    if (settings.effort !== undefined) {
      const effort = settings.effort?.trim() || null;
      if (effort && !supportsReasoningEffort(runtime.config.provider)) {
        throw new HiveError(
          "LOCAL_AGENT_EFFORT_UNSUPPORTED",
          serverText("error.localAgent.effortUnsupported"),
        );
      }
      runtime.config.effort = this.options.database.setLocalAgentEffort(id, effort);
      this.writeSettings(runtime.config);
    }
    // 模型写进设置文件，Agent 下一轮就按新模型跑，不用重启
    if (settings.model !== undefined) {
      runtime.config.model = this.options.database.setLocalAgentModel(
        id,
        settings.model?.trim() || null,
      );
      this.writeSettings(runtime.config);
    }
    // 自动引导由服务端在派发时判断，不影响进程，随时可改
    if (settings.autoSteer !== undefined) {
      this.options.database.setSetting(
        autoSteerKey(runtime.config.name),
        settings.autoSteer ? "1" : "0",
      );
    }
    if (settings.mcpDisabled === undefined) return this.view(runtime);
    if (runtime.transitioning) {
      throw new HiveError("LOCAL_AGENT_BUSY", serverText("error.localAgent.restartingSettings"));
    }
    if (!MCP_SELECTABLE.has(runtime.config.provider)) {
      throw new HiveError(
        "LOCAL_AGENT_MCP_UNSUPPORTED",
        serverText("error.localAgent.mcpUnsupported"),
      );
    }
    runtime.config.mcpDisabled = this.options.database.setLocalAgentMcpDisabled(
      id,
      settings.mcpDisabled,
    );
    this.writeSettings(runtime.config);
    return this.view(runtime);
  }

  /**
   * 这个 Agent 的运行时能用的模型（按 provider 缓存 10 分钟，refresh 时重新拉）。
   * 拉不到不报错：返回空列表和原因，网页上照样可以手填。
   */
  async models(id: string, refresh = false): Promise<LocalAgentModelsResponse> {
    const { config } = this.require(id);
    const { provider } = config;
    // Claude、Codex 按工作目录读项目级配置；和启动时一样，目录用不了就按主目录
    const cwd =
      provider === "claude" || provider === "codex"
        ? (checkCwd(config.cwd, this.options.home?.())?.to ?? config.cwd ?? undefined)
        : undefined;
    const key = cwd ? `${provider}\u0000${cwd}` : provider;
    const cached = this.modelsCache.get(key);
    if (cached && !refresh && this.now() - cached.at < MODELS_CACHE_MS) return cached.result;
    const result = this.listModels(provider, cwd ? { cwd } : {}).catch(
      (error: unknown): LocalAgentModelsResponse => ({
        source: "preset",
        models: [],
        efforts: [...runtimeReasoningEfforts(provider)],
        error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
      }),
    );
    this.modelsCache.set(key, { at: this.now(), result });
    // 拉取失败的不缓存：下次打开再试
    void result.then((value) => {
      if (value.error && this.modelsCache.get(key)?.result === result) {
        this.modelsCache.delete(key);
      }
    });
    return result;
  }

  /** 这个 Agent 会加载的本机 MCP 及启用状态；measure 时逐个连上估算开局 token（结果缓存 10 分钟） */
  async mcpServers(id: string, measure: boolean): Promise<LocalAgentMcpResponse> {
    const { config } = this.require(id);
    // 和启动时一样：工作目录用不了就按主目录列，免得设置里的 MCP 列表直接报错
    const cwd = checkCwd(config.cwd, this.options.home?.())?.to ?? config.cwd;
    return this.listMcpFor(id, config.provider, cwd, this.writeSettings(config), measure);
  }

  /** 接入新 Agent 前预览：这个 provider 在该目录下会加载哪些本机 MCP（默认全部启用） */
  mcpCandidates(
    provider: LocalAgentProvider,
    cwd: string | undefined,
    measure: boolean,
  ): Promise<LocalAgentMcpResponse> {
    const resolved = cwd ? resolveWorkspace(cwd) : null;
    return this.listMcpFor(
      `new:${provider}:${resolved ?? ""}`,
      provider,
      resolved,
      undefined,
      measure,
    );
  }

  private async listMcpFor(
    cacheKey: string,
    provider: LocalAgentProvider,
    cwd: string | null,
    settingsFile: string | undefined,
    measure: boolean,
  ): Promise<LocalAgentMcpResponse> {
    if (!MCP_SELECTABLE.has(provider)) {
      return { supported: false, servers: [], baselineTokens: null };
    }
    const cachedEntry = this.measureCache.get(cacheKey);
    const cached =
      cachedEntry && this.now() - cachedEntry.at < MCP_MEASURE_CACHE_MS
        ? cachedEntry.result
        : undefined;
    let stdout: string;
    try {
      stdout = await this.listMcp([
        "mcp",
        "list",
        cliOption("provider", provider),
        cliOption("cwd", cwd ?? homedir()),
        ...(settingsFile ? [cliOption("agent-settings", settingsFile)] : []),
        "--json",
        ...(measure && provider === "claude" ? ["--measure"] : []),
      ]);
    } catch (error) {
      // 超时、某个 MCP 起不来、模型服务限流时测量失败：按设计会发生，告诉人原因，不当成 Server 故障
      throw mcpListError(error);
    }
    const line = stdout.trim().split("\n").at(-1) ?? "";
    let servers: LocalAgentMcpResponse["servers"];
    try {
      servers = (JSON.parse(line) as { servers: LocalAgentMcpResponse["servers"] }).servers;
    } catch {
      throw new HiveError(
        "LOCAL_AGENT_MCP_LIST_FAILED",
        serverText("error.localAgent.mcpListFailed"),
      );
    }
    // 没要求重新估算时沿用 10 分钟内的估算结果，启用状态以刚读到的为准
    if (!measure && cached) {
      const measured = new Map(cached.servers.map((server) => [server.name, server.measurement]));
      servers = servers.map((server) => {
        const measurement = measured.get(server.name);
        return measurement ? { ...server, measurement } : server;
      });
    }
    const result: LocalAgentMcpResponse = {
      supported: true,
      servers,
      baselineTokens: provider === "claude" ? CLAUDE_BASELINE_TOKENS : null,
    };
    if (measure) this.measureCache.set(cacheKey, { at: this.now(), result });
    return result;
  }

  private logFile(config: LocalAgentConfig): string | undefined {
    return this.options.logDir ? path.join(this.options.logDir, `${config.id}.log`) : undefined;
  }

  list(): LocalAgent[] {
    this.currentCodeVersion();
    const busy = this.busyNames();
    return [...this.runtimes.values()].map((runtime) => this.view(runtime, busy));
  }

  get(id: string): LocalAgent {
    return this.view(this.require(id));
  }

  logs(id: string): string[] {
    const runtime = this.require(id);
    return runtime.pendingLine ? [...runtime.logs, runtime.pendingLine] : [...runtime.logs];
  }

  providers(): Promise<LocalProviderInfo[]> {
    const cached = this.probeCache;
    if (cached && this.now() - cached.at < PROBE_CACHE_MS) return cached.result;
    const result = Promise.all(
      (Object.keys(PROVIDER_COMMANDS) as LocalAgentProvider[]).map(async (provider) => {
        const command = PROVIDER_COMMANDS[provider];
        const { installed, version } = await slowOps.track(
          `localAgents.probe ${provider}`,
          {},
          () => this.probe(command),
        );
        return { provider, command, installed, version };
      }),
    );
    this.probeCache = { at: this.now(), result };
    return result;
  }

  create(request: CreateLocalAgentRequest): LocalAgent {
    const name = request.name.trim();
    if (this.options.isNameInUse(name)) {
      throw new HiveError(
        "LOCAL_AGENT_NAME_TAKEN",
        serverText("error.localAgent.nameInUse", { name }),
      );
    }
    // 与 `hive join` 一致：可写的档位必须明确工作目录，避免授权到错误目录
    const cwd = request.access === "read-only" ? null : resolveWorkspace(request.cwd);
    const config = this.options.database.createLocalAgent({
      provider: request.provider,
      name,
      access: request.access,
      cwd,
      model: request.model ?? null,
      ...(request.mcpDisabled && MCP_SELECTABLE.has(request.provider)
        ? { mcpDisabled: [...new Set(request.mcpDisabled)].sort() }
        : {}),
    });
    const runtime = this.track(config);
    this.launch(runtime);
    return this.view(runtime);
  }

  startAgent(id: string): LocalAgent {
    const runtime = this.require(id);
    if (!runtime.child) {
      runtime.timer?.cancel();
      runtime.failures = [];
      runtime.consecutiveFailures = 0;
      this.options.database.setLocalAgentAutostart(id, true);
      this.launch(runtime);
    }
    return this.view(runtime);
  }

  async stop(id: string): Promise<LocalAgent> {
    const runtime = this.require(id);
    runtime.pendingRestart = undefined;
    this.options.database.setLocalAgentAutostart(id, false);
    await this.terminate(runtime, "stopped");
    await this.stopStrays(runtime);
    runtime.phase = "stopped";
    return this.view(runtime);
  }

  /**
   * 重启。guard 在真正启动前对最终配置再核对一次（例如批准单绑定的配置），不通过就不启动；
   * 等旧进程退出期间拒绝设置改动，保证核对过的就是要启动的。
   */
  async restart(id: string, guard?: (agent: LocalAgent) => boolean): Promise<LocalAgent> {
    const runtime = this.require(id);
    if (runtime.transitioning) {
      throw new HiveError("LOCAL_AGENT_BUSY", serverText("error.localAgent.restarting"));
    }
    runtime.pendingRestart = undefined;
    runtime.transitioning = true;
    try {
      await this.terminate(runtime, "restarted");
      if (guard && !guard(this.view(runtime))) {
        runtime.phase = "stopped";
        throw new HiveError(
          "LOCAL_AGENT_CONFIG_CHANGED",
          serverText("error.localAgent.configChanged"),
        );
      }
      runtime.failures = [];
      runtime.consecutiveFailures = 0;
      this.options.database.setLocalAgentAutostart(id, true);
      this.launch(runtime);
    } finally {
      runtime.transitioning = false;
    }
    return this.view(runtime);
  }

  /**
   * 空闲后重启（「重启」按钮的默认做法）：手上没有排队或执行中的调用就马上重启；
   * 正忙就先记下，等调用都结束后由 checkUpdates 重启，正在做的任务不会被打断。
   */
  async restartWhenIdle(id: string, guard?: (agent: LocalAgent) => boolean): Promise<LocalAgent> {
    const runtime = this.require(id);
    if (runtime.child && this.isBusy(runtime)) {
      if (runtime.transitioning) {
        throw new HiveError("LOCAL_AGENT_BUSY", serverText("error.localAgent.restarting"));
      }
      runtime.pendingRestart = { guard };
      this.appendLog(runtime, "[hive] 手上还有任务，做完后重启\n");
      return this.view(runtime);
    }
    return this.restart(id, guard);
  }

  /**
   * 把 Agent 带进别人的房间（hive join --server 别人的 Hive --background）用的命令和环境：
   * 和本机 Agent 同一份 CLI、同样的网络代理设置；不带 HIVE_SUPERVISOR_PID（它不归本机 Server 管）。
   */
  remoteJoinLauncher(): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
    let proxy: ProxyEnvPatch | undefined;
    try {
      proxy = this.options.proxyEnv?.();
    } catch {
      proxy = undefined;
    }
    const env = applyProxyEnv({ ...process.env }, proxy) as NodeJS.ProcessEnv;
    delete env.HIVE_SUPERVISOR_PID;
    delete env.HIVE_AGENT_TOKEN;
    return { command: this.options.cli.command, args: [...this.options.cli.args], env };
  }

  /** 本机 Agent 的配置（带 Agent 进别人房间时沿用它的运行时、模型、工作目录和权限档） */
  configOf(
    id: string,
  ): Pick<LocalAgentConfig, "provider" | "model" | "cwd" | "access"> | undefined {
    const runtime = this.runtimes.get(id);
    if (!runtime) return undefined;
    const { provider, model, cwd, access } = runtime.config;
    return { provider, model, cwd, access };
  }

  /** 自动更新开关：本机 Agent 落后于当前代码时，在空闲后自动重启（默认开） */
  autoUpdateEnabled(): boolean {
    return this.options.database.getSetting(AUTO_UPDATE_SETTING) !== "0";
  }

  setAutoUpdate(enabled: boolean): void {
    this.options.database.setSetting(AUTO_UPDATE_SETTING, enabled ? "1" : "0");
    if (enabled) this.checkSoon();
  }

  /** 最近算出的当前代码版本（过期了在后台重算，这次先用旧值）；判断不出时为 undefined */
  currentCodeVersion(): AgentCodeVersion | undefined {
    if (!this.current || this.now() - this.current.at >= VERSION_CACHE_MS) {
      void this.refreshVersion();
    }
    return this.current?.version;
  }

  private refreshVersion(): Promise<AgentCodeVersion | undefined> {
    if (this.current && this.now() - this.current.at < VERSION_CACHE_MS) {
      return Promise.resolve(this.current.version);
    }
    this.refreshing ??= this.currentVersion()
      .catch(() => undefined)
      .then((version) => {
        const changed =
          this.current !== undefined &&
          (this.current.version ? versionKey(this.current.version) : undefined) !==
            (version ? versionKey(version) : undefined);
        this.current = { at: this.now(), version };
        this.refreshing = undefined;
        if (changed) this.options.onCurrentVersionChange?.();
        return version;
      });
    return this.refreshing;
  }

  /** 有 Agent 可能刚变空闲（调用结束、忙碌状态解除）：稍等片刻再检查要不要重启 */
  checkSoon(): void {
    if (this.shuttingDown || this.idleTimer) return;
    if (
      !this.options.runningVersion &&
      ![...this.runtimes.values()].some((r) => r.pendingRestart)
    ) {
      return;
    }
    this.idleTimer = this.setTimer(() => {
      this.idleTimer = undefined;
      void this.checkUpdates();
    }, IDLE_CHECK_DELAY_MS);
  }

  private scheduleUpdateCheck(): void {
    this.updateTimer?.cancel();
    this.updateTimer = this.setTimer(() => {
      this.updateTimer = undefined;
      void this.checkUpdates().finally(() => {
        if (!this.shuttingDown) this.scheduleUpdateCheck();
      });
    }, this.options.updateCheckMs ?? UPDATE_CHECK_MS);
  }

  private cancelUpdateTimers(): void {
    this.updateTimer?.cancel();
    this.updateTimer = undefined;
    this.idleTimer?.cancel();
    this.idleTimer = undefined;
  }

  /**
   * 该重启的空闲 Agent 现在重启：人点过「重启」而当时正忙的；以及（自动更新开着时）落后于当前代码的。
   * 忙的跳过，下次检查再看。自动更新每次只重启一个（重启完再接着查下一个，免得一下子起一堆进程），
   * 同一个目标版本只自动重启一次，同一个 Agent 两次自动重启至少隔 AUTO_RESTART_COOLDOWN_MS。
   */
  async checkUpdates(): Promise<void> {
    if (this.shuttingDown || this.checking) return;
    this.checking = true;
    try {
      const current = this.options.runningVersion ? await this.refreshVersion() : undefined;
      if (this.shuttingDown) return;
      const autoUpdate = current !== undefined && this.autoUpdateEnabled();
      // 忙闲在决定重启的同一刻读：从这里到发出结束信号之间不让出事件循环，不会有新调用插进来
      const busy = this.busyNames();
      let updating = false;
      for (const runtime of this.runtimes.values()) {
        if (!runtime.child || runtime.transitioning) continue;
        const manual = runtime.pendingRestart;
        const update = !manual && autoUpdate && !updating && this.updateDue(runtime, current!);
        if (!manual && !update) continue;
        if (busy.has(runtime.config.name.toLocaleLowerCase())) continue;
        if (update) {
          updating = true;
          runtime.autoRestartedFor = versionKey(current!);
          runtime.lastAutoRestartAt = this.now();
          this.appendLog(runtime, "[hive] 代码已更新，Agent 空闲，自动重启以用上新代码\n");
          this.log(`[local-agents] ${runtime.config.name} 运行的是旧代码，空闲后自动重启`);
        } else {
          this.appendLog(runtime, "[hive] 手上的任务做完了，按之前的要求重启\n");
        }
        void this.restart(runtime.config.id, manual?.guard)
          .catch((error: unknown) => {
            this.appendLog(
              runtime,
              `[hive] 重启没有完成：${error instanceof Error ? error.message : String(error)}\n`,
            );
          })
          .finally(() => {
            if (update) this.checkSoon();
          });
      }
    } finally {
      this.checking = false;
    }
  }

  private busyNames(): ReadonlySet<string> {
    return this.options.busyAgentNames?.() ?? new Set<string>();
  }

  private isBusy(runtime: Runtime, busy = this.busyNames()): boolean {
    return busy.has(runtime.config.name.toLocaleLowerCase());
  }

  /**
   * 在跑的进程落后于当前代码：上报的指纹或包版本旧，或者在线却没上报版本（还不会上报的旧版 Bridge）。
   * 还没上线、当前版本判断不出来时不算。
   */
  private outdated(runtime: Runtime): boolean {
    const current = this.current?.version;
    if (!runtime.child || !current || !this.options.runningVersion) return false;
    if (!this.options.isAgentOnline(runtime.config.name)) return false;
    const running = this.options.runningVersion(runtime.config.name);
    return running ? isAgentOutdated(running, current, true) : true;
  }

  /** 这个名字是本机 Agent 时，它是否在跑旧代码；不是本机 Agent 返回 undefined */
  outdatedByName(name: string): boolean | undefined {
    const key = name.toLocaleLowerCase();
    for (const runtime of this.runtimes.values()) {
      if (runtime.config.name.toLocaleLowerCase() === key) return this.outdated(runtime);
    }
    return undefined;
  }

  /** 落后、这个目标版本还没自动重启过、也过了冷却期 */
  private updateDue(runtime: Runtime, current: AgentCodeVersion): boolean {
    if (!this.outdated(runtime)) return false;
    if (runtime.autoRestartedFor === versionKey(current)) return false;
    return (
      runtime.lastAutoRestartAt === undefined ||
      this.now() - runtime.lastAutoRestartAt >= AUTO_RESTART_COOLDOWN_MS
    );
  }

  async remove(id: string): Promise<void> {
    const runtime = this.require(id);
    await this.terminate(runtime, "removed");
    await this.stopStrays(runtime);
    this.runtimes.delete(id);
    this.options.database.deleteLocalAgent(id);
  }

  /** 找到没被跟踪的同一 Agent 进程并发 SIGTERM，返回它们的 pid */
  private signalStrays(runtime: Runtime): number[] {
    const file = this.settingsFile(runtime.config);
    if (!file) return [];
    const own = runtime.child?.pid;
    let strays: number[];
    try {
      strays = (this.options.findStrays ?? defaultFindStrays)(file);
    } catch {
      return [];
    }
    strays = strays.filter((pid) => pid !== own && pid !== process.pid);
    const kill = this.options.killStray ?? defaultKillStray;
    for (const pid of strays) {
      this.appendLog(runtime, `[hive] 结束没被跟踪的旧进程 ${runtime.config.name}（pid ${pid}）\n`);
      this.log(`[local-agents] ${runtime.config.name}：结束残留进程 pid ${pid}`);
      kill(pid, "SIGTERM");
    }
    return strays;
  }

  /**
   * 结束没被跟踪、却还在用这个 Agent 名字的进程（上一个 Server 交接时没接上留下的）：停止、删除、启动前都清，
   * 否则删掉的 Agent 还挂在在线列表里，新启动的那个也会一直报「名字已在线」。
   * 命令行找得到的先 SIGTERM、宽限期后 SIGKILL；找不到（比如列不出进程）也经连接请同名 Agent 自己退出
   */
  private async stopStrays(runtime: Runtime): Promise<void> {
    const strays = this.signalStrays(runtime);
    const kill = this.options.killStray ?? defaultKillStray;
    if (!runtime.child) this.options.requestShutdown?.(runtime.config.name);
    if (!strays.length) return;
    await new Promise<void>((resolve) => {
      this.setTimer(() => {
        for (const pid of strays) if (this.strayAlive(pid)) kill(pid, "SIGKILL");
        resolve();
      }, STOP_GRACE_MS);
    });
  }

  private strayAlive(pid: number): boolean {
    return (this.options.isStrayAlive ?? isAlive)(pid);
  }

  /**
   * 启动前发现旧进程还活着：等它退出（最多 STOP_GRACE_MS，之后 SIGKILL）再起新进程。
   * 旧进程收到 SIGTERM 后还要停下回合、把没送达的停止回报写进状态文件；新进程同时起来会读到半截的
   * 状态文件、随后又把它覆盖掉，旧进程手上那条调用就一直挂在「执行中」，10 分钟后被判结果未知。
   * 旧进程退出后，它没来得及报的调用按「被重启」结束（和 Server 自己重启 Agent 一样）。
   */
  private launchAfterStrays(runtime: Runtime, strays: number[]): void {
    const kill = this.options.killStray ?? defaultKillStray;
    let polls = Math.ceil(STOP_GRACE_MS / STRAY_POLL_MS);
    runtime.waitingStrays = true;
    const check = () => {
      runtime.timer = undefined;
      runtime.waitingStrays = false;
      if (this.shuttingDown || runtime.phase !== "running" || runtime.child) return;
      const remaining = strays.filter((pid) => this.strayAlive(pid));
      if (remaining.length && --polls > 0) {
        runtime.waitingStrays = true;
        runtime.timer = this.setTimer(check, STRAY_POLL_MS);
        return;
      }
      for (const pid of remaining) kill(pid, "SIGKILL");
      try {
        this.options.onAgentEnded?.(runtime.config.name, "restarted");
      } catch (error) {
        this.log(`[local-agents] ${runtime.config.name}：标记中断的调用失败：${String(error)}`);
      }
      this.launch(runtime, true);
    };
    runtime.timer = this.setTimer(check, STRAY_POLL_MS);
  }

  /** 服务关闭：先 SIGTERM 让 Agent 正常离线，宽限期后仍未退出再 SIGKILL */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.cancelUpdateTimers();
    await Promise.all(
      [...this.runtimes.values()].map((runtime) => this.terminate(runtime, "serverStopped")),
    );
  }

  private require(id: string): Runtime {
    const runtime = this.runtimes.get(id);
    if (!runtime)
      throw new HiveError("LOCAL_AGENT_NOT_FOUND", serverText("error.localAgent.notFound"));
    return runtime;
  }

  private track(config: LocalAgentConfig): Runtime {
    const runtime: Runtime = {
      config,
      pid: null,
      startedAt: null,
      lastExitCode: null,
      lastError: null,
      restarts: 0,
      failures: [],
      consecutiveFailures: 0,
      phase: config.autostart ? "running" : "stopped",
      stopping: false,
      logs: [],
      pendingLine: "",
      settingsApplied: false,
    };
    this.runtimes.set(config.id, runtime);
    return runtime;
  }

  private view(runtime: Runtime, busy?: ReadonlySet<string>): LocalAgent {
    const { config } = runtime;
    const running = runtime.child ? this.options.runningVersion?.(config.name) : undefined;
    const outdated = this.outdated(runtime);
    const current = this.current?.version;
    let status: LocalAgentStatus;
    if (runtime.child) {
      status = this.options.isAgentOnline(config.name) ? "running" : "starting";
    } else {
      status = runtime.phase === "running" ? "starting" : runtime.phase;
    }
    return {
      id: config.id,
      provider: config.provider,
      name: config.name,
      access: config.access,
      cwd: config.cwd,
      model: config.model,
      effort: config.effort ?? null,
      compactWindow: config.compactWindow ?? null,
      cacheTtl: config.cacheTtl ?? null,
      status,
      pid: runtime.child ? runtime.pid : null,
      startedAt: runtime.startedAt ? new Date(runtime.startedAt).toISOString() : null,
      lastExitCode: runtime.lastExitCode,
      lastError: runtime.lastError,
      restarts: runtime.restarts,
      createdAt: config.createdAt,
      mcpDisabled: config.mcpDisabled ?? [],
      autoSteer: this.options.database.getSetting(autoSteerKey(config.name)) === "1",
      // 正在运行、但启动时没带设置文件（升级前就在跑的进程）：勾选、模型要重启一次才生效
      ...(runtime.child && !runtime.settingsApplied && this.settingsFile(config)
        ? { settingsPendingRestart: true }
        : {}),
      busy: runtime.child ? this.isBusy(runtime, busy) : false,
      ...(running ? { version: running } : {}),
      ...(runtime.cwdFallback ? { cwdFallback: runtime.cwdFallback } : {}),
      ...(outdated ? { outdated: true } : {}),
      // 点过「重启」在等它忙完，或自动更新会在它空闲后重启它
      ...(runtime.pendingRestart ||
      (outdated &&
        current &&
        this.autoUpdateEnabled() &&
        runtime.autoRestartedFor !== versionKey(current))
        ? { restartWhenIdle: true }
        : {}),
    };
  }

  private launch(runtime: Runtime, straysCleared = false): void {
    if (this.shuttingDown || runtime.child || runtime.waitingStrays) return;
    const { config } = runtime;
    // 新进程跑的就是现在的代码：之前等着的重启不用再做了
    runtime.pendingRestart = undefined;
    const fallback = checkCwd(config.cwd, this.options.home?.());
    runtime.cwdFallback = fallback;
    if (fallback) {
      const message =
        fallback.reason === "installDir"
          ? `工作目录 ${fallback.from} 是桌面端的安装目录，升级后会被删掉，已改成 ${fallback.to}`
          : `工作目录 ${fallback.from} 不存在，这次先在 ${fallback.to} 启动；目录恢复后重启这个 Agent 即回到原目录`;
      this.appendLog(runtime, `[hive] ${message}\n`);
      this.options.log?.(`[local-agents] ${config.name}：${message}`);
      if (fallback.reason === "installDir") {
        this.options.database.setLocalAgentCwd(config.id, fallback.to);
        runtime.config = { ...config, cwd: fallback.to };
      }
    }
    const cwd = fallback ? fallback.to : config.cwd;
    // 旧进程还占着名字的话新进程上不了线（一直报「名字已在线」）：先请它退出，还活着就等它退出再启动
    if (!straysCleared) {
      const strays = this.signalStrays(runtime).filter((pid) => this.strayAlive(pid));
      if (strays.length) {
        this.launchAfterStrays(runtime, strays);
        return;
      }
    }
    const settingsFile = this.writeSettings(runtime.config);
    runtime.settingsApplied = settingsFile !== undefined;
    const args = [
      ...this.options.cli.args,
      "join",
      cliOption("server", this.options.serverUrl),
      cliOption("name", config.name),
      cliOption("provider", config.provider),
      cliOption("access", config.access),
      ...(cwd ? [cliOption("cwd", cwd)] : []),
      // 有设置文件时模型只从设置文件读（每一轮生效），不再作为启动参数：改回默认才能真的回到默认
      ...(config.model && !settingsFile ? [cliOption("model", config.model)] : []),
      ...(settingsFile ? [cliOption("agent-settings", settingsFile)] : []),
      // 本机拉起的 Agent 是房主自己的：房主在网页上给房间设的工作区直接跟随，不用再手动 --allow-root
      "--trust-room-workspace",
    ];
    runtime.phase = "running";
    runtime.stopping = false;
    runtime.startedAt = this.now();
    this.appendLog(
      runtime,
      `[hive] 启动 ${config.name}（${config.provider} · ${config.access}）\n`,
    );
    const logFile = this.logFile(config);
    if (logFile) mkdirSync(path.dirname(logFile), { recursive: true });
    const proxy = this.proxyEnv(runtime);
    const proxyUrl = proxy?.set.HTTPS_PROXY;
    if (proxyUrl) this.appendLog(runtime, `[hive] 网络代理：${maskProxyUrl(proxyUrl)}\n`);
    else if (proxy?.unset.includes("HTTPS_PROXY"))
      this.appendLog(runtime, "[hive] 网络代理：不用代理\n");
    const child = this.spawnAgent(this.options.cli.command, args, {
      cwd: homedir(),
      env: {
        ...proxy?.set,
        // token 走环境变量：命令行参数会被同机其他用户通过 ps 看到
        HIVE_AGENT_TOKEN: this.options.joinToken,
        // 让子进程在 Hive Server 消失（包括被 kill -9）且一段时间内没有回来时自行退出，不留孤儿
        HIVE_SUPERVISOR_PID: String(process.pid),
      },
      ...(proxy?.unset.length ? { unsetEnv: proxy.unset } : {}),
      ...(logFile ? { logFile } : {}),
    });
    this.attach(runtime, child, runtime.startedAt);
  }

  /** 网络代理设置算出的环境变量；读系统代理出错不影响启动，按没设代理处理 */
  private proxyEnv(runtime: Runtime): ProxyEnvPatch | undefined {
    try {
      return this.options.proxyEnv?.();
    } catch (error) {
      this.appendLog(
        runtime,
        `[hive] 读取网络代理设置失败，这次不设代理：${error instanceof Error ? error.message : String(error)}\n`,
      );
      return undefined;
    }
  }

  private attach(runtime: Runtime, child: ChildHandle, startedAt: number): void {
    runtime.phase = "running";
    runtime.stopping = false;
    runtime.startedAt = startedAt;
    runtime.child = child;
    runtime.pid = child.pid ?? null;
    const recordPid = (pid: number | undefined) => {
      if (!pid || runtime.child !== child) return;
      runtime.pid = pid;
      this.options.database.setLocalAgentProcess(
        runtime.config.id,
        pid,
        new Date(startedAt).toISOString(),
      );
    };
    if (child.pid) recordPid(child.pid);
    else void child.pidReady?.then(recordPid);
    let resolveExited!: () => void;
    runtime.exited = new Promise((resolve) => (resolveExited = resolve));
    child.onOutput((chunk) => this.appendLog(runtime, chunk));
    child.onExit((code, error) => {
      if (runtime.child === child) runtime.child = undefined;
      runtime.lastExitCode = code;
      if (!this.shuttingDown || runtime.stopping) {
        this.options.database.setLocalAgentProcess(runtime.config.id, null, null);
      }
      if (error) this.appendLog(runtime, `[hive] 无法启动：${error.message}\n`);
      resolveExited();
      this.handleExit(runtime, code, error);
    });
  }

  private handleExit(runtime: Runtime, code: number | null, error?: Error): void {
    if (runtime.stopping || this.shuttingDown) return;
    const now = this.now();
    const ranFor = runtime.startedAt ? now - runtime.startedAt : 0;
    if (ranFor >= STABLE_RUN_MS) runtime.consecutiveFailures = 0;
    runtime.consecutiveFailures += 1;
    runtime.failures = [...runtime.failures.filter((at) => now - at < CRASH_WINDOW_MS), now];
    runtime.lastError =
      error?.message ?? (this.tail(runtime, 5) || `进程退出，退出码 ${code ?? "未知"}`);
    if (runtime.failures.length >= CRASH_LIMIT) {
      runtime.phase = "crashed";
      this.log(`[local-agents] ${runtime.config.name} 连续崩溃，已停止自动重启`);
      this.appendLog(runtime, `[hive] 10 分钟内退出 ${CRASH_LIMIT} 次，已停止自动重启。\n`);
      return;
    }
    const delay = Math.min(BACKOFF_MAX_MS, 1_000 * 2 ** (runtime.consecutiveFailures - 1));
    runtime.phase = "restarting";
    this.appendLog(runtime, `[hive] 进程意外退出，${Math.round(delay / 1000)} 秒后重启。\n`);
    runtime.timer = this.setTimer(() => {
      runtime.timer = undefined;
      if (runtime.phase !== "restarting") return;
      runtime.restarts += 1;
      this.launch(runtime);
    }, delay);
  }

  private async terminate(runtime: Runtime, reason?: LocalAgentEndReason): Promise<void> {
    runtime.timer?.cancel();
    runtime.timer = undefined;
    runtime.waitingStrays = false;
    const child = runtime.child;
    if (!child) return;
    runtime.stopping = true;
    // Windows 上「信号」都是强制结束，Agent 来不及下线：先经连接请它自己退出，宽限期过了再结束进程树
    const asked =
      process.platform === "win32" &&
      (this.options.requestShutdown?.(runtime.config.name) ?? false);
    if (!asked) child.kill("SIGTERM");
    let forced: { cancel(): void } | undefined;
    await Promise.race([
      runtime.exited,
      new Promise<void>((resolve) => {
        forced = this.setTimer(() => {
          child.kill("SIGKILL");
          resolve();
        }, STOP_GRACE_MS);
      }),
    ]);
    forced?.cancel();
    if (runtime.child === child) runtime.child = undefined;
    // 进程已经退出：它来得及自己报的结果（停下、下线）已经收到，剩下还在进行的就不会再有结果了
    if (reason) {
      try {
        this.options.onAgentEnded?.(runtime.config.name, reason);
      } catch (error) {
        this.log(`[local-agents] ${runtime.config.name}：标记中断的调用失败：${String(error)}`);
      }
    }
  }

  private appendLog(runtime: Runtime, chunk: string): void {
    const text = runtime.pendingLine + chunk.replace(ANSI_PATTERN, "").replace(/\r/g, "");
    const lines = text.split("\n");
    runtime.pendingLine = lines.pop() ?? "";
    runtime.logs.push(...lines);
    if (runtime.logs.length > LOG_LINES) runtime.logs.splice(0, runtime.logs.length - LOG_LINES);
  }

  private tail(runtime: Runtime, count: number): string {
    return runtime.logs
      .filter((line) => line.trim() && !line.startsWith("[hive] 启动"))
      .slice(-count)
      .join("\n")
      .slice(-1_000);
  }
}

/** workspace / full 的目录必须真实存在且是绝对路径；取 realpath 存储，拒绝文件系统根目录 */
/** 进程的命令行里是否带某个参数（读不到时按没有处理） */
function processHasArgument(pid: number | undefined, argument: string): boolean {
  return pid ? (processCommandLine(pid)?.includes(argument) ?? false) : false;
}

/** 读进程的完整命令行：macOS / Linux 用 ps，Windows 用 PowerShell 查 Win32_Process；读不到返回 undefined */
/** 命令行里带着这个设置文件的进程（就是这个本机 Agent 的 hive join） */
function defaultFindStrays(settingsFile: string): number[] {
  const marker = `--agent-settings=${settingsFile}`;
  let listing: string;
  if (process.platform === "win32") {
    listing = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }',
      ],
      { encoding: "utf8", timeout: 15_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
    );
  } else {
    listing = execFileSync("ps", ["-ax", "-o", "pid=,args="], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
  }
  const pids: number[] = [];
  for (const line of listing.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match || !match[2]!.includes(marker)) continue;
    // 命令行里的路径后面要么结束、要么是空格或引号，免得 a.json 匹配到 a.json.bak
    const after = match[2]!.charAt(match[2]!.indexOf(marker) + marker.length);
    if (after && !/[\s"']/.test(after)) continue;
    pids.push(Number(match[1]));
  }
  return pids;
}

function defaultKillStray(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    killTree(pid);
    return;
  }
  try {
    process.kill(pid, signal);
  } catch {
    /* 已经退出 */
  }
}

function processCommandLine(pid: number): string | undefined {
  try {
    if (process.platform === "win32") {
      return (
        execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-CimInstance Win32_Process -Filter "ProcessId=${Math.trunc(pid)}").CommandLine`,
          ],
          { encoding: "utf8", timeout: 10_000, windowsHide: true },
        ).trim() || undefined
      );
    }
    return execFileSync("ps", ["-o", "args=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    });
  } catch {
    return undefined;
  }
}

/**
 * Windows 上结束整棵进程树：信号在 Windows 上一律是强制结束，而且只结束 Agent 自己，
 * 它起的 claude / codex 与工具命令会留下来。taskkill /T 连同子进程一起结束。
 */
function killTree(pid: number): void {
  execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => {
    /* 已经退出时 taskkill 报错，忽略 */
  });
}

export function resolveWorkspace(input: string | undefined): string {
  if (!input?.trim())
    throw new HiveError("LOCAL_AGENT_CWD_REQUIRED", serverText("error.localAgent.cwdRequired"));
  const cwd = expandHome(input);
  if (!path.isAbsolute(cwd)) {
    throw new HiveError("LOCAL_AGENT_CWD_INVALID", serverText("error.localAgent.cwdAbsolute"));
  }
  let resolved: string;
  try {
    resolved = realpathSync(cwd);
  } catch {
    throw new HiveError(
      "LOCAL_AGENT_CWD_INVALID",
      serverText("error.localAgent.cwdMissing", { path: cwd }),
    );
  }
  if (!statSync(resolved).isDirectory()) {
    throw new HiveError(
      "LOCAL_AGENT_CWD_INVALID",
      serverText("error.localAgent.cwdNotDirectory", { path: cwd }),
    );
  }
  if (path.parse(resolved).root === resolved) {
    throw new HiveError("LOCAL_AGENT_CWD_INVALID", serverText("error.localAgent.cwdRoot"));
  }
  return resolved;
}
