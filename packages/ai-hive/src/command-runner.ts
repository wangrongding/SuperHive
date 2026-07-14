import { execFile } from "node:child_process";

export type CommandResult = { stdout: string; stderr: string };
export type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; input?: string },
) => Promise<CommandResult>;

export const defaultCommandRunner: CommandRunner = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      { cwd: options.cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
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
