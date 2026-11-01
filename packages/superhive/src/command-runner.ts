import { execFile } from "node:child_process";
import { AgentCancelledError } from "./responder.js";
import { assertWindowsCommandLine, commandFor } from "./windows-command.js";

export type CommandResult = { stdout: string; stderr: string };
export type CommandRunner = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    input?: string;
    signal?: AbortSignal;
    onStdout?: (chunk: string) => void;
  },
) => Promise<CommandResult>;

export const defaultCommandRunner: CommandRunner = (command, args, options) =>
  new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new AgentCancelledError());
      return;
    }
    let resolved;
    try {
      resolved = commandFor(command, args);
      // Copilot / OpenClaw 把整段提示放在参数里：Windows 命令行有长度上限，超出时给出明确原因
      assertWindowsCommandLine(resolved.command, resolved.args, command);
    } catch (error) {
      reject(error);
      return;
    }
    const child = execFile(
      resolved.command,
      resolved.args,
      {
        cwd: options.cwd,
        windowsHide: true,
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
