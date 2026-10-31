import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentBridge, pickReplyParent } from "./bridge.js";
import type {
  ChatMessage,
  Invocation,
  InvocationReport,
  Participant,
  WhiteboardEntry,
} from "./hive-protocol.js";
import {
  AgentCancelledError,
  AgentExecutionUncertainError,
  AgentNonRetryableError,
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
  whiteboard: WhiteboardEntry[] = [];
  participants: Participant[] = [self];
  whiteboardCalls = 0;
  participantCalls = 0;
  /** 模拟 Server 重启：接下来这么多次补拉/发送都连不上 */
  offlineCalls = 0;
  private offline(): void {
    if (this.offlineCalls > 0) {
      this.offlineCalls -= 1;
      throw new Error("聊天室连接已断开，稍后将自动重试。");
    }
  }

  start() {}
  stop() {}
  setTyping() {}
  async fetchInstructions() {
    return "server rules";
  }
  async fetchMessages(afterSeq: number) {
    this.offline();
    const messages = this.messages.filter((message) => message.seq > afterSeq);
    return { messages, latestSeq: this.messages.at(-1)?.seq ?? afterSeq };
  }
  async fetchWhiteboard() {
    this.whiteboardCalls += 1;
    return this.whiteboard;
  }
  async fetchParticipants() {
    this.participantCalls += 1;
    return this.participants;
  }
  report(report: Omit<InvocationReport, "type">) {
    this.reports.push(report);
  }
  async sendMessage(input: { content: string; clientMessageId: string; parentMessageId: string }) {
    this.offline();
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
  finish(text = "完成", threadId = "thread-1", usage?: AgentReply["usage"]) {
    this.resolvers.shift()?.resolve({ text, threadId, ...(usage ? { usage } : {}) });
  }
  fail(message: string | Error = "boom") {
    this.resolvers.shift()?.reject(message instanceof Error ? message : new Error(message));
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

  async function startBridge(
    state?: AgentState,
    invocations?: Invocation[],
    snapshotMessages: ChatMessage[] = [],
  ) {
    if (state) await store.save(state);
    bridge = new AgentBridge(
      {
        ...identity,
        persona: "p",
        provider: "codex",
        token: "t",
        tuning: { batchWindowMs: 20, offlineRetryIntervalMs: 5 },
      },
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
      messages: snapshotMessages,
      participants: [self],
      ...(invocations ? { invocations } : {}),
    };
    await room.handlers.onSnapshot(snapshot);
  }

  async function completePromptTurn(threadId = "thread-1"): Promise<AgentReplyInput> {
    const index = responder.calls.length;
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === index + 1);
    const input = responder.calls[index]!;
    responder.finish("完成", threadId);
    await waitUntil(() => room.statuses(mention.id).includes("completed"));
    return input;
  }

  function seedPromptContext() {
    room.whiteboard = ["a", "b"].map((key) => ({
      id: `board-${key}`,
      key,
      slot: "ready",
      summary: `summary-${key}`,
      unblocks: [],
      authorName: "author",
      updatedAt: "2026-10-31T00:00:00Z",
    }));
    room.participants = [self, { ...self, id: "other", username: "reviewer", persona: "review" }];
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
    vi.useRealTimers();
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

  it("waits for the Hive Server to come back instead of re-running a finished turn", async () => {
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    // 模型已经给出结果，这时 Server 正在重启：补拉和发送各失败几次后恢复
    room.offlineCalls = 4;
    responder.finish("重启期间做完的");
    await waitUntil(() => room.statuses(mention.id).includes("completed"));
    expect(room.sent).toHaveLength(1);
    expect(room.sent[0]).toMatchObject({ content: "重启期间做完的" });
    // 没有把整轮当失败重跑
    expect(responder.calls).toHaveLength(1);
    expect(room.statuses(mention.id)).not.toContain("failed");
  });

  it("strips the attachment directive from the reply and reports files it could not publish", async () => {
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    responder.finish("做好了\n\n<hive-attachments>\nout/a.png\n</hive-attachments>");
    await waitUntil(() => room.sent.length === 1);
    expect(room.sent[0]?.content).toBe(
      "做好了\n\n（以下附件没有发出：a.png — 这个 Agent 没有配置工作目录，不能发布文件）",
    );
    expect(room.sent[0]).not.toHaveProperty("attachmentIds");
  });

  it("resends the full rules once when they changed for a resumed codex thread", async () => {
    await startBridge({ ...baseState(), threadId: "thread-old", instructionsDigest: "stale" });
    const first = chat();
    room.messages.push(first);
    room.handlers.onMention(first, first.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    expect(responder.calls[0]?.prompt).toContain("<updated_rules>");
    expect(responder.calls[0]?.prompt).toContain("server rules");
    responder.finish("好");
    await waitUntil(() => room.sent.length === 1);

    const second = chat({ seq: first.seq + 10 });
    room.messages.push(second);
    room.handlers.onMention(second, second.seq, false);
    await waitUntil(() => responder.calls.length === 2);
    expect(responder.calls[1]?.prompt).not.toContain("<updated_rules>");
  });

  it("still posts the final answer after delegating with hive_invoke", async () => {
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    // 本轮中途经 hive_invoke 发出的委派消息不是这一轮的回复
    room.messages.push(
      chat({
        senderId: SELF,
        senderName: "agent-a",
        senderType: "agent",
        content: "@agent-b 子任务",
        mentions: ["agent-b"],
        kind: "delegation",
      }),
    );
    responder.finish("已委派 agent-b，结果回来后汇总");
    await waitUntil(() => room.statuses(mention.id).includes("completed"));
    expect(room.sent).toEqual([
      expect.objectContaining({
        content: "已委派 agent-b，结果回来后汇总",
        parentMessageId: mention.id,
      }),
    ]);
  });

  it("processes a server-dispatched answer that does not @ the agent", async () => {
    await startBridge(baseState());
    // 人回复了 Agent 的提问：正文没有 @，但服务端已为它派发
    const answer = chat({ content: "A", mentions: [] });
    room.messages.push(answer);
    room.handlers.onMention(answer, answer.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    responder.finish("收到，开始提交");
    await waitUntil(() => room.statuses(answer.id).includes("completed"));
    expect(room.sent[0]).toMatchObject({ content: "收到，开始提交", parentMessageId: answer.id });
  });

  it("still posts the final answer after asking a human with hive_ask_human", async () => {
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    // 本轮中途经 hive_ask_human 发出的提问不是这一轮的回复
    room.messages.push(
      chat({
        senderId: SELF,
        senderName: "agent-a",
        senderType: "agent",
        content: "@Alice ❓ 发正式环境吗？",
        mentions: ["Alice"],
        kind: "question",
      }),
    );
    responder.finish("在等 Alice 确认环境，确认后继续");
    await waitUntil(() => room.statuses(mention.id).includes("completed"));
    expect(room.sent).toEqual([
      expect.objectContaining({
        content: "在等 Alice 确认环境，确认后继续",
        parentMessageId: mention.id,
      }),
    ]);
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

  it("reports a turn's usage once, tagged with new/resumed session and idle time", async () => {
    await startBridge(baseState());
    const usage = {
      inputTokens: 10,
      cacheWriteTokens: 400_000,
      cacheReadTokens: 0,
      outputTokens: 20,
      requests: 1,
      peakContextTokens: 400_010,
      peakCacheWriteTokens: 400_000,
    };
    const first = chat();
    const second = chat({ senderName: "Bob", content: "@agent-a 还有这个" });
    room.messages.push(first, second);
    room.handlers.onMention(first, first.seq, false);
    room.handlers.onMention(second, second.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    responder.finish("好", "thread-1", usage);
    await waitUntil(() => room.statuses(second.id).includes("completed"));
    const withUsage = room.reports.filter((report) => report.usage);
    expect(withUsage).toHaveLength(1);
    expect(withUsage[0]).toMatchObject({ messageId: first.id, status: "completed" });
    expect(withUsage[0]!.usage).toEqual({ ...usage, session: "new" });

    const third = chat({ content: "@agent-a 再来" });
    room.messages.push(third);
    room.handlers.onMention(third, third.seq, false);
    await waitUntil(() => responder.calls.length === 2);
    responder.finish("好", "thread-1", usage);
    await waitUntil(() => room.statuses(third.id).includes("completed"));
    const resumed = room.reports.find((report) => report.messageId === third.id && report.usage);
    expect(resumed?.usage?.session).toBe("resumed");
    expect(resumed?.usage?.idleMs).toBeGreaterThanOrEqual(0);
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
      expect.objectContaining({ messageId: pendingMention.id, status: "uncertain" }),
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

  it("picks up queued mentions on first join without replaying older chat", async () => {
    const history = chat({ content: "@agent-a 早就处理过的旧消息" });
    const inWindow = chat({ content: "@agent-a 上线前就排队的" });
    const outOfWindow = chat({ content: "@agent-a 太早的排队提及" });
    room.messages.push(outOfWindow, history, inWindow);
    const invocation = (message: ChatMessage, status: Invocation["status"]): Invocation => ({
      id: message.id.replace(/0000$/, "ffff"),
      roomId: "general",
      messageId: message.id,
      agentId: SELF,
      agentName: "agent-a",
      status,
      attempts: 1,
    });
    // 不传 state：本地没有状态文件，即首次加入；快照窗口里只有后两条消息
    await startBridge(
      undefined,
      [invocation(outOfWindow, "queued"), invocation(inWindow, "queued")],
      [history, inWindow],
    );
    await waitUntil(() => responder.calls.length === 1);
    expect(responder.calls[0]!.prompt).toContain("上线前就排队的");
    expect(room.reports).toContainEqual(
      expect.objectContaining({ messageId: outOfWindow.id, status: "failed" }),
    );
    responder.finish();
    await waitUntil(() => room.statuses(inWindow.id).includes("completed"));
    await new Promise((resolve) => setTimeout(resolve, 60));
    // 没有 queued 调用的历史 @ 不补做
    expect(responder.calls).toHaveLength(1);
    expect(room.statuses(history.id)).toEqual([]);
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
    // Fetch cheaply on each wake so member changes are detected; only changes enter prompts.
    expect(room.participantCalls).toBe(3);
  });

  it("does not resend unchanged whiteboard/members after timestamp changes or reordering", async () => {
    seedPromptContext();
    await startBridge(baseState());
    const first = await completePromptTurn();
    expect(first.prompt).toContain("summary-a");
    expect(first.prompt).toContain("reviewer");
    room.whiteboard = room.whiteboard
      .reverse()
      .map((entry) => ({ ...entry, updatedAt: "2026-10-31T01:00:00Z" }));
    room.participants = room.participants
      .reverse()
      .map((member) => ({ ...member, lastSeenAt: "2026-10-31T01:00:00Z" }));
    const next = await completePromptTurn();
    expect(next.refreshInstructions).toBe(false);
    expect(next.prompt).not.toContain("<room_whiteboard>");
    expect(next.prompt).not.toContain("<room_members>");
    expect((await store.load())?.promptContext?.whiteboard?.entries).toHaveLength(2);
  });

  it("sends only semantic deltas for whiteboard slot/content changes and member status changes", async () => {
    seedPromptContext();
    room.participants.push({ ...self, id: "stable", username: "unchanged-member" });
    await startBridge(baseState());
    await completePromptTurn();
    room.whiteboard[0] = { ...room.whiteboard[0]!, slot: "blocked", summary: "needs-input" };
    room.participants[1] = { ...room.participants[1]!, status: "busy" };
    const next = await completePromptTurn();
    expect(next.prompt).toContain("增量：");
    expect(next.prompt).toContain("阻塞：");
    expect(next.prompt).toContain("[a] needs-input");
    expect(next.prompt).not.toContain("summary-b");
    expect(next.prompt).toContain("reviewer（agent，busy）");
    expect(next.prompt).not.toContain("unchanged-member");
    const stable = await completePromptTurn();
    expect(stable.prompt).not.toContain("<room_whiteboard>");
    expect(stable.prompt).not.toContain("<room_members>");
  });

  it("sends removals when lists clear, then stays quiet", async () => {
    seedPromptContext();
    await startBridge(baseState());
    await completePromptTurn();
    room.whiteboard = [];
    room.participants = [self];
    const cleared = await completePromptTurn();
    expect(cleared.prompt).toContain("从摘要移除");
    expect(cleared.prompt).toContain("- [a]");
    expect(cleared.prompt).toContain("- [b]");
    expect(cleared.prompt).toContain("移出成员列表：\n- reviewer");
    const next = await completePromptTurn();
    expect(next.prompt).not.toContain("<room_whiteboard>");
    expect(next.prompt).not.toContain("<room_members>");
  });

  it("preserves context snapshots across Bridge restart and forces complete periodic refreshes", async () => {
    seedPromptContext();
    await startBridge(baseState());
    await completePromptTurn();
    await bridge.stop();
    await startBridge(await store.load());
    const resumed = await completePromptTurn();
    expect(resumed.prompt).not.toContain("<room_whiteboard>");
    expect(resumed.prompt).not.toContain("<room_members>");
    const state = (await store.load())!;
    await bridge.stop();
    await startBridge({ ...state, briefTurns: 8 });
    const periodic = await completePromptTurn();
    expect(periodic.refreshInstructions).toBe(true);
    expect(periodic.prompt).toContain("完整快照");
    expect(periodic.prompt).toContain("summary-a");
    expect(periodic.prompt).toContain("summary-b");
    expect(periodic.prompt).toContain("reviewer");
  });

  it("resends full unchanged context after the time-based refresh interval", async () => {
    seedPromptContext();
    await startBridge(baseState());
    await completePromptTurn();
    const state = (await store.load())!;
    await bridge.stop();
    await startBridge({ ...state, lastFullPromptAt: "2000-01-01T00:00:00Z" });
    const periodic = await completePromptTurn();
    expect(periodic.refreshInstructions).toBe(true);
    expect(periodic.prompt).toContain("完整快照");
    expect(periodic.prompt).toContain("summary-b");
    expect(periodic.prompt).toContain("reviewer");
  });

  it("never reuses the old topic baseline when the new topic's first fetch fails", async () => {
    seedPromptContext();
    await startBridge(baseState());
    await completePromptTurn();
    room.messages.push(chat({ kind: "topic", content: "new topic", mentions: [] }));
    vi.spyOn(room, "fetchWhiteboard").mockRejectedValueOnce(new Error("offline"));
    const first = await completePromptTurn("thread-new-topic");
    expect(first.threadId).toBeUndefined();
    expect(first.refreshInstructions).toBe(true);
    expect(first.prompt).toContain("reviewer");
    expect((await store.load())?.promptContext?.whiteboard).toBeUndefined();
    const next = await completePromptTurn("thread-new-topic");
    expect(next.prompt).toContain("完整快照");
    expect(next.prompt).toContain("summary-a");
    expect(next.prompt).not.toContain("<room_members>");
  });

  it("migrates legacy fingerprints to one full context snapshot without resetting the conversation", async () => {
    seedPromptContext();
    await startBridge(baseState());
    await completePromptTurn();
    const state = (await store.load())!;
    delete state.promptContext;
    state.whiteboardDigest = "legacy-digest";
    await bridge.stop();
    await startBridge(state);
    const migrated = await completePromptTurn();
    expect(migrated.threadId).toBe("thread-1");
    expect(migrated.refreshInstructions).toBe(false);
    expect(migrated.prompt).toContain("完整快照");
    expect(migrated.prompt).toContain("summary-b");
    expect((await store.load())?.whiteboardDigest).toBeUndefined();
    expect((await completePromptTurn()).prompt).not.toContain("<room_whiteboard>");
  });

  it("does not treat failed fetches as removals or lose changes observed after recovery", async () => {
    seedPromptContext();
    await startBridge(baseState());
    await completePromptTurn();
    const previous = (await store.load())!.promptContext;
    room.whiteboard[0] = { ...room.whiteboard[0]!, summary: "after-outage" };
    room.participants[1] = { ...room.participants[1]!, status: "offline" };
    vi.spyOn(room, "fetchWhiteboard").mockRejectedValueOnce(new Error("offline"));
    vi.spyOn(room, "fetchParticipants").mockRejectedValueOnce(new Error("offline"));
    const failed = await completePromptTurn();
    expect(failed.prompt).not.toContain("<room_whiteboard>");
    expect(failed.prompt).not.toContain("<room_members>");
    expect((await store.load())!.promptContext).toEqual(previous);
    const recovered = await completePromptTurn();
    expect(recovered.prompt).toContain("[a] after-outage");
    expect(recovered.prompt).not.toContain("summary-b");
    expect(recovered.prompt).toContain("reviewer（agent，offline）");
  });

  it("supplies missing baseline after the first full fetch failed", async () => {
    seedPromptContext();
    await startBridge(baseState());
    vi.spyOn(room, "fetchWhiteboard").mockRejectedValueOnce(new Error("offline"));
    const first = await completePromptTurn();
    expect(first.prompt).not.toContain("<room_whiteboard>");
    const recovered = await completePromptTurn();
    expect(recovered.refreshInstructions).toBe(false);
    expect(recovered.prompt).toContain("完整快照");
    expect(recovered.prompt).toContain("summary-a");
    expect(recovered.prompt).toContain("summary-b");
    expect(recovered.prompt).not.toContain("<room_members>");
  });

  it("does not checkpoint an unacknowledged prompt when the provider fails", async () => {
    seedPromptContext();
    await startBridge(baseState());
    await completePromptTurn();
    const previous = (await store.load())!.promptContext;
    room.whiteboard[0] = { ...room.whiteboard[0]!, summary: "unacknowledged" };
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 2);
    responder.fail(new AgentNonRetryableError("failed before completion"));
    await waitUntil(() => room.statuses(mention.id).includes("failed"));
    expect((await store.load())!.promptContext).toEqual(previous);
    expect((await completePromptTurn()).prompt).toContain("[a] unacknowledged");
  });

  it("refreshes full context after a runtime silently replaced its missing thread", async () => {
    seedPromptContext();
    await startBridge(baseState());
    await completePromptTurn();
    await completePromptTurn("thread-replacement");
    expect((await store.load())!.promptContext).toBeUndefined();
    const next = await completePromptTurn("thread-replacement");
    expect(next.prompt).toContain("完整快照");
    expect(next.prompt).toContain("summary-b");
    expect(next.prompt).toContain("reviewer");
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

  it("drops the provider session and old context when someone starts a new topic", async () => {
    seedPromptContext();
    await startBridge({ ...baseState(), threadId: "thread-old" });
    room.messages.push(chat({ content: "旧话题里讨论的方案 A", mentions: [] }));
    const topic = chat({ kind: "topic", content: "Alice 开启了新话题", mentions: [] });
    room.messages.push(topic);
    room.messages.push(chat({ content: "新话题：改做方案 B", mentions: [] }));
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);

    const first = responder.calls[0]!;
    // 不再续用旧会话，并重新注入完整规则；上下文只剩分隔之后的消息
    expect(first.threadId).toBeUndefined();
    expect(first.refreshInstructions).toBe(true);
    expect(first.prompt).toContain("方案 B");
    expect(first.prompt).toContain("summary-a");
    expect(first.prompt).toContain("reviewer");
    expect(first.prompt).not.toContain("方案 A");
    responder.finish("好的", "thread-new");
    await waitUntil(() => room.statuses(mention.id).includes("completed"));
    expect((await store.load())?.topicSeq).toBe(topic.seq);

    // 同一个话题里的下一轮续用新会话，不会再次重置
    const next = chat();
    room.messages.push(next);
    room.handlers.onMention(next, next.seq, false);
    await waitUntil(() => responder.calls.length === 2);
    expect(responder.calls[1]!.threadId).toBe("thread-new");
    responder.finish();
    await waitUntil(() => room.statuses(next.id).includes("completed"));
  });

  it("reports heartbeat-only waiting without treating it as runtime progress or retrying", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(room.reports.at(-1)?.progress).toBe("仅 Bridge 心跳；1分0秒未收到 Runtime 新进度");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(room.reports.at(-1)?.progress).toContain("2分0秒未收到 Runtime 新进度，状态待核实");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(room.reports.at(-1)?.progress).toContain("3分0秒未收到 Runtime 新进度，状态待核实");
    expect(room.statuses(mention.id)).not.toContain("failed");
    expect(room.sent).toHaveLength(0);
    expect(responder.calls).toHaveLength(1);
    expect(responder.calls[0]!.signal?.aborted).toBe(false);

    responder.finish();
    await waitUntil(() => room.statuses(mention.id).includes("completed"));
    const reportsAtCompletion = room.reports.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(room.reports).toHaveLength(reportsAtCompletion);
  });

  it("labels old progress as historical and clears a stale warning on fresh runtime progress", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    const progress = responder.calls[0]!.onProgress!;
    progress("执行命令：读取项目");
    expect(room.reports.at(-1)?.progress).toBe("执行命令：读取项目");

    await vi.advanceTimersByTimeAsync(120_000);
    expect(room.reports.at(-1)?.progress).toContain("状态待核实；上次：执行命令：读取项目");
    // 刚发过心跳也不得节流掉新的真实进度，否则告警会继续误留在界面上。
    progress("调用工具：读取测试结果");
    expect(room.reports.at(-1)?.progress).toBe("调用工具：读取测试结果");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(room.reports.at(-1)?.progress).toContain("1分0秒未收到 Runtime 新进度");
    expect(room.reports.at(-1)?.progress).not.toContain("状态待核实");
  });

  it("tracks throttled runtime events without letting heartbeat reset the idle clock", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    const progress = responder.calls[0]!.onProgress!;
    progress("第一个动作");
    const reportsBeforeThrottle = room.reports.length;
    await vi.advanceTimersByTimeAsync(1_000);
    progress("第二个动作");
    expect(room.reports).toHaveLength(reportsBeforeThrottle);

    await vi.advanceTimersByTimeAsync(119_000);
    expect(room.reports.at(-1)?.progress).toContain("1分59秒未收到 Runtime 新进度");
    expect(room.reports.at(-1)?.progress).toContain("上次：第二个动作");
    expect(room.reports.at(-1)?.progress).not.toContain("状态待核实");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(room.reports.at(-1)?.progress).toContain("2分59秒未收到 Runtime 新进度，状态待核实");
  });

  it("keeps heartbeat warnings inside the progress wire limit even after a long tool label", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    responder.calls[0]!.onProgress!("很长的工具名称".repeat(100));
    await vi.advanceTimersByTimeAsync(120_000);
    const warning = room.reports.at(-1)?.progress ?? "";
    expect(warning).toContain("状态待核实");
    expect(warning.length).toBeLessThanOrEqual(200);
  });

  it("streams structured facts, throttles activity but not errors, and ignores late callbacks", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    const emit = responder.calls[0]!.onRuntimeEvent!;
    emit({ kind: "capabilities", observability: "partial" });
    emit({ kind: "activity", phase: "tool_running", tool: "read" });
    const count = room.reports.length;
    for (let i = 0; i < 20; i++) emit({ kind: "activity", phase: "tool_running", tool: "read" });
    expect(room.reports).toHaveLength(count);
    emit({ kind: "provider_error", code: 429 });
    expect(room.reports.at(-1)?.runtimeEvent).toEqual({ kind: "provider_error", code: 429 });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(room.reports.at(-1)?.runtimeEvent).toBeUndefined();
    expect(room.reports.at(-1)?.progress).toContain("状态待核实");
    emit({ kind: "recovered" });
    expect(room.reports.at(-1)?.runtimeEvent?.kind).toBe("recovered");
    responder.finish();
    await waitUntil(() => room.statuses(mention.id).includes("completed"));
    const finishedCount = room.reports.length;
    emit({ kind: "provider_error", code: 500 });
    expect(room.reports).toHaveLength(finishedCount);
  });

  it("reports a non-retryable startup failure once and preserves it across reconnect", async () => {
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    responder.fail(
      new AgentNonRetryableError("Codex app-server initialize 超时；不会自动降级或重试。"),
    );
    await waitUntil(() => room.statuses(mention.id).includes("failed"));
    await new Promise((resolve) => setTimeout(resolve, 1100));
    room.handlers.onMention(mention, mention.seq, false);
    expect(responder.calls).toHaveLength(1);
    expect(room.reports.at(-1)?.detail).toContain("initialize");
    expect((await store.load())?.processedMessageIds).toContain(mention.id);
  });

  it("does not requeue a steer with unknown delivery", async () => {
    await startBridge(baseState());
    const first = chat();
    room.messages.push(first);
    room.handlers.onMention(first, first.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    vi.spyOn(responder, "steer").mockRejectedValue(new AgentExecutionUncertainError("ack lost"));
    const extra = chat();
    room.messages.push(extra);
    room.handlers.onMention(extra, extra.seq, false);
    await waitUntil(() => room.statuses(extra.id).includes("uncertain"));
    responder.finish("first complete");
    await waitUntil(() => room.statuses(first.id).includes("completed"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(responder.calls).toHaveLength(1);
    expect((await store.load())?.processedMessageIds).toContain(extra.id);
  });

  it("does not automatically replay a provider execution whose result was lost", async () => {
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    responder.fail(new AgentExecutionUncertainError());
    await waitUntil(() => room.statuses(mention.id).includes("uncertain"));
    expect(room.reports.at(-1)?.detail).toContain("已禁止自动重放");
    expect((await store.load())?.processedMessageIds).toContain(mention.id);
    room.handlers.onMention(mention, mention.seq, false);
    await flush();
    expect(responder.calls).toHaveLength(1);
  });

  it("waits for the whole batch to finish before acknowledging a partial cancellation", async () => {
    await startBridge(baseState());
    const first = chat();
    const second = chat();
    room.messages.push(first, second);
    room.handlers.onMention(first, first.seq, false);
    room.handlers.onMention(second, second.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    room.handlers.onCancel!(first.id);
    expect(room.statuses(first.id)).not.toContain("cancelled");
    expect(responder.calls[0]!.signal?.aborted).toBe(false);
    responder.finish();
    await waitUntil(() => room.statuses(first.id).includes("cancelled"));
    expect(room.statuses(second.id)).toContain("completed");
  });

  it("picks the deepest trigger as the reply parent", () => {
    const human = chat({ hopCount: 0 });
    const agent = chat({ hopCount: 2, senderType: "agent" });
    const later = chat({ hopCount: 0 });
    expect(pickReplyParent([human, agent, later]).id).toBe(agent.id);
  });
});
