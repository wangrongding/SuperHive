// @vitest-environment jsdom

import { useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, Invocation, MetaResponse } from "@superhive/protocol";
import { useMessageJump, useMessageWindow } from "./use-message-timeline";
import type { MessageScroll } from "./use-message-scroll";

const at = "2026-11-26T00:00:00.000Z";
const invocation = {
  id: crypto.randomUUID(),
  roomId: "other",
  messageId: crypto.randomUUID(),
  agentId: crypto.randomUUID(),
  agentName: "helper",
  requesterName: "rd",
  requesterType: "human",
  status: "waiting_human",
  attempts: 1,
  createdAt: at,
  updatedAt: at,
} as Invocation;
const message = (seq: number, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id: crypto.randomUUID(),
  roomId: "other",
  seq,
  senderId: invocation.agentId,
  senderName: "helper",
  senderType: "agent",
  content: `消息 ${seq}`,
  mentions: [],
  traceId: crypto.randomUUID(),
  hopCount: 0,
  createdAt: at,
  ...extra,
});
const trigger = message(10, { id: invocation.messageId, senderType: "human" });
const question = message(20, { kind: "question", parentMessageId: trigger.id });
const meta = {} as MetaResponse;
const setError = vi.fn();
const setGotoNotice = vi.fn();
const closeMobilePanel = vi.fn();
let jump: ReturnType<typeof useMessageJump>;
let latestMessages: ChatMessage[];
const scrollIntoView = vi.fn();

function Harness({
  snapshot,
  roomId = "other",
  ready = true,
}: {
  snapshot: ChatMessage[];
  roomId?: string;
  ready?: boolean;
}) {
  const [messages, setMessages] = useState(snapshot);
  const previousSnapshot = useRef(snapshot);
  if (previousSnapshot.current !== snapshot) {
    previousSnapshot.current = snapshot;
    setMessages(snapshot);
  }
  latestMessages = messages;
  const window = useMessageWindow({ messages });
  const messageListRef = useRef<HTMLDivElement>(null);
  const currentRoomIdRef = useRef(roomId);
  currentRoomIdRef.current = roomId;
  const scroll = {
    messageListRef,
    bottomAnimationRef: useRef(0),
    detachAnimationCancelRef: useRef(undefined),
    nearBottomRef: useRef(true),
  } as unknown as MessageScroll;
  jump = useMessageJump({
    messages,
    messagesLoaded: ready,
    setMessages,
    meta,
    authToken: "test",
    base: "",
    currentRoomId: roomId,
    currentRoomIdRef,
    ...window,
    setOpenMachineIds: vi.fn(),
    closeMobilePanel,
    setError,
    setGotoNotice,
    scroll,
  });
  return (
    <>
      <button>保持焦点</button>
      <div ref={messageListRef}>
        {window.timeline.map(({ message: item }) => (
          <article
            key={item.id}
            data-message-id={item.id}
            className={jump.highlightedMessageId === item.id ? "highlighted" : ""}
          >
            {item.content}
            {item.kind === "question" && !item.deletedAt && (
              <div className="question-options">
                <button>选项</button>
              </div>
            )}
          </article>
        ))}
      </div>
    </>
  );
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function respond(messages: ChatMessage[], latestSeq = messages.at(-1)?.seq ?? 0) {
  return new Response(JSON.stringify({ messages, latestSeq }), { status: 200 });
}

describe("attention message navigation", () => {
  it("keeps options centered through delayed layout and stops tracking on user input", async () => {
    let resize!: ResizeObserverCallback;
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          resize = callback;
        }
        observe = vi.fn();
        disconnect = disconnect;
      },
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    render(<Harness snapshot={[trigger, question]} />);
    act(() => jump.locateAttention(invocation));
    await waitFor(() => expect(jump.highlightedMessageId).toBe(question.id));
    const before = scrollIntoView.mock.calls.length;
    act(() => resize([], {} as ResizeObserver));
    expect(scrollIntoView.mock.calls.length).toBe(before + 1);
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "center", behavior: "auto" });
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(disconnect).toHaveBeenCalled();
  });

  it("expands an old topic and centers the options without taking keyboard focus", async () => {
    const snapshot = [
      trigger,
      question,
      message(21, { kind: "topic" }),
      ...Array.from({ length: 40 }, (_, index) => message(30 + index)),
    ];
    render(<Harness snapshot={snapshot} />);
    const focus = screen.getByRole("button", { name: "保持焦点" });
    focus.focus();
    expect(screen.queryByText(question.content)).toBeNull();
    act(() => jump.locateAttention(invocation));
    await waitFor(() => expect(jump.highlightedMessageId).toBe(question.id));
    expect(scrollIntoView.mock.instances.at(-1)).toBe(
      screen.getByRole("button", { name: "选项" }).parentElement,
    );
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });
    expect(document.activeElement).toBe(focus);
    expect(fetch).not.toHaveBeenCalled();
    vi.useFakeTimers();
    act(() => jump.setHighlightedMessageId(undefined));
    act(() => jump.setHighlightedMessageId(question.id));
    act(() => vi.advanceTimersByTime(2300));
    expect(jump.highlightedMessageId).toBeUndefined();
  });

  it("waits for the destination snapshot, even when an unrelated message arrives first", async () => {
    const view = render(
      <Harness snapshot={[message(1, { roomId: "general" })]} roomId="general" />,
    );
    act(() => jump.locateAttention(invocation, trigger.seq));
    expect(fetch).not.toHaveBeenCalled();
    view.rerender(<Harness snapshot={[message(100)]} roomId="other" ready={false} />);
    expect(fetch).not.toHaveBeenCalled();
    view.rerender(<Harness snapshot={[trigger, question]} roomId="other" />);
    await waitFor(() => expect(jump.highlightedMessageId).toBe(question.id));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("loads an older question by the trigger sequence and picks the latest non-recalled question", async () => {
    const newer = message(25, { kind: "question", parentMessageId: trigger.id });
    const recalled = message(26, { kind: "question", parentMessageId: trigger.id, deletedAt: at });
    vi.mocked(fetch)
      .mockResolvedValueOnce(respond([trigger, question], 200))
      .mockResolvedValueOnce(respond([newer, recalled, message(200)], 200));
    render(<Harness snapshot={[message(200)]} />);
    act(() => jump.locateAttention(invocation, trigger.seq));
    await waitFor(() => expect(jump.highlightedMessageId).toBe(newer.id));
    expect(vi.mocked(fetch).mock.calls[0]![0]).toContain(
      "/api/rooms/other/messages?afterSeq=9&limit=500",
    );
    expect(vi.mocked(fetch).mock.calls[1]![0]).toContain("afterSeq=20");
    expect(latestMessages.some((item) => item.id === question.id)).toBe(true);
  });

  it("resolves an unloaded trigger by ID before using the existing sequence context", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond([trigger, question, message(200)], 200));
    render(<Harness snapshot={[message(200)]} />);
    act(() => jump.locateProgress({ messageId: trigger.id, invocation }));
    await waitFor(() => expect(jump.highlightedMessageId).toBe(question.id));
    expect(vi.mocked(fetch).mock.calls[0]![0]).toContain(`messageId=${trigger.id}&limit=500`);
  });

  it("falls back rather than selecting an unproven old question after the context limit", async () => {
    vi.mocked(fetch).mockImplementation(async () => respond([trigger, question], 10000));
    render(<Harness snapshot={[trigger]} />);
    act(() => jump.locateAttention(invocation));
    await waitFor(() => expect(jump.highlightedMessageId).toBe(trigger.id));
    expect(fetch).toHaveBeenCalledTimes(10);
  });

  it("falls back to the trigger when every matching question was recalled", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond([trigger, { ...question, deletedAt: at }], 20));
    render(<Harness snapshot={[trigger, { ...question, deletedAt: at }]} />);
    act(() => jump.locateAttention(invocation));
    await waitFor(() => expect(jump.highlightedMessageId).toBe(trigger.id));
    expect(screen.queryByRole("button", { name: "选项" })).toBeNull();
  });

  it.each(["blocked", "failed"] as const)(
    "keeps %s actions on the trigger card",
    async (status) => {
      render(<Harness snapshot={[trigger, question]} />);
      act(() => jump.locateAttention({ ...invocation, status }));
      await waitFor(() => expect(jump.highlightedMessageId).toBe(trigger.id));
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("loads an unseen result instead of its trigger, and falls back if the result is recalled", async () => {
    const reply = message(30);
    vi.mocked(fetch).mockResolvedValueOnce(respond([reply], 200));
    const view = render(<Harness snapshot={[trigger]} />);
    act(() =>
      jump.locateAttention({ ...invocation, status: "completed", replyMessageId: reply.id }),
    );
    await waitFor(() => expect(jump.highlightedMessageId).toBe(reply.id));
    expect(vi.mocked(fetch).mock.calls[0]![0]).toContain(`messageId=${reply.id}&limit=1`);
    view.rerender(<Harness snapshot={[trigger, { ...reply, deletedAt: at }]} />);
    vi.mocked(fetch)
      .mockResolvedValueOnce(respond([{ ...reply, deletedAt: at }], 200))
      .mockResolvedValueOnce(respond([trigger], 200));
    act(() =>
      jump.locateAttention({
        ...invocation,
        status: "completed",
        replyMessageId: reply.id,
      }),
    );
    await waitFor(() => expect(jump.highlightedMessageId).toBe(trigger.id));
  });

  it("does not merge or scroll stale results after switching rooms", async () => {
    let finish!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const view = render(<Harness snapshot={[message(200)]} />);
    act(() => jump.locateAttention(invocation, trigger.seq));
    view.rerender(<Harness snapshot={[message(1, { roomId: "general" })]} roomId="general" />);
    await act(async () => finish(respond([trigger, question], 20)));
    expect(jump.highlightedMessageId).toBeUndefined();
    expect(latestMessages.some((item) => item.id === question.id)).toBe(false);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
