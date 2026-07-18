import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Participant } from "@ai-hive/protocol";
import { HiveDatabase, HiveError } from "./database.js";

describe("HiveDatabase", () => {
  let db: HiveDatabase;
  let human: Participant;
  let agentA: Participant;
  let agentB: Participant;

  beforeEach(() => {
    db = new HiveDatabase(":memory:");
    human = db.upsertParticipant({ roomId: "general", username: "Alice", type: "human" });
    agentA = db.upsertParticipant({ roomId: "general", username: "agent-a", type: "agent" });
    agentB = db.upsertParticipant({ roomId: "general", username: "agent-b", type: "agent" });
  });

  afterEach(() => db.close());

  it("keeps usernames unique case-insensitively", () => {
    const reconnect = db.upsertParticipant({
      roomId: "general",
      username: "alice",
      type: "human",
    });
    expect(reconnect.id).toBe(human.id);
    expect(
      db.listParticipants("general").filter((p) => p.username.toLowerCase() === "alice"),
    ).toHaveLength(1);
    expect(() =>
      db.upsertParticipant({ roomId: "general", username: "Alice", type: "agent" }),
    ).toThrowError(HiveError);
  });

  it("stores the runtime provider independently from the Agent persona", () => {
    const claude = db.upsertParticipant({
      roomId: "general",
      username: "claude-agent",
      type: "agent",
      provider: "claude",
      persona: "代码审查",
    });
    expect(claude).toMatchObject({ provider: "claude", persona: "代码审查" });
  });

  it("assigns strictly increasing seq values and supports afterSeq", () => {
    const first = db.createMessage(human, { content: "one", clientMessageId: "one" }).message;
    const second = db.createMessage(human, { content: "two", clientMessageId: "two" }).message;
    expect(second.seq).toBeGreaterThan(first.seq);
    expect(db.getMessages("general", first.seq).map((message) => message.id)).toEqual([second.id]);
  });

  it("makes clientMessageId idempotent", () => {
    const first = db.createMessage(human, { content: "hello", clientMessageId: "same" });
    const second = db.createMessage(human, { content: "changed", clientMessageId: "same" });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.message.id).toBe(first.message.id);
    expect(second.message.content).toBe("hello");
  });

  it("stops dispatch chains after hop four", () => {
    const root = db.createMessage(human, {
      content: "@agent-a start",
      clientMessageId: "root",
    }).message;
    const one = db.createMessage(agentA, {
      content: "@agent-b one",
      clientMessageId: "hop-1",
      parentMessageId: root.id,
    }).message;
    const two = db.createMessage(agentB, {
      content: "@agent-a two",
      clientMessageId: "hop-2",
      parentMessageId: one.id,
    }).message;
    const three = db.createMessage(agentA, {
      content: "@agent-b three",
      clientMessageId: "hop-3",
      parentMessageId: two.id,
    }).message;
    const four = db.createMessage(agentB, {
      content: "@agent-a four",
      clientMessageId: "hop-4",
      parentMessageId: three.id,
    }).message;
    expect(four.hopCount).toBe(4);
    expect(() =>
      db.createMessage(agentA, {
        content: "too far",
        clientMessageId: "hop-5",
        parentMessageId: four.id,
      }),
    ).toThrowError(/hop limit/i);
  });

  it("limits each agent to six replies per minute", () => {
    const root = db.createMessage(human, { content: "root", clientMessageId: "rate-root" }).message;
    for (let index = 0; index < 6; index += 1) {
      db.createMessage(agentA, {
        content: `reply ${index}`,
        clientMessageId: `rate-${index}`,
        parentMessageId: root.id,
      });
    }
    expect(() =>
      db.createMessage(agentA, {
        content: "reply 7",
        clientMessageId: "rate-7",
        parentMessageId: root.id,
      }),
    ).toThrowError(/rate limit/i);
  });

  it("limits a trace to twelve agent messages", () => {
    const root = db.createMessage(human, {
      content: "root",
      clientMessageId: "trace-root",
    }).message;
    for (let index = 0; index < 12; index += 1) {
      const agent = db.upsertParticipant({
        roomId: "general",
        username: `trace-agent-${index}`,
        type: "agent",
      });
      db.createMessage(agent, {
        content: `reply ${index}`,
        clientMessageId: `trace-${index}`,
        parentMessageId: root.id,
      });
    }
    const lastAgent = db.upsertParticipant({
      roomId: "general",
      username: "trace-agent-last",
      type: "agent",
    });
    expect(() =>
      db.createMessage(lastAgent, {
        content: "reply 13",
        clientMessageId: "trace-13",
        parentMessageId: root.id,
      }),
    ).toThrowError(/trace limit/i);
  });

  it("preserves the token and message history across a database restart", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "hive-db-test-"));
    const filename = path.join(directory, "hive.sqlite");
    const first = new HiveDatabase(filename);
    const member = first.upsertParticipant({
      roomId: "restart-room",
      username: "Restart User",
      type: "human",
    });
    const token = first.getOrCreateToken();
    first.createMessage(member, { content: "persistent", clientMessageId: "persistent-1" });
    first.close();

    const second = new HiveDatabase(filename);
    expect(second.getOrCreateToken()).toBe(token);
    expect(second.getMessages("restart-room").map((message) => message.content)).toEqual([
      "persistent",
    ]);
    expect(second.listParticipants("restart-room")[0]?.status).toBe("offline");
    second.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("seeds the general room and registers implicit rooms from existing data", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "hive-db-rooms-"));
    const filename = path.join(directory, "hive.sqlite");
    const first = new HiveDatabase(filename);
    const member = first.upsertParticipant({
      roomId: "implicit-room",
      username: "Old User",
      type: "human",
    });
    first.createMessage(member, { content: "legacy", clientMessageId: "legacy-1" });
    first.close();

    const second = new HiveDatabase(filename);
    const roomIds = second.listRooms().map((room) => room.id);
    expect(roomIds).toContain("general");
    expect(roomIds).toContain("implicit-room");
    const implicit = second.getRoom("implicit-room");
    expect(implicit).toMatchObject({ name: "implicit-room", latestSeq: 1, onlineCount: 0 });
    second.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("creates rooms explicitly and rejects duplicate ids", () => {
    const room = db.createRoom({ id: "frontend", name: "前端协作", createdBy: "Alice" });
    expect(room).toMatchObject({
      id: "frontend",
      name: "前端协作",
      createdBy: "Alice",
      onlineCount: 0,
      latestSeq: 0,
    });
    expect(() => db.createRoom({ id: "frontend" })).toThrowError(HiveError);
    expect(db.ensureRoom("frontend")).toMatchObject({ created: false });
    expect(db.ensureRoom("backend", "Bob").created).toBe(true);
  });

  it("renames, archives, and restores rooms while protecting the default room", () => {
    db.createRoom({ id: "frontend" });
    expect(db.updateRoom("frontend", { name: "前端" }).name).toBe("前端");

    const archived = db.updateRoom("frontend", { archived: true });
    expect(archived.archivedAt).toBeTruthy();
    expect(db.listRooms().map((room) => room.id)).not.toContain("frontend");
    expect(db.listRooms(true).map((room) => room.id)).toContain("frontend");

    const restored = db.updateRoom("frontend", { archived: false });
    expect(restored.archivedAt).toBeUndefined();
    expect(db.listRooms().map((room) => room.id)).toContain("frontend");

    expect(() => db.updateRoom("missing-room", { name: "x" })).toThrowError(/not found/i);
    expect(() => db.updateRoom("general", { archived: true })).toThrowError(/cannot be archived/i);
  });

  it("tracks online counts and latest seq per room", () => {
    expect(db.getRoom("general")).toMatchObject({ onlineCount: 3, latestSeq: 0 });
    db.createMessage(human, { content: "hi", clientMessageId: "room-stats-1" });
    expect(db.getRoom("general")?.latestSeq).toBeGreaterThan(0);
    db.setParticipantStatus(human.id, "offline");
    expect(db.onlineCount("general")).toBe(2);
    expect(db.getRoom("general")?.onlineCount).toBe(2);
  });
});
