import { describe, expect, it } from "vitest";
import { observeRuntime } from "./runtime-observation.js";

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 28, 13, 0, seconds)).toISOString();
describe("runtime observation", () => {
  it("separates connection, runtime-event and real-progress clocks", () => {
    let runtime = observeRuntime(
      undefined,
      { kind: "activity", phase: "tool_running", tool: "read" },
      at(0),
    );
    runtime = observeRuntime(
      runtime,
      { kind: "provider_error", code: 503, retryAttempt: 1, retryInMs: 500 },
      at(10),
    );
    runtime = observeRuntime(runtime, undefined, at(20));
    expect(runtime.lastHeartbeatAt).toBe(at(20));
    expect(runtime.lastRuntimeEventAt).toBe(at(10));
    expect(runtime.lastProgressAt).toBe(at(0));
    expect(runtime.lastError).toMatchObject({ code: 503, at: at(10) });
    expect(runtime.history).toHaveLength(2);
    runtime = observeRuntime(runtime, { kind: "activity", phase: "tool_completed" }, at(25));
    expect(runtime.lastError?.recoveredAt).toBeUndefined();
    expect(runtime.tool).toBeUndefined();
    runtime = observeRuntime(runtime, { kind: "recovered" }, at(30));
    expect(runtime.lastError?.recoveredAt).toBe(at(30));
    expect(runtime.lastProgressAt).toBe(at(30));
  });
  it("records a usage capability without changing the observability level", () => {
    const now = "2026-10-31T10:00:00.000Z";
    const full = observeRuntime(undefined, { kind: "capabilities", observability: "full" }, now);
    const withUsage = observeRuntime(full, { kind: "capabilities", usage: true }, now);
    expect(withUsage).toMatchObject({ observability: "full", usage: true });
    expect(
      observeRuntime(undefined, { kind: "capabilities", usage: true }, now).observability,
    ).toBe("heartbeat");
  });

  it("bounds the timeline, merges repeated activity but keeps distinct tool categories", () => {
    let runtime = observeRuntime(undefined, undefined, at(0));
    for (let i = 0; i < 20; i++)
      runtime = observeRuntime(
        runtime,
        { kind: "activity", phase: "tool_running", tool: i % 2 ? "read" : "write" },
        at(i),
      );
    expect(runtime.history).toHaveLength(12);
    const previous = runtime;
    runtime = observeRuntime(
      runtime,
      { kind: "activity", phase: "tool_running", tool: "read" },
      at(30),
    );
    expect(runtime.history).toHaveLength(12);
    expect(runtime.history.at(-1)?.at).toBe(at(30));
    expect(previous.history.at(-1)?.at).toBe(at(19));
  });
});
