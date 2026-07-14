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
      "pnpm agent join --server http://10.0.0.8:8787 --room general --name my-agent --token test-token",
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

  it("enforces unique online names and routes mentions only to the named agent", async () => {
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
    const agentA = await TestPeer.connect(wsUrl);
    const agentB = await TestPeer.connect(wsUrl);
    const duplicate = await TestPeer.connect(wsUrl);
    peers.push(human, agentA, agentB, duplicate);

    human.send({
      type: "participant.join",
      username: "Alice",
      participantType: "human",
      roomId: "general",
      token: "test-token",
    });
    agentA.send({
      type: "participant.join",
      username: "agent-a",
      participantType: "agent",
      provider: "claude",
      roomId: "general",
      token: "test-token",
    });
    agentB.send({
      type: "participant.join",
      username: "agent-b",
      participantType: "agent",
      roomId: "general",
      token: "test-token",
    });
    duplicate.send({
      type: "participant.join",
      username: "alice",
      participantType: "human",
      roomId: "general",
      token: "test-token",
    });

    await human.next((event) => event.type === "room.snapshot");
    const agentSnapshot = await agentA.next((event) => event.type === "room.snapshot");
    expect(agentSnapshot.type === "room.snapshot" && agentSnapshot.self.provider).toBe("claude");
    await agentB.next((event) => event.type === "room.snapshot");
    const duplicateError = await duplicate.next(
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
    const mention = await agentA.next((event) => event.type === "agent.mentioned");
    expect(mention.type === "agent.mentioned" && mention.message.mentions).toContain("agent-a");
    await expect(agentB.next((event) => event.type === "agent.mentioned", 150)).rejects.toThrow(
      /timed out/i,
    );

    const response = await fetch(`http://127.0.0.1:${port}/api/rooms/general/messages?afterSeq=0`, {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { messages: Array<{ content: string }> };
    expect(payload.messages.map((message) => message.content)).toEqual(["@agent-a please help"]);
  });
});
