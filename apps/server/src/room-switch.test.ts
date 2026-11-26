import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { ServerEvent } from "@superhive/protocol";
import { buildApp } from "./app.js";
import { Peer } from "./test-peer.js";

describe("switching WebSocket rooms", () => {
  const peers: Peer[] = [];
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    for (const peer of peers.splice(0)) peer.socket.close();
    await close?.();
  });

  async function start() {
    const app = await buildApp({
      databasePath: ":memory:",
      token: "test-token",
      staticDir: "/missing",
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    close = () => app.close();
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const headers = { Authorization: "Bearer test-token", "Content-Type": "application/json" };
    const api = async (path: string, body?: unknown) => {
      const response = await fetch(`${base}${path}`, {
        headers: body === undefined ? { Authorization: headers.Authorization } : headers,
        ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
      });
      return response.json();
    };
    await api("/api/rooms", { id: "second", name: "second" });
    const join = async (
      username: string,
      roomId = "general",
      participantType = "human",
      token = "test-token",
    ) => {
      const peer = await Peer.connect(`${base.replace("http", "ws")}/ws`);
      peers.push(peer);
      peer.send({ type: "participant.join", username, roomId, participantType, token });
      const snapshot = await peer.next((event) => event.type === "room.snapshot");
      return { peer, snapshot: snapshot as Extract<ServerEvent, { type: "room.snapshot" }> };
    };
    return { join, api };
  }

  it("moves the same connection and sends messages only in its new room", async () => {
    const { join } = await start();
    const { peer } = await join("Alice");
    const { peer: oldObserver } = await join("Old");
    const { peer: newObserver } = await join("New", "second");
    peer.send({ type: "room.switch", roomId: "second" });
    const snapshot = await peer.next((event) => event.type === "room.snapshot");
    expect(snapshot.type === "room.snapshot" && snapshot.self.roomId).toBe("second");
    expect(snapshot.type === "room.snapshot" && snapshot.features).toContain("room.switch");
    expect(peer.closed).toBe(false);
    await oldObserver.next(
      (event) =>
        event.type === "presence.changed" &&
        event.participant.username === "Alice" &&
        event.participant.status === "offline",
    );
    peer.send({ type: "message.send", clientMessageId: "new-room", content: "Only second" });
    await newObserver.next(
      (event) => event.type === "message.created" && event.message.content === "Only second",
    );
    expect(
      oldObserver.events.some(
        (event) => event.type === "message.created" && event.message.content === "Only second",
      ),
    ).toBe(false);
    oldObserver.send({
      type: "message.send",
      clientMessageId: "old-room",
      content: "Only general",
    });
    await oldObserver.next(
      (event) => event.type === "message.created" && event.message.content === "Only general",
    );
    expect(
      peer.events.some(
        (event) => event.type === "message.created" && event.message.roomId === "general",
      ),
    ).toBe(false);
    peer.socket.close();
    await newObserver.next(
      (event) =>
        event.type === "presence.changed" &&
        event.participant.username === "Alice" &&
        event.participant.status === "offline",
    );
  });

  it("keeps a human online while another tab leaves or joins, and repeated switches do not flap", async () => {
    const { join } = await start();
    const { peer: watcher } = await join("Watcher");
    const { peer } = await join("Alice");
    await join("Alice");
    await join("Alice", "second");
    watcher.events.length = 0;
    peer.send({ type: "room.switch", roomId: "second" });
    await peer.next((event) => event.type === "room.snapshot");
    expect(
      watcher.events.filter(
        (event) => event.type === "presence.changed" && event.participant.username === "Alice",
      ),
    ).toHaveLength(0);
    peer.events.length = 0;
    peer.send({ type: "room.switch", roomId: "second" });
    await peer.next((event) => event.type === "room.snapshot");
    expect(peer.events.filter((event) => event.type === "presence.changed")).toHaveLength(0);
  });

  it("rejects a missing room without leaving the current one", async () => {
    const { join } = await start();
    const { peer } = await join("Alice");
    peer.send({ type: "room.switch", roomId: "missing" });
    await peer.next((event) => event.type === "error" && event.code === "ROOM_NOT_FOUND");
    peer.send({ type: "room.switch", roomId: "general" });
    const snapshot = await peer.next((event) => event.type === "room.snapshot");
    expect(snapshot.type === "room.snapshot" && snapshot.self.roomId).toBe("general");
  });

  it("does not let a guest subscribe outside its invitation", async () => {
    const { join, api } = await start();
    const invite = await api("/api/rooms/general/invites", { expiresInMinutes: 60 });
    const access = await api("/api/invites/redeem", { token: invite.token, username: "Guest" });
    const { peer } = await join("Guest", "general", "human", access.token);
    peer.send({ type: "room.switch", roomId: "second" });
    await peer.next((event) => event.type === "error" && event.code === "ROOM_FORBIDDEN");
    peer.send({ type: "room.switch", roomId: "general" });
    await peer.next((event) => event.type === "room.snapshot");
    expect(peer.closed).toBe(false);
  });

  it("rejects agents and conflicting names without moving or disconnecting them", async () => {
    const { join } = await start();
    const { peer: agent } = await join("Agent", "general", "agent");
    agent.send({ type: "room.switch", roomId: "second" });
    await agent.next((event) => event.type === "error" && event.code === "ROOM_FORBIDDEN");
    const { peer } = await join("Alice");
    await join("Alice", "second", "agent");
    peer.send({ type: "room.switch", roomId: "second" });
    await peer.next((event) => event.type === "error" && event.code === "USERNAME_TAKEN");
    expect(peer.closed).toBe(false);
    peer.send({ type: "room.switch", roomId: "general" });
    await peer.next((event) => event.type === "room.snapshot");
  });
});
