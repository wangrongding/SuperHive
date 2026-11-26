// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, Invocation, TraceStep } from "@superhive/protocol";
import { MessageList } from "./message-list";

vi.mock("./shadow-content", () => ({
  ShadowContent: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./message-markdown-lazy", () => ({
  MessageMarkdown: ({ content }: { content: string }) => <p>{content}</p>,
}));
vi.mock("./thinking-card", async (original) => ({
  ...(await original<typeof import("./thinking-card")>()),
  ThinkingCard: ({ steps }: { steps?: TraceStep[] }) => <aside>{steps?.[0]?.text}</aside>,
  TraceRecap: ({ steps }: { steps: TraceStep[] }) => <aside>{steps[0]?.text}</aside>,
}));

afterEach(cleanup);
const at = "2026-11-26T04:00:00.000Z";
const trigger: ChatMessage = {
  id: "trigger",
  roomId: "general",
  seq: 1,
  senderId: "alice",
  senderName: "Alice",
  senderType: "human",
  content: "",
  mentions: [],
  traceId: "trace",
  hopCount: 0,
  createdAt: at,
  deletedAt: at,
};
const reply: ChatMessage = {
  ...trigger,
  id: "reply",
  seq: 2,
  senderId: "worker",
  senderName: "worker",
  senderType: "agent",
  content: "Independent agent reply",
  deletedAt: undefined,
};
const invocation: Invocation = {
  id: "task",
  roomId: "general",
  messageId: trigger.id,
  agentId: "worker",
  agentName: "worker",
  requesterName: "Alice",
  requesterType: "human",
  status: "running",
  attempts: 1,
  createdAt: at,
  updatedAt: at,
};

function props(messages: ChatMessage[], task: Invocation): ComponentProps<typeof MessageList> {
  type Props = ComponentProps<typeof MessageList>;
  return {
    scroll: {
      messageListRef: { current: null },
      messageScrollContentRef: { current: null },
      messagesEndRef: { current: null },
      setShadowHost: vi.fn(),
      setScrollContentElement: vi.fn(),
      handleMessageListScroll: vi.fn(),
      captureScrollAnchor: vi.fn(),
    } as unknown as Props["scroll"],
    win: {
      hiddenCount: 0,
      earlierTopicCount: 0,
      timeline: messages.map((message) => ({ message, grouped: true, newDay: false })),
    } as Props["win"],
    jump: { jumpToMessage: vi.fn() } as unknown as Props["jump"],
    share: {
      shareMode: false,
      selectedMessageIds: new Set(),
      toggleMessageSelected: vi.fn(),
    } as unknown as Props["share"],
    composer: { textareaRef: { current: null } } as Props["composer"],
    actions: {
      pendingAnswers: new Set(),
      cancelInvocation: vi.fn(),
    } as unknown as Props["actions"],
    messages,
    messagesLoaded: true,
    currentRoomName: "general",
    currentRoomId: "general",
    currentRoomWorkspace: undefined,
    username: "Alice",
    guest: undefined,
    isOwner: true,
    base: "",
    authToken: undefined,
    connectionState: "online",
    participants: [],
    invocations: new Map([[task.id, task]]),
    traces: new Map([
      [task.id, [{ id: "step", kind: "text", text: "Recalled secret trace", startedAt: at }]],
    ]),
    pendingApprovals: new Set(),
    agentProviderByName: new Map(),
    timeFormat: "24h",
    openMachineIds: new Set(),
    setOpenMachineIds: vi.fn(),
    openSenderMenu: vi.fn(),
    locateMessageFromMarkdown: vi.fn(),
    dockPreview: vi.fn(),
    setRetryModelFor: vi.fn(),
    localAgentFor: () => undefined,
    openAgentTerminal: vi.fn(),
    canViewWorkspace: false,
    openWorkspaceFor: vi.fn(),
  };
}

describe("撤回后的完整对话流", () => {
  it("运行中的任务只剩紧凑状态，做完后只剩撤回提示", () => {
    const view = render(<MessageList {...props([trigger], invocation)} />);
    expect(screen.getByText("你撤回了一条消息")).toBeTruthy();
    expect(screen.getByText("@worker · 任务仍在继续")).toBeTruthy();
    expect(screen.queryByText("Recalled secret trace")).toBeNull();
    expect(screen.queryByRole("button", { name: /详情|重试/ })).toBeNull();
    view.rerender(<MessageList {...props([trigger], { ...invocation, status: "completed" })} />);
    expect(screen.getByText("你撤回了一条消息")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText("Recalled secret trace")).toBeNull();
  });

  it("回复独立保留，但回复上方不能复活撤回任务的过程", () => {
    render(
      <MessageList
        {...props([trigger, reply], {
          ...invocation,
          status: "completed",
          replyMessageId: reply.id,
        })}
      />,
    );
    expect(screen.getByText("Independent agent reply")).toBeTruthy();
    expect(screen.queryByText("Recalled secret trace")).toBeNull();
  });

  it("触发消息未加载时，也按服务端撤回标记屏蔽过程", () => {
    render(
      <MessageList
        {...props([reply], { ...invocation, messageRecalled: true, replyMessageId: reply.id })}
      />,
    );
    expect(screen.queryByText("Recalled secret trace")).toBeNull();
  });

  it("消息正文快照较旧时，撤回标记也能挡住已结束任务的过程回顾", () => {
    render(
      <MessageList
        {...props([{ ...trigger, deletedAt: undefined }], {
          ...invocation,
          status: "completed",
          messageRecalled: true,
        })}
      />,
    );
    expect(screen.queryByText("Recalled secret trace")).toBeNull();
    expect(screen.queryByRole("button", { name: /详情|重试/ })).toBeNull();
  });
});
