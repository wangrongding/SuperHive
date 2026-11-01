import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { superhiveHome } from "./home-dir.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

type ServiceStartOptions = {
  host: string;
  port: number;
  publicUrl?: string;
  /** 仅在关闭时记录 false，restart 时沿用 */
  localAgents?: false;
};

type ServiceState = {
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

选项：
  --host ADDRESS     监听地址
  --port PORT        监听端口
  --data-dir PATH    数据、PID 和日志目录（默认 ~/.superhive）
  --public-url URL   对外访问地址
  --token TOKEN      更新固定 Join Token
  --no-local-agents  关闭网页上的"在本机启动 Agent"
  --local-agents     重新开启网页上的"在本机启动 Agent"
  --foreground       重启后在前台运行
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
      help: { type: "boolean", short: "h" },
    },
  });
  if (parsed.values.help) {
    console.log(startUsage);
    return;
  }

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
    return;
  }

  const logFd = openSync(servicePaths.logPath, "a", 0o600);
  const child = spawn(process.execPath, [serverEntry], {
    detached: true,
    env: serverEnv,
    stdio: ["ignore", logFd, logFd],
  });
  closeSync(logFd);
  if (!child.pid) throw new Error("无法创建 Hive Server 后台进程。");
  const childExited = new Promise<void>((_resolve, reject) => {
    child.once("exit", (code, signal) => {
      reject(new Error(`Server 进程提前退出（${signal ?? `exit ${code ?? "unknown"}`}）。`));
    });
  });
  child.unref();

  const state: ServiceState = {
    pid: child.pid,
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
    if (processExists(child.pid)) process.kill(child.pid, "SIGTERM");
    rmSync(servicePaths.statePath, { force: true });
    throw new Error(`${(error as Error).message}日志：${servicePaths.logPath}`);
  }
  state.publicUrl = await fetchPublicUrl(healthUrl, fallbackPublicUrl);
  writeState(servicePaths.statePath, state);
  printStarted(state);
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

  // 先请 Server 自己退出（让本机 Agent 正常下线、IM 断开）；Windows 上信号就是强制结束，只能这样
  const asked = state.shutdownToken
    ? await fetch(new URL("/api/local/shutdown", state.healthUrl), {
        method: "POST",
        headers: { "x-hive-shutdown": state.shutdownToken },
        signal: AbortSignal.timeout(3_000),
      }).then(
        (response) => response.ok,
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

  await stopService(parsed.values["data-dir"] ? ["--data-dir", parsed.values["data-dir"]] : []);
  console.log("[hive] 正在重新启动 Hive Server…");
  await startService(startArgs);
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
