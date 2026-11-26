// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Invocation } from "@superhive/protocol";
import { InvocationChips, canRetryInvocation } from "./invocations";
import { groupTraceSteps } from "./live-trace";

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
    // 底层事件列表已去掉：执行过程看消息下的过程框
    expect(within(dialog).queryByText("最近事件")).toBeNull();
    expect(within(dialog).getAllByText("尚未收到")).toHaveLength(3);
    expect(document.activeElement).toBe(
      within(dialog).getByRole("button", { name: "关闭调用详情" }),
    );
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(document.body.style.overflow).not.toBe("hidden");
  });
  it("「看改动」关掉详情并打开这个 Agent 的改动", async () => {
    const user = userEvent.setup();
    const onViewChanges = vi.fn();
    render(
      <InvocationChips
        {...props}
        invocations={[invocation]}
        connectionState="online"
        onViewChanges={onViewChanges}
      />,
    );
    await user.click(screen.getByRole("button", { name: /查看调用详情/ }));
    await user.click(
      within(screen.getByRole("dialog", { name: "调用详情" })).getByRole("button", {
        name: "看改动",
      }),
    );
    expect(onViewChanges).toHaveBeenCalledWith(invocation);
    expect(screen.queryByRole("dialog")).toBeNull();
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
    expect(props.onJump).toHaveBeenCalledWith(
      "reply",
      expect.objectContaining({ replyMessageId: "reply" }),
    );
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
});

describe("trace in details", () => {
  it("shows the full trace in the dialog for the owner", async () => {
    const user = userEvent.setup();
    const steps = [
      { id: "s1", kind: "text" as const, text: "先看一下改动", startedAt: at, endedAt: at },
      {
        id: "s2",
        kind: "tool" as const,
        tool: "command" as const,
        summary: "git status",
        status: "ok" as const,
        startedAt: at,
        endedAt: at,
      },
    ];
    render(
      <InvocationChips
        {...props}
        invocations={[invocation]}
        traces={new Map([[invocation.id, steps]])}
      />,
    );
    await user.click(screen.getByRole("button", { name: /查看调用详情/ }));
    const dialog = screen.getByRole("dialog", { name: "调用详情" });
    const trace = within(dialog).getByRole("region", { name: "执行过程" });
    expect(within(trace).getByText("先看一下改动")).toBeTruthy();
    expect(within(trace).getByText("git status")).toBeTruthy();
  });
});

describe("trace grouping", () => {
  const step = (id: string, tool: "read" | "command" | "search", status: "ok" | "error") => ({
    id,
    kind: "tool" as const,
    tool,
    summary: id,
    status,
    startedAt: at,
    endedAt: at,
  });
  it("merges consecutive reads like a CLI but never hides commands or failures", () => {
    const rows = groupTraceSteps([
      step("a.ts", "read", "ok"),
      step("b.ts", "read", "ok"),
      step("c.ts", "read", "ok"),
      step("git status", "command", "ok"),
      step("pnpm test", "command", "ok"),
      step("d.ts", "read", "error"),
      step("e.ts", "read", "ok"),
    ]);
    expect(
      rows.map((row) => (row.type === "group" ? `group:${row.steps.length}` : row.step.id)),
    ).toEqual(["group:3", "git status", "pnpm test", "d.ts", "e.ts"]);
  });
});

describe("inserting a queued message into the running task", () => {
  const agent = {
    id: "a",
    roomId: "general",
    username: "worker",
    type: "agent" as const,
    status: "busy" as const,
    provider: "claude",
    joinedAt: at,
    lastSeenAt: at,
  };
  const running: Invocation = { ...invocation, id: "00000000-0000-4000-8000-0000000000a1" };
  const queued: Invocation = {
    ...invocation,
    id: "00000000-0000-4000-8000-0000000000a2",
    messageId: "m2",
    status: "queued",
  };
  const all = new Map([running, queued].map((item) => [item.id, item]));

  it("offers insert and stop-and-switch on a human message queued behind a running task", () => {
    const onSteer = vi.fn();
    const onPreempt = vi.fn();
    render(
      <InvocationChips
        {...props}
        participants={[agent]}
        invocations={[queued]}
        allInvocations={all}
        onSteer={onSteer}
        onPreempt={onPreempt}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "用这条引导 @worker 正在执行的任务" }));
    expect(onSteer).toHaveBeenCalledWith(queued);
    fireEvent.click(screen.getByRole("button", { name: "停下 @worker 当前的任务，改做这条" }));
    expect(onPreempt).toHaveBeenCalledWith(queued);
  });

  it("hides insert for agent-sent messages, runtimes without steering, guests' stop and idle agents", () => {
    const { rerender } = render(
      <InvocationChips
        {...props}
        participants={[agent]}
        invocations={[{ ...queued, requesterType: "agent" }]}
        allInvocations={all}
        onSteer={vi.fn()}
        onPreempt={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /引导/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /改做这条/ })).toBeNull();
    rerender(
      <InvocationChips
        {...props}
        participants={[{ ...agent, provider: "copilot" }]}
        invocations={[queued]}
        allInvocations={all}
        onSteer={vi.fn()}
        onPreempt={vi.fn()}
        isOwner={false}
      />,
    );
    expect(screen.queryByRole("button", { name: /引导/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /改做这条/ })).toBeNull();
    rerender(
      <InvocationChips
        {...props}
        participants={[agent]}
        invocations={[queued]}
        allInvocations={new Map([[queued.id, queued]])}
        onSteer={vi.fn()}
        onPreempt={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /引导/ })).toBeNull();
  });
});

describe("queued status line", () => {
  it("does not repeat the server's delivery note next to the same status label", () => {
    const queued: Invocation = {
      ...invocation,
      status: "queued",
      receivedAt: at,
      detail: "已送达，排队中",
    };
    render(<InvocationChips {...props} invocations={[queued]} />);
    expect(screen.getAllByText("已送达，排队中")).toHaveLength(1);
  });

  it("explains why a task is still queued and how long a running one has been quiet", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.parse(at) + 200_000));
    const online = [
      {
        id: "a",
        roomId: "general",
        username: "worker",
        type: "agent" as const,
        status: "busy" as const,
        joinedAt: at,
        lastSeenAt: at,
      },
    ];
    const running: Invocation = {
      ...invocation,
      requesterName: "Bob",
      runtime: {
        observability: "full",
        lastHeartbeatAt: at,
        lastProgressAt: at,
        tool: "command",
        phase: "tool_running",
        history: [],
      },
    };
    const queued: Invocation = {
      ...invocation,
      id: "00000000-0000-4000-8000-000000000002",
      messageId: "m2",
      status: "queued",
      startedAt: undefined,
      createdAt: new Date(Date.parse(at) + 100_000).toISOString(),
    };
    render(
      <InvocationChips
        {...props}
        participants={online as never}
        invocations={[running, queued]}
        connectionState="online"
      />,
    );
    // 排队的那条在消息下就能看到前面还有几个
    expect(screen.getByText("前面还有 1 个")).toBeTruthy();
    const [runningChip, queuedChip] = screen.getAllByRole("button", { name: /查看调用详情/ });
    fireEvent.click(queuedChip!);
    let why = screen.getByRole("region", { name: "为什么是这个状态" });
    expect(why.textContent).toContain("@worker 手上还有 1 个任务排在前面，它正在做 Bob 派的任务");
    fireEvent.click(screen.getByRole("button", { name: "关闭调用详情" }));
    fireEvent.click(runningChip!);
    why = screen.getByRole("region", { name: "为什么是这个状态" });
    expect(why.textContent).toContain(
      "已经 3 分钟没有新的执行事件，最后一步是「跑命令 · 工具执行中」",
    );
    expect(why.className).toContain("warning");
  });
});
