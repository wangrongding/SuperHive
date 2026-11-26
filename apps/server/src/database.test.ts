import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIMITS, serverText, type Participant } from "@superhive/protocol";
import Database from "better-sqlite3";
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

  it("lists participants by last activity regardless of status or type", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-11-17T10:00:00.000Z"));
      db.setParticipantStatus(agentA.id, "busy");
      vi.setSystemTime(new Date("2026-11-17T10:00:01.000Z"));
      db.setParticipantStatus(human.id, "online");
      vi.setSystemTime(new Date("2026-11-17T10:00:02.000Z"));
      db.setParticipantStatus(agentB.id, "offline");
      db.upsertParticipant({ roomId: "other", username: "newest", type: "agent" });

      expect(db.listParticipants("general").map((entry) => entry.id)).toEqual([
        agentB.id,
        human.id,
        agentA.id,
      ]);

      vi.setSystemTime(new Date("2026-11-17T10:00:03.000Z"));
      db.upsertParticipant({ roomId: "general", username: "agent-a", type: "agent" });
      expect(db.listParticipants("general").map((entry) => entry.id)).toEqual([
        agentA.id,
        agentB.id,
        human.id,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses case-insensitive names to break equal last activity timestamps", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-11-17T10:00:00.000Z"));
      db.setParticipantStatus(human.id, "busy");
      db.setParticipantStatus(agentB.id, "online");
      db.setParticipantStatus(agentA.id, "offline");

      expect(db.listParticipants("general").map((entry) => entry.username)).toEqual([
        "agent-a",
        "agent-b",
        "Alice",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("assigns strictly increasing seq values and supports afterSeq", () => {
    const first = db.createMessage(human, { content: "one", clientMessageId: "one" }).message;
    const second = db.createMessage(human, { content: "two", clientMessageId: "two" }).message;
    expect(second.seq).toBeGreaterThan(first.seq);
    expect(db.getMessages("general", first.seq).map((message) => message.id)).toEqual([second.id]);
  });

  it("updates last activity for new messages without changing participant status", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-11-17T10:00:00.000Z"));
      db.setParticipantStatus(human.id, "online");
      db.setParticipantStatus(agentA.id, "busy");
      vi.setSystemTime(new Date("2026-11-17T10:01:00.000Z"));
      db.setParticipantStatus(agentB.id, "online");

      vi.setSystemTime(new Date("2026-11-17T10:05:00.000Z"));
      const first = db.createMessage(human, {
        content: "hello",
        clientMessageId: "activity-human",
      });
      expect(db.getParticipant(human.id)?.lastSeenAt).toBe(first.message.createdAt);
      expect(db.listParticipants("general")[0]?.id).toBe(human.id);

      vi.setSystemTime(new Date("2026-11-17T10:06:00.000Z"));
      const reply = db.createMessage(agentA, {
        content: "working",
        parentMessageId: first.message.id,
        clientMessageId: "activity-agent",
        kind: "progress",
      });
      expect(db.getParticipant(agentA.id)).toMatchObject({
        status: "busy",
        lastSeenAt: reply.message.createdAt,
      });
      expect(db.listParticipants("general")[0]?.id).toBe(agentA.id);

      vi.setSystemTime(new Date("2026-11-17T10:07:00.000Z"));
      expect(
        db.createMessage(human, { content: "retry", clientMessageId: "activity-human" }).created,
      ).toBe(false);
      expect(() =>
        db.createMessage(human, { content: "", clientMessageId: "activity-empty" }),
      ).toThrowError(HiveError);
      expect(db.getParticipant(human.id)?.lastSeenAt).toBe(first.message.createdAt);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rolls back the message and last activity if attachment binding fails", () => {
    const before = db.getParticipant(human.id)?.lastSeenAt;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-11-17T10:05:00.000Z"));
      expect(() =>
        db.createMessage(human, {
          content: "attachment",
          clientMessageId: "activity-rollback",
          onInsert: () => {
            throw new Error("binding failed");
          },
        }),
      ).toThrowError("binding failed");
      expect(db.findMessageByClientId(human.id, "activity-rollback")).toBeUndefined();
      expect(db.getParticipant(human.id)?.lastSeenAt).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["receipt", "schedule", "topic"] as const)(
    "does not count server-generated %s messages as participant activity",
    (kind) => {
      const before = db.getParticipant(human.id)?.lastSeenAt;
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date("2026-11-17T10:05:00.000Z"));
        db.createMessage(human, {
          content: "generated",
          clientMessageId: `activity-${kind}`,
          kind,
        });
        expect(db.getParticipant(human.id)?.lastSeenAt).toBe(before);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("does not attribute system-forwarded text to the participant's activity", () => {
    const before = db.getParticipant(human.id)?.lastSeenAt;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-11-17T10:05:00.000Z"));
      db.createMessage(human, {
        content: "generated",
        text: serverText("topic.started", { name: human.username }),
        clientMessageId: "activity-forwarded",
      });
      expect(db.getParticipant(human.id)?.lastSeenAt).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("makes clientMessageId idempotent", () => {
    const first = db.createMessage(human, { content: "hello", clientMessageId: "same" });
    const second = db.createMessage(human, { content: "changed", clientMessageId: "same" });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.message.id).toBe(first.message.id);
    expect(second.message.content).toBe("hello");
  });

  it("records a quote only for a live message in the same room and drops it on recall", () => {
    const original = db.createMessage(agentA, {
      content: "原回复",
      clientMessageId: "q-1",
    }).message;
    const quoting = db.createMessage(human, {
      content: "> #1 · agent-a\n> 原回复\n\n接着说",
      clientMessageId: "q-2",
      quotedMessageId: original.id,
    }).message;
    expect(quoting.quote).toEqual({
      messageId: original.id,
      seq: original.seq,
      senderName: "agent-a",
    });
    expect(db.getMessage(quoting.id)?.quote).toEqual(quoting.quote);

    // 别的房间的、已撤回的、不存在的：当作没引用，消息照常发出
    const elsewhere = db.upsertParticipant({ roomId: "other", username: "Bob", type: "human" });
    const foreign = db.createMessage(elsewhere, { content: "x", clientMessageId: "q-3" }).message;
    const gone = db.createMessage(human, { content: "gone", clientMessageId: "q-4" }).message;
    db.deleteMessage(human, gone.id);
    for (const [index, quotedMessageId] of [
      foreign.id,
      gone.id,
      "00000000-0000-4000-8000-000000000009",
    ].entries()) {
      const sent = db.createMessage(human, {
        content: "hi",
        clientMessageId: `q-skip-${index}`,
        quotedMessageId,
      });
      expect(sent.created).toBe(true);
      expect(sent.message.quote).toBeUndefined();
    }

    // 引用它的消息撤回后，引用关系一起清掉
    expect(db.deleteMessage(human, quoting.id).quote).toBeUndefined();
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

  it("does not cap how deep a reply chain can go", () => {
    vi.useFakeTimers();
    // 转交深度上限已取消（rd #6608）：分批推进时间避开每分钟条数，链条可以一直往下接
    let tail = db.createMessage(human, { content: "start", clientMessageId: "hop-root" }).message;
    for (let hop = 1; hop <= 120; hop += 1) {
      vi.advanceTimersByTime(10_000);
      tail = db.createMessage(hop % 2 ? agentA : agentB, {
        content: `hop ${hop}`,
        clientMessageId: `hop-${hop}`,
        parentMessageId: tail.id,
      }).message;
    }
    expect(tail.hopCount).toBe(120);
    vi.useRealTimers();
  });

  describe("pingPongRun", () => {
    const send = (sender: Participant, id: string, parent?: string, extra = {}) => {
      vi.advanceTimersByTime(10_000);
      return db.createMessage(sender, {
        content: id,
        clientMessageId: id,
        ...(parent ? { parentMessageId: parent } : {}),
        ...extra,
      }).message;
    };
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("counts alternating messages between the same pair back to the human", () => {
      let tail = send(human, "pp-root");
      for (let index = 1; index <= 6; index += 1) {
        tail = send(index % 2 ? agentA : agentB, `pp-${index}`, tail.id);
      }
      expect(db.pingPongRun(tail, agentB.id, agentA.id, 100)).toBe(6);
      // cap 封顶，不会把整条链都走一遍
      expect(db.pingPongRun(tail, agentB.id, agentA.id, 4)).toBe(4);
    });

    it("breaks at a third agent, a delegation, a receipt or a message with attachments", () => {
      const agentC = db.upsertParticipant({
        roomId: "general",
        username: "agent-c",
        type: "agent",
      });
      const root = send(human, "br-root");
      const third = send(agentC, "br-c", root.id);
      let tail = send(agentA, "br-a1", third.id);
      tail = send(agentB, "br-b1", tail.id);
      expect(db.pingPongRun(tail, agentB.id, agentA.id, 100)).toBe(2);

      const delegation = send(agentA, "br-delegate", root.id, { kind: "delegation" });
      tail = send(agentB, "br-b2", delegation.id);
      expect(db.pingPongRun(tail, agentB.id, agentA.id, 100)).toBe(1);

      const withFile = send(agentA, "br-file", root.id, {
        attachments: [
          {
            id: "00000000-0000-4000-8000-000000000001",
            name: "report.md",
            mime: "text/markdown",
            size: 10,
            kind: "text",
            sha256: "a".repeat(64),
          },
        ],
      });
      tail = send(agentB, "br-b3", withFile.id);
      tail = send(agentA, "br-a3", tail.id);
      expect(db.pingPongRun(tail, agentA.id, agentB.id, 100)).toBe(2);
    });

    it("treats a whiteboard update by either agent as real output", () => {
      let tail = send(human, "wb-root");
      for (let index = 1; index <= 4; index += 1) {
        tail = send(index % 2 ? agentA : agentB, `wb-${index}`, tail.id);
      }
      vi.advanceTimersByTime(10_000);
      db.upsertWhiteboardEntry(agentA, { key: "wb", slot: "in_progress", summary: "做到一半" });
      tail = send(agentA, "wb-5", tail.id);
      expect(db.pingPongRun(tail, agentA.id, agentB.id, 100)).toBe(1);
    });
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

  it("assigns session lanes: delegations open a lane, rework and receipts reuse it", () => {
    const ask = (sender: Participant, content: string, extra: Record<string, unknown> = {}) =>
      db.createMessage(sender, { content, clientMessageId: `c-${content}`, ...extra }).message;
    const root = ask(human, "@agent-a build it");
    const lead = db.createInvocation({ message: root, agent: agentA, status: "queued" }).invocation;
    expect(lead.laneKey).toBe("main");

    const delegation = ask(agentA, "@agent-b part 1", {
      parentMessageId: root.id,
      kind: "delegation",
    });
    const sub = db.createInvocation({
      message: delegation,
      agent: agentB,
      status: "queued",
      parentInvocationId: lead.id,
    }).invocation;
    expect(sub.laneKey).toBe(sub.id);

    // 子任务回执回到委派方自己那一道（主道）
    const receipt = ask(agentB, "@agent-a receipt", {
      parentMessageId: delegation.id,
      kind: "receipt",
    });
    const back = db.createInvocation({
      message: receipt,
      agent: agentA,
      status: "queued",
      parentInvocationId: sub.id,
    }).invocation;
    expect(back.laneKey).toBe("main");

    // 委派方接着同一件活再派「返修」：沿用子任务原来那一道
    const rework = ask(agentA, "@agent-b fix it", {
      parentMessageId: receipt.id,
      kind: "delegation",
    });
    const again = db.createInvocation({
      message: rework,
      agent: agentB,
      status: "queued",
      parentInvocationId: back.id,
    }).invocation;
    expect(again.laneKey).toBe(sub.id);

    // 人另起一件活，再派出去的是新的一道
    const other = ask(human, "@agent-a another thing");
    const lead2 = db.createInvocation({
      message: other,
      agent: agentA,
      status: "queued",
    }).invocation;
    const fresh = db.createInvocation({
      message: ask(agentA, "@agent-b part 2", { parentMessageId: other.id, kind: "delegation" }),
      agent: agentB,
      status: "queued",
      parentInvocationId: lead2.id,
    }).invocation;
    expect(fresh.laneKey).toBe(fresh.id);

    // 人直接回复子任务里 Agent 发的消息：进那一道
    const delivered = ask(agentB, "done part 1", { parentMessageId: delegation.id });
    const followUp = db.createInvocation({
      message: ask(human, "@agent-b tweak", { replyToMessageId: delivered.id }),
      agent: agentB,
      status: "queued",
    }).invocation;
    expect(followUp.laneKey).toBe(sub.id);
    // 普通 @ 是主道
    const plain = db.createInvocation({
      message: ask(human, "@agent-b hi"),
      agent: agentB,
      status: "queued",
    }).invocation;
    expect(plain.laneKey).toBe("main");
  });

  it("keeps the usage ledger across retries and room clears, and splits it by agent, day and model", () => {
    const usage = (model: string, write: number, read: number) => ({
      model,
      inputTokens: 10,
      cacheWriteTokens: write,
      cacheReadTokens: read,
      outputTokens: 5,
      requests: 2,
      peakContextTokens: write + read + 10,
      peakCacheWriteTokens: write,
    });
    const first = db.createMessage(human, {
      content: "@agent-a a",
      clientMessageId: "u-1",
    }).message;
    const second = db.createMessage(human, {
      content: "@agent-b b",
      clientMessageId: "u-2",
    }).message;
    const a = db.createInvocation({ message: first, agent: agentA, status: "queued" }).invocation;
    const b = db.createInvocation({ message: second, agent: agentB, status: "queued" }).invocation;
    db.recordUsage(a, usage("claude-opus-5-5", 1_000, 0), "2026-10-30T10:00:00.000Z");
    // 同一调用再次上报（重试）覆盖而不是重复计数
    db.recordUsage(a, usage("claude-opus-5-5", 300_000, 0), "2026-10-31T10:00:00.000Z");
    db.recordUsage(b, usage("gpt-6-astra", 0, 50_000), "2026-10-31T11:00:00.000Z");
    expect(db.getInvocation(a.id)?.usage?.cacheWriteTokens).toBe(300_000);

    db.clearRoom("general");
    const summary = db.usageSummary("general", "2026-10-01T00:00:00.000Z", 200_000);
    expect(summary.totals).toMatchObject({
      turns: 2,
      cacheWriteTokens: 300_000,
      cacheReadTokens: 50_000,
      largeCacheWrites: 1,
    });
    expect(summary.agents.map((agent) => agent.agentName)).toEqual(["agent-b", "agent-a"]);
    expect(summary.cells.map((cell) => [cell.model, cell.turns])).toEqual([
      ["gpt-6-astra", 1],
      ["claude-opus-5-5", 1],
    ]);
    expect(summary.recent[0]?.invocationId).toBe(b.id);
    expect(db.usageSummary("general", "2026-11-01T00:00:00.000Z", 200_000).totals.turns).toBe(0);
    // 成员列表要的「最近一轮用的模型」：清空房间后照样查得到，没记过的是 undefined
    expect(db.latestUsageModel(agentA.id)).toEqual({
      id: "claude-opus-5-5",
      at: "2026-10-30T10:00:00.000Z",
    });
    expect(db.latestUsageModel(agentB.id)?.id).toBe("gpt-6-astra");
    expect(db.latestUsageModel("00000000-0000-4000-8000-00000000dead")).toBeUndefined();
  });

  it("keeps each retry of an invocation as its own ledger row and migrates the old ledger", () => {
    const message = db.createMessage(human, {
      content: "@agent-a r",
      clientMessageId: "r-1",
    }).message;
    const invocation = db.createInvocation({ message, agent: agentA, status: "queued" }).invocation;
    const turn = (firstRequestAt: string) => ({
      inputTokens: 1,
      cacheWriteTokens: 100,
      cacheReadTokens: 0,
      outputTokens: 1,
      requests: 1,
      peakContextTokens: 101,
      peakCacheWriteTokens: 100,
      firstRequestAt,
      outcome: "failed" as const,
    });
    db.recordUsage(invocation, turn("2026-10-31T10:00:00.000Z"), "2026-10-31T10:00:01.000Z");
    // 同一回合断线重发：只记一次
    db.recordUsage(invocation, turn("2026-10-31T10:00:00.000Z"), "2026-10-31T10:00:02.000Z");
    db.recordUsage(invocation, turn("2026-10-31T10:01:00.000Z"), "2026-10-31T10:01:01.000Z");
    expect(db.usageSummary("general", "2026-10-01T00:00:00.000Z", 200_000).totals.turns).toBe(2);
  });

  it("migrates a ledger keyed by invocation to per-turn rows", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "hive-usage-migrate-"));
    const file = path.join(directory, "hive.sqlite");
    const first = new HiveDatabase(file);
    const alice = first.upsertParticipant({ roomId: "general", username: "Alice", type: "human" });
    const agent = first.upsertParticipant({ roomId: "general", username: "a", type: "agent" });
    const message = first.createMessage(alice, { content: "@a x", clientMessageId: "m" }).message;
    const invocation = first.createInvocation({ message, agent, status: "queued" }).invocation;
    first.close();
    // 模拟旧版账本：以调用 ID 为主键
    const raw = new Database(file);
    raw.exec(`DROP TABLE agent_usage;
      CREATE TABLE agent_usage (invocation_id TEXT PRIMARY KEY, room_id TEXT NOT NULL,
        message_id TEXT NOT NULL, agent_id TEXT NOT NULL, agent_name TEXT NOT NULL, model TEXT,
        usage TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX agent_usage_room ON agent_usage(room_id, created_at);`);
    raw.prepare("INSERT INTO agent_usage VALUES (?, 'general', ?, ?, 'a', NULL, ?, ?)").run(
      invocation.id,
      message.id,
      agent.id,
      JSON.stringify({
        inputTokens: 1,
        cacheWriteTokens: 0,
        cacheReadTokens: 2,
        outputTokens: 3,
        requests: 1,
        peakContextTokens: 3,
        peakCacheWriteTokens: 0,
      }),
      "2026-10-31T09:00:00.000Z",
    );
    raw.close();
    const reopened = new HiveDatabase(file);
    try {
      expect(
        reopened.usageSummary("general", "2026-10-01T00:00:00.000Z", 200_000).totals,
      ).toMatchObject({ turns: 1, cacheReadTokens: 2 });
    } finally {
      reopened.close();
      rmSync(directory, { recursive: true, force: true });
    }
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
    ).toThrowError(/每分钟上限/);
  });

  it("does not cap the agent messages in one trace", () => {
    vi.useFakeTimers();
    const root = db.createMessage(human, {
      content: "root",
      clientMessageId: "trace-root",
    }).message;
    // 旧版一条链最多 40 条 Agent 消息，长委派链会被拦下（rd #6608）
    for (let index = 0; index < 120; index += 1) {
      vi.advanceTimersByTime(10_000);
      db.createMessage(index % 2 ? agentA : agentB, {
        content: `reply ${index}`,
        clientMessageId: `trace-${index}`,
        parentMessageId: root.id,
      });
    }
    expect(db.getMessages("general").filter((m) => m.traceId === root.traceId)).toHaveLength(121);
    vi.useRealTimers();
  });

  it("does not count server-sent receipts toward the delegate's per-minute limit", () => {
    const root = db.createMessage(human, { content: "root", clientMessageId: "rr-root" }).message;
    for (let index = 0; index < LIMITS.maxAgentRepliesPerMinute; index += 1) {
      db.createMessage(agentB, {
        content: `receipt ${index}`,
        clientMessageId: `rr-receipt-${index}`,
        parentMessageId: root.id,
        kind: "receipt",
      });
    }
    // 回执不算 agent-b 自己发言：它仍能照常回复，回执本身也不受每分钟条数限制
    expect(() =>
      db.createMessage(agentB, {
        content: "own reply",
        clientMessageId: "rr-own",
        parentMessageId: root.id,
      }),
    ).not.toThrow();
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

    expect(() => db.updateRoom("missing-room", { name: "x" })).toThrowError(/房间不存在/);
    expect(() => db.updateRoom("general", { archived: true })).toThrowError(/默认房间不能归档/);
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
    // 进度和子任务回执不占轮数
    db.createMessage(agentA, { content: "进度", clientMessageId: "a-progress", kind: "progress" });
    db.createMessage(agentB, { content: "回执", clientMessageId: "b-receipt", kind: "receipt" });
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

  it("clears rooms by archiving the entire current board and preserves old history and other rooms", () => {
    const old = db.upsertWhiteboardEntry(agentA, {
      key: "old",
      slot: "ready",
      summary: "old history",
    }).entry;
    const oldHistory = db.changeWhiteboardArchive("general", [old], true);
    const other = db.upsertParticipant({ roomId: "other", username: "Alice", type: "human" });
    const foreign = db.upsertWhiteboardEntry(other, {
      key: "foreign",
      slot: "ready",
      summary: "other room",
    }).entry;
    for (let index = 0; index < 201; index += 1)
      db.upsertWhiteboardEntry(agentA, { key: `clear-${index}`, slot: "ready", summary: "done" });
    const message = db.createMessage(human, { content: "chat", clientMessageId: "clear" }).message;
    const queued = db.createInvocation({ message, agent: agentA, status: "queued" }).invocation;
    db.updateInvocation(queued.id, { status: "completed" });
    const current = db.listWhiteboard("general");
    const removed = db.clearRoom("general", human.username, {
      whiteboard: "archive",
      entries: current,
    });
    expect(removed).toMatchObject({ messages: 1, invocations: 1 });
    expect(removed.archivedEntries).toHaveLength(201);
    expect(db.listWhiteboard("general")).toEqual([]);
    expect(db.listWhiteboard("general", "archived")).toHaveLength(202);
    expect(db.listWhiteboard("general", "archived")).toContainEqual(oldHistory[0]);
    expect(db.listWhiteboard("other")).toEqual([foreign]);
    expect(db.changeWhiteboardArchive("general", removed.archivedEntries, false)).toHaveLength(201);
  });

  it("keeps every record on protected or stale room clears, and allows explicit chat-only clears", () => {
    const ready = db.upsertWhiteboardEntry(agentA, {
      key: "ready",
      slot: "ready",
      summary: "done",
    }).entry;
    const message = db.createMessage(human, {
      content: "chat",
      clientMessageId: "protected-clear",
    }).message;
    const queued = db.createInvocation({
      message,
      agent: agentA,
      status: "queued",
    }).invocation;
    const invocation = db.updateInvocation(queued.id, { status: "running" });
    // 还挂着已登记 worktree 的条目：整次清空拒绝，什么都不删
    db.connection().exec("CREATE TABLE managed_worktrees (id TEXT, repo TEXT, branch TEXT)");
    db.connection()
      .prepare("INSERT INTO managed_worktrees VALUES (?, ?, ?)")
      .run("managed", "/repo", "feat/task");
    const occupied = db.upsertWhiteboardEntry(agentA, {
      key: "worktree:managed",
      slot: "milestone",
      summary: "still registered",
    }).entry;
    const kept = db.listWhiteboard("general", "all");
    expect(() => db.clearRoom("general")).toThrowError(
      expect.objectContaining({ code: "WHITEBOARD_PROTECTED" }),
    );
    expect(db.listWhiteboard("general", "all")).toEqual(kept);
    expect(db.getMessage(message.id)).toEqual(message);
    expect(db.getInvocation(invocation.id)).toEqual(invocation);
    db.connection().exec("DELETE FROM managed_worktrees");
    expect(
      db.listWhiteboard("general").find((entry) => entry.id === occupied.id),
    ).not.toHaveProperty("archiveProtected");
    const finished = db.upsertWhiteboardEntry(agentA, {
      key: "protected",
      slot: "ready",
      summary: "finished",
    }).entry;
    for (const entries of [
      [],
      [ready],
      [ready, ready],
      [ready, { ...finished, updatedAt: "2000-01-01T00:00:00.000Z" }],
    ]) {
      expect(() =>
        db.clearRoom("general", "Alice", { whiteboard: "archive", entries }),
      ).toThrowError(expect.objectContaining({ code: "WHITEBOARD_CONFLICT" }));
      expect(db.getMessage(message.id)).toEqual(message);
      expect(db.getInvocation(invocation.id)).toEqual(invocation);
      expect(db.listWhiteboard("general", "archived")).toEqual([]);
    }
    const active = db.upsertWhiteboardEntry(agentA, {
      key: "protected",
      slot: "in_progress",
      summary: "still active",
      claim: { repo: "/repo", branch: "feat/active" },
    }).entry;
    const before = db.listWhiteboard("general", "all");
    expect(db.clearRoom("general", "Alice", { whiteboard: "keep" })).toEqual({
      messages: 1,
      invocations: 1,
      archivedEntries: [],
    });
    expect(db.listWhiteboard("general", "all")).toEqual(before);
    expect(db.listWhiteboard("general")).toContainEqual(active);
    expect(db.getMessage(message.id)).toBeUndefined();
  });

  it("rolls back archives and invocation deletion if chat deletion fails", () => {
    const entry = db.upsertWhiteboardEntry(agentA, {
      key: "done",
      slot: "ready",
      summary: "done",
    }).entry;
    const message = db.createMessage(human, {
      content: "chat",
      clientMessageId: "rollback-clear",
    }).message;
    const queued = db.createInvocation({
      message,
      agent: agentA,
      status: "queued",
    }).invocation;
    const invocation = db.updateInvocation(queued.id, { status: "completed" });
    db.connection().exec(
      "CREATE TRIGGER prevent_clear BEFORE DELETE ON messages BEGIN SELECT RAISE(ABORT, 'test failure'); END",
    );
    expect(() => db.clearRoom("general")).toThrowError("test failure");
    expect(db.listWhiteboard("general")).toEqual([entry]);
    expect(db.getMessage(message.id)).toEqual(message);
    expect(db.getInvocation(invocation.id)).toEqual(invocation);
  });

  it("does not clear chat or release registered workspace claims", () => {
    db.connection().exec("CREATE TABLE managed_worktrees (id TEXT, repo TEXT, branch TEXT)");
    db.connection()
      .prepare("INSERT INTO managed_worktrees VALUES (?, ?, ?)")
      .run("managed", "/repo", "feat/task");
    const message = db.createMessage(human, {
      content: "chat",
      clientMessageId: "worktree-clear",
    }).message;
    db.upsertWhiteboardEntry(agentA, {
      key: "worktree:managed",
      slot: "milestone",
      summary: "registered",
    });
    expect(() => db.clearRoom("general")).toThrowError(
      expect.objectContaining({ code: "WHITEBOARD_PROTECTED" }),
    );
    expect(db.getMessage(message.id)).toEqual(message);
    expect(db.listWhiteboard("general", "archived")).toEqual([]);
    expect(
      db.connection().prepare("SELECT COUNT(*) AS count FROM managed_worktrees").get(),
    ).toEqual({ count: 1 });
  });

  it("retains whiteboard entries instead of silently deleting overflow", () => {
    for (let index = 0; index < 52; index += 1) {
      db.upsertWhiteboardEntry(agentA, {
        key: `task-${index}`,
        slot: "milestone",
        summary: `里程碑 ${index}`,
      });
    }
    const entries = db.listWhiteboard("general");
    expect(entries).toHaveLength(52);
    expect(entries.map((entry) => entry.key)).toContain("task-0");
    expect(db.removeWhiteboardEntry("general", entries[0]!.id)).toBe(true);
    expect(db.removeWhiteboardEntry("other", entries[1]!.id)).toBe(false);
  });

  it("classifies old directory records on read without rewriting or dropping any stored metadata", () => {
    const active = db.upsertWhiteboardEntry(agentA, {
      key: "worktree:active",
      slot: "in_progress",
      summary: "Original reservation",
      repo: "repo",
      branch: "feat/task",
      claim: { repo: "/repo", branch: "feat/task" },
      unblocks: ["review"],
    }).entry;
    const cleaned = db.upsertWhiteboardEntry(agentB, {
      key: "worktree:cleaned",
      slot: "milestone",
      summary: "Original cleanup record",
      commit: "abcdef0123456",
    }).entry;
    const task = db.upsertWhiteboardEntry(agentA, {
      key: "worktree-deps",
      slot: "in_progress",
      summary: "Real dependency task",
    }).entry;
    const stored = db.connection().prepare("SELECT * FROM whiteboard_entries ORDER BY key").all();
    expect(active.kind).toBe("task_directory");
    expect(cleaned.kind).toBe("task_directory");
    expect(task.kind).toBeUndefined();
    expect(db.listWhiteboard("general")).toEqual(expect.arrayContaining([active, cleaned, task]));
    expect(db.connection().prepare("SELECT * FROM whiteboard_entries ORDER BY key").all()).toEqual(
      stored,
    );
    const archived = db.changeWhiteboardArchive("general", [cleaned], true);
    expect(db.listWhiteboard("general", "archived")).toEqual(archived);
    expect(archived[0]).toMatchObject({
      id: cleaned.id,
      summary: cleaned.summary,
      commit: cleaned.commit,
      authorName: cleaned.authorName,
      kind: "task_directory",
    });
    expect(db.changeWhiteboardArchive("general", archived, false)[0]).toMatchObject({
      id: cleaned.id,
      summary: cleaned.summary,
      slot: cleaned.slot,
      authorName: cleaned.authorName,
      kind: "task_directory",
    });
  });

  it("archives and restores batches without losing their identities or authors", () => {
    const first = db.upsertWhiteboardEntry(agentA, {
      key: "first",
      slot: "ready",
      summary: "done",
      unblocks: ["ui"],
    }).entry;
    const second = db.upsertWhiteboardEntry(agentB, {
      key: "second",
      slot: "milestone",
      summary: "released",
    }).entry;
    const archived = db.changeWhiteboardArchive("general", [first, second], true);
    expect(archived.every((entry) => entry.archivedAt === entry.updatedAt)).toBe(true);
    expect(db.listWhiteboard("general")).toEqual([]);
    expect(db.listWhiteboard("general", "archived")).toHaveLength(2);
    expect(db.listWhiteboard("general", "all")).toHaveLength(2);
    const restored = db.changeWhiteboardArchive("general", archived, false);
    expect(restored.map((entry) => entry.id)).toEqual([first.id, second.id]);
    expect(restored[0]).toMatchObject({
      authorId: agentA.id,
      unblocks: ["ui"],
      createdAt: first.createdAt,
    });
    expect(restored.every((entry) => !entry.archivedAt)).toBe(true);
    expect(db.listWhiteboard("general", "archived")).toEqual([]);
    expect(() =>
      db.removeWhiteboardEntry("general", first.id, archived[0]!.updatedAt),
    ).toThrowError("白板事项已变化");
  });

  it("rejects stale, duplicate and foreign-room batches atomically", () => {
    const first = db.upsertWhiteboardEntry(agentA, {
      key: "first",
      slot: "ready",
      summary: "old",
    }).entry;
    const second = db.upsertWhiteboardEntry(agentA, {
      key: "second",
      slot: "ready",
      summary: "old",
    }).entry;
    db.upsertWhiteboardEntry(agentA, { key: "second", slot: "ready", summary: "changed" });
    expect(() => db.changeWhiteboardArchive("general", [first, second], true)).toThrowError(
      "白板事项已变化",
    );
    expect(() => db.changeWhiteboardArchive("general", [first, first], true)).toThrowError(
      "白板事项已变化",
    );
    expect(() => db.changeWhiteboardArchive("other", [first], true)).toThrowError(
      "没有所选白板事项",
    );
    expect(db.listWhiteboard("general", "archived")).toEqual([]);
    const archived = db.changeWhiteboardArchive("general", [first], true);
    expect(() => db.changeWhiteboardArchive("general", [first], true)).toThrowError(
      "白板事项已变化",
    );
    expect(() => db.changeWhiteboardArchive("general", [first], false)).toThrowError(
      "白板事项已变化",
    );
    expect(db.listWhiteboard("general", "archived")).toEqual(archived);
  });

  it("lets stale active or blocked tasks be archived but protects registered worktree claims", () => {
    // Agent 崩了或忘了收尾留下的进行中/阻塞条目，房主得能清掉
    for (const slot of ["in_progress", "blocked"] as const) {
      const stale = db.upsertWhiteboardEntry(agentA, { key: slot, slot, summary: "stale" }).entry;
      expect(stale.archiveProtected).toBeUndefined();
      const [archived] = db.changeWhiteboardArchive("general", [stale], true);
      expect(archived!.archivedAt).toBeTruthy();
      db.removeWhiteboardEntry("general", stale.id);
    }
    db.connection().exec("CREATE TABLE managed_worktrees (id TEXT, repo TEXT, branch TEXT)");
    db.connection()
      .prepare("INSERT INTO managed_worktrees VALUES (?, ?, ?)")
      .run("managed", "/repo", "feat/task");
    const registered = db.upsertWhiteboardEntry(agentA, {
      key: "worktree:managed",
      slot: "milestone",
      summary: "still registered",
    }).entry;
    const claimed = db.upsertWhiteboardEntry(agentA, {
      key: "task",
      slot: "ready",
      summary: "review",
      claim: { repo: "/repo", branch: "feat/task" },
    }).entry;
    for (const entry of [registered, claimed]) {
      expect(entry.archiveProtected).toBe(true);
      expect(() => db.changeWhiteboardArchive("general", [entry], true)).toThrowError(
        "不能归档或删除",
      );
      expect(() => db.removeWhiteboardEntry("general", entry.id)).toThrowError("不能归档或删除");
    }
    expect(db.listWhiteboard("general", "archived")).toEqual([]);
    db.connection().exec("DELETE FROM managed_worktrees");
    expect(db.changeWhiteboardArchive("general", [registered, claimed], true)).toHaveLength(2);
  });

  it("records the source message and keeps it when a later update has none", () => {
    const source = { id: "00000000-0000-4000-8000-0000000000c1", seq: 42 };
    const first = db.upsertWhiteboardEntry(agentA, {
      key: "task",
      slot: "in_progress",
      summary: "做登录页",
      source,
    }).entry;
    expect(first).toMatchObject({ messageId: source.id, messageSeq: 42 });
    const later = db.upsertWhiteboardEntry(agentA, {
      key: "task",
      slot: "ready",
      summary: "登录页做完了",
    }).entry;
    expect(later).toMatchObject({ messageId: source.id, messageSeq: 42 });
  });

  it("turns open entries on a merged branch into milestones once per merged commit", () => {
    const ready = db.upsertWhiteboardEntry(agentA, {
      key: "review",
      slot: "ready",
      summary: "做完待 review",
      branch: "feat/a",
    }).entry;
    const working = db.upsertWhiteboardEntry(agentB, {
      key: "work",
      slot: "in_progress",
      summary: "还在做",
      claim: { repo: "/repo", branch: "feat/a" },
    }).entry;
    const blocked = db.upsertWhiteboardEntry(agentA, {
      key: "stuck",
      slot: "blocked",
      summary: "卡住了",
      branch: "feat/a",
    }).entry;
    const other = db.upsertWhiteboardEntry(agentA, {
      key: "other",
      slot: "ready",
      summary: "别的分支",
      branch: "feat/b",
    }).entry;
    // 目录不干净：进行中的不动
    const dirty = db.completeMergedWhiteboard("general", "feat/a", "c1", {
      includeInProgress: false,
    });
    expect(dirty.map((entry) => entry.id)).toEqual([ready.id]);
    expect(dirty[0]).toMatchObject({ slot: "milestone", mergedAt: expect.any(String) });
    const clean = db.completeMergedWhiteboard("general", "feat/a", "c1", {
      includeInProgress: true,
    });
    expect(clean.map((entry) => entry.id)).toEqual([working.id]);
    expect(clean[0]!.claim).toBeUndefined();
    // 同一个合入提交不再重复转；Agent 重新登记回进行中后，也不会被改回去
    db.upsertWhiteboardEntry(agentA, {
      key: "review",
      slot: "in_progress",
      summary: "接着做",
      branch: "feat/a",
    });
    expect(
      db.completeMergedWhiteboard("general", "feat/a", "c1", { includeInProgress: true }),
    ).toEqual([]);
    const reopened = db.listWhiteboard("general").find((entry) => entry.id === ready.id)!;
    expect(reopened).toMatchObject({ slot: "in_progress" });
    expect(reopened.mergedAt).toBeUndefined();
    // 新的提交合入后再转
    expect(
      db
        .completeMergedWhiteboard("general", "feat/a", "c2", { includeInProgress: true })
        .map((entry) => entry.id),
    ).toEqual([ready.id]);
    const current = new Map(db.listWhiteboard("general").map((entry) => [entry.id, entry]));
    expect(current.get(blocked.id)!.slot).toBe("blocked");
    expect(current.get(other.id)!.slot).toBe("ready");
  });

  it("archives milestones that have not changed for a while, except protected ones", () => {
    const old = db.upsertWhiteboardEntry(agentA, {
      key: "old",
      slot: "milestone",
      summary: "早就合入",
    }).entry;
    const fresh = db.upsertWhiteboardEntry(agentA, {
      key: "fresh",
      slot: "milestone",
      summary: "刚合入",
    }).entry;
    const working = db.upsertWhiteboardEntry(agentA, {
      key: "working",
      slot: "in_progress",
      summary: "还在做",
    }).entry;
    const protectedEntry = db.upsertWhiteboardEntry(agentA, {
      key: "worktree:managed",
      slot: "milestone",
      summary: "目录还在",
    }).entry;
    const past = "2026-01-01T00:00:00.000Z";
    db.connection()
      .prepare("UPDATE whiteboard_entries SET updated_at = ? WHERE id IN (?, ?, ?)")
      .run(past, old.id, working.id, protectedEntry.id);
    const archived = db.archiveStaleMilestones("2026-02-01T00:00:00.000Z");
    expect(archived.map((entry) => entry.id)).toEqual([old.id]);
    expect(archived[0]!.archivedAt).toBeTruthy();
    expect(
      db
        .listWhiteboard("general")
        .map((entry) => entry.id)
        .sort(),
    ).toEqual([fresh.id, working.id, protectedEntry.id].sort());
  });

  it("reactivates the same archived key even for an identical update within the throttle window", () => {
    const input = { key: "task", slot: "ready" as const, summary: "done" };
    const entry = db.upsertWhiteboardEntry(agentA, input).entry;
    const archived = db.changeWhiteboardArchive("general", [entry], true)[0]!;
    const updated = db.upsertWhiteboardEntry(agentA, input);
    expect(updated.changed).toBe(true);
    expect(updated.entry.id).toBe(entry.id);
    expect(updated.entry.archivedAt).toBeUndefined();
    expect(updated.entry.updatedAt > archived.updatedAt).toBe(true);
    expect(db.listWhiteboard("general")).toEqual([updated.entry]);
    expect(() => db.changeWhiteboardArchive("general", [archived], false)).toThrowError(
      "白板事项已变化",
    );
  });

  it("migrates legacy board rows and persists history across a restart", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "hive-whiteboard-"));
    const filename = path.join(directory, "board.sqlite");
    let disk: HiveDatabase | undefined;
    try {
      disk = new HiveDatabase(filename);
      const entry = disk.upsertWhiteboardEntry(agentA, {
        key: "legacy",
        slot: "ready",
        summary: "preserved",
      }).entry;
      disk.close();
      disk = undefined;
      const legacy = new Database(filename);
      legacy.exec(
        "DROP INDEX whiteboard_archive; ALTER TABLE whiteboard_entries DROP COLUMN archived_at",
      );
      legacy.close();
      disk = new HiveDatabase(filename);
      expect(disk.listWhiteboard("general")).toEqual([entry]);
      const archived = disk.changeWhiteboardArchive("general", [entry], true);
      disk.close();
      disk = new HiveDatabase(filename);
      expect(disk.listWhiteboard("general")).toEqual([]);
      expect(disk.listWhiteboard("general", "archived")).toEqual(archived);
      expect(disk.changeWhiteboardArchive("general", archived, false)).toHaveLength(1);
    } finally {
      disk?.close();
      rmSync(directory, { recursive: true, force: true });
    }
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
