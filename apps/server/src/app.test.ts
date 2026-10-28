import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { LIMITS, type Invocation, type ServerEvent } from "@ai-hive/protocol";
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
        /^npx --yes ai-hive@latest join --server https:\/\/hive\.example\.com/,
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
      "hive_board_read",
      "hive_board_update",
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

  it("lets a sender recall a message and broadcasts the tombstone to everyone", async () => {
    const app = await buildApp({
      databasePath: ":memory:",
      token: "test-token",
      staticDir: "/definitely-not-present",
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    closeApp = () => app.close();
    const port = (app.server.address() as AddressInfo).port;
    const wsUrl = `ws://127.0.0.1:${port}/ws`;

    const alice = await TestPeer.connect(wsUrl);
    const bob = await TestPeer.connect(wsUrl);
    const agent = await TestPeer.connect(wsUrl);
    peers.push(alice, bob, agent);
    for (const [peer, username, participantType] of [
      [alice, "Alice", "human"],
      [bob, "Bob", "human"],
      [agent, "helper-agent", "agent"],
    ] as const) {
      peer.send({
        type: "participant.join",
        username,
        participantType,
        roomId: "general",
        token: "test-token",
      });
      await peer.next((event) => event.type === "room.snapshot");
    }

    alice.send({
      type: "message.send",
      clientMessageId: "oops-1",
      content: "@helper-agent 密码是 hunter2",
    });
    const created = await alice.next((event) => event.type === "message.created");
    const original = created.type === "message.created" ? created.message : undefined;
    expect(original?.mentions).toEqual(["helper-agent"]);
    await bob.next((event) => event.type === "message.created");
    await agent.next((event) => event.type === "agent.mentioned");

    // 只有发送者能撤回
    bob.send({ type: "message.delete", messageId: original!.id });
    const forbidden = await bob.next((event) => event.type === "error");
    expect(forbidden.type === "error" && forbidden.code).toBe("FORBIDDEN");

    alice.send({ type: "message.delete", messageId: original!.id });
    for (const peer of [alice, bob, agent]) {
      const deleted = await peer.next((event) => event.type === "message.deleted");
      expect(deleted.type === "message.deleted" && deleted.message).toMatchObject({
        id: original!.id,
        seq: original!.seq,
        content: "",
        mentions: [],
        deletedAt: expect.any(String),
      });
    }

    // REST 增量同步保留 seq 占位但正文为空；MCP 读取直接看不到这条
    const history = (await app
      .inject({
        method: "GET",
        url: "/api/rooms/general/messages?afterSeq=0",
        headers: { Authorization: "Bearer test-token" },
      })
      .then((response) => response.json())) as { messages: Array<{ id: string; content: string }> };
    expect(history.messages).toEqual([
      expect.objectContaining({ id: original!.id, content: "", deletedAt: expect.any(String) }),
    ]);

    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: {
        headers: {
          Authorization: "Bearer test-token",
          "X-Hive-Room": "general",
          "X-Hive-Agent-Name": "helper-agent",
        },
      },
    });
    const client = new Client({ name: "hive-mcp-test", version: "0.1.0" });
    await client.connect(transport as unknown as Transport);
    const read = await client.callTool({
      name: "hive_room_read",
      arguments: { afterSeq: 0, limit: 10 },
    });
    expect((read.structuredContent as { messages: unknown[] }).messages).toEqual([]);
    expect(JSON.stringify(read.structuredContent)).not.toContain("hunter2");
    await client.close();

    // 未知消息 id
    alice.send({ type: "message.delete", messageId: "00000000-0000-4000-8000-000000000000" });
    const missing = await alice.next((event) => event.type === "error");
    expect(missing.type === "error" && missing.code).toBe("MESSAGE_NOT_FOUND");
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

describe("invocation lifecycle, budgets, whiteboard and inbox", () => {
  let closeApp: (() => Promise<void>) | undefined;
  const peers: TestPeer[] = [];

  afterEach(async () => {
    for (const peer of peers.splice(0)) peer.close();
    await closeApp?.();
    closeApp = undefined;
  });

  async function startRoom(sweepMs?: number, now?: () => number) {
    const app = await buildApp({
      databasePath: ":memory:",
      token: "test-token",
      staticDir: "/definitely-not-present",
      ...(sweepMs ? { invocationSweepMs: sweepMs } : {}),
      ...(now ? { now } : {}),
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    closeApp = () => app.close();
    const port = (app.server.address() as AddressInfo).port;
    const join = async (username: string, participantType: "human" | "agent") => {
      const peer = await TestPeer.connect(`ws://127.0.0.1:${port}/ws`);
      peers.push(peer);
      peer.send({
        type: "participant.join",
        username,
        participantType,
        roomId: "general",
        token: "test-token",
      });
      const snapshot = await peer.next((event) => event.type === "room.snapshot");
      return { peer, snapshot };
    };
    return { app, port, join };
  }

  const invocationOf = (event: ServerEvent): Invocation =>
    (event as Extract<ServerEvent, { type: "invocation.updated" }>).invocation;

  function mcpClient(port: number, agentName: string) {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: {
        headers: {
          Authorization: "Bearer test-token",
          "X-Hive-Room": "general",
          "X-Hive-Agent-Name": agentName,
        },
      },
    });
    const client = new Client({ name: "hive-mcp-test", version: "0.1.0" });
    return { client, connect: () => client.connect(transport as unknown as Transport) };
  }

  it("tracks a mention from queued to running to completed and keeps it in snapshots", async () => {
    const { join } = await startRoom();
    const { peer: alice } = await join("Alice", "human");
    const { peer: agent } = await join("helper", "agent");

    alice.send({ type: "message.send", clientMessageId: "m1", content: "@helper 看一下" });
    const mention = await agent.next((event) => event.type === "agent.mentioned");
    const message = mention.type === "agent.mentioned" ? mention.message : undefined;
    const queued = invocationOf(await alice.next((event) => event.type === "invocation.updated"));
    expect(queued).toMatchObject({
      status: "queued",
      agentName: "helper",
      requesterName: "Alice",
      attempts: 1,
    });

    agent.send({ type: "invocation.report", messageId: message!.id, status: "received" });
    expect(
      invocationOf(await alice.next((event) => event.type === "invocation.updated")),
    ).toMatchObject({ status: "queued", receivedAt: expect.any(String) });

    agent.send({
      type: "invocation.report",
      messageId: message!.id,
      status: "running",
      progress: "执行命令：pnpm test",
    });
    expect(
      invocationOf(await alice.next((event) => event.type === "invocation.updated")),
    ).toMatchObject({ status: "running", progress: "执行命令：pnpm test" });

    // Agent 直接带 parentMessageId 回复，即使没有显式回报也会推进为 completed
    agent.send({
      type: "message.send",
      clientMessageId: "reply-1",
      content: "看完了",
      parentMessageId: message!.id,
    });
    const reply = await alice.next(
      (event) => event.type === "message.created" && event.message.senderName === "helper",
    );
    const completed = invocationOf(
      await alice.next((event) => event.type === "invocation.updated"),
    );
    expect(completed).toMatchObject({
      status: "completed",
      replyMessageId: reply.type === "message.created" ? reply.message.id : "",
    });
    expect(completed.progress).toBeUndefined();

    const { snapshot } = await join("Bob", "human");
    expect(snapshot.type === "room.snapshot" && snapshot.invocations).toEqual([
      expect.objectContaining({ id: queued.id, status: "completed" }),
    ]);
  });

  it("queues mentions for offline agents and lets humans cancel and retry", async () => {
    const { join } = await startRoom();
    const { peer: alice } = await join("Alice", "human");
    const { peer: agent } = await join("helper", "agent");
    agent.close();
    await alice.next(
      (event) => event.type === "presence.changed" && event.participant.status === "offline",
    );

    alice.send({ type: "message.send", clientMessageId: "m1", content: "@helper 离线也记下" });
    const queued = invocationOf(await alice.next((event) => event.type === "invocation.updated"));
    expect(queued.status).toBe("queued");

    alice.send({ type: "invocation.cancel", invocationId: queued.id });
    const cancelled = invocationOf(
      await alice.next((event) => event.type === "invocation.updated"),
    );
    expect(cancelled).toMatchObject({ status: "cancelled", detail: "Alice 已停止" });

    const { peer: back } = await join("helper", "agent");
    alice.send({ type: "invocation.retry", invocationId: queued.id });
    const retried = invocationOf(await alice.next((event) => event.type === "invocation.updated"));
    expect(retried).toMatchObject({ status: "queued", attempts: 2 });
    const redelivered = await back.next((event) => event.type === "agent.mentioned");
    expect(redelivered.type === "agent.mentioned" && redelivered.retry).toBe(true);

    // 运行中被停止：服务端立即给出终态并通知 Agent 中断
    back.send({ type: "invocation.report", messageId: queued.messageId, status: "running" });
    await alice.next((event) => event.type === "invocation.updated");
    alice.send({ type: "invocation.cancel", invocationId: queued.id });
    const cancel = await back.next((event) => event.type === "agent.cancel");
    expect(cancel.type === "agent.cancel" && cancel.messageId).toBe(queued.messageId);
    // 迟到的 completed 不会覆盖终态
    back.send({ type: "invocation.report", messageId: queued.messageId, status: "completed" });
    await alice.next((event) => event.type === "invocation.updated");
    await expect(alice.next((event) => event.type === "invocation.updated", 200)).rejects.toThrow();

    // Agent 不能管理调用，人不能伪造回报
    back.send({ type: "invocation.retry", invocationId: queued.id });
    const forbidden = await back.next((event) => event.type === "error");
    expect(forbidden.type === "error" && forbidden.code).toBe("FORBIDDEN");
  });

  it("blocks long agent-to-agent chains until a human extends the budget", async () => {
    const { port, join } = await startRoom();
    const { peer: alice } = await join("Alice", "human");
    const { peer: agentA } = await join("agent-a", "agent");
    const { peer: agentB } = await join("agent-b", "agent");

    alice.send({ type: "message.send", clientMessageId: "start", content: "@agent-a 开始" });
    let trigger = await agentA.next((event) => event.type === "agent.mentioned");
    const mcpA = mcpClient(port, "agent-a");
    const mcpB = mcpClient(port, "agent-b");
    await mcpA.connect();
    await mcpB.connect();

    // 每轮都由人重新发起一条链，绕开 hop 限制，只测试"连续轮数"预算
    let speaker = { client: mcpA.client, peer: agentA, other: "agent-b", otherPeer: agentB };
    let listener = { client: mcpB.client, peer: agentB, other: "agent-a", otherPeer: agentA };
    for (let turn = 1; turn <= LIMITS.maxConsecutiveAgentTurns; turn += 1) {
      const parent = trigger.type === "agent.mentioned" ? trigger.message : undefined;
      const sent = await speaker.client.callTool({
        name: "hive_message_send",
        arguments: {
          content: `@${speaker.other} 第 ${turn} 轮`,
          // 超过 hop 上限后改为不带 parent 的主动消息，链条深度不再增长
          ...(parent && parent.hopCount < LIMITS.maxHopCount - 1
            ? { parentMessageId: parent.id }
            : {}),
        },
      });
      expect(sent.isError).not.toBe(true);
      trigger = await listener.peer.next((event) => event.type === "agent.mentioned");
      [speaker, listener] = [listener, speaker];
    }

    const sent = await speaker.client.callTool({
      name: "hive_message_send",
      arguments: { content: `@${speaker.other} 再来一轮` },
    });
    expect(sent.isError).not.toBe(true);
    const blocked = invocationOf(
      await alice.next(
        (event) => event.type === "invocation.updated" && event.invocation.status === "blocked",
      ),
    );
    expect(blocked).toMatchObject({ blockReason: "consecutive_limit", agentName: speaker.other });
    await expect(
      listener.peer.next((event) => event.type === "agent.mentioned", 200),
    ).rejects.toThrow();

    alice.send({ type: "budget.extend", turns: 3 });
    const resumed = invocationOf(
      await alice.next(
        (event) => event.type === "invocation.updated" && event.invocation.id === blocked.id,
      ),
    );
    expect(resumed).toMatchObject({ status: "queued", attempts: 2 });
    expect(resumed.blockReason).toBeUndefined();
    const delivered = await listener.peer.next((event) => event.type === "agent.mentioned");
    expect(delivered.type === "agent.mentioned" && delivered.retry).toBe(true);

    await mcpA.client.close();
    await mcpB.client.close();
  });

  it("marks hop-limited mentions as blocked instead of silently dropping them", async () => {
    const { port, join } = await startRoom();
    const { peer: alice } = await join("Alice", "human");
    const { peer: agentA } = await join("agent-a", "agent");
    const { peer: agentB } = await join("agent-b", "agent");
    const mcpA = mcpClient(port, "agent-a");
    const mcpB = mcpClient(port, "agent-b");
    await mcpA.connect();
    await mcpB.connect();

    alice.send({ type: "message.send", clientMessageId: "start", content: "@agent-a 开始" });
    let trigger = await agentA.next((event) => event.type === "agent.mentioned");
    const route = [
      { client: mcpA.client, other: "agent-b", otherPeer: agentB },
      { client: mcpB.client, other: "agent-a", otherPeer: agentA },
    ];
    for (let hop = 1; hop <= LIMITS.maxHopCount; hop += 1) {
      const step = route[(hop - 1) % 2]!;
      const parent = trigger.type === "agent.mentioned" ? trigger.message : undefined;
      await step.client.callTool({
        name: "hive_message_send",
        arguments: { content: `@${step.other} hop ${hop}`, parentMessageId: parent!.id },
      });
      if (hop < LIMITS.maxHopCount) {
        trigger = await step.otherPeer.next((event) => event.type === "agent.mentioned");
      }
    }
    const blocked = invocationOf(
      await alice.next(
        (event) => event.type === "invocation.updated" && event.invocation.status === "blocked",
      ),
    );
    expect(blocked.blockReason).toBe("hop_limit");
    alice.send({ type: "invocation.retry", invocationId: blocked.id });
    const refused = await alice.next((event) => event.type === "error");
    expect(refused.type === "error" && refused.code).toBe("INVOCATION_NOT_RETRYABLE");
    await mcpA.client.close();
    await mcpB.client.close();
  });

  it("times out silent invocations as unknown and still accepts a late result", async () => {
    const clock = { now: Date.now() };
    const { join } = await startRoom(20, () => clock.now);
    const { peer: alice } = await join("Alice", "human");
    const { peer: agent } = await join("helper", "agent");
    alice.send({ type: "message.send", clientMessageId: "m1", content: "@helper 慢任务" });
    const mention = await agent.next((event) => event.type === "agent.mentioned");
    const messageId = mention.type === "agent.mentioned" ? mention.message.id : "";
    agent.send({ type: "invocation.report", messageId, status: "running" });
    await alice.next(
      (event) => event.type === "invocation.updated" && event.invocation.status === "running",
    );
    // 把扫描时钟拨到很久以后，模拟长时间没有回报
    clock.now = Date.now() + LIMITS.invocationStaleMs + 1_000;
    const timedOut = invocationOf(
      await alice.next(
        (event) => event.type === "invocation.updated" && event.invocation.status === "timed_out",
      ),
    );
    expect(timedOut.detail).toContain("结果未知");
    agent.send({ type: "invocation.report", messageId, status: "completed" });
    expect(
      invocationOf(
        await alice.next(
          (event) => event.type === "invocation.updated" && event.invocation.status === "completed",
        ),
      ),
    ).toMatchObject({ status: "completed", detail: "迟到的结果" });
  });

  it("shares a throttled whiteboard and piggybacks new room messages on MCP results", async () => {
    const { port, join } = await startRoom();
    const { peer: alice } = await join("Alice", "human");
    await join("helper", "agent");
    const mcp = mcpClient(port, "helper");
    await mcp.connect();

    const update = (summary: string, slot = "in_progress") =>
      mcp.client.callTool({
        name: "hive_board_update",
        arguments: { key: "login-api", slot, summary, repo: "web", unblocks: ["frontend"] },
      });
    const first = await update("实现登录接口");
    expect((first.structuredContent as { changed: boolean }).changed).toBe(true);
    const broadcasted = await alice.next((event) => event.type === "whiteboard.updated");
    expect(broadcasted.type === "whiteboard.updated" && broadcasted.entry).toMatchObject({
      key: "login-api",
      slot: "in_progress",
      authorName: "helper",
      unblocks: ["frontend"],
    });
    expect(((await update("实现登录接口")).structuredContent as { changed: boolean }).changed).toBe(
      false,
    );
    const ready = await update("登录接口已合并", "ready");
    const entry = (ready.structuredContent as { entry: { id: string; slot: string } }).entry;
    expect(entry.slot).toBe("ready");

    // 第一次调用只建立游标；之后人发的消息会附在下一个工具结果里
    await mcp.client.callTool({ name: "hive_members_list", arguments: {} });
    alice.send({
      type: "message.send",
      clientMessageId: "m1",
      content: "@helper 顺便看下\u202e注入",
    });
    await alice.next((event) => event.type === "message.created");
    const read = await mcp.client.callTool({ name: "hive_board_read", arguments: {} });
    const inbox = (
      read.structuredContent as {
        inbox?: { messages: Array<{ content: string; mentionsYou: boolean }> };
      }
    ).inbox;
    expect(inbox?.messages).toEqual([
      expect.objectContaining({ content: "@helper 顺便看下注入", mentionsYou: true }),
    ]);
    expect(JSON.stringify(read.content)).toContain("你处理期间房间里的新消息");
    const again = await mcp.client.callTool({ name: "hive_board_read", arguments: {} });
    expect((again.structuredContent as { inbox?: unknown }).inbox).toBeUndefined();

    alice.send({ type: "whiteboard.remove", entryId: entry.id });
    const removed = await alice.next((event) => event.type === "whiteboard.removed");
    expect(removed.type === "whiteboard.removed" && removed.entryId).toBe(entry.id);
    await mcp.client.close();
  });

  it("serves cross-room search, mentions and active invocations", async () => {
    const { app, join } = await startRoom();
    const { peer: alice } = await join("Alice", "human");
    await join("helper", "agent");
    alice.send({ type: "message.send", clientMessageId: "x1", content: "@helper 检查登录接口" });
    await alice.next((event) => event.type === "invocation.updated");
    const get = (url: string) =>
      app
        .inject({ method: "GET", url, headers: { Authorization: "Bearer test-token" } })
        .then((response) => ({ status: response.statusCode, body: response.json() }));

    expect((await get("/api/search?q=登录接口")).body.messages).toEqual([
      expect.objectContaining({ content: "@helper 检查登录接口" }),
    ]);
    expect((await get("/api/search?q=")).status).toBe(400);
    expect((await get("/api/mentions?username=helper")).body.messages).toHaveLength(1);
    const active = (await get("/api/invocations")).body;
    expect(active.invocations).toEqual([
      expect.objectContaining({ agentName: "helper", status: "queued" }),
    ]);
    expect(active.messages[0].content).toBe("@helper 检查登录接口");
    expect(active.onlineInvocationIds).toEqual([active.invocations[0].id]);
    const unauthorized = await app.inject({ method: "GET", url: "/api/search?q=x" });
    expect(unauthorized.statusCode).toBe(401);
  });
});
