// @vitest-environment jsdom

import { act, cleanup, render, renderHook, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, Invocation } from "@superhive/protocol";
import { AttentionToasts, useAttention, type AttentionToast } from "./attention-alerts";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const at = "2026-11-11T10:00:00.000Z";

function toast(index: number): AttentionToast {
  const invocation = {
    id: `00000000-0000-4000-8000-00000000030${index}`,
    roomId: "frontend",
    messageId: "00000000-0000-4000-8000-000000000201",
    agentId: "00000000-0000-4000-8000-000000000105",
    agentName: `agent-${index}`,
    requesterName: "Alice",
    requesterType: "human",
    status: "completed",
    attempts: 1,
    createdAt: at,
    updatedAt: at,
  } as Invocation;
  return { id: `t${index}`, kind: "unseen", invocation };
}

describe("attention opening", () => {
  it("resolves notification and toast clicks using the latest invocation and messages", () => {
    const onOpen = vi.fn();
    const initial = { ...toast(1).invocation, status: "running" } as Invocation;
    const waiting = {
      ...initial,
      status: "waiting_human",
      updatedAt: "2026-11-11T10:01:00.000Z",
    } as Invocation;
    const question = {
      id: "question",
      seq: 30,
      roomId: waiting.roomId,
      senderId: waiting.agentId,
      parentMessageId: waiting.messageId,
      kind: "question",
    } as ChatMessage;
    const notifications: Array<{ onclick?: () => void; close: () => void }> = [];
    class NotificationMock {
      static permission = "granted";
      onclick?: () => void;
      close = vi.fn();
      constructor() {
        notifications.push(this);
      }
    }
    vi.stubGlobal("Notification", NotificationMock);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const focus = vi.spyOn(window, "focus").mockImplementation(() => undefined);
    const { result, rerender } = renderHook(
      ({ messages }: { messages: ChatMessage[] }) =>
        useAttention({
          username: "Alice",
          isOwner: true,
          currentRoomId: "general",
          activeInvocations: new Map([[waiting.id, waiting]]),
          messages,
          preferences: { delivery: "system", sound: false },
          roomName: (id) => id,
          onOpen,
        }),
      { initialProps: { messages: [] as ChatMessage[] } },
    );
    act(() => {
      result.current.seed([initial]);
      result.current.observe(waiting);
    });
    expect(notifications).toHaveLength(1);
    rerender({ messages: [question] });
    act(() => notifications[0]!.onclick?.());
    expect(onOpen).toHaveBeenLastCalledWith(
      expect.objectContaining({ messageId: question.id, messageSeq: 30, invocation: waiting }),
    );
    act(() => result.current.open(initial));
    expect(onOpen).toHaveBeenLastCalledWith(
      expect.objectContaining({ messageId: question.id, invocation: waiting }),
    );
    focus.mockRestore();
    visibility.mockRestore();
  });
});

describe("AttentionToasts", () => {
  it("keeps completed toasts until dismissed and folds older ones", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const onDismissAll = vi.fn();
    render(
      <AttentionToasts
        toasts={[1, 2, 3, 4, 5].map(toast)}
        roomName={() => "frontend"}
        onOpen={() => {}}
        onDismiss={onDismiss}
        onDismissAll={onDismissAll}
      />,
    );
    // 不点就不消失：过一分钟还在，也没有被自动关掉
    act(() => vi.advanceTimersByTime(60_000));
    expect(onDismiss).not.toHaveBeenCalled();
    const region = screen.getByRole("region", { name: "任务提醒" });
    // 只摆最新三条，更早的折成「还有 n 条」
    expect(within(region).getAllByRole("status")).toHaveLength(3);
    expect(within(region).getByText("agent-5 做完了")).toBeTruthy();
    expect(within(region).queryByText("agent-1 做完了")).toBeNull();
    expect(within(region).getByText("还有 2 条")).toBeTruthy();
    act(() => within(region).getByRole("button", { name: "全部关闭" }).click());
    expect(onDismissAll).toHaveBeenCalledTimes(1);
  });

  it("shows no bar for a single toast", () => {
    render(
      <AttentionToasts
        toasts={[toast(1)]}
        roomName={() => "frontend"}
        onOpen={() => {}}
        onDismiss={() => {}}
        onDismissAll={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: "全部关闭" })).toBeNull();
  });
});
