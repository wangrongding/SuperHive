// @vitest-environment jsdom

import { useRef, useState } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, MetaResponse, Participant } from "@superhive/protocol";
import { useRoomConnection } from "./use-room-connection";
import { useRoomData } from "./use-room-data";
import { RoomCache } from "./room-cache";
import { RoomTimelineLoading } from "./room-timeline-loading";
import { useMessageScroll } from "./use-message-scroll";
import { buildTimeline } from "./timeline";
import { render, screen } from "@testing-library/react";

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  private listeners = new Map<string, Array<(event: Event) => void>>();
  constructor() {
    FakeSocket.instances.push(this);
  }
  addEventListener(type: string, callback: (event: Event) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  emit(type: string, event: Event) {
    for (const callback of this.listeners.get(type) ?? []) callback(event);
  }
  open() {
    this.readyState = 1;
    this.emit("open", new Event("open"));
  }
  close() {
    this.readyState = 3;
    this.emit("close", new Event("close"));
  }
  receive(event: object) {
    this.emit("message", new MessageEvent("message", { data: JSON.stringify(event) }));
  }
}

const meta = { wsUrl: "ws://localhost/ws" } as MetaResponse;
const person = (roomId: string): Participant => ({
  id: roomId,
  roomId,
  username: "Alice",
  type: "human",
  status: "online",
  joinedAt: "2026-11-26T00:00:00Z",
  lastSeenAt: "2026-11-26T00:00:00Z",
});
const message = (roomId: string, seq: number): ChatMessage => ({
  id: `${roomId}-${seq}`,
  roomId,
  seq,
  senderId: roomId,
  senderName: "Alice",
  senderType: "human",
  content: `${roomId} ${seq}`,
  mentions: [],
  traceId: roomId,
  hopCount: 0,
  createdAt: "2026-11-26T00:00:00Z",
});
const snapshot = (
  roomId: string,
  messages: ChatMessage[] = [],
  features = ["room.switch"],
): object => ({
  type: "room.snapshot",
  self: person(roomId),
  participants: [person(roomId)],
  messages,
  latestSeq: messages.at(-1)?.seq ?? 0,
  invocations: [],
  whiteboard: [],
  approvals: [],
  features,
});
const noOp = () => undefined;
const pluginsChanged = vi.fn();

function useHarness() {
  const [currentRoomId, setRoomId] = useState("general");
  const [state, setConnectionState] = useState<"connecting" | "online" | "offline">("connecting");
  const [error, setError] = useState<string>();
  const room = useRoomData({ base: "", authToken: "test-token", currentRoomId });
  const switchRoom = (roomId: string) => {
    room.activateRoom(roomId, { scrollTop: 240, nearBottom: false, visibleLimit: 50 });
    setRoomId(roomId);
  };
  useRoomConnection({
    meta,
    username: "Alice",
    authToken: "test-token",
    base: "",
    currentRoomId,
    room,
    refreshRooms: async () => undefined,
    switchRoom,
    upsertRoom: noOp,
    setRooms: noOp,
    onAccessLost: noOp,
    setConnectionState,
    setError,
    setArtifactsEpoch: noOp,
    setPendingNewMessages: noOp,
    setRecallCandidateId: noOp,
    setWorktreeNotices: noOp,
    worktreeNoticeVersion: useRef(0),
    setPendingAnswers: noOp,
    notificationPreferencesRef: useRef({
      messageNotifications: "off",
      notificationSound: false,
      presenceNotifications: false,
    }),
    slowOpsRef: useRef(undefined),
    setIncidentAttention: noOp,
    onPluginsChanged: pluginsChanged,
    attentionRef: useRef(undefined),
    globalEventsRef: useRef({
      onInvocation: noOp,
      onSchedule: noOp,
      onRoomActivity: noOp,
      onReadState: noOp,
      onSnapshot: noOp,
    }),
  });
  return { room, switchRoom, state, error, currentRoomId };
}

describe("single connection room navigation", () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ messages: [], latestSeq: 0 }))),
    );
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  function start(features = ["room.switch"], messages = [message("general", 1)]) {
    const hook = renderHook(useHarness);
    const socket = FakeSocket.instances[0]!;
    act(() => {
      socket.open();
      socket.receive(snapshot("general", messages, features));
    });
    return { ...hook, socket };
  }

  it("switches without reconnecting, restores cached data immediately, and catches up", async () => {
    const { result, socket } = start();
    act(() => result.current.switchRoom("second"));
    expect(FakeSocket.instances).toHaveLength(1);
    expect(socket.sent.at(-1)).toEqual({ type: "room.switch", roomId: "second" });
    expect(result.current.state).toBe("online");
    expect(result.current.room.socketRef.current).toBeUndefined();
    act(() => socket.receive(snapshot("second", [message("second", 2)])));
    act(() => result.current.switchRoom("general"));
    expect(result.current.room.messagesLoaded).toBe(true);
    expect(result.current.room.messages).toEqual([message("general", 1)]);
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ messages: [message("general", 2)], latestSeq: 2 })),
    );
    await act(async () => socket.receive(snapshot("general", [message("general", 2)])));
    expect(fetch).toHaveBeenCalledWith(
      "/api/rooms/general/messages?afterSeq=1&limit=500",
      expect.anything(),
    );
    expect(result.current.room.messages.map((item) => item.seq)).toEqual([1, 2]);
    expect(socket.sent.filter((event) => event.type === "participant.join")).toHaveLength(1);
  });

  it("still delivers plugins.changed after switching rooms on the same connection", () => {
    pluginsChanged.mockClear();
    const { result, socket } = start();
    act(() => result.current.switchRoom("second"));
    // 切换中（新房间快照还没到）也要收：插件列表按房间取，版本号只负责触发重取
    act(() => socket.receive({ type: "plugins.changed" }));
    act(() => socket.receive(snapshot("second", [message("second", 1)])));
    act(() => socket.receive({ type: "plugins.changed" }));
    expect(FakeSocket.instances).toHaveLength(1);
    expect(pluginsChanged).toHaveBeenCalledTimes(2);
  });

  it("falls back to reconnecting when the snapshot advertises no switch support", () => {
    const { result, socket } = start([]);
    act(() => result.current.switchRoom("second"));
    expect(socket.readyState).toBe(3);
    expect(socket.sent.some((event) => event.type === "room.switch")).toBe(false);
    expect(FakeSocket.instances).toHaveLength(2);
    const next = FakeSocket.instances[1]!;
    act(() => next.open());
    expect(next.sent[0]).toMatchObject({ type: "participant.join", roomId: "second" });
  });

  it("reconnects to the latest selected room, then resumes afterSeq catch-up", async () => {
    const { result, socket } = start();
    act(() => {
      result.current.switchRoom("second");
      socket.close();
    });
    act(() => vi.advanceTimersByTime(500));
    const next = FakeSocket.instances[1]!;
    act(() => next.open());
    expect(next.sent[0]?.roomId).toBe("second");
    act(() => next.receive(snapshot("second", [message("second", 3)])));
    act(() => next.close());
    act(() => vi.advanceTimersByTime(500));
    const reconnected = FakeSocket.instances[2]!;
    await act(async () => {
      reconnected.open();
      reconnected.receive(snapshot("second", [message("second", 4)]));
    });
    expect(fetch).toHaveBeenCalledWith(
      "/api/rooms/second/messages?afterSeq=3&limit=500",
      expect.anything(),
    );
    expect(result.current.state).toBe("online");
  });

  it("serializes rapid switches and ignores a stale snapshot and foreign presence", () => {
    const { result, socket } = start();
    act(() => result.current.switchRoom("second"));
    act(() => result.current.switchRoom("general"));
    expect(result.current.room.socketRef.current).toBeUndefined();
    act(() => socket.receive(snapshot("second", [message("second", 5)])));
    expect(result.current.room.messages.map((item) => item.roomId)).toEqual(["general"]);
    expect(socket.sent.at(-1)).toEqual({ type: "room.switch", roomId: "general" });
    act(() => socket.receive({ type: "presence.changed", participant: person("second") }));
    expect(result.current.room.participants.map((item) => item.roomId)).toEqual(["general"]);
  });

  it("discards a catch-up response after switching away and back", async () => {
    const { result, socket } = start();
    act(() => result.current.switchRoom("second"));
    act(() => socket.receive(snapshot("second")));
    act(() => result.current.switchRoom("general"));
    let finish: (response: Response) => void = noOp;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    act(() => socket.receive(snapshot("general")));
    act(() => result.current.switchRoom("second"));
    await act(async () =>
      finish(new Response(JSON.stringify({ messages: [message("general", 99)], latestSeq: 99 }))),
    );
    expect(result.current.room.messages).toEqual([]);
    expect(result.current.room.latestSeqRef.current).toBe(0);
  });

  it("continues catch-up beyond one server page and also catches up an empty cached room", async () => {
    const { result, socket } = start(["room.switch"], []);
    act(() => result.current.switchRoom("second"));
    act(() => socket.receive(snapshot("second")));
    act(() => result.current.switchRoom("general"));
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ messages: [message("general", 500)], latestSeq: 501 })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ messages: [message("general", 501)], latestSeq: 501 })),
      );
    await act(async () => socket.receive(snapshot("general", [message("general", 501)])));
    expect(fetch).toHaveBeenCalledWith(
      "/api/rooms/general/messages?afterSeq=0&limit=500",
      expect.anything(),
    );
    expect(fetch).toHaveBeenCalledWith(
      "/api/rooms/general/messages?afterSeq=500&limit=500",
      expect.anything(),
    );
    expect(result.current.room.messages.map((item) => item.seq)).toEqual([500, 501]);
  });

  it("returns to the subscribed room after a rejected switch without closing the connection", () => {
    const { result, socket } = start();
    act(() => result.current.switchRoom("missing"));
    act(() => socket.receive({ type: "error", code: "ROOM_NOT_FOUND", message: "Missing room" }));
    expect(result.current.currentRoomId).toBe("general");
    expect(result.current.room.messagesLoaded).toBe(true);
    expect(result.current.error).toBe("Missing room");
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("joins the latest room if navigation happens before the socket opens", () => {
    const { result } = renderHook(useHarness);
    act(() => result.current.switchRoom("second"));
    const socket = FakeSocket.instances[0]!;
    act(() => socket.open());
    expect(socket.sent[0]?.roomId).toBe("second");
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("refreshes cached recalls outside the recent snapshot and drops messages removed by a clear", async () => {
    const { result, socket } = start();
    act(() => result.current.switchRoom("second"));
    act(() => socket.receive(snapshot("second")));
    act(() => result.current.switchRoom("general"));
    const deleted = { ...message("general", 1), content: "", deletedAt: "2026-11-26T01:00:00Z" };
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ messages: [message("general", 3)], latestSeq: 3 })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ messages: [deleted, message("general", 3)], latestSeq: 3 })),
      );
    await act(async () =>
      socket.receive({
        ...(snapshot("general", [message("general", 3)]) as Record<string, unknown>),
        firstSeq: 1,
      }),
    );
    expect(result.current.room.messages[0]?.deletedAt).toBe(deleted.deletedAt);
    act(() =>
      socket.receive({
        ...(snapshot("general", [message("general", 4)]) as Record<string, unknown>),
        firstSeq: 4,
      }),
    );
    expect(result.current.room.messages.map((item) => item.seq)).toEqual([4]);
  });

  it("does not undo a recall with an older in-flight HTTP response", async () => {
    const { result, socket } = start();
    act(() => result.current.switchRoom("second"));
    act(() => socket.receive(snapshot("second")));
    act(() => result.current.switchRoom("general"));
    let finish: (response: Response) => void = noOp;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    act(() => socket.receive(snapshot("general", [message("general", 2)])));
    const deleted = { ...message("general", 1), content: "", deletedAt: "2026-11-26T01:00:00Z" };
    act(() => socket.receive({ type: "message.deleted", message: deleted }));
    await act(async () =>
      finish(
        new Response(
          JSON.stringify({
            messages: [message("general", 1), message("general", 2)],
            latestSeq: 2,
          }),
        ),
      ),
    );
    expect(result.current.room.messages[0]?.deletedAt).toBe(deleted.deletedAt);
  });
});

describe("room loading and cache", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });
  it("keeps only five recently used rooms and promotes cache hits", () => {
    const cache = new RoomCache<number>();
    for (let index = 0; index < 5; index++) cache.set(String(index), index);
    cache.get("0");
    cache.set("5", 5);
    expect(cache.get("1")).toBeUndefined();
    expect(cache.get("0")).toBe(0);
  });
  it("does not flash a logo or skeleton before 300ms", () => {
    vi.useFakeTimers();
    const { container } = render(<RoomTimelineLoading />);
    expect(container.innerHTML).toBe("");
    act(() => vi.advanceTimersByTime(299));
    expect(container.innerHTML).toBe("");
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole("status").className).toBe("room-timeline-skeleton");
    expect(container.querySelector("svg")).toBeNull();
  });
  it("restores reading position instead of scrolling cached messages to the bottom", () => {
    const messages = [message("general", 1)];
    const { result, rerender } = renderHook(
      ({ messages }: { messages: ChatMessage[] }) =>
        useMessageScroll({ messages, username: "Reader", timeline: buildTimeline(messages) }),
      { initialProps: { messages } },
    );
    const list = document.createElement("div");
    const content = document.createElement("div");
    list.append(content);
    document.body.append(list);
    const scrollTo = vi.fn();
    list.scrollTo = scrollTo;
    Object.defineProperties(list, { scrollHeight: { value: 2000 }, clientHeight: { value: 500 } });
    result.current.messageListRef.current = list;
    act(() => result.current.setScrollContentElement(content));
    scrollTo.mockClear();
    act(() =>
      result.current.restoreRoomScroll({ scrollTop: 240, nearBottom: false, visibleLimit: 50 }),
    );
    rerender({ messages: [...messages] });
    expect(scrollTo).toHaveBeenCalledWith({ top: 240, behavior: "instant" });
    expect(result.current.nearBottomRef.current).toBe(false);
    scrollTo.mockClear();
    rerender({ messages: [...messages, message("general", 2)] });
    expect(scrollTo).not.toHaveBeenCalled();
    list.remove();
  });
  it("does not reuse cached room data across credentials", () => {
    const { result, rerender } = renderHook(
      ({ authToken }) => useRoomData({ base: "", authToken, currentRoomId: "general" }),
      { initialProps: { authToken: "first" } },
    );
    act(() => {
      result.current.setMessages([message("general", 1)]);
      result.current.setMessagesLoaded(true);
    });
    act(() =>
      result.current.activateRoom("second", { scrollTop: 0, nearBottom: true, visibleLimit: 25 }),
    );
    rerender({ authToken: "second" });
    act(() =>
      result.current.activateRoom("general", { scrollTop: 0, nearBottom: true, visibleLimit: 25 }),
    );
    expect(result.current.messages).toEqual([]);
    expect(result.current.messagesLoaded).toBe(false);
  });
});
