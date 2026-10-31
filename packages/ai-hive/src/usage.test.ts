import { describe, expect, it } from "vitest";
import { ClaudeStream } from "./claude-stream.js";
import { UsageAccumulator, codexBuckets } from "./usage.js";

const claudeUsage = (input: number, write: number, read: number, output: number) => ({
  input_tokens: input,
  cache_creation_input_tokens: write,
  cache_read_input_tokens: read,
  output_tokens: output,
});

describe("UsageAccumulator", () => {
  it("dedupes repeated reports of one request and keeps the first request separately", () => {
    const usage = new UsageAccumulator();
    usage.request("a", { inputTokens: 10, cacheWriteTokens: 400_000, cacheReadTokens: 0 });
    usage.request("a", { inputTokens: 10, cacheWriteTokens: 400_000, outputTokens: 50 });
    usage.request("b", { inputTokens: 5, cacheReadTokens: 400_010, outputTokens: 20 });
    expect(usage.finish()).toEqual({
      inputTokens: 15,
      cacheWriteTokens: 400_000,
      cacheReadTokens: 400_010,
      outputTokens: 70,
      requests: 2,
      firstRequest: { inputTokens: 10, cacheWriteTokens: 400_000, cacheReadTokens: 0 },
      peakContextTokens: 400_015,
      peakCacheWriteTokens: 400_000,
    });
  });

  it("returns nothing when no tokens were reported and ignores synthetic models", () => {
    const usage = new UsageAccumulator();
    usage.setModel("<synthetic>");
    usage.request("x", { inputTokens: 0 });
    expect(usage.finish()).toBeUndefined();
  });

  it("splits Codex inputTokens, which include cached input, into exclusive buckets", () => {
    expect(codexBuckets({ inputTokens: 1000, cachedInputTokens: 800, outputTokens: 30 })).toEqual({
      inputTokens: 200,
      cacheWriteTokens: 0,
      cacheReadTokens: 800,
      outputTokens: 30,
    });
  });
});

describe("ClaudeStream usage", () => {
  it("reads per-request usage from the stream and totals from the result", () => {
    const stream = new ClaudeStream(() => undefined);
    const lines = [
      {
        type: "stream_event",
        event: {
          type: "message_start",
          message: { id: "m1", model: "claude-opus-5-5", usage: claudeUsage(16149, 20097, 0, 4) },
        },
      },
      {
        type: "assistant",
        message: { id: "m1", model: "claude-opus-5-5", usage: claudeUsage(16149, 20097, 0, 4) },
      },
      {
        type: "stream_event",
        event: { type: "message_delta", usage: claudeUsage(16149, 20097, 0, 90) },
      },
      {
        type: "stream_event",
        event: {
          type: "message_start",
          message: { id: "m2", model: "claude-opus-5-5", usage: claudeUsage(3, 500, 36246, 1) },
        },
      },
      {
        type: "stream_event",
        event: { type: "message_delta", usage: claudeUsage(3, 500, 36246, 12) },
      },
      {
        type: "result",
        result: "ok",
        session_id: "s",
        total_cost_usd: 0.2,
        modelUsage: {
          "claude-opus-5-5[1m]": {
            inputTokens: 16152,
            outputTokens: 102,
            cacheReadInputTokens: 36246,
            cacheCreationInputTokens: 20597,
            costUSD: 0.19,
            contextWindow: 1_000_000,
            canonicalModel: "claude-opus-5-5",
          },
          "claude-haiku-4-5": {
            inputTokens: 100,
            outputTokens: 10,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            costUSD: 0.01,
          },
        },
      },
    ];
    stream.push(lines.map((line) => JSON.stringify(line)).join("\n"));
    stream.finish();
    // modelUsage / total_cost_usd 是 --resume 会话的累计值，不能当本轮合计
    expect(stream.sessionCostUsd()).toBe(0.2);
    expect(stream.usage()).toEqual({
      model: "claude-opus-5-5",
      inputTokens: 16152,
      cacheWriteTokens: 20597,
      cacheReadTokens: 36246,
      outputTokens: 102,
      requests: 2,
      firstRequest: { inputTokens: 16149, cacheWriteTokens: 20097, cacheReadTokens: 0 },
      peakContextTokens: 36749,
      peakCacheWriteTokens: 20097,
      contextWindow: 1_000_000,
    });
  });
});
