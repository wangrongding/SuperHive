import { expect, it } from "vitest";
import { runtimeEventSchema, runtimeObservationSchema } from "./index.js";
it("rejects raw diagnostics and accepts only structured allowlisted runtime facts", () => {
  expect(
    runtimeEventSchema.safeParse({ kind: "activity", tool: "read", phase: "tool_running" }).success,
  ).toBe(true);
  for (const extra of [
    { rawError: "secret" },
    { arguments: { token: "secret" } },
    { tool: "/private/file" },
  ]) {
    expect(runtimeEventSchema.safeParse({ kind: "activity", ...extra }).success).toBe(false);
  }
  expect(runtimeEventSchema.safeParse({ kind: "provider_error", code: 999 }).success).toBe(false);
});
it("keeps old heartbeat-only observations readable and bounds the timeline", () => {
  const at = "2026-10-28T13:00:00.000Z";
  const old = { observability: "heartbeat", lastHeartbeatAt: at, history: [] };
  expect(runtimeObservationSchema.safeParse(old).success).toBe(true);
  expect(
    runtimeObservationSchema.safeParse({
      ...old,
      history: Array(13).fill({ kind: "activity", at }),
    }).success,
  ).toBe(false);
});
