import { spawn } from "node:child_process";
import { AgentCancelledError } from "./responder.js";
import type { CommandRunner } from "./command-runner.js";
import { commandFor } from "./windows-command.js";

/** Consume stdout incrementally, without buffering private tool output or forwarding stderr. */
export const streamCommandRunner: CommandRunner = (command, args, options) =>
  new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(new AgentCancelledError());
    const resolved = commandFor(command, args);
    const child = spawn(resolved.command, resolved.args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    let failure: Error | undefined;
    child.on("error", () => {
      failure = new Error("运行进程无法启动或已中断。");
    });
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      if (failure || options.signal?.aborted) return;
      try {
        options.onStdout?.(chunk);
      } catch {
        failure = new Error("无法处理运行事件。");
        child.kill();
      }
    });
    // Drain stderr to avoid blocking, but never publish arbitrary private diagnostics.
    child.stderr.resume();
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") failure = new Error("无法发送运行输入。");
    });
    child.once("close", (code, signal) => {
      if (options.signal?.aborted) reject(new AgentCancelledError());
      else if (failure) reject(failure);
      else if (code !== 0)
        reject(new Error(`运行进程异常退出（${signal ?? code ?? "unknown"}）。`));
      else resolve({ stdout: "", stderr: "" });
    });
    child.stdin.end(options.input);
  });
