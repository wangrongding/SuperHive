import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentBridge, pickReplyParent } from "./bridge.js";
import type { ChatMessage, Invocation, InvocationReport, Participant } from "./hive-protocol.js";
import {
  AgentCancelledError,
  type AgentReply,
  type AgentReplyInput,
  type AgentResponder,
} from "./responder.js";
import type { RoomClient, RoomClientHandlers, Snapshot } from "./room-client.js";
import { StateStore, type AgentState } from "./state-store.js";

const SELF = "00000000-0000-4000-8000-0000000000aa";
let seq = 0;

function chat(overrides: Partial<ChatMessage> = {}): ChatMessage {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    roomId: "general",
    seq,
    senderId: "00000000-0000-4000-8000-0000000000bb",
    senderName: "Alice",
    senderType: "human",
    content: "@agent-a 帮忙",
    mentions: ["agent-a"],
    traceId: "00000000-0000-4000-8000-0000000000cc",
    hopCount: 0,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const self: Participant = {
  id: SELF,
  roomId: "general",
  username: "agent-a",
  type: "agent",
  status: "online",
  joinedAt: new Date().toISOString(),
  lastSeenAt: new Date().toISOString(),
};

/** 记录 Bridge 对房间的所有调用，并允许测试直接触发服务端事件 */
class FakeRoom {
  handlers!: RoomClientHandlers;
  messages: ChatMessage[] = [];
  reports: Array<Omit<InvocationReport, "type">> = [];
  sent: Array<{ content: string; clientMessageId: string; parentMessageId: string }> = [];
  whiteboardCalls = 0;
  participantCalls = 0;

  start() {}
  stop() {}
  setTyping() {}
  async fetchInstructions() {
    return "server rules";
  }
  async fetchMessages(afterSeq: number) {
    const messages = this.messages.filter((message) => message.seq > afterSeq);
    return { messages, latestSeq: this.messages.at(-1)?.seq ?? afterSeq };
  }
  async fetchWhiteboard() {
    this.whiteboardCalls += 1;
    return [];
  }
  async fetchParticipants() {
    this.participantCalls += 1;
    return [self];
  }
  report(report: Omit<InvocationReport, "type">) {
    this.reports.push(report);
  }
  async sendMessage(input: { content: string; clientMessageId: string; parentMessageId: string }) {
    this.sent.push(input);
    const reply = chat({
      senderId: SELF,
      senderName: "agent-a",
      senderType: "agent",
      content: input.content,
      mentions: [],
    });
    this.messages.push(reply);
    return reply;
  }
  statuses(messageId: string) {
    return this.reports
      .filter((report) => report.messageId === messageId)
      .map((report) => report.status);
  }
}

/** 可控的 Responder：每次 reply 都挂起，由测试决定何时完成或失败 */
class ControlledResponder implements AgentResponder {
  calls: AgentReplyInput[] = [];
  steered: string[] = [];
  steerResult = true;
  private resolvers: Array<{
    resolve: (reply: AgentReply) => void;
    reject: (error: Error) => void;
  }> = [];

  reply(input: AgentReplyInput): Promise<AgentReply> {
    this.calls.push(input);
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      this.resolvers.push(entry);
      input.signal?.addEventListener("abort", () => {
        this.resolvers = this.resolvers.filter((candidate) => candidate !== entry);
        reject(new AgentCancelledError());
      });
    });
  }
  async steer(prompt: string) {
    this.steered.push(prompt);
    return this.steerResult;
  }
  finish(text = "完成", threadId = "thread-1") {
    this.resolvers.shift()?.resolve({ text, threadId });
  }
  fail(message = "boom") {
    this.resolvers.shift()?.reject(new Error(message));
  }
}

async function flush(times = 5) {
  for (let index = 0; index < times; index += 1)
    await new Promise((resolve) => setImmediate(resolve));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("AgentBridge", () => {
  let directory: string;
  let store: StateStore;
  let room: FakeRoom;
  let responder: ControlledResponder;
  let bridge: AgentBridge;
  const identity = { serverUrl: "http://hive", roomId: "general", username: "agent-a" };

  async function startBridge(state?: AgentState, invocations?: Invocation[]) {
    if (state) await store.save(state);
    bridge = new AgentBridge(
      { ...identity, persona: "p", provider: "codex", token: "t", tuning: { batchWindowMs: 20 } },
      store,
      responder,
      () => undefined,
      (_options, handlers) => {
        room.handlers = handlers;
        return room as unknown as RoomClient;
      },
    );
    await bridge.start();
    const snapshot: Snapshot = {
      self,
      latestSeq: room.messages.at(-1)?.seq ?? 0,
      messages: [],
      participants: [self],
      ...(invocations ? { invocations } : {}),
    };
    await room.handlers.onSnapshot(snapshot);
  }

  const baseState = (): AgentState => ({
    ...identity,
    lastProcessedSeq: 0,
    processedMessageIds: [],
  });

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "hive-bridge-test-"));
    store = new StateStore(directory, identity);
    room = new FakeRoom();
    responder = new ControlledResponder();
  });

  afterEach(async () => {
    await bridge?.stop();
    await rm(directory, { recursive: true, force: true });
  });

  it("reports the full lifecycle and writes the execution intent before calling the provider", async () => {
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);

    const intent = await store.load();
    expect(intent?.inflight?.messageIds).toEqual([mention.id]);
    expect(room.statuses(mention.id)).toEqual(["received", "running"]);
    expect(room.reports.find((report) => report.status === "running")?.contextSeq).toBe(
      mention.seq,
    );

    responder.finish("搞定");
    await waitUntil(() => room.statuses(mention.id).includes("completed"));
    const completed = room.reports.find((report) => report.status === "completed");
    expect(completed?.replyMessageId).toBe(room.messages.at(-1)?.id);
    expect(room.sent[0]).toMatchObject({ content: "搞定", parentMessageId: mention.id });
    const saved = await store.load();
    expect(saved?.inflight).toBeUndefined();
    expect(saved?.processedMessageIds).toContain(mention.id);
    expect(saved?.threadId).toBe("thread-1");
  });

  it("stays silent on NO_REPLY but still completes and remembers the mention", async () => {
    await startBridge(baseState());
    const mention = chat({
      senderName: "agent-b",
      senderType: "agent",
      content: "@agent-a 我这边结论和你一致",
    });
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    // 全部由 Agent 唤醒时，结尾提醒可以不回
    expect(responder.calls[0]!.prompt).toContain("只输出 NO_REPLY");

    responder.finish("**NO_REPLY**");
    await waitUntil(() => room.statuses(mention.id).includes("completed"));
    expect(room.sent).toHaveLength(0);
    const completed = room.reports.find((report) => report.status === "completed");
    expect(completed).toMatchObject({ detail: "无需回复" });
    expect(completed?.replyMessageId).toBeUndefined();
    expect((await store.load())?.processedMessageIds).toContain(mention.id);
  });

  it("strips a stray NO_REPLY from a real answer and only reminds about it for agent triggers", async () => {
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    expect(responder.calls[0]!.prompt).not.toContain("只输出 NO_REPLY");

    responder.finish("已经改好了。\n\nNO_REPLY");
    await waitUntil(() => room.statuses(mention.id).includes("completed"));
    expect(room.sent[0]?.content).toBe("已经改好了。");
  });

  it("merges a burst of mentions into one provider turn", async () => {
    await startBridge(baseState());
    const first = chat();
    const second = chat({ senderName: "Bob", content: "@agent-a 还有这个" });
    room.messages.push(first, second);
    room.handlers.onMention(first, first.seq, false);
    room.handlers.onMention(second, second.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    expect(responder.calls[0]!.prompt).toContain("当前有 2 条消息");
    responder.finish();
    await waitUntil(() => room.statuses(second.id).includes("completed"));
    expect(room.sent).toHaveLength(1);
    expect(responder.calls).toHaveLength(1);
  });

  it("steers late mentions into the running turn and falls back to queueing", async () => {
    await startBridge(baseState());
    const first = chat();
    room.messages.push(first);
    room.handlers.onMention(first, first.seq, false);
    await waitUntil(() => responder.calls.length === 1);

    const late = chat({ content: "@agent-a 顺便看下 README" });
    room.messages.push(late);
    room.handlers.onMention(late, late.seq, false);
    await waitUntil(() => responder.steered.length === 1);
    await flush();
    expect(responder.steered[0]).toContain("README");
    expect(room.statuses(late.id)).toContain("running");

    responder.steerResult = false;
    const queued = chat({ content: "@agent-a 第三件事" });
    room.messages.push(queued);
    room.handlers.onMention(queued, queued.seq, false);
    await waitUntil(() => responder.steered.length === 2);

    responder.finish();
    await waitUntil(() => room.statuses(late.id).includes("completed"));
    // 注入失败的那条在下一轮单独处理
    await waitUntil(() => responder.calls.length === 2);
    expect(responder.calls[1]!.prompt).toContain("第三件事");
    expect(responder.calls[1]!.threadId).toBe("thread-1");
    responder.finish();
    await waitUntil(() => room.statuses(queued.id).includes("completed"));
  });

  it("aborts the provider when every message of the turn is cancelled", async () => {
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    room.handlers.onCancel!(mention.id);
    await waitUntil(() => room.statuses(mention.id).includes("cancelled"));
    expect(room.sent).toHaveLength(0);
    expect(responder.calls[0]!.signal?.aborted).toBe(true);
    expect((await store.load())?.processedMessageIds).toContain(mention.id);

    // 停止一条还在排队的提及：直接出队，不调用 Provider
    const blocker = chat();
    const queued = chat();
    room.messages.push(blocker, queued);
    responder.steerResult = false;
    room.handlers.onMention(blocker, blocker.seq, false);
    await waitUntil(() => responder.calls.length === 2);
    room.handlers.onMention(queued, queued.seq, false);
    await waitUntil(() => responder.steered.length >= 1);
    await flush();
    room.handlers.onCancel!(queued.id);
    responder.finish();
    await waitUntil(() => room.statuses(blocker.id).includes("completed"));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(responder.calls).toHaveLength(2);
  });

  it("does not rerun an execution that was interrupted by a crash", async () => {
    const pendingMention = chat();
    room.messages.push(pendingMention);
    await startBridge({
      ...baseState(),
      inflight: {
        executionId: "exec-1",
        messageIds: [pendingMention.id],
        startedAt: new Date().toISOString(),
      },
    });
    await flush();
    expect(room.reports).toContainEqual(
      expect.objectContaining({ messageId: pendingMention.id, status: "failed" }),
    );
    expect(responder.calls).toHaveLength(0);
    expect((await store.load())?.inflight).toBeUndefined();

    // 人在界面中重试：忽略"已处理"记录并重新执行
    room.handlers.onMention(pendingMention, pendingMention.seq, true);
    await waitUntil(() => responder.calls.length === 1);
    responder.finish();
    await waitUntil(() => room.statuses(pendingMention.id).includes("completed"));
  });

  it("only replays queued mentions on reconnect and leaves blocked ones alone", async () => {
    const queued = chat();
    const blocked = chat({ content: "@agent-a 被拦下的" });
    room.messages.push(queued, blocked);
    const invocation = (message: ChatMessage, status: Invocation["status"]): Invocation => ({
      id: message.id.replace(/0000$/, "ffff"),
      roomId: "general",
      messageId: message.id,
      agentId: SELF,
      agentName: "agent-a",
      status,
      attempts: 1,
    });
    await startBridge(baseState(), [invocation(queued, "queued"), invocation(blocked, "blocked")]);
    await waitUntil(() => responder.calls.length === 1);
    expect(responder.calls[0]!.prompt).toContain("帮忙");
    expect(responder.calls[0]!.prompt).not.toContain("<trigger_message>\n#" + blocked.seq);
    responder.finish();
    await waitUntil(() => room.statuses(queued.id).includes("completed"));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(responder.calls).toHaveLength(1);
  });

  it("retries failures with a stable idempotency key and dead-letters after three attempts", async () => {
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    responder.fail("网络错误");
    await waitUntil(() => responder.calls.length === 2, 3_000);
    responder.fail("网络错误");
    await waitUntil(() => responder.calls.length === 3, 5_000);
    responder.fail("网络错误");
    await waitUntil(() => room.statuses(mention.id).includes("failed"));
    const failed = room.reports.find((report) => report.status === "failed");
    expect(failed?.detail).toContain("连续失败 3 次");
    expect((await store.load())?.processedMessageIds).toContain(mention.id);
  }, 10_000);

  it("sends the full context only for new sessions or periodically", async () => {
    await startBridge(baseState());
    for (let turn = 0; turn < 3; turn += 1) {
      const mention = chat();
      room.messages.push(mention);
      room.handlers.onMention(mention, mention.seq, false);
      await waitUntil(() => responder.calls.length === turn + 1);
      responder.finish();
      await waitUntil(() => room.statuses(mention.id).includes("completed"));
    }
    expect(responder.calls.map((call) => call.refreshInstructions)).toEqual([true, false, false]);
    expect(responder.calls[0]!.prompt).toContain("<room_members>");
    expect(responder.calls[1]!.prompt).not.toContain("<room_members>");
    expect(room.participantCalls).toBe(1);
  });

  it("re-injects the rules right away when they changed since the session last saw them", async () => {
    await startBridge({
      ...baseState(),
      threadId: "thread-old",
      briefTurns: 1,
      lastFullPromptAt: new Date().toISOString(),
      instructionsDigest: "rules-before-upgrade",
    });
    for (let turn = 0; turn < 2; turn += 1) {
      const mention = chat();
      room.messages.push(mention);
      room.handlers.onMention(mention, mention.seq, false);
      await waitUntil(() => responder.calls.length === turn + 1);
      responder.finish();
      await waitUntil(() => room.statuses(mention.id).includes("completed"));
    }
    // 第一轮因规则变化发完整上下文，之后恢复增量
    expect(responder.calls.map((call) => call.refreshInstructions)).toEqual([true, false]);
    expect((await store.load())?.instructionsDigest).not.toBe("rules-before-upgrade");
  });

  it("picks the deepest trigger as the reply parent", () => {
    const human = chat({ hopCount: 0 });
    const agent = chat({ hopCount: 2, senderType: "agent" });
    const later = chat({ hopCount: 0 });
    expect(pickReplyParent([human, agent, later]).id).toBe(agent.id);
  });
});
