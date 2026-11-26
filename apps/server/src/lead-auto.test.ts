import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, RoomSummary, ServerEvent } from "@superhive/protocol";
import { buildApp } from "./app.js";
import { HiveDatabase } from "./database.js";
import type { ChildHandle, SpawnAgent } from "./local-agents.js";
import { Peer } from "./test-peer.js";

let cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const step of cleanup.reverse()) await step();
  cleanup = [];
});

const DELAY = 40;

function tempDatabase(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "hive-lead-auto-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, "hive.sqlite");
}

const fakeSpawn = vi.fn<SpawnAgent>(() => {
  const exit = new EventEmitter();
  return {
    pid: undefined,
    onOutput: () => undefined,
    onExit: (listener) => {
      exit.on("exit", listener);
    },
    kill: () => {
      exit.emit("exit", 0);
    },
  } satisfies ChildHandle;
});

async function hive(
  options: {
    databasePath?: string;
    local?: readonly string[];
    supervisor?: boolean;
  } = {},
) {
  const local = new Set((options.local ?? []).map((name) => name.toLocaleLowerCase()));
  const app = await buildApp({
    databasePath: options.databasePath ?? ":memory:",
    token: "test-token",
    staticDir: "/definitely-not-present",
    autoLead: options.supervisor
      ? { delayMs: DELAY }
      : { delayMs: DELAY, isLocal: (name) => local.has(name.toLocaleLowerCase()) },
    ...(options.supervisor
      ? {
          localAgents: {
            cli: { command: "fake", args: [] },
            serverUrl: "http://127.0.0.1",
            spawn: fakeSpawn,
            probe: async () => ({ installed: true, version: "test" }),
            findStrays: () => [],
          },
        }
      : {}),
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  cleanup.push(() => app.close());
  const port = (app.server.address() as AddressInfo).port;
  const join = async (username: string, participantType: "human" | "agent", roomId = "general") => {
    const peer = await Peer.connect(`ws://127.0.0.1:${port}/ws`);
    cleanup.push(() => peer.socket.close());
    peer.send({ type: "participant.join", username, participantType, roomId, token: "test-token" });
    await peer.next((event) => event.type === "room.snapshot");
    return peer;
  };
  const patch = (payload: Record<string, unknown>, roomId = "general") =>
    app.inject({
      method: "PATCH",
      url: `/api/rooms/${roomId}`,
      headers: { authorization: "Bearer test-token" },
      payload,
    });
  const room = async (roomId = "general"): Promise<RoomSummary> => {
    const response = await app.inject({
      url: "/api/rooms",
      headers: { authorization: "Bearer test-token" },
    });
    return (response.json().rooms as RoomSummary[]).find((item) => item.id === roomId)!;
  };
  const messages = async (roomId = "general"): Promise<ChatMessage[]> => {
    const response = await app.inject({
      url: `/api/rooms/${roomId}/messages`,
      headers: { authorization: "Bearer test-token" },
    });
    return response.json().messages as ChatMessage[];
  };
  return { app, join, patch, room, messages };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, DELAY * 4));

function leadChanged(peer: Peer, name: string | undefined) {
  return peer.next(
    (event) =>
      event.type === "rooms.changed" &&
      event.room.id === "general" &&
      event.room.leadAgent === name,
  ) as Promise<Extract<ServerEvent, { type: "rooms.changed" }>>;
}

describe("default lead agent", () => {
  it("makes the first agent that comes online the lead and posts a notice that wakes no one", async () => {
    const { join, room, messages } = await hive();
    const alice = await join("Alice", "human");
    const first = await join("first", "agent");
    const changed = await leadChanged(alice, "first");
    expect(changed.room.leadMode).toBe("auto");
    expect(await room()).toMatchObject({ leadAgent: "first", leadMode: "auto" });

    const notice = (await messages()).find((message) => message.kind === "notice")!;
    expect(notice).toMatchObject({ senderName: "first", mentions: [] });
    expect(notice.content).toContain("first 自动成为这个房间的主 Agent");
    expect(notice.content).toContain("底部状态栏");
    expect(notice.text?.key).toBe("notice.leadAuto");
    // 提示不唤醒任何人
    await expect(first.next((event) => event.type === "agent.mentioned", 150)).rejects.toThrow();

    // 之后加入的不改主 Agent
    await join("second", "agent");
    await settle();
    expect((await room()).leadAgent).toBe("first");
    expect((await messages()).filter((message) => message.kind === "notice")).toHaveLength(1);

    // 自动设的主 Agent 照常接没 @ 的消息
    alice.send({ type: "message.send", clientMessageId: "plain", content: "帮我看下 README" });
    const mentioned = await first.next((event) => event.type === "agent.mentioned");
    expect(mentioned).toMatchObject({ lead: true });
  });

  it("prefers a local agent when several come online together, then join order", async () => {
    const { join, room } = await hive({ local: ["local-b", "local-c"] });
    await Promise.all([join("remote-a", "agent"), join("local-b", "agent")]);
    await join("local-c", "agent");
    await settle();
    expect((await room()).leadAgent).toBe("local-b");
  });

  it("falls back to join order when no local agent is around", async () => {
    const { join, room } = await hive();
    await join("one", "agent");
    await join("two", "agent");
    await settle();
    expect((await room()).leadAgent).toBe("one");
  });

  it("remembers when the owner cancels the lead and never auto-assigns again", async () => {
    const { join, patch, room, messages } = await hive();
    await join("first", "agent");
    await settle();
    expect((await room()).leadAgent).toBe("first");

    const cancelled = await patch({ leadAgent: null });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().room).toMatchObject({ leadMode: "manual" });
    expect(cancelled.json().room.leadAgent).toBeUndefined();

    await join("second", "agent");
    await settle();
    expect((await room()).leadAgent).toBeUndefined();
    expect((await messages()).filter((message) => message.kind === "notice")).toHaveLength(1);

    // 改回自动：马上挑一个在线的
    const auto = await patch({ leadMode: "auto" });
    expect(auto.statusCode).toBe(200);
    expect(auto.json().room).toMatchObject({ leadAgent: "first", leadMode: "auto" });
    // 不能一边改回自动一边指定人
    expect((await patch({ leadMode: "auto", leadAgent: "second" })).statusCode).toBe(400);
  });

  it("never overrides a lead the owner picked by hand", async () => {
    const { join, patch, room } = await hive({ local: ["local"] });
    const remote = await join("remote", "agent");
    // 窗口还没到，房主先手动指定
    expect((await patch({ leadAgent: "remote" })).json().room).toMatchObject({
      leadAgent: "remote",
      leadMode: "manual",
    });
    await join("local", "agent");
    await settle();
    expect(await room()).toMatchObject({ leadAgent: "remote", leadMode: "manual" });

    // 手动设的只是离线也不换
    remote.socket.close();
    await settle();
    expect(await room()).toMatchObject({ leadAgent: "remote", leadMode: "manual" });
  });

  it("does not hand over when the auto lead merely goes offline", async () => {
    const { join, room } = await hive();
    const first = await join("first", "agent");
    await join("second", "agent");
    await settle();
    first.socket.close();
    await settle();
    expect(await room()).toMatchObject({ leadAgent: "first", leadMode: "auto" });
  });
});

describe("default lead agent with local agents", () => {
  async function supervised() {
    const databasePath = tempDatabase();
    const hub = await hive({ databasePath, supervisor: true });
    const session = (await hub.app.inject({ url: "/api/local/session" })).json();
    const headers = { "x-hive-owner": session.ownerToken as string };
    const create = async (name: string) => {
      const response = await hub.app.inject({
        method: "POST",
        url: "/api/local/agents",
        headers,
        payload: { provider: "claude", name, access: "read-only", cwd: tmpdir() },
      });
      expect(response.statusCode).toBe(201);
      return response.json().agent as { id: string; name: string };
    };
    const remove = (id: string) =>
      hub.app.inject({ method: "DELETE", url: `/api/local/agents/${id}`, headers });
    return { ...hub, create, remove };
  }

  it("hands an auto lead over to the next online agent (local first) when it is deleted", async () => {
    const { join, room, messages, create, remove } = await supervised();
    const lead = await create("lead-local");
    await create("next-local");
    const alice = await join("Alice", "human");
    await join("lead-local", "agent");
    await leadChanged(alice, "lead-local");
    await join("remote", "agent");
    await join("next-local", "agent");
    await settle();

    expect((await remove(lead.id)).statusCode).toBe(204);
    const changed = await leadChanged(alice, "next-local");
    expect(changed.room.leadMode).toBe("auto");
    const notice = (await messages()).filter((message) => message.kind === "notice").at(-1)!;
    expect(notice.text?.key).toBe("notice.leadSucceeded");
    expect(notice.content).toContain("lead-local 已不在这个房间，主 Agent 自动换成 next-local");
    expect(notice.mentions).toEqual([]);
    expect((await room()).leadAgent).toBe("next-local");
  });

  it("keeps a hand-picked lead after it is deleted so the owner chooses again", async () => {
    const { join, patch, room, messages, create, remove } = await supervised();
    const lead = await create("picked");
    await join("picked", "agent");
    await join("other", "agent");
    await settle();
    expect((await patch({ leadAgent: "picked" })).statusCode).toBe(200);
    const notices = (await messages()).filter((message) => message.kind === "notice").length;

    expect((await remove(lead.id)).statusCode).toBe(204);
    await settle();
    expect(await room()).toMatchObject({ leadAgent: "picked", leadMode: "manual" });
    expect((await messages()).filter((message) => message.kind === "notice")).toHaveLength(notices);
  });
});

describe("lead mode migration", () => {
  it("marks leads set before the upgrade as hand-picked and leaves empty rooms on auto", () => {
    const databasePath = tempDatabase();
    const legacy = new HiveDatabase(databasePath);
    legacy.ensureRoom("picked", "Alice");
    legacy.ensureRoom("empty", "Alice");
    legacy.updateRoom("picked", { leadAgent: "Lead" });
    // 模拟旧库：没有 lead_mode 这一列
    legacy.connection().exec("ALTER TABLE rooms DROP COLUMN lead_mode");
    legacy.close();

    const upgraded = new HiveDatabase(databasePath);
    cleanup.push(() => upgraded.close());
    expect(upgraded.getRoom("picked")).toMatchObject({ leadAgent: "Lead", leadMode: "manual" });
    expect(upgraded.getRoom("empty")?.leadMode).toBeUndefined();
    expect(upgraded.getRoom("empty")?.leadAgent).toBeUndefined();
  });
});
