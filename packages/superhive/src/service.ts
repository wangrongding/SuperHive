import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { DOCS_URL } from "./docs-url.js";
import { superhiveHome } from "./home-dir.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { sqliteLoadError, sqliteMissingMessage } from "./server-deps.js";
import { spawnBackground } from "./background-process.js";
import {
  askBusyChoice,
  handoverBlocker,
  readLocalAgents,
  waitForIdle,
  type LocalAgentSnapshot,
} from "./restart-handover.js";

type ServiceStartOptions = {
  host: string;
  port: number;
  publicUrl?: string;
  /** 仅在关闭时记录 false，restart 时沿用 */
  localAgents?: false;
};

export type ServiceState = {
  pid: number;
  instanceId: string;
  healthUrl: string;
  publicUrl: string;
  dataDir: string;
  logPath: string;
  startedAt: string;
  startOptions?: ServiceStartOptions;
  /** 请 Server 正常退出用的口令（POST /api/local/shutdown）；Windows 上没有 SIGTERM 可用 */
  shutdownToken?: string;
};

const startUsage = `
用法：
  hive start [选项]

选项：
  --host ADDRESS     监听地址（默认 0.0.0.0）
  --port PORT        监听端口（默认 8787）
  --data-dir PATH    数据、PID 和日志目录（默认 ~/.superhive）
  --public-url URL   对外访问地址；反向代理或多网卡时使用
  --token TOKEN      固定 Join Token；默认首次启动时自动生成
  --no-local-agents  关闭网页上的"在本机启动 Agent"
  --foreground       在前台运行，不启动后台进程
  --no-open          启动后不自动用默认浏览器打开网页
`;

const stopUsage = `
用法：
  hive stop [--data-dir PATH]
`;

const restartUsage = `
用法：
  hive restart [选项]

说明：
  默认沿用上次启动时的 host、port 和 public-url；显式传入的选项会覆盖原配置。
  本机 Agent 不下线：旧 Server 把它们交给新 Server 接管，正在跑的任务继续做完，回复照常送达。
  交接不了时（正在运行的是旧版 Server、换了端口或 Join Token、关掉本机 Agent），有 Agent 正在干活
  就先问你：等它们做完再重启，还是立即重启（中断任务）；不在终端里运行时等它们做完。

选项：
  --host ADDRESS     监听地址
  --port PORT        监听端口
  --data-dir PATH    数据、PID 和日志目录（默认 ~/.superhive）
  --public-url URL   对外访问地址
  --token TOKEN      更新固定 Join Token
  --no-local-agents  关闭网页上的"在本机启动 Agent"
  --local-agents     重新开启网页上的"在本机启动 Agent"
  --open             重启后用默认浏览器打开网页（默认不打开，已开着的页面刷新即可）
  --foreground       重启后在前台运行
  --wait             交接不了时不问，等本机 Agent 手上的任务做完再重启（最多 30 分钟）
  --force            交接不了时不问也不等，立即重启（会中断正在跑的任务）
`;

function pathsFor(dataDir?: string): {
  dataDir: string;
  statePath: string;
  databasePath: string;
  logPath: string;
} {
  const resolved = path.resolve(dataDir ?? superhiveHome());
  return {
    dataDir: resolved,
    statePath: path.join(resolved, "server.json"),
    databasePath: path.join(resolved, "hive.sqlite"),
    logPath: path.join(resolved, "server.log"),
  };
}

function readState(statePath: string): ServiceState | undefined {
  try {
    const value = JSON.parse(readFileSync(statePath, "utf8")) as Partial<ServiceState>;
    if (
      typeof value.pid !== "number" ||
      !Number.isSafeInteger(value.pid) ||
      typeof value.instanceId !== "string" ||
      typeof value.healthUrl !== "string" ||
      typeof value.publicUrl !== "string" ||
      typeof value.dataDir !== "string" ||
      typeof value.logPath !== "string" ||
      typeof value.startedAt !== "string"
    ) {
      return undefined;
    }
    const rawStartOptions = value.startOptions as Partial<ServiceStartOptions> | undefined;
    const startOptions =
      rawStartOptions &&
      typeof rawStartOptions.host === "string" &&
      typeof rawStartOptions.port === "number" &&
      Number.isSafeInteger(rawStartOptions.port) &&
      rawStartOptions.port >= 1 &&
      rawStartOptions.port <= 65_535 &&
      (rawStartOptions.publicUrl === undefined || typeof rawStartOptions.publicUrl === "string")
        ? {
            host: rawStartOptions.host,
            port: rawStartOptions.port,
            ...(rawStartOptions.publicUrl ? { publicUrl: rawStartOptions.publicUrl } : {}),
            ...(rawStartOptions.localAgents === false ? { localAgents: false as const } : {}),
          }
        : undefined;
    return {
      pid: value.pid,
      instanceId: value.instanceId,
      healthUrl: value.healthUrl,
      publicUrl: value.publicUrl,
      dataDir: value.dataDir,
      logPath: value.logPath,
      startedAt: value.startedAt,
      ...(startOptions ? { startOptions } : {}),
      ...(typeof value.shutdownToken === "string" ? { shutdownToken: value.shutdownToken } : {}),
    };
  } catch {
    return undefined;
  }
}

export function readServiceState(dataDir: string): ServiceState | undefined {
  return readState(pathsFor(dataDir).statePath);
}

function writeState(statePath: string, state: ServiceState): void {
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function healthMatches(url: string, instanceId: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    if (!response.ok) return false;
    const payload = (await response.json()) as { status?: string; instanceId?: string };
    return payload.status === "ok" && payload.instanceId === instanceId;
  } catch {
    return false;
  }
}

async function waitUntilReady(healthUrl: string, instanceId: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await healthMatches(healthUrl, instanceId)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Server 未能在 15 秒内启动，请查看日志。");
}

async function fetchPublicUrl(healthUrl: string, fallback: string): Promise<string> {
  try {
    const response = await fetch(new URL("/api/meta", healthUrl));
    if (!response.ok) return fallback;
    const payload = (await response.json()) as { httpUrl?: string };
    return payload.httpUrl ?? fallback;
  } catch {
    return fallback;
  }
}

function printStarted(state: ServiceState, alreadyRunning = false): void {
  const defaultDataDir = pathsFor().dataDir;
  const dataDirArgument =
    state.dataDir === defaultDataDir ? "" : ` --data-dir ${shellQuote(state.dataDir)}`;
  const restartCommand = `npx superhive restart${dataDirArgument}`;
  const stopCommand =
    state.dataDir === defaultDataDir
      ? "npx superhive stop"
      : `npx superhive stop${dataDirArgument}`;
  console.log(`[hive] ${alreadyRunning ? "服务已经在运行" : "服务已启动"}（PID ${state.pid}）`);
  console.log(`[hive] Web UI：${state.publicUrl}`);
  console.log(`[hive] 日志：${state.logPath}`);
  console.log(`[hive] 重启：${restartCommand}`);
  console.log(`[hive] 停止：${stopCommand}`);
  console.log(`[hive] 文档：${DOCS_URL}`);
}

/**
 * 用默认浏览器打开网页。打开的是本机地址（127.0.0.1）：在 Server 所在电脑上打开才是房主身份。
 * 没有图形界面（SSH、CI、Linux 无显示）或设置了 BROWSER=none / HIVE_NO_OPEN 时不打开；打不开也不影响启动。
 */
export function openBrowser(url: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CI || env.HIVE_NO_OPEN || env.BROWSER === "none") return false;
  let command: string;
  let args: string[];
  if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else if (process.platform === "win32") {
    command = "cmd";
    args = ["/c", "start", '""', url];
  } else {
    if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
    command = "xdg-open";
    args = [url];
  }
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function openWebUi(state: ServiceState, enabled: boolean): void {
  if (!enabled) return;
  const local = new URL(state.healthUrl).origin;
  if (openBrowser(local))
    console.log(`[hive] 已在默认浏览器打开 ${local}（不想自动打开可加 --no-open）`);
}

export async function startService(args = process.argv.slice(3)): Promise<void> {
  const parsed = parseArgs({
    args,
    options: {
      host: { type: "string", default: "0.0.0.0" },
      port: { type: "string", default: "8787" },
      "data-dir": { type: "string" },
      "public-url": { type: "string" },
      token: { type: "string" },
      "no-local-agents": { type: "boolean", default: false },
      foreground: { type: "boolean", default: false },
      "no-open": { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
  });
  if (parsed.values.help) {
    console.log(startUsage);
    return;
  }
  const open = !parsed.values["no-open"];

  const port = Number.parseInt(parsed.values.port, 10);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`端口无效：${parsed.values.port}`);
  }
  if (parsed.values["public-url"]) new URL(parsed.values["public-url"]);

  const servicePaths = pathsFor(parsed.values["data-dir"]);
  mkdirSync(servicePaths.dataDir, { recursive: true, mode: 0o700 });
  const existing = readState(servicePaths.statePath);
  if (
    existing &&
    processExists(existing.pid) &&
    (await healthMatches(existing.healthUrl, existing.instanceId))
  ) {
    printStarted(existing, true);
    openWebUi(existing, open);
    return;
  }
  rmSync(servicePaths.statePath, { force: true });

  const serverEntry = fileURLToPath(new URL("./server/index.js", import.meta.url));
  const staticDir = fileURLToPath(new URL("../web", import.meta.url));
  if (!existsSync(serverEntry) || !existsSync(path.join(staticDir, "index.html"))) {
    throw new Error(
      "当前安装包缺少 Server 或 Web UI 构建产物。仓库开发请使用 pnpm dev；发布前请重新构建 npm 包。",
    );
  }

  const sqliteError = sqliteLoadError();
  if (sqliteError) throw new Error(sqliteMissingMessage(sqliteError));

  const instanceId = randomUUID();
  const probeHost =
    parsed.values.host === "0.0.0.0"
      ? "127.0.0.1"
      : parsed.values.host === "::"
        ? "::1"
        : parsed.values.host;
  const formattedProbeHost = probeHost.includes(":") ? `[${probeHost}]` : probeHost;
  const healthUrl = `http://${formattedProbeHost}:${port}/health`;
  const fallbackPublicUrl = parsed.values["public-url"] ?? new URL(healthUrl).origin;
  const shutdownToken = randomUUID();
  const serverEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HIVE_HOST: parsed.values.host,
    HIVE_PORT: String(port),
    HIVE_DATABASE: servicePaths.databasePath,
    HIVE_STATIC_DIR: staticDir,
    HIVE_INSTANCE_ID: instanceId,
    HIVE_SHUTDOWN_TOKEN: shutdownToken,
    HIVE_SERVICE_MODE: parsed.values.foreground ? "foreground" : "background",
    ...(parsed.values["public-url"] ? { HIVE_PUBLIC_URL: parsed.values["public-url"] } : {}),
    ...(parsed.values.token ? { HIVE_TOKEN: parsed.values.token } : {}),
    ...(parsed.values["no-local-agents"] ? { HIVE_LOCAL_AGENTS: "0" } : {}),
  };

  if (parsed.values.foreground) {
    Object.assign(process.env, serverEnv);
    const state: ServiceState = {
      pid: process.pid,
      instanceId,
      shutdownToken,
      healthUrl,
      publicUrl: fallbackPublicUrl,
      dataDir: servicePaths.dataDir,
      logPath: "标准输出（前台运行）",
      startedAt: new Date().toISOString(),
      startOptions: {
        host: parsed.values.host,
        port,
        ...(parsed.values["public-url"] ? { publicUrl: parsed.values["public-url"] } : {}),
        ...(parsed.values["no-local-agents"] ? { localAgents: false as const } : {}),
      },
    };
    writeState(servicePaths.statePath, state);
    const cleanup = () => rmSync(servicePaths.statePath, { force: true });
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
    await import(new URL("./server/index.js", import.meta.url).href);
    await waitUntilReady(healthUrl, instanceId);
    state.publicUrl = await fetchPublicUrl(healthUrl, fallbackPublicUrl);
    writeState(servicePaths.statePath, state);
    printStarted(state);
    openWebUi(state, open);
    return;
  }

  const logFd = openSync(servicePaths.logPath, "a", 0o600);
  let launched: ReturnType<typeof spawnBackground>;
  try {
    // 后台常驻：CLI 退出后 Server 照样运行；Windows 上给它一个看不见的控制台，它再拉起的命令不会弹窗
    launched = spawnBackground(process.execPath, [serverEntry], { env: serverEnv, logFd });
  } finally {
    closeSync(logFd);
  }
  let serverPid: number;
  try {
    serverPid = await launched.pid;
  } catch (error) {
    throw new Error(
      `无法创建 Hive Server 后台进程：${(error as Error).message}。日志：${servicePaths.logPath}`,
    );
  }
  const exitError = (detail: string) => new Error(`Server 进程提前退出（${detail}）。`);
  const childExited = new Promise<void>((_resolve, reject) => {
    const child = launched.child;
    if (child) {
      child.once("exit", (code, signal) =>
        reject(exitError(signal ?? `exit ${code ?? "unknown"}`)),
      );
      return;
    }
    // Windows 上 Server 由 PowerShell 代为拉起，拿不到退出事件，只能轮询
    const poll = setInterval(() => {
      if (processExists(serverPid)) return;
      clearInterval(poll);
      reject(exitError("exit unknown"));
    }, 500);
    poll.unref();
  });
  childExited.catch(() => undefined);

  const state: ServiceState = {
    pid: serverPid,
    instanceId,
    healthUrl,
    shutdownToken,
    publicUrl: fallbackPublicUrl,
    dataDir: servicePaths.dataDir,
    logPath: servicePaths.logPath,
    startedAt: new Date().toISOString(),
    startOptions: {
      host: parsed.values.host,
      port,
      ...(parsed.values["public-url"] ? { publicUrl: parsed.values["public-url"] } : {}),
      ...(parsed.values["no-local-agents"] ? { localAgents: false as const } : {}),
    },
  };
  writeState(servicePaths.statePath, state);
  try {
    await Promise.race([waitUntilReady(healthUrl, instanceId), childExited]);
  } catch (error) {
    if (processExists(serverPid)) process.kill(serverPid, "SIGTERM");
    rmSync(servicePaths.statePath, { force: true });
    throw new Error(`${(error as Error).message}日志：${servicePaths.logPath}`);
  }
  state.publicUrl = await fetchPublicUrl(healthUrl, fallbackPublicUrl);
  writeState(servicePaths.statePath, state);
  printStarted(state);
  openWebUi(state, open);
}

export async function stopService(args = process.argv.slice(3)): Promise<void> {
  const parsed = parseArgs({
    args,
    options: {
      "data-dir": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (parsed.values.help) {
    console.log(stopUsage);
    return;
  }

  const servicePaths = pathsFor(parsed.values["data-dir"]);
  const state = readState(servicePaths.statePath);
  if (!state) {
    console.log("[hive] 没有找到正在运行的 Hive Server。");
    return;
  }
  if (!processExists(state.pid)) {
    rmSync(servicePaths.statePath, { force: true });
    console.log("[hive] Hive Server 已经停止，已清理过期状态。");
    return;
  }
  if (!(await healthMatches(state.healthUrl, state.instanceId))) {
    throw new Error(`PID ${state.pid} 与记录的 Hive 实例不匹配，为避免停止其他进程，已拒绝操作。`);
  }

  await stopRunning(servicePaths, state);
}

/**
 * 请正在运行的 Server 退出。handover 时请它把本机 Agent 交给下一个 Server（不结束进程），
 * 返回 Server 是否答应了交接。
 */
async function stopRunning(
  servicePaths: ReturnType<typeof pathsFor>,
  state: ServiceState,
  options: { handover?: boolean } = {},
): Promise<{ handedOver: boolean }> {
  // 先请 Server 自己退出（让本机 Agent 正常下线、IM 断开）；Windows 上信号就是强制结束，只能这样
  let handedOver = false;
  const asked = state.shutdownToken
    ? await fetch(new URL("/api/local/shutdown", state.healthUrl), {
        method: "POST",
        headers: {
          "x-hive-shutdown": state.shutdownToken,
          ...(options.handover ? { "content-type": "application/json" } : {}),
        },
        ...(options.handover ? { body: JSON.stringify({ handover: true }) } : {}),
        signal: AbortSignal.timeout(3_000),
      }).then(
        async (response) => {
          if (!response.ok) return false;
          const payload = (await response.json().catch(() => ({}))) as { handover?: unknown };
          handedOver = payload.handover === true;
          return true;
        },
        () => false,
      )
    : false;
  if (!asked) process.kill(state.pid, "SIGTERM");
  const deadline = Date.now() + (asked ? 10_000 : 5_000);
  while (processExists(state.pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (processExists(state.pid)) process.kill(state.pid, "SIGKILL");
  rmSync(servicePaths.statePath, { force: true });
  console.log(`[hive] 已停止 Hive Server（PID ${state.pid}）。`);
  return { handedOver };
}

/** 由 hive start 启动的 Server 是否还在运行（只看记录的进程在不在，不做健康检查） */
export function serviceRunning(dataDir?: string): boolean {
  const state = readState(pathsFor(dataDir).statePath);
  return Boolean(state && processExists(state.pid));
}

/** 上次 hive start 的启动参数（host、port、public-url、是否关闭本机 Agent），给开机自启沿用 */
export function savedStartArgs(dataDir?: string): string[] {
  const servicePaths = pathsFor(dataDir);
  const options = optionsFromLegacyState(readState(servicePaths.statePath));
  const args: string[] = [];
  if (options && options.host !== "0.0.0.0") args.push("--host", options.host);
  if (options && options.port !== 8787) args.push("--port", String(options.port));
  if (options?.publicUrl) args.push("--public-url", options.publicUrl);
  if (options?.localAgents === false) args.push("--no-local-agents");
  if (dataDir) args.push("--data-dir", servicePaths.dataDir);
  return args;
}

function optionsFromLegacyState(state: ServiceState | undefined): ServiceStartOptions | undefined {
  if (!state) return undefined;
  if (state.startOptions) return state.startOptions;
  try {
    const port = Number.parseInt(new URL(state.healthUrl).port, 10);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return undefined;
    return { host: "0.0.0.0", port };
  } catch {
    return undefined;
  }
}

export async function restartService(args = process.argv.slice(3)): Promise<void> {
  const parsed = parseArgs({
    args,
    options: {
      host: { type: "string" },
      port: { type: "string" },
      "data-dir": { type: "string" },
      "public-url": { type: "string" },
      token: { type: "string" },
      "no-local-agents": { type: "boolean" },
      "local-agents": { type: "boolean" },
      foreground: { type: "boolean", default: false },
      open: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      wait: { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
  });
  if (parsed.values.help) {
    console.log(restartUsage);
    return;
  }

  const servicePaths = pathsFor(parsed.values["data-dir"]);
  const previousOptions = optionsFromLegacyState(readState(servicePaths.statePath));
  const host = parsed.values.host ?? previousOptions?.host ?? "0.0.0.0";
  const port = parsed.values.port ?? String(previousOptions?.port ?? 8787);
  const publicUrl = parsed.values["public-url"] ?? previousOptions?.publicUrl;
  const startArgs = ["--host", host, "--port", port];
  if (parsed.values["data-dir"]) startArgs.push("--data-dir", parsed.values["data-dir"]);
  if (publicUrl) startArgs.push("--public-url", publicUrl);
  if (parsed.values.token) startArgs.push("--token", parsed.values.token);
  const localAgentsOff = parsed.values["local-agents"]
    ? false
    : (parsed.values["no-local-agents"] ?? previousOptions?.localAgents === false);
  if (localAgentsOff) startArgs.push("--no-local-agents");
  if (parsed.values.foreground) startArgs.push("--foreground");
  // 重启时网页多半已经开着（刷新即可），默认不再新开一个标签页
  if (!parsed.values.open) startArgs.push("--no-open");

  const state = readState(servicePaths.statePath);
  const running =
    state && processExists(state.pid) && (await healthMatches(state.healthUrl, state.instanceId));
  if (!state || !running) {
    await stopService(parsed.values["data-dir"] ? ["--data-dir", parsed.values["data-dir"]] : []);
    console.log("[hive] 正在启动 Hive Server…");
    await startService(startArgs);
    return;
  }

  // 能交接就交接：本机 Agent 不下线，正在跑的任务继续，由新 Server 接管
  const before = readLocalAgents(servicePaths.databasePath);
  const blocker = handoverBlocker({
    serverSupports: await healthSupportsHandover(state.healthUrl),
    canAskShutdown: Boolean(state.shutdownToken),
    previous: {
      host: previousOptions?.host ?? "0.0.0.0",
      port: previousOptions?.port ?? 8787,
      localAgentsOff: previousOptions?.localAgents === false,
    },
    next: { host, port: Number.parseInt(port, 10), localAgentsOff },
    tokenChanged: Boolean(parsed.values.token),
  });
  // 能交接就总是请求交接：Server 没开本机 Agent 时会忽略，读不到数据库也不影响
  const handover = !blocker;
  if (blocker && !parsed.values.force) {
    const proceed = await confirmInterruption(servicePaths.databasePath, blocker, {
      wait: Boolean(parsed.values.wait),
    });
    if (!proceed) {
      console.log("[hive] 已取消，Hive Server 没有重启。");
      return;
    }
  }

  const { handedOver } = await stopRunning(servicePaths, state, { handover });
  if (handover && !handedOver)
    console.warn("[hive] Server 没有接受交接，本机 Agent 已随旧 Server 下线，重启后会重新拉起。");
  console.log("[hive] 正在重新启动 Hive Server…");
  await startService(startArgs);
  if (handedOver && before) reportHandover(servicePaths.databasePath, before);
}

/** 新版 Server 的 /health 带 handover: true，表示能把本机 Agent 交给下一个 Server */
export async function healthSupportsHandover(healthUrl: string): Promise<boolean> {
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1_500) });
    if (!response.ok) return false;
    return ((await response.json()) as { handover?: unknown }).handover === true;
  } catch {
    return false;
  }
}

/** 交接不了：没人在忙就直接重启；有人在忙时，终端里让用户选，非终端（脚本）等它们空闲 */
async function confirmInterruption(
  databasePath: string,
  reason: string,
  options: { wait: boolean },
): Promise<boolean> {
  const snapshot = readLocalAgents(databasePath);
  if (!snapshot) {
    console.warn(
      `[hive] ${reason}；看不到本机 Agent 是否在忙，重启会让它们下线，进行中的任务会被中断。`,
    );
    return true;
  }
  if (snapshot.busy.length === 0) {
    if (snapshot.running.length > 0)
      console.log(`[hive] ${reason}；本机 Agent 都空闲，重启后会重新拉起。`);
    return true;
  }
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const choice = options.wait || !interactive ? "wait" : await askBusyChoice(snapshot.busy, reason);
  if (choice === "cancel") return false;
  if (choice === "now") return true;
  if (!interactive || options.wait)
    console.log(`[hive] ${reason}；${snapshot.busy.join("、")} 正在干活，等它们做完再重启。`);
  const still = await waitForIdle(() => readLocalAgents(databasePath)?.busy, {
    timeoutMs: WAIT_IDLE_TIMEOUT_MS,
  });
  if (still.length > 0) {
    throw new Error(
      `等了 ${WAIT_IDLE_TIMEOUT_MS / 60_000} 分钟，${still.join("、")} 还在忙，没有重启。确定要中断它们就运行 hive restart --force。`,
    );
  }
  console.log("[hive] 本机 Agent 都空闲了，开始重启。");
  return true;
}

/** 等忙的 Agent 空闲最多这么久 */
const WAIT_IDLE_TIMEOUT_MS = 30 * 60_000;

/** 新 Server 起来时已按进程号接管：进程号没变的就是接上了 */
function reportHandover(databasePath: string, before: LocalAgentSnapshot): void {
  const after = readLocalAgents(databasePath);
  if (!after) return;
  const pids = new Map(after.running.map((agent) => [agent.name, agent.pid]));
  const kept = before.running.filter((agent) => pids.get(agent.name) === agent.pid);
  const relaunched = before.running.length - kept.length;
  const busy = before.busy.filter((name) => kept.some((agent) => agent.name === name));
  console.log(
    `[hive] ${kept.length} 个本机 Agent 已由新 Server 接管，没有下线` +
      (busy.length ? `；${busy.join("、")} 手上的任务继续执行，回复照常送达` : "") +
      (relaunched ? `；另有 ${relaunched} 个没接上，已重新拉起` : "") +
      "。",
  );
  console.log("[hive] 它们跑的还是旧版本代码，空闲后会自动重启换成新版本（设置里可关自动更新）。");
}

/**
 * 给用户复制的命令里的路径加引号。不能用 JSON.stringify：它会把 Windows 路径的 \ 写成 \\，
 * 照抄到 PowerShell / cmd 里就是错的路径。
 */
export function shellQuote(value: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    return /^[\w@+=:,./\\-]+$/.test(value) ? value : `"${value.replace(/"/g, '""')}"`;
  }
  if (/^[\w@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
