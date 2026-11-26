/**
 * 带到别人房间的 Agent 清单：本机每个 `hive join --server <别人的 Hive>` 进程在 ~/.superhive/remote-joins/
 * 里各记一份（<id>.json），CLI（hive agents / hive leave）和本机 Server（/api/local/remote-joins）读同一份。
 *
 * 与 apps/server/src/remote-joins.ts 相同（两个包分别发布，各带一份；remote-joins.test.ts 校验两份一致）。
 * 只用 Node 内置模块和同目录的 background-process.ts，不依赖各包自己的其他代码。
 *
 * - <id>.json：记录（0600）。join 进程每 15 秒刷新一次 updatedAt 当心跳，连上 / 断开某个房间时写 rooms
 * - <id>.token：这个 Agent 的 join token（0600），重新上线、退出房间时用；不经接口返回
 * - <id>.log：后台运行时的日志
 * - <id>.stop：请 join 进程正常离线退出（各平台通用，Windows 上没有 SIGTERM 可用）
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnBackground } from "./background-process.js";

export type RemoteJoinRecord = {
  version: 1;
  id: string;
  server: string;
  roomId: string | null;
  name: string;
  runtime: string;
  access: string;
  cwd: string | null;
  model: string | null;
  pid: number | null;
  background: boolean;
  startedAt: string;
  /** 心跳：join 进程活着时每 15 秒刷新 */
  updatedAt: string;
  stoppedAt: string | null;
  logFile: string | null;
  /** 房间 → 是否连上 */
  rooms: Record<string, boolean>;
  /** 重新上线用：可执行文件、参数（不含 token 和 --background）、当时的工作目录 */
  launch: { command: string; args: string[]; cwd: string } | null;
  lastError: string | null;
};

/** 给界面和 hive agents 看的视图（与 @superhive/protocol 的 RemoteJoin 同构） */
export type RemoteJoinView = {
  id: string;
  server: string;
  roomId: string | null;
  name: string;
  runtime: string;
  access: string;
  cwd: string | null;
  model: string | null;
  pid: number | null;
  background: boolean;
  status: "online" | "connecting" | "stopped";
  rooms: { roomId: string; connected: boolean }[];
  startedAt: string;
  updatedAt: string;
  stoppedAt: string | null;
  logFile: string | null;
  canRestart: boolean;
  lastError: string | null;
};

export const HEARTBEAT_MS = 15_000;
/** 超过这么久没心跳，就算进程号还在（可能被系统复用了）也当它已经停了 */
export const STALE_MS = 60_000;

/** 清单目录：默认 ~/.superhive/remote-joins；HIVE_REMOTE_JOINS_DIR 可改（测试、临时环境） */
export function remoteJoinsDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const override = env.HIVE_REMOTE_JOINS_DIR?.trim();
  return override ? path.resolve(override) : path.join(home, ".superhive", "remote-joins");
}

export function normalizeServer(server: string): string {
  try {
    const url = new URL(server);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return server.replace(/\/+$/, "").toLowerCase();
  }
}

export function remoteJoinId(server: string, roomId: string | null, name: string): string {
  return createHash("sha256")
    .update(`${normalizeServer(server)}\n${roomId ?? "*"}\n${name.toLocaleLowerCase()}`)
    .digest("hex")
    .slice(0, 16);
}

const ID_PATTERN = /^[0-9a-f]{16}$/;

function file(dir: string, id: string, ext: "json" | "token" | "log" | "stop"): string {
  if (!ID_PATTERN.test(id)) throw new Error(`无效的 id：${id}`);
  return path.join(dir, `${id}.${ext}`);
}

export function logFileOf(dir: string, id: string): string {
  return file(dir, id, "log");
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function writeAtomic(target: string, content: string): void {
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, content, { mode: 0o600 });
  renameSync(temp, target);
}

export function readRecord(dir: string, id: string): RemoteJoinRecord | undefined {
  try {
    const value = JSON.parse(readFileSync(file(dir, id, "json"), "utf8")) as RemoteJoinRecord;
    return value && value.version === 1 && value.id === id ? value : undefined;
  } catch {
    return undefined;
  }
}

export function readRecords(dir: string): RemoteJoinRecord[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".json") && ID_PATTERN.test(name.slice(0, -5)))
    .map((name) => readRecord(dir, name.slice(0, -5)))
    .filter((record): record is RemoteJoinRecord => Boolean(record))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export function writeRecord(dir: string, record: RemoteJoinRecord): void {
  ensureDir(dir);
  writeAtomic(file(dir, record.id, "json"), `${JSON.stringify(record, null, 2)}\n`);
}

/** 读出、改、写回；记录不在时什么都不做 */
export function updateRecord(
  dir: string,
  id: string,
  patch: (record: RemoteJoinRecord) => void,
): RemoteJoinRecord | undefined {
  const record = readRecord(dir, id);
  if (!record) return undefined;
  patch(record);
  writeRecord(dir, record);
  return record;
}

export function writeToken(dir: string, id: string, token: string): void {
  ensureDir(dir);
  writeAtomic(file(dir, id, "token"), token);
}

export function readToken(dir: string, id: string): string | undefined {
  try {
    const token = readFileSync(file(dir, id, "token"), "utf8").trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

export function processAlive(pid: number | null | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export type Liveness = { now?: number; isAlive?: (pid: number) => boolean };

/** 进程还在、心跳没过期 */
export function recordRunning(record: RemoteJoinRecord, options: Liveness = {}): boolean {
  if (!record.pid || record.stoppedAt) return false;
  const now = options.now ?? Date.now();
  const beat = Date.parse(record.updatedAt);
  if (!Number.isFinite(beat) || now - beat > STALE_MS) return false;
  return (options.isAlive ?? processAlive)(record.pid);
}

export function viewOf(record: RemoteJoinRecord, options: Liveness = {}): RemoteJoinView {
  const running = recordRunning(record, options);
  const rooms = Object.entries(record.rooms ?? {}).map(([roomId, connected]) => ({
    roomId,
    connected: running && connected,
  }));
  return {
    id: record.id,
    server: record.server,
    roomId: record.roomId,
    name: record.name,
    runtime: record.runtime,
    access: record.access,
    cwd: record.cwd,
    model: record.model,
    pid: running ? record.pid : null,
    background: record.background,
    status: !running ? "stopped" : rooms.some((room) => room.connected) ? "online" : "connecting",
    rooms,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    stoppedAt: running ? null : (record.stoppedAt ?? record.updatedAt),
    logFile: record.logFile,
    canRestart: Boolean(record.launch),
    lastError: record.lastError,
  };
}

export function listRemoteJoins(dir: string, options: Liveness = {}): RemoteJoinView[] {
  return readRecords(dir).map((record) => viewOf(record, options));
}

/**
 * 按名字或 id（可以只写 id 开头几位）找；同名的有几个时要求写 id。
 * 找不到返回 undefined，有歧义时抛错。
 */
export function findRecord(dir: string, query: string): RemoteJoinRecord | undefined {
  const records = readRecords(dir);
  const lower = query.toLocaleLowerCase();
  const byId = records.filter((record) => record.id.startsWith(lower));
  if (byId.length === 1 && lower.length >= 4) return byId[0];
  const byName = records.filter((record) => record.name.toLocaleLowerCase() === lower);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    throw new Error(
      `有 ${byName.length} 个叫 ${query} 的 Agent（在不同的 Server 或房间），请改用 id：${byName.map((record) => record.id).join("、")}`,
    );
  }
  return undefined;
}

export function requestStop(dir: string, id: string): void {
  ensureDir(dir);
  writeFileSync(file(dir, id, "stop"), new Date().toISOString(), { mode: 0o600 });
}

export function stopRequested(dir: string, id: string): boolean {
  return existsSync(file(dir, id, "stop"));
}

export function clearStopRequest(dir: string, id: string): void {
  rmSync(file(dir, id, "stop"), { force: true });
}

/** 结束进程（及它拉起的子进程）：Windows 用 taskkill /T /F，其他平台 SIGTERM */
export function killTree(pid: number, platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* 已经退出 */
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 让它离线：先写停止请求，等 join 进程自己正常离线退出（会先把手上的连接关掉）；
 * timeoutMs 内没退就强制结束。清单里保留这一条，之后可以重新上线。
 */
export async function stopRemoteJoin(
  dir: string,
  id: string,
  options: {
    timeoutMs?: number;
    isAlive?: (pid: number) => boolean;
    kill?: (pid: number) => void;
  } = {},
): Promise<RemoteJoinRecord | undefined> {
  const record = readRecord(dir, id);
  if (!record) return undefined;
  const isAlive = options.isAlive ?? processAlive;
  const pid = record.pid;
  if (pid && !record.stoppedAt && isAlive(pid)) {
    requestStop(dir, id);
    const deadline = Date.now() + (options.timeoutMs ?? 8_000);
    while (isAlive(pid) && Date.now() < deadline) await sleep(200);
    if (isAlive(pid)) {
      (options.kill ?? killTree)(pid);
      const killDeadline = Date.now() + 3_000;
      while (isAlive(pid) && Date.now() < killDeadline) await sleep(100);
      if (isAlive(pid) && process.platform !== "win32") {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* 已经退出 */
        }
      }
    }
  }
  clearStopRequest(dir, id);
  return updateRecord(dir, id, (current) => {
    // 停的过程中同一条命令又被启动了（pid 变了）：不要把新进程标成已停止
    if (current.pid && current.pid !== pid && !current.stoppedAt) return;
    current.pid = null;
    current.stoppedAt ??= new Date().toISOString();
    for (const roomId of Object.keys(current.rooms)) current.rooms[roomId] = false;
  });
}

/** 从清单里删掉（不管进程，调用前先停） */
export function forgetRemoteJoin(dir: string, id: string): void {
  for (const ext of ["json", "token", "stop", "log"] as const) {
    rmSync(file(dir, id, ext), { force: true });
  }
}

/**
 * 请对方 Server 把这个 Agent 移出房间：用它自己的 token 调 POST /api/guest-agents/leave，
 * 只对访客带入的 Agent 有效（撤销它自己的访客 Agent 会话）。
 */
export async function leaveRemoteRoom(
  server: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ left: true } | { left: false; error: string }> {
  let response: Response;
  try {
    response = await fetchImpl(`${server.replace(/\/+$/, "")}/api/guest-agents/leave`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    return {
      left: false,
      error: `连不上对方 Server：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (response.ok) return { left: true };
  if (response.status === 404) {
    return {
      left: false,
      error:
        "对方 Hive 版本较旧，不支持 Agent 自己退出房间；已离线，需要的话请房主在成员列表里移除",
    };
  }
  let message = `HTTP ${response.status}`;
  try {
    const body = (await response.json()) as { error?: string; message?: string; code?: string };
    message = body.error ?? body.message ?? body.code ?? message;
  } catch {
    /* 不是 JSON */
  }
  if (response.status === 401) {
    // token 已经失效：访客到期或已被移除，本来就不在房间里了
    return { left: true };
  }
  return { left: false, error: message };
}

/**
 * 按记下的启动参数在后台重新拉起（关掉终端也在线）。token 经环境变量传，不出现在进程参数里。
 * 返回新进程号；参数里的可执行文件已经不在（比如 npx 缓存被清了）时抛错。
 */
export async function launchInBackground(
  dir: string,
  input: {
    id: string;
    command: string;
    args: string[];
    cwd: string;
    token: string;
    env?: NodeJS.ProcessEnv;
  },
): Promise<number> {
  ensureDir(dir);
  const logFile = logFileOf(dir, input.id);
  clearStopRequest(dir, input.id);
  const logFd = openSync(logFile, "a", 0o600);
  let launched: ReturnType<typeof spawnBackground>;
  try {
    writeFileSync(logFd, `\n[hive] ${new Date().toISOString()} 后台启动\n`);
    launched = spawnBackground(input.command, input.args, {
      cwd: existsSync(input.cwd) ? input.cwd : homedir(),
      env: {
        ...(input.env ?? process.env),
        HIVE_AGENT_TOKEN: input.token,
        HIVE_REMOTE_JOIN_BACKGROUND: "1",
        HIVE_REMOTE_JOIN_LOG: logFile,
        HIVE_REMOTE_JOINS_DIR: dir,
        // Windows 上在自己的隐藏控制台里运行（不继承调用方的管道，ssh、execFile 不会被拖住），输出由它自己写日志
        ...(process.platform === "win32" ? { HIVE_REMOTE_JOIN_SELF_LOG: "1" } : {}),
      },
      logFd,
      windowsOwnConsole: true,
    });
  } finally {
    closeSync(logFd);
  }
  return launched.pid;
}

/** 重新上线：读记下的启动参数和 token */
export async function restartRemoteJoin(
  dir: string,
  id: string,
  env?: NodeJS.ProcessEnv,
): Promise<number> {
  const record = readRecord(dir, id);
  if (!record) throw new Error("清单里没有这个 Agent");
  if (recordRunning(record)) throw new Error(`${record.name} 已经在运行（进程 ${record.pid}）`);
  const token = readToken(dir, id);
  if (!record.launch || !token)
    throw new Error("没有记下启动参数，请重新运行当初的 hive join 命令");
  const script = record.launch.args.find((arg) => /\.(c|m)?[jt]s$/.test(arg));
  if (script && path.isAbsolute(script) && !existsSync(script)) {
    throw new Error(`当初运行的 superhive 已经不在了（${script}），请重新运行 hive join 命令`);
  }
  return launchInBackground(dir, {
    id,
    command: record.launch.command,
    args: record.launch.args,
    cwd: record.launch.cwd,
    token,
    ...(env ? { env } : {}),
  });
}

/** 等到它连上（online）、进程退出或超时 */
export async function waitForOnline(
  dir: string,
  id: string,
  pid: number,
  timeoutMs = 30_000,
  isAlive: (pid: number) => boolean = processAlive,
): Promise<"online" | "exited" | "timeout"> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const record = readRecord(dir, id);
    if (record?.pid === pid && Object.values(record.rooms).some(Boolean)) return "online";
    if (!isAlive(pid)) return "exited";
    await sleep(300);
  }
  return "timeout";
}

/** 日志最后几行，启动失败时给人看 */
export function logTail(logFile: string | null, lines = 20): string {
  if (!logFile) return "";
  try {
    return readFileSync(logFile, "utf8").trimEnd().split(/\r?\n/).slice(-lines).join("\n");
  } catch {
    return "";
  }
}
