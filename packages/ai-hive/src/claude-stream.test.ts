import { describe, expect, it } from "vitest";
import { ClaudeStream } from "./claude-stream.js";
import type { RuntimeEvent } from "./hive-protocol.js";

describe("Claude stream diagnostics", () => {
  it("parses fragmented JSON, returns only the final result and emits no private content", () => {
    const events: RuntimeEvent[] = [];
    const stream = new ClaudeStream((e) => events.push(e));
    const lines = [
      { type: "stream_event", event: { type: "message_start" } },
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "thinking_delta", thinking: "PRIVATE_THOUGHT" },
        },
      },
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "1", name: "Bash", input: { command: "SECRET_COMMAND" } },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "1", content: "SECRET_FILE", is_error: true },
          ],
        },
      },
      { type: "result", is_error: false, result: "public reply", session_id: "session" },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n");
    for (let i = 0; i < lines.length; i += 7) stream.push(lines.slice(i, i + 7));
    expect(stream.finish()).toEqual({
      result: "public reply",
      session_id: "session",
      is_error: false,
    });
    expect(events).toContainEqual({ kind: "activity", phase: "tool_running", tool: "command" });
    expect(events).toContainEqual({ kind: "activity", phase: "tool_completed", tool: "command" });
    expect(JSON.stringify(events)).not.toMatch(/PRIVATE|SECRET|session|public reply/);
  });

  it("keeps an API error until model recovery evidence, not a tool result", () => {
    const events: RuntimeEvent[] = [];
    const stream = new ClaudeStream((e) => events.push(e));
    const push = (event: object) => stream.push(JSON.stringify(event) + "\n");
    push({
      type: "system",
      subtype: "api_retry",
      error_status: 429,
      attempt: 2,
      retry_delay_ms: 500,
      error: "SECRET",
    });
    push({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } });
    expect(events).not.toContainEqual({ kind: "recovered" });
    push({ type: "assistant", error: "rate_limit", message: { content: [] } });
    expect(events).not.toContainEqual({ kind: "recovered" });
    push({ type: "stream_event", event: { type: "message_start" } });
    expect(events).toContainEqual({
      kind: "provider_error",
      code: 429,
      retryAttempt: 2,
      retryInMs: 500,
    });
    expect(events.at(-2)).toEqual({ kind: "recovered" });
  });

  it("ignores malformed, oversized and unknown events without replaying the task", () => {
    const events: RuntimeEvent[] = [];
    const stream = new ClaudeStream((e) => events.push(e));
    stream.push("not-json\n" + "x".repeat(1_100_000));
    stream.push('\n{"type":"private_event","payload":"SECRET"}\n');
    stream.push(
      '{"type":"system","subtype":"api_retry","error_status":999,"attempt":-1,"retry_delay_ms":"secret"}\n',
    );
    stream.push('{"type":"result","result":"ok"}\n');
    expect(stream.finish()?.result).toBe("ok");
    expect(events[0]).toEqual({ kind: "provider_error" });
    expect(events).toHaveLength(2);
  });

  it("never treats partial assistant text as a completed reply", () => {
    const stream = new ClaudeStream(() => {});
    stream.push('{"type":"assistant","message":{"content":[{"type":"text","text":"partial"}]}}\n');
    expect(stream.finish()).toBeUndefined();
  });
});
