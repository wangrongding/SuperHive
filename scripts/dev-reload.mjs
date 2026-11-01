import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { clearInterval, clearTimeout, setInterval, setTimeout } from "node:timers";
import { publicError, runCheck } from "./dev-process.mjs";

export const RESTART_EXIT_CODE = 75;
export const DEPENDENCY_ROOT_FILES = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"];
const IGNORED = new Set([
  "node_modules",
  ".git",
  "dist",
  "coverage",
  "data",
  "logs",
  ".superhive-dev",
]);

function collect(repoRoot, directory, accept) {
  const result = [];
  const visit = (relative) => {
    if (!fs.existsSync(path.join(repoRoot, relative))) return;
    for (const entry of fs.readdirSync(path.join(repoRoot, relative), { withFileTypes: true })) {
      if (IGNORED.has(entry.name)) continue;
      const file = `${relative}/${entry.name}`;
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && accept(file)) result.push(file);
    }
  };
  visit(directory);
  return result;
}

export function runtimeScripts(repoRoot) {
  return collect(
    repoRoot,
    "scripts",
    (file) =>
      file !== "scripts/dev.mjs" &&
      /\.[cm]?js$/.test(file) &&
      !/\.(test|smoke)\.[cm]?js$/.test(file),
  );
}

export function requiresInstall(file) {
  return DEPENDENCY_ROOT_FILES.includes(file) || file.endsWith("/package.json");
}

export function fileDigest(repoRoot, file) {
  try {
    return createHash("sha256")
      .update(fs.readFileSync(path.join(repoRoot, file)))
      .digest("hex");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

export function reloadSnapshot(repoRoot) {
  const files = [
    ...DEPENDENCY_ROOT_FILES,
    ...runtimeScripts(repoRoot),
    ...["apps", "packages"].flatMap((dir) =>
      collect(repoRoot, dir, (file) => file.endsWith("/package.json")),
    ),
  ];
  return new Map(files.map((file) => [file, fileDigest(repoRoot, file)]));
}

export function changedInputs(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((file) => before.get(file) !== after.get(file))
    .sort();
}

/** Polling content hashes also handles atomic replacement, new packages and imported helpers. */
export function watchReloadInputs(repoRoot, onChange, onError, { intervalMs = 500 } = {}) {
  let baseline = reloadSnapshot(repoRoot);
  const poll = () => {
    try {
      const next = reloadSnapshot(repoRoot);
      const changed = changedInputs(baseline, next);
      baseline = next;
      if (changed.length) onChange(changed);
    } catch (error) {
      onError(error);
    }
  };
  const timer = setInterval(poll, intervalMs);
  return {
    poll,
    acknowledgeInstallLock() {
      baseline.set("pnpm-lock.yaml", fileDigest(repoRoot, "pnpm-lock.yaml"));
    },
    close() {
      clearInterval(timer);
    },
  };
}

/** Validate ESM links/evaluation in an owned child; --eval leaves argv[1] unset. */
export async function verifySupervisorImports(repoRoot, { signal, timeoutMs = 10_000 }) {
  const url = pathToFileURL(path.join(repoRoot, "scripts/dev-supervisor.mjs")).href;
  await runCheck(
    process.execPath,
    ["--input-type=module", "--eval", `await import(${JSON.stringify(url)});`],
    "检查 supervisor 模块加载",
    { cwd: repoRoot, signal, timeoutMs },
  );
}

/** Dependency installation and supervisor handoff never overlap application builds. */
export class SelfReload {
  constructor({
    supervisor,
    install,
    checkScripts,
    restart,
    acknowledgeInstallLock,
    refreshInputs = () => {},
    debounceMs = 1_500,
  }) {
    Object.assign(this, {
      supervisor,
      install,
      checkScripts,
      restart,
      acknowledgeInstallLock,
      refreshInputs,
      debounceMs,
    });
    this.pending = new Set();
    this.installDirty = false;
    this.dependencyRevision = 0;
    this.installing = false;
    this.closed = false;
    this.abort = new globalThis.AbortController();
  }

  changed(files) {
    if (this.closed) return;
    const accepted = files.filter((file) => !(this.installing && file === "pnpm-lock.yaml"));
    if (!accepted.length) return;
    for (const file of accepted) this.pending.add(file);
    if (accepted.some(requiresInstall)) {
      this.installDirty = true;
      this.dependencyRevision += 1;
    }
    this.lastChange = Date.now();
    // Stop scheduling source rebuilds immediately, but let an in-flight check settle.
    void this.supervisor.pause();
    if (!this.active) this.supervisor.status("pending", [...this.pending].sort());
    this.schedule(this.debounceMs);
  }

  schedule(wait) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.closed || this.active || !this.pending.size) return;
      const files = [...this.pending].sort();
      this.pending.clear();
      this.active = this.update(files).finally(() => {
        this.active = undefined;
        if (!this.closed && this.pending.size)
          this.schedule(Math.max(0, this.lastChange + this.debounceMs - Date.now()));
      });
    }, wait);
  }

  async update(files) {
    let handedOff = false;
    try {
      await this.supervisor.pause();
      if (this.closed) return;
      this.supervisor.status("building", files);
      if (this.installDirty) {
        const revision = this.dependencyRevision;
        this.installing = true;
        try {
          await this.install({ signal: this.abort.signal });
          if (this.dependencyRevision === revision) this.installDirty = false;
        } finally {
          // pnpm owns lockfile writes while it runs. Do not swallow package/script edits.
          try {
            this.acknowledgeInstallLock();
          } finally {
            this.installing = false;
          }
          this.refreshInputs();
        }
      }
      if (this.closed || this.pending.size) return;
      await this.checkScripts({ signal: this.abort.signal });
      this.refreshInputs();
      if (this.closed || this.pending.size) return;
      this.supervisor.status("restarting", files);
      await this.restart(files);
      handedOff = true;
    } catch (error) {
      if (!this.closed) this.supervisor.setControlFailure(files, error);
      // No timed retry or crash loop: another real edit schedules the next attempt.
      this.lastError = publicError(error);
    } finally {
      // Keep ownership only when a newer control update is queued or handoff won.
      // A failed install/check must not permanently disable ordinary source updates.
      if (!this.closed && !handedOff && !this.pending.size) this.supervisor.resume();
    }
  }

  stop({ wait = true } = {}) {
    this.closed = true;
    clearTimeout(this.timer);
    this.abort.abort();
    return wait ? this.active : undefined;
  }
}
