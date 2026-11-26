import { openSync, writeSync } from "node:fs";

/**
 * Windows 上后台运行的 join 在自己的隐藏控制台里（见 background-process.ts 的 windowsOwnConsole），
 * 标准输出和标准错误去了看不见的控制台：由进程自己把它们追加写进日志文件。
 * 返回是否接管了输出。
 */
export function redirectOutputToLog(
  env: NodeJS.ProcessEnv = process.env,
  streams: { stdout: NodeJS.WriteStream; stderr: NodeJS.WriteStream } = process,
): boolean {
  const logFile = env.HIVE_REMOTE_JOIN_LOG;
  if (env.HIVE_REMOTE_JOIN_SELF_LOG !== "1" || !logFile) return false;
  delete env.HIVE_REMOTE_JOIN_SELF_LOG;
  let fd: number;
  try {
    fd = openSync(logFile, "a", 0o600);
  } catch {
    return false;
  }
  for (const stream of [streams.stdout, streams.stderr]) {
    stream.write = ((chunk: string | Uint8Array, encoding?: unknown, callback?: unknown) => {
      try {
        if (typeof chunk === "string") writeSync(fd, chunk);
        else writeSync(fd, chunk);
      } catch {
        /* 日志写不进去不影响 Agent 工作 */
      }
      const done = typeof encoding === "function" ? encoding : callback;
      if (typeof done === "function") (done as () => void)();
      return true;
    }) as NodeJS.WriteStream["write"];
  }
  return true;
}
