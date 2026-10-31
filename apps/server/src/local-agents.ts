import { execFile, execFileSync, spawn } from "node:child_process";
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
import type {
  CreateLocalAgentRequest,
  LocalAgent,
  LocalAgentMcpResponse,
  LocalAgentProvider,
  LocalAgentStatus,
  LocalProviderInfo,
} from "@ai-hive/protocol";
import { HiveError, type HiveDatabase, type LocalAgentConfig } from "./database.js";
import { expandHome } from "./local-directories.js";

/**
 * 本机 Agent 管家：在 Hive Server 所在电脑上，按房主在网页上的选择拉起 `ai-hive join` 子进程。
 * 只负责进程生命周期（启动、崩溃重启、停止、退出清理），Agent 的行为仍完全由 CLI 决定。
 * 鉴权与"是否本机请求"的判断在路由层（local-access.ts），这里假定调用方已通过校验。
 */

/** ai-hive CLI 的启动方式：打包后是 node + dist/cli.js，开发时是 node + tsx + src/cli.ts */
export type AgentCli = { command: string; args: string[] };

export type ChildHandle = {
  pid: number | undefined;
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
  options: { env: Record<string, string>; cwd: string; logFile?: string },
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
  log?: (message: string) => void;
  spawn?: SpawnAgent;
  adopt?: AdoptAgent;
  /** Agent 输出日志的目录；设置后 Agent 以独立进程组运行，Server 交接重启时不随之退出 */
  logDir?: string;
  /** Agent 设置文件目录（网页上勾选的 MCP 等）；Agent 每一轮读取，改动不必重启 */
  settingsDir?: string;
  /** 列出 Agent 会加载的本机 MCP（测试注入）；默认运行 `ai-hive mcp list` */
  listMcp?: McpLister;
  probe?: ProviderProbe;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => { cancel(): void };
};

const LOG_LINES = 500;
const BACKOFF_MAX_MS = 60_000;
/** 10 分钟内意外退出 5 次即熔断，避免未登录等配置错误导致无限重启 */
const CRASH_WINDOW_MS = 10 * 60_000;
const CRASH_LIMIT = 5;
/** 连续运行超过 1 分钟视为稳定，之后再退出时退避从头计算 */
const STABLE_RUN_MS = 60_000;
const STOP_GRACE_MS = 5_000;
const PROBE_CACHE_MS = 60_000;
/** 单个 Agent 日志超过这个大小时，下次启动先轮转为 .1 */
const LOG_FILE_MAX_BYTES = 5 * 1024 * 1024;
const TAIL_INTERVAL_MS = 1_000;

export type McpLister = (args: string[]) => Promise<string>;

/** 支持按勾选加载 MCP 的 provider */
const MCP_SELECTABLE: ReadonlySet<LocalAgentProvider> = new Set(["claude", "codex"]);
/** 实测：Claude Code 不带任何 MCP 时开局约 4 万 token（系统提示与内置工具） */
const CLAUDE_BASELINE_TOKENS = 40_000;
const MCP_MEASURE_CACHE_MS = 10 * 60_000;

export const PROVIDER_COMMANDS: Record<LocalAgentProvider, string> = {
  codex: "codex",
  claude: "claude",
  copilot: "copilot",
  opencode: "opencode",
  omp: "omp",
  openclaw: "openclaw",
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
  /** 主动停止中：退出不算失败 */
  stopping: boolean;
  timer?: { cancel(): void } | undefined;
  logs: string[];
  pendingLine: string;
  exited?: Promise<void> | undefined;
  /** 当前进程启动时带了设置文件：之后的勾选改动下一轮就生效；否则要重启一次 */
  settingsApplied: boolean;
};

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
  let fd: number | undefined;
  if (logFile) {
    if (fileSize(logFile) > LOG_FILE_MAX_BYTES) renameSync(logFile, `${logFile}.1`);
    fd = openSync(logFile, "a");
  }
  const offset = logFile ? fileSize(logFile) : 0;
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    // 写日志文件的 Agent 自成进程组：Server（及 dev 结束 Server 进程组）退出时不会把它一起带走
    stdio: fd === undefined ? ["ignore", "pipe", "pipe"] : ["ignore", fd, fd],
    detached: fd !== undefined && process.platform !== "win32",
  });
  if (fd !== undefined) closeSync(fd);
  const exitListeners: Array<(code: number | null, error?: Error) => void> = [];
  const outputListeners: Array<(chunk: string) => void> = [];
  let exited = false;
  let released = false;
  let stopTail: (() => void) | undefined;
  const emitExit = (code: number | null, error?: Error) => {
    if (exited || released) return;
    exited = true;
    stopTail?.();
    for (const listener of exitListeners) listener(code, error);
  };
  child.on("error", (error) => emitExit(null, error));
  child.on("close", (code) => emitExit(code));
  if (logFile) {
    child.unref();
    stopTail = tailFile(logFile, offset, (chunk) => {
      for (const listener of outputListeners) listener(chunk);
    });
  }
  return {
    pid: child.pid,
    onOutput(listener) {
      if (logFile) outputListeners.push(listener);
      else {
        child.stdout?.setEncoding("utf8").on("data", listener);
        child.stderr?.setEncoding("utf8").on("data", listener);
      }
    },
    onExit(listener) {
      exitListeners.push(listener);
    },
    kill(signal) {
      if (!exited) child.kill(signal);
    },
    release() {
      released = true;
      stopTail?.();
      child.removeAllListeners();
    },
  };
};

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * 按 pid 接管：进程还在，并且命令行确实是这个名字的 `ai-hive join`（防止 pid 被别的进程复用），
 * 之后靠轮询发现它退出、靠信号结束它，输出从日志文件末尾接着读。
 */
export const defaultAdoptAgent: AdoptAgent = (pid, options) => {
  if (process.platform === "win32" || !isAlive(pid)) return undefined;
  let commandLine: string;
  try {
    commandLine = execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 5_000,
    });
  } catch {
    return undefined;
  }
  const args = commandLine.trim().split(/\s+/);
  const nameAt = args.indexOf("--name");
  if (!args.includes("join") || nameAt < 0 || args[nameAt + 1] !== options.name) return undefined;
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
    execFile(command, ["--version"], { timeout: 5_000, encoding: "utf8" }, (error, stdout) => {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
        resolve({ installed: false, version: null });
        return;
      }
      const version = stdout.trim().split("\n")[0]?.trim() || null;
      resolve({ installed: true, version: error ? null : version });
    });
  });

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
  private shuttingDown = false;

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
    this.listMcp =
      options.listMcp ??
      ((args) =>
        new Promise((resolve, reject) =>
          execFile(
            options.cli.command,
            [...options.cli.args, ...args],
            { timeout: 90_000, maxBuffer: 4 * 1024 * 1024 },
            (error, stdout) => (error ? reject(error) : resolve(stdout)),
          ),
        ));
  }

  /**
   * 服务启动时恢复上次保存的本机 Agent；手动停止过的保持停止。
   * 上一个 Server 交接时留下的进程还在跑的，直接接管（它手上的任务不中断），不再另起一个。
   */
  start(): void {
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
      if (config.autostart) this.launch(runtime);
    }
  }

  /**
   * 交接给下一个 Server（开发时代码更新、Server 换代）：不结束 Agent 进程，只停止跟踪。
   * 进程号已经落库，新 Server 启动时接管；Agent 断线期间会自行重连，正在跑的任务继续做完。
   */
  detach(): void {
    this.shuttingDown = true;
    for (const runtime of this.runtimes.values()) {
      runtime.timer?.cancel();
      runtime.timer = undefined;
      runtime.child?.release?.();
    }
  }

  private settingsFile(config: LocalAgentConfig): string | undefined {
    return this.options.settingsDir && MCP_SELECTABLE.has(config.provider)
      ? path.join(this.options.settingsDir, `${config.id}.json`)
      : undefined;
  }

  private writeSettings(config: LocalAgentConfig): string | undefined {
    const file = this.settingsFile(config);
    if (!file) return undefined;
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ mcpDisabled: config.mcpDisabled ?? [] }), { mode: 0o600 });
    // 先写临时文件再改名：Agent 随时可能在读，不能读到写了一半的内容
    renameSync(tmp, file);
    return file;
  }

  /** 保存网页上的勾选；已带设置文件启动的 Agent 下一轮就按新的勾选加载 */
  updateSettings(id: string, settings: { mcpDisabled: string[] }): LocalAgent {
    const runtime = this.require(id);
    if (!MCP_SELECTABLE.has(runtime.config.provider)) {
      throw new HiveError(
        "LOCAL_AGENT_MCP_UNSUPPORTED",
        "这个 Agent 类型暂不支持在 Hive 里开关 MCP。",
      );
    }
    runtime.config.mcpDisabled = this.options.database.setLocalAgentMcpDisabled(
      id,
      settings.mcpDisabled,
    );
    this.writeSettings(runtime.config);
    return this.view(runtime);
  }

  /** 这个 Agent 会加载的本机 MCP 及启用状态；measure 时逐个连上估算开局 token（结果缓存 10 分钟） */
  async mcpServers(id: string, measure: boolean): Promise<LocalAgentMcpResponse> {
    const { config } = this.require(id);
    return this.listMcpFor(id, config.provider, config.cwd, this.writeSettings(config), measure);
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
    const stdout = await this.listMcp([
      "mcp",
      "list",
      "--provider",
      provider,
      "--cwd",
      cwd ?? homedir(),
      ...(settingsFile ? ["--agent-settings", settingsFile] : []),
      "--json",
      ...(measure && provider === "claude" ? ["--measure"] : []),
    ]);
    const line = stdout.trim().split("\n").at(-1) ?? "";
    let servers: LocalAgentMcpResponse["servers"];
    try {
      servers = (JSON.parse(line) as { servers: LocalAgentMcpResponse["servers"] }).servers;
    } catch {
      throw new HiveError("LOCAL_AGENT_MCP_LIST_FAILED", "没能读取这个 Agent 的 MCP 列表。");
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
    return [...this.runtimes.values()].map((runtime) => this.view(runtime));
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
        const { installed, version } = await this.probe(command);
        return { provider, command, installed, version };
      }),
    );
    this.probeCache = { at: this.now(), result };
    return result;
  }

  create(request: CreateLocalAgentRequest): LocalAgent {
    const name = request.name.trim();
    if (this.options.isNameInUse(name)) {
      throw new HiveError("LOCAL_AGENT_NAME_TAKEN", `名称 ${name} 已被在线成员使用，请换一个。`);
    }
    // 与 `ai-hive join` 一致：可写的档位必须明确工作目录，避免授权到错误目录
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
    this.options.database.setLocalAgentAutostart(id, false);
    await this.terminate(runtime);
    runtime.phase = "stopped";
    return this.view(runtime);
  }

  async restart(id: string): Promise<LocalAgent> {
    const runtime = this.require(id);
    await this.terminate(runtime);
    runtime.failures = [];
    runtime.consecutiveFailures = 0;
    this.options.database.setLocalAgentAutostart(id, true);
    this.launch(runtime);
    return this.view(runtime);
  }

  async remove(id: string): Promise<void> {
    const runtime = this.require(id);
    await this.terminate(runtime);
    this.runtimes.delete(id);
    this.options.database.deleteLocalAgent(id);
  }

  /** 服务关闭：先 SIGTERM 让 Agent 正常离线，宽限期后仍未退出再 SIGKILL */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await Promise.all([...this.runtimes.values()].map((runtime) => this.terminate(runtime)));
  }

  private require(id: string): Runtime {
    const runtime = this.runtimes.get(id);
    if (!runtime) throw new HiveError("LOCAL_AGENT_NOT_FOUND", "找不到这个本机 Agent。");
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

  private view(runtime: Runtime): LocalAgent {
    const { config } = runtime;
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
      status,
      pid: runtime.child ? runtime.pid : null,
      startedAt: runtime.startedAt ? new Date(runtime.startedAt).toISOString() : null,
      lastExitCode: runtime.lastExitCode,
      lastError: runtime.lastError,
      restarts: runtime.restarts,
      createdAt: config.createdAt,
      mcpDisabled: config.mcpDisabled ?? [],
      // 正在运行、但启动时没带设置文件（升级前就在跑的进程）：勾选要重启一次才生效
      ...(runtime.child && !runtime.settingsApplied && MCP_SELECTABLE.has(config.provider)
        ? { settingsPendingRestart: true }
        : {}),
    };
  }

  private launch(runtime: Runtime): void {
    if (this.shuttingDown || runtime.child) return;
    const { config } = runtime;
    const settingsFile = this.writeSettings(config);
    runtime.settingsApplied = settingsFile !== undefined;
    const args = [
      ...this.options.cli.args,
      "join",
      "--server",
      this.options.serverUrl,
      "--name",
      config.name,
      "--provider",
      config.provider,
      "--access",
      config.access,
      ...(config.cwd ? ["--cwd", config.cwd] : []),
      ...(config.model ? ["--model", config.model] : []),
      ...(settingsFile ? ["--agent-settings", settingsFile] : []),
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
    const child = this.spawnAgent(this.options.cli.command, args, {
      cwd: homedir(),
      env: {
        // token 走环境变量：命令行参数会被同机其他用户通过 ps 看到
        HIVE_AGENT_TOKEN: this.options.joinToken,
        // 让子进程在 Hive Server 消失（包括被 kill -9）且一段时间内没有回来时自行退出，不留孤儿
        HIVE_SUPERVISOR_PID: String(process.pid),
      },
      ...(logFile ? { logFile } : {}),
    });
    this.attach(runtime, child, runtime.startedAt);
  }

  private attach(runtime: Runtime, child: ChildHandle, startedAt: number): void {
    runtime.phase = "running";
    runtime.stopping = false;
    runtime.startedAt = startedAt;
    runtime.child = child;
    runtime.pid = child.pid ?? null;
    if (child.pid) {
      this.options.database.setLocalAgentProcess(
        runtime.config.id,
        child.pid,
        new Date(startedAt).toISOString(),
      );
    }
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

  private async terminate(runtime: Runtime): Promise<void> {
    runtime.timer?.cancel();
    runtime.timer = undefined;
    const child = runtime.child;
    if (!child) return;
    runtime.stopping = true;
    child.kill("SIGTERM");
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
  if (!pid) return false;
  try {
    return execFileSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8" }).includes(
      argument,
    );
  } catch {
    return false;
  }
}

export function resolveWorkspace(input: string | undefined): string {
  if (!input?.trim())
    throw new HiveError("LOCAL_AGENT_CWD_REQUIRED", "工作区和完全访问权限需要指定工作目录。");
  const cwd = expandHome(input);
  if (!path.isAbsolute(cwd)) {
    throw new HiveError(
      "LOCAL_AGENT_CWD_INVALID",
      "工作目录需要是绝对路径，例如 /Users/me/project。",
    );
  }
  let resolved: string;
  try {
    resolved = realpathSync(cwd);
  } catch {
    throw new HiveError("LOCAL_AGENT_CWD_INVALID", `找不到目录 ${cwd}。`);
  }
  if (!statSync(resolved).isDirectory()) {
    throw new HiveError("LOCAL_AGENT_CWD_INVALID", `${cwd} 不是目录。`);
  }
  if (path.parse(resolved).root === resolved) {
    throw new HiveError("LOCAL_AGENT_CWD_INVALID", "不能把整个文件系统根目录作为工作目录。");
  }
  return resolved;
}
