import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import {
  RoomClient,
  RoomClientError,
  fetchRooms,
  type RoomClientHandlers,
  type Snapshot,
} from "./room-client.js";
import type { ChatMessage, RoomSummary, ServerEvent } from "./hive-protocol.js";

function waitFor<T>(
  register: (resolve: (value: T) => void) => void,
  timeoutMs = 2_000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), timeoutMs);
    register((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

describe("RoomClient", () => {
  let server: WebSocketServer | undefined;
  let client: RoomClient | undefined;

  afterEach(async () => {
    client?.stop();
    client = undefined;
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
    vi.unstubAllGlobals();
  });

  it("reads a receipt result at its exact sequence without truncating the content", async () => {
    const message = {
      id: "00000000-0000-4000-8000-000000000001",
      seq: 43,
      content: "完整证据".repeat(2000) + "结果末尾",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ messages: [message], latestSeq: 50 })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ messages: [{ ...message, seq: 44 }], latestSeq: 50 })),
      )
      .mockResolvedValueOnce(new Response("denied", { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    client = new RoomClient(
      {
        serverUrl: "http://hive.test:8787",
        roomId: "general",
        username: "test-agent",
        token: "test-token",
      },
      { onSnapshot: () => undefined, onMention: () => undefined, onError: () => undefined },
    );
    expect(await client.fetchMessageAt(message.seq, message.id)).toEqual(message);
    const [requestUrl, requestOptions] = fetchMock.mock.calls[0]!;
    expect(String(requestUrl)).toBe(
      "http://hive.test:8787/api/rooms/general/messages?afterSeq=42&limit=1",
    );
    expect(requestOptions.headers).toEqual({ Authorization: "Bearer test-token" });
    expect(requestOptions.signal).toBeInstanceOf(AbortSignal);
    expect(await client.fetchMessageAt(message.seq, message.id)).toBeUndefined();
    await expect(client.fetchMessageAt(message.seq, message.id)).rejects.toThrow("403");
  });

  it("reports a failed snapshot catch-up instead of crashing, then reconnects for a fresh snapshot", async () => {
    server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await waitFor<void>((resolve) => server!.on("listening", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const self = {
      id: "00000000-0000-4000-8000-000000000001",
      roomId: "general",
      username: "test-agent",
      type: "agent" as const,
      status: "online" as const,
      joinedAt: "2026-07-18T00:00:00.000Z",
      lastSeenAt: "2026-07-18T00:00:00.000Z",
    };
    let connections = 0;
    server.on("connection", (socket) => {
      connections += 1;
      socket.on("message", () =>
        socket.send(
          JSON.stringify({
            type: "room.snapshot",
            self,
            participants: [self],
            messages: [],
            latestSeq: 1,
          }),
        ),
      );
    });
    const errors: Error[] = [];
    let snapshots = 0;
    const recovered = waitFor<void>((resolve) => {
      client = new RoomClient(
        {
          serverUrl: `http://127.0.0.1:${port}`,
          roomId: "general",
          username: "test-agent",
          token: "t",
        },
        {
          // 第一次补拉时服务端正在重启：这个拒绝不能变成未处理的 Promise 把进程崩掉
          onSnapshot: async () => {
            snapshots += 1;
            if (snapshots === 1) throw new TypeError("fetch failed");
            resolve();
          },
          onMention: () => undefined,
          onError: (error) => errors.push(error),
        },
      );
      client.start();
    }, 5_000);
    await recovered;
    expect(errors.map((error) => error.message)).toContain("fetch failed");
    expect(connections).toBe(2);
  });

  it("被房主暂停（SESSION_PAUSED）后照常重连但拉长间隔，恢复后重新加入", async () => {
    server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await waitFor<void>((resolve) => server!.on("listening", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const self = {
      id: "00000000-0000-4000-8000-000000000001",
      roomId: "general",
      username: "guest-agent",
      type: "agent" as const,
      status: "online" as const,
      joinedAt: "2026-07-18T00:00:00.000Z",
      lastSeenAt: "2026-07-18T00:00:00.000Z",
    };
    let paused = true;
    const joinedAt: number[] = [];
    server.on("connection", (socket) => {
      socket.on("message", () => {
        joinedAt.push(Date.now());
        if (paused) {
          socket.send(JSON.stringify({ type: "error", code: "SESSION_PAUSED", message: "paused" }));
          socket.close(4401, "paused");
          return;
        }
        socket.send(
          JSON.stringify({
            type: "room.snapshot",
            self,
            participants: [self],
            messages: [],
            latestSeq: 1,
          }),
        );
      });
    });
    const codes: string[] = [];
    const rejoined = waitFor<void>((resolve) => {
      client = new RoomClient(
        {
          serverUrl: `http://127.0.0.1:${port}`,
          roomId: "general",
          username: "guest-agent",
          token: "t",
          pausedRetryMs: 400,
        },
        {
          onSnapshot: () => resolve(),
          onMention: () => undefined,
          onError: (error) => {
            if (error instanceof RoomClientError) codes.push(error.code);
            // 被拒两次后房主恢复
            if (codes.length === 2) paused = false;
          },
        },
      );
      client.start();
    }, 5_000);
    await rejoined;
    expect(codes).toEqual(["SESSION_PAUSED", "SESSION_PAUSED"]);
    expect(joinedAt).toHaveLength(3);
    // 普通断线第一次只等 500ms；暂停时每次都按 pausedRetryMs 等，不按 500ms 起的指数退避
    expect(joinedAt[1]! - joinedAt[0]!).toBeGreaterThanOrEqual(380);
    expect(joinedAt[2]! - joinedAt[1]!).toBeGreaterThanOrEqual(380);
    expect(joinedAt[2]! - joinedAt[1]!).toBeLessThan(1_500);
  });

  it("dispatches snapshots, rooms.changed, message.deleted, and typed error codes", async () => {
    server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await waitFor<void>((resolve) => server!.on("listening", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const sockets: WebSocket[] = [];
    const sendEvent = (event: ServerEvent) => sockets[0]!.send(JSON.stringify(event));
    const joined = waitFor<unknown>((resolve) => {
      server!.on("connection", (socket) => {
        sockets.push(socket);
        socket.on("message", (raw) => resolve(JSON.parse(raw.toString())));
      });
    });

    let resolveSnapshot!: (snapshot: Snapshot) => void;
    let resolveRoom!: (room: RoomSummary) => void;
    let resolveDeleted!: (message: ChatMessage) => void;
    let resolveError!: (error: Error) => void;
    const handlers: RoomClientHandlers = {
      onSnapshot: (snapshot) => resolveSnapshot(snapshot),
      onMention: () => undefined,
      onMessageDeleted: (message) => resolveDeleted(message),
      onRoomsChanged: (room) => resolveRoom(room),
      onError: (error) => resolveError(error),
    };
    client = new RoomClient(
      {
        serverUrl: `http://127.0.0.1:${port}`,
        roomId: "general",
        username: "test-agent",
        token: "test-token",
        provider: "echo",
      },
      handlers,
    );
    client.start();

    expect(await joined).toMatchObject({
      type: "participant.join",
      participantType: "agent",
      roomId: "general",
      token: "test-token",
      // 源码运行：包版本之外还带上启动时的提交和 Agent 代码指纹
      version: {
        package: expect.stringMatching(/^\d+\.\d+\.\d+/),
        commit: expect.stringMatching(/^[0-9a-f]{7,64}$/),
        fingerprint: expect.stringMatching(/^[0-9a-f]{16}\.[0-9a-f]{16}$/),
      },
    });

    const self = {
      id: "00000000-0000-4000-8000-000000000001",
      roomId: "general",
      username: "test-agent",
      type: "agent" as const,
      status: "online" as const,
      joinedAt: "2026-07-18T00:00:00.000Z",
      lastSeenAt: "2026-07-18T00:00:00.000Z",
    };
    const snapshotPromise = waitFor<Snapshot>((resolve) => (resolveSnapshot = resolve));
    sendEvent({ type: "room.snapshot", self, participants: [self], messages: [], latestSeq: 7 });
    expect((await snapshotPromise).latestSeq).toBe(7);

    const roomPromise = waitFor<RoomSummary>((resolve) => (resolveRoom = resolve));
    sendEvent({
      type: "rooms.changed",
      room: {
        id: "fresh",
        name: "新房间",
        createdAt: "2026-07-18T00:00:01.000Z",
        onlineCount: 0,
        latestSeq: 0,
      },
    });
    expect((await roomPromise).id).toBe("fresh");

    const deletedPromise = waitFor<ChatMessage>((resolve) => (resolveDeleted = resolve));
    sendEvent({
      type: "message.deleted",
      message: {
        id: "00000000-0000-4000-8000-000000000009",
        roomId: "general",
        seq: 8,
        senderId: "00000000-0000-4000-8000-000000000002",
        senderName: "Alice",
        senderType: "human",
        content: "",
        mentions: [],
        traceId: "00000000-0000-4000-8000-000000000003",
        hopCount: 0,
        createdAt: "2026-07-18T00:00:02.000Z",
        deletedAt: "2026-07-18T00:00:03.000Z",
      },
    });
    expect((await deletedPromise).deletedAt).toBe("2026-07-18T00:00:03.000Z");

    const errorPromise = waitFor<Error>((resolve) => (resolveError = resolve));
    sendEvent({ type: "error", code: "ROOM_ARCHIVED", message: "This room is archived." });
    const error = await errorPromise;
    expect(error).toBeInstanceOf(RoomClientError);
    expect((error as RoomClientError).code).toBe("ROOM_ARCHIVED");
  });
});

describe("RoomClient reports", () => {
  let server: WebSocketServer | undefined;
  let client: RoomClient | undefined;
  afterEach(async () => {
    client?.stop();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  });

  it("buffers invocation reports until joined and keeps terminal states over late progress", async () => {
    server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await waitFor<void>((resolve) => server!.on("listening", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const received: Array<Record<string, unknown>> = [];
    let socket: WebSocket | undefined;
    server.on("connection", (connection) => {
      socket = connection;
      connection.on("message", (raw) => received.push(JSON.parse(raw.toString())));
    });
    let resolveSnapshot!: () => void;
    let resolveCancel!: (cancel: { id: string; turn?: string[] }) => void;
    let resolveRetry!: (retry: boolean) => void;
    client = new RoomClient(
      { serverUrl: `http://127.0.0.1:${port}`, roomId: "general", username: "a", token: "t" },
      {
        onSnapshot: () => resolveSnapshot(),
        onMention: (_message, _latest, retry) => resolveRetry(retry),
        onCancel: (id, turn) => resolveCancel({ id, ...(turn ? { turn } : {}) }),
        onError: () => undefined,
      },
    );
    const messageId = "00000000-0000-4000-8000-000000000001";
    const progressOnly = "00000000-0000-4000-8000-000000000003";
    client.report({ messageId: progressOnly, status: "running" });
    client.report({ messageId, status: "failed", detail: "crash" });
    client.report({ messageId, status: "running" });
    // 还没送达的只交出终态（进程退出前由 Bridge 落盘），进度不交
    expect(client.undeliveredReports()).toEqual([
      { type: "invocation.report", messageId, status: "failed", detail: "crash" },
    ]);
    client.start();
    await waitFor<void>((resolve) => {
      const check = () => (socket ? resolve() : setTimeout(check, 5));
      check();
    });
    const snapshot = waitFor<void>((resolve) => (resolveSnapshot = resolve));
    socket!.send(
      JSON.stringify({
        type: "room.snapshot",
        self: { id: messageId },
        participants: [],
        messages: [],
        latestSeq: 0,
        invocations: [],
      }),
    );
    await snapshot;
    await waitFor<void>((resolve) => {
      const check = () =>
        received.some(
          (event) => event.type === "invocation.report" && event.messageId === messageId,
        )
          ? resolve()
          : setTimeout(check, 5);
      check();
    });
    expect(
      received.filter(
        (event) => event.type === "invocation.report" && event.messageId === messageId,
      ),
    ).toEqual([{ type: "invocation.report", messageId, status: "failed", detail: "crash" }]);
    expect(client.undeliveredReports()).toEqual([]);

    const cancel = waitFor<{ id: string; turn?: string[] }>((resolve) => (resolveCancel = resolve));
    socket!.send(JSON.stringify({ type: "agent.cancel", messageId }));
    expect(await cancel).toEqual({ id: messageId });
    // 服务端停整轮时带上同轮的消息，原样交给 Bridge
    const sibling = "00000000-0000-4000-8000-000000000002";
    const turnCancel = waitFor<{ id: string; turn?: string[] }>(
      (resolve) => (resolveCancel = resolve),
    );
    socket!.send(JSON.stringify({ type: "agent.cancel", messageId, turn: [messageId, sibling] }));
    expect(await turnCancel).toEqual({ id: messageId, turn: [messageId, sibling] });
    const retry = waitFor<boolean>((resolve) => (resolveRetry = resolve));
    socket!.send(
      JSON.stringify({
        type: "agent.mentioned",
        message: { id: messageId },
        latestSeq: 1,
        retry: true,
      }),
    );
    expect(await retry).toBe(true);
  });
});

describe("RoomClient with an older server", () => {
  let server: WebSocketServer | undefined;
  let client: RoomClient | undefined;
  afterEach(async () => {
    client?.stop();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  });

  it("does not send invocation reports when the snapshot lacks invocation tracking", async () => {
    server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await waitFor<void>((resolve) => server!.on("listening", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const received: Array<Record<string, unknown>> = [];
    server.on("connection", (connection) => {
      connection.on("message", (raw) => {
        const event = JSON.parse(raw.toString()) as Record<string, unknown>;
        received.push(event);
        if (event.type === "participant.join") {
          connection.send(
            JSON.stringify({
              type: "room.snapshot",
              self: { id: "self" },
              participants: [],
              messages: [],
              latestSeq: 0,
            }),
          );
        }
      });
    });
    let resolveSnapshot!: () => void;
    const snapshot = waitFor<void>((resolve) => (resolveSnapshot = resolve));
    client = new RoomClient(
      { serverUrl: `http://127.0.0.1:${port}`, roomId: "general", username: "a", token: "t" },
      { onSnapshot: () => resolveSnapshot(), onMention: () => undefined, onError: () => undefined },
    );
    client.report({ messageId: "00000000-0000-4000-8000-000000000001", status: "received" });
    client.start();
    await snapshot;
    client.report({ messageId: "00000000-0000-4000-8000-000000000001", status: "running" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received.map((event) => event.type)).toEqual(["participant.join"]);
  });

  it("reports the provider session after joining a server that supports it, and again on reconnect", async () => {
    server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await waitFor<void>((resolve) => server!.on("listening", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const received: Array<Record<string, unknown>> = [];
    server.on("connection", (connection) => {
      connection.on("message", (raw) => {
        const event = JSON.parse(raw.toString()) as Record<string, unknown>;
        received.push(event);
        if (event.type === "participant.join") {
          connection.send(
            JSON.stringify({
              type: "room.snapshot",
              self: { id: "self" },
              participants: [],
              messages: [],
              latestSeq: 0,
              invocations: [],
              features: ["session"],
            }),
          );
        }
      });
    });
    let resolveSnapshot!: () => void;
    const snapshot = waitFor<void>((resolve) => (resolveSnapshot = resolve));
    client = new RoomClient(
      { serverUrl: `http://127.0.0.1:${port}`, roomId: "general", username: "a", token: "t" },
      { onSnapshot: () => resolveSnapshot(), onMention: () => undefined, onError: () => undefined },
    );
    // 加入前就知道会话（状态文件里有）：等快照确认服务端支持后再报
    client.reportSession("sess-1", "/repo");
    client.start();
    await snapshot;
    await new Promise((resolve) => setTimeout(resolve, 50));
    client.reportSession("sess-1", "/repo");
    client.reportSession("sess-2", "/repo");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received.filter((event) => event.type === "agent.session")).toEqual([
      { type: "agent.session", sessionId: "sess-1", cwd: "/repo" },
      { type: "agent.session", sessionId: "sess-2", cwd: "/repo" },
    ]);
  });
  it("Hive 工具状态变了才报；服务端不认 tools 时不发；连上前就知道的连不上等快照后补报", async () => {
    server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await waitFor<void>((resolve) => server!.on("listening", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const received: Array<Record<string, unknown>> = [];
    let features = ["tools"];
    server.on("connection", (connection) => {
      connection.on("message", (raw) => {
        const event = JSON.parse(raw.toString()) as Record<string, unknown>;
        received.push(event);
        if (event.type === "participant.join") {
          connection.send(
            JSON.stringify({
              type: "room.snapshot",
              self: { id: "self" },
              participants: [],
              messages: [],
              latestSeq: 0,
              invocations: [],
              features,
            }),
          );
        }
      });
    });
    let resolveSnapshot!: () => void;
    const snapshot = waitFor<void>((resolve) => (resolveSnapshot = resolve));
    client = new RoomClient(
      { serverUrl: `http://127.0.0.1:${port}`, roomId: "general", username: "a", token: "t" },
      { onSnapshot: () => resolveSnapshot(), onMention: () => undefined, onError: () => undefined },
    );
    client.reportHiveTools("unavailable", "failed");
    client.start();
    await snapshot;
    await new Promise((resolve) => setTimeout(resolve, 50));
    client.reportHiveTools("unavailable", "failed");
    client.reportHiveTools("connected");
    client.reportHiveTools("connected");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received.filter((event) => event.type === "agent.tools")).toEqual([
      { type: "agent.tools", hive: "unavailable", detail: "failed" },
      { type: "agent.tools", hive: "connected" },
    ]);

    // 旧版服务端不认：一条都不发
    client.stop();
    received.length = 0;
    features = [];
    let resolveOld!: () => void;
    const old = waitFor<void>((resolve) => (resolveOld = resolve));
    client = new RoomClient(
      { serverUrl: `http://127.0.0.1:${port}`, roomId: "general", username: "a", token: "t" },
      { onSnapshot: () => resolveOld(), onMention: () => undefined, onError: () => undefined },
    );
    client.start();
    await old;
    client.reportHiveTools("unavailable");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received.filter((event) => event.type === "agent.tools")).toEqual([]);
  });
  it("re-announces that it is busy after reconnecting mid-task", async () => {
    server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await waitFor<void>((resolve) => server!.on("listening", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const received: Array<Record<string, unknown>> = [];
    let joins = 0;
    let resolveSecondJoin!: () => void;
    const secondJoin = waitFor<void>((resolve) => (resolveSecondJoin = resolve));
    server.on("connection", (connection) => {
      connection.on("message", (raw) => {
        const event = JSON.parse(raw.toString()) as Record<string, unknown>;
        received.push(event);
        if (event.type !== "participant.join") return;
        joins += 1;
        connection.send(
          JSON.stringify({
            type: "room.snapshot",
            self: { id: "self" },
            participants: [],
            messages: [],
            latestSeq: 0,
            invocations: [],
          }),
        );
        if (joins === 2) resolveSecondJoin();
      });
    });
    let resolveSnapshot!: () => void;
    const snapshot = waitFor<void>((resolve) => (resolveSnapshot = resolve));
    client = new RoomClient(
      { serverUrl: `http://127.0.0.1:${port}`, roomId: "general", username: "a", token: "t" },
      { onSnapshot: () => resolveSnapshot(), onMention: () => undefined, onError: () => undefined },
    );
    client.start();
    await snapshot;
    client.setTyping(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // 服务端重启：连接断开，重连后服务端把它当成刚上线（空闲）
    for (const connection of server.clients) connection.terminate();
    await secondJoin;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const afterReconnect = received.slice(
      received.findLastIndex((e) => e.type === "participant.join"),
    );
    expect(afterReconnect).toContainEqual({ type: "agent.typing", active: true });
  });
});

describe("fetchRooms", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the bearer token and returns the room list", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            rooms: [
              {
                id: "general",
                name: "general",
                createdAt: "2026-07-18T00:00:00.000Z",
                onlineCount: 1,
                latestSeq: 3,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const rooms = await fetchRooms("http://hive.test:8787", "secret-token");
    expect(rooms.map((room) => room.id)).toEqual(["general"]);
    expect(fetchMock).toHaveBeenCalledWith("http://hive.test:8787/api/rooms", {
      headers: { Authorization: "Bearer secret-token" },
    });
  });

  it("throws on non-2xx responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 401 })),
    );
    await expect(fetchRooms("http://hive.test:8787", "bad")).rejects.toThrow(/401/);
  });
});
