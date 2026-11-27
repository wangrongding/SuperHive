import { spawn } from "node:child_process";
import {
  closeSync,
  constants,
  accessSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { spawnBackground } from "./background-process.js";
import {
  healthSupportsHandover,
  readServiceState,
  shellQuote,
  type ServiceState,
} from "./service.js";
import { handoverBlocker, readLocalAgents, waitForIdle } from "./restart-handover.js";
import {
  CHECK_CACHE_MS,
  checkLatest,
  detectInstall,
  refreshLatest,
  upgradeCommand,
} from "./update.js";

type Blocker = "source" | "npx" | "desktop" | "permissions" | "external" | "installer";
type Context = { packageRoot: string; version: string; dataDir: string; serverPid: number };
type Job = {
  id: string;
  target: string;
  previous: string;
  phase: "installing" | "waiting" | "restarting" | "rolling_back" | "completed" | "failed";
  startedAt: number;
  updatedAt: number;
  workerPid?: number;
  error?: string;
  rolledBack?: boolean;
};

export function updateBlocker(options: {
  install: ReturnType<typeof detectInstall>;
  managed: boolean;
  writable: boolean;
  desktop: boolean;
  external: boolean;
}): Blocker | null {
  if (options.desktop) return "desktop";
  if (options.install.kind === "source") return "source";
  if (options.install.kind === "npx") return "npx";
  if (options.install.kind !== "npm") return "installer";
  if (!options.managed || options.external) return "external";
  if (!options.writable) return "permissions";
  return null;
}

export function updateJobFile(dataDir: string): string {
  return path.join(dataDir, "web-update.json");
}

export function webRestartArgs(state: ServiceState, dataDir: string, choice?: string): string[] {
  const options = state.startOptions;
  const healthUrl = new URL(state.healthUrl);
  const port =
    options?.port ?? Number(healthUrl.port || (healthUrl.protocol === "https:" ? 443 : 80));
  return [
    "restart",
    "--data-dir",
    dataDir,
    "--host",
    options?.host ?? healthUrl.hostname,
    "--port",
    String(port),
    ...(options?.publicUrl ? ["--public-url", options.publicUrl] : []),
    options?.localAgents === false ? "--no-local-agents" : "--local-agents",
    choice === "now" ? "--force" : "--wait",
  ];
}

export function readUpdateJob(dataDir: string): Job | null {
  try {
    return JSON.parse(readFileSync(updateJobFile(dataDir), "utf8")) as Job;
  } catch {
    return null;
  }
}

function saveJob(dataDir: string, job: Job) {
  job.updatedAt = Date.now();
  const file = updateJobFile(dataDir);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(job)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

function writableDirectory(directory: string): boolean {
  try {
    accessSync(directory, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function releaseNotes(version: string, dataDir: string) {
  const file = path.join(dataDir, "update-notes.json");
  let notes: string[] = [];
  try {
    const cached = JSON.parse(readFileSync(file, "utf8")) as {
      version: string;
      checkedAt: number;
      notes: string[];
    };
    if (cached.version === version && Date.now() - cached.checkedAt < CHECK_CACHE_MS)
      return cached.notes;
  } catch {
    notes = [];
  }
  try {
    const response = await fetch(
      `https://api.github.com/repos/wangrongding/SuperHive/releases/tags/v${version}`,
      { signal: AbortSignal.timeout(1_500), headers: { accept: "application/vnd.github+json" } },
    );
    if (response.ok) {
      const release = (await response.json()) as { body?: unknown };
      if (typeof release.body === "string")
        notes = release.body
          .split("\n")
          .filter((line) => /^\s*[-*]\s+/.test(line))
          .map((line) =>
            line
              .replace(/^\s*[-*]\s+/, "")
              .replace(/[*`]/g, "")
              .slice(0, 300),
          )
          .slice(0, 6);
    }
  } catch {
    notes = [];
  }
  try {
    writeFileSync(file, JSON.stringify({ version, checkedAt: Date.now(), notes }), { mode: 0o600 });
  } catch {
    return notes;
  }
  return notes;
}

export async function inspectWebUpdate(context: Context, options: { refresh?: boolean } = {}) {
  const install = detectInstall(context.packageRoot);
  const state = readServiceState(context.dataDir);
  const managed = Boolean(
    process.env.HIVE_SERVICE_MODE === "background" &&
    state?.pid === context.serverPid &&
    state.instanceId === process.env.HIVE_INSTANCE_ID &&
    state.shutdownToken &&
    state.shutdownToken === process.env.HIVE_SHUTDOWN_TOKEN,
  );
  const blocker = updateBlocker({
    install,
    managed,
    writable: writableDirectory(path.dirname(context.packageRoot)),
    desktop: Boolean(process.versions.electron || process.env.HIVE_DESKTOP),
    external: Boolean(
      process.env.INVOCATION_ID ||
      process.env.NOTIFY_SOCKET ||
      process.env.PM2_HOME ||
      process.env.LAUNCH_JOB_LABEL ||
      process.env.SUPERVISOR_ENABLED,
    ),
  });
  const cacheFile = path.join(context.dataDir, "update-check.json");
  // 网页点「检查更新」时绕开缓存马上查；没查到要告诉网页，不能当成「已是最新」
  const checked = options.refresh
    ? await refreshLatest(context.version, { file: cacheFile })
    : { latest: await checkLatest(context.version, { file: cacheFile }), failed: false };
  const latest = checked.latest;
  const canHandover = Boolean(
    managed &&
    state &&
    !handoverBlocker({
      serverSupports: await healthSupportsHandover(state.healthUrl),
      canAskShutdown: Boolean(state.shutdownToken),
      previous: {
        host: state.startOptions?.host ?? "0.0.0.0",
        port: state.startOptions?.port ?? 8787,
        localAgentsOff: state.startOptions?.localAgents === false,
      },
      next: {
        host: state.startOptions?.host ?? "0.0.0.0",
        port: state.startOptions?.port ?? 8787,
        localAgentsOff: state.startOptions?.localAgents === false,
      },
      tokenChanged: false,
    }),
  );
  const dataArg = ` --data-dir ${shellQuote(context.dataDir)}`;
  return {
    current: context.version,
    latest: latest ?? null,
    notes: latest ? await releaseNotes(latest, context.dataDir) : [],
    releaseUrl: latest ? `https://github.com/wangrongding/SuperHive/releases/tag/v${latest}` : null,
    canUpdate: blocker === null,
    blocker,
    manualCommand:
      install.kind === "source"
        ? "git pull && pnpm build"
        : install.kind === "npx"
          ? `npx superhive@latest restart${dataArg}`
          : blocker === "external"
            ? `${upgradeCommand(install)?.display ?? "npm install -g superhive@latest"}\n# Restart with your service manager`
            : `hive update${dataArg}`,
    busyAgents: readLocalAgents(path.join(context.dataDir, "hive.sqlite"))?.busy ?? [],
    canHandover,
    ...(checked.failed ? { checkFailed: true } : {}),
  };
}

async function runChecked(file: string, args: string[], timeoutMs = 15 * 60_000, logFd?: number) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(file, args, {
      stdio: ["ignore", logFd ?? "inherit", logFd ?? "inherit"],
      windowsHide: true,
      shell: process.platform === "win32" && /\.cmd$/i.test(file),
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Update command timed out"));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Update command failed (exit ${code ?? "signal"})`));
    });
  });
}

export async function replaceAndRestart(options: {
  packageRoot: string;
  candidate: string;
  backup: string;
  restart: () => Promise<void>;
  rollbackRestart: () => Promise<void>;
  phase: (phase: Job["phase"]) => void;
}): Promise<void> {
  renameSync(options.packageRoot, options.backup);
  try {
    renameSync(options.candidate, options.packageRoot);
  } catch (error) {
    renameSync(options.backup, options.packageRoot);
    throw error;
  }
  try {
    options.phase("restarting");
    await options.restart();
  } catch (error) {
    options.phase("rolling_back");
    const rejected = `${options.backup}.rejected`;
    renameSync(options.packageRoot, rejected);
    renameSync(options.backup, options.packageRoot);
    try {
      await options.rollbackRestart();
    } finally {
      rmSync(rejected, { recursive: true, force: true });
    }
    throw error;
  }
  rmSync(options.backup, { recursive: true, force: true });
}

async function performUpdate(context: Context, job: Job, choice: string | undefined) {
  const lock = path.join(context.dataDir, "web-update.lock");
  const logFd = openSync(path.join(context.dataDir, "web-update.log"), "a", 0o600);
  let staging: string | undefined;
  const phase = (value: Job["phase"]) => {
    job.phase = value;
    saveJob(context.dataDir, job);
  };
  try {
    const originalState = readServiceState(context.dataDir);
    if (!originalState) throw new Error("The original Server configuration is missing");
    const restartArgs = webRestartArgs(originalState, context.dataDir, choice);
    job.workerPid = process.pid;
    saveJob(context.dataDir, job);
    const info = await inspectWebUpdate(context);
    if (!info.canUpdate || info.latest !== job.target)
      throw new Error("Update eligibility changed; check the version again");
    staging = mkdtempSync(path.join(path.dirname(context.packageRoot), ".superhive-update-"));
    const command = upgradeCommand({ kind: "npm", prefix: staging }, { version: job.target })!;
    const npmCli = path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
    await runChecked(
      existsSync(npmCli) ? process.execPath : command.file,
      [...(existsSync(npmCli) ? [npmCli] : []), ...command.args, "--no-audit", "--no-fund"],
      15 * 60_000,
      logFd,
    );
    const candidate = path.join(
      staging,
      process.platform === "win32" ? "node_modules/superhive" : "lib/node_modules/superhive",
    );
    const cli = path.join(candidate, "dist/cli.js");
    const candidatePackage = JSON.parse(
      readFileSync(path.join(candidate, "package.json"), "utf8"),
    ) as { name?: string; version?: string };
    if (candidatePackage.name !== "superhive" || candidatePackage.version !== job.target)
      throw new Error("The downloaded package does not match the confirmed version");
    if (
      !existsSync(path.join(candidate, "dist/server/index.js")) ||
      !existsSync(path.join(candidate, "web/index.html"))
    )
      throw new Error("The downloaded package is missing Server or web files");
    await runChecked(process.execPath, [cli, "--version"], 30_000, logFd);
    const checkNative = `const require = (await import('node:module')).createRequire(${JSON.stringify(path.join(candidate, "package.json"))}); const Database = require('better-sqlite3'); const database = new Database(':memory:'); database.close();`;
    await runChecked(
      process.execPath,
      ["--input-type=module", "--eval", checkNative],
      30_000,
      logFd,
    );
    const fresh = await inspectWebUpdate(context);
    if (!fresh.canUpdate) throw new Error("The Server is no longer managed by Hive");
    if (!fresh.canHandover && fresh.busyAgents.length && choice !== "now") {
      if (choice !== "wait") throw new Error("Busy Agents require confirmation");
      phase("waiting");
      const remaining = await waitForIdle(
        () => readLocalAgents(path.join(context.dataDir, "hive.sqlite"))?.busy,
        { timeoutMs: 30 * 60_000, log: (line) => writeSync(logFd, `${line}\n`) },
      );
      if (remaining.length)
        throw new Error("Agents are still busy; the old Server has not been restarted");
    }
    const restart = async (expectedVersion: string) => {
      await runChecked(
        process.execPath,
        [path.join(context.packageRoot, "dist/cli.js"), ...restartArgs],
        35 * 60_000,
        logFd,
      );
      const state = readServiceState(context.dataDir);
      if (!state) throw new Error("The restarted Server did not save its state");
      const response = await fetch(state.healthUrl, { signal: AbortSignal.timeout(5_000) });
      const health = (await response.json()) as { version?: string; instanceId?: string };
      if (
        !response.ok ||
        health.version !== expectedVersion ||
        health.instanceId !== state.instanceId
      )
        throw new Error("The restarted Server did not confirm the expected version");
    };
    await replaceAndRestart({
      packageRoot: context.packageRoot,
      candidate,
      backup: `${staging}.backup`,
      restart: () => restart(job.target),
      rollbackRestart: async () => {
        await restart(job.previous);
        job.rolledBack = true;
      },
      phase,
    });
    phase("completed");
  } catch (error) {
    job.error = error instanceof Error ? error.message : "Update failed";
    phase("failed");
  } finally {
    closeSync(logFd);
    if (staging) rmSync(staging, { recursive: true, force: true });
    if (existsSync(lock) && readFileSync(lock, "utf8") === job.id) rmSync(lock, { force: true });
  }
}

export async function webUpdateCommand(
  args: string[],
  base: { packageRoot: string; version: string },
) {
  const parsed = parseArgs({
    args,
    options: {
      "data-dir": { type: "string" },
      "server-pid": { type: "string" },
      launch: { type: "boolean" },
      run: { type: "boolean" },
      target: { type: "string" },
      choice: { type: "string" },
      refresh: { type: "boolean" },
    },
  });
  if (!parsed.values["data-dir"] || !/^\d+$/.test(parsed.values["server-pid"] ?? ""))
    throw new Error("Missing managed Server context");
  const context: Context = {
    ...base,
    dataDir: path.resolve(parsed.values["data-dir"]),
    serverPid: Number(parsed.values["server-pid"]),
  };
  mkdirSync(context.dataDir, { recursive: true });
  if (parsed.values.run) {
    const job = readUpdateJob(context.dataDir);
    if (!job || readFileSync(path.join(context.dataDir, "web-update.lock"), "utf8") !== job.id)
      throw new Error("Update job is no longer active");
    await performUpdate(context, job, parsed.values.choice);
    return;
  }
  const info = await inspectWebUpdate(context, {
    refresh: Boolean(parsed.values.refresh && !parsed.values.launch),
  });
  if (!parsed.values.launch) {
    console.log(JSON.stringify(info));
    return;
  }
  if (!info.canUpdate || !info.latest || info.latest !== parsed.values.target)
    throw new Error("Update eligibility or version changed");
  if (
    !info.canHandover &&
    info.busyAgents.length &&
    !["wait", "now"].includes(parsed.values.choice ?? "")
  )
    throw new Error("Busy Agents require confirmation");
  const job: Job = {
    id: randomUUID(),
    target: info.latest,
    previous: info.current,
    phase: "installing",
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
  const lock = path.join(context.dataDir, "web-update.lock");
  const lockFd = openSync(lock, "wx", 0o600);
  writeFileSync(lockFd, job.id);
  closeSync(lockFd);
  saveJob(context.dataDir, job);
  const logFd = openSync(path.join(context.dataDir, "web-update.log"), "a", 0o600);
  try {
    const worker = spawnBackground(
      process.execPath,
      [
        process.argv[1]!,
        "web-update",
        "--run",
        "--data-dir",
        context.dataDir,
        "--server-pid",
        String(context.serverPid),
        ...(parsed.values.choice ? ["--choice", parsed.values.choice] : []),
      ],
      { logFd, windowsOwnConsole: true },
    );
    job.workerPid = await worker.pid;
    saveJob(context.dataDir, job);
    console.log(JSON.stringify(job));
  } catch (error) {
    job.error = "Could not start the update worker";
    job.phase = "failed";
    saveJob(context.dataDir, job);
    rmSync(lock, { force: true });
    throw error;
  } finally {
    closeSync(logFd);
  }
}
