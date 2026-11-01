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
  }) {
    super();
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
  }

  status(state, changedFiles = [], error) {
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
    };
    writeStatus(this.statusPath, status);
    this.emit("status", status);
  }

  changed(files, { immediate = false } = {}) {
    if (this.closed) return;
    for (const file of files) this.pending.add(file);
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
      this.active = this.update(files).finally(() => {
        this.active = undefined;
        if (!this.closed && !this.paused && this.pending.size) {
          this.status("pending", [...this.pending].sort());
          this.schedule(Math.max(0, this.lastChange + this.debounceMs - Date.now()));
        }
      });
    }, wait);
  }

  async update(files) {
    this.generation += 1;
    this.status("building", files);
    let build;
    try {
      build = await this.build({ signal: this.abort.signal });
      if (this.closed || this.paused || this.pending.size) return;
      this.status("restarting", files);
      const previous = this.server;
      this.server = undefined; // An intentional exit must not be reported as a crash.
      if (previous) this.markHandover(true);
      await previous?.stop();
      if (this.closed || this.paused || this.pending.size) return;
      await build?.publish?.();
      if (this.closed) return;
      const server = await this.startServer({ generation: this.generation });
      this.server = server;
      server.exited.then(() => {
        if (!this.closed && this.server === server) {
          this.server = undefined;
          this.status(
            "failed",
            files,
            new DevError("Hive Server 已退出；修改代码后会自动重试，请查看本机 dev 终端。"),
          );
        }
      });
      await server.ready({ timeoutMs: this.healthTimeoutMs, signal: this.abort.signal });
      if (this.closed) return;
      if (this.server !== server)
        throw new DevError("Hive Server 在就绪前退出；修改代码后会自动重试。");
      if (!this.paused && !this.pending.size) this.status("ready", files);
    } catch (error) {
      if (this.closed) return;
      console.error("[dev]", publicError(error));
      this.status("failed", files, error);
      // A hung/broken replacement must not keep the port or its managed Agents alive.
      const failedServer = this.server;
      if (failedServer && build) {
        this.server = undefined;
        await failedServer.stop();
      }
    } finally {
      await build?.dispose?.();
    }
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
  }

  async pause() {
    this.paused = true;
    clearTimeout(this.timer);
    await this.active;
  }

  async close({ preserveStatus = false } = {}) {
    if (this.closed) return;
    if (!preserveStatus) this.status("failed", [], new DevError("开发 supervisor 已停止。"));
    this.closed = true;
    clearTimeout(this.timer);
    this.abort.abort();
    await this.active;
    const server = this.server;
    this.server = undefined;
    // 开发 supervisor 自更新（preserveStatus）时 Server 也只是换代；Ctrl+C 才让本机 Agent 一起结束
    this.markHandover(preserveStatus);
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
  const require = createRequire(path.join(repoRoot, "package.json"));
  const tsc = require.resolve("typescript/bin/tsc");
  const dispose = () => {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(protocolOutput, { recursive: true, force: true });
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
            noEmit: true,
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
        const destination = path.join(repoRoot, "packages/protocol/dist");
        const previous = path.join(staging, "previous-protocol");
        if (fs.existsSync(destination)) fs.renameSync(destination, previous);
        try {
          fs.renameSync(protocolOutput, destination);
        } catch (error) {
          if (fs.existsSync(previous)) fs.renameSync(previous, destination);
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
    if (server.finished)
      throw new DevError("Hive Server 启动失败；修改代码后会自动重试，请查看本机 dev 终端。");
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

async function assertPortAvailable(port, host) {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", () =>
      reject(
        new DevError(`端口 ${port} 已被占用；请先停止旧 dev 实例再启动，不会替你结束其他进程。`),
      ),
    );
    probe.listen(port, host, () => probe.close(resolve));
  });
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
  await assertPortAvailable(port, host);
  await assertPortAvailable(webPort, "0.0.0.0");
  const require = createRequire(path.join(repoRoot, "apps/server/package.json"));
  const handoverPath = path.join(stateDir, "agent-handover");
  const supervisor = new DevSupervisor({
    statusPath,
    handoverPath,
    build: ({ signal }) => buildWorkspace(repoRoot, { signal, stateDir }),
    startServer: () => {
      const instanceId = randomUUID();
      const shutdownToken = randomUUID();
      const probeHost = ["0.0.0.0", "::", "localhost"].includes(host) ? "127.0.0.1" : host;
      const formattedHost = probeHost.includes(":") ? `[${probeHost}]` : probeHost;
      const server = startProcess(
        process.execPath,
        // --import 要的是 URL：Windows 上 C:\... 这样的路径会被当成 c: 协议报错
        [
          "--import",
          pathToFileURL(require.resolve("tsx")).href,
          path.join(repoRoot, "apps/server/src/index.ts"),
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
  const close = ({ restarting = false } = {}) => {
    closing ??= (async () => {
      stopWatching?.();
      reloadWatcher?.close();
      await Promise.all([
        reloader?.stop({ wait: !restarting }),
        supervisor.close({ preserveStatus: restarting }),
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
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => {
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
