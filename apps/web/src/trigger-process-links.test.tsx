// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { cleanup, fireEvent, render, renderHook, act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, Invocation } from "@superhive/protocol";
import { MessageList } from "./message-list";
import { useMessageJump } from "./use-message-timeline";

vi.mock("./shadow-content", () => ({
  ShadowContent: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./message-markdown-lazy", () => ({
  MessageMarkdown: ({ content }: { content: string }) => <p>{content}</p>,
}));

afterEach(cleanup);
const at = "2026-11-26T04:00:00.000Z";
const question: ChatMessage = {
  id: "question",
  roomId: "general",
  seq: 6370,
  senderId: "alice",
  senderName: "Alice",
  senderType: "human",
  content: "过程卡片和原问题之间要能双向跳转",
  mentions: ["worker"],
  traceId: "trace",
  hopCount: 0,
  createdAt: at,
};
const reply: ChatMessage = {
  ...question,
  id: "reply",
  seq: 6400,
  senderId: "worker",
  senderName: "worker",
  senderType: "agent",
  content: "做完了",
  mentions: [],
  parentMessageId: question.id,
};
const running: Invocation = {
  id: "task",
  roomId: "general",
  messageId: question.id,
  agentId: "worker",
  agentName: "worker",
  requesterName: "Alice",
  requesterType: "human",
  status: "running",
  attempts: 1,
  createdAt: at,
  updatedAt: at,
  startedAt: at,
};

type Props = ComponentProps<typeof MessageList>;
function setup(
  messages: ChatMessage[],
  tasks: Invocation[],
  flash: { messageIds?: string[]; invocationIds?: string[] } = {},
) {
  const jump = {
    jumpToMessage: vi.fn(),
    jumpToProcess: vi.fn(() => true),
    locateMessage: vi.fn(),
    flashOrigin: vi.fn(),
    flash: {
      messageIds: new Set(flash.messageIds),
      invocationIds: new Set(flash.invocationIds),
    },
  };
  const props: Props = {
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
      timeline: messages.map((message) => ({ message, grouped: false, newDay: false })),
    } as Props["win"],
    jump: jump as unknown as Props["jump"],
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
    invocations: new Map(tasks.map((task) => [task.id, task])),
    traces: new Map(),
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
  const view = render(<MessageList {...props} />);
  return { view, jump };
}

describe("原消息 → 过程卡", () => {
  it("进行中的状态条有「查看过程」，跳到对话流里那张卡并让状态条一起闪", () => {
    const { jump } = setup([question], [running]);
    fireEvent.click(screen.getByRole("button", { name: /跳到执行过程/ }));
    expect(jump.jumpToProcess).toHaveBeenCalledWith("task", { invocationIds: ["task"] });
  });

  it("等你回答时同样能跳到过程卡", () => {
    const { jump } = setup([question], [{ ...running, status: "waiting_human" }]);
    fireEvent.click(screen.getByRole("button", { name: /跳到执行过程/ }));
    expect(jump.jumpToProcess).toHaveBeenCalledWith("task", { invocationIds: ["task"] });
  });

  it("排队中的指向同一个 Agent 正在做的那张卡", () => {
    const other: ChatMessage = { ...question, id: "other", seq: 6371, content: "另一件事" };
    const queued: Invocation = {
      ...running,
      id: "queued",
      messageId: other.id,
      status: "queued",
      startedAt: undefined,
    };
    const { jump } = setup([question, other], [running, queued]);
    const buttons = screen.getAllByRole("button", { name: /跳到执行过程/ });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1]!);
    expect(jump.jumpToProcess).toHaveBeenCalledWith("task", { invocationIds: ["queued"] });
  });

  it("完成后只留「查看回复」，跳过去时状态条也闪", () => {
    const { jump } = setup(
      [question, reply],
      [{ ...running, status: "completed", replyMessageId: reply.id, finishedAt: at }],
    );
    expect(screen.queryByRole("button", { name: /跳到执行过程/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /跳到回复/ }));
    expect(jump.jumpToMessage).toHaveBeenCalledWith("reply");
    expect(jump.flashOrigin).toHaveBeenCalledWith({ invocationIds: ["task"] });
  });

  it("被跳到的状态条和过程卡带高亮", () => {
    const { view } = setup([question], [running], { invocationIds: ["task"] });
    const flashed = view.container.querySelectorAll(".jump-flash");
    expect([...flashed].map((element) => element.className.split(" ")[0])).toEqual([
      "invocation-chip",
      "thinking-card",
    ]);
  });
});

describe("过程卡 → 原消息", () => {
  it("一行模式也留「#N」入口，点了跳回原消息、卡片和状态条一起闪", () => {
    const { jump } = setup([question], [{ ...running, status: "waiting_human" }]);
    // 等你回答时卡片默认只留一行
    const chip = screen.getByRole("button", {
      name: "跳到原消息 #6370：过程卡片和原问题之间要能双向跳转",
    });
    expect(chip.textContent).toBe("#6370");
    fireEvent.click(chip);
    expect(jump.jumpToMessage).toHaveBeenCalledWith("question");
    expect(jump.flashOrigin).toHaveBeenCalledWith({ invocationIds: ["task"] });
  });
});

describe("回复 → 原问题", () => {
  it("Agent 的最终回复有「回应 #N」，跳回原问题并闪回复和状态条", () => {
    const { jump } = setup(
      [question, reply],
      [{ ...running, status: "completed", replyMessageId: reply.id, finishedAt: at }],
    );
    const link = screen.getByRole("button", { name: /^跳到原消息 #6370/ });
    expect(link.textContent).toBe("回应 #6370");
    fireEvent.click(link);
    expect(jump.jumpToMessage).toHaveBeenCalledWith("question");
    expect(jump.flashOrigin).toHaveBeenCalledWith({
      messageIds: ["reply"],
      invocationIds: ["task"],
    });
  });

  it("没有调用记录时按 parentMessageId；原消息不在已加载范围就按 seq 往前补拉", () => {
    const { jump } = setup([reply], []);
    fireEvent.click(screen.getByRole("button", { name: "跳到它回应的那条消息" }));
    expect(jump.jumpToMessage).not.toHaveBeenCalled();
    expect(jump.locateMessage).toHaveBeenCalledWith({ messageId: "question", messageSeq: 1400 });
  });

  it("原消息撤回了不给入口；进度消息也不给", () => {
    setup(
      [
        { ...question, deletedAt: at, content: "" },
        reply,
        { ...reply, id: "p", seq: 6401, kind: "progress" },
      ],
      [],
    );
    expect(screen.queryByRole("button", { name: /跳到原消息|跳到它回应/ })).toBeNull();
  });
});

describe("jumpToProcess", () => {
  it("滚到过程卡并让两头都闪；找不到卡片时返回 false", () => {
    vi.useFakeTimers();
    const list = document.createElement("div");
    const card = document.createElement("article");
    card.className = "thinking-card";
    card.dataset.invocationId = "task";
    card.scrollIntoView = vi.fn();
    list.append(card);
    const scroll = {
      messageListRef: { current: list },
      bottomAnimationRef: { current: 0 },
      detachAnimationCancelRef: { current: undefined },
      nearBottomRef: { current: true },
    };
    const { result } = renderHook(() =>
      useMessageJump({
        messages: [],
        messagesLoaded: true,
        setMessages: vi.fn(),
        meta: undefined,
        authToken: undefined,
        base: "",
        currentRoomId: "general",
        currentRoomIdRef: { current: "general" },
        currentTopic: undefined,
        visibleLimit: 25,
        setVisibleLimit: vi.fn(),
        setExpandedTopicId: vi.fn(),
        setOpenMachineIds: vi.fn(),
        closeMobilePanel: vi.fn(),
        setError: vi.fn(),
        setGotoNotice: vi.fn(),
        scroll: scroll as never,
        timeline: [],
      }),
    );
    let found = false;
    act(() => {
      found = result.current.jumpToProcess("task", { invocationIds: ["chip"] });
    });
    expect(found).toBe(true);
    expect(card.scrollIntoView).toHaveBeenCalled();
    expect([...result.current.flash.invocationIds]).toEqual(["task", "chip"]);
    act(() => {
      vi.advanceTimersByTime(2300);
    });
    expect(result.current.flash.invocationIds.size).toBe(0);
    act(() => {
      found = result.current.jumpToProcess("missing");
    });
    expect(found).toBe(false);
    vi.useRealTimers();
  });
});
