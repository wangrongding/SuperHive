import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerEvent } from "@superhive/protocol";
import { buildApp } from "./app.js";
import { HiveDatabase } from "./database.js";
import type { ChildHandle, SpawnAgent } from "./local-agents.js";

describe("removed local agent recovery", () => {
  const cleanup: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    for (const dispose of cleanup.reverse()) await dispose();
    cleanup.length = 0;
  });

  async function setup(options: { legacy?: boolean; remote?: boolean } = {}) {
    const directory = mkdtempSync(path.join(tmpdir(), "hive-rejoin-test-"));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const databasePath = path.join(directory, "hive.sqlite");
    const db = new HiveDatabase(databasePath);
    db.ensureRoom("general", "Alice");
    const member = db.upsertParticipant({
      roomId: "general",
      username: "Alice-claude",
      type: "agent",
      provider: "claude",
    });
    db.setParticipantStatus(member.id, "offline");
    if (options.legacy) {
      db.connection().exec(`CREATE TABLE managed_worktrees (
        id TEXT PRIMARY KEY, repo TEXT, agent_name TEXT, slug TEXT, path TEXT, branch TEXT, record TEXT
      )`);
      db.connection()
        .prepare("INSERT INTO managed_worktrees VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(
          "legacy",
          directory,
          member.username,
          "old",
          directory,
          "old",
          JSON.stringify({
            id: "legacy",
            repo: directory,
            agentName: member.username,
            roomId: "general",
            path: directory,
            branch: "old",
            phase: "ready",
          }),
        );
    } else if (!options.remote) {
      const config = db.createLocalAgent({
        provider: "claude",
        name: member.username,
        access: "full",
        cwd: directory,
        model: null,
      });
      db.deleteLocalAgent(config.id);
    }
    const { message } = db.createMessage(member, {
      content: "old result",
      clientMessageId: "old-result",
    });
    const { entry } = db.upsertWhiteboardEntry(member, {
      key: "old-work",
      slot: "ready",
      summary: "old result",
    });
    db.close();
    const spawn = vi.fn<SpawnAgent>(() => {
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
    const app = await buildApp({
      databasePath,
      token: "fixture-token",
      staticDir: "/not-present",
      localAgents: {
        cli: { command: "fake", args: [] },
        serverUrl: "http://127.0.0.1",
        spawn,
        probe: async () => ({ installed: true, version: "test" }),
        findStrays: () => [],
      },
    });
    cleanup.push(() => app.close());
    const session = (await app.inject({ url: "/api/local/session" })).json();
    const headers = { "x-hive-owner": session.ownerToken as string };
    const create = (payload: Record<string, unknown> = {}) =>
      app.inject({
        method: "POST",
        url: "/api/local/agents",
        headers,
        payload: {
          provider: "claude",
          name: member.username,
          access: "read-only",
          rejoinParticipantId: member.id,
          ...payload,
        },
      });
    return { app, headers, member, spawn, create, databasePath, directory, message, entry };
  }

  it("keeps deleted configuration hints without retaining permissions or credentials", async () => {
    const { app, headers, member, directory, create } = await setup();
    expect((await app.inject({ url: "/api/local/agents", headers })).json().removedAgents).toEqual([
      { name: member.username, provider: "claude", cwd: directory },
    ]);
    expect((await create()).statusCode).toBe(201);
    expect((await app.inject({ url: "/api/local/agents", headers })).json().removedAgents).toEqual(
      [],
    );
  });

  it("recovers legacy local ownership from registered worktrees, not from an offline status", async () => {
    const { app, headers, member, directory } = await setup({ legacy: true });
    expect((await app.inject({ url: "/api/local/agents", headers })).json().removedAgents).toEqual([
      { name: member.username, provider: "claude", cwd: directory },
    ]);
  });

  it("does not offer recovery or hiding for unproven remote members", async () => {
    const { app, headers, member, create, spawn } = await setup({ remote: true });
    expect((await app.inject({ url: "/api/local/agents", headers })).json().removedAgents).toEqual(
      [],
    );
    expect((await create()).json().code).toBe("MEMBER_NOT_REMOVED");
    expect(
      (
        await app.inject({ method: "POST", url: `/api/local/members/${member.id}/hide`, headers })
      ).json().code,
    ).toBe("MEMBER_NOT_REMOVED");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects changed names, occupied names and unauthenticated mutations before spawning", async () => {
    const { app, headers, member, create, spawn } = await setup();
    expect((await create({ name: "different" })).json().code).toBe("MEMBER_NOT_REMOVED");
    expect(
      (await app.inject({ method: "POST", url: `/api/local/members/${member.id}/hide` }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/local/members/${member.id}/hide`,
          headers,
          remoteAddress: "10.0.0.2",
        })
      ).statusCode,
    ).toBe(403);
    expect((await create()).statusCode).toBe(201);
    expect((await create()).statusCode).not.toBe(201);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("hides only the list entry and reconnects with the same identity and message history", async () => {
    const { app, headers, member, databasePath, message, create, entry } = await setup();
    const hide = await app.inject({
      method: "POST",
      url: `/api/local/members/${member.id}/hide`,
      headers,
    });
    expect(hide.statusCode).toBe(200);
    const before = new HiveDatabase(databasePath);
    expect(before.getParticipant(member.id)?.hidden).toBe(true);
    expect(before.getMessage(message.id)?.senderId).toBe(member.id);
    expect(before.listWhiteboard("general").find((item) => item.id === entry.id)).toMatchObject({
      authorId: member.id,
      authorName: member.username,
    });
    before.close();
    expect((await create()).statusCode).toBe(201);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address() as { port: number };
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
    cleanup.push(() => {
      socket.terminate();
    });
    const snapshot = new Promise<Extract<ServerEvent, { type: "room.snapshot" }>>(
      (resolve, reject) => {
        socket.on("error", reject);
        socket.on("message", (raw) => {
          const event = JSON.parse(raw.toString()) as ServerEvent;
          if (event.type === "room.snapshot") resolve(event);
          if (event.type === "error") reject(new Error(event.message));
        });
      },
    );
    await new Promise<void>((resolve) => socket.once("open", resolve));
    socket.send(
      JSON.stringify({
        type: "participant.join",
        token: "fixture-token",
        roomId: "general",
        username: member.username,
        participantType: "agent",
        provider: "claude",
      }),
    );
    const joined = await snapshot;
    expect(joined.self).toMatchObject({
      id: member.id,
      username: member.username,
      provider: "claude",
    });
    expect(joined.self.hidden).not.toBe(true);
    expect(joined.messages.find((entry) => entry.id === message.id)?.senderId).toBe(member.id);
    const after = new HiveDatabase(databasePath);
    expect(after.getParticipant(member.id)?.hidden).not.toBe(true);
    const updated = after.upsertWhiteboardEntry(joined.self, {
      key: "old-work",
      slot: "ready",
      summary: "new result",
    });
    expect(updated.entry).toMatchObject({
      id: entry.id,
      authorId: member.id,
      authorName: member.username,
    });
    after.close();
  });

  it("rejects names held by offline humans in other rooms", async () => {
    const { databasePath, create, spawn, member } = await setup();
    const database = new HiveDatabase(databasePath);
    database.ensureRoom("other", "Alice");
    const human = database.upsertParticipant({
      roomId: "other",
      username: member.username,
      type: "human",
    });
    database.setParticipantStatus(human.id, "offline");
    database.close();
    expect((await create()).json().code).toBe("LOCAL_AGENT_NAME_TAKEN");
    expect(spawn).not.toHaveBeenCalled();
  });
});
