import { describe, expect, it } from "vitest";
import { streamCommandRunner } from "./stream-command-runner.js";
import { AgentCancelledError } from "./responder.js";

describe("streamCommandRunner", () => {
  it("delivers stdout before exit without retaining private output", async () => {
    let received!: () => void;
    const first = new Promise<void>((resolve) => {
      received = resolve;
    });
    let finished = false;
    let text = "";
    const run = streamCommandRunner(
      process.execPath,
      ["-e", "process.stdout.write('first');setTimeout(()=>process.stdout.write('last'),150)"],
      {
        cwd: process.cwd(),
        onStdout: (chunk) => {
          text += chunk;
          received();
        },
      },
    ).then((result) => {
      finished = true;
      return result;
    });
    await first;
    expect(finished).toBe(false);
    expect(await run).toEqual({ stdout: "", stderr: "" });
    expect(text).toBe("firstlast");
  });
  it("does not leak stderr on failure", async () => {
    await expect(
      streamCommandRunner(
        process.execPath,
        ["-e", "process.stderr.write('SECRET_TOKEN');process.exit(2)"],
        { cwd: process.cwd() },
      ),
    ).rejects.toThrow("运行进程异常退出（2）");
  });
  it("waits for child closure on cancellation and rejects with the cancellation type", async () => {
    const controller = new AbortController();
    const run = streamCommandRunner(
      process.execPath,
      ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"],
      {
        cwd: process.cwd(),
        signal: controller.signal,
        onStdout: () => controller.abort(),
      },
    );
    await expect(run).rejects.toBeInstanceOf(AgentCancelledError);
  });
});
