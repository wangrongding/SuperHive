import { execFile, spawn } from "node:child_process";
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

/**
 * Windows: npm/pnpm 的 .cmd 垫片不能直接 spawn（ENOENT / EINVAL），经 cmd.exe 又会改写参数。
 * 读出垫片真正运行的目标：.exe 直接运行，.js 用 node 运行。与 packages/superhive/src/windows-command.ts 同一做法。
 */
export function resolveWindowsCommand(command, args, env = process.env) {
  if (process.platform !== "win32") return { command, args };
  const pick = (name) => Object.entries(env).find(([key]) => key.toLowerCase() === name)?.[1];
  const extensions = (pick("pathext") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const isFile = (file) => {
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  };
  const bases = /[\\/]/.test(command)
    ? [command]
    : (pick("path") ?? "")
        .split(";")
        .filter(Boolean)
        .map((dir) => path.win32.join(dir, command));
  let found;
  for (const base of bases) {
    found = [base, ...extensions.map((ext) => base + ext)].find(
      (file) => path.win32.extname(file) && isFile(file),
    );
    if (found) break;
  }
  if (!found || !/\.(cmd|bat)$/i.test(found)) return { command: found ?? command, args };
  const target = [...fs.readFileSync(found, "utf8").matchAll(/"%~?dp0%?\\([^"]+)"/gi)].at(-1)?.[1];
  if (!target) throw new DevError(`无法直接运行 ${found}；请确认它是 npm / pnpm 生成的启动脚本。`);
  const resolved = path.win32.join(path.win32.dirname(found), target);
  return /\.(c|m)?js$/i.test(resolved)
    ? { command: process.execPath, args: [resolved, ...args] }
    : { command: resolved, args };
}

/**
 * Start in a private process group, never signal arbitrary pnpm/node processes.
 * gracefulStop：Windows 上没有 SIGTERM，先用它请进程自己退出（例如 Server 的关闭接口），
 * 宽限期过后再结束整棵进程树。
 */
export function startProcess(
  command,
  args,
  { stopGraceMs = 12_000, gracefulStop, ...options } = {},
) {
  const resolved = resolveWindowsCommand(command, args, options.env ?? process.env);
  const child = spawn(resolved.command, resolved.args, {
    stdio: "inherit",
    detached: process.platform !== "win32",
    windowsHide: true,
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
      // Windows：child.kill 只结束直接子进程（例如 pnpm），孙进程（vite、server）会留下占着端口
      if (process.platform === "win32") {
        if (!finished)
          execFile(
            "taskkill",
            ["/PID", String(child.pid), "/T", "/F"],
            { windowsHide: true },
            () => {},
          );
      } else process.kill(-child.pid, signal);
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
        const asked =
          process.platform === "win32" && gracefulStop
            ? await gracefulStop().then(
                (ok) => ok === true,
                () => false,
              )
            : false;
        if (!asked) signalTree("SIGTERM");
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
