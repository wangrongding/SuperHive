import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  LIMITS,
  type Invocation,
  type Participant,
  type ServerEvent,
  type WhiteboardEntry,
} from "@superhive/protocol";
import WebSocket from "ws";
import { buildApp } from "./app.js";
import { HiveDatabase } from "./database.js";

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

  /** 取出（并移除）目前已收到、符合条件的全部事件，用来断言「没有收到」 */
  drain(predicate: (event: ServerEvent) => boolean): ServerEvent[] {
    const matched = this.events.filter(predicate);
    for (const event of matched) this.events.splice(this.events.indexOf(event), 1);
    return matched;
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
        /^npx --yes superhive@latest join --server https:\/\/hive\.example\.com/,
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
    expect(response.json()).toEqual({
      status: "ok",
      version: expect.any(String),
      pid: process.pid,
      instanceId: "test-instance",
    });
  });

  it("tells hive restart it can hand local Agents over only when it manages them", async () => {
    const app = await buildApp({
      databasePath: ":memory:",
      token: "test-token",
      staticDir: "/definitely-not-present",
      handoverFile: "/definitely-not-present/agent-handover",
      localAgents: {
        cli: { command: "/usr/bin/node", args: ["/opt/superhive/dist/cli.js"] },
        serverUrl: "http://127.0.0.1:8787",
        probe: async () => ({ installed: false, version: null }),
      },
    });
    closeApp = () => app.close();
    expect((await app.inject({ method: "GET", url: "/health" })).json()).toMatchObject({
      handover: true,
    });
    await app.close();

    // 没开本机 Agent：没有可交接的，不报这一项
    const plain = await buildApp({
      databasePath: ":memory:",
      token: "test-token",
      staticDir: "/definitely-not-present",
      handoverFile: "/definitely-not-present/agent-handover",
    });
    closeApp = () => plain.close();
    expect((await plain.inject({ method: "GET", url: "/health" })).json()).not.toHaveProperty(
      "handover",
    );
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

  it("exposes only allowlisted feedback build metadata to remote visitors", async () => {
    const app = await buildApp({
      databasePath: ":memory:",
      token: "private-test-token",
      incidentRepo: false,
      staticDir: "/definitely-not-present",
    });
    closeApp = () => app.close();
    const response = await app.inject({
      method: "GET",
      url: "/api/meta",
      remoteAddress: "203.0.113.25",
    });
    const metadata = response.json();
    expect(metadata.feedback).toEqual({
      version: expect.stringMatching(/^\d+\.\d+\.\d+/),
      runMode: "source",
    });
    expect(metadata).not.toHaveProperty("joinToken");
    expect(metadata).not.toHaveProperty("agentCommand");
    expect(JSON.stringify(metadata.feedback)).not.toMatch(
      /private-test-token|Users|home|203\.0\.113/,
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
      "hive_ask_human",
      "hive_attachment_read",
      "hive_board_read",
      "hive_board_update",
      "hive_incident_report",
      "hive_invoke",
      "hive_members_list",
      "hive_message_send",
      "hive_room_create",
      "hive_room_post",
      "hive_room_read",
      "hive_rule_propose",
      "hive_schedule_cancel",
      "hive_schedule_create",
      "hive_schedule_list",
      "hive_todo_add",
      "hive_todo_list",
      "hive_todo_update",
      "hive_wait",
      "hive_worktree_create",
      "hive_worktree_list",
      "hive_worktree_remove",
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

  it("broadcasts new message activity without counting heartbeats, replays or system messages", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-11-17T10:00:00.000Z"));
      const app = await buildApp({
        databasePath: ":memory:",
        token: "test-token",
        staticDir: "/definitely-not-present",
      });
      await app.listen({ host: "127.0.0.1", port: 0 });
      closeApp = () => app.close();
      const port = (app.server.address() as AddressInfo).port;
      const join = async (username: string) => {
        const peer = await TestPeer.connect(`ws://127.0.0.1:${port}/ws`);
        peers.push(peer);
        peer.send({
          type: "participant.join",
          username,
          participantType: "human",
          roomId: "general",
          token: "test-token",
        });
        await peer.next((event) => event.type === "room.snapshot");
        return peer;
      };
      const participants = async () => {
        const response = await app.inject({
          method: "GET",
          url: "/api/rooms/general/participants",
          headers: { Authorization: "Bearer test-token" },
        });
        return (response.json() as { participants: Participant[] }).participants;
      };
      const alice = await join("Alice");
      vi.setSystemTime(new Date("2026-11-17T10:01:00.000Z"));
      const bob = await join("Bob");
      expect((await participants()).map((member) => member.username)).toEqual(["Bob", "Alice"]);

      vi.setSystemTime(new Date("2026-11-17T10:05:00.000Z"));
      const message = { type: "message.send", clientMessageId: "new-activity", content: "hello" };
      alice.send(message);
      await alice.next((event) => event.type === "message.created");
      const changed = await bob.next(
        (event) =>
          event.type === "presence.changed" &&
          event.participant.username === "Alice" &&
          event.participant.lastSeenAt === "2026-11-17T10:05:00.000Z",
      );
      expect(changed.type === "presence.changed" && changed.participant.status).toBe("online");
      expect((await participants()).map((member) => member.username)).toEqual(["Alice", "Bob"]);

      vi.setSystemTime(new Date("2026-11-17T10:06:00.000Z"));
      alice.send({ type: "presence.heartbeat" });
      alice.send(message);
      await alice.next((event) => event.type === "message.created");
      await expect(
        bob.next(
          (event) =>
            event.type === "presence.changed" &&
            event.participant.username === "Alice" &&
            event.participant.lastSeenAt === "2026-11-17T10:06:00.000Z",
          50,
        ),
      ).rejects.toThrow(/timed out/i);

      vi.setSystemTime(new Date("2026-11-17T10:07:00.000Z"));
      alice.send({ type: "topic.start" });
      await alice.next(
        (event) => event.type === "message.created" && event.message.kind === "topic",
      );
      expect((await participants())[0]?.lastSeenAt).toBe("2026-11-17T10:05:00.000Z");
    } finally {
      vi.useRealTimers();
    }
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

  it("starts a new topic, scopes Agent reads to it, and lets the local owner clear the room", async () => {
    const app = await buildApp({
      databasePath: ":memory:",
      token: "test-token",
      staticDir: "/definitely-not-present",
      localAgents: {
        cli: { command: "/usr/bin/node", args: ["/opt/superhive/dist/cli.js"] },
        serverUrl: "http://127.0.0.1:8787",
        probe: async () => ({ installed: false, version: null }),
      },
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    closeApp = () => app.close();
    const port = (app.server.address() as AddressInfo).port;
    const wsUrl = `ws://127.0.0.1:${port}/ws`;

    const alice = await TestPeer.connect(wsUrl);
    const agent = await TestPeer.connect(wsUrl);
    peers.push(alice, agent);
    for (const [peer, username, participantType] of [
      [alice, "Alice", "human"],
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

    alice.send({ type: "message.send", clientMessageId: "old-1", content: "@helper-agent 旧话题" });
    await agent.next((event) => event.type === "agent.mentioned");
    const old = await alice.next((event) => event.type === "message.created");

    // Agent 不能开启新话题
    agent.send({ type: "topic.start" });
    const forbidden = await agent.next((event) => event.type === "error");
    expect(forbidden.type === "error" && forbidden.code).toBe("TOPIC_FORBIDDEN");

    alice.send({ type: "topic.start" });
    const topicEvent = await alice.next((event) => event.type === "message.created");
    const topic = topicEvent.type === "message.created" ? topicEvent.message : undefined;
    expect(topic).toMatchObject({ kind: "topic", senderName: "Alice", mentions: [] });
    expect(topic!.content).toContain("开启了新话题");
    alice.send({ type: "message.send", clientMessageId: "new-1", content: "新话题的第一条" });
    await alice.next((event) => event.type === "message.created");

    // MCP 只读到当前话题（分隔本身及之后），即使 Agent 要求从头读
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
      arguments: { afterSeq: 0, limit: 50 },
    });
    const contents = (
      read.structuredContent as { messages: Array<{ content: string }> }
    ).messages.map((message) => message.content);
    expect(contents.some((content) => content.includes("旧话题"))).toBe(false);
    expect(contents.at(-1)).toBe("新话题的第一条");
    await client.close();

    // 清空房间：需要本机房主凭证，操作人必须是房间里的人类成员
    const session = (await app.inject({ method: "GET", url: "/api/local/session" })).json() as {
      ownerToken: string;
      hostPlatform?: string;
    };
    // 本机 Agent 跑在 Server 所在电脑上：网页按这个平台说明工作区档有没有系统沙箱，不看浏览器平台
    expect(session.hostPlatform).toBe(process.platform);
    const clear = (username: string, owner = session.ownerToken) =>
      app.inject({
        method: "POST",
        url: "/api/local/rooms/general/clear",
        headers: { "x-hive-owner": owner },
        payload: { username },
      });
    expect((await clear("Alice", "test-token")).statusCode).toBe(401);
    expect((await clear("helper-agent")).statusCode).toBe(403);
    const cleared = await clear("Alice");
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().removed.messages).toBe(3);
    for (const peer of [alice, agent]) {
      const event = await peer.next((candidate) => candidate.type === "room.cleared");
      expect(event.type === "room.cleared" && event.message).toMatchObject({ kind: "topic" });
    }
    const history = (await app
      .inject({
        method: "GET",
        url: "/api/rooms/general/messages?afterSeq=0",
        headers: { Authorization: "Bearer test-token" },
      })
      .then((response) => response.json())) as {
      messages: Array<{ seq: number; content: string }>;
    };
    expect(history.messages).toHaveLength(1);
    expect(history.messages[0]!.content).toContain("清空了房间");
    // seq 继续递增，不复用：各 Agent 记录的处理进度不会因此错乱
    const oldSeq = old.type === "message.created" ? old.message.seq : 0;
    expect(history.messages[0]!.seq).toBeGreaterThan(oldSeq + 2);
    const invocations = (await app
      .inject({
        method: "GET",
        url: "/api/invocations?roomId=general",
        headers: { Authorization: "Bearer test-token" },
      })
      .then((response) => response.json())) as { invocations: unknown[] };
    expect(invocations.invocations).toEqual([]);
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
    // 带着最近一条消息的时间，侧栏按它排不置顶的房间
    const adhocActivityAt = activity.type === "room.activity" ? activity.lastActivityAt : undefined;
    expect(adhocActivityAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
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

    // 置顶：房主整份写回顺序，存在服务端（换设备也一样），改动的房间广播给所有人
    const pinsBefore = (await (
      await fetch(`${baseUrl}/api/rooms`, { headers: authHeaders })
    ).json()) as { rooms: Array<{ id: string; pinned?: number; lastActivityAt?: string }> };
    expect(pinsBefore.rooms.every((room) => room.pinned === undefined)).toBe(true);
    expect(pinsBefore.rooms.find((room) => room.id === "adhoc")?.lastActivityAt).toBe(
      adhocActivityAt,
    );
    expect(pinsBefore.rooms.find((room) => room.id === "frontend")?.lastActivityAt).toBeUndefined();

    expect(
      (
        await fetch(`${baseUrl}/api/room-pins`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ roomIds: ["frontend"] }),
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
    const pinned = await fetch(`${baseUrl}/api/room-pins`, {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ roomIds: ["frontend", "missing", "general", "frontend"] }),
    });
    expect(pinned.status).toBe(200);
    // 不存在的、重复的去掉
    expect(await pinned.json()).toEqual({ roomIds: ["frontend", "general"] });
    const pinnedFrontend = await restored.next(
      (event) => event.type === "rooms.changed" && event.room.id === "frontend",
    );
    expect(pinnedFrontend.type === "rooms.changed" && pinnedFrontend.room.pinned).toBe(0);
    const pinnedList = (await (
      await fetch(`${baseUrl}/api/rooms`, { headers: authHeaders })
    ).json()) as { rooms: Array<{ id: string; pinned?: number }> };
    expect(Object.fromEntries(pinnedList.rooms.map((room) => [room.id, room.pinned]))).toEqual({
      frontend: 0,
      general: 1,
      adhoc: undefined,
    });

    await fetch(`${baseUrl}/api/room-pins`, {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ roomIds: ["general"] }),
    });
    const unpinned = await restored.next(
      (event) =>
        event.type === "rooms.changed" &&
        event.room.id === "frontend" &&
        event.room.pinned === undefined,
    );
    expect(unpinned.type).toBe("rooms.changed");
    const generalMoved = await restored.next(
      (event) =>
        event.type === "rooms.changed" && event.room.id === "general" && event.room.pinned === 0,
    );
    expect(generalMoved.type).toBe("rooms.changed");
  });
});

describe("invocation lifecycle, budgets, whiteboard and inbox", () => {
  let closeApp: (() => Promise<void>) | undefined;
  const peers: TestPeer[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    for (const peer of peers.splice(0)) peer.close();
    await closeApp?.();
    closeApp = undefined;
  });

  async function startRoom(sweepMs?: number, now?: () => number, enableLocal = false) {
    const app = await buildApp({
      databasePath: ":memory:",
      token: "test-token",
      staticDir: "/definitely-not-present",
      ...(sweepMs ? { invocationSweepMs: sweepMs } : {}),
      ...(now ? { now } : {}),
      ...(enableLocal
        ? {
            localAgents: {
              cli: { command: "/usr/bin/node", args: ["/opt/superhive/dist/cli.js"] },
              serverUrl: "http://127.0.0.1:8787",
              probe: async () => ({ installed: false, version: null }),
            },
          }
        : {}),
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

  it("shows an agent's context size and cache expiry from its latest usage, until a new topic", async () => {
    const { join } = await startRoom();
    const { peer: alice } = await join("Alice", "human");
    const { peer: agent } = await join("helper", "agent");
    alice.send({ type: "message.send", clientMessageId: "c1", content: "@helper 看一下" });
    const mention = await agent.next((event) => event.type === "agent.mentioned");
    const message = mention.type === "agent.mentioned" ? mention.message : undefined;
    const usage = {
      model: "claude-opus-5-5",
      inputTokens: 10,
      cacheWriteTokens: 1_000,
      cacheReadTokens: 120_000,
      outputTokens: 50,
      requests: 2,
      peakContextTokens: 121_010,
      peakCacheWriteTokens: 1_000,
      lastContextTokens: 121_010,
      compactWindow: 400_000,
      contextWindow: 1_000_000,
      cacheTtlMs: 3_600_000,
      lastRequestAt: "2026-11-24T11:00:00.000Z",
    };
    agent.send({ type: "invocation.report", messageId: message!.id, status: "completed", usage });
    const changed = await alice.next(
      (event) =>
        event.type === "presence.changed" &&
        event.participant.username === "helper" &&
        event.participant.context !== undefined,
    );
    expect(changed.type === "presence.changed" && changed.participant.context).toEqual({
      contextTokens: 121_010,
      compactWindow: 400_000,
      contextWindow: 1_000_000,
      cacheExpiresAt: "2026-11-24T12:00:00.000Z",
      at: "2026-11-24T11:00:00.000Z",
    });
    // 这一轮实际用的模型另外带着，开新话题也不丢
    expect(changed.type === "presence.changed" && changed.participant.lastModel).toEqual({
      id: "claude-opus-5-5",
      at: "2026-11-24T11:00:00.000Z",
    });
    // 开新话题：旧会话的上下文不再适用
    alice.send({ type: "topic.start" });
    const cleared = await alice.next(
      (event) =>
        event.type === "presence.changed" &&
        event.participant.username === "helper" &&
        event.participant.context === undefined &&
        event.participant.lastModel !== undefined,
    );
    expect(cleared.type === "presence.changed" && cleared.participant.lastModel?.id).toBe(
      "claude-opus-5-5",
    );
  });

  it("records a turn's usage even after the invocation finished and summarizes it per agent and day", async () => {
    const { app, join } = await startRoom();
    const { peer: alice } = await join("Alice", "human");
    const { peer: agent } = await join("helper", "agent");

    alice.send({ type: "message.send", clientMessageId: "u1", content: "@helper 看一下" });
    const mention = await agent.next((event) => event.type === "agent.mentioned");
    const message = mention.type === "agent.mentioned" ? mention.message : undefined;
    // 先带 parentMessageId 回复，调用已完成；随后到达的用量仍要记账
    agent.send({
      type: "message.send",
      clientMessageId: "u-reply",
      content: "好",
      parentMessageId: message!.id,
    });
    await alice.next(
      (event) => event.type === "invocation.updated" && event.invocation.status === "completed",
    );
    const usage = {
      model: "claude-opus-5-5",
      inputTokens: 100,
      cacheWriteTokens: 430_000,
      cacheReadTokens: 0,
      outputTokens: 50,
      requests: 1,
      firstRequest: { inputTokens: 100, cacheWriteTokens: 430_000, cacheReadTokens: 0 },
      peakContextTokens: 430_100,
      peakCacheWriteTokens: 430_000,
      reportedCostUsd: 2.2,
      session: "new" as const,
    };
    agent.send({ type: "invocation.report", messageId: message!.id, status: "completed", usage });
    const updated = invocationOf(
      await alice.next(
        (event) => event.type === "invocation.updated" && Boolean(event.invocation.usage),
      ),
    );
    expect(updated).toMatchObject({ status: "completed", usage });

    const response = await app.inject({
      method: "GET",
      url: "/api/rooms/general/usage?days=1",
      headers: { authorization: "Bearer test-token" },
    });
    expect(response.statusCode).toBe(200);
    const summary = response.json();
    expect(summary.totals).toMatchObject({
      turns: 1,
      cacheWriteTokens: 430_000,
      largeCacheWrites: 1,
      reportedCostUsd: 2.2,
    });
    expect(summary.agents).toEqual([
      expect.objectContaining({
        agentName: "helper",
        models: ["claude-opus-5-5"],
        latest: expect.objectContaining({ invocationId: updated.id }),
      }),
    ]);
    expect(summary.cells).toEqual([
      expect.objectContaining({ model: "claude-opus-5-5", turns: 1, day: expect.any(String) }),
    ]);
    expect(summary.recent).toHaveLength(1);

    // 大额写入阈值由网页设置传入
    const relaxed = await app.inject({
      method: "GET",
      url: "/api/rooms/general/usage?days=1&alert=500000",
      headers: { authorization: "Bearer test-token" },
    });
    expect(relaxed.json()).toMatchObject({
      cacheWriteAlertTokens: 500_000,
      totals: { largeCacheWrites: 0 },
    });
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
    expect(cancelled).toMatchObject({
      status: "cancelling",
      detail: "Alice 已请求停止，等待 helper 确认",
    });

    const { peer: back } = await join("helper", "agent");
    await back.next((event) => event.type === "agent.cancel");
    back.send({ type: "invocation.report", messageId: queued.messageId, status: "cancelled" });
    await alice.next(
      (event) => event.type === "invocation.updated" && event.invocation.status === "cancelled",
    );
    alice.send({ type: "invocation.retry", invocationId: queued.id });
    const retried = invocationOf(await alice.next((event) => event.type === "invocation.updated"));
    expect(retried).toMatchObject({ status: "queued", attempts: 2 });
    const redelivered = await back.next((event) => event.type === "agent.mentioned");
    expect(redelivered.type === "agent.mentioned" && redelivered.retry).toBe(true);

    // 运行中被停止：进入 cancelling 并通知 Agent 中断，确认后才是终态
    back.send({ type: "invocation.report", messageId: queued.messageId, status: "running" });
    await alice.next((event) => event.type === "invocation.updated");
    alice.send({ type: "invocation.cancel", invocationId: queued.id });
    const cancel = await back.next((event) => event.type === "agent.cancel");
    expect(cancel.type === "agent.cancel" && cancel.messageId).toBe(queued.messageId);
    expect(
      invocationOf(await alice.next((event) => event.type === "invocation.updated")),
    ).toMatchObject({ status: "cancelling" });
    back.send({ type: "invocation.report", messageId: queued.messageId, status: "cancelled" });
    expect(
      invocationOf(await alice.next((event) => event.type === "invocation.updated")),
    ).toMatchObject({ status: "cancelled", detail: "helper 已确认停止" });
    // 迟到的 completed 不会覆盖终态
    back.send({ type: "invocation.report", messageId: queued.messageId, status: "completed" });
    await expect(alice.next((event) => event.type === "invocation.updated", 200)).rejects.toThrow();

    // Agent 不能管理调用，人不能伪造回报
    back.send({ type: "invocation.retry", invocationId: queued.id });
    const forbidden = await back.next((event) => event.type === "error");
    expect(forbidden.type === "error" && forbidden.code).toBe("FORBIDDEN");
  });

  it("keeps a started run cancelling until the agent confirms and refuses retries meanwhile", async () => {
    const { join } = await startRoom();
    const { peer: alice } = await join("Alice", "human");
    const { peer: agent } = await join("helper", "agent");
    alice.send({ type: "message.send", clientMessageId: "m1", content: "@helper 长任务" });
    const mention = await agent.next((event) => event.type === "agent.mentioned");
    const messageId = mention.type === "agent.mentioned" ? mention.message.id : "";
    const queued = invocationOf(await alice.next((event) => event.type === "invocation.updated"));
    agent.send({ type: "invocation.report", messageId, status: "running" });
    await alice.next(
      (event) => event.type === "invocation.updated" && event.invocation.status === "running",
    );

    alice.send({ type: "invocation.cancel", invocationId: queued.id });
    expect(
      invocationOf(
        await alice.next(
          (event) =>
            event.type === "invocation.updated" && event.invocation.status === "cancelling",
        ),
      ).detail,
    ).toContain("等待 helper 确认");
    await agent.next((event) => event.type === "agent.cancel");

    // 停止未确认前的心跳/进度不会把调用冲回 running
    agent.send({ type: "invocation.report", messageId, status: "running", progress: "还在跑" });
    expect(
      invocationOf(await alice.next((event) => event.type === "invocation.updated")),
    ).toMatchObject({ status: "cancelling" });

    alice.send({ type: "invocation.retry", invocationId: queued.id });
    const refused = await alice.next((event) => event.type === "error");
    expect(refused.type === "error" && refused.code).toBe("INVOCATION_NOT_RETRYABLE");

    // 重复停止只重发请求；Agent 断线重连后也会再次收到停止请求
    alice.send({ type: "invocation.cancel", invocationId: queued.id });
    await agent.next((event) => event.type === "agent.cancel");
    await agent.closeAndWait();
    const { peer: back } = await join("helper", "agent");
    const resent = await back.next((event) => event.type === "agent.cancel");
    expect(resent.type === "agent.cancel" && resent.messageId).toBe(messageId);

    back.send({ type: "invocation.report", messageId, status: "cancelled" });
    await alice.next(
      (event) => event.type === "invocation.updated" && event.invocation.status === "cancelled",
    );
    alice.send({ type: "invocation.retry", invocationId: queued.id });
    expect(
      invocationOf(
        await alice.next(
          (event) => event.type === "invocation.updated" && event.invocation.status === "queued",
        ),
      ),
    ).toMatchObject({ attempts: 2 });
  });

  it("does not trust a missing start report or uncertain recovery as stop confirmation", async () => {
    const { join } = await startRoom();
    const { peer: alice } = await join("Alice", "human");
    const { peer: agent } = await join("helper", "agent");
    alice.send({ type: "message.send", clientMessageId: "race", content: "@helper work" });
    const mention = await agent.next((event) => event.type === "agent.mentioned");
    const messageId = mention.type === "agent.mentioned" ? mention.message.id : "";
    const queued = invocationOf(await alice.next((event) => event.type === "invocation.updated"));
    alice.send({ type: "invocation.cancel", invocationId: queued.id });
    expect(
      invocationOf(await alice.next((event) => event.type === "invocation.updated")).status,
    ).toBe("cancelling");
    agent.send({
      type: "invocation.report",
      messageId,
      status: "uncertain",
      detail: "old runtime unknown",
    });
    // 停止后只能确认结果未知：不再挂着「停止中」，改为结果未知，仍不许直接重试
    expect(
      invocationOf(await alice.next((event) => event.type === "invocation.updated")).status,
    ).toBe("timed_out");
    alice.send({ type: "invocation.retry", invocationId: queued.id });
    const error = await alice.next((event) => event.type === "error");
    expect(error.type === "error" && error.code).toBe("INVOCATION_NOT_RETRYABLE");
  });

  it("lets an agent resume its own interrupted call, but not one the human dismissed", async () => {
    const { join } = await startRoom();
    const { peer: alice } = await join("Alice", "human");
    const { peer: agent } = await join("helper", "agent");
    alice.send({ type: "message.send", clientMessageId: "resume", content: "@helper work" });
    const mention = await agent.next((event) => event.type === "agent.mentioned");
    const messageId = mention.type === "agent.mentioned" ? mention.message.id : "";
    const queued = invocationOf(await alice.next((event) => event.type === "invocation.updated"));
    agent.send({ type: "invocation.report", messageId, status: "running" });
    await alice.next(
      (event) => event.type === "invocation.updated" && event.invocation.status === "running",
    );
    // 服务端判了超时（Agent 进程退出期间没有进度）
    agent.send({ type: "invocation.report", messageId, status: "uncertain", detail: "gone" });
    await alice.next(
      (event) => event.type === "invocation.updated" && event.invocation.status === "timed_out",
    );
    // 同一 Agent 重启后确认那一轮没有副作用，自动重跑：回到执行中，人此时不能再点重试
    agent.send({
      type: "invocation.report",
      messageId,
      status: "running",
      detail: "中断后自动恢复",
      detailText: { key: "bridge.crashResumed", params: { count: 1, limit: 2 } },
    });
    expect(
      invocationOf(
        await alice.next(
          (event) => event.type === "invocation.updated" && event.invocation.status === "running",
        ),
      ),
    ).toMatchObject({ detailText: { key: "bridge.crashResumed" } });
    alice.send({ type: "invocation.retry", invocationId: queued.id });
    const refused = await alice.next((event) => event.type === "error");
    expect(refused.type === "error" && refused.code).toBe("INVOCATION_NOT_RETRYABLE");

    // 人收起了结果未知之后，迟到的 running 不再把它冲回执行中
    agent.send({ type: "invocation.report", messageId, status: "uncertain", detail: "gone again" });
    await alice.next(
      (event) => event.type === "invocation.updated" && event.invocation.status === "timed_out",
    );
    alice.send({ type: "invocation.dismiss", invocationIds: [queued.id] });
    await alice.next(
      (event) =>
        event.type === "invocation.updated" && event.invocation.resolution?.kind === "dismissed",
    );
    agent.send({ type: "invocation.report", messageId, status: "running", progress: "late" });
    await expect(
      alice.next(
        (event) => event.type === "invocation.updated" && event.invocation.status === "running",
        200,
      ),
    ).rejects.toThrow();
  });

  it("does not dispatch mentions from a reply that arrives after a stop request", async () => {
    const { join } = await startRoom();
    const { peer: alice } = await join("Alice", "human");
    const { peer: agent } = await join("helper", "agent");
    const { peer: other } = await join("reviewer", "agent");
    alice.send({ type: "message.send", clientMessageId: "m1", content: "@helper 写完叫 reviewer" });
    const mention = await agent.next((event) => event.type === "agent.mentioned");
    const messageId = mention.type === "agent.mentioned" ? mention.message.id : "";
    const queued = invocationOf(await alice.next((event) => event.type === "invocation.updated"));
    agent.send({ type: "invocation.report", messageId, status: "running" });
    await alice.next(
      (event) => event.type === "invocation.updated" && event.invocation.status === "running",
    );
    alice.send({ type: "invocation.cancel", invocationId: queued.id });
    await alice.next(
      (event) => event.type === "invocation.updated" && event.invocation.status === "cancelling",
    );

    agent.send({
      type: "message.send",
      clientMessageId: "late-1",
      content: "@reviewer 写好了",
      parentMessageId: messageId,
    });
    await alice.next(
      (event) => event.type === "message.created" && event.message.senderName === "helper",
    );
    expect(
      invocationOf(await alice.next((event) => event.type === "invocation.updated")),
    ).toMatchObject({ status: "cancelling", detail: expect.stringContaining("未再派发") });
    await expect(other.next((event) => event.type === "agent.mentioned", 200)).rejects.toThrow();

    // 已确认停止后的回复同样不再派发
    alice.send({ type: "message.send", clientMessageId: "m2", content: "@helper 再来一个" });
    const second = await agent.next((event) => event.type === "agent.mentioned");
    const secondId = second.type === "agent.mentioned" ? second.message.id : "";
    const secondInvocation = invocationOf(
      await alice.next((event) => event.type === "invocation.updated"),
    );
    alice.send({ type: "invocation.cancel", invocationId: secondInvocation.id });
    expect(
      invocationOf(await alice.next((event) => event.type === "invocation.updated")),
    ).toMatchObject({ status: "cancelling" });
    agent.send({ type: "invocation.report", messageId: secondId, status: "cancelled" });
    await alice.next(
      (event) => event.type === "invocation.updated" && event.invocation.status === "cancelled",
    );
    agent.send({
      type: "message.send",
      clientMessageId: "late-2",
      content: "@reviewer 还是写好了",
      parentMessageId: secondId,
    });
    await alice.next(
      (event) => event.type === "message.created" && event.message.content.includes("还是"),
    );
    await expect(other.next((event) => event.type === "agent.mentioned", 200)).rejects.toThrow();
  });

  it("chains an executing agent's parentless MCP send to its trigger without completing it", async () => {
    const { app, port, join } = await startRoom();
    const { peer: alice } = await join("Alice", "human");
    const { peer: agentA } = await join("agent-a", "agent");
    const { peer: agentB } = await join("agent-b", "agent");
    const mcpA = mcpClient(port, "agent-a");
    await mcpA.connect();

    alice.send({ type: "message.send", clientMessageId: "start", content: "@agent-a 开始" });
    const mention = await agentA.next((event) => event.type === "agent.mentioned");
    const trigger = mention.type === "agent.mentioned" ? mention.message : undefined;
    agentA.send({ type: "invocation.report", messageId: trigger!.id, status: "running" });
    await alice.next(
      (event) => event.type === "invocation.updated" && event.invocation.status === "running",
    );

    // 执行中省略 parentMessageId：服务端补上触发消息，hop / trace 照常累计
    const sent = await mcpA.client.callTool({
      name: "hive_message_send",
      arguments: { content: "@agent-b 帮我看下接口" },
    });
    expect(sent.isError).not.toBe(true);
    const delegated = await agentB.next((event) => event.type === "agent.mentioned");
    expect(delegated.type === "agent.mentioned" && delegated.message).toMatchObject({
      parentMessageId: trigger!.id,
      traceId: trigger!.traceId,
      hopCount: trigger!.hopCount + 1,
    });

    // 中途的消息不代表这一轮结束：触发调用仍在执行，完成由 bridge 在轮末报告
    const invocations = await app.inject({
      method: "GET",
      url: "/api/rooms/general/invocations",
      headers: { authorization: "Bearer test-token" },
    });
    const own = (invocations.json() as { invocations: Invocation[] }).invocations.find(
      (invocation) => invocation.messageId === trigger!.id,
    );
    expect(own?.status).toBe("running");
    await mcpA.client.close();
  });

  it("keeps a bridge-run invocation running when the agent sends an interim message with the trigger as parent", async () => {
    const { app, port, join } = await startRoom();
    const { peer: alice } = await join("Alice", "human");
    const { peer: agentA } = await join("agent-a", "agent");
    const mcpA = mcpClient(port, "agent-a");
    await mcpA.connect();
    const invocationOf = async (messageId: string) =>
      (
        (
          await app.inject({
            method: "GET",
            url: "/api/rooms/general/invocations",
            headers: { authorization: "Bearer test-token" },
          })
        ).json() as { invocations: Invocation[] }
      ).invocations.find((invocation) => invocation.messageId === messageId)!;

    alice.send({ type: "message.send", clientMessageId: "long", content: "@agent-a 做个大任务" });
    const mention = await agentA.next((event) => event.type === "agent.mentioned");
    const trigger = mention.type === "agent.mentioned" ? mention.message : undefined;
    agentA.send({ type: "invocation.report", messageId: trigger!.id, status: "running" });
    await alice.next(
      (event) => event.type === "invocation.updated" && event.invocation.status === "running",
    );
    // Agent 按规则带上触发消息 ID 先报一句进度：不能把这一轮当成结束
    await mcpA.client.callTool({
      name: "hive_message_send",
      arguments: { content: "收到，开始做", parentMessageId: trigger!.id },
    });
    const interim = await alice.next(
      (event) => event.type === "message.created" && event.message.content === "收到，开始做",
    );
    expect(await invocationOf(trigger!.id)).toMatchObject({
      status: "running",
      progress: expect.stringContaining("进行中的消息"),
    });
    expect((await invocationOf(trigger!.id)).replyMessageId).toBeUndefined();
    // 之后的进度照常更新，轮末 Bridge 代发最终回复并报完成
    agentA.send({
      type: "invocation.report",
      messageId: trigger!.id,
      status: "running",
      progress: "执行命令：pnpm test",
    });
    agentA.send({
      type: "message.send",
      clientMessageId: "agent-reply-x",
      content: "做完了，结果如下",
      parentMessageId: trigger!.id,
    });
    const final = await alice.next(
      (event) => event.type === "message.created" && event.message.content === "做完了，结果如下",
    );
    const done = await invocationOf(trigger!.id);
    expect(done).toMatchObject({
      status: "completed",
      replyMessageId: final.type === "message.created" ? final.message.id : "",
    });
    expect(done.replyMessageId).not.toBe(
      interim.type === "message.created" ? interim.message.id : "",
    );
    await mcpA.client.close();
  });

  it("still treats an MCP reply as the result when no bridge is running the invocation", async () => {
    const { port, join } = await startRoom();
    const { peer: alice } = await join("Alice", "human");
    const { peer: agentA } = await join("agent-a", "agent");
    const mcpA = mcpClient(port, "agent-a");
    await mcpA.connect();
    alice.send({ type: "message.send", clientMessageId: "plain", content: "@agent-a 你好" });
    const mention = await agentA.next((event) => event.type === "agent.mentioned");
    const trigger = mention.type === "agent.mentioned" ? mention.message : undefined;
    await mcpA.client.callTool({
      name: "hive_message_send",
      arguments: { content: "你好呀", parentMessageId: trigger!.id },
    });
    await alice.next(
      (event) => event.type === "invocation.updated" && event.invocation.status === "completed",
    );
    await mcpA.client.close();
  });

  it("blocks long agent-to-agent chains until a human extends the budget", async () => {
    const { port, join } = await startRoom();
    const { peer: alice } = await join("Alice", "human");
    const names = ["agent-a", "agent-b", "agent-c"];
    const agents = [];
    for (const name of names) {
      const { peer } = await join(name, "agent");
      const mcp = mcpClient(port, name);
      await mcp.connect();
      agents.push({ name, peer, client: mcp.client });
    }

    alice.send({ type: "message.send", clientMessageId: "start", content: "@agent-a 开始" });
    let trigger = await agents[0]!.peer.next((event) => event.type === "agent.mentioned");
    // 三个 Agent 轮流 @ 下一个：没有哪一对在来回，只测试"连续轮数"预算（转交链本身不限深度）
    // 连续轮数上限比单 Agent 每分钟条数大：只假装时间在走（定时器照常），免得先撞上限流
    vi.useFakeTimers({ toFake: ["Date"] });
    for (let turn = 1; turn <= LIMITS.maxConsecutiveAgentTurns; turn += 1) {
      vi.setSystemTime(Date.now() + 6_000);
      const speaker = agents[(turn - 1) % 3]!;
      const listener = agents[turn % 3]!;
      const parent = trigger.type === "agent.mentioned" ? trigger.message : undefined;
      const sent = await speaker.client.callTool({
        name: "hive_message_send",
        arguments: { content: `@${listener.name} 第 ${turn} 轮`, parentMessageId: parent!.id },
      });
      expect(sent.isError).not.toBe(true);
      // 回复没 @ 回请求方时也会送到请求方，只认这一轮 @ 给自己的那条
      trigger = await listener.peer.next(
        (event) =>
          event.type === "agent.mentioned" && event.message.content.endsWith(`第 ${turn} 轮`),
      );
    }
    const speaker = agents[LIMITS.maxConsecutiveAgentTurns % 3]!;
    const listener = agents[(LIMITS.maxConsecutiveAgentTurns + 1) % 3]!;
    const parent = trigger.type === "agent.mentioned" ? trigger.message : undefined;
    expect(parent!.hopCount).toBeGreaterThan(12);

    const sent = await speaker.client.callTool({
      name: "hive_message_send",
      arguments: { content: `@${listener.name} 再来一轮`, parentMessageId: parent!.id },
    });
    expect(sent.isError).not.toBe(true);
    const blocked = invocationOf(
      await alice.next(
        (event) => event.type === "invocation.updated" && event.invocation.status === "blocked",
      ),
    );
    expect(blocked).toMatchObject({ blockReason: "consecutive_limit", agentName: listener.name });
    const again = (event: ServerEvent) =>
      event.type === "agent.mentioned" && event.message.content.endsWith("再来一轮");
    await expect(listener.peer.next(again, 200)).rejects.toThrow();

    alice.send({ type: "budget.extend", turns: 3 });
    const resumed = invocationOf(
      await alice.next(
        (event) => event.type === "invocation.updated" && event.invocation.id === blocked.id,
      ),
    );
    expect(resumed).toMatchObject({ status: "queued", attempts: 2 });
    expect(resumed.blockReason).toBeUndefined();
    const delivered = await listener.peer.next(again);
    expect(delivered.type === "agent.mentioned" && delivered.retry).toBe(true);

    for (const agent of agents) await agent.client.close();
  });

  describe("replies to another agent's request", () => {
    async function requestRoom() {
      const room = await startRoom();
      const { peer: alice } = await room.join("Alice", "human");
      const { peer: lead } = await room.join("lead", "agent");
      const { peer: helper } = await room.join("helper", "agent");
      const leadMcp = mcpClient(room.port, "lead");
      const helperMcp = mcpClient(room.port, "helper");
      await leadMcp.connect();
      await helperMcp.connect();
      alice.send({ type: "message.send", clientMessageId: "root", content: "@lead 帮我看看" });
      const rooted = await lead.next((event) => event.type === "agent.mentioned");
      const root = rooted.type === "agent.mentioned" ? rooted.message : undefined;
      lead.send({ type: "invocation.report", messageId: root!.id, status: "running" });
      await leadMcp.client.callTool({
        name: "hive_message_send",
        arguments: { content: "@helper 请改一下登录页", parentMessageId: root!.id },
      });
      const asked = await helper.next((event) => event.type === "agent.mentioned");
      const request = asked.type === "agent.mentioned" ? asked.message : undefined;
      helper.send({ type: "invocation.report", messageId: request!.id, status: "running" });
      return { ...room, alice, lead, helper, leadMcp, helperMcp, request: request! };
    }

    it("wakes the requester when the reply does not @ it, and only once per request", async () => {
      const { alice, lead, helperMcp, leadMcp, request } = await requestRoom();
      await helperMcp.client.callTool({
        name: "hive_message_send",
        arguments: { content: "lead，登录页改好了", parentMessageId: request.id },
      });
      const woken = await lead.next(
        (event) => event.type === "agent.mentioned" && event.message.content.includes("改好了"),
      );
      const reply = woken.type === "agent.mentioned" ? woken.message : undefined;
      expect(reply?.mentions).toEqual([]);
      const delivered = invocationOf(
        await alice.next(
          (event) =>
            event.type === "invocation.updated" &&
            event.invocation.messageId === reply!.id &&
            event.invocation.agentName === "lead",
        ),
      );
      expect(delivered.parentInvocationId).toEqual(expect.any(String));

      // 同一个请求的第二条回复不再重复唤醒
      await helperMcp.client.callTool({
        name: "hive_message_send",
        arguments: { content: "补充：截图也更新了", parentMessageId: request.id },
      });
      const second = await alice.next(
        (event) =>
          event.type === "message.created" && event.message.content.includes("截图也更新了"),
      );
      await new Promise((resolve) => setTimeout(resolve, 80));
      const extra = lead.drain(
        (event) =>
          event.type === "agent.mentioned" &&
          second.type === "message.created" &&
          event.message.id === second.message.id,
      );
      expect(extra).toHaveLength(0);
      await leadMcp.client.close();
      await helperMcp.client.close();
    });

    it("does not deliver twice when the reply already @s the requester", async () => {
      const { alice, lead, helperMcp, leadMcp, request } = await requestRoom();
      await helperMcp.client.callTool({
        name: "hive_message_send",
        arguments: { content: "@lead 改好了", parentMessageId: request.id },
      });
      const woken = await lead.next((event) => event.type === "agent.mentioned");
      const reply = woken.type === "agent.mentioned" ? woken.message : undefined;
      expect(reply?.mentions).toEqual(["lead"]);
      await new Promise((resolve) => setTimeout(resolve, 80));
      const invocations = alice
        .drain(
          (event) =>
            event.type === "invocation.updated" &&
            event.invocation.messageId === reply!.id &&
            event.invocation.agentName === "lead",
        )
        .map((event) => invocationOf(event).id);
      expect(new Set(invocations).size).toBe(1);
      await leadMcp.client.close();
      await helperMcp.client.close();
    });

    it("does not wake anyone extra when replying to a human", async () => {
      const { port, join } = await startRoom();
      const { peer: alice } = await join("Alice", "human");
      const { peer: helper } = await join("helper", "agent");
      const { peer: lead } = await join("lead", "agent");
      const helperMcp = mcpClient(port, "helper");
      await helperMcp.connect();
      alice.send({ type: "message.send", clientMessageId: "ask", content: "@helper 改一下" });
      const asked = await helper.next((event) => event.type === "agent.mentioned");
      const request = asked.type === "agent.mentioned" ? asked.message : undefined;
      helper.send({ type: "invocation.report", messageId: request!.id, status: "running" });
      await helperMcp.client.callTool({
        name: "hive_message_send",
        arguments: { content: "改好了", parentMessageId: request!.id },
      });
      await alice.next(
        (event) => event.type === "message.created" && event.message.content === "改好了",
      );
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(lead.drain((event) => event.type === "agent.mentioned")).toHaveLength(0);
      expect(helper.drain((event) => event.type === "agent.mentioned")).toHaveLength(0);
      await helperMcp.client.close();
    });

    it("applies back-and-forth detection to reply delivery too", async () => {
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
      const limit = LIMITS.maxAgentPingPongMessages;
      for (let turn = 1; turn <= limit + 1; turn += 1) {
        const step = route[(turn - 1) % 2]!;
        const parent = trigger.type === "agent.mentioned" ? trigger.message : undefined;
        // 最后一条只回复、不 @ 对方：代为送达同样受来回检测约束
        const last = turn === limit + 1;
        await step.client.callTool({
          name: "hive_message_send",
          arguments: {
            content: last ? `第 ${turn} 条回复` : `@${step.other} 第 ${turn} 条`,
            parentMessageId: parent!.id,
          },
        });
        if (!last) trigger = await step.otherPeer.next((event) => event.type === "agent.mentioned");
      }
      const blocked = invocationOf(
        await alice.next(
          (event) => event.type === "invocation.updated" && event.invocation.status === "blocked",
        ),
      );
      expect(blocked.blockReason).toBe("ping_pong");
      await mcpA.client.close();
      await mcpB.client.close();
    });
  });

  it("pauses two agents bouncing @ back and forth until a human continues", async () => {
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
    const limit = LIMITS.maxAgentPingPongMessages;
    // 前 limit 条照常互相唤醒，第 limit + 1 条的唤醒被暂停
    for (let turn = 1; turn <= limit + 1; turn += 1) {
      const step = route[(turn - 1) % 2]!;
      const parent = trigger.type === "agent.mentioned" ? trigger.message : undefined;
      const sent = await step.client.callTool({
        name: "hive_message_send",
        arguments: { content: `@${step.other} 第 ${turn} 条`, parentMessageId: parent!.id },
      });
      expect(sent.isError).not.toBe(true);
      if (turn <= limit) {
        trigger = await step.otherPeer.next((event) => event.type === "agent.mentioned");
      }
    }
    const blocked = invocationOf(
      await alice.next(
        (event) => event.type === "invocation.updated" && event.invocation.status === "blocked",
      ),
    );
    expect(blocked).toMatchObject({ blockReason: "ping_pong", agentName: "agent-b" });
    expect(blocked.detail).toContain("互相 @ 了 8 条");
    await expect(agentB.next((event) => event.type === "agent.mentioned", 200)).rejects.toThrow();

    // 人点「继续」后来回检测随追加轮数一起放宽，被暂停的唤醒恢复投递，还能再来回 turns 条
    alice.send({ type: "budget.extend", turns: 2 });
    const resumed = invocationOf(
      await alice.next(
        (event) => event.type === "invocation.updated" && event.invocation.id === blocked.id,
      ),
    );
    expect(resumed).toMatchObject({ status: "queued", attempts: 2 });
    const delivered = await agentB.next(
      (event) => event.type === "agent.mentioned" && event.retry === true,
    );
    const last = delivered.type === "agent.mentioned" ? delivered.message : undefined;
    const reply = await mcpB.client.callTool({
      name: "hive_message_send",
      arguments: { content: "@agent-a 续上", parentMessageId: last!.id },
    });
    expect(reply.isError).not.toBe(true);
    await agentA.next((event) => event.type === "agent.mentioned");
    await mcpA.client.close();
    await mcpB.client.close();
  });

  it("resets back-and-forth detection when a human speaks", async () => {
    const { port, join } = await startRoom();
    const { peer: alice } = await join("Alice", "human");
    const { peer: agentA } = await join("agent-a", "agent");
    const { peer: agentB } = await join("agent-b", "agent");
    const mcpA = mcpClient(port, "agent-a");
    const mcpB = mcpClient(port, "agent-b");
    await mcpA.connect();
    await mcpB.connect();
    const route = [
      { client: mcpA.client, other: "agent-b", otherPeer: agentB },
      { client: mcpB.client, other: "agent-a", otherPeer: agentA },
    ];
    const limit = LIMITS.maxAgentPingPongMessages;
    // 两段对话各来回 limit 条，中间人插了一句话：都不会被暂停
    for (const round of [1, 2]) {
      alice.send({
        type: "message.send",
        clientMessageId: `start-${round}`,
        content: `@agent-a 第 ${round} 段`,
      });
      let trigger = await agentA.next((event) => event.type === "agent.mentioned");
      for (let turn = 1; turn <= limit; turn += 1) {
        const step = route[(turn - 1) % 2]!;
        const parent = trigger.type === "agent.mentioned" ? trigger.message : undefined;
        await step.client.callTool({
          name: "hive_message_send",
          arguments: { content: `@${step.other} ${round}-${turn}`, parentMessageId: parent!.id },
        });
        trigger = await step.otherPeer.next((event) => event.type === "agent.mentioned");
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(
      alice.drain(
        (event) => event.type === "invocation.updated" && event.invocation.status === "blocked",
      ),
    ).toHaveLength(0);
    await mcpA.client.close();
    await mcpB.client.close();
  });

  it("redelivers a mention the online agent never acknowledged before calling it unknown", async () => {
    const clock = { now: Date.now() };
    const { join } = await startRoom(20, () => clock.now);
    const { peer: alice } = await join("Alice", "human");
    const { peer: agent } = await join("helper", "agent");
    alice.send({ type: "message.send", clientMessageId: "lost", content: "@helper 干活" });
    await agent.next((event) => event.type === "agent.mentioned");
    // Agent 收到了却没确认（事件丢了、Bridge 没处理）：超过确认时限后先补发一次，而不是直接判结果未知
    clock.now = Date.now() + LIMITS.invocationUnacknowledgedMs + 1_000;
    const again = await agent.next((event) => event.type === "agent.mentioned");
    expect(again.type === "agent.mentioned" && again.message.content).toBe("@helper 干活");
    // 补发后仍不确认：才判为结果未知
    clock.now += LIMITS.invocationUnacknowledgedMs + 1_000;
    const timedOut = invocationOf(
      await alice.next(
        (event) => event.type === "invocation.updated" && event.invocation.status === "timed_out",
      ),
    );
    expect(timedOut.detail).toContain("没有确认收到");
  });

  it("lets the human continue a turn the agent itself reported as interrupted, resuming the session", async () => {
    const { join } = await startRoom();
    const { peer: alice } = await join("Alice", "human");
    const { peer: agent } = await join("helper", "agent");
    alice.send({ type: "message.send", clientMessageId: "cut", content: "@helper 干活" });
    const mention = await agent.next((event) => event.type === "agent.mentioned");
    const messageId = mention.type === "agent.mentioned" ? mention.message.id : "";
    agent.send({ type: "invocation.report", messageId, status: "running" });
    agent.send({
      type: "invocation.report",
      messageId,
      status: "uncertain",
      detail: "执行中断",
      detailText: { key: "bridge.crashedMidTurn" },
    });
    const unknown = invocationOf(
      await alice.next(
        (event) => event.type === "invocation.updated" && event.invocation.status === "timed_out",
      ),
    );
    // Agent 自己说这一轮已经不在跑了：人点「继续」可以重新派发，并告诉 Agent 接着原会话核对现状
    alice.send({ type: "invocation.retry", invocationId: unknown.id });
    const again = await agent.next((event) => event.type === "agent.mentioned");
    expect(again).toMatchObject({ retry: true, resume: true });
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
    // 结果未知时可能仍在执行，不允许直接重试
    alice.send({ type: "invocation.retry", invocationId: timedOut.id });
    const refused = await alice.next((event) => event.type === "error");
    expect(refused.type === "error" && refused.code).toBe("INVOCATION_NOT_RETRYABLE");
    agent.send({ type: "invocation.report", messageId, status: "completed" });
    expect(
      invocationOf(
        await alice.next(
          (event) => event.type === "invocation.updated" && event.invocation.status === "completed",
        ),
      ),
    ).toMatchObject({ status: "completed", detail: "迟到的结果" });
  });

  it("gives running invocations a grace period after the machine wakes from sleep", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now());
      const { join } = await startRoom(20);
      const { peer: alice } = await join("Alice", "human");
      const { peer: agent } = await join("helper", "agent");
      alice.send({ type: "message.send", clientMessageId: "sleep", content: "@helper 慢任务" });
      const mention = await agent.next((event) => event.type === "agent.mentioned");
      const messageId = mention.type === "agent.mentioned" ? mention.message.id : "";
      agent.send({ type: "invocation.report", messageId, status: "running" });
      await alice.next(
        (event) => event.type === "invocation.updated" && event.invocation.status === "running",
      );
      // 合盖睡了很久：醒来时墙钟一下子跳过了超时阈值，扫描定时器补跑
      vi.setSystemTime(Date.now() + LIMITS.invocationStaleMs + 60_000);
      await expect(
        alice.next(
          (event) => event.type === "invocation.updated" && event.invocation.status === "timed_out",
          300,
        ),
      ).rejects.toThrow();
      // Agent 醒来后照常报心跳，调用一直是执行中
      agent.send({ type: "invocation.report", messageId, status: "running", progress: "醒了" });
      await expect(
        alice.next(
          (event) => event.type === "invocation.updated" && event.invocation.status === "timed_out",
          200,
        ),
      ).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  describe("hive_invoke delegation", () => {
    /** Alice @ planner，planner 开工后用 hive_invoke 把子任务派给 worker */
    async function delegationRoom(sweepMs?: number, now?: () => number) {
      const room = await startRoom(sweepMs, now);
      const { peer: alice } = await room.join("Alice", "human");
      const { peer: planner } = await room.join("planner", "agent");
      const { peer: worker } = await room.join("worker", "agent");
      alice.send({ type: "message.send", clientMessageId: "root", content: "@planner 做个计划" });
      const mentioned = await planner.next((event) => event.type === "agent.mentioned");
      const trigger = mentioned.type === "agent.mentioned" ? mentioned.message : undefined;
      planner.send({ type: "invocation.report", messageId: trigger!.id, status: "running" });
      await alice.next(
        (event) => event.type === "invocation.updated" && event.invocation.status === "running",
      );
      const plannerMcp = mcpClient(room.port, "planner");
      const workerMcp = mcpClient(room.port, "worker");
      await plannerMcp.connect();
      await workerMcp.connect();
      const invoke = async (args: Record<string, unknown>) => {
        const result = await plannerMcp.client.callTool({ name: "hive_invoke", arguments: args });
        return {
          result,
          data: result.structuredContent as Record<string, unknown> & { invocationId: string },
        };
      };
      return { ...room, alice, planner, worker, trigger: trigger!, plannerMcp, workerMcp, invoke };
    }

    it("delegates without completing the caller and returns the receipt to it", async () => {
      const { alice, planner, worker, trigger, plannerMcp, workerMcp, invoke } =
        await delegationRoom();
      const { data } = await invoke({
        agent: "worker",
        task: "统计一下测试数量\n细节不应该在公开回执重复出现",
      });
      expect(data).toMatchObject({ status: "queued", targetOnline: true });

      const delegated = await worker.next((event) => event.type === "agent.mentioned");
      const delegation = delegated.type === "agent.mentioned" ? delegated.message : undefined;
      expect(delegation).toMatchObject({
        kind: "delegation",
        content: "@worker 统计一下测试数量\n细节不应该在公开回执重复出现",
        parentMessageId: trigger.id,
      });
      const child = invocationOf(
        await alice.next(
          (event) =>
            event.type === "invocation.updated" && event.invocation.id === data.invocationId,
        ),
      );
      // 子调用记下了真实的上游，并登记了待回执
      expect(child).toMatchObject({ continuation: "pending", requesterName: "planner" });
      expect(child.parentInvocationId).toEqual(expect.any(String));

      // worker 回复并结束：planner 收到一条代发的回执，正文里的 @ 不会再唤醒别人
      const reply = await workerMcp.client.callTool({
        name: "hive_message_send",
        arguments: {
          content: `共 66 项，@Alice 请过目\n${"完整证据".repeat(1500)}\n末尾检查`,
          parentMessageId: delegation!.id,
        },
      });
      expect(reply.isError).not.toBe(true);
      const receiptEvent = await planner.next(
        (event) => event.type === "agent.mentioned" && event.message.kind === "receipt",
      );
      const receipt = receiptEvent.type === "agent.mentioned" ? receiptEvent.message : undefined;
      expect(receipt?.content).toContain("子任务回执");
      expect(receipt?.text?.key).toBe("receipt.compact");
      expect(receipt?.content).toContain("委派：统计一下测试数量");
      expect(receipt?.content).toContain("[结果见 #");
      expect(receipt?.content).not.toContain("共 66 项");
      expect(receipt?.content).not.toContain("细节不应该");
      expect(receipt?.content).not.toContain("末尾检查");
      expect(receipt?.content.length).toBeLessThan(300);
      expect(receipt?.text?.params?.resultMessageId).toEqual(expect.any(String));
      expect(receipt?.mentions).toEqual(["planner"]);
      expect(receipt?.parentMessageId).toBe(delegation!.id);
      const delivered = invocationOf(
        await alice.next(
          (event) =>
            event.type === "invocation.updated" &&
            event.invocation.id === data.invocationId &&
            event.invocation.continuation === "delivered",
        ),
      );
      expect(delivered.status).toBe("completed");

      await plannerMcp.client.close();
      await workerMcp.client.close();
    });

    it("hands the result to hive_wait instead of sending a second receipt", async () => {
      const { planner, worker, plannerMcp, workerMcp, invoke } = await delegationRoom();
      const { data } = await invoke({ agent: "worker", task: "快速检查", clientMessageId: "d1" });
      const again = await invoke({ agent: "worker", task: "快速检查", clientMessageId: "d1" });
      expect(again.data.invocationId).toBe(data.invocationId);

      const delegated = await worker.next((event) => event.type === "agent.mentioned");
      const delegation = delegated.type === "agent.mentioned" ? delegated.message : undefined;
      const pending = await plannerMcp.client.callTool({
        name: "hive_wait",
        arguments: { invocationId: data.invocationId, timeoutSeconds: 1 },
      });
      expect(pending.structuredContent).toMatchObject({ done: false, status: "queued" });

      const waiting = plannerMcp.client.callTool({
        name: "hive_wait",
        arguments: { invocationId: data.invocationId, timeoutSeconds: 10 },
      });
      await workerMcp.client.callTool({
        name: "hive_message_send",
        arguments: { content: "检查通过", parentMessageId: delegation!.id },
      });
      const done = await waiting;
      expect(done.structuredContent).toMatchObject({
        done: true,
        status: "completed",
        reply: { content: "检查通过" },
      });
      await expect(
        planner.next(
          (event) => event.type === "agent.mentioned" && event.message.kind === "receipt",
          400,
        ),
      ).rejects.toThrow();

      await plannerMcp.client.close();
      await workerMcp.client.close();
    });

    it("sends a receipt still owed from before a restart", async () => {
      const directory = mkdtempSync(path.join(tmpdir(), "hive-receipt-"));
      const databasePath = path.join(directory, "hive.sqlite");
      const seed = new HiveDatabase(databasePath);
      const human = seed.upsertParticipant({ roomId: "general", username: "Alice", type: "human" });
      const planner = seed.upsertParticipant({
        roomId: "general",
        username: "planner",
        type: "agent",
      });
      const worker = seed.upsertParticipant({
        roomId: "general",
        username: "worker",
        type: "agent",
      });
      const root = seed.createMessage(human, {
        content: "@planner go",
        clientMessageId: "r",
      }).message;
      const delegation = seed.createMessage(planner, {
        content: "@worker sub",
        clientMessageId: "d",
        parentMessageId: root.id,
        kind: "delegation",
      }).message;
      const child = seed.createInvocation({
        message: delegation,
        agent: worker,
        status: "queued",
        continuation: "pending",
      }).invocation;
      seed.updateInvocation(child.id, { status: "failed", detail: "命令退出码 1" });
      seed.close();

      const app = await buildApp({ databasePath, token: "test-token", staticDir: "/nope" });
      await app.ready();
      await new Promise((resolve) => setTimeout(resolve, 20));
      await app.close();
      const after = new HiveDatabase(databasePath);
      const receipt = after
        .getMessages("general", 0, 50)
        .find((message) => message.kind === "receipt");
      expect(receipt).toMatchObject({ senderName: "worker", mentions: ["planner"] });
      expect(receipt?.content).toContain("命令退出码 1");
      expect(after.getInvocation(child.id)?.continuation).toBe("delivered");
      after.close();
      rmSync(directory, { recursive: true, force: true });
    });

    it("carries the receipt over to the answer when a subtask asks a human", async () => {
      const { alice, planner, worker, workerMcp, invoke } = await delegationRoom();
      const { data } = await invoke({ agent: "worker", task: "上线前确认" });
      const delegated = await worker.next((event) => event.type === "agent.mentioned");
      const delegation = delegated.type === "agent.mentioned" ? delegated.message : undefined;
      worker.send({ type: "invocation.report", messageId: delegation!.id, status: "running" });
      const asked = await workerMcp.client.callTool({
        name: "hive_ask_human",
        arguments: { question: "可以上线吗？" },
      });
      const questionId = (asked.structuredContent as { questionMessageId: string })
        .questionMessageId;
      const question = await alice.next(
        (event) => event.type === "message.created" && event.message.id === questionId,
      );
      // 委派链上的子任务问的是链条源头的人
      expect(question.type === "message.created" && question.message.mentions).toEqual(["Alice"]);
      worker.send({ type: "invocation.report", messageId: delegation!.id, status: "completed" });

      alice.send({
        type: "message.send",
        clientMessageId: "go",
        content: "可以",
        replyToMessageId: questionId,
      });
      const woken = await worker.next(
        (event) => event.type === "agent.mentioned" && event.message.content === "可以",
      );
      const answer = woken.type === "agent.mentioned" ? woken.message : undefined;
      const parked = invocationOf(
        await alice.next(
          (event) =>
            event.type === "invocation.updated" &&
            event.invocation.id === data.invocationId &&
            event.invocation.status === "completed",
        ),
      );
      // 旧调用不再回执，回执交给回答触发的新调用
      expect(parked.continuation).toBeUndefined();
      const resumed = invocationOf(
        await alice.next(
          (event) =>
            event.type === "invocation.updated" && event.invocation.messageId === answer!.id,
        ),
      );
      expect(resumed).toMatchObject({ continuation: "pending", requesterName: "planner" });

      await workerMcp.client.callTool({
        name: "hive_message_send",
        arguments: { content: "已上线", parentMessageId: answer!.id },
      });
      const receiptEvent = await planner.next(
        (event) => event.type === "agent.mentioned" && event.message.kind === "receipt",
      );
      expect(receiptEvent.type === "agent.mentioned" && receiptEvent.message.text?.key).toBe(
        "receipt.compact",
      );
    });

    it("refuses self and upstream delegation", async () => {
      const { worker, plannerMcp, workerMcp, invoke } = await delegationRoom();
      const self = await invoke({ agent: "planner", task: "自己做" });
      expect(self.result.isError).toBe(true);

      await invoke({ agent: "worker", task: "子任务" });
      const delegated = await worker.next((event) => event.type === "agent.mentioned");
      const delegation = delegated.type === "agent.mentioned" ? delegated.message : undefined;
      worker.send({ type: "invocation.report", messageId: delegation!.id, status: "running" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const cycle = await workerMcp.client.callTool({
        name: "hive_invoke",
        arguments: { agent: "planner", task: "反过来帮我" },
      });
      expect(cycle.isError).toBe(true);
      expect(JSON.stringify(cycle.content)).toContain("相互等待");

      await plannerMcp.client.close();
      await workerMcp.client.close();
    });

    it("delegates again to an agent whose earlier subtask ended with an unknown result", async () => {
      const { planner, worker, plannerMcp, workerMcp, invoke } = await delegationRoom();
      await invoke({ agent: "worker", task: "第一次" });
      const delegated = await worker.next((event) => event.type === "agent.mentioned");
      const delegation = delegated.type === "agent.mentioned" ? delegated.message : undefined;
      worker.send({ type: "invocation.report", messageId: delegation!.id, status: "running" });
      worker.send({
        type: "invocation.report",
        messageId: delegation!.id,
        status: "uncertain",
        detail: "gone",
      });
      // 结果未知的回执唤醒 planner；它在回执这一轮里再派给 worker，不能被当成相互等待
      const receiptEvent = await planner.next(
        (event) => event.type === "agent.mentioned" && event.message.kind === "receipt",
      );
      const receipt = receiptEvent.type === "agent.mentioned" ? receiptEvent.message : undefined;
      planner.send({ type: "invocation.report", messageId: receipt!.id, status: "running" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const again = await invoke({ agent: "worker", task: "接着做", clientMessageId: "again" });
      expect(again.result.isError).not.toBe(true);
      const redelegated = await worker.next(
        (event) => event.type === "agent.mentioned" && event.message.content.includes("接着做"),
      );
      expect(redelegated.type).toBe("agent.mentioned");

      await plannerMcp.client.close();
      await workerMcp.client.close();
    });

    it("tells the delegator right away when the target is offline or has not started", async () => {
      // 时钟拨快 6 秒：子任务一派出就已超过 5 秒的活动门闩
      const { worker, plannerMcp, workerMcp, invoke } = await delegationRoom(
        undefined,
        () => Date.now() + 6_000,
      );
      const { data } = await invoke({ agent: "worker", task: "在线但没开工" });
      expect(data.targetState).toContain("已派出");
      const started = Date.now();
      const undelivered = await plannerMcp.client.callTool({
        name: "hive_wait",
        arguments: { invocationId: data.invocationId, timeoutSeconds: 10 },
      });
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(undelivered.structuredContent).toMatchObject({
        done: false,
        stalled: true,
        state: "queued_undelivered",
      });

      await workerMcp.client.close();
      worker.close();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const offline = await invoke({ agent: "worker", task: "离线时派活" });
      expect(offline.data).toMatchObject({ targetOnline: false });
      expect(offline.data.targetState).toContain("离线");
      const waited = await plannerMcp.client.callTool({
        name: "hive_wait",
        arguments: { invocationId: offline.data.invocationId, timeoutSeconds: 10 },
      });
      expect(waited.structuredContent).toMatchObject({
        done: false,
        stalled: true,
        state: "queued_offline",
      });
      expect(String((waited.structuredContent as { note: string }).note)).toContain("离线");

      await plannerMcp.client.close();
    });

    it("keeps delegating after the consecutive-turn budget for plain @ is used up", async () => {
      const { worker, plannerMcp, workerMcp, invoke } = await delegationRoom();
      // 两个 Agent 轮流发言，耗尽「人上次发言以来的 Agent 连续发言」预算（避开单 Agent 每分钟上限）
      vi.useFakeTimers({ toFake: ["Date"] });
      for (let index = 0; index <= LIMITS.maxConsecutiveAgentTurns; index += 1) {
        vi.setSystemTime(Date.now() + 6_000);
        const sent = await (index % 2 ? plannerMcp : workerMcp).client.callTool({
          name: "hive_message_send",
          arguments: { content: `进度 ${index}`, clientMessageId: `fill-${index}` },
        });
        expect(sent.isError).not.toBe(true);
      }
      // 派活是上游在等结果的结构化委派，不受这个费用刹车约束（rd #6608）
      const { data } = await invoke({ agent: "worker", task: "再做一件事" });
      expect(data).toMatchObject({ status: "queued" });
      await worker.next(
        (event) => event.type === "agent.mentioned" && event.message.kind === "delegation",
      );

      await plannerMcp.client.close();
      await workerMcp.client.close();
    });

    // 180 条消息逐条走 WebSocket 往返，全量并行跑、机器负载高时默认 5 秒不够
    it("never blocks a long delegate → receipt → delegate chain", async () => {
      const { alice, planner, worker, plannerMcp, workerMcp, invoke } = await delegationRoom();
      vi.useFakeTimers({ toFake: ["Date"] });
      // 60 轮 = 60 条派活 + 60 条答复 + 60 条回执，远超旧版 12 跳 / 40 条的上限
      const rounds = 60;
      let lastReceipt: { id: string; hopCount: number } | undefined;
      for (let round = 1; round <= rounds; round += 1) {
        vi.setSystemTime(Date.now() + 6_000);
        const { data } = await invoke({
          agent: "worker",
          task: `第 ${round} 步`,
          clientMessageId: `step-${round}`,
        });
        expect(data).toMatchObject({ status: "queued" });
        const delegated = await worker.next(
          (event) => event.type === "agent.mentioned" && event.message.kind === "delegation",
        );
        const delegation = delegated.type === "agent.mentioned" ? delegated.message : undefined;
        const reply = await workerMcp.client.callTool({
          name: "hive_message_send",
          arguments: { content: `第 ${round} 步做完了`, parentMessageId: delegation!.id },
        });
        expect(reply.isError).not.toBe(true);
        const receiptEvent = await planner.next(
          (event) => event.type === "agent.mentioned" && event.message.kind === "receipt",
        );
        const receipt = receiptEvent.type === "agent.mentioned" ? receiptEvent.message : undefined;
        // 委派方收到回执后接着这条回执往下派活，链条越来越深
        planner.send({ type: "invocation.report", messageId: receipt!.id, status: "running" });
        await alice.next(
          (event) =>
            event.type === "invocation.updated" &&
            event.invocation.messageId === receipt!.id &&
            event.invocation.status === "running",
        );
        lastReceipt = receipt;
      }
      expect(lastReceipt!.hopCount).toBeGreaterThanOrEqual(rounds * 2);
      expect(
        alice.drain(
          (event) => event.type === "invocation.updated" && event.invocation.status === "blocked",
        ),
      ).toHaveLength(0);
      // 委派方最后的汇总照常发出
      const summary = await plannerMcp.client.callTool({
        name: "hive_message_send",
        arguments: { content: "全部做完了", parentMessageId: lastReceipt!.id },
      });
      expect(summary.isError).not.toBe(true);

      await plannerMcp.client.close();
      await workerMcp.client.close();
    }, 30_000);

    it("tells the delegator when the subtask outcome is unknown", async () => {
      const { planner, worker, plannerMcp, workerMcp, invoke } = await delegationRoom();
      const { data } = await invoke({ agent: "worker", task: "可能会卡住" });
      const delegated = await worker.next((event) => event.type === "agent.mentioned");
      const delegation = delegated.type === "agent.mentioned" ? delegated.message : undefined;
      worker.send({
        type: "invocation.report",
        messageId: delegation!.id,
        status: "uncertain",
        detail: "进程中断，结果未知",
      });
      const receiptEvent = await planner.next(
        (event) => event.type === "agent.mentioned" && event.message.kind === "receipt",
      );
      const receipt = receiptEvent.type === "agent.mentioned" ? receiptEvent.message : undefined;
      expect(receipt?.content).toContain("结果未知");
      expect(receipt?.content).toContain(data.invocationId);

      await plannerMcp.client.close();
      await workerMcp.client.close();
    });
  });

  describe("hive_ask_human", () => {
    /** Alice @ helper，helper 开工后向人提问 */
    async function askRoom() {
      const room = await startRoom();
      const { peer: alice } = await room.join("Alice", "human");
      const { peer: helper } = await room.join("helper", "agent");
      alice.send({ type: "message.send", clientMessageId: "root", content: "@helper 发布一下" });
      const mentioned = await helper.next((event) => event.type === "agent.mentioned");
      const trigger = mentioned.type === "agent.mentioned" ? mentioned.message : undefined;
      helper.send({ type: "invocation.report", messageId: trigger!.id, status: "running" });
      await alice.next(
        (event) => event.type === "invocation.updated" && event.invocation.status === "running",
      );
      const helperMcp = mcpClient(room.port, "helper");
      await helperMcp.connect();
      const ask = async (question: string, extra: Record<string, unknown> = {}) => {
        const result = await helperMcp.client.callTool({
          name: "hive_ask_human",
          arguments: { question, ...extra },
        });
        return {
          result,
          data: result.structuredContent as Record<string, unknown> & {
            questionMessageId: string;
            invocationId: string;
          },
        };
      };
      return { ...room, alice, helper, trigger: trigger!, helperMcp, ask };
    }

    it("parks the invocation until a human replies, then wakes the agent with the answer", async () => {
      const { app, alice, helper, trigger, helperMcp, ask } = await askRoom();
      const { data } = await ask("发到 @worker 的测试环境还是正式环境？建议测试环境");
      expect(data).toMatchObject({ asked: true, status: "waiting_human" });

      const question = await alice.next(
        (event) => event.type === "message.created" && event.message.kind === "question",
      );
      const questionMessage = question.type === "message.created" ? question.message : undefined;
      // 问题发给人：@ 了发起人，问题里的 @ 被换成全角，不会唤醒别的 Agent
      expect(questionMessage).toMatchObject({
        parentMessageId: trigger.id,
        mentions: ["Alice"],
      });
      expect(questionMessage?.content).toContain("＠worker");

      // 这一轮的心跳与结束都不把调用冲回 running / completed
      helper.send({ type: "invocation.report", messageId: trigger.id, status: "running" });
      helper.send({ type: "invocation.report", messageId: trigger.id, status: "completed" });
      const parked = invocationOf(
        await alice.next(
          (event) =>
            event.type === "invocation.updated" &&
            event.invocation.id === data.invocationId &&
            Boolean(event.invocation.finishedAt),
        ),
      );
      expect(parked.status).toBe("waiting_human");
      expect(parked.detail).toContain("等人回答");

      // 人直接回复提问（不必 @ helper）：旧调用完成，helper 被回答重新唤醒
      alice.send({
        type: "message.send",
        clientMessageId: "answer",
        content: "测试环境",
        replyToMessageId: questionMessage!.id,
      });
      const woken = await helper.next(
        (event) => event.type === "agent.mentioned" && event.message.content === "测试环境",
      );
      expect(woken.type).toBe("agent.mentioned");
      const done = invocationOf(
        await alice.next(
          (event) =>
            event.type === "invocation.updated" &&
            event.invocation.id === data.invocationId &&
            event.invocation.status === "completed",
        ),
      );
      expect(done.detail).toContain("已回答");
      const answerMessage = woken.type === "agent.mentioned" ? woken.message : undefined;
      const port = (app.server.address() as AddressInfo).port;
      const invocations = (await (
        await fetch(`http://127.0.0.1:${port}/api/rooms/general/invocations`, {
          headers: { Authorization: "Bearer test-token" },
        })
      ).json()) as { invocations: Invocation[] };
      expect(
        invocations.invocations.find((item) => item.messageId === answerMessage?.id),
      ).toMatchObject({ agentName: "helper", status: "queued" });

      await helperMcp.client.close();
    });

    it("renders options and turns a validated pick into a full-text answer exactly once", async () => {
      const { alice, helper, ask } = await askRoom();
      const { data } = await ask("先做哪个？", {
        options: ["提交改动", "先跑测试", "写文档"],
        multiple: true,
      });
      expect(data.options).toEqual([
        { key: "A", label: "提交改动" },
        { key: "B", label: "先跑测试" },
        { key: "C", label: "写文档" },
      ]);
      const created = await alice.next(
        (event) => event.type === "message.created" && event.message.id === data.questionMessageId,
      );
      const question = created.type === "message.created" ? created.message : undefined;
      // 正文同样列出选项，纯文本端也能看懂
      expect(question?.question).toEqual({ options: data.options, multiple: true });
      expect(question?.content).toContain("A. 提交改动");
      expect(question?.content).toContain("（可多选）");

      const errorOf = async (event: Record<string, unknown>) => {
        alice.send({ type: "question.answer", questionMessageId: question!.id, ...event });
        const error = await alice.next((item) => item.type === "error");
        return error.type === "error" ? error.code : undefined;
      };
      expect(await errorOf({ clientMessageId: "x1", selected: ["D"] })).toBe("INVALID_ANSWER");
      expect(await errorOf({ clientMessageId: "x2", selected: [] })).toBe("INVALID_ANSWER");
      expect(await errorOf({ clientMessageId: "x3", selected: ["A", "A"] })).toBe("INVALID_ANSWER");

      alice.send({
        type: "question.answer",
        clientMessageId: "pick",
        questionMessageId: question!.id,
        selected: ["C", "A"],
        other: "顺便推送",
      });
      const woken = await helper.next(
        (event) => event.type === "agent.mentioned" && event.message.answer !== undefined,
      );
      const answer = woken.type === "agent.mentioned" ? woken.message : undefined;
      // 正文由服务端按题目顺序生成并带上选项原文；结构化字段只记下所选
      expect(answer).toMatchObject({
        content: "选择 A：提交改动；C：写文档；其它：顺便推送",
        replyToMessageId: question!.id,
        answer: { questionMessageId: question!.id, selected: ["A", "C"], other: "顺便推送" },
      });

      // 同一 clientMessageId 的重试拿回已发出的答案；换个标签页再答被拒绝
      alice.send({
        type: "question.answer",
        clientMessageId: "pick",
        questionMessageId: question!.id,
        selected: ["B"],
      });
      const replayed = await alice.next(
        (event) => event.type === "message.created" && event.message.id === answer!.id,
      );
      expect(replayed.type).toBe("message.created");
      expect(await errorOf({ clientMessageId: "pick-2", selected: ["B"] })).toBe("QUESTION_CLOSED");
    });

    it("keeps single choice to one pick and accepts other alone", async () => {
      const { alice, helper, ask } = await askRoom();
      const { data } = await ask("发到哪？", { options: ["测试环境", "正式环境"] });
      alice.send({
        type: "question.answer",
        clientMessageId: "two",
        questionMessageId: data.questionMessageId,
        selected: ["A"],
        other: "都不要",
      });
      const error = await alice.next((event) => event.type === "error");
      expect(error.type === "error" && error.code).toBe("INVALID_ANSWER");
      alice.send({
        type: "question.answer",
        clientMessageId: "other",
        questionMessageId: data.questionMessageId,
        selected: [],
        other: "先别发",
      });
      const woken = await helper.next(
        (event) => event.type === "agent.mentioned" && event.message.content === "其它：先别发",
      );
      expect(woken.type).toBe("agent.mentioned");
    });

    it("rejects invalid option lists from the agent", async () => {
      const { ask } = await askRoom();
      const { result } = await ask("选一个", { options: ["同一个", "同一个"] });
      expect(result.isError).toBe(true);
    });

    it("refuses questions outside an executing invocation and lets a human stop waiting", async () => {
      const room = await startRoom();
      await room.join("helper", "agent");
      const idle = mcpClient(room.port, "helper");
      await idle.connect();
      const refused = await idle.client.callTool({
        name: "hive_ask_human",
        arguments: { question: "随便问问" },
      });
      expect(refused.isError).toBe(true);
      await idle.client.close();
      closeApp = undefined;
      await room.app.close();

      const { alice, helper, trigger, helperMcp, ask } = await askRoom();
      const { data } = await ask("要不要继续？");
      helper.send({ type: "invocation.report", messageId: trigger.id, status: "completed" });
      await alice.next(
        (event) =>
          event.type === "invocation.updated" &&
          event.invocation.id === data.invocationId &&
          Boolean(event.invocation.finishedAt),
      );
      alice.send({ type: "invocation.cancel", invocationId: data.invocationId });
      const cancelled = invocationOf(
        await alice.next(
          (event) =>
            event.type === "invocation.updated" &&
            event.invocation.id === data.invocationId &&
            event.invocation.status === "cancelled",
        ),
      );
      expect(cancelled.detail).toContain("不再回答");
      await helperMcp.client.close();
    });
  });

  it("links default room clears to recoverable archives, legacy events and current-only Agent reads", async () => {
    const { app, port, join } = await startRoom(undefined, undefined, true);
    const { peer: alice } = await join("Alice", "human");
    await join("helper", "agent");
    const mcp = mcpClient(port, "helper");
    await mcp.connect();
    const result = await mcp.client.callTool({
      name: "hive_board_update",
      arguments: { key: "done", slot: "ready", summary: "done" },
    });
    const entry = (result.structuredContent as { entry: WhiteboardEntry }).entry;
    await alice.next((event) => event.type === "whiteboard.updated");
    alice.send({ type: "message.send", clientMessageId: "room-clear-chat", content: "old chat" });
    await alice.next((event) => event.type === "message.created");
    const { ownerToken } = (await app.inject({ url: "/api/local/session" })).json();
    const response = await app.inject({
      method: "POST",
      url: "/api/local/rooms/general/clear",
      headers: { "x-hive-owner": ownerToken },
      payload: { username: "Alice" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().removed).toMatchObject({ messages: 1, whiteboard: 1 });
    expect(await alice.next((event) => event.type === "whiteboard.removed")).toMatchObject({
      entryId: entry.id,
      archivedEntry: { archivedAt: expect.any(String) },
    });
    expect(await alice.next((event) => event.type === "room.cleared")).toMatchObject({
      whiteboardArchived: true,
    });
    const headers = { authorization: "Bearer test-token" };
    const archived = (
      await app.inject({ url: "/api/rooms/general/whiteboard?view=archived", headers })
    ).json().entries;
    expect(archived).toHaveLength(1);
    expect(
      (await app.inject({ url: "/api/rooms/general/whiteboard", headers })).json().entries,
    ).toEqual([]);
    expect(
      (
        (await mcp.client.callTool({ name: "hive_board_read", arguments: {} }))
          .structuredContent as { entries: WhiteboardEntry[] }
      ).entries,
    ).toEqual([]);
    const { snapshot } = await join("Bob", "human");
    expect(snapshot.type === "room.snapshot" && snapshot.whiteboard).toEqual([]);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/rooms/general/whiteboard/restore",
          headers,
          payload: {
            entries: archived.map(({ id, updatedAt }: WhiteboardEntry) => ({ id, updatedAt })),
          },
        })
      ).statusCode,
    ).toBe(200);
    expect(await alice.next((event) => event.type === "whiteboard.updated")).toMatchObject({
      entry: { id: entry.id },
    });
    await mcp.client.close();
  });

  it("rejects malformed, unauthorized, protected and stale clears before deleting records", async () => {
    const { app, port, join } = await startRoom(undefined, undefined, true);
    const { peer: alice } = await join("Alice", "human");
    await join("helper", "agent");
    const mcp = mcpClient(port, "helper");
    await mcp.connect();
    const update = async (slot: string, summary: string) =>
      (
        (
          await mcp.client.callTool({
            name: "hive_board_update",
            arguments: { key: "task", slot, summary },
          })
        ).structuredContent as { entry: WhiteboardEntry }
      ).entry;
    const entry = await update("ready", "old");
    alice.send({ type: "message.send", clientMessageId: "protected-chat", content: "keep chat" });
    await alice.next((event) => event.type === "message.created");
    const { ownerToken } = (await app.inject({ url: "/api/local/session" })).json();
    const clear = (payload: object, credential = ownerToken) =>
      app.inject({
        method: "POST",
        url: "/api/local/rooms/general/clear",
        headers: { "x-hive-owner": credential },
        payload,
      });
    expect((await clear({ username: "Alice" }, "test-token")).statusCode).toBe(401);
    expect((await clear({ username: "helper" })).statusCode).toBe(403);
    expect((await clear({ username: "absent" })).statusCode).toBe(403);
    expect((await clear({ username: "Alice", whiteboard: "delete" })).statusCode).toBe(400);
    await update("ready", "new");
    expect((await clear({ username: "Alice", entries: [entry] })).json().code).toBe(
      "WHITEBOARD_CONFLICT",
    );
    const headers = { authorization: "Bearer test-token" };
    expect(
      (await app.inject({ url: "/api/rooms/general/messages", headers })).json().messages,
    ).toHaveLength(1);
    expect(
      (await app.inject({ url: "/api/rooms/general/whiteboard?view=archived", headers })).json()
        .entries,
    ).toEqual([]);
    expect((await clear({ username: "Alice", whiteboard: "keep" })).statusCode).toBe(200);
    expect(await alice.next((event) => event.type === "room.cleared")).toMatchObject({
      whiteboardArchived: false,
    });
    expect(
      (await app.inject({ url: "/api/rooms/general/whiteboard", headers })).json().entries,
    ).toMatchObject([{ slot: "ready", summary: "new" }]);
    await mcp.client.close();
  });

  it("archives and restores batches while keeping legacy peers and Agent reads current-only", async () => {
    const { app, port, join } = await startRoom();
    const { peer: alice } = await join("Alice", "human");
    await join("helper", "agent");
    const mcp = mcpClient(port, "helper");
    await mcp.connect();
    const entries: WhiteboardEntry[] = [];
    for (const key of ["first", "second"]) {
      const result = await mcp.client.callTool({
        name: "hive_board_update",
        arguments: { key, slot: "ready", summary: "done" },
      });
      entries.push((result.structuredContent as { entry: WhiteboardEntry }).entry);
      await alice.next((event) => event.type === "whiteboard.updated");
    }
    const request = (action: string, selected: WhiteboardEntry[]) =>
      app.inject({
        method: "POST",
        url: `/api/rooms/general/whiteboard/${action}`,
        headers: { authorization: "Bearer test-token" },
        payload: { entries: selected.map(({ id, updatedAt }) => ({ id, updatedAt })) },
      });
    const archive = await request("archive", entries);
    expect(archive.statusCode).toBe(200);
    const archived = archive.json<{ entries: WhiteboardEntry[] }>().entries;
    for (const entry of archived) {
      const event = await alice.next(
        (event) => event.type === "whiteboard.removed" && event.entryId === entry.id,
      );
      expect(event).toMatchObject({ archivedEntry: entry });
    }
    const read = async (query = "") =>
      (
        await app.inject({
          url: `/api/rooms/general/whiteboard${query}`,
          headers: { authorization: "Bearer test-token" },
        })
      ).json<{ entries: WhiteboardEntry[] }>().entries;
    expect(await read()).toEqual([]);
    expect(await read("?view=archived")).toHaveLength(2);
    expect(await read("?view=all")).toHaveLength(2);
    expect(
      (
        (await mcp.client.callTool({ name: "hive_board_read", arguments: {} }))
          .structuredContent as { entries: WhiteboardEntry[] }
      ).entries,
    ).toEqual([]);
    const { snapshot } = await join("Bob", "human");
    expect(snapshot.type === "room.snapshot" && snapshot.whiteboard).toEqual([]);
    const restoredResponse = await request("restore", archived);
    expect(restoredResponse.statusCode).toBe(200);
    const restored = restoredResponse.json<{ entries: WhiteboardEntry[] }>().entries;
    for (const entry of restored)
      await alice.next(
        (event) => event.type === "whiteboard.updated" && event.entry.id === entry.id,
      );
    expect(await read()).toHaveLength(2);
    expect((await request("restore", archived)).statusCode).toBe(409);
    alice.send({
      type: "whiteboard.remove",
      entryId: archived[0]!.id,
      updatedAt: archived[0]!.updatedAt,
    });
    expect(await alice.next((event) => event.type === "error")).toMatchObject({
      code: "WHITEBOARD_CONFLICT",
    });
    expect(await read()).toHaveLength(2);
    await mcp.client.close();
  });

  it("rejects unauthorized, malformed, protected, stale and foreign-room archive requests", async () => {
    const { app, port, join } = await startRoom();
    await join("helper", "agent");
    const mcp = mcpClient(port, "helper");
    await mcp.connect();
    const update = async (key: string, slot: string, summary = "task") =>
      (
        (
          await mcp.client.callTool({
            name: "hive_board_update",
            arguments: { key, slot, summary },
          })
        ).structuredContent as { entry: WhiteboardEntry }
      ).entry;
    const ready = await update("ready", "ready");
    const request = (
      selected: Array<{ id: string; updatedAt: string }>,
      room = "general",
      token = "test-token",
    ) =>
      app.inject({
        method: "POST",
        url: `/api/rooms/${room}/whiteboard/archive`,
        headers: { authorization: `Bearer ${token}` },
        payload: { entries: selected },
      });
    expect((await request([ready], "general", "wrong-token")).statusCode).toBe(401);
    expect((await request([])).statusCode).toBe(400);
    expect((await request([ready, ready])).statusCode).toBe(400);
    expect((await request([{ id: ready.id, updatedAt: "invalid" }])).statusCode).toBe(400);
    expect((await request([ready], "other")).statusCode).toBe(404);
    await update("ready", "ready", "changed");
    expect((await request([ready])).json().code).toBe("WHITEBOARD_CONFLICT");
    const headers = { authorization: "Bearer test-token" };
    expect(
      (await app.inject({ url: "/api/rooms/general/whiteboard?view=archived", headers })).json()
        .entries,
    ).toEqual([]);
    expect(
      (await app.inject({ url: "/api/rooms/general/whiteboard?view=invalid", headers })).statusCode,
    ).toBe(400);
    await mcp.client.close();
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

describe("网页安全响应头", () => {
  it("网页带内容安全策略，不允许内联脚本、不被嵌入、不带 Referer（链接里有登录票）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hive-static-"));
    writeFileSync(path.join(dir, "index.html"), "<!doctype html><div id=root></div>");
    const app = await buildApp({ databasePath: ":memory:", staticDir: dir });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/",
        headers: { host: "10.0.0.8:8787" },
      });
      const policy = String(response.headers["content-security-policy"]);
      expect(policy).toContain("script-src 'self'");
      expect(policy).toContain("frame-ancestors 'none'");
      // PDF 预览的 blob 能放进 iframe；插件仍然一律不许
      expect(policy).toContain("frame-src 'self' blob:");
      expect(policy).toContain("object-src 'none'");
      expect(policy).toContain("connect-src 'self' ws://10.0.0.8:8787 wss://10.0.0.8:8787");
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
      // 接口不受影响
      const meta = await app.inject({ method: "GET", url: "/api/meta" });
      expect(meta.headers["content-security-policy"]).toBeUndefined();
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
