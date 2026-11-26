import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentCancelledError, EchoResponder } from "./responder.js";

const prompt = "<trigger_message>\n#1 [human:rd] @smoke-echo hi\n</trigger_message>";

describe("EchoResponder", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("echoes immediately by default", async () => {
    const reply = await new EchoResponder("smoke-echo").reply({ instructions: "", prompt });
    expect(reply.text).toBe("Echo from smoke-echo: smoke-echo hi");
  });

  it("waits HIVE_ECHO_DELAY_MS with progress, and stops when asked", async () => {
    vi.useFakeTimers();
    vi.stubEnv("HIVE_ECHO_DELAY_MS", "3000");
    const progress: string[] = [];
    const pending = new EchoResponder("smoke-echo").reply({
      instructions: "",
      prompt,
      onProgress: (text) => progress.push(text),
    });
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(pending).resolves.toMatchObject({ text: "Echo from smoke-echo: smoke-echo hi" });
    expect(progress.length).toBeGreaterThanOrEqual(3);

    const controller = new AbortController();
    const stopped = new EchoResponder("smoke-echo").reply({
      instructions: "",
      prompt,
      signal: controller.signal,
    });
    const assertion = expect(stopped).rejects.toBeInstanceOf(AgentCancelledError);
    controller.abort();
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });
});
