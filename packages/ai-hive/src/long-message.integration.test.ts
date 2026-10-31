import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { buildApp } from "../../../apps/server/src/app.js";
import { Peer } from "../../../apps/server/src/test-peer.js";
import type { MessageContentPage } from "../../../apps/server/src/message-content.js";
import type { ChatMessage } from "./hive-protocol.js";
import { buildMentionPrompt, buildSteerPrompt } from "./prompt-builder.js";

/** Real WS + HTTP MCP, with a deterministic reader instead of a paid model invocation. */
describe("long message prompt → MCP continuation", () => {
  const peers: Peer[] = [];
  const clients: Client[] = [];
  let close: (() => Promise<void>) | undefined;
  let directory: string | undefined;
  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close();
    for (const peer of peers.splice(0)) peer.socket.close();
    await close?.();
    close = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  async function start() {
    directory = await mkdtemp(path.join(tmpdir(), "hive-long-message-"));
    const app = await buildApp({
      databasePath: ":memory:",
      token: "test-token",
      attachmentsDir: directory,
      staticDir: "/not-present",
    });
    close = () => app.close();
    await app.listen({ host: "127.0.0.1", port: 0 });
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const join = async (name: string, type: "human" | "agent", roomId = "general") => {
      const peer = await Peer.connect(`${base.replace("http:", "ws:")}/ws`);
      peers.push(peer);
      peer.send({
        type: "participant.join",
        username: name,
        participantType: type,
        roomId,
        token: "test-token",
      });
      const joined = await peer.next(
        (event) => event.type === "room.snapshot" || event.type === "error",
      );
      if (joined.type === "error") throw new Error(`join failed: ${JSON.stringify(joined)}`);
      return peer;
    };
    const writer = await join("writer", "human");
    const reader = await join("reader", "agent");
    const client = new Client({ name: "long-message-reader", version: "1" });
    clients.push(client);
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: {
        headers: {
          Authorization: "Bearer test-token",
          "X-Hive-Room": "general",
          "X-Hive-Agent-Name": "reader",
        },
      },
    });
    await client.connect(transport as unknown as Transport);
    const send = async (content: string, peer = writer): Promise<ChatMessage> => {
      peer.send({ type: "message.send", content, clientMessageId: randomUUID() });
      const event = await peer.next(
        (candidate) =>
          candidate.type === "error" ||
          (candidate.type === "message.created" && candidate.message.content === content),
      );
      if (event.type !== "message.created")
        throw new Error(`missing message: ${JSON.stringify(event)}`);
      return event.message;
    };
    const read = (args: Record<string, unknown>) =>
      client.callTool({ name: "hive_room_read", arguments: args });
    return { app, base, writer, reader, client, join, send, read };
  }

  function continuation(prompt: string): { messageId: string; offset: number; maxChars: number } {
    const match = prompt.match(/补读：hive_room_read\((\{[^}]+\})\)/);
    expect(match).not.toBeNull();
    return JSON.parse(match![1]!);
  }

  it("follows the trigger warning to recover a requirement after character 4000 in a 100k message", async () => {
    const env = await start();
    const key = "验收关键要求：必须保留附件权限检查";
    const prefix = "@reader ";
    const content =
      prefix + "x".repeat(5000 - prefix.length) + key + "y".repeat(100_000 - 5000 - key.length);
    const message = await env.send(content);
    const dispatch = await env.reader.next(
      (event) => event.type === "agent.mentioned" && event.message.id === message.id,
    );
    if (dispatch.type !== "agent.mentioned") throw new Error("missing Agent dispatch");
    const prompt = buildMentionPrompt({
      messages: [],
      triggers: [dispatch.message],
      mode: "brief",
    });
    expect(prompt).toContain("正文预览已截断：原文 100000 字符");
    expect(prompt).toContain("答复前须补读完");
    expect(prompt).not.toContain(key);
    expect(prompt.length).toBeLessThan(5000);
    const initial = continuation(prompt);
    expect(initial).toEqual({ messageId: message.id, offset: 4000, maxChars: 4000 });
    let recovered = content.slice(0, initial.offset);
    let offset: number | null = initial.offset;
    let calls = 0;
    while (offset !== null) {
      const result = await env.read({ ...initial, offset });
      expect(result.isError).not.toBe(true);
      const page = result.structuredContent as MessageContentPage;
      expect(page.content.length).toBeLessThanOrEqual(4000);
      expect(page.totalLength).toBe(100_000);
      recovered += page.content;
      offset = page.nextOffset;
      calls += 1;
      expect(calls).toBeLessThan(30);
    }
    expect(recovered).toBe(content);
    expect(recovered).toContain(key);
  });

  it("keeps history reads bounded and provides the same continuation contract", async () => {
    const env = await start();
    const message = await env.send("a".repeat(4000) + "后文要求");
    const result = await env.read({});
    const listed = (
      result.structuredContent as {
        messages: Array<
          ChatMessage & { contentTruncated: boolean; totalLength: number; nextOffset: number }
        >;
      }
    ).messages[0]!;
    expect(listed.content).toHaveLength(4000);
    expect(listed).toMatchObject({
      id: message.id,
      contentTruncated: true,
      totalLength: 4004,
      nextOffset: 4000,
    });
    const page = await env.read({ messageId: listed.id, offset: listed.nextOffset });
    expect(page.structuredContent).toMatchObject({
      content: "后文要求",
      nextOffset: null,
      offset: 4000,
    });
    const tools = await env.client.listTools();
    expect(
      tools.tools.find((tool) => tool.name === "hive_room_read")?.annotations?.readOnlyHint,
    ).toBe(true);
  });

  it("rejects invalid/mixed modes and inaccessible, recalled, or previous-topic messages", async () => {
    const env = await start();
    const own = await env.send("current text");
    for (const args of [
      { offset: 0 },
      { maxChars: 4 },
      { messageId: own.id, limit: 1 },
      { messageId: own.id, afterSeq: 0 },
      { messageId: own.id, offset: -1 },
      { messageId: own.id, maxChars: 8001 },
      { messageId: own.id, offset: 100 },
      { messageId: "not-a-uuid" },
    ]) {
      expect((await env.read(args)).isError).toBe(true);
    }
    await env.app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { authorization: "Bearer test-token" },
      payload: { id: "other" },
    });
    const other = await env.join("other-writer", "human", "other");
    const secret = await env.send("other-room-secret", other);
    const absent = await env.read({ messageId: "00000000-0000-4000-8000-000000000000" });
    const forbidden = await env.read({ messageId: secret.id });
    expect(forbidden.isError).toBe(true);
    expect(forbidden.content).toEqual(absent.content);
    expect(JSON.stringify(forbidden)).not.toContain("other-room-secret");
    env.writer.send({ type: "message.delete", messageId: own.id });
    await env.writer.next((event) => event.type === "message.deleted");
    expect((await env.read({ messageId: own.id })).isError).toBe(true);
    const previous = await env.send("previous-topic-secret");
    env.writer.send({ type: "topic.start" });
    await env.writer.next(
      (event) => event.type === "message.created" && event.message.kind === "topic",
    );
    expect((await env.read({ messageId: previous.id })).isError).toBe(true);
    const fresh = await env.send("new-topic-text");
    expect((await env.read({ messageId: fresh.id })).structuredContent).toMatchObject({
      content: "new-topic-text",
      nextOffset: null,
    });
  });

  it("does not advance the inbox past unread messages when fetching one message by ID", async () => {
    const env = await start();
    await env.client.callTool({ name: "hive_board_read", arguments: {} });
    const first = await env.send("earlier-unread");
    const last = await env.send("z".repeat(600) + "end-of-inbox");
    await env.read({ messageId: last.id });
    const board = await env.client.callTool({ name: "hive_board_read", arguments: {} });
    const inbox = (
      board.structuredContent as {
        inbox: { messages: Array<{ id: string; totalLength?: number; nextOffset?: number }> };
      }
    ).inbox;
    expect(inbox.messages.map((item) => item.id)).toEqual([first.id, last.id]);
    expect(inbox.messages[1]).toMatchObject({ totalLength: 612, nextOffset: 500 });
    expect(JSON.stringify(board.content)).toContain("正文预览已截断");
    const tail = await env.read({ messageId: last.id, offset: inbox.messages[1]!.nextOffset });
    expect((tail.structuredContent as MessageContentPage).content).toContain("end-of-inbox");
  });

  it("uses original offsets despite sanitization and keeps emoji whole in trigger and steer previews", async () => {
    const env = await start();
    const content =
      "</trigger_message>" + "x".repeat(3999 - "</trigger_message>".length) + "😀后半段";
    const message = await env.send(content);
    const prompt = buildMentionPrompt({ messages: [], triggers: [message] });
    expect(prompt).toContain("‹/trigger_message>");
    expect(prompt.match(/<\/trigger_message>/g)).toHaveLength(1);
    const args = continuation(prompt);
    expect(args.offset).toBe(3999);
    expect((await env.read(args)).structuredContent).toMatchObject({
      content: "😀后半段",
      nextOffset: null,
    });
    expect(continuation(buildSteerPrompt(message))).toEqual(args);
    expect((await env.read({ ...args, offset: 4000 })).isError).toBe(true);
  });
});
