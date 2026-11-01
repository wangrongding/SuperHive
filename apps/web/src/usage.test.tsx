// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentUsage, UsageSummary } from "@superhive/protocol";
import {
  InvocationUsage,
  UsageSection,
  estimateCells,
  estimateCost,
  formatTokens,
  describeCacheWrite,
  resetUsageSettings,
  setModelPrice,
  setUsageSettings,
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
  idleBasis: "request",
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
  resetUsageSettings();
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

describe("cache write explanations", () => {
  it("separates observed facts from the likely cause and uses the observed cache lifetime", () => {
    expect(describeCacheWrite(usage, { cacheTtlMinutes: 5 })).toEqual({
      facts: ["续接会话", "距上次模型请求 30 分钟", "有效期未观测到，按 5 分钟 假定"],
      likely: "可能原因：间隔超过缓存有效期，缓存已过期",
    });
    // 上一轮观测到是 1 小时写入：30 分钟内不该推测为过期
    expect(
      describeCacheWrite({ ...usage, previousCacheTtlMs: 3_600_000 }, { cacheTtlMinutes: 5 }),
    ).toEqual({
      facts: ["续接会话", "距上次模型请求 30 分钟", "上一轮缓存按 60 分钟 有效期写入"],
      likely: "可能原因：会话压缩、上游换了路由或网关没有命中（间隔在有效期内）",
    });
    expect(
      describeCacheWrite({ ...usage, idleBasis: "turn" }, { cacheTtlMinutes: 60 }).facts[1],
    ).toBe("距上一轮结束约 30 分钟（按回合估算）");
    expect(describeCacheWrite({ ...usage, session: "new" }).likely).toBe(
      "新会话开局，整段写入是正常的",
    );
  });
});

describe("usage views", () => {
  it("explains a large cache write on the invocation", () => {
    render(<InvocationUsage usage={usage} />);
    expect(screen.getByText("单次缓存写入 430k token")).toBeTruthy();
    expect(screen.getByText(/观测：续接会话，距上次模型请求 30 分钟/)).toBeTruthy();
    expect(screen.getByText(/会话已有 431k token/)).toBeTruthy();
    expect(screen.getByText("0%")).toBeTruthy();
    expect(screen.getByText("$2.20")).toBeTruthy();
  });

  it("shows per-agent usage and lists large cache writes with their reason", async () => {
    const load = vi.fn().mockResolvedValue(summary);
    const onStartTopic = vi.fn();
    render(
      <UsageSection
        roomId="general"
        load={load}
        onStartTopic={onStartTopic}
        participants={[
          {
            id: agentId,
            roomId: "general",
            username: "rd-claude",
            type: "agent",
            status: "online",
            joinedAt: "2026-10-31T00:00:00.000Z",
            lastSeenAt: "2026-10-31T00:00:00.000Z",
          },
          {
            id: "00000000-0000-4000-8000-0000000000b2",
            roomId: "general",
            username: "rd-omp",
            type: "agent",
            status: "online",
            joinedAt: "2026-10-31T00:00:00.000Z",
            lastSeenAt: "2026-10-31T00:00:00.000Z",
          },
        ]}
      />,
    );
    await waitFor(() => expect(screen.getAllByText("@rd-claude").length).toBeGreaterThan(0));
    expect(load).toHaveBeenCalledWith("general", 1, 200_000);
    expect(screen.getByText(/写入 430k/)).toBeTruthy();
    expect(screen.getAllByText(/可能原因：间隔超过缓存有效期/).length).toBeGreaterThan(0);
    // 会话超过 30 万：提示并给出开新话题的入口
    expect(screen.getByText(/会话偏大（≥ 300k token）/)).toBeTruthy();
    screen.getByRole("button", { name: "开启新话题" }).click();
    expect(onStartTopic).toHaveBeenCalled();
    expect(screen.getByText(/没有用量记录：@rd-omp/)).toBeTruthy();
    // 阈值可配：调高后重新按新阈值拉取
    setUsageSettings({ cacheWriteAlertTokens: 500_000 });
    await waitFor(() => expect(load).toHaveBeenCalledWith("general", 1, 500_000));
    expect(screen.getAllByText("≈$2.20").length).toBeGreaterThan(0);
    setModelPrice("claude-opus-5-5", { input: 0, cacheWrite: 1, cacheRead: 0, output: 0 });
    await waitFor(() => expect(screen.getAllByText("≈$0.430").length).toBeGreaterThan(0));
  });
});
