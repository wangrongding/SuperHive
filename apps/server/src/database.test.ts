import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIMITS, type Participant } from "@ai-hive/protocol";
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

  it("lets only the sender recall a message and purges its content", () => {
    const { message } = db.createMessage(human, {
      content: "@agent-a 密钥是 sk-secret",
      clientMessageId: "recall-1",
    });
    db.createMessage(agentA, { content: "after", clientMessageId: "recall-2" });

    expect(() => db.deleteMessage(agentA, message.id)).toThrowError(
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
    expect(() => db.deleteMessage(human, "00000000-0000-4000-8000-000000000000")).toThrowError(
      expect.objectContaining({ code: "MESSAGE_NOT_FOUND" }),
    );
    const other = db.upsertParticipant({ roomId: "other", username: "Alice", type: "human" });
    expect(() => db.deleteMessage(other, message.id)).toThrowError(
      expect.objectContaining({ code: "MESSAGE_NOT_FOUND" }),
    );

    const recalled = db.deleteMessage(human, message.id);
    expect(recalled).toMatchObject({ id: message.id, seq: message.seq, content: "", mentions: [] });
    expect(recalled.deletedAt).toBeTruthy();
    expect(db.deleteMessage(human, message.id).deletedAt).toBe(recalled.deletedAt);

    // seq 占位保留，正文已从库中清除
    expect(db.getMessages("general").map((entry) => [entry.seq, entry.content])).toEqual([
      [message.seq, ""],
      [message.seq + 1, "after"],
    ]);
    expect(db.latestSeq("general")).toBe(message.seq + 1);
  });

  it("stops dispatch chains at the hop limit", () => {
    vi.useFakeTimers();
    // 分批推进时间，只测深度，不触发每分钟发言上限
    let tail = db.createMessage(human, { content: "start", clientMessageId: "hop-root" }).message;
    for (let hop = 1; hop <= LIMITS.maxHopCount; hop += 1) {
      vi.advanceTimersByTime(60_000);
      tail = db.createMessage(hop % 2 ? agentA : agentB, {
        content: `hop ${hop}`,
        clientMessageId: `hop-${hop}`,
        parentMessageId: tail.id,
      }).message;
    }
    expect(tail.hopCount).toBe(LIMITS.maxHopCount);
    expect(() =>
      db.createMessage(tail.senderId === agentA.id ? agentB : agentA, {
        content: "too far",
        clientMessageId: "hop-over",
        parentMessageId: tail.id,
      }),
    ).toThrowError(/hop limit/i);
    vi.useRealTimers();
  });

  it("extends the hop limit by the turns a human granted, until the next human message", () => {
    vi.useFakeTimers();
    let tail = db.createMessage(human, { content: "start", clientMessageId: "grant-root" }).message;
    const send = (sender: Participant, id: string) => {
      vi.advanceTimersByTime(60_000);
      return db.createMessage(sender, {
        content: id,
        clientMessageId: id,
        parentMessageId: tail.id,
      }).message;
    };
    for (let hop = 1; hop <= LIMITS.maxHopCount; hop += 1)
      tail = send(hop % 2 ? agentA : agentB, `grant-${hop}`);
    const next = () => (tail.senderId === agentA.id ? agentB : agentA);
    expect(() => send(next(), "grant-blocked")).toThrowError(/hop limit/i);

    db.extendAgentTurns("general", 1);
    tail = send(next(), "grant-extended");
    expect(tail.hopCount).toBe(LIMITS.maxHopCount + 1);

    // 人一发言，追加额度失效，旧链条恢复默认深度上限
    db.createMessage(human, { content: "ok", clientMessageId: "grant-human" });
    expect(() => send(next(), "grant-after-human")).toThrowError(/hop limit/i);
    vi.useRealTimers();
  });

  it("claims a subtask receipt exactly once and lists receipts still owed", () => {
    const root = db.createMessage(human, {
      content: "@agent-a go",
      clientMessageId: "c-root",
    }).message;
    const delegation = db.createMessage(agentA, {
      content: "@agent-b sub",
      clientMessageId: "c-delegate",
      parentMessageId: root.id,
      kind: "delegation",
    }).message;
    expect(delegation.kind).toBe("delegation");
    const parent = db.createInvocation({
      message: root,
      agent: agentA,
      status: "queued",
    }).invocation;
    const child = db.createInvocation({
      message: delegation,
      agent: agentB,
      status: "queued",
      parentInvocationId: parent.id,
      continuation: "pending",
    }).invocation;
    expect(child).toMatchObject({
      requesterId: agentA.id,
      parentInvocationId: parent.id,
      continuation: "pending",
    });
    expect(db.invocationAncestors(child.id).map((invocation) => invocation.id)).toEqual([
      parent.id,
    ]);
    // 还没结束的子任务不欠回执
    expect(db.listPendingContinuations()).toEqual([]);
    db.updateInvocation(child.id, { status: "completed" });
    expect(db.listPendingContinuations().map((invocation) => invocation.id)).toEqual([child.id]);

    expect(db.claimContinuation(child.id, "consumed")).toBe(true);
    expect(db.claimContinuation(child.id, "delivered")).toBe(false);
    expect(db.listPendingContinuations()).toEqual([]);
  });

  it("limits each agent's replies per minute", () => {
    const root = db.createMessage(human, { content: "root", clientMessageId: "rate-root" }).message;
    for (let index = 0; index < LIMITS.maxAgentRepliesPerMinute; index += 1) {
      db.createMessage(agentA, {
        content: `reply ${index}`,
        clientMessageId: `rate-${index}`,
        parentMessageId: root.id,
      });
    }
    expect(() =>
      db.createMessage(agentA, {
        content: "one too many",
        clientMessageId: "rate-over",
        parentMessageId: root.id,
      }),
    ).toThrowError(/rate limit/i);
  });

  it("limits the agent messages in one trace", () => {
    const root = db.createMessage(human, {
      content: "root",
      clientMessageId: "trace-root",
    }).message;
    for (let index = 0; index < LIMITS.maxAgentMessagesPerTrace; index += 1) {
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
        content: "one too many",
        clientMessageId: "trace-over",
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

  it("keeps an Agent's MCP inbox cursor across a database restart", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "hive-db-inbox-"));
    const filename = path.join(directory, "hive.sqlite");
    const first = new HiveDatabase(filename);
    const agent = first.upsertParticipant({ roomId: "general", username: "helper", type: "agent" });
    expect(first.getInboxCursor(agent.id)).toBeUndefined();
    first.setInboxCursor(agent.id, 42);
    first.close();

    // 重连时按房间 + 用户名复用同一个参与者 id，游标随之找回
    const second = new HiveDatabase(filename);
    const rejoined = second.upsertParticipant({
      roomId: "general",
      username: "helper",
      type: "agent",
    });
    expect(rejoined.id).toBe(agent.id);
    expect(second.getInboxCursor(rejoined.id)).toBe(42);
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

  it("strips control and bidi characters from message content", () => {
    const { message } = db.createMessage(human, {
      content: "hi\u202e @agent-a\u0007 go",
      clientMessageId: "unsafe-1",
    });
    expect(message.content).toBe("hi @agent-a go");
    expect(message.mentions).toEqual(["agent-a"]);
    expect(() =>
      db.createMessage(human, { content: "\u0000\u202e", clientMessageId: "unsafe-2" }),
    ).toThrowError(expect.objectContaining({ code: "EMPTY_MESSAGE" }));
  });

  it("counts consecutive agent turns since the last human message and honours extensions", () => {
    db.createMessage(human, { content: "start", clientMessageId: "h1" });
    db.createMessage(agentA, { content: "one", clientMessageId: "a1" });
    db.createMessage(agentB, { content: "two", clientMessageId: "b1" });
    expect(db.agentTurnBudget("general")).toEqual({
      used: 2,
      limit: LIMITS.maxConsecutiveAgentTurns,
    });
    expect(db.extendAgentTurns("general", 3)).toBe(3);
    expect(db.extendAgentTurns("general", 2)).toBe(5);
    expect(db.agentTurnBudget("general").limit).toBe(LIMITS.maxConsecutiveAgentTurns + 5);
    // 人一发言，计数和追加额度都重新开始
    db.createMessage(human, { content: "继续", clientMessageId: "h2" });
    expect(db.agentTurnBudget("general")).toEqual({
      used: 0,
      limit: LIMITS.maxConsecutiveAgentTurns,
    });
  });

  it("creates one invocation per message and agent and counts pair turns", () => {
    const { message } = db.createMessage(agentA, {
      content: "@agent-b help",
      clientMessageId: "pair-1",
    });
    const first = db.createInvocation({ message, agent: agentB, status: "queued" });
    const again = db.createInvocation({ message, agent: agentB, status: "queued" });
    expect(first.created).toBe(true);
    expect(again).toEqual({ invocation: first.invocation, created: false });
    expect(db.pairTurnsToday("general", agentA.id, agentB.id)).toBe(1);
    const updated = db.updateInvocation(first.invocation.id, {
      status: "running",
      progress: "执行命令",
    });
    expect(updated).toMatchObject({ status: "running", progress: "执行命令" });
    expect(db.updateInvocation(first.invocation.id, { progress: null }).progress).toBeUndefined();
  });

  it("keeps at most fifty whiteboard entries per slot", () => {
    for (let index = 0; index < 52; index += 1) {
      db.upsertWhiteboardEntry(agentA, {
        key: `task-${index}`,
        slot: "milestone",
        summary: `里程碑 ${index}`,
      });
    }
    const entries = db.listWhiteboard("general");
    expect(entries).toHaveLength(50);
    expect(entries.map((entry) => entry.key)).not.toContain("task-0");
    expect(db.removeWhiteboardEntry("general", entries[0]!.id)).toBe(true);
    expect(db.removeWhiteboardEntry("other", entries[1]!.id)).toBe(false);
  });

  it("searches messages across rooms with the trigram index and keeps recalled text out", () => {
    const other = db.upsertParticipant({ roomId: "design", username: "Bob", type: "human" });
    db.createMessage(human, { content: "先把登录接口的契约定下来", clientMessageId: "s1" });
    db.createMessage(other, { content: "登录页草图在 Figma 里", clientMessageId: "s2" });
    const secret = db.createMessage(human, {
      content: "登录密钥是 sk-123",
      clientMessageId: "s3",
    }).message;
    db.deleteMessage(human, secret.id);

    expect(db.searchMessages("登录接口").map((message) => message.content)).toEqual([
      "先把登录接口的契约定下来",
    ]);
    // 少于 3 个字符走 LIKE，跨房间、按时间倒序
    expect(db.searchMessages("登录").map((message) => message.roomId)).toEqual([
      "design",
      "general",
    ]);
    expect(db.searchMessages("sk-123")).toEqual([]);
    expect(db.searchMessages('"); DROP')).toEqual([]);
    expect(db.searchMessages("100%")).toEqual([]);
  });

  it("lists mentions of a user across rooms, excluding their own messages", () => {
    const bob = db.upsertParticipant({ roomId: "design", username: "Bob", type: "human" });
    db.createMessage(bob, { content: "@Alice 看下草图", clientMessageId: "m1" });
    db.createMessage(agentA, { content: "@alice 已完成", clientMessageId: "m2" });
    db.createMessage(human, { content: "@Alice 提醒自己", clientMessageId: "m3" });
    db.createMessage(agentA, { content: "@Alicia 不是你", clientMessageId: "m4" });
    expect(db.listMentions("alice").map((message) => message.content)).toEqual([
      "@alice 已完成",
      "@Alice 看下草图",
    ]);
  });

  it("lists invocations that still need attention across rooms", () => {
    const { message } = db.createMessage(human, { content: "@agent-a go", clientMessageId: "i1" });
    const running = db.createInvocation({ message, agent: agentA, status: "queued" }).invocation;
    const done = db.createInvocation({ message, agent: agentB, status: "queued" }).invocation;
    db.updateInvocation(done.id, { status: "completed" });
    expect(db.listActiveInvocations().map((invocation) => invocation.id)).toEqual([running.id]);
    db.updateInvocation(running.id, { status: "failed" });
    expect(db.listActiveInvocations()[0]).toMatchObject({ id: running.id, status: "failed" });
  });

  describe("异常调用的收起", () => {
    let clock = Date.parse("2026-10-30T10:00:00.000Z");
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
    });
    afterEach(() => vi.useRealTimers());
    const tick = () => {
      clock += 1_000;
      vi.setSystemTime(clock);
    };
    const invoke = (agent: Participant, text: string) => {
      tick();
      const { message } = db.createMessage(human, {
        content: `@${agent.username} ${text}`,
        clientMessageId: `m-${clock}`,
      });
      return db.createInvocation({ message, agent, status: "queued" }).invocation;
    };

    it("同一 Agent 之后正常完成任务，更早的失败与结果未知自动收起；访客待批准不收起", () => {
      const unknown = invoke(agentA, "a");
      db.updateInvocation(unknown.id, { status: "timed_out" });
      const failed = invoke(agentA, "b");
      db.updateInvocation(failed.id, { status: "failed" });
      const other = invoke(agentB, "c");
      db.updateInvocation(other.id, { status: "timed_out" });
      tick();
      const { message } = db.createMessage(human, { content: "@agent-a d", clientMessageId: "g" });
      const approval = db.createInvocation({
        message,
        agent: agentA,
        status: "blocked",
        blockReason: "guest_approval",
      }).invocation;
      expect(db.supersedeStaleInvocations()).toEqual([]);

      const done = invoke(agentA, "e");
      db.updateInvocation(done.id, { status: "completed" });
      const superseded = db.supersedeStaleInvocations("general");
      expect(superseded.map((item) => item.id).sort()).toEqual([unknown.id, failed.id].sort());
      expect(superseded[0]?.resolution).toMatchObject({
        kind: "superseded",
        note: "agent-a 之后的任务已正常完成",
      });
      expect(db.getInvocation(other.id)?.resolution).toBeUndefined();
      expect(db.getInvocation(approval.id)?.resolution).toBeUndefined();
      // 再跑一次不会重复收起
      expect(db.supersedeStaleInvocations()).toEqual([]);
    });

    it("开启新话题后收起之前的异常；人可以手动忽略，状态再变化时自动恢复", () => {
      const stale = invoke(agentB, "x");
      db.updateInvocation(stale.id, { status: "timed_out" });
      const kept = invoke(agentA, "y");
      db.updateInvocation(kept.id, { status: "failed" });
      const running = invoke(agentA, "z");
      expect(db.dismissInvocations("general", [kept.id, running.id], "Alice")).toHaveLength(1);
      expect(db.getInvocation(kept.id)?.resolution).toMatchObject({
        kind: "dismissed",
        by: "Alice",
      });
      expect(db.dismissInvocations("other-room", [stale.id], "Alice")).toEqual([]);

      // 重试会把状态改回 queued：之前的「已忽略」作废
      db.updateInvocation(kept.id, { status: "queued" });
      expect(db.getInvocation(kept.id)?.resolution).toBeUndefined();

      tick();
      db.createMessage(human, { content: "开启新话题", clientMessageId: "t", kind: "topic" });
      expect(db.supersedeStaleInvocations("general").map((item) => item.id)).toEqual([stale.id]);
      expect(db.getInvocation(stale.id)?.resolution?.note).toBe("之后开启了新话题");
    });
  });
});
