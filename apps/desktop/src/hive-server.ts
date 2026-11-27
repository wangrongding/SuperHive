import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/**
 * 本机 Hive 的发现与启动，和 `hive start` 共用 ~/.superhive/server.json：
 * - 已经有 hive start（或另一个桌面端）起的 Server 在跑：直接连上去，不再起一个抢端口；
 * - 否则由桌面端起一个，写同样格式的 server.json，`hive stop` / `hive start` 都认得它。
 */

export type ServiceState = {
  pid: number;
  instanceId: string;
  healthUrl: string;
  publicUrl: string;
  dataDir: string;
  logPath: string;
  startedAt: string;
  startOptions?: { host: string; port: number; publicUrl?: string; localAgents?: false };
  shutdownToken?: string;
  /** 桌面端写入：这个 Server 由哪个程序起的 */
  launcher?: string;
};

/**
 * 数据目录：和 CLI 一样默认 ~/.superhive；改名前的 ~/.ai-hive 还在而新目录没有时沿用旧目录
 * （迁移交给 CLI 做，桌面端不搬用户数据）。SUPERHIVE_DESKTOP_DATA_DIR 给测试和高级用户指定别的目录。
 */
export function superhiveHome(
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
  exists: (file: string) => boolean = existsSync,
): string {
  if (env.SUPERHIVE_DESKTOP_DATA_DIR) return path.resolve(env.SUPERHIVE_DESKTOP_DATA_DIR);
  const current = path.join(home, ".superhive");
  const legacy = path.join(home, ".ai-hive");
  return !exists(current) && exists(legacy) ? legacy : current;
}

export function statePathFor(dataDir: string): string {
  return path.join(dataDir, "server.json");
}

export function readState(statePath: string): ServiceState | undefined {
  try {
    const value = JSON.parse(readFileSync(statePath, "utf8")) as Partial<ServiceState>;
    if (
      typeof value.pid !== "number" ||
      typeof value.instanceId !== "string" ||
      typeof value.healthUrl !== "string" ||
      typeof value.publicUrl !== "string"
    ) {
      return undefined;
    }
    return value as ServiceState;
  } catch {
    return undefined;
  }
}

export function writeState(statePath: string, state: ServiceState): void {
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

type Health = { status?: string; instanceId?: string };

export async function readHealth(url: string, timeoutMs = 1_000): Promise<Health | undefined> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return undefined;
    return (await response.json()) as Health;
  } catch {
    return undefined;
  }
}

/** 窗口要打开的地址：一律用回环地址（在本机打开才是房主身份，也只把终端交给回环页面） */
export function loopbackOrigin(healthUrl: string): string {
  const url = new URL(healthUrl);
  const host = ["0.0.0.0", "localhost", "[::]"].includes(url.hostname) ? "127.0.0.1" : url.hostname;
  if (host !== "127.0.0.1" && host !== "[::1]") return `http://127.0.0.1:${url.port || "80"}`;
  return `http://${host}:${url.port || "80"}`;
}

/** 端口能不能用：在通配地址上试着监听一下 */
export function portFree(port: number, host = "0.0.0.0"): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

export type Discovery =
  | { kind: "existing"; origin: string; state?: ServiceState; source: "state" | "port" }
  | { kind: "start"; port: number };

/**
 * 决定连哪个 Hive：
 * 1. server.json 记录的进程还在、健康检查的 instanceId 对得上 → 连它；
 * 2. 记录过期就清掉；
 * 3. 首选端口上已经是一个 Hive（比如仓库里 pnpm dev 起的）→ 也直接连；
 * 4. 首选端口被别的程序占了 → 往后找一个空端口自己起。
 */
export async function discover(options: {
  dataDir: string;
  preferredPort: number;
  health?: typeof readHealth;
  isPortFree?: (port: number) => Promise<boolean>;
  alive?: (pid: number) => boolean;
  maxTries?: number;
}): Promise<Discovery> {
  const health = options.health ?? readHealth;
  const free = options.isPortFree ?? ((port: number) => portFree(port));
  const alive = options.alive ?? processExists;
  const statePath = statePathFor(options.dataDir);
  const state = readState(statePath);
  if (state) {
    const payload = alive(state.pid) ? await health(state.healthUrl) : undefined;
    if (payload?.status === "ok" && payload.instanceId === state.instanceId) {
      return { kind: "existing", origin: loopbackOrigin(state.healthUrl), state, source: "state" };
    }
    rmSync(statePath, { force: true });
  }
  const tries = options.maxTries ?? 20;
  for (let offset = 0; offset < tries; offset += 1) {
    const port = options.preferredPort + offset;
    if (port > 65_535) break;
    if (await free(port)) return { kind: "start", port };
    // 只有首选端口上的 Hive 才直接连：别的端口上的可能是另一份数据目录
    if (offset === 0) {
      const payload = await health(`http://127.0.0.1:${port}/health`);
      if (payload?.status === "ok") {
        return { kind: "existing", origin: `http://127.0.0.1:${port}`, source: "port" };
      }
    }
  }
  throw new Error(`No free port found from ${options.preferredPort}`);
}

export type ServerChild = {
  pid: number | undefined;
  kill(): boolean;
  on(event: "exit", listener: (code: number) => void): unknown;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
};

/** 拉起 Server 进程；等进程真正起来（拿到 pid）再返回 */
/** cwd：Server 进程的工作目录，桌面端统一用主目录（见 serverEnv） */
export type ForkServer = (
  entry: string,
  env: Record<string, string>,
  cwd: string,
) => Promise<ServerChild>;

export type OwnedServer = {
  origin: string;
  state: ServiceState;
  child: ServerChild;
  exited: Promise<number>;
  /** handover：换代重启，本机 Agent 交给下一个 Server 接管，不下线 */
  stop(options?: { handover?: boolean }): Promise<void>;
};

/**
 * 桌面端起 Server 用的环境变量：继承当前环境（去掉 ELECTRON_*），再盖上 overrides。
 * HIVE_LAUNCH_DIR 是新建 Agent、选目录时的默认工作目录；不设的话 Server 拿 process.cwd()，
 * 而桌面端的 cwd 是安装目录（Windows：%LOCALAPPDATA%\SuperHive\app-<版本>，升级后会被删掉）
 * 或 /（Mac 上双击打开 .app），都不能当工作目录，所以统一设成主目录。
 * 用户自己在环境里设了 HIVE_LAUNCH_DIR 时尊重它。
 */
export function serverEnv(
  base: NodeJS.ProcessEnv,
  home: string,
  overrides: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !key.startsWith("ELECTRON_")) env[key] = value;
  }
  env.HIVE_LAUNCH_DIR = base.HIVE_LAUNCH_DIR?.trim() || home;
  return Object.assign(env, overrides);
}

/** 起桌面端自己的 Server（utilityProcess），等健康检查通过 */
export async function startServer(options: {
  fork: ForkServer;
  serverEntry: string;
  staticDir: string;
  dataDir: string;
  port: number;
  host?: string;
  env: NodeJS.ProcessEnv;
  agentCli: string[];
  launcher: string;
  /** 用户主目录：Server 的 cwd 和新建 Agent、房间工作区的默认目录 */
  home: string;
  readyTimeoutMs?: number;
}): Promise<OwnedServer> {
  const dataDir = options.dataDir;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  // 默认只听本机；要让局域网设备连进来由调用方传 0.0.0.0（见 lan-access.ts）
  const host = options.host ?? "127.0.0.1";
  const instanceId = randomUUID();
  const shutdownToken = randomUUID();
  const healthUrl = `http://127.0.0.1:${options.port}/health`;
  const logPath = path.join(dataDir, "server.log");
  const env = serverEnv(options.env, options.home, {
    HIVE_HOST: host,
    HIVE_PORT: String(options.port),
    HIVE_DATABASE: path.join(dataDir, "hive.sqlite"),
    HIVE_STATIC_DIR: options.staticDir,
    HIVE_INSTANCE_ID: instanceId,
    HIVE_SHUTDOWN_TOKEN: shutdownToken,
    HIVE_LOCAL_AGENT_CLI: JSON.stringify(options.agentCli),
    // 已经是桌面端拉起的，不要再有别的程序替它开浏览器
    HIVE_NO_OPEN: "1",
  });

  const child = await options.fork(options.serverEntry, env, options.home);
  const logFd = openSync(logPath, "a", 0o600);
  const write = (chunk: Buffer | string) => {
    try {
      writeSync(logFd, typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    } catch {
      /* 日志写不进去不影响运行 */
    }
  };
  child.stdout?.on("data", write);
  child.stderr?.on("data", write);
  const exited = new Promise<number>((resolve) => {
    child.on("exit", (code) => {
      try {
        closeSync(logFd);
      } catch {
        /* 已关闭 */
      }
      resolve(code);
    });
  });

  const state: ServiceState = {
    pid: child.pid ?? -1,
    instanceId,
    healthUrl,
    publicUrl: `http://127.0.0.1:${options.port}`,
    dataDir,
    logPath,
    startedAt: new Date().toISOString(),
    startOptions: { host, port: options.port },
    shutdownToken,
    launcher: options.launcher,
  };
  const statePath = statePathFor(dataDir);
  if (child.pid) writeState(statePath, state);

  const deadline = Date.now() + (options.readyTimeoutMs ?? 30_000);
  let exitCode: number | undefined;
  void exited.then((code) => {
    exitCode = code;
  });
  while (Date.now() < deadline) {
    if (exitCode !== undefined) break;
    const payload = await readHealth(healthUrl);
    if (payload?.status === "ok" && payload.instanceId === instanceId) {
      const origin = `http://127.0.0.1:${options.port}`;
      return {
        origin,
        state,
        child,
        exited,
        stop: (stopOptions) => stopServer({ state, child, exited, statePath, ...stopOptions }),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  child.kill();
  rmSync(statePath, { force: true });
  throw new Error(
    exitCode !== undefined
      ? `SuperHive Server exited early (code ${exitCode}). Log: ${logPath}`
      : `SuperHive Server did not start within ${Math.round((options.readyTimeoutMs ?? 30_000) / 1000)}s. Log: ${logPath}`,
  );
}

/** 先请 Server 正常退出（本机 Agent 下线、IM 断开），等不到再强制结束 */
export async function stopServer(options: {
  state: ServiceState;
  child: ServerChild;
  exited: Promise<number>;
  statePath: string;
  timeoutMs?: number;
  handover?: boolean;
}): Promise<void> {
  const { state } = options;
  let done = false;
  void options.exited.then(() => {
    done = true;
  });
  if (state.shutdownToken) {
    await fetch(new URL("/api/local/shutdown", state.healthUrl), {
      method: "POST",
      headers: {
        "x-hive-shutdown": state.shutdownToken,
        ...(options.handover ? { "content-type": "application/json" } : {}),
      },
      ...(options.handover ? { body: JSON.stringify({ handover: true }) } : {}),
      signal: AbortSignal.timeout(3_000),
    }).catch(() => undefined);
  }
  const timeout = options.timeoutMs ?? 10_000;
  await Promise.race([options.exited, new Promise((resolve) => setTimeout(resolve, timeout))]);
  if (!done) options.child.kill();
  // 只删自己写的那份记录：期间别人重启过就不动
  const current = readState(options.statePath);
  if (!current || current.instanceId === state.instanceId)
    rmSync(options.statePath, { force: true });
}

/** 问自己起的 Server 有没有别的设备连进来过（老 Server 没有这个接口、出错时返回 undefined） */
export async function readLanUsage(
  state: Pick<ServiceState, "healthUrl" | "shutdownToken">,
): Promise<{ ownerDevices: number; guestSessions: number } | undefined> {
  if (!state.shutdownToken) return undefined;
  try {
    const response = await fetch(new URL("/api/local/lan-usage", state.healthUrl), {
      headers: { "x-hive-shutdown": state.shutdownToken },
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return undefined;
    const value = (await response.json()) as { ownerDevices?: unknown; guestSessions?: unknown };
    if (typeof value.ownerDevices !== "number" || typeof value.guestSessions !== "number")
      return undefined;
    return { ownerDevices: value.ownerDevices, guestSessions: value.guestSessions };
  } catch {
    return undefined;
  }
}
