// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentUsage, UsageSummary } from "@ai-hive/protocol";
import {
  InvocationUsage,
  UsageSection,
  estimateCells,
  estimateCost,
  formatTokens,
  setModelPrice,
} from "./usage";

const agentId = "00000000-0000-4000-8000-0000000000a1";
const usage: AgentUsage = {
  model: "claude-opus-5-5",
  inputTokens: 1_000,
  cacheWriteTokens: 430_000,
  cacheReadTokens: 0,
  outputTokens: 2_000,
  requests: 1,
  firstRequest: { inputTokens: 1_000, cacheWriteTokens: 430_000, cacheReadTokens: 0 },
  peakContextTokens: 431_000,
  peakCacheWriteTokens: 430_000,
  reportedCostUsd: 2.2,
  session: "resumed",
  idleMs: 30 * 60_000,
};
const totals = {
  inputTokens: 1_000,
  cacheWriteTokens: 430_000,
  cacheReadTokens: 0,
  outputTokens: 2_000,
  turns: 1,
  requests: 1,
  reportedCostUsd: 2.2,
  largeCacheWrites: 1,
};
const summary: UsageSummary = {
  roomId: "general",
  since: "2026-10-30T00:00:00.000Z",
  cacheWriteAlertTokens: 200_000,
  totals,
  agents: [
    {
      ...totals,
      agentId,
      agentName: "rd-claude",
      models: ["claude-opus-5-5"],
      latest: {
        invocationId: "00000000-0000-4000-8000-000000000001",
        roomId: "general",
        messageId: "00000000-0000-4000-8000-000000000002",
        agentId,
        agentName: "rd-claude",
        createdAt: new Date().toISOString(),
        usage,
      },
    },
  ],
  cells: [{ ...totals, agentId, day: "2026-10-31", model: "claude-opus-5-5" }],
  recent: [
    {
      invocationId: "00000000-0000-4000-8000-000000000001",
      roomId: "general",
      messageId: "00000000-0000-4000-8000-000000000002",
      agentId,
      agentName: "rd-claude",
      createdAt: new Date().toISOString(),
      usage,
    },
  ],
};

afterEach(() => {
  cleanup();
  setModelPrice("claude-opus-5-5", undefined);
  localStorage.clear();
});

describe("usage estimates", () => {
  it("prefers configured prices and falls back to the runtime's own estimate", () => {
    expect(estimateCost(usage, undefined)).toBe(2.2);
    expect(
      estimateCost(usage, { input: 4, cacheWrite: 5, cacheRead: 0.4, output: 20 }),
    ).toBeCloseTo((1_000 * 4 + 430_000 * 5 + 2_000 * 20) / 1_000_000);
    expect(estimateCost({ ...usage, reportedCostUsd: 0 }, undefined)).toBeUndefined();
  });

  it("flags totals as incomplete when a model has neither a price nor a reported cost", () => {
    const codex = { ...totals, reportedCostUsd: 0, model: "gpt-6-astra" };
    expect(estimateCells([{ ...totals, model: "claude-opus-5-5" }, codex], {})).toEqual({
      usd: 2.2,
      complete: false,
    });
    expect(formatTokens(431_000)).toBe("431k");
    expect(formatTokens(1_250_000)).toBe("1.25M");
  });
});

describe("usage views", () => {
  it("explains a large cache write on the invocation", () => {
    render(<InvocationUsage usage={usage} />);
    expect(screen.getByText(/单次缓存写入 430k token：空闲超过缓存有效期/)).toBeTruthy();
    expect(screen.getByText("0%")).toBeTruthy();
    expect(screen.getByText("$2.20")).toBeTruthy();
  });

  it("shows per-agent usage and lists large cache writes with their reason", async () => {
    const load = vi.fn().mockResolvedValue(summary);
    render(<UsageSection roomId="general" load={load} />);
    await waitFor(() => expect(screen.getAllByText("@rd-claude")).toHaveLength(2));
    expect(load).toHaveBeenCalledWith("general", 1);
    expect(screen.getByText(/写入 430k/)).toBeTruthy();
    expect(screen.getAllByText(/空闲超过缓存有效期/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("≈$2.20").length).toBeGreaterThan(0);
    setModelPrice("claude-opus-5-5", { input: 0, cacheWrite: 1, cacheRead: 0, output: 0 });
    await waitFor(() => expect(screen.getAllByText("≈$0.430").length).toBeGreaterThan(0));
  });
});
