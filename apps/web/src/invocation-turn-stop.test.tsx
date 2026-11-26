// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Invocation } from "@superhive/protocol";
import { InvocationChips, canRetryInvocation, guestCanStopTurn, turnSiblings } from "./invocations";
import { attentionKind, isCompleted, needsDecision } from "./attention";
import { setLocalePreference } from "./i18n";

const at = "2026-11-24T07:00:00.000Z";
const make = (id: number, overrides: Partial<Invocation> = {}): Invocation => ({
  id: `00000000-0000-4000-8000-00000000000${id}`,
  roomId: "general",
  messageId: `m${id}`,
  agentId: "a",
  agentName: "worker",
  requesterName: "rd",
  requesterType: "human",
  status: "running",
  attempts: 1,
  createdAt: at,
  startedAt: at,
  updatedAt: at,
  ...overrides,
});
const props = {
  participants: [],
  canJumpTo: () => true,
  onJump: vi.fn(),
  onRetry: vi.fn(),
  onExtend: vi.fn(),
};
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  setLocalePreference("zh-CN");
});

describe("撤回消息的任务", () => {
  it("服务端标记撤回的调用不能重试，也不再要求处理或报完成未看", () => {
    const failed = make(1, { status: "failed", messageRecalled: true });
    expect(canRetryInvocation(failed)).toBe(false);
    expect(attentionKind(failed)).toBeUndefined();
    expect(needsDecision(failed)).toBe(false);
    expect(isCompleted({ ...failed, status: "completed" })).toBe(false);
  });

  it("英文紧凑状态也不展示详情", () => {
    setLocalePreference("en");
    render(
      <InvocationChips
        {...props}
        invocations={[make(1, { messageRecalled: true })]}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText("@worker · Task is still running")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop @worker's current run" })).toBeTruthy();
  });

  it.each(["completed", "cancelled", "failed", "blocked", "timed_out", "waiting_human"] as const)(
    "已结束的 %s 不再显示卡片、详情或重试",
    (status) => {
      const invocation = make(1, { status, finishedAt: at, detail: "secret" });
      const { container } = render(
        <InvocationChips {...props} recalled invocations={[invocation]} onCancel={vi.fn()} />,
      );
      expect(container.textContent).toBe("");
    },
  );

  it("只撤回时显示紧凑状态和停止，停止后收起", async () => {
    const onCancel = vi.fn();
    const invocation = make(1, { detail: "secret detail", progress: "secret progress" });
    const view = render(
      <InvocationChips {...props} recalled invocations={[invocation]} onCancel={onCancel} />,
    );
    expect(screen.getByRole("status").textContent).toContain("@worker · 任务仍在继续");
    expect(view.container.textContent).not.toContain("secret");
    expect(screen.queryByRole("button", { name: /详情|重试|继续/ })).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: "停止 @worker 这一轮" }));
    expect(onCancel).toHaveBeenCalledWith(invocation);
    view.rerender(
      <InvocationChips
        {...props}
        recalled
        invocations={[{ ...invocation, status: "cancelling" }]}
        onCancel={onCancel}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("停止中…");
    expect(screen.queryByRole("button")).toBeNull();
    view.rerender(
      <InvocationChips
        {...props}
        recalled
        invocations={[{ ...invocation, status: "completed" }]}
        onCancel={onCancel}
      />,
    );
    expect(view.container.textContent).toBe("");
  });

  it("访客不能停别人的任务，断线时停止按钮不可用", () => {
    const invocation = make(1);
    const view = render(
      <InvocationChips
        {...props}
        recalled
        isOwner={false}
        selfName="visitor"
        invocations={[invocation]}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    view.rerender(
      <InvocationChips
        {...props}
        recalled
        connectionState="offline"
        invocations={[invocation]}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole("button").hasAttribute("disabled")).toBe(true);
  });
});

describe("合在一轮里处理的几条消息", () => {
  it("同一轮：同一个 Agent 在这个房间里正跑着的，排队的、别的 Agent、已结束的不算", () => {
    const self = make(1);
    const all = [
      self,
      make(2, { status: "cancelling" }),
      make(3, { status: "waiting_human" }),
      make(4, { status: "queued" }),
      make(5, { agentId: "b" }),
      make(6, { status: "completed" }),
      make(7, { status: "waiting_human", finishedAt: at }),
    ];
    expect(turnSiblings(self, all).map((item) => item.messageId)).toEqual(["m2", "m3"]);
    // 排队中的不在跑的这一轮里
    expect(turnSiblings(all[3]!, all)).toEqual([]);
  });

  it("房主点任意一条下面的「停止这一轮」，说明会一起停下", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const first = make(1);
    const all = new Map([first, make(2)].map((item) => [item.id, item]));
    render(
      <InvocationChips {...props} onCancel={onCancel} invocations={[first]} allInvocations={all} />,
    );
    const button = screen.getByRole("button", { name: "停止 @worker 这一轮的 2 条消息" });
    expect(button.textContent).toBe("停止这一轮");
    await user.hover(button);
    expect(await screen.findByText("这一轮一起处理了 2 条消息，停止会把它们一起停下")).toBeTruthy();
    await user.click(button);
    expect(onCancel).toHaveBeenCalledWith(first);
  });

  it("只有一条时照旧显示「停止」", () => {
    const only = make(1);
    render(
      <InvocationChips
        {...props}
        onCancel={vi.fn()}
        invocations={[only]}
        allInvocations={new Map([[only.id, only]])}
      />,
    );
    expect(screen.getByRole("button", { name: "停止 @worker" }).textContent).toBe("停止");
  });

  it("访客：同一轮里有别人发起的消息时停不了，按钮点不了并说清楚", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const mine = make(1, { requesterName: "Visitor" });
    const all = new Map([mine, make(2, { requesterName: "rd" })].map((item) => [item.id, item]));
    expect(guestCanStopTurn(mine, all.values(), "visitor")).toBe(false);
    render(
      <InvocationChips
        {...props}
        isOwner={false}
        selfName="visitor"
        onCancel={onCancel}
        invocations={[mine]}
        allInvocations={all}
      />,
    );
    const button = screen.getByRole("button", { name: "停止 @worker 这一轮的 2 条消息" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    await user.hover(button);
    expect(
      await screen.findByText("@worker 这一轮还在一起处理别人发起的消息，访客没法停下这一轮"),
    ).toBeTruthy();
    await user.click(button);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("访客：同一轮全是自己发起的可以停", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const mine = make(1, { requesterName: "visitor" });
    const all = new Map(
      [mine, make(2, { requesterName: "visitor" })].map((item) => [item.id, item]),
    );
    render(
      <InvocationChips
        {...props}
        isOwner={false}
        selfName="visitor"
        onCancel={onCancel}
        invocations={[mine]}
        allInvocations={all}
      />,
    );
    await user.click(screen.getByRole("button", { name: "停止 @worker 这一轮的 2 条消息" }));
    expect(onCancel).toHaveBeenCalledWith(mine);
  });
});
