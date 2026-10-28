import { execFile, spawn } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type {
  CreateLocalAgentRequest,
  LocalAgent,
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
};

export type SpawnAgent = (
  command: string,
  args: string[],
  options: { env: Record<string, string>; cwd: string },
) => ChildHandle;

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
};

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export const defaultSpawnAgent: SpawnAgent = (command, args, options) => {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exitListeners: Array<(code: number | null, error?: Error) => void> = [];
  let exited = false;
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
      if (!exited) child.kill(signal);
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
  private readonly probe: ProviderProbe;
  private readonly now: () => number;
  private readonly setTimer: NonNullable<LocalAgentSupervisorOptions["setTimer"]>;
  private readonly log: (message: string) => void;
  private probeCache?: { at: number; result: Promise<LocalProviderInfo[]> };
  private shuttingDown = false;

  constructor(private readonly options: LocalAgentSupervisorOptions) {
    this.spawnAgent = options.spawn ?? defaultSpawnAgent;
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
  }

  /** 服务启动时恢复上次保存的本机 Agent；手动停止过的保持停止 */
  start(): void {
    for (const config of this.options.database.listLocalAgents()) {
      const runtime = this.track(config);
      if (config.autostart) this.launch(runtime);
    }
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
    };
  }

  private launch(runtime: Runtime): void {
    if (this.shuttingDown || runtime.child) return;
    const { config } = runtime;
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
    ];
    runtime.phase = "running";
    runtime.stopping = false;
    runtime.startedAt = this.now();
    this.appendLog(
      runtime,
      `[hive] 启动 ${config.name}（${config.provider} · ${config.access}）\n`,
    );
    const child = this.spawnAgent(this.options.cli.command, args, {
      cwd: homedir(),
      env: {
        // token 走环境变量：命令行参数会被同机其他用户通过 ps 看到
        HIVE_AGENT_TOKEN: this.options.joinToken,
        // 让子进程在 Hive Server 消失（包括被 kill -9）时自行退出，不留孤儿
        HIVE_SUPERVISOR_PID: String(process.pid),
      },
    });
    runtime.child = child;
    runtime.pid = child.pid ?? null;
    let resolveExited!: () => void;
    runtime.exited = new Promise((resolve) => (resolveExited = resolve));
    child.onOutput((chunk) => this.appendLog(runtime, chunk));
    child.onExit((code, error) => {
      if (runtime.child === child) runtime.child = undefined;
      runtime.lastExitCode = code;
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
