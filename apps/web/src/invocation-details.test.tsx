// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Invocation } from "@ai-hive/protocol";
import { InvocationChips, canRetryInvocation } from "./invocations";
import { runtimeEventLabel } from "./invocation-details";

const at = "2026-10-28T13:00:00.000Z";
const invocation: Invocation = {
  id: "00000000-0000-4000-8000-000000000001",
  roomId: "general",
  messageId: "m",
  agentId: "a",
  agentName: "worker",
  requesterName: "Alice",
  requesterType: "human",
  status: "running",
  attempts: 1,
  createdAt: at,
  startedAt: at,
  updatedAt: at,
};
const props = {
  participants: [],
  canJumpTo: () => true,
  onJump: vi.fn(),
  onRetry: vi.fn(),
  onCancel: vi.fn(),
  onExtend: vi.fn(),
};
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("clickable invocation details", () => {
  it("opens with keyboard, shows honest legacy fallback and restores focus on Escape", async () => {
    const user = userEvent.setup();
    render(<InvocationChips {...props} invocations={[invocation]} connectionState="online" />);
    const trigger = screen.getByRole("button", { name: /查看调用详情/ });
    trigger.focus();
    await user.keyboard("{Enter}");
    const dialog = screen.getByRole("dialog", { name: "调用详情" });
    expect(within(dialog).getByText("仅心跳 / 未接入事件")).toBeTruthy();
    expect(within(dialog).getByText(/不会用心跳伪造进度/)).toBeTruthy();
    expect(within(dialog).getAllByText("尚未收到")).toHaveLength(3);
    expect(document.activeElement).toBe(
      within(dialog).getByRole("button", { name: "关闭调用详情" }),
    );
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(document.body.style.overflow).not.toBe("hidden");
  });
  it("uses current props while open and distinguishes disconnects, errors, progress and recovery", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <InvocationChips {...props} invocations={[invocation]} connectionState="online" />,
    );
    await user.click(screen.getByRole("button", { name: /查看调用详情/ }));
    const updated: Invocation = {
      ...invocation,
      runtime: {
        observability: "partial",
        lastHeartbeatAt: at,
        lastRuntimeEventAt: at,
        lastProgressAt: at,
        lastError: { at, code: 429, retryAttempt: 2 },
        history: [{ at, kind: "provider_error", code: 429, retryAttempt: 2 }],
      },
    };
    rerender(<InvocationChips {...props} invocations={[updated]} connectionState="offline" />);
    const dialog = screen.getByRole("dialog", { name: "调用详情" });
    expect(within(dialog).getByText(/显示最近快照/)).toBeTruthy();
    expect(within(dialog).getByText(/尚未确认恢复.*HTTP 429/)).toBeTruthy();
    expect(within(dialog).getByText("部分事件可见")).toBeTruthy();
    rerender(
      <InvocationChips
        {...props}
        invocations={[
          {
            ...updated,
            status: "completed",
            replyMessageId: "reply",
            finishedAt: at,
            runtime: {
              ...updated.runtime!,
              lastError: { ...updated.runtime!.lastError!, recoveredAt: at },
            },
          },
        ]}
        connectionState="online"
      />,
    );
    expect(within(dialog).getByText(/已收到恢复证据/)).toBeTruthy();
    expect(within(dialog).getByText("已完成")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "查看回复" }));
    expect(props.onJump).toHaveBeenCalledWith("reply");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("does not increase completed duration and does not offer retry for an uncertain execution", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(at));
    render(
      <InvocationChips
        {...props}
        invocations={[{ ...invocation, status: "failed", finishedAt: at }]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /查看调用详情/ }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("0 分 0 秒")).toBeTruthy();
    act(() => vi.advanceTimersByTime(60_000));
    expect(within(dialog).getByText("0 分 0 秒")).toBeTruthy();
    expect(canRetryInvocation({ ...invocation, status: "timed_out" })).toBe(false);
  });
  it("closes on removal and never interprets untrusted agent names as HTML", () => {
    const { rerender } = render(
      <InvocationChips
        {...props}
        invocations={[{ ...invocation, agentName: "<img src=x onerror=alert(1)>" }]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /查看调用详情/ }));
    expect(screen.getByRole("dialog").querySelector("img")).toBeNull();
    rerender(<InvocationChips {...props} invocations={[]} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("labels tool completion without implying success", () => {
    expect(
      runtimeEventLabel({ kind: "activity", phase: "tool_completed", tool: "command" }),
    ).toContain("不代表任务完成");
  });
});
