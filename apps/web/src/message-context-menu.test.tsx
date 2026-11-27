// @vitest-environment jsdom
import { useState, type ComponentProps, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, Invocation, TraceStep } from "@superhive/protocol";
import { MessageList } from "./message-list";
import { ContextMenu, type ContextMenuState } from "./context-menu";
import type { GuestAccess } from "./access-gate";

vi.mock("./shadow-content", () => ({
  ShadowContent: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./message-markdown-lazy", () => ({
  MessageMarkdown: ({ content }: { content: string }) => (
    <div>
      {content.split("\n\n").map((part) =>
        part.startsWith("```") ? (
          <pre key={part}>
            <code>{part.replace(/```\w*\n?/g, "")}</code>
          </pre>
        ) : part.startsWith("http") ? (
          <a key={part} href={part}>
            {part}
          </a>
        ) : (
          <p key={part}>{part}</p>
        ),
      )}
    </div>
  ),
}));
vi.mock("./thinking-card", async (original) => ({
  ...(await original<typeof import("./thinking-card")>()),
  TraceRecap: ({ open, invocation }: { open?: boolean; invocation: Invocation }) => (
    <aside data-testid={`recap-${invocation.id}`}>{open ? "recap-open" : "recap-closed"}</aside>
  ),
}));

afterEach(() => {
  cleanup();
  document.getSelection()?.removeAllRanges();
});

const at = "2026-11-26T04:00:00.000Z";
const question: ChatMessage = {
  id: "00000000-0000-4000-8000-000000000001",
  roomId: "general",
  seq: 1,
  senderId: "alice",
  senderName: "Alice",
  senderType: "human",
  content: "@worker 帮我看看",
  mentions: ["worker"],
  traceId: "trace",
  hopCount: 0,
  createdAt: at,
};
const reply: ChatMessage = {
  ...question,
  id: "00000000-0000-4000-8000-000000000002",
  seq: 2,
  senderId: "worker",
  senderName: "worker",
  senderType: "agent",
  content: "看完了，结论如下\n\n```\nnpm test\n```\n\nhttps://example.com/doc",
  mentions: [],
};
const finished: Invocation = {
  id: "task",
  roomId: "general",
  messageId: question.id,
  agentId: "worker",
  agentName: "worker",
  requesterName: "Alice",
  requesterType: "human",
  status: "completed",
  replyMessageId: reply.id,
  attempts: 1,
  createdAt: at,
  updatedAt: at,
};
const steps: TraceStep[] = [{ id: "s", kind: "text", text: "过程", startedAt: at }];

type Props = ComponentProps<typeof MessageList>;
function makeProps(
  messages: ChatMessage[],
  overrides: Partial<Props> & { invocationList?: Invocation[] } = {},
) {
  const { invocationList = [finished], ...rest } = overrides;
  const composer = {
    textareaRef: { current: null },
    appendMention: vi.fn(),
    quoteMessage: vi.fn(),
  };
  const actions = {
    pendingAnswers: new Set(),
    copyMessageContent: vi.fn(),
    copySeqReference: vi.fn(),
    copyPlainText: vi.fn(),
    setRecallCandidateId: vi.fn(),
    retryInvocation: vi.fn(),
    cancelInvocation: vi.fn(),
    dismissInvocations: vi.fn(),
  };
  const jump = {
    jumpToMessage: vi.fn(),
    jumpToProcess: vi.fn(),
    locateMessage: vi.fn(),
    flashOrigin: vi.fn(),
    flash: { messageIds: new Set(), invocationIds: new Set() },
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
      releaseBottomPin: vi.fn(),
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
    composer: composer as unknown as Props["composer"],
    actions: actions as unknown as Props["actions"],
    messages,
    messagesLoaded: true,
    currentRoomName: "general",
    currentRoomId: "general",
    currentRoomWorkspace: "/repo",
    username: "Alice",
    guest: undefined,
    isOwner: true,
    base: "",
    authToken: undefined,
    connectionState: "online",
    participants: [],
    invocations: new Map(invocationList.map((item) => [item.id, item])),
    traces: new Map([[finished.id, steps]]),
    pendingApprovals: new Set(),
    agentProviderByName: new Map(),
    timeFormat: "24h",
    openMachineIds: new Set(),
    setOpenMachineIds: vi.fn(),
    openSenderMenu: vi.fn(),
    openContextMenu: vi.fn(),
    locateMessageFromMarkdown: vi.fn(),
    dockPreview: vi.fn(),
    setRetryModelFor: vi.fn(),
    localAgentFor: () => undefined,
    openAgentTerminal: vi.fn(),
    canViewWorkspace: true,
    openWorkspaceFor: vi.fn(),
    ...rest,
  };
  return { props, composer, actions, jump };
}

/** 和 App 一样：MessageList 通过 openContextMenu 交出菜单，外面用同一个 ContextMenu 画出来 */
function Harness({ props }: { props: Props }) {
  const [menu, setMenu] = useState<ContextMenuState>();
  return (
    <>
      <MessageList {...props} openContextMenu={setMenu} />
      <input aria-label="composer" />
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(undefined)} />}
    </>
  );
}

const ids: Record<string, string> = {
  帮我看看: "00000000-0000-4000-8000-000000000001",
  看完了: "00000000-0000-4000-8000-000000000002",
};
function articleOf(text: keyof typeof ids): HTMLElement {
  return document.querySelector<HTMLElement>(`article[data-message-id="${ids[text]}"]`)!;
}
function menuLabels(): string[] {
  return within(screen.getByRole("menu"))
    .getAllByRole("menuitem")
    .map((item) => item.querySelector("span")!.textContent!);
}

describe("消息右键菜单", () => {
  it("右击 Agent 回复弹出菜单：引用、复制、@ 它、看过程、看改动", () => {
    const { props } = makeProps([question, reply]);
    render(<Harness props={props} />);
    fireEvent.contextMenu(articleOf("看完了"), { clientX: 40, clientY: 50 });
    expect(menuLabels()).toEqual([
      "引用回复",
      "复制文本",
      "复制序号 #2",
      "复制消息链接",
      "@ worker",
      "看这一轮过程",
      "看它的改动",
    ]);
  });

  it("自己的消息：没有 @ 自己，有撤回；没有过程和改动", () => {
    const { props, actions } = makeProps([question, reply]);
    render(<Harness props={props} />);
    fireEvent.contextMenu(articleOf("帮我看看"), { clientX: 40, clientY: 50 });
    const labels = menuLabels();
    expect(labels).not.toContain("@ Alice");
    expect(labels).not.toContain("看这一轮过程");
    expect(labels).not.toContain("看它的改动");
    fireEvent.click(screen.getByRole("menuitem", { name: "撤回" }));
    expect(actions.setRecallCandidateId).toHaveBeenCalledWith(question.id);
  });

  it("引用 Agent 回复：交给输入框插引用块并顺手 @ 它", () => {
    const { props, composer } = makeProps([question, reply]);
    render(<Harness props={props} />);
    fireEvent.contextMenu(articleOf("看完了"), { clientX: 40, clientY: 50 });
    fireEvent.click(screen.getByRole("menuitem", { name: "引用回复" }));
    expect(composer.quoteMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: reply.id, seq: 2, content: reply.content }),
      { mention: "worker" },
    );
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("选中了消息里的一段：改成引用选中内容，并能复制选中内容", () => {
    const { props, composer, actions } = makeProps([question, reply]);
    render(<Harness props={props} />);
    const text = screen.getByText("看完了，结论如下").firstChild!;
    const select = () => {
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, 3);
      document.getSelection()!.removeAllRanges();
      document.getSelection()!.addRange(range);
    };
    select();
    fireEvent.contextMenu(articleOf("看完了"), { clientX: 40, clientY: 50 });
    expect(menuLabels().slice(0, 3)).toEqual(["引用选中内容", "复制选中内容", "复制文本"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "复制选中内容" }));
    expect(actions.copyPlainText).toHaveBeenCalledWith("看完了");
    select();
    fireEvent.contextMenu(articleOf("看完了"), { clientX: 40, clientY: 50 });
    fireEvent.click(screen.getByRole("menuitem", { name: "引用选中内容" }));
    expect(composer.quoteMessage).toHaveBeenCalledWith(expect.objectContaining({ id: reply.id }), {
      selection: "看完了",
      mention: "worker",
    });
  });

  it("选区在别的消息里时不算选中", () => {
    const { props } = makeProps([question, reply]);
    render(<Harness props={props} />);
    const text = articleOf("帮我看看").querySelector(".message-body p")!.firstChild!;
    const range = document.createRange();
    range.selectNodeContents(text);
    document.getSelection()!.addRange(range);
    fireEvent.contextMenu(articleOf("看完了"), { clientX: 40, clientY: 50 });
    expect(menuLabels()[0]).toBe("引用回复");
  });

  it("点在代码块、链接上额外给复制代码、复制链接", () => {
    const { props, actions } = makeProps([question, reply]);
    render(<Harness props={props} />);
    fireEvent.contextMenu(screen.getByText("npm test"), { clientX: 40, clientY: 50 });
    expect(menuLabels()[0]).toBe("复制代码");
    fireEvent.click(screen.getByRole("menuitem", { name: "复制代码" }));
    expect(actions.copyPlainText).toHaveBeenCalledWith("npm test");
    fireEvent.contextMenu(screen.getByRole("link"), { clientX: 40, clientY: 50 });
    expect(menuLabels()[0]).toBe("复制链接");
    fireEvent.click(screen.getByRole("menuitem", { name: "复制链接" }));
    expect(actions.copyPlainText).toHaveBeenCalledWith("https://example.com/doc");
  });

  it("复制消息链接是聊天里可点的 #序号 链接", () => {
    const { props, actions } = makeProps([question, reply]);
    render(<Harness props={props} />);
    fireEvent.contextMenu(articleOf("看完了"), { clientX: 40, clientY: 50 });
    fireEvent.click(screen.getByRole("menuitem", { name: /复制消息链接/ }));
    expect(actions.copyPlainText).toHaveBeenCalledWith(`[#2](#message/${reply.id}/2)`);
  });

  it("看这一轮过程：展开回复上方的过程回顾", () => {
    const { props } = makeProps([question, reply]);
    render(<Harness props={props} />);
    expect(screen.getByTestId("recap-task").textContent).toBe("recap-closed");
    fireEvent.contextMenu(articleOf("看完了"), { clientX: 40, clientY: 50 });
    fireEvent.click(screen.getByRole("menuitem", { name: "看这一轮过程" }));
    expect(screen.getByTestId("recap-task").textContent).toBe("recap-open");
  });

  it("失败的任务给重试，执行中的给停止", () => {
    const failed = { ...finished, status: "failed" as const, replyMessageId: undefined };
    const { props, actions } = makeProps([question], { invocationList: [failed] });
    const view = render(<Harness props={props} />);
    fireEvent.contextMenu(articleOf("帮我看看"), { clientX: 40, clientY: 50 });
    fireEvent.click(screen.getByRole("menuitem", { name: "重试 @worker" }));
    expect(actions.retryInvocation).toHaveBeenCalledWith(failed);
    view.unmount();

    const running = { ...finished, status: "running" as const, replyMessageId: undefined };
    const next = makeProps([question], { invocationList: [running] });
    render(<Harness props={next.props} />);
    fireEvent.contextMenu(articleOf("帮我看看"), { clientX: 40, clientY: 50 });
    fireEvent.click(screen.getByRole("menuitem", { name: "停止 @worker" }));
    expect(next.actions.cancelInvocation).toHaveBeenCalledWith(running);
  });

  it("访客：邀请不让 @ Agent 时不给 @，引用也不补 @；不让看过程时不给看过程", () => {
    const guest = { allowAgents: false, showTrace: false } as unknown as GuestAccess;
    const { props, composer } = makeProps([question, reply], {
      guest,
      isOwner: false,
      canViewWorkspace: false,
    });
    render(<Harness props={props} />);
    fireEvent.contextMenu(articleOf("看完了"), { clientX: 40, clientY: 50 });
    expect(menuLabels()).toEqual(["引用回复", "复制文本", "复制序号 #2", "复制消息链接"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "引用回复" }));
    expect(composer.quoteMessage).toHaveBeenCalledWith(expect.anything(), {});
  });

  it("分享模式、已撤回的消息、可编辑区域保留浏览器原生菜单", () => {
    const recalled = { ...reply, content: "", deletedAt: at };
    const { props } = makeProps([question, recalled]);
    render(<Harness props={props} />);
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    screen.getByText("worker 撤回了一条消息").dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByRole("menu")).toBeNull();

    cleanup();
    const shared = makeProps([question, reply], {
      share: {
        shareMode: true,
        selectedMessageIds: new Set(),
        toggleMessageSelected: vi.fn(),
      } as unknown as Props["share"],
    });
    render(<Harness props={shared.props} />);
    fireEvent.contextMenu(articleOf("看完了"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("键盘：菜单键 / Shift+F10 在消息里打开，Esc 关闭后焦点回到原处", () => {
    const { props } = makeProps([question, reply]);
    render(<Harness props={props} />);
    const article = articleOf("看完了");
    const more = within(article).getByRole("button", { name: "更多操作" });
    more.focus();
    // 键盘触发的 contextmenu 坐标是 0，菜单贴着消息弹出
    fireEvent.contextMenu(more, { clientX: 0, clientY: 0 });
    const menu = screen.getByRole("menu");
    expect(document.activeElement).toBe(menu);
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(more);

    // 操作条上的「更多」按钮点开是同一份菜单
    fireEvent.click(more);
    expect(menuLabels()[0]).toBe("引用回复");
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Enter" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("悬停操作条的「引用」按钮和右键引用回复是同一个动作", () => {
    const { props, composer } = makeProps([question, reply]);
    render(<Harness props={props} />);
    fireEvent.click(within(articleOf("看完了")).getByRole("button", { name: "引用回复 #2" }));
    expect(composer.quoteMessage).toHaveBeenCalledWith(expect.objectContaining({ id: reply.id }), {
      mention: "worker",
    });
  });
});

describe("执行中卡片的右键菜单", () => {
  it("跳回在处理的消息、@ 它、停止这一轮", () => {
    const running = { ...finished, status: "running" as const, replyMessageId: undefined };
    const { props, jump, actions, composer } = makeProps([question], {
      invocationList: [running],
    });
    render(<Harness props={props} />);
    const card = document.querySelector<HTMLElement>(".thinking-card")!;
    fireEvent.contextMenu(card, { clientX: 40, clientY: 50 });
    expect(menuLabels()).toEqual(["跳到在处理的 #1", "@ worker", "停止这一轮"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "跳到在处理的 #1" }));
    expect(jump.jumpToMessage).toHaveBeenCalledWith(question.id);
    fireEvent.contextMenu(card, { clientX: 40, clientY: 50 });
    fireEvent.click(screen.getByRole("menuitem", { name: "@ worker" }));
    expect(composer.appendMention).toHaveBeenCalledWith("worker");
    fireEvent.contextMenu(card, { clientX: 40, clientY: 50 });
    fireEvent.click(screen.getByRole("menuitem", { name: "停止这一轮" }));
    expect(actions.cancelInvocation).toHaveBeenCalledWith(running);
  });
});

describe("引用卡片", () => {
  const quoting: ChatMessage = {
    ...question,
    id: "00000000-0000-4000-8000-000000000003",
    seq: 3,
    content: "> #2 · worker\n> 看完了，结论如下\n\n@worker 那就这样",
    quote: { messageId: reply.id, seq: 2, senderName: "worker" },
  };

  it("引用块渲染成卡片，点了跳回原消息并让两头一起闪", () => {
    const { props, jump } = makeProps([question, reply, quoting]);
    render(<Harness props={props} />);
    const card = screen.getByRole("button", { name: "跳到引用的原消息 #2（worker）" });
    expect(card.textContent).toContain("看完了，结论如下");
    // 正文里不再重复出现引用块
    expect(screen.queryByText(/> #2 · worker/)).toBeNull();
    expect(screen.getByText("@worker 那就这样")).toBeTruthy();
    act(() => card.click());
    expect(jump.jumpToMessage).toHaveBeenCalledWith(reply.id);
    expect(jump.flashOrigin).toHaveBeenCalledWith({ messageIds: [quoting.id] });
  });

  it("原消息没载入时按序号补拉再定位", () => {
    const { props, jump } = makeProps([quoting]);
    render(<Harness props={props} />);
    fireEvent.click(screen.getByRole("button", { name: /跳到引用的原消息 #2/ }));
    expect(jump.locateMessage).toHaveBeenCalledWith({ messageId: reply.id, messageSeq: 2 });
  });

  it("原消息撤回了：显示原消息已不可见，不露出摘录", () => {
    const { props } = makeProps([question, { ...reply, content: "", deletedAt: at }, quoting]);
    render(<Harness props={props} />);
    expect(screen.getByText("原消息已不可见")).toBeTruthy();
    expect(screen.queryByText(/看完了，结论如下/)).toBeNull();
    expect(screen.queryByRole("button", { name: /跳到引用的原消息/ })).toBeNull();
  });
});

describe("回答提问的卡片", () => {
  const asked: ChatMessage = {
    ...reply,
    id: "00000000-0000-4000-8000-000000000004",
    seq: 4,
    kind: "question",
    content: "@Alice ❓ 群-351 选哪种做法？\nA. 先停掉接管\nB. 换一台云机",
    question: {
      options: [
        { key: "A", label: "先停掉接管" },
        { key: "B", label: "换一台云机" },
      ],
      multiple: false,
    },
  };
  const answered: ChatMessage = {
    ...question,
    id: "00000000-0000-4000-8000-000000000005",
    seq: 5,
    content: "其它：这个问题是谁提出来的啊?",
    mentions: [],
    replyToMessageId: asked.id,
    answer: {
      questionMessageId: asked.id,
      questionSeq: 4,
      selected: [],
      other: "这个问题是谁提出来的啊?",
    },
  };

  it("点选回答顶上显示「回答提问 #4」和提问摘要，点了跳回提问", () => {
    const { props, jump } = makeProps([asked, answered]);
    render(<Harness props={props} />);
    const card = screen.getByRole("button", { name: "跳到回答的提问 #4" });
    expect(card.textContent).toContain("回答提问");
    expect(card.textContent).toContain("#4");
    expect(card.textContent).toContain("群-351 选哪种做法");
    expect(card.textContent).not.toContain("@Alice");
    // 回答正文照常显示
    expect(screen.getByText("其它：这个问题是谁提出来的啊?")).toBeTruthy();
    act(() => card.click());
    expect(jump.jumpToMessage).toHaveBeenCalledWith(asked.id);
  });

  it("提问早已不在已载入的消息里：按 questionSeq 补拉定位", () => {
    const { props, jump } = makeProps([answered]);
    render(<Harness props={props} />);
    fireEvent.click(screen.getByRole("button", { name: "跳到回答的提问 #4" }));
    expect(jump.locateMessage).toHaveBeenCalledWith({ messageId: asked.id, messageSeq: 4 });
  });

  it("手打回复提问同样显示；回复普通消息不显示", () => {
    const typed = { ...answered, answer: undefined, content: "选 A 吧" };
    const { props } = makeProps([asked, typed]);
    render(<Harness props={props} />);
    expect(screen.getByRole("button", { name: "跳到回答的提问 #4" })).toBeTruthy();
    cleanup();
    const plain = { ...typed, replyToMessageId: reply.id };
    const second = makeProps([reply, plain]);
    render(<Harness props={second.props} />);
    expect(screen.queryByRole("button", { name: /跳到回答的提问/ })).toBeNull();
  });

  it("提问撤回了：显示原提问已不可见", () => {
    const { props } = makeProps([{ ...asked, content: "", deletedAt: at }, answered]);
    render(<Harness props={props} />);
    expect(screen.getByText("原提问已不可见")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /跳到回答的提问/ })).toBeNull();
  });
});
