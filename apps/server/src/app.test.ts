import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ServerEvent } from "@ai-hive/protocol";
import WebSocket from "ws";
import { buildApp } from "./app.js";

class TestPeer {
  readonly socket: WebSocket;
  private readonly events: ServerEvent[] = [];
  private readonly listeners = new Set<() => void>();

  private constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.on("message", (raw) => {
      this.events.push(JSON.parse(raw.toString()) as ServerEvent);
      for (const listener of this.listeners) listener();
    });
  }

  static async connect(url: string): Promise<TestPeer> {
    const peer = new TestPeer(url);
    await new Promise<void>((resolve, reject) => {
      peer.socket.once("open", resolve);
      peer.socket.once("error", reject);
    });
    return peer;
  }

  send(event: object): void {
    this.socket.send(JSON.stringify(event));
  }

  async next(predicate: (event: ServerEvent) => boolean, timeoutMs = 1_000): Promise<ServerEvent> {
    const existingIndex = this.events.findIndex(predicate);
    if (existingIndex >= 0) return this.events.splice(existingIndex, 1)[0]!;
    return new Promise<ServerEvent>((resolve, reject) => {
      const check = () => {
        const index = this.events.findIndex(predicate);
        if (index < 0) return;
        cleanup();
        resolve(this.events.splice(index, 1)[0]!);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out waiting for WebSocket event."));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.listeners.delete(check);
      };
      this.listeners.add(check);
      check();
    });
  }

  close(): void {
    this.socket.close();
  }

  async closeAndWait(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      this.socket.once("close", () => resolve());
      this.socket.close();
    });
  }
}

describe("Hive WebSocket protocol", () => {
  const peers: TestPeer[] = [];
  let closeApp: (() => Promise<void>) | undefined;

  afterEach(async () => {
    for (const peer of peers) peer.close();
    peers.length = 0;
    await closeApp?.();
    closeApp = undefined;
  });

  it("uses the configured public URL for HTTPS and WebSocket connection metadata", async () => {
    const app = await buildApp({
      databasePath: ":memory:",
      token: "test-token",
      publicUrl: "https://hive.example.com/",
      staticDir: "/definitely-not-present",
    });
    closeApp = () => app.close();

    const response = await app.inject({ method: "GET", url: "/api/meta" });
    expect(response.json()).toMatchObject({
      httpUrl: "https://hive.example.com",
      wsUrl: "wss://hive.example.com/ws",
      mcpUrl: "https://hive.example.com/mcp",
      agentCommand: expect.stringMatching(
        /^npx --yes ai-hive join --server https:\/\/hive\.example\.com/,
      ),
    });
  });

  it("exposes a daemon instance id through the health check", async () => {
    const app = await buildApp({
      databasePath: ":memory:",
      token: "test-token",
      instanceId: "test-instance",
      staticDir: "/definitely-not-present",
    });
    closeApp = () => app.close();

    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.json()).toEqual({ status: "ok", instanceId: "test-instance" });
  });

  it("can expose the workspace command during local development", async () => {
    const app = await buildApp({
      databasePath: ":memory:",
      token: "test-token",
      publicUrl: "http://10.0.0.8:8787",
      agentCommandPrefix: "pnpm agent",
      staticDir: "/definitely-not-present",
    });
    closeApp = () => app.close();

    const response = await app.inject({ method: "GET", url: "/api/meta" });
    expect(response.json().agentCommand).toBe(
      "pnpm agent join --server http://10.0.0.8:8787 --name my-agent --token test-token",
    );
  });

  it("exposes authenticated Hive MCP tools for an online Agent", async () => {
    const app = await buildApp({
      databasePath: ":memory:",
      token: "test-token",
      staticDir: "/definitely-not-present",
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    closeApp = () => app.close();
    const port = (app.server.address() as AddressInfo).port;
    const wsUrl = `ws://127.0.0.1:${port}/ws`;

    const sender = await TestPeer.connect(wsUrl);
    const target = await TestPeer.connect(wsUrl);
    peers.push(sender, target);
    sender.send({
      type: "participant.join",
      username: "sender-agent",
      participantType: "agent",
      provider: "codex",
      roomId: "general",
      token: "test-token",
    });
    target.send({
      type: "participant.join",
      username: "target-agent",
      participantType: "agent",
      provider: "claude",
      roomId: "general",
      token: "test-token",
    });
    await sender.next((event) => event.type === "room.snapshot");
    await target.next((event) => event.type === "room.snapshot");

    const unauthorized = await app.inject({
      method: "POST",
      url: "/mcp",
      payload: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    });
    expect(unauthorized.statusCode).toBe(401);

    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: {
        headers: {
          Authorization: "Bearer test-token",
          "X-Hive-Room": "general",
          "X-Hive-Agent-Name": "sender-agent",
        },
      },
    });
    const client = new Client({ name: "hive-mcp-test", version: "0.1.0" });
    await client.connect(transport as unknown as Transport);

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      "hive_members_list",
      "hive_message_send",
      "hive_room_read",
    ]);
    const members = await client.callTool({ name: "hive_members_list", arguments: {} });
    expect(JSON.stringify(members.structuredContent)).toContain("target-agent");

    const sent = await client.callTool({
      name: "hive_message_send",
      arguments: { content: "@target-agent 请检查", clientMessageId: "mcp-send-1" },
    });
    expect(sent.isError).not.toBe(true);
    const mention = await target.next((event) => event.type === "agent.mentioned");
    expect(mention.type === "agent.mentioned" && mention.message.senderName).toBe("sender-agent");

    const messages = await client.callTool({
      name: "hive_room_read",
      arguments: { afterSeq: 0, limit: 10 },
    });
    expect(JSON.stringify(messages.structuredContent)).toContain("请检查");
    await client.close();
  });

  it("shares a human identity across tabs while keeping Agent names unique", async () => {
    const app = await buildApp({
      databasePath: ":memory:",
      token: "test-token",
      staticDir: "/definitely-not-present",
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    closeApp = () => app.close();
    const port = (app.server.address() as AddressInfo).port;
    const wsUrl = `ws://127.0.0.1:${port}/ws`;

    const human = await TestPeer.connect(wsUrl);
    const duplicateHuman = await TestPeer.connect(wsUrl);
    const agentA = await TestPeer.connect(wsUrl);
    const agentB = await TestPeer.connect(wsUrl);
    const duplicateAgent = await TestPeer.connect(wsUrl);
    peers.push(human, duplicateHuman, agentA, agentB, duplicateAgent);

    human.send({
      type: "participant.join",
      username: "Alice",
      participantType: "human",
      roomId: "general",
      token: "test-token",
    });
    const humanSnapshot = await human.next((event) => event.type === "room.snapshot");

    duplicateHuman.send({
      type: "participant.join",
      username: "alice",
      participantType: "human",
      roomId: "general",
      token: "test-token",
    });
    const duplicateSnapshot = await duplicateHuman.next((event) => event.type === "room.snapshot");
    expect(
      humanSnapshot.type === "room.snapshot" &&
        duplicateSnapshot.type === "room.snapshot" &&
        duplicateSnapshot.self.id,
    ).toBe(humanSnapshot.type === "room.snapshot" ? humanSnapshot.self.id : undefined);
    expect(
      duplicateSnapshot.type === "room.snapshot"
        ? duplicateSnapshot.participants.filter(
            (participant) => participant.username.toLocaleLowerCase() === "alice",
          )
        : [],
    ).toHaveLength(1);

    agentA.send({
      type: "participant.join",
      username: "agent-a",
      participantType: "agent",
      provider: "claude",
      roomId: "general",
      token: "test-token",
    });
    const agentSnapshot = await agentA.next((event) => event.type === "room.snapshot");
    expect(agentSnapshot.type === "room.snapshot" && agentSnapshot.self.provider).toBe("claude");

    agentB.send({
      type: "participant.join",
      username: "agent-b",
      participantType: "agent",
      roomId: "general",
      token: "test-token",
    });
    await agentB.next((event) => event.type === "room.snapshot");

    duplicateAgent.send({
      type: "participant.join",
      username: "agent-a",
      participantType: "agent",
      provider: "claude",
      roomId: "general",
      token: "test-token",
    });
    const duplicateError = await duplicateAgent.next(
      (event) => event.type === "error" && event.code === "USERNAME_TAKEN",
    );
    expect(duplicateError.type).toBe("error");

    human.send({
      type: "message.send",
      clientMessageId: "human-1",
      content: "@agent-a please help",
    });
    const created = await human.next((event) => event.type === "message.created");
    expect(created.type === "message.created" && created.message.seq).toBe(1);
    const duplicateCreated = await duplicateHuman.next((event) => event.type === "message.created");
    expect(duplicateCreated.type === "message.created" && duplicateCreated.message.seq).toBe(1);
    const mention = await agentA.next((event) => event.type === "agent.mentioned");
    expect(mention.type === "agent.mentioned" && mention.message.mentions).toContain("agent-a");
    await expect(agentB.next((event) => event.type === "agent.mentioned", 150)).rejects.toThrow(
      /timed out/i,
    );

    await human.closeAndWait();
    const participantsResponse = await fetch(
      `http://127.0.0.1:${port}/api/rooms/general/participants`,
      { headers: { Authorization: "Bearer test-token" } },
    );
    const participantsPayload = (await participantsResponse.json()) as {
      participants: Array<{ username: string; status: string }>;
    };
    expect(
      participantsPayload.participants.find(
        (participant) => participant.username.toLocaleLowerCase() === "alice",
      )?.status,
    ).toBe("online");

    duplicateHuman.send({
      type: "message.send",
      clientMessageId: "human-2",
      content: "still connected from the second tab",
    });
    const secondCreated = await duplicateHuman.next(
      (event) => event.type === "message.created" && event.message.clientMessageId === "human-2",
    );
    expect(secondCreated.type === "message.created" && secondCreated.message.seq).toBe(2);

    const response = await fetch(`http://127.0.0.1:${port}/api/rooms/general/messages?afterSeq=0`, {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { messages: Array<{ content: string }> };
    expect(payload.messages.map((message) => message.content)).toEqual([
      "@agent-a please help",
      "still connected from the second tab",
    ]);
  });

  it("manages the room registry and broadcasts cross-room activity", async () => {
    const app = await buildApp({
      databasePath: ":memory:",
      token: "test-token",
      staticDir: "/definitely-not-present",
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    closeApp = () => app.close();
    const port = (app.server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;
    const wsUrl = `ws://127.0.0.1:${port}/ws`;
    const authHeaders = { Authorization: "Bearer test-token" };
    const jsonHeaders = { ...authHeaders, "Content-Type": "application/json" };

    expect((await fetch(`${baseUrl}/api/rooms`)).status).toBe(401);
    const initialList = (await (
      await fetch(`${baseUrl}/api/rooms`, { headers: authHeaders })
    ).json()) as { rooms: Array<{ id: string }> };
    expect(initialList.rooms.map((room) => room.id)).toEqual(["general"]);

    const created = await fetch(`${baseUrl}/api/rooms`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ id: "frontend", name: "前端", createdBy: "Alice" }),
    });
    expect(created.status).toBe(201);
    const duplicate = await fetch(`${baseUrl}/api/rooms`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ id: "frontend" }),
    });
    expect(duplicate.status).toBe(409);

    const renamed = await fetch(`${baseUrl}/api/rooms/frontend`, {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({ name: "前端协作" }),
    });
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as { room: { name: string } }).room.name).toBe("前端协作");

    const protectedRoom = await fetch(`${baseUrl}/api/rooms/general`, {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({ archived: true }),
    });
    expect(protectedRoom.status).toBe(400);

    const watcher = await TestPeer.connect(wsUrl);
    const roamer = await TestPeer.connect(wsUrl);
    peers.push(watcher, roamer);
    watcher.send({
      type: "participant.join",
      username: "Watcher",
      participantType: "human",
      roomId: "general",
      token: "test-token",
    });
    await watcher.next((event) => event.type === "room.snapshot");

    roamer.send({
      type: "participant.join",
      username: "Roamer",
      participantType: "human",
      roomId: "adhoc",
      token: "test-token",
    });
    await roamer.next((event) => event.type === "room.snapshot");
    const registered = await watcher.next(
      (event) => event.type === "rooms.changed" && event.room.id === "adhoc",
    );
    expect(registered.type === "rooms.changed" && registered.room.name).toBe("adhoc");

    roamer.send({ type: "message.send", clientMessageId: "adhoc-1", content: "hello from adhoc" });
    const activity = await watcher.next(
      (event) => event.type === "room.activity" && event.roomId === "adhoc" && event.latestSeq > 0,
    );
    expect(activity.type === "room.activity" && activity.onlineCount).toBe(1);
    await expect(watcher.next((event) => event.type === "message.created", 150)).rejects.toThrow(
      /timed out/i,
    );

    await roamer.closeAndWait();
    const archivedResponse = await fetch(`${baseUrl}/api/rooms/adhoc`, {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({ archived: true }),
    });
    expect(archivedResponse.status).toBe(200);

    const blocked = await TestPeer.connect(wsUrl);
    peers.push(blocked);
    blocked.send({
      type: "participant.join",
      username: "Blocked",
      participantType: "human",
      roomId: "adhoc",
      token: "test-token",
    });
    const blockedError = await blocked.next(
      (event) => event.type === "error" && event.code === "ROOM_ARCHIVED",
    );
    expect(blockedError.type).toBe("error");
    await new Promise<void>((resolve) => blocked.socket.once("close", () => resolve()));

    const restoredResponse = await fetch(`${baseUrl}/api/rooms/adhoc`, {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({ archived: false }),
    });
    expect(restoredResponse.status).toBe(200);
    const restored = await TestPeer.connect(wsUrl);
    peers.push(restored);
    restored.send({
      type: "participant.join",
      username: "Returning",
      participantType: "human",
      roomId: "adhoc",
      token: "test-token",
    });
    await restored.next((event) => event.type === "room.snapshot");

    const finalList = (await (
      await fetch(`${baseUrl}/api/rooms`, { headers: authHeaders })
    ).json()) as { rooms: Array<{ id: string; latestSeq: number }> };
    expect(finalList.rooms.map((room) => room.id).sort()).toEqual(["adhoc", "frontend", "general"]);
    expect(finalList.rooms.find((room) => room.id === "adhoc")?.latestSeq).toBeGreaterThan(0);
  });
});
