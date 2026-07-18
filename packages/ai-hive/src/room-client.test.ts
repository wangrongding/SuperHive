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
import type { RoomSummary, ServerEvent } from "./hive-protocol.js";

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

  it("dispatches snapshots, rooms.changed, and typed error codes", async () => {
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
    let resolveError!: (error: Error) => void;
    const handlers: RoomClientHandlers = {
      onSnapshot: (snapshot) => resolveSnapshot(snapshot),
      onMention: () => undefined,
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

    const errorPromise = waitFor<Error>((resolve) => (resolveError = resolve));
    sendEvent({ type: "error", code: "ROOM_ARCHIVED", message: "This room is archived." });
    const error = await errorPromise;
    expect(error).toBeInstanceOf(RoomClientError);
    expect((error as RoomClientError).code).toBe("ROOM_ARCHIVED");
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
