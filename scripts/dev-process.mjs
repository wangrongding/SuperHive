import { spawn } from "node:child_process";
import console from "node:console";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";

/** The web plugin watches the parent directory, so atomic rename is observable. */
export function writeStatus(statusPath, status) {
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  const temporary = `${statusPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, statusPath);
}

export function readGeneration(statusPath) {
  try {
    const { generation } = JSON.parse(fs.readFileSync(statusPath, "utf8"));
    return Number.isSafeInteger(generation) && generation >= 0 ? generation : 0;
  } catch {
    return 0;
  }
}

/** Error summaries reach a public development page. Never copy raw subprocess output there. */
export function publicError(error) {
  return error instanceof DevError ? error.message : "开发更新失败；请查看本机 dev 终端。";
}

export class DevError extends Error {}

/** Start in a private process group, never signal arbitrary pnpm/node processes. */
export function startProcess(command, args, { stopGraceMs = 12_000, ...options } = {}) {
  const child = spawn(command, args, {
    stdio: "inherit",
    detached: process.platform !== "win32",
    ...options,
  });
  let finished = false;
  let spawnError;
  const exited = new Promise((resolve) => {
    child.once("error", (error) => {
      spawnError = error;
      finished = true;
      resolve({ code: null, signal: null });
    });
    child.once("exit", (code, signal) => {
      finished = true;
      resolve({ code, signal });
    });
  });
  function signalTree(signal) {
    if (!child.pid) return;
    try {
      if (process.platform === "win32") child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  let stopping;
  return {
    child,
    exited,
    get finished() {
      return finished;
    },
    get spawnError() {
      return spawnError;
    },
    stop() {
      stopping ??= (async () => {
        signalTree("SIGTERM");
        const timeout = setTimeout(() => signalTree("SIGKILL"), stopGraceMs);
        try {
          await exited;
        } finally {
          clearTimeout(timeout);
        }
        // The process may have died before collecting its non-detached children.
        try {
          signalTree("SIGKILL");
        } catch (error) {
          // Darwin can report EPERM for a reparented/zombie-only group after its
          // leader exits. TERM was already delivered; never escalate privileges.
          // Permission failures while the leader is alive still fail normally.
          if (error.code !== "EPERM") throw error;
        }
      })();
      return stopping;
    },
  };
}

export async function runCheck(command, args, label, { cwd, signal, env, timeoutMs }) {
  if (signal.aborted) throw new DevError("开发更新已停止。");
  console.log(`[dev] ${label}`);
  const task = startProcess(command, args, { cwd, ...(env ? { env } : {}) });
  const cancel = () => {
    void task.stop();
  };
  signal.addEventListener("abort", cancel, { once: true });
  const timeout = timeoutMs ? setTimeout(cancel, timeoutMs) : undefined;
  try {
    const result = await task.exited;
    if (signal.aborted || task.spawnError || result.code !== 0) {
      throw new DevError(`${label}失败；未切换运行版本，详细诊断见本机 dev 终端。`);
    }
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", cancel);
  }
}
