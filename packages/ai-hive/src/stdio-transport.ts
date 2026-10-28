import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/**
 * 常驻子进程上的换行分隔 JSON-RPC 传输（Codex app-server 与 ACP Agent 共用）。
 * 只负责按行收发和退出通知，协议语义由上层客户端处理。
 */

/** 子进程退出信息；error 表示 spawn 本身失败（如 ENOENT） */
export type StdioExit = {
  code: number | null;
  signal: string | null;
  error?: Error;
  /** stderr 最近的一段输出，便于诊断 */
  stderr: string;
};

/** 与子进程通信的最小传输抽象，测试中可注入假实现 */
export type StdioTransport = {
  write(line: string): void;
  onLine(listener: (line: string) => void): void;
  onExit(listener: (exit: StdioExit) => void): void;
  kill(): void;
};

export type StdioTransportFactory = (
  command: string,
  args: string[],
  options: { cwd: string; env?: Record<string, string> },
) => StdioTransport;

const STDERR_TAIL_LIMIT = 4_000;

/** 默认传输：spawn 子进程，stdout 按行读取，stderr 透传并保留尾部 */
export const spawnStdioTransport: StdioTransportFactory = (command, args, options) => {
  const child = spawn(command, args, {
    cwd: options.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
  });
  const lineListeners: Array<(line: string) => void> = [];
  const exitListeners: Array<(exit: StdioExit) => void> = [];
  let stderrTail = "";
  let exited = false;
  const emitExit = (exit: Omit<StdioExit, "stderr">) => {
    if (exited) return;
    exited = true;
    for (const listener of exitListeners) listener({ ...exit, stderr: stderrTail });
  };

  createInterface({ input: child.stdout! }).on("line", (line) => {
    for (const listener of lineListeners) listener(line);
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_LIMIT);
  });
  // stdin 写入失败（进程已退出）时不要抛出未处理异常，退出事件会负责收尾
  child.stdin!.on("error", () => undefined);
  child.on("error", (error) => emitExit({ code: null, signal: null, error }));
  child.on("close", (code, signal) => emitExit({ code, signal }));

  return {
    write(line) {
      if (!exited && child.stdin!.writable) child.stdin!.write(`${line}\n`);
    },
    onLine(listener) {
      lineListeners.push(listener);
    },
    onExit(listener) {
      exitListeners.push(listener);
    },
    kill() {
      if (!exited) child.kill("SIGTERM");
    },
  };
};
