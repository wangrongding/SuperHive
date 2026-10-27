import { execFile } from "node:child_process";
import { AgentCancelledError } from "./responder.js";

export type CommandResult = { stdout: string; stderr: string };
export type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; input?: string; signal?: AbortSignal },
) => Promise<CommandResult>;

export const defaultCommandRunner: CommandRunner = (command, args, options) =>
  new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new AgentCancelledError());
      return;
    }
    const child = execFile(
      command,
      args,
      {
        cwd: options.cwd,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (error, stdout, stderr) => {
        if (error) {
          // 被"停止"按钮中断时 execFile 会以 AbortError 结束并终止子进程
          if (options.signal?.aborted) {
            reject(new AgentCancelledError());
            return;
          }
          reject(new Error(stderr.trim() || error.message, { cause: error }));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
    child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.stdin?.end(options.input);
  });
