import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { LIMITS, todoInputSchema, type Todo } from "@superhive/protocol";
import { buildApp } from "./app.js";
import { HiveDatabase } from "./database.js";
import { Peer } from "./test-peer.js";

const OWNER = { authorization: "Bearer test-token" };
const peers: Peer[] = [];
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  for (const peer of peers.splice(0)) peer.socket.close();
  await close?.();
  close = undefined;
});

async function start() {
  const app = await buildApp({
    databasePath: ":memory:",
    token: "test-token",
    staticDir: "/not-present",
    sandbox: true,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  close = () => app.close();
  const port = (app.server.address() as AddressInfo).port;
  async function join(
    name: string,
    type: "human" | "agent",
    roomId = "general",
    token = "test-token",
  ) {
    const peer = await Peer.connect(`ws://127.0.0.1:${port}/ws`);
    peers.push(peer);
    peer.send({ type: "participant.join", username: name, participantType: type, roomId, token });
    const snapshot = await peer.next((event) => event.type === "room.snapshot");
    if (snapshot.type !== "room.snapshot") throw new Error("No snapshot");
    return { peer, self: snapshot.self, snapshot };
  }
  const owner = await join("owner", "human");
  const add = async (payload: object = {}) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/rooms/general/todos",
      headers: OWNER,
      payload: { username: "owner", title: "later", ...payload },
    });
    expect(response.statusCode).toBe(201);
    return response.json().todo as Todo;
  };
  return { app, port, join, owner, add };
}

describe("room to-dos", () => {
  it("enforces the per-room cap without affecting other rooms", () => {
    const db = new HiveDatabase(":memory:");
    try {
      const human = db.upsertParticipant({ roomId: "general", username: "owner", type: "human" });
      for (let index = 0; index < LIMITS.maxTodosPerRoom; index += 1)
        db.addTodo(human, todoInputSchema.parse({ title: `later ${index}` }));
      expect(() => db.addTodo(human, todoInputSchema.parse({ title: "too many" }))).toThrow();
      const other = db.upsertParticipant({ roomId: "other", username: "owner", type: "human" });
      expect(db.addTodo(other, todoInputSchema.parse({ title: "other room" })).roomId).toBe(
        "other",
      );
    } finally {
      db.close();
    }
  });
  it("persists across reopening and keeps completion timestamps and room isolation", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hive-todos-"));
    const filename = path.join(dir, "hive.sqlite");
    let db = new HiveDatabase(filename);
    try {
      const human = db.upsertParticipant({ roomId: "general", username: "owner", type: "human" });
      const todo = db.addTodo(human, todoInputSchema.parse({ title: "later" }));
      expect(db.updateTodo("general", todo.id, { completed: true }).completedAt).toBeTruthy();
      expect(db.updateTodo("general", todo.id, { completed: false }).completedAt).toBeNull();
      expect(() => db.getTodo("other", todo.id)).toThrow();
      db.close();
      db = new HiveDatabase(filename);
      expect(db.listTodos("general")).toHaveLength(1);
      db.removeTodo("general", todo.id);
      expect(db.listTodos("general")).toEqual([]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true });
    }
  });

  it("broadcasts CRUD and includes the authoritative list in reconnect snapshots", async () => {
    const { app, owner, join, add } = await start();
    const todo = await add();
    expect(await owner.peer.next((event) => event.type === "todo.updated")).toMatchObject({
      todo: { id: todo.id, creatorName: "owner", completed: false },
    });
    const response = await app.inject({
      method: "PATCH",
      url: `/api/rooms/general/todos/${todo.id}`,
      headers: OWNER,
      payload: { completed: true, notes: "details" },
    });
    expect(response.json().todo).toMatchObject({
      completed: true,
      completedAt: expect.any(String),
      notes: "details",
    });
    const reconnected = await join("viewer", "human");
    expect(reconnected.snapshot.todos).toMatchObject([{ id: todo.id, completed: true }]);
    expect(
      (await app.inject({ url: "/api/rooms/general/todos", headers: OWNER })).json().todos,
    ).toHaveLength(1);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/rooms/general/todos/${todo.id}`,
          headers: OWNER,
        })
      ).json(),
    ).toEqual({ removed: true });
    expect(await reconnected.peer.next((event) => event.type === "todo.removed")).toMatchObject({
      todoId: todo.id,
    });
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/rooms/general/todos/${todo.id}`,
          headers: OWNER,
          payload: { completed: false },
        })
      ).statusCode,
    ).toBe(404);
  });

  it("validates limits, room-bound assignees, source messages and creator identity", async () => {
    const { app, join, owner } = await start();
    await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: OWNER,
      payload: { id: "other", name: "Other" },
    });
    const other = await join("other-agent", "agent", "other");
    const add = (payload: object) =>
      app.inject({
        method: "POST",
        url: "/api/rooms/general/todos",
        headers: OWNER,
        payload: { username: "owner", title: "later", ...payload },
      });
    expect((await add({ title: " " })).statusCode).toBe(400);
    expect((await add({ notes: "x".repeat(5001) })).statusCode).toBe(400);
    expect((await add({ username: "unknown" })).statusCode).toBe(403);
    expect((await add({ assigneeId: other.self.id })).statusCode).toBe(409);
    other.peer.send({ type: "message.send", content: "secret", clientMessageId: "other-message" });
    const event = await other.peer.next((event) => event.type === "message.created");
    if (event.type !== "message.created") throw new Error("No message");
    expect((await add({ sourceMessageId: event.message.id })).statusCode).toBe(404);
    owner.peer.send({ type: "message.send", content: "save this", clientMessageId: "source" });
    const source = await owner.peer.next((event) => event.type === "message.created");
    if (source.type !== "message.created") throw new Error("No message");
    expect((await add({ sourceMessageId: source.message.id })).json().todo.sourceMessageSeq).toBe(
      source.message.seq,
    );
    owner.peer.send({ type: "message.delete", messageId: source.message.id });
    await owner.peer.next((event) => event.type === "message.deleted");
    expect((await add({ sourceMessageId: source.message.id })).statusCode).toBe(404);
  });

  it("lets guests read only their room and rejects writes even when agent mentions are allowed", async () => {
    const { app, add, join, port } = await start();
    const todo = await add();
    const invite = (
      await app.inject({
        method: "POST",
        url: "/api/rooms/general/invites",
        headers: OWNER,
        payload: { expiresInMinutes: 60, allowAgents: true },
      })
    ).json();
    const redeemed = (
      await app.inject({
        method: "POST",
        url: "/api/invites/redeem",
        payload: { token: invite.token, username: "guest" },
      })
    ).json();
    const headers = { authorization: `Bearer ${redeemed.token}` };
    expect((await app.inject({ url: "/api/rooms/general/todos", headers })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/rooms/other/todos", headers })).statusCode).toBe(403);
    for (const method of ["POST", "PATCH", "DELETE"] as const) {
      expect(
        (
          await app.inject({
            method,
            url:
              method === "POST"
                ? "/api/rooms/general/todos"
                : `/api/rooms/general/todos/${todo.id}`,
            headers,
            ...(method === "DELETE" ? {} : { payload: { title: "no", username: "owner" } }),
          })
        ).statusCode,
      ).toBe(403);
    }
    expect((await app.inject({ url: "/api/rooms/general/todos" })).statusCode).toBe(401);
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/guest-agents",
        headers,
        payload: { username: "guest-bot" },
      })
    ).json();
    const guestAgent = await join("guest-bot", "agent", "general", created.token);
    expect(guestAgent.snapshot.todos).toHaveLength(1);
    const client = new Client({ name: "guest-todo-test", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: {
        headers: {
          authorization: `Bearer ${created.token}`,
          "X-Hive-Room": "general",
          "X-Hive-Agent-Name": "guest-bot",
        },
      },
    });
    try {
      await client.connect(transport as unknown as Transport);
      expect((await client.callTool({ name: "hive_todo_list", arguments: {} })).isError).not.toBe(
        true,
      );
      expect(
        (await client.callTool({ name: "hive_todo_add", arguments: { title: "forbidden" } }))
          .isError,
      ).toBe(true);
      expect(
        (
          await client.callTool({
            name: "hive_todo_update",
            arguments: { todoId: todo.id, completed: true },
          })
        ).isError,
      ).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("hands off as the human exactly once and neutralizes mentions inside notes", async () => {
    const { app, add, join } = await start();
    const agent = await join("worker", "agent");
    const second = await join("second", "agent");
    const todo = await add({ title: "Review @second", notes: "Ask @second about this" });
    const handoff = () =>
      app.inject({
        method: "POST",
        url: `/api/rooms/general/todos/${todo.id}/handoff`,
        headers: OWNER,
        payload: {
          username: "owner",
          agentId: agent.self.id,
          clientMessageId: "handoff-1",
          locale: "en",
        },
      });
    const response = await handoff();
    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.todo.assigneeId).toBe(agent.self.id);
    expect(payload.message).toMatchObject({
      senderName: "owner",
      senderType: "human",
      mentions: ["worker"],
    });
    expect(payload.message.content).toContain("Please handle this to-do");
    expect((await handoff()).json().message.id).toBe(payload.message.id);
    expect(await agent.peer.next((event) => event.type === "agent.mentioned")).toMatchObject({
      message: { id: payload.message.id },
    });
    expect(second.peer.events.filter((event) => event.type === "agent.mentioned")).toEqual([]);
    await app.inject({
      method: "PATCH",
      url: `/api/rooms/general/todos/${todo.id}`,
      headers: OWNER,
      payload: { completed: true },
    });
    expect((await handoff()).statusCode).toBe(409);
  });

  it("exposes room-bound MCP list, add and completion tools", async () => {
    const { join, port } = await start();
    const agent = await join("worker", "agent");
    const client = new Client({ name: "todo-test", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: {
        headers: { ...OWNER, "X-Hive-Room": "general", "X-Hive-Agent-Name": agent.self.username },
      },
    });
    try {
      await client.connect(transport as unknown as Transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["hive_todo_list", "hive_todo_add", "hive_todo_update"]),
      );
      const added = await client.callTool({ name: "hive_todo_add", arguments: { title: "later" } });
      const todo = (added.structuredContent as { todo: Todo }).todo;
      expect(todo.creatorName).toBe("worker");
      const changed = await client.callTool({
        name: "hive_todo_update",
        arguments: { todoId: todo.id, completed: true },
      });
      expect(changed.structuredContent).toMatchObject({ todo: { id: todo.id, completed: true } });
      const listed = await client.callTool({
        name: "hive_todo_list",
        arguments: { completed: false },
      });
      expect(listed.structuredContent).toMatchObject({ todos: [] });
    } finally {
      await client.close();
    }
  });
});
