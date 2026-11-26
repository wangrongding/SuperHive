import console from "node:console";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DevError,
  adoptProcess,
  describeProcess,
  listeningPids,
  processCwd,
  publicError,
  readGeneration,
  runCheck,
  startProcess,
  writeStatus,
} from "./dev-process.mjs";
import {
  RESTART_EXIT_CODE,
  SelfReload,
  watchReloadInputs,
  runtimeScripts,
  verifySupervisorImports,
} from "./dev-reload.mjs";
export {
  DevError,
  publicError,
  readGeneration,
  startProcess,
  writeStatus,
} from "./dev-process.mjs";

export const SOURCE_ROOTS = ["apps/server/src", "packages/protocol/src", "packages/superhive/src"];
const CONFIG_FILES = [
  "tsconfig.base.json",
  ...["apps/server", "packages/protocol", "packages/superhive"].map(
    (dir) => `${dir}/tsconfig.json`,
  ),
];
const IGNORED = new Set([
  "node_modules",
  ".git",
  "dist",
  "coverage",
  "data",
  "logs",
  ".superhive-dev",
]);

export function serverRestartDelay(attempt) {
  return [1_000, 2_000, 5_000, 10_000, 30_000][Math.min(Math.max(attempt - 1, 0), 4)];
}

export function isWatchedFile(file) {
  const normalized = file.replaceAll("\\", "/");
  if (normalized.split("/").some((part) => IGNORED.has(part))) return false;
  return (
    CONFIG_FILES.includes(normalized) ||
    SOURCE_ROOTS.some(
      (root) =>
        normalized === root ||
        (normalized.startsWith(`${root}/`) && /\.(?:[cm]?[jt]sx?|json)$/.test(normalized)),
    )
  );
}

/** One owner, one update at a time; edits during a build invalidate its ready notification. */
export class DevSupervisor extends EventEmitter {
  constructor({
    statusPath,
    build,
    startServer,
    debounceMs = 1_500,
    healthTimeoutMs = 30_000,
    handoverPath,
    reclaim,
    restartDelay = serverRestartDelay,
    crashWindowMs = 60_000,
    crashLimit = 5,
  }) {
    super();
    // 手上没有在跑的 Server 时，找回端口上本仓库上一代留下的 Server（supervisor 意外退出后的孤儿），
    // 按换代流程交接后停掉；端口被别的程序占着时抛出说明原因的 DevError
    this.reclaim = reclaim;
    // 换代时写下交接标记：旧 Server 据此把本机 Agent 留给新 Server 接管，而不是一起结束
    this.handoverPath = handoverPath;
    this.statusPath = statusPath;
    this.build = build;
    this.startServer = startServer;
    this.debounceMs = debounceMs;
    this.healthTimeoutMs = healthTimeoutMs;
    this.generation = readGeneration(statusPath);
    this.pending = new Set();
    this.server = undefined;
    this.active = undefined;
    this.timer = undefined;
    this.lastChange = 0;
    this.closed = false;
    this.paused = false;
    this.abort = new globalThis.AbortController();
    this.restartDelay = restartDelay;
    this.crashWindowMs = crashWindowMs;
    this.crashLimit = crashLimit;
    this.crashes = [];
    this.restartAttempt = 0;
    this.recoveryPending = false;
  }

  status(state, changedFiles = [], error, recovery = {}) {
    if (this.closed) return;
    let detail = error ? publicError(error) : undefined;
    if (this.controlFailure) {
      changedFiles = [...new Set([...changedFiles, ...this.controlFailure.files])];
      const retained = this.controlFailure.error;
      if (state === "ready") {
        state = "failed";
        detail = `应用服务已更新并通过健康检查，但开发自更新仍未完成：${retained}`;
      } else {
        if (state === "pending") state = "failed";
        detail =
          detail && detail !== retained ? `${detail}\n开发自更新仍未完成：${retained}` : retained;
      }
    }
    const status = {
      generation: this.generation,
      state,
      updatedAt: new Date().toISOString(),
      changedFiles,
      ...(detail ? { error: detail } : {}),
      ...recovery,
    };
    writeStatus(this.statusPath, status);
    this.emit("status", status);
  }

  changed(files, { immediate = false } = {}) {
    if (this.closed) return;
    for (const file of files) this.pending.add(file);
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    this.crashes = [];
    this.restartAttempt = 0;
    this.recoveryStopped = false;
    this.lastChange = Date.now();
    if (this.paused) return;
    if (!this.active) this.status("pending", [...this.pending].sort());
    this.schedule(immediate ? 0 : this.debounceMs);
  }

  schedule(wait) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.closed || this.paused || this.active || !this.pending.size) return;
      const files = [...this.pending].sort();
      this.pending.clear();
      this.run(() => this.update(files));
    }, wait);
  }

  run(action) {
    this.active = action().finally(() => {
      this.active = undefined;
      if (this.closed || this.paused) return;
      if (this.pending.size) {
        this.status("pending", [...this.pending].sort());
        this.schedule(Math.max(0, this.lastChange + this.debounceMs - Date.now()));
      } else this.scheduleRecovery();
    });
  }

  serverFailed(error) {
    if (this.closed) return;
    const now = Date.now();
    this.crashes = this.crashes.filter((timestamp) => now - timestamp < this.crashWindowMs);
    if (!this.crashes.length) this.restartAttempt = 0;
    this.crashes.push(now);
    this.recoveryPending = true;
    this.recoveryError = error;
    console.error("[dev]", publicError(error));
    if (this.crashes.length >= this.crashLimit) {
      this.recoveryStopped = true;
      this.status(
        "failed",
        this.runtimeFiles,
        new DevError(
          `Hive Server 在 ${this.crashWindowMs / 1_000} 秒内连续失败 ${this.crashes.length} 次，已停止自动重启。最后原因：${publicError(error)}。请查看本机 dev 终端，修正代码后会重新尝试。`,
        ),
        { restartStopped: true },
      );
    } else this.scheduleRecovery();
  }

  scheduleRecovery() {
    if (
      this.closed ||
      this.paused ||
      this.active ||
      this.pending.size ||
      this.server ||
      !this.recoveryPending ||
      this.recoveryStopped ||
      this.recoveryTimer ||
      this.runtimeGeneration === undefined
    )
      return;
    const restartAttempt = this.restartAttempt + 1;
    const restartDelayMs = this.restartDelay(restartAttempt);
    this.status("restarting", this.runtimeFiles, this.recoveryError, {
      restartAttempt,
      restartDelayMs,
    });
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      if (this.closed || this.paused || this.active || this.pending.size) return;
      this.restartAttempt = restartAttempt;
      this.run(() => this.launchServer());
    }, restartDelayMs);
  }

  async launchServer() {
    let server;
    try {
      server = await this.startServer({ generation: this.runtimeGeneration });
      this.server = server;
      this.recoveryPending = false;
      server.exited.then((result) => {
        if (!this.closed && this.server === server) {
          this.server = undefined;
          const reason = result?.signal
            ? `信号 ${result.signal}`
            : `退出码 ${result?.code ?? "未知"}`;
          this.serverFailed(new DevError(`Hive Server 意外退出（${reason}）`));
        }
      });
      await server.ready({ timeoutMs: this.healthTimeoutMs, signal: this.abort.signal });
      if (this.closed || this.server !== server) return;
      if (!this.paused && !this.pending.size) {
        if (this.buildFailure)
          this.status("failed", this.buildFailure.files, this.buildFailure.error);
        else this.status("ready", this.runtimeFiles);
      }
    } catch (error) {
      if (this.closed || (server && this.server !== server)) return;
      this.server = undefined;
      if (server) await this.stopServer(server);
      this.serverFailed(error);
    }
  }

  async update(files) {
    this.generation += 1;
    this.status("building", files);
    let build;
    try {
      build = await this.build({ signal: this.abort.signal });
      if (this.closed || this.paused || this.pending.size) return;
      this.status("restarting", files);
      const previous = this.server ?? (await this.reclaim?.());
      this.server = undefined; // An intentional exit must not be reported as a crash.
      if (previous) await this.stopServer(previous);
      if (this.closed || this.paused || this.pending.size) return;
      await build?.publish?.();
      if (this.closed) return;
      this.runtimeGeneration = this.generation;
      this.runtimeFiles = files;
      this.buildFailure = undefined;
      await this.launchServer();
    } catch (error) {
      if (this.closed) return;
      console.error("[dev]", publicError(error));
      this.buildFailure = { files, error };
      this.status("failed", files, error);
      // A hung/broken replacement must not keep the port. Its local Agents are still handed over:
      // the next good build adopts them; without one they go offline after their 2-minute grace.
      const failedServer = this.server;
      if (failedServer && build) {
        this.server = undefined;
        await this.stopServer(failedServer);
      }
    } finally {
      await build?.dispose?.();
    }
  }

  /** 停掉换代下来的 Server：先写交接标记，它退出时不结束本机 Agent，由下一个 Server 接管 */
  async stopServer(server) {
    this.markHandover(true);
    await server.stop();
  }

  /** 交接标记：true 时写入（Server 只是换代），false 时删除（真正停止，本机 Agent 一起结束） */
  markHandover(handover) {
    if (!this.handoverPath) return;
    try {
      if (handover) {
        fs.mkdirSync(path.dirname(this.handoverPath), { recursive: true });
        fs.writeFileSync(this.handoverPath, `${new Date().toISOString()}\n`, { mode: 0o600 });
      } else fs.rmSync(this.handoverPath, { force: true });
    } catch (error) {
      console.error("[dev] 无法写入 Agent 交接标记：", error);
    }
  }

  setControlFailure(files, error) {
    this.controlFailure = { files: [...files], error: publicError(error) };
    this.status("failed", files, error);
  }

  resume() {
    if (this.closed) return;
    this.paused = false;
    // Preserve the failure notice until the queued build actually starts.
    if (this.pending.size) this.schedule(0);
    else this.scheduleRecovery();
  }

  async pause() {
    this.paused = true;
    clearTimeout(this.timer);
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    await this.active;
  }

  /**
   * preserveStatus：开发 supervisor 自更新，状态留给下一代接着写。
   * handover：Server 退出时把本机 Agent 留给下一个 Server 接管（默认跟 preserveStatus 一致）；
   * 停掉 pnpm dev 时也传 true（见 main），只有明确要连 Agent 一起停时才是 false。
   */
  async close({ preserveStatus = false, handover = preserveStatus } = {}) {
    if (this.closed) return;
    if (!preserveStatus) this.status("failed", [], new DevError("开发 supervisor 已停止。"));
    this.closed = true;
    clearTimeout(this.timer);
    clearTimeout(this.recoveryTimer);
    this.abort.abort();
    await this.active;
    const server = this.server;
    this.server = undefined;
    this.markHandover(handover);
    await server?.stop();
  }
}

/** Build into staging; failed type checks must not publish half-built protocol output. */
export async function buildWorkspace(
  repoRoot,
  { signal, stateDir = path.join(repoRoot, ".superhive-dev") },
) {
  fs.mkdirSync(stateDir, { recursive: true });
  const staging = fs.mkdtempSync(path.join(stateDir, "build-"));
  // Keep generated declarations under their package so imports (e.g. zod) resolve
  // through that package's node_modules, not the workspace root's dependencies.
  const protocolStagingRoot = path.join(repoRoot, "packages/protocol/.superhive-dev");
  fs.mkdirSync(protocolStagingRoot, { recursive: true });
  const protocolOutput = fs.mkdtempSync(path.join(protocolStagingRoot, "build-"));
  const serverStagingRoot = path.join(repoRoot, "apps/server/.superhive-dev");
  fs.mkdirSync(serverStagingRoot, { recursive: true });
  const serverOutput = fs.mkdtempSync(path.join(serverStagingRoot, "build-"));
  const require = createRequire(path.join(repoRoot, "package.json"));
  const tsc = require.resolve("typescript/bin/tsc");
  const dispose = () => {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(protocolOutput, { recursive: true, force: true });
    fs.rmSync(serverOutput, { recursive: true, force: true });
  };
  try {
    await runCheck(
      process.execPath,
      [
        tsc,
        "-p",
        "packages/protocol/tsconfig.json",
        "--outDir",
        protocolOutput,
        "--noEmitOnError",
        "--sourceMap",
        "false",
      ],
      "编译 protocol",
      { cwd: repoRoot, signal },
    );
    for (const pkg of ["apps/server", "packages/superhive"]) {
      const config = path.join(staging, `${path.basename(pkg)}.json`);
      fs.writeFileSync(
        config,
        JSON.stringify({
          extends: path.join(repoRoot, pkg, "tsconfig.json"),
          compilerOptions: {
            noEmit: pkg !== "apps/server",
            ...(pkg === "apps/server" ? { outDir: serverOutput, sourceMap: false } : {}),
            baseUrl: repoRoot,
            paths: { "@superhive/protocol": [path.join(protocolOutput, "index.d.ts")] },
            typeRoots: [
              path.join(repoRoot, pkg, "node_modules/@types"),
              path.join(repoRoot, "node_modules/@types"),
            ],
          },
        }),
      );
      await runCheck(process.execPath, [tsc, "-p", config], `检查 ${pkg}`, {
        cwd: repoRoot,
        signal,
      });
    }
    return {
      publish() {
        const outputs = [
          [protocolOutput, path.join(repoRoot, "packages/protocol/dist")],
          [serverOutput, path.join(serverStagingRoot, "runtime")],
        ];
        const replacements = [];
        try {
          for (const [output, destination] of outputs) {
            const previous = path.join(staging, `previous-${replacements.length}`);
            const hadPrevious = fs.existsSync(destination);
            if (hadPrevious) fs.renameSync(destination, previous);
            replacements.push({ destination, previous, hadPrevious });
            fs.renameSync(output, destination);
          }
        } catch (error) {
          for (const { destination, previous, hadPrevious } of replacements.reverse()) {
            fs.rmSync(destination, { recursive: true, force: true });
            if (hadPrevious) fs.renameSync(previous, destination);
          }
          throw error;
        }
      },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

export async function waitForHealth(url, instanceId, server, { timeoutMs = 30_000, signal }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new DevError("开发更新已停止。");
    if (server.finished) throw new DevError("Hive Server 启动失败；请查看本机 dev 终端。");
    try {
      const response = await globalThis.fetch(url, {
        signal: globalThis.AbortSignal.timeout(1_000),
      });
      const body = await response.json();
      if (response.ok && body.status === "ok" && body.instanceId === instanceId) return;
    } catch {
      /* A server can be unavailable during startup. */
    }
    await delay(100, undefined, { signal });
  }
  throw new DevError(
    "Hive Server 未在期限内通过健康检查；修改代码后会自动重试，请查看本机 dev 终端。",
  );
}

export function watchWorkspace(repoRoot, onChange, onError) {
  const watchers = [];
  const fingerprints = new Map();
  const fingerprint = (file) => {
    try {
      return createHash("sha256")
        .update(fs.readFileSync(path.join(repoRoot, file)))
        .digest("hex");
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "EISDIR") return undefined;
      throw error;
    }
  };
  const sourceFiles = (root) => {
    const files = [];
    const visit = (directory) => {
      if (!fs.existsSync(path.join(repoRoot, directory))) return;
      for (const entry of fs.readdirSync(path.join(repoRoot, directory), { withFileTypes: true })) {
        if (IGNORED.has(entry.name)) continue;
        const file = `${directory}/${entry.name}`;
        if (entry.isDirectory()) visit(file);
        else if (entry.isFile() && isWatchedFile(file)) files.push(file);
      }
    };
    visit(root);
    return files;
  };
  const check = (files) => {
    try {
      const changed = [];
      for (const file of new Set(files)) {
        const next = fingerprint(file);
        if (next === fingerprints.get(file)) continue;
        if (next === undefined) fingerprints.delete(file);
        else fingerprints.set(file, next);
        changed.push(file);
      }
      if (changed.length) onChange(changed);
    } catch (error) {
      onError(error);
    }
  };
  try {
    // Native watchers may replay creation events or deliver duplicate saves. Only
    // content changes invalidate a build; initial files and generated churn do not.
    for (const file of [...SOURCE_ROOTS.flatMap(sourceFiles), ...CONFIG_FILES]) {
      const digest = fingerprint(file);
      if (digest !== undefined) fingerprints.set(file, digest);
    }
    for (const root of SOURCE_ROOTS) {
      const watcher = fs.watch(
        path.join(repoRoot, root),
        { recursive: true },
        (_event, filename) => {
          const file = filename ? `${root}/${filename}`.replaceAll("\\", "/") : root;
          if (file !== root && isWatchedFile(file)) check([file]);
          else if (!file.split("/").some((part) => IGNORED.has(part))) {
            // Directory moves/deletions can arrive without per-file events.
            try {
              check([
                ...sourceFiles(root),
                ...[...fingerprints.keys()].filter((key) => key.startsWith(`${root}/`)),
              ]);
            } catch (error) {
              onError(error);
            }
          }
        },
      );
      watcher.on("error", onError);
      watchers.push(watcher);
    }
    for (const directory of new Set(CONFIG_FILES.map((file) => path.dirname(file)))) {
      const watcher = fs.watch(path.join(repoRoot, directory), (_event, filename) => {
        if (!filename) {
          check(CONFIG_FILES.filter((file) => path.dirname(file) === directory));
          return;
        }
        const file = path.posix.join(directory, String(filename));
        if (CONFIG_FILES.includes(file)) check([file]);
      });
      watcher.on("error", onError);
      watchers.push(watcher);
    }
    // Close the initial scan -> watch registration race while all watchers are active.
    check([...SOURCE_ROOTS.flatMap(sourceFiles), ...CONFIG_FILES]);
  } catch (error) {
    for (const watcher of watchers) watcher.close();
    throw error;
  }
  return () => {
    for (const watcher of watchers) watcher.close();
  };
}

function portAvailable(port, host) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
}

/**
 * 端口上的进程是不是本仓库 dev 起的、并且已经没有 supervisor 在管：父进程是本 supervisor
 * （丢了引用），或者父进程已不是 dev supervisor（上一代意外退出，它被 init 收养）。
 * 另一个还活着的 pnpm dev 管着的进程不算，避免两个 dev 互相抢端口。
 */
async function unmanaged(info) {
  if (info.ppid === process.pid) return true;
  const parent = info.ppid > 1 ? await describeProcess(info.ppid) : undefined;
  return !parent?.command.includes("scripts/dev-supervisor.mjs");
}

/**
 * Server 端口被占时认一认占用者：本仓库上一代留下的 Hive Server 返回可交接的进程，
 * 其他情况抛出说明原因的 DevError，不替人结束别的进程。
 */
export async function findOrphanServer({
  port,
  host,
  healthUrl,
  entry,
  inspect = describeProcess,
  isUnmanaged = unmanaged,
  stopGraceMs,
}) {
  if (await portAvailable(port, host)) return undefined;
  let body;
  try {
    const response = await globalThis.fetch(healthUrl, {
      signal: globalThis.AbortSignal.timeout(2_000),
    });
    body = await response.json();
  } catch {
    /* not an HTTP/Hive listener */
  }
  if (body?.status !== "ok" || !Number.isSafeInteger(body.pid) || body.pid <= 1)
    throw new DevError(
      `端口 ${port} 被其他程序占用（不是 Hive Server）；请先释放端口或换 HIVE_PORT，不会替你结束其他进程。`,
    );
  const info = await inspect(body.pid);
  if (!info?.command.includes(entry))
    throw new DevError(
      `端口 ${port} 被另一个 Hive Server 占用（pid ${body.pid}，不是这个仓库的 pnpm dev 启动的）；请先停掉它或换 HIVE_PORT，不会替你结束其他进程。`,
    );
  if (!(await isUnmanaged(info)))
    throw new DevError(
      `端口 ${port} 上的 Hive Server（pid ${body.pid}）还由另一个 pnpm dev 管着；请先停掉那个 dev 再启动。`,
    );
  const isOwn = async (pid, current) => {
    const next = current ?? (await inspect(pid));
    return Boolean(next?.command.includes(entry));
  };
  return adoptProcess(body.pid, { isOwn, ...(stopGraceMs ? { stopGraceMs } : {}) });
}

/** Web 端口被本仓库上一代留下的 Vite 占着时结束它（它不带状态，直接重起）；其他占用者报原因 */
export async function reclaimWebPort({ port, host, repoRoot, stopGraceMs }) {
  if (await portAvailable(port, host)) return;
  // lsof 给的是真实路径（macOS 的 /var 是 /private/var 的软链）
  const root = fs.realpathSync(repoRoot);
  const isOwn = async (pid, current) => {
    const info = current ?? (await describeProcess(pid));
    const cwd = info && (await processCwd(pid));
    return Boolean(
      info?.command.includes("vite") &&
      info.command.includes(`--port ${port}`) &&
      cwd &&
      (cwd === root || cwd.startsWith(`${root}${path.sep}`)),
    );
  };
  const orphans = [];
  for (const pid of await listeningPids(port)) {
    const info = await describeProcess(pid);
    if (!info || !(await isOwn(pid, info))) continue;
    // vite 的父进程是 pnpm，pnpm（进程组组长）才是 supervisor 直接起的
    const leader = info.pgid === pid ? info : await describeProcess(info.pgid);
    const owner = leader && (await isOwn(info.pgid, leader)) ? leader : info;
    if (!(await unmanaged(owner)))
      throw new DevError(
        `Web 端口 ${port} 上的 Vite（pid ${pid}）还由另一个 pnpm dev 管着；请先停掉那个 dev 再启动。`,
      );
    orphans.push(adoptProcess(pid, { isOwn, ...(stopGraceMs ? { stopGraceMs } : {}) }));
  }
  if (!orphans.length)
    throw new DevError(
      `Web 端口 ${port} 已被占用（不是这个仓库上一次 pnpm dev 留下的 Vite）；请先释放端口或换 HIVE_DEV_WEB_PORT，不会替你结束其他进程。`,
    );
  console.log(
    `[dev] 结束上一次 pnpm dev 留下的 Vite（pid ${orphans.map((o) => o.pid).join(", ")}）`,
  );
  await Promise.all(orphans.map((orphan) => orphan.stop()));
  if (!(await portAvailable(port, host)))
    throw new DevError(`Web 端口 ${port} 仍被占用；请查看本机 dev 终端。`);
}

/** supervisor 被强制结束时来不及清理的编译暂存目录 */
function removeStaleStaging(directories) {
  for (const directory of directories) {
    let entries;
    try {
      entries = fs.readdirSync(directory);
    } catch {
      continue;
    }
    for (const name of entries)
      if (name.startsWith("build-"))
        fs.rmSync(path.join(directory, name), { recursive: true, force: true });
  }
}

export async function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const stateDir = path.join(repoRoot, ".superhive-dev");
  const statusPath = path.join(stateDir, "status.json");
  const host = process.env.HIVE_HOST ?? "0.0.0.0";
  const port = Number(process.env.HIVE_PORT ?? 8787);
  const webPort = Number(process.env.HIVE_DEV_WEB_PORT ?? 5188);
  for (const value of [port, webPort]) {
    if (!Number.isInteger(value) || value < 1 || value > 65535)
      throw new DevError("开发端口必须在 1 到 65535 之间。");
  }
  if (port === webPort) throw new DevError("Web 和 Hive Server 不能使用同一端口。");
  const probeHost = ["0.0.0.0", "::", "localhost"].includes(host) ? "127.0.0.1" : host;
  const formattedHost = probeHost.includes(":") ? `[${probeHost}]` : probeHost;
  const serverEntry = path.join(repoRoot, "apps/server/src/index.ts");
  // 上一代 supervisor 意外退出时 Server 和 Vite 会留下来占着端口：Server 交给第一次换代按交接流程接管
  // （编译通过前它照常服务，本机 Agent 不掉线），Vite 不带状态，直接结束重起
  const reclaim = async () => {
    const orphan = await findOrphanServer({
      port,
      host,
      healthUrl: `http://${formattedHost}:${port}/health`,
      entry: serverEntry,
    });
    if (orphan)
      console.log(
        `[dev] 端口 ${port} 上是上一代留下的 Hive Server（pid ${orphan.pid}），换代时交接接管`,
      );
    return orphan;
  };
  await reclaim();
  await reclaimWebPort({ port: webPort, host: "0.0.0.0", repoRoot });
  removeStaleStaging([
    stateDir,
    path.join(repoRoot, "packages/protocol/.superhive-dev"),
    path.join(repoRoot, "apps/server/.superhive-dev"),
  ]);
  const handoverPath = path.join(stateDir, "agent-handover");
  const supervisor = new DevSupervisor({
    statusPath,
    handoverPath,
    reclaim,
    build: ({ signal }) => buildWorkspace(repoRoot, { signal, stateDir }),
    startServer: () => {
      const instanceId = randomUUID();
      const shutdownToken = randomUUID();
      const server = startProcess(
        process.execPath,
        // --import 要的是 URL：Windows 上 C:\... 这样的路径会被当成 c: 协议报错
        [
          "--import",
          pathToFileURL(path.join(repoRoot, "scripts/dev-server-runtime.mjs")).href,
          serverEntry,
        ],
        {
          cwd: path.join(repoRoot, "apps/server"),
          env: {
            ...process.env,
            HIVE_INSTANCE_ID: instanceId,
            // 飞书卡片上的网页链接要指向 Vite 的端口
            HIVE_DEV_WEB_PORT: String(webPort),
            HIVE_HANDOVER_FILE: handoverPath,
            HIVE_SHUTDOWN_TOKEN: shutdownToken,
            HIVE_DEV_SERVER_SOURCE: path.join(repoRoot, "apps/server/src"),
            HIVE_DEV_SERVER_OUTPUT: path.join(repoRoot, "apps/server/.superhive-dev/runtime"),
          },
          // Windows：请 Server 自己退出，它才会写交接、让本机 Agent 继续运行由新 Server 接管
          gracefulStop: () =>
            globalThis
              .fetch(`http://${formattedHost}:${port}/api/local/shutdown`, {
                method: "POST",
                headers: { "x-hive-shutdown": shutdownToken },
                signal: globalThis.AbortSignal.timeout(3_000),
              })
              .then((response) => response.ok),
        },
      );
      server.ready = (options) =>
        waitForHealth(`http://${formattedHost}:${port}/health`, instanceId, server, options);
      return server;
    },
  });
  // Windows 上的 pnpm.cmd 由 startProcess 解析成 node + pnpm.cjs 直接运行
  const pnpm = "pnpm";
  let web;
  let stopWatching;
  let reloadWatcher;
  let reloader;
  let closing;
  // 停掉 pnpm dev（Ctrl+C、关掉终端、Vite 退出）也按交接退出：本机 Agent 接着跑手上的任务，
  // 重新 pnpm dev 后新 Server 按 pid 接管、回复照常送达；一直没有新 Server 时 Agent 宽限期（2 分钟）后自己离线。
  // 要连本机 Agent 一起停，用 HIVE_DEV_KEEP_AGENTS=0 启动
  const keepAgents = !["0", "false", "off"].includes(
    process.env.HIVE_DEV_KEEP_AGENTS?.trim().toLowerCase() ?? "",
  );
  const close = ({ restarting = false } = {}) => {
    closing ??= (async () => {
      stopWatching?.();
      reloadWatcher?.close();
      await Promise.all([
        reloader?.stop({ wait: !restarting }),
        supervisor.close({ preserveStatus: restarting, handover: restarting || keepAgents }),
      ]);
      await web?.stop();
    })();
    return closing;
  };
  reloader = new SelfReload({
    supervisor,
    install: ({ signal }) =>
      runCheck(
        pnpm,
        ["install", "--no-frozen-lockfile", "--prefer-offline", "--prod=false"],
        "安装依赖 pnpm install",
        {
          cwd: repoRoot,
          signal,
          timeoutMs: 180_000,
          env: { ...process.env, CI: "1" },
        },
      ),
    checkScripts: async ({ signal }) => {
      let manifest;
      try {
        manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
      } catch {
        throw new DevError("根 package.json 无法读取或解析；已保留现有开发进程。");
      }
      if (manifest.scripts?.dev !== "node scripts/dev.mjs") {
        throw new DevError(
          "自动更新要求保留 dev 入口 node scripts/dev.mjs；如需更换入口，请在终端手动切换。",
        );
      }
      for (const file of [...runtimeScripts(repoRoot), "scripts/dev.mjs"]) {
        await runCheck(process.execPath, ["--check", file], `检查 ${file}`, {
          cwd: repoRoot,
          signal,
        });
      }
      await verifySupervisorImports(repoRoot, { signal });
    },
    acknowledgeInstallLock: () => reloadWatcher?.acknowledgeInstallLock(),
    refreshInputs: () => reloadWatcher?.poll(),
    restart: async (changedFiles) => {
      if (!process.env.HIVE_DEV_LAUNCHER_PID)
        throw new DevError("请先通过新版 pnpm dev 启动开发启动器，才能自动更新 supervisor。");
      writeStatus(path.join(stateDir, "restart-request.json"), { changedFiles });
      await close({ restarting: true });
      process.exitCode = RESTART_EXIT_CODE;
    },
  });
  // 关掉终端后再往终端写会报 EIO：别让它打断收尾（交接标记、停 Server、停 Vite）
  for (const stream of [process.stdout, process.stderr]) stream.on("error", () => {});
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
    process.on(signal, () => {
      if (closing) return;
      console.log(
        keepAgents
          ? "[dev] 正在停止。本机 Agent 继续运行：2 分钟内重新 pnpm dev 会接管，手上的任务不中断；否则它们自己离线。要连 Agent 一起停，用 HIVE_DEV_KEEP_AGENTS=0 pnpm dev 启动。"
          : "[dev] 正在停止，本机 Agent 一起离线（HIVE_DEV_KEEP_AGENTS=0）。",
      );
      void close();
    });
  try {
    stopWatching = watchWorkspace(
      repoRoot,
      (files) => supervisor.changed(files),
      () => {
        supervisor.status(
          "failed",
          [],
          new DevError("源码监听失败，请在本机终端重新启动 pnpm dev。"),
        );
      },
    );
    reloadWatcher = watchReloadInputs(
      repoRoot,
      (files) => reloader.changed(files),
      () => {
        supervisor.status("failed", [], new DevError("开发启动配置监听失败；请检查本机目录权限。"));
      },
    );
    let initialFiles = ["initial-start"];
    const requestPath = path.join(stateDir, "restart-request.json");
    try {
      const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
      if (Array.isArray(request.changedFiles))
        initialFiles = request.changedFiles.filter((file) => typeof file === "string").slice(0, 50);
      fs.rmSync(requestPath, { force: true });
    } catch {
      /* ordinary startup */
    }
    supervisor.changed(initialFiles, { immediate: true });
    web = startProcess(
      pnpm,
      [
        "--filter",
        "@superhive/web",
        "exec",
        "vite",
        "--host",
        "0.0.0.0",
        "--port",
        String(webPort),
        "--strictPort",
      ],
      {
        cwd: repoRoot,
        env: process.env,
      },
    );
    console.log(
      `[dev] 自动更新已启用；Web http://localhost:${webPort}，Server ${port}。按 Ctrl+C 停止。`,
    );
    await web.exited;
    if (!closing) {
      console.error("[dev] Vite 已退出；请查看本机终端并重新运行 pnpm dev。");
      process.exitCode = 1;
    }
    await close();
  } catch (error) {
    await close();
    throw error;
  }
}

if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
) {
  main().catch((error) => {
    console.error("[dev]", publicError(error));
    console.error(error); // Local terminal only; never copied to the public status document.
    process.exitCode = 1;
  });
}
