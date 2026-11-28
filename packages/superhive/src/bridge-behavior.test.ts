import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
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
  AgentSessionInvalidError,
  AgentTransientError,
  AgentUpstreamError,
  type AgentReply,
  type AgentReplyInput,
  type AgentResponder,
} from "./responder.js";
import {
  RoomClientError,
  type RoomClient,
  type RoomClientHandlers,
  type Snapshot,
} from "./room-client.js";
import { StateStore, type AgentState } from "./state-store.js";
import { TaskWorkspaceBusyError } from "./task-workspace.js";

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
  /** 连不上时抛什么；默认是连接断开，也可以换成 Server 在但答不上来时的超时 */
  offlineError = () => new Error("聊天室连接已断开，稍后将自动重试。");
  private offline(): void {
    if (this.offlineCalls > 0) {
      this.offlineCalls -= 1;
      throw this.offlineError();
    }
  }

  start() {}
  stop() {}
  sessions: Array<{ sessionId: string; cwd: string }> = [];
  reportSession(sessionId: string, cwd: string) {
    this.sessions.push({ sessionId, cwd });
  }
  hiveTools: Array<{ hive: string; detail?: string }> = [];
  reportHiveTools(hive: string, detail?: string) {
    this.hiveTools.push({ hive, ...(detail ? { detail } : {}) });
  }
  typing: boolean[] = [];
  setTyping(active: boolean) {
    this.typing.push(active);
  }
  async fetchInstructions() {
    return "server rules";
  }
  async fetchMessages(afterSeq: number) {
    this.offline();
    const messages = this.messages.filter((message) => message.seq > afterSeq);
    return { messages, latestSeq: this.messages.at(-1)?.seq ?? afterSeq };
  }
  async fetchMessageAt(messageSeq: number, id: string) {
    return this.messages.find((message) => message.seq === messageSeq && message.id === id);
  }
  async fetchMessageById(id: string) {
    return this.messages.find((message) => message.id === id);
  }
  async fetchWhiteboard() {
    this.whiteboardCalls += 1;
    return this.whiteboard;
  }
  async fetchParticipants() {
    this.participantCalls += 1;
    return this.participants;
  }
  /** 模拟连接断开：回报进 outbox，不算送达 */
  disconnected = false;
  outbox: InvocationReport[] = [];
  report(report: Omit<InvocationReport, "type">) {
    if (this.disconnected) {
      this.outbox.push({ type: "invocation.report", ...report });
      return;
    }
    this.order.push(report.status);
    this.reports.push(report);
  }
  undeliveredReports() {
    return this.outbox.filter(
      (report) => report.status !== "received" && report.status !== "running",
    );
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
  approvalRequests: Array<{ messageId: string; requestId: string; summary: string }> = [];
  approvalsSupported = true;
  requestApproval(request: { messageId: string; requestId: string; summary: string }) {
    if (!this.approvalsSupported) return false;
    this.approvalRequests.push(request);
    return true;
  }
  traces: Array<{ messageId: string; steps: unknown[] }> = [];
  /** 按先后记下执行过程和状态回报，用来核对顺序 */
  order: string[] = [];
  trace(messageId: string, steps: unknown[]) {
    this.order.push("trace");
    this.traces.push({ messageId, steps });
  }
  statuses(messageId: string) {
    return this.reports
      .filter((report) => report.messageId === messageId)
      .map((report) => report.status);
  }
}

/** 可控的 Responder：每次 reply 都挂起，由测试决定何时完成或失败 */
class ControlledResponder implements AgentResponder {
  async close() {}
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
  finish(
    text = "完成",
    threadId = "thread-1",
    usage?: AgentReply["usage"],
    sessionCostUsd?: number,
    compacted?: boolean,
  ) {
    this.resolvers.shift()?.resolve({
      text,
      threadId,
      ...(usage ? { usage } : {}),
      ...(sessionCostUsd !== undefined ? { sessionCostUsd } : {}),
      ...(compacted ? { compacted } : {}),
    });
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

  /** 本机 Hive Server 写给 Agent 的设置文件（模型、备用模型） */
  let settingsFile: string | undefined;
  let taskWorkspace: ConstructorParameters<typeof AgentBridge>[0]["taskWorkspace"];
  /** startBridge 用的运行时，默认 codex */
  let bridgeProvider: string | undefined;
  let bridgeLead: string | undefined;
  let extraTuning: ConstructorParameters<typeof AgentBridge>[0]["tuning"];

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
        provider: bridgeProvider ?? "codex",
        ...(bridgeLead ? { roomLeadAgent: bridgeLead } : {}),
        token: "t",
        ...(settingsFile ? { settingsFile } : {}),
        ...(taskWorkspace ? { taskWorkspace, cwd: directory, access: "workspace" as const } : {}),
        tuning: {
          batchWindowMs: 20,
          offlineRetryIntervalMs: 5,
          traceFlushMs: 5,
          upstreamRetryDelaysMs: [30, 60],
          networkRetryDelaysMs: [30, 60, 90],
          transientRetryDelaysMs: [10, 20],
          ...extraTuning,
        },
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

  async function completePromptTurn(
    threadId = "thread-1",
    compacted = false,
  ): Promise<AgentReplyInput> {
    const index = responder.calls.length;
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === index + 1);
    const input = responder.calls[index]!;
    responder.finish("完成", threadId, undefined, undefined, compacted);
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
    settingsFile = undefined;
    taskWorkspace = undefined;
    bridgeProvider = undefined;
    bridgeLead = undefined;
    extraTuning = undefined;
  });

  afterEach(async () => {
    await bridge?.stop();
    vi.useRealTimers();
    await rm(directory, { recursive: true, force: true });
  });

  it("只读档在房间工作区里：加入时上报实际目录和房间工作区，规则写明当前工作目录", async () => {
    let roomOptions: ConstructorParameters<typeof RoomClient>[0] | undefined;
    bridge = new AgentBridge(
      {
        ...identity,
        persona: "p",
        provider: "claude",
        token: "t",
        access: "read-only",
        cwd: directory,
        roomWorkspace: "~/proj",
        tuning: { batchWindowMs: 20 },
      },
      store,
      responder,
      () => undefined,
      (options, handlers) => {
        roomOptions = options;
        room.handlers = handlers;
        return room as unknown as RoomClient;
      },
    );
    await bridge.start();
    await room.handlers.onSnapshot({ self, latestSeq: 0, messages: [], participants: [self] });
    expect(roomOptions?.workspace).toEqual({ cwd: directory, roomWorkspace: "~/proj" });
    const input = await completePromptTurn();
    expect(input.instructions).toContain("本房间工作区：~/proj");
    expect(input.instructions).toContain(`你当前的工作目录：${directory}（只读`);
  });

  it("被房主暂停：只记一次日志、不离开房间，恢复加入后再记一次", async () => {
    const logs: string[] = [];
    const onArchived = vi.fn();
    bridge = new AgentBridge(
      { ...identity, persona: "p", provider: "codex", token: "t", onArchived },
      store,
      responder,
      (line) => logs.push(line),
      (_options, handlers) => {
        room.handlers = handlers;
        return room as unknown as RoomClient;
      },
    );
    // 冷启动时正处于暂停：加入前的步骤不需要访客凭证，start 照常完成
    await bridge.start();
    const paused = new RoomClientError("SESSION_PAUSED: paused", "SESSION_PAUSED");
    for (let attempt = 0; attempt < 5; attempt += 1) room.handlers.onError(paused);
    expect(logs.filter((line) => line.includes("SESSION_PAUSED"))).toEqual([]);
    expect(logs.filter((line) => line.includes("已被房主暂停"))).toHaveLength(1);
    expect(onArchived).not.toHaveBeenCalled();
    await room.handlers.onSnapshot({ self, latestSeq: 0, messages: [], participants: [self] });
    expect(logs.filter((line) => line.includes("房主已恢复"))).toHaveLength(1);
    // 再次暂停又会提示一次
    room.handlers.onError(paused);
    expect(logs.filter((line) => line.includes("已被房主暂停"))).toHaveLength(2);
    // 真被移除才离开
    room.handlers.onError(new RoomClientError("SESSION_REVOKED: revoked", "SESSION_REVOKED"));
    expect(onArchived).toHaveBeenCalledTimes(1);
  });

  it("工作区档没有系统沙箱：加入时上报 noSandbox，规则如实说明", async () => {
    let roomOptions: ConstructorParameters<typeof RoomClient>[0] | undefined;
    bridge = new AgentBridge(
      {
        ...identity,
        persona: "p",
        provider: "claude",
        token: "t",
        access: "workspace",
        cwd: directory,
        noSandbox: true,
        tuning: { batchWindowMs: 20 },
      },
      store,
      responder,
      () => undefined,
      (options, handlers) => {
        roomOptions = options;
        room.handlers = handlers;
        return room as unknown as RoomClient;
      },
    );
    await bridge.start();
    await room.handlers.onSnapshot({ self, latestSeq: 0, messages: [], participants: [self] });
    expect(roomOptions?.workspace).toEqual({ cwd: directory, noSandbox: true });
    const input = await completePromptTurn();
    expect(input.instructions).toContain("这台电脑上没有系统沙箱");
    expect(input.instructions).not.toContain("绕过沙箱");
  });

  it("只读档也给附件准备本地路径：Hive 工具连不上时 Agent 仍能用读文件工具看图", async () => {
    const body = "PNG-BYTES";
    const attachment = {
      id: "6f1d2c3b-1111-4222-8333-444455556666",
      name: "截图.png",
      mime: "image/png",
      size: Buffer.byteLength(body),
      kind: "image" as const,
      sha256: createHash("sha256").update(body).digest("hex"),
    };
    const fetchMock = vi.fn(async (input: URL | string) =>
      new URL(String(input)).pathname === `/api/attachments/${attachment.id}`
        ? new Response(body)
        : new Response("{}", { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      bridge = new AgentBridge(
        {
          ...identity,
          persona: "p",
          provider: "claude",
          token: "t",
          access: "read-only",
          attachmentCacheDir: path.join(directory, "attachments"),
          tuning: { batchWindowMs: 20 },
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
      await room.handlers.onSnapshot({ self, latestSeq: 0, messages: [], participants: [self] });
      const mention = chat({ attachments: [attachment] });
      room.messages.push(mention);
      room.handlers.onMention(mention, mention.seq, false);
      await waitUntil(() => responder.calls.length === 1);
      const input = responder.calls[0]!;
      const cached = path.join(directory, "attachments", attachment.sha256, "截图.png");
      expect(input.prompt).toContain(`本地路径：${cached}`);
      expect(await readFile(cached, "utf8")).toBe(body);
      responder.finish("完成");
      await waitUntil(() => room.statuses(mention.id).includes("completed"));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("运行时报 Hive 工具连不上时转告房间（去掉本机用户目录），连上后也转告", async () => {
    bridge = new AgentBridge(
      { ...identity, persona: "p", provider: "claude", token: "t", tuning: { batchWindowMs: 20 } },
      store,
      responder,
      () => undefined,
      (_options, handlers) => {
        room.handlers = handlers;
        return room as unknown as RoomClient;
      },
    );
    await bridge.start();
    await room.handlers.onSnapshot({ self, latestSeq: 0, messages: [], participants: [self] });
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    const input = responder.calls[0]!;
    input.onHiveTools?.("unavailable", `连不上 ${homedir()}/x\n第二行`);
    input.onHiveTools?.("connected");
    expect(room.hiveTools).toEqual([
      { hive: "unavailable", detail: "连不上 ~/x 第二行" },
      { hive: "connected" },
    ]);
    responder.finish("完成");
    await waitUntil(() => room.statuses(mention.id).includes("completed"));
  });

  it("compact receipts still deliver the full result to the responder", async () => {
    const result = chat({
      senderType: "agent",
      senderName: "worker",
      content: "结果".repeat(3000) + "末尾验证",
    });
    const receipt = chat({
      senderType: "agent",
      senderName: "worker",
      kind: "receipt",
      content: "@agent-a 子任务回执 · 结果见 #1",
      text: { key: "receipt.compact", params: { seq: result.seq, resultMessageId: result.id } },
    });
    room.messages.push(result, receipt);
    await startBridge();
    room.handlers.onMention(receipt, receipt.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    expect(responder.calls[0]?.prompt).toContain(result.content);
    responder.finish();
    await waitUntil(() => room.statuses(receipt.id).includes("completed"));
  });

  it("回答隔了很久才到：提问早于本轮上下文时补拉原文并标注回答哪一问", async () => {
    const question = chat({
      senderType: "agent",
      senderName: "agent-a",
      kind: "question",
      content: "@Alice ❓ 群-351 选哪种做法？",
      mentions: ["Alice"],
    });
    const chatter = chat({ content: "接管一直闪", mentions: [] });
    const answer = chat({
      content: "其它：这个问题是谁提出来的啊?",
      mentions: [],
      replyToMessageId: question.id,
      answer: {
        questionMessageId: question.id,
        questionSeq: question.seq,
        selected: [],
        other: "这个问题是谁提出来的啊?",
      },
    });
    room.messages.push(question, chatter, answer);
    // 提问在上次处理过的序号之前：本轮上下文里没有它
    await startBridge({ ...baseState(), lastProcessedSeq: question.seq });
    room.handlers.onMention(answer, answer.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    const prompt = responder.calls[0]!.prompt;
    expect(prompt).toContain(
      `[回答提问] 这是 Alice 对 #${question.seq} id=${question.id} 提问（agent-a 提的）的回答`,
    );
    expect(prompt).toContain("群-351 选哪种做法");
    responder.finish();
    await waitUntil(() => room.statuses(answer.id).includes("completed"));
  });

  it("hands off only after the setup turn ends, with a new cwd, session and full context", async () => {
    const checkout = path.join(directory, "checkout");
    const isolated = new ControlledResponder();
    let selected: string | undefined = undefined;
    const close = vi.fn(async () => undefined);
    responder.close = close;
    const factory = vi.fn(() => isolated);
    taskWorkspace = { resolve: async () => selected, responder: factory };
    await startBridge({ ...baseState(), workspace: directory, threadId: "old-thread" });
    const message = chat();
    room.messages.push(message);
    room.handlers.onMention(message, message.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    expect(responder.calls[0]?.threadId).toBe("old-thread");
    for (const name of [
      "hive.hive_room_read",
      "hive.hive_worktree_list",
      "hive.hive_message_send",
      "hive.hive_worktree_create",
      "hive.hive_board_update",
    ]) {
      responder.calls[0]?.onTrace?.({
        id: name,
        kind: "tool",
        tool: "collaboration",
        name,
        ...(name === "hive.hive_message_send" ? { hiveProgress: true as const } : {}),
        startedAt: new Date().toISOString(),
      });
    }
    selected = checkout;
    expect(close).not.toHaveBeenCalled();
    responder.finish("Created checkout; no files edited", "old-thread");
    await waitUntil(() => isolated.calls.length === 1);
    expect(close).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith(checkout);
    expect(isolated.calls[0]?.threadId).toBeUndefined();
    expect(isolated.calls[0]?.instructions).toContain(checkout);
    expect(isolated.calls[0]?.prompt).toContain("Created checkout; no files edited");
    expect(isolated.calls[0]?.prompt).toContain("不要重放原任务");
    expect(room.sent).toHaveLength(0);
    isolated.finish("Finished in isolated checkout", "isolated-thread");
    await waitUntil(() => room.statuses(message.id).includes("completed"));
    expect(room.sent.map((item) => item.content)).toEqual(["Finished in isolated checkout"]);
    expect(await store.load()).toMatchObject({ workspace: checkout, threadId: "isolated-thread" });
    const followup = chat({ content: "@agent-a review fixes" });
    room.messages.push(followup);
    room.handlers.onMention(followup, followup.seq, false);
    await waitUntil(() => isolated.calls.length === 2);
    expect(isolated.calls[1]?.threadId).toBe("isolated-thread");
    isolated.finish();
    await waitUntil(() => room.statuses(followup.id).includes("completed"));
  });

  it("parks the session when moving to another task directory and picks it up again on return", async () => {
    const checkout = path.join(directory, "checkout");
    let selected: string | undefined = checkout;
    taskWorkspace = { resolve: async () => selected, responder: () => responder };
    await startBridge({ ...baseState(), workspace: directory, threadId: "room-thread" });

    // 进任务目录：开新会话，原来房间工作区那段先收起来
    const first = chat({ content: "@agent-a fix the bug" });
    room.messages.push(first);
    room.handlers.onMention(first, first.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    expect(responder.calls[0]?.threadId).toBeUndefined();
    responder.finish("fixed", "task-thread");
    await waitUntil(() => room.statuses(first.id).includes("completed"));
    expect((await store.load())?.parkedSessions).toMatchObject([
      { workspace: directory, threadId: "room-thread" },
    ]);

    // 回到房间工作区：接回原来那段，并说明中间在别的目录处理过哪些消息
    selected = undefined;
    const second = chat({ content: "@agent-a what next?" });
    room.messages.push(second);
    room.handlers.onMention(second, second.seq, false);
    await waitUntil(() => responder.calls.length === 2);
    expect(responder.calls[1]?.threadId).toBe("room-thread");
    expect(responder.calls[1]?.prompt).toContain("已接回");
    expect(responder.calls[1]?.prompt).toMatch(/hive_room_read\(\{"afterSeq":\d+\}\)/);
    responder.finish("next", "room-thread");
    await waitUntil(() => room.statuses(second.id).includes("completed"));

    // 返修回到同一个任务目录：接着那件活的会话
    selected = checkout;
    const third = chat({ content: "@agent-a one more fix" });
    room.messages.push(third);
    room.handlers.onMention(third, third.seq, false);
    await waitUntil(() => responder.calls.length === 3);
    expect(responder.calls[2]?.threadId).toBe("task-thread");
    responder.finish("done", "task-thread");
    await waitUntil(() => room.statuses(third.id).includes("completed"));
    const state = await store.load();
    expect(state).toMatchObject({ workspace: checkout, threadId: "task-thread" });
    expect(state?.parkedSessions?.map((item) => item.threadId)).toEqual(["room-thread"]);
  });

  it("runs a delegated subtask in its own session lane and keeps the room session", async () => {
    await startBridge({ ...baseState(), threadId: "room-thread" });
    const mention = (content: string, laneKey?: string) => {
      const message = chat({ content });
      room.messages.push(message);
      room.handlers.onMention(
        message,
        message.seq,
        false,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        laneKey,
      );
      return message;
    };

    // 子任务：开一段单独的新会话，并说明它看不到房间主对话
    const task = mention("@agent-a part 1", "lane-1");
    await waitUntil(() => responder.calls.length === 1);
    expect(responder.calls[0]?.threadId).toBeUndefined();
    expect(responder.calls[0]?.prompt).toContain("单独开的新对话");
    responder.finish("part 1 done", "sub-thread");
    await waitUntil(() => room.statuses(task.id).includes("completed"));
    expect(await store.load()).toMatchObject({ lane: "lane-1", threadId: "sub-thread" });

    // 房间里的人 @：回到主对话那一段
    const ask = mention("@agent-a status?");
    await waitUntil(() => responder.calls.length === 2);
    expect(responder.calls[1]?.threadId).toBe("room-thread");
    expect(responder.calls[1]?.prompt).not.toContain("单独开的新对话");
    responder.finish("fine", "room-thread");
    await waitUntil(() => room.statuses(ask.id).includes("completed"));
    const state = await store.load();
    expect(state?.lane).toBeUndefined();
    expect(state?.parkedSessions).toMatchObject([{ lane: "lane-1", threadId: "sub-thread" }]);

    // 同一件子任务的返修：接回子任务那一段，并说明中间漏看的消息怎么补读
    const rework = mention("@agent-a fix part 1", "lane-1");
    await waitUntil(() => responder.calls.length === 3);
    expect(responder.calls[2]?.threadId).toBe("sub-thread");
    expect(responder.calls[2]?.prompt).toContain("子任务时的那段对话");
    responder.finish("fixed", "sub-thread");
    await waitUntil(() => room.statuses(rework.id).includes("completed"));
  });

  it("renews a long room session between tasks and hands over a rule-built summary", async () => {
    const earlier = chat({ content: "@agent-a 做登录页" });
    const myReply = chat({
      content: "登录页做好了，提交 abc123",
      senderId: SELF,
      senderName: "agent-a",
      senderType: "agent",
      mentions: [],
    });
    room.messages.push(earlier, myReply);
    await startBridge({
      ...baseState(),
      lastProcessedSeq: myReply.seq,
      threadId: "room-thread",
      sessionStats: { threadId: "room-thread", contextTokens: 250_000, turns: 12 },
    });
    const ask = chat({ content: "@agent-a 再做注册页" });
    room.messages.push(ask);
    room.handlers.onMention(ask, ask.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    expect(responder.calls[0]?.threadId).toBeUndefined();
    const prompt = responder.calls[0]?.prompt ?? "";
    expect(prompt).toContain("房间主对话的一段新会话");
    expect(prompt).toContain(`#${earlier.seq} [Alice] @agent-a 做登录页`);
    expect(prompt).toContain("提交 abc123");
    expect(
      room.reports
        .filter((report) => report.messageId === ask.id)
        .map((report) => report.progress ?? "")
        .join("\n"),
    ).toContain("换了一段新对话");
    responder.finish("注册页开工", "fresh-thread", {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      requests: 1,
      peakContextTokens: 30_000,
      peakCacheWriteTokens: 0,
    } as AgentReply["usage"]);
    await waitUntil(() => room.statuses(ask.id).includes("completed"));
    expect((await store.load())?.sessionStats).toMatchObject({
      threadId: "fresh-thread",
      contextTokens: 30_000,
    });
  });

  it("does not renew the room session for a receipt", async () => {
    await startBridge({
      ...baseState(),
      threadId: "room-thread",
      sessionStats: { threadId: "room-thread", contextTokens: 900_000, turns: 30 },
    });
    const receipt = chat({ kind: "receipt", content: "@agent-a 📬 子任务回执" });
    room.messages.push(receipt);
    room.handlers.onMention(receipt, receipt.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    expect(responder.calls[0]?.threadId).toBe("room-thread");
    responder.finish();
    await waitUntil(() => room.statuses(receipt.id).includes("completed"));
  });

  it("keeps a single session when HIVE_TASK_LANES=0", async () => {
    vi.stubEnv("HIVE_TASK_LANES", "0");
    try {
      await startBridge({ ...baseState(), threadId: "room-thread" });
      const message = chat({ content: "@agent-a part 1" });
      room.messages.push(message);
      room.handlers.onMention(
        message,
        message.seq,
        false,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "lane-1",
      );
      await waitUntil(() => responder.calls.length === 1);
      expect(responder.calls[0]?.threadId).toBe("room-thread");
      responder.finish("ok", "room-thread");
      await waitUntil(() => room.statuses(message.id).includes("completed"));
      expect((await store.load())?.lane).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("does not pick up a parked session after a new topic started", async () => {
    const checkout = path.join(directory, "checkout");
    let selected: string | undefined = checkout;
    taskWorkspace = { resolve: async () => selected, responder: () => responder };
    await startBridge({ ...baseState(), workspace: directory, threadId: "room-thread" });
    const first = chat({ content: "@agent-a fix the bug" });
    room.messages.push(first);
    room.handlers.onMention(first, first.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    responder.finish("fixed", "task-thread");
    await waitUntil(() => room.statuses(first.id).includes("completed"));

    room.messages.push(chat({ kind: "topic", content: "新话题", mentions: [] }));
    selected = undefined;
    const second = chat({ content: "@agent-a fresh start" });
    room.messages.push(second);
    room.handlers.onMention(second, second.seq, false);
    await waitUntil(() => responder.calls.length === 2);
    expect(responder.calls[1]?.threadId).toBeUndefined();
    expect(responder.calls[1]?.prompt).not.toContain("已接回");
    responder.finish("ok", "fresh-thread");
    await waitUntil(() => room.statuses(second.id).includes("completed"));
    expect((await store.load())?.parkedSessions).toBeUndefined();
  });

  it.each([
    ["write", "write"],
    ["collaboration", "hive.hive_message_send"],
    ["collaboration", "hive.hive_ask_human"],
    ["collaboration", "hive.hive_invoke"],
    ["collaboration", "evil.hive_worktree_create"],
    ["command", "exec"],
  ] as const)(
    "still hands off after a %s side effect from %s, listing it for the new session",
    async (tool, name) => {
      const isolated = new ControlledResponder();
      let selected: string | undefined = undefined;
      taskWorkspace = { resolve: async () => selected, responder: () => isolated };
      await startBridge(baseState());
      const message = chat();
      room.messages.push(message);
      room.handlers.onMention(message, message.seq, false);
      await waitUntil(() => responder.calls.length === 1);
      responder.calls[0]?.onTrace?.({
        id: "write",
        kind: "tool",
        tool,
        name,
        summary: "write original checkout",
        startedAt: new Date().toISOString(),
      });
      selected = path.join(directory, "checkout");
      responder.finish("Original checkout changed; worktree prepared");
      // 不再拦下报失败：切到新目录接着做，把原目录里做过的改动交给新会话核对、别重复
      await waitUntil(() => isolated.calls.length === 1);
      expect(room.statuses(message.id)).not.toContain("failed");
      expect(isolated.calls[0]!.prompt).toContain("write original checkout");
      expect(isolated.calls[0]!.prompt).toContain("已经做过的不要重复");
      expect(await store.load()).toMatchObject({ workspace: selected });
      isolated.finish();
      await waitUntil(() => room.statuses(message.id).includes("completed"));
    },
  );

  it("keeps going in the same session when the requested worktree is already the current directory", async () => {
    taskWorkspace = { resolve: async () => undefined, responder: () => responder };
    await startBridge(baseState());
    const message = chat();
    room.messages.push(message);
    room.handlers.onMention(message, message.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    responder.calls[0]?.onTrace?.({
      id: "wt",
      kind: "tool",
      tool: "collaboration",
      name: "mcp__hive__hive_worktree_create",
      summary: "hive_worktree_create",
      startedAt: new Date().toISOString(),
    });
    // 复用的任务目录就是当前目录：按 runtimeHandoff 结束准备回合后，没有可切换的
    responder.finish("准备好了，等 Bridge 交接", "same-session");
    await waitUntil(() => responder.calls.length === 2);
    expect(responder.calls[1]!.threadId).toBe("same-session");
    expect(responder.calls[1]!.prompt).toContain("不需要切换");
    responder.finish("做完了", "same-session");
    await waitUntil(() => room.statuses(message.id).includes("completed"));
    expect(responder.calls).toHaveLength(2);
  });

  it("tells the agent and the task card when its last task workspace was not reused", async () => {
    const notice = {
      kind: "focus_dropped" as const,
      path: "/repo-wt/agent-a-slow-ops",
      reason: "任务目录 /repo-wt/agent-a-slow-ops 登记的分支是 feat/a，现在却在 feat/b",
    };
    taskWorkspace = {
      resolve: async (messageId, onNotice) => {
        onNotice?.(messageId, notice);
        return undefined;
      },
      responder: () => responder,
    };
    await startBridge(baseState());
    const message = chat();
    room.messages.push(message);
    room.handlers.onMention(message, message.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    const prompt = responder.calls[0]!.prompt;
    expect(prompt).toContain("你上次用的任务目录 /repo-wt/agent-a-slow-ops 不能再用");
    expect(prompt).toContain("现在却在 feat/b");
    expect(prompt).toContain("先用 hive_worktree_create 以新的 slug 建任务目录");
    expect(prompt).toContain("不要在默认工作目录里改代码");
    expect(
      room.reports.find(
        (report) =>
          report.messageId === message.id &&
          report.detailText?.key === "bridge.worktreeFocusDropped",
      ),
    ).toMatchObject({
      status: "running",
      detailText: { params: { path: notice.path, reason: notice.reason } },
    });
    responder.finish("ok");
    await waitUntil(() => room.statuses(message.id).includes("completed"));
    // 说明只用一次：下一条任务没有新的说明就不再提
    const next = chat();
    room.messages.push(next);
    taskWorkspace.resolve = async () => undefined;
    room.handlers.onMention(next, next.seq, false);
    await waitUntil(() => responder.calls.length === 2);
    expect(responder.calls[1]!.prompt).not.toContain("不能再用");
    responder.finish("ok");
    await waitUntil(() => room.statuses(next.id).includes("completed"));
  });

  it("finishes a cleaned task without a provider call and still runs the next unrelated task", async () => {
    const { TaskWorkspaceRemovedError } = await import("./task-workspace.js");
    const removed = chat();
    taskWorkspace = {
      resolve: async (id) =>
        id === removed.id ? new TaskWorkspaceRemovedError("/removed") : undefined,
      responder: () => responder,
    };
    await startBridge(baseState());
    room.messages.push(removed);
    room.handlers.onMention(removed, removed.seq, false);
    const next = chat({ seq: removed.seq + 1 });
    room.messages.push(next);
    room.handlers.onMention(next, next.seq, false);
    await waitUntil(() => room.statuses(removed.id).includes("completed"));
    expect(room.statuses(removed.id)).not.toContain("failed");
    expect(
      room.reports.find(
        (report) => report.messageId === removed.id && report.status === "completed",
      )?.detailText?.key,
    ).toBe("bridge.worktreeCleaned");
    await waitUntil(() => responder.calls.length === 1);
    expect(room.sent).toEqual([]);
    responder.finish();
    await waitUntil(() => room.statuses(next.id).includes("completed"));
    expect((await store.load())?.processedMessageIds).toContain(removed.id);
  });

  it("finishes the turn normally when the post-turn workspace check waits out a Server restart", async () => {
    // 合入后 Server 自动重启：这一轮跑完去复核任务目录时 Bridge 还没重连上，Server 先回 401
    const { resolveTaskWorkspace } = await import("./task-workspace.js");
    const hive = { serverUrl: "http://hive", roomId: "general", username: "writer", token: "t" };
    let clock = 0;
    const retry = {
      attempts: 3,
      timeoutMs: 50,
      delaysMs: [2_000, 4_000],
      reconnectMs: 60_000,
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms;
      },
    };
    let turnDone = false;
    const fetch = vi.fn(async () =>
      fetch.mock.calls.length <= 2
        ? Response.json({ error: "Online local agent required" }, { status: 401 })
        : Response.json({ worktree: null }),
    );
    taskWorkspace = {
      resolve: async (id) => {
        if (!turnDone) return undefined;
        vi.stubGlobal("fetch", fetch);
        try {
          return await resolveTaskWorkspace(hive, id, retry);
        } finally {
          vi.unstubAllGlobals();
        }
      },
      responder: () => responder,
    };
    await startBridge(baseState());
    const message = chat();
    room.messages.push(message);
    room.handlers.onMention(message, message.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    turnDone = true;
    responder.finish("done");
    await waitUntil(() => room.statuses(message.id).includes("completed"));
    expect(room.statuses(message.id)).not.toContain("uncertain");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("refuses to run when the managed workspace cannot be verified", async () => {
    taskWorkspace = {
      resolve: async () => {
        throw new AgentNonRetryableError("checkout identity changed");
      },
      responder: () => responder,
    };
    await startBridge(baseState());
    const message = chat();
    room.messages.push(message);
    room.handlers.onMention(message, message.seq, false);
    await waitUntil(() => room.statuses(message.id).includes("failed"));
    expect(responder.calls).toHaveLength(0);
  });

  /**
   * 失败分三类，逐个抛点核对：最终上报的状态与文案键（网页按键归类、给按钮写后果说明），
   * 以及暂时性失败有没有自动重试、不安全的有没有拦在执行之前。
   */
  describe("failure classes by throw site", () => {
    type Scenario = {
      site: string;
      /** 触发这个抛点，返回触发消息 */
      run: () => Promise<ChatMessage>;
      status: InvocationReport["status"];
      key: string;
      /** 交给运行时执行的次数（暂时性失败会自动重试） */
      calls?: number;
    };

    async function mention(): Promise<ChatMessage> {
      await startBridge(baseState());
      const message = chat();
      room.messages.push(message);
      room.handlers.onMention(message, message.seq, false);
      return message;
    }

    const settled = (message: ChatMessage) =>
      room.statuses(message.id).some((status) => ["failed", "uncertain"].includes(status));

    /** 运行时直接抛出 error（Codex 客户端里的各个抛点）；暂时性失败自动重试时每次都抛 */
    function runtimeThrows(error: () => Error) {
      return async () => {
        const message = await mention();
        for (let call = 1; !settled(message); call += 1) {
          await waitUntil(() => responder.calls.length === call || settled(message));
          if (!settled(message)) responder.fail(error());
          await waitUntil(() => settled(message) || responder.calls.length > call);
        }
        return message;
      };
    }

    /** 回合跑完后复核任务目录这一步出错 */
    function afterTurn(resolve: (id: string) => Promise<string | undefined>) {
      return async () => {
        let turnDone = false;
        taskWorkspace = {
          resolve: async (id) => (turnDone ? resolve(id) : undefined),
          responder: () => responder,
        };
        const message = await mention();
        await waitUntil(() => responder.calls.length === 1);
        turnDone = true;
        responder.finish("done");
        return message;
      };
    }

    const scenarios: Scenario[] = [
      {
        site: "task-workspace unsafe(): checkout identity changed before the turn",
        run: async () => {
          taskWorkspace = {
            resolve: async () => {
              throw new AgentNonRetryableError("checkout identity changed");
            },
            responder: () => responder,
          };
          return mention();
        },
        status: "failed",
        key: "bridge.unsafe",
        calls: 0,
      },
      {
        site: "task-workspace lookup(): Server busy before the turn",
        run: async () => {
          const { TaskWorkspaceBusyError } = await import("./task-workspace.js");
          taskWorkspace = {
            resolve: async () => {
              throw new TaskWorkspaceBusyError("Hive Server is busy (503) (after 3 attempts)");
            },
            responder: () => responder,
          };
          return mention();
        },
        status: "failed",
        key: "bridge.worktreeBusy",
        calls: 0,
      },
      {
        site: "codexStartupFailure(): handshake timeout (AgentTransientError)",
        run: runtimeThrows(
          () => new AgentTransientError("Codex app-server initialize：握手或会话准备超时"),
        ),
        status: "failed",
        key: "bridge.transientFailed",
        calls: 3,
      },
      {
        site: "codexStartupFailure(): CLI missing / config (AgentNonRetryableError)",
        run: runtimeThrows(() => new AgentNonRetryableError("找不到 Codex 命令")),
        status: "failed",
        key: "bridge.unsafe",
        calls: 1,
      },
      {
        site: "Codex turn reported failed / interrupted (settled uncertain)",
        run: runtimeThrows(
          () =>
            new AgentExecutionUncertainError("Codex 回合已报告失败；可能已执行部分操作", {
              settled: true,
            }),
        ),
        status: "uncertain",
        key: "bridge.uncertain",
        calls: 1,
      },
      {
        site: "bridge: task workspace busy when re-checked after the turn",
        run: async () => {
          // 等 Server 恢复也有上限：一直忙就照旧判结果未知
          extraTuning = { offlineRetryMs: 30 };
          return afterTurn(async () => {
            const { TaskWorkspaceBusyError } = await import("./task-workspace.js");
            throw new TaskWorkspaceBusyError("Hive Server is busy (503)");
          })();
        },
        status: "uncertain",
        key: "bridge.uncertain",
        calls: 1,
      },
      {
        site: "bridge: task workspace unsafe when re-checked after the turn",
        run: afterTurn(async () => {
          throw new AgentNonRetryableError("checkout identity changed");
        }),
        status: "uncertain",
        key: "bridge.uncertain",
        calls: 1,
      },
      {
        site: "bridge: incomplete task workspace selection after the turn",
        run: async () => {
          let turnDone = false;
          taskWorkspace = {
            resolve: async () => undefined,
            resolveMany: async (ids) =>
              new Map(turnDone ? [] : ids.map((id) => [id, undefined] as const)),
            responder: () => responder,
          };
          const message = await mention();
          await waitUntil(() => responder.calls.length === 1);
          turnDone = true;
          responder.finish("done");
          return message;
        },
        status: "uncertain",
        key: "bridge.uncertain",
        calls: 1,
      },
      {
        site: "bridge: task workspace bindings changed during the turn",
        run: async () => {
          let turnDone = false;
          let second = "";
          taskWorkspace = {
            resolve: async (id) =>
              turnDone && id === second ? path.join(directory, "other") : undefined,
            responder: () => responder,
          };
          await startBridge(baseState());
          const first = chat();
          const next = chat();
          second = next.id;
          room.messages.push(first, next);
          room.handlers.onMention(first, first.seq, false);
          room.handlers.onMention(next, next.seq, false);
          await waitUntil(() => responder.calls.length === 1);
          turnDone = true;
          responder.finish("done");
          return first;
        },
        status: "uncertain",
        key: "bridge.uncertain",
        calls: 1,
      },
      {
        site: "bridge: more than one worktree handoff in a task",
        run: async () => {
          let selected: string | undefined;
          taskWorkspace = { resolve: async () => selected, responder: () => responder };
          const message = await mention();
          await waitUntil(() => responder.calls.length === 1);
          selected = path.join(directory, "one");
          responder.finish("prepared one");
          await waitUntil(() => responder.calls.length === 2);
          selected = path.join(directory, "two");
          responder.finish("prepared two");
          return message;
        },
        status: "failed",
        key: "bridge.unsafe",
        calls: 2,
      },
      {
        site: "bridge: steer into the active turn hits an unsafe workspace",
        run: async () => {
          let unsafe = false;
          taskWorkspace = {
            resolve: async () => {
              if (unsafe) throw new AgentNonRetryableError("checkout identity changed");
              return undefined;
            },
            responder: () => responder,
          };
          await mention();
          await waitUntil(() => responder.calls.length === 1);
          unsafe = true;
          const extra = chat();
          room.messages.push(extra);
          room.handlers.onMention(extra, extra.seq, false, true);
          return extra;
        },
        status: "failed",
        key: "bridge.unsafe",
        calls: 1,
      },
    ];

    it.each(scenarios)("$site → $status ($key)", async ({ run, status, key, calls }) => {
      const message = await run();
      await waitUntil(() => room.statuses(message.id).includes(status));
      const report = room.reports.find(
        (candidate) => candidate.messageId === message.id && candidate.status === status,
      );
      expect(report?.detailText?.key).toBe(key);
      // 原来的英文「confirm before …」不再直接给人看
      expect(report?.detail).not.toContain("confirm before");
      if (calls !== undefined) expect(responder.calls).toHaveLength(calls);
    });
  });

  it("retries a transient failure automatically and runs once it clears", async () => {
    const { TaskWorkspaceBusyError } = await import("./task-workspace.js");
    const retries = () => room.reports.filter((report) => report.progress).length;
    taskWorkspace = {
      // 自动重试两次之后 Server 不忙了
      resolve: async () => {
        if (retries() < 2) throw new TaskWorkspaceBusyError("Hive Server is busy (503)");
        return undefined;
      },
      responder: () => responder,
    };
    await startBridge(baseState());
    const message = chat();
    room.messages.push(message);
    room.handlers.onMention(message, message.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    expect(
      room.reports
        .filter((report) => report.messageId === message.id && report.progress)
        .map((report) => report.progress),
    ).toEqual([
      "暂时没成功，1 秒后自动重试（第 1/2 次）",
      "暂时没成功，1 秒后自动重试（第 2/2 次）",
    ]);
    expect(room.statuses(message.id)).not.toContain("failed");
    responder.finish();
    await waitUntil(() => room.statuses(message.id).includes("completed"));
  });

  it("treats a stop during the worktree handoff as stopped, not failed", async () => {
    const handoff: { selected?: string; messageId?: string } = {};
    taskWorkspace = {
      resolve: async () => {
        // 人在 Bridge 切目录这一刻点了停止
        if (handoff.selected && handoff.messageId) room.handlers.onCancel!(handoff.messageId);
        return handoff.selected;
      },
      responder: () => responder,
    };
    await startBridge(baseState());
    const message = chat();
    handoff.messageId = message.id;
    room.messages.push(message);
    room.handlers.onMention(message, message.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    handoff.selected = path.join(directory, "checkout");
    responder.finish("prepared");
    await waitUntil(() => room.statuses(message.id).includes("cancelled"));
    expect(room.statuses(message.id)).not.toContain("failed");
    expect(responder.calls).toHaveLength(1);
  });

  it("drops an old directory's thread when a saved task starts in another checkout", async () => {
    const isolated = new ControlledResponder();
    const checkout = path.join(directory, "checkout");
    taskWorkspace = { resolve: async () => checkout, responder: () => isolated };
    await startBridge({ ...baseState(), workspace: directory, threadId: "old-thread" });
    const message = chat();
    room.messages.push(message);
    room.handlers.onMention(message, message.seq, false);
    await waitUntil(() => isolated.calls.length === 1);
    expect(isolated.calls[0]?.threadId).toBeUndefined();
    isolated.finish();
    await waitUntil(() => room.statuses(message.id).includes("completed"));
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

  /** RoomClient 读请求到时限放弃时抛的错误（AbortSignal.timeout） */
  const requestTimeout = () =>
    new DOMException("The operation was aborted due to timeout", "TimeoutError");

  it("waits for a Server that is too slow to answer the catch-up after the reply", async () => {
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    // 模型已经给出结果，这时机器很忙、Server 在但答不上来：补拉回复前后的消息超时两次后恢复
    room.offlineError = requestTimeout;
    room.offlineCalls = 2;
    responder.finish("忙的时候做完的");
    await waitUntil(() => room.statuses(mention.id).includes("completed"));
    expect(room.sent).toEqual([expect.objectContaining({ content: "忙的时候做完的" })]);
    expect(responder.calls).toHaveLength(1);
    expect(room.statuses(mention.id)).not.toContain("failed");
  });

  it("waits for a Server that is too slow to answer when a turn starts instead of counting failed attempts", async () => {
    // 开工前拉这一轮的上下文就超时：还什么都没做，等 Server 回来再开工；
    // 不然负载高时每次 10 秒超时、三次就判失败，比不设时限一直等还糟
    await startBridge(baseState());
    room.offlineError = requestTimeout;
    room.offlineCalls = 2;
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    responder.finish("好了");
    await waitUntil(() => room.statuses(mention.id).includes("completed"));
    expect(room.reports.map((report) => report.progress ?? "").join("\n")).not.toMatch(/尝试失败/);
    expect(room.statuses(mention.id)).not.toContain("failed");
    expect(room.sent).toHaveLength(1);
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

  it("posts the final answer after an interim hive_message_send, but not a repeat or an acknowledgement", async () => {
    const run = async (final: string, sentContent: string) => {
      const calls = responder.calls.length;
      const mention = chat({ content: `@agent-a ${final}` });
      room.messages.push(mention);
      room.handlers.onMention(mention, mention.seq, false);
      await waitUntil(() => responder.calls.length === calls + 1);
      const interim = chat({
        senderId: SELF,
        senderName: "agent-a",
        senderType: "agent",
        content: sentContent,
        mentions: [],
        parentMessageId: mention.id,
      });
      room.messages.push(interim);
      responder.finish(final);
      await waitUntil(() => room.statuses(mention.id).includes("completed"));
      const completed = room.reports.find(
        (report) => report.messageId === mention.id && report.status === "completed",
      );
      return { interim, completed };
    };
    await startBridge(baseState());
    // 中途报了一句进度，最终的完整结论照常代发，并作为这一轮的回复
    const first = await run("全部修完，测试通过", "收到，开始做");
    expect(room.sent.at(-1)).toMatchObject({ content: "全部修完，测试通过" });
    expect(first.completed?.replyMessageId).toBe(room.messages.at(-1)!.id);
    // 最终输出和工具发过的一样：不重复发
    const sentBefore = room.sent.length;
    const second = await run("结论：已修复", "结论：已修复");
    expect(room.sent).toHaveLength(sentBefore);
    expect(second.completed?.replyMessageId).toBe(second.interim.id);
    // 只说一句已发送：不重复发
    const third = await run("已通过 hive_message_send 发送", "这是完整的答复");
    expect(room.sent).toHaveLength(sentBefore);
    expect(third.completed?.replyMessageId).toBe(third.interim.id);
  });

  it("hands a runtime approval request to the server and resolves it with the human's decision", async () => {
    await startBridge(baseState());
    const mention = chat({ content: "@agent-a 跑一下" });
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    const ask = responder.calls[0]!.requestApproval!;
    const first = ask({ tool: "Bash", summary: "curl example.com" });
    await waitUntil(() => room.approvalRequests.length === 1);
    expect(room.approvalRequests[0]).toMatchObject({
      messageId: mention.id,
      summary: "curl example.com",
    });
    room.handlers.onApprovalDecision?.(room.approvalRequests[0]!.requestId, true);
    await expect(first).resolves.toBe(true);
    // 这一轮被停止：等着的申请按拒绝
    const second = ask({ tool: "Bash", summary: "rm -rf x" });
    room.handlers.onCancel?.(mention.id);
    await expect(second).resolves.toBe(false);
    // 服务端不支持时直接拒绝，不干等
    room.approvalsSupported = false;
    await expect(ask({ tool: "Bash", summary: "x" })).resolves.toBe(false);
  });

  it("never takes a progress update as the turn's reply", async () => {
    await startBridge(baseState());
    const mention = chat({ content: "@agent-a 跑一遍全量测试" });
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    room.messages.push(
      chat({
        senderId: SELF,
        senderName: "agent-a",
        senderType: "agent",
        content: "全部通过",
        mentions: [],
        parentMessageId: mention.id,
        kind: "progress",
      }),
    );
    // 最终输出和进度一样，也照常作为回复发出
    responder.finish("全部通过");
    await waitUntil(() => room.statuses(mention.id).includes("completed"));
    expect(room.sent.at(-1)).toMatchObject({ content: "全部通过" });
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
    // 这里用的是 40 万 token 的会话：关掉主道自动换新，只看用量怎么记
    vi.stubEnv("HIVE_LANE_RENEW", "0");
    onTestFinished(() => vi.unstubAllEnvs());
    await startBridge(baseState());
    const usage = {
      inputTokens: 10,
      cacheWriteTokens: 400_000,
      cacheReadTokens: 0,
      outputTokens: 20,
      requests: 1,
      peakContextTokens: 400_010,
      peakCacheWriteTokens: 400_000,
      cacheWrite1hTokens: 0,
      firstRequestAt: "2026-10-31T10:00:00.000Z",
      lastRequestAt: "2026-10-31T10:06:00.000Z",
    };
    const first = chat();
    const second = chat({ senderName: "Bob", content: "@agent-a 还有这个" });
    room.messages.push(first, second);
    room.handlers.onMention(first, first.seq, false);
    room.handlers.onMention(second, second.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    responder.finish("好", "thread-1", usage, 2.2);
    await waitUntil(() => room.statuses(second.id).includes("completed"));
    const withUsage = room.reports.filter((report) => report.usage);
    expect(withUsage).toHaveLength(1);
    expect(withUsage[0]).toMatchObject({ messageId: first.id, status: "completed" });
    expect(withUsage[0]!.usage).toEqual({
      ...usage,
      reportedCostUsd: 2.2,
      session: "new",
      outcome: "completed",
      // 没有任何输出事件就结束：只有整轮耗时，没有首个输出时间
      turnMs: expect.any(Number),
      // 写的是 5 分钟缓存
      cacheTtlMs: 300_000,
    });

    const third = chat({ content: "@agent-a 再来" });
    room.messages.push(third);
    room.handlers.onMention(third, third.seq, false);
    await waitUntil(() => responder.calls.length === 2);
    // 自报费用是会话累计值，本轮只记差额；间隔按上轮最后一次请求到本轮第一次请求算，
    // 不把上一轮执行的 6 分钟算成空闲
    responder.finish(
      "好",
      "thread-1",
      {
        ...usage,
        firstRequestAt: "2026-10-31T10:06:10.000Z",
        lastRequestAt: "2026-10-31T10:07:00.000Z",
      },
      2.4,
    );
    await waitUntil(() => room.statuses(third.id).includes("completed"));
    const resumed = room.reports.find((report) => report.messageId === third.id && report.usage);
    expect(resumed?.usage).toMatchObject({
      session: "resumed",
      idleMs: 10_000,
      idleBasis: "request",
      // 上一轮观测到的是 5 分钟写入
      previousCacheTtlMs: 300_000,
    });
    expect(resumed?.usage?.reportedCostUsd).toBeCloseTo(0.2);
  });

  it("times the first runtime output and the whole turn from when the Bridge picked it up", async () => {
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const call = responder.calls[0]!;
    call.onTrace?.({ id: "t1", kind: "thinking", status: "running" });
    // 之后的输出不改变首个输出时间
    await new Promise((resolve) => setTimeout(resolve, 30));
    call.onProgress?.("还在做");
    responder.finish("好", "thread-1", {
      inputTokens: 1,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 1,
      requests: 1,
      peakContextTokens: 1,
      peakCacheWriteTokens: 0,
    });
    await waitUntil(() => room.statuses(mention.id).includes("completed"));
    const usage = room.reports.find((report) => report.usage)?.usage;
    expect(usage?.firstOutputMs).toBeGreaterThanOrEqual(25);
    expect(usage?.turnMs).toBeGreaterThanOrEqual((usage?.firstOutputMs ?? 0) + 25);
  });

  it("still records usage observed before a turn failed, once", async () => {
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    responder.calls[0]!.onUsage?.({
      inputTokens: 5,
      cacheWriteTokens: 1000,
      cacheReadTokens: 0,
      outputTokens: 3,
      requests: 1,
      peakContextTokens: 1005,
      peakCacheWriteTokens: 1000,
    });
    responder.fail(new AgentExecutionUncertainError("lost"));
    await waitUntil(() => room.statuses(mention.id).includes("uncertain"));
    const withUsage = room.reports.filter((report) => report.usage);
    expect(withUsage).toHaveLength(1);
    expect(withUsage[0]).toMatchObject({
      status: "uncertain",
      usage: { cacheWriteTokens: 1000, outcome: "uncertain", session: "new" },
    });
  });

  it.each([false, true])(
    "steers late mentions and falls back to queueing (managed=%s)",
    async (managed) => {
      if (managed) taskWorkspace = { resolve: async () => undefined, responder: () => responder };
      await startBridge(baseState());
      const first = chat();
      room.messages.push(first);
      room.handlers.onMention(first, first.seq, false);
      await waitUntil(() => responder.calls.length === 1);

      const late = chat({ content: "@agent-a 顺便看下 README" });
      room.messages.push(late);
      room.handlers.onMention(late, late.seq, false, true);
      await waitUntil(() => responder.steered.length === 1);
      await flush();
      expect(responder.steered[0]).toContain("README");
      expect(room.statuses(late.id)).toContain("running");
      expect(
        room.reports.find((report) => report.messageId === late.id && report.status === "running")
          ?.detail,
      ).toBe(`已并入当前任务（#${first.seq}）`);
      // 执行过程里标出引导
      expect(room.traces.some((trace) => trace.messageId === first.id)).toBe(true);

      responder.steerResult = false;
      const queued = chat({ content: "@agent-a 第三件事" });
      room.messages.push(queued);
      room.handlers.onMention(queued, queued.seq, false, true);
      await waitUntil(() => responder.steered.length === 2);

      responder.finish();
      await waitUntil(() => room.statuses(late.id).includes("completed"));
      // 注入失败的那条在下一轮单独处理
      await waitUntil(() => responder.calls.length === 2);
      expect(responder.calls[1]!.prompt).toContain("第三件事");
      expect(responder.calls[1]!.threadId).toBe("thread-1");
      responder.finish();
      await waitUntil(() => room.statuses(queued.id).includes("completed"));
    },
  );

  it.each(["unbound", "same checkout", "unbound steer"])(
    "batches and steers managed messages in %s",
    async (mode) => {
      const checkout = mode === "unbound" ? undefined : path.join(directory, "checkout");
      let unboundSteer: string | undefined;
      const resolve = vi.fn(async (id: string) => (id === unboundSteer ? undefined : checkout));
      const resolveMany = vi.fn<
        (
          ids: string[],
          sink?: unknown,
          options?: unknown,
        ) => Promise<Map<string, string | undefined>>
      >(async (ids) => new Map(ids.map((id) => [id, id === unboundSteer ? undefined : checkout])));
      taskWorkspace = { resolve, resolveMany, responder: () => responder };
      await startBridge(baseState());
      const first = chat();
      const second = chat({ content: "@agent-a also update tests" });
      room.messages.push(first, second);
      room.handlers.onMention(first, first.seq, false);
      room.handlers.onMention(second, second.seq, false);
      await waitUntil(() => responder.calls.length === 1);
      expect((await store.load())?.inflight?.messageIds).toEqual([first.id, second.id]);
      expect(resolveMany).toHaveBeenCalledOnce();
      expect(resolveMany).toHaveBeenCalledWith([first.id, second.id], expect.any(Function));
      expect(resolve).not.toHaveBeenCalled();
      const late = chat({ content: "@agent-a add one more assertion" });
      if (mode === "unbound steer") unboundSteer = late.id;
      room.messages.push(late);
      room.handlers.onMention(late, late.seq, false, true);
      await waitUntil(() => room.statuses(late.id).includes("running"));
      expect(responder.steered).toHaveLength(1);
      responder.finish();
      await waitUntil(() => room.statuses(late.id).includes("completed"));
      expect(room.statuses(first.id)).toContain("completed");
      expect(room.statuses(second.id)).toContain("completed");
      expect(responder.calls).toHaveLength(1);
      expect(resolve).toHaveBeenCalledOnce();
      expect(resolveMany).toHaveBeenCalledTimes(2);
      // 开工前选目录按「能不能开工」查；这一轮跑完后的复核带 settled，中途结束的消息不让整轮变成结果未知
      expect(resolveMany.mock.calls.map((call) => call.length)).toEqual([2, 3]);
      expect(resolveMany).toHaveBeenLastCalledWith(
        [first.id, second.id, late.id],
        expect.any(Function),
        {
          settled: true,
        },
      );
    },
  );

  it.each([
    {
      // 合入 main 后开发环境换代、Server 重启：连不上
      case: "unreachable",
      error: () => new TaskWorkspaceBusyError("fetch failed (after 3 attempts)"),
    },
    {
      // 故障单 3493d392 11-28 的现场：机器负载很高，Server 在、但 17 秒内答不上来，三次都超时
      case: "too slow to answer",
      error: () =>
        new TaskWorkspaceBusyError("The operation was aborted due to timeout (after 3 attempts)", {
          cause: new DOMException("The operation was aborted due to timeout", "TimeoutError"),
        }),
    },
    {
      case: "rate limited",
      error: () => new TaskWorkspaceBusyError("Hive Server is busy (429) (after 3 attempts)"),
    },
  ])(
    "waits for the Server when the post-turn workspace re-check finds it $case",
    async ({ error }) => {
      // 这一轮跑完去复核任务目录时 Server 暂时答不上：等它回来再复核，不判结果未知
      let turnDone = false;
      let offline = 2;
      const resolveMany = vi.fn(async (ids: string[]) => {
        if (turnDone && offline > 0) {
          offline -= 1;
          throw error();
        }
        return new Map(ids.map((id) => [id, undefined] as const));
      });
      taskWorkspace = { resolve: async () => undefined, resolveMany, responder: () => responder };
      await startBridge(baseState());
      const message = chat();
      room.messages.push(message);
      room.handlers.onMention(message, message.seq, false);
      await waitUntil(() => responder.calls.length === 1);
      turnDone = true;
      responder.finish("done");
      await waitUntil(() =>
        room
          .statuses(message.id)
          .some((status) => ["completed", "failed", "uncertain"].includes(status)),
      );
      expect(room.statuses(message.id)).toContain("completed");
      expect(room.statuses(message.id)).not.toContain("uncertain");
      expect(resolveMany).toHaveBeenCalledTimes(4);
      expect(responder.calls).toHaveLength(1);
    },
  );

  it("does not batch or steer messages across different managed checkouts", async () => {
    const first = chat();
    const second = chat({ content: "@agent-a unrelated task" });
    const same = chat({ content: "@agent-a refine the current task" });
    const paths = new Map([
      [first.id, path.join(directory, "first-checkout")],
      [same.id, path.join(directory, "first-checkout")],
      [second.id, path.join(directory, "second-checkout")],
    ]);
    const other = new ControlledResponder();
    taskWorkspace = {
      resolve: async (id) => paths.get(id),
      resolveMany: async (ids) => new Map(ids.map((id) => [id, paths.get(id)])),
      responder: (cwd) => (cwd === paths.get(second.id) ? other : responder),
    };
    await startBridge(baseState());
    room.messages.push(first, second);
    room.handlers.onMention(first, first.seq, false);
    room.handlers.onMention(second, second.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    expect((await store.load())?.inflight?.messageIds).toEqual([first.id]);
    room.handlers.onMention(second, second.seq, false, true);
    await waitUntil(() =>
      room.reports.some(
        (report) => report.messageId === second.id && report.detail?.includes("另一个工作目录"),
      ),
    );
    expect(responder.steered).toHaveLength(0);
    expect(other.calls).toHaveLength(0);
    room.messages.push(same);
    room.handlers.onMention(same, same.seq, false, true);
    await waitUntil(() => responder.steered.length === 1);
    responder.finish();
    await waitUntil(() => other.calls.length === 1);
    expect(other.calls[0]?.threadId).toBeUndefined();
    expect(other.calls[0]?.instructions).toContain(paths.get(second.id));
    expect(room.statuses(second.id)).not.toContain("completed");
    other.finish();
    await waitUntil(() => room.statuses(second.id).includes("completed"));
    expect(responder.calls).toHaveLength(1);
  });

  it("queues a managed steer that finishes resolving after the current turn ends", async () => {
    let resolveSteer!: (value: string | undefined) => void;
    const waiting = new Promise<string | undefined>((resolve) => {
      resolveSteer = resolve;
    });
    taskWorkspace = {
      resolve: () => waiting,
      resolveMany: async (ids) => new Map(ids.map((id) => [id, undefined])),
      responder: () => responder,
    };
    await startBridge(baseState());
    const first = chat();
    room.messages.push(first);
    room.handlers.onMention(first, first.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    const late = chat();
    room.messages.push(late);
    room.handlers.onMention(late, late.seq, false, true);
    responder.finish();
    await waitUntil(() => room.statuses(first.id).includes("completed"));
    resolveSteer(undefined);
    await waitUntil(() => responder.calls.length === 2);
    expect(responder.steered).toHaveLength(0);
    responder.finish();
    await waitUntil(() => room.statuses(late.id).includes("completed"));
  });

  it("queues a late mention by default and inserts it only when a human asks", async () => {
    await startBridge(baseState());
    const first = chat();
    room.messages.push(first);
    room.handlers.onMention(first, first.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    const late = chat({ content: "@agent-a 另一件事" });
    room.messages.push(late);
    room.handlers.onMention(late, late.seq, false);
    await flush();
    expect(responder.steered).toHaveLength(0);
    // 人点「引导」：从队里拿出来插进去
    room.handlers.onMention(late, late.seq, false, true);
    await waitUntil(() => responder.steered.length === 1);
    await waitUntil(() => room.statuses(late.id).includes("running"));
    responder.finish();
    await waitUntil(() => room.statuses(late.id).includes("completed"));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(responder.calls).toHaveLength(1);
  });

  it("runs a stop-and-switch message next, on its own, ahead of the rest of the queue", async () => {
    await startBridge(baseState());
    const first = chat();
    room.messages.push(first);
    room.handlers.onMention(first, first.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    const earlier = chat({ content: "@agent-a 早来的另一件事" });
    const urgent = chat({ content: "@agent-a 方向变了，改做这个" });
    room.messages.push(earlier, urgent);
    room.handlers.onMention(earlier, earlier.seq, false);
    room.handlers.onMention(urgent, urgent.seq, false);
    await flush();
    // 人点「停下当前，改做这条」：先排到队首，再停当前任务
    room.handlers.onMention(urgent, urgent.seq, false, false, true);
    room.handlers.onCancel!(first.id);
    await waitUntil(() => responder.calls.length === 2);
    // 只看这一轮要回应的触发消息（其它消息作为上下文出现是正常的）
    const triggers = (index: number) =>
      responder.calls[index]!.prompt.split("<trigger_message")[1] ?? "";
    expect(triggers(1)).toContain("改做这个");
    expect(triggers(1)).not.toContain("早来的另一件事");
    responder.finish();
    await waitUntil(() => responder.calls.length === 3);
    expect(triggers(2)).toContain("早来的另一件事");
    responder.finish();
  });

  it("explains why a steer request stayed queued when nothing is running", async () => {
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false, true);
    await waitUntil(() =>
      room.reports.some((report) => report.detail?.includes("没有正在执行、能引导的任务")),
    );
    await waitUntil(() => responder.calls.length === 1);
    responder.finish();
    await waitUntil(() => room.statuses(mention.id).includes("completed"));
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
    room.handlers.onMention(queued, queued.seq, false, true);
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
        mutated: true,
      },
    });
    await flush();
    expect(room.reports).toContainEqual(
      expect.objectContaining({
        messageId: pendingMention.id,
        status: "uncertain",
        detailText: { key: "bridge.crashedMidTurn" },
      }),
    );
    expect(responder.calls).toHaveLength(0);
    expect((await store.load())?.inflight).toBeUndefined();

    // 人在界面中重试：忽略"已处理"记录并重新执行
    room.handlers.onMention(pendingMention, pendingMention.seq, true);
    await waitUntil(() => responder.calls.length === 1);
    responder.finish();
    await waitUntil(() => room.statuses(pendingMention.id).includes("completed"));
  });

  describe("resuming after the bridge process dies mid-turn", () => {
    const invocationFor = (
      message: ChatMessage,
      status: Invocation["status"],
      extra: Partial<Invocation> = {},
    ): Invocation => ({
      id: message.id.replace(/0000$/, "ffff"),
      roomId: "general",
      messageId: message.id,
      agentId: SELF,
      agentName: "agent-a",
      status,
      attempts: 1,
      ...extra,
    });
    const crashed = (
      messageIds: string[],
      extra: Partial<NonNullable<AgentState["inflight"]>> = {},
    ) => ({
      executionId: "exec-crash",
      messageIds,
      startedAt: new Date().toISOString(),
      ...extra,
    });

    it("reruns a side-effect-free turn after a crash and says so on the card", async () => {
      const mention = chat();
      room.messages.push(mention);
      await startBridge({ ...baseState(), inflight: crashed([mention.id]) }, [
        invocationFor(mention, "running"),
      ]);
      await waitUntil(() => responder.calls.length === 1);
      // 不报结果未知，改为重新执行，并在状态和执行过程里写明是中断后自动恢复
      expect(room.statuses(mention.id)).not.toContain("uncertain");
      expect(room.reports).toContainEqual(
        expect.objectContaining({
          messageId: mention.id,
          status: "running",
          detailText: { key: "bridge.crashResumed", params: { count: 1, limit: 2 } },
        }),
      );
      expect(JSON.stringify(room.traces)).toContain("已自动重新执行（第 1/2 次）");
      expect(responder.calls[0]!.prompt).toContain("Agent 进程意外退出");
      expect((await store.load())?.crashResumes).toEqual({ [mention.id]: 1 });
      responder.finish();
      await waitUntil(() => room.statuses(mention.id).includes("completed"));
      expect(room.reports.at(-1)).toMatchObject({
        status: "completed",
        detailText: { key: "bridge.crashResumedDone", params: { count: 1 } },
      });
      const saved = await store.load();
      expect(saved?.crashResumes).toBeUndefined();
      expect(saved?.inflight).toBeUndefined();
      expect(saved?.processedMessageIds).toContain(mention.id);
    });

    it("keeps a crashed turn with side effects as uncertain, also on reconnect", async () => {
      const mention = chat();
      room.messages.push(mention);
      await startBridge({ ...baseState(), inflight: crashed([mention.id], { mutated: true }) }, [
        invocationFor(mention, "running"),
      ]);
      await flush();
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(responder.calls).toHaveLength(0);
      expect(room.reports).toEqual([
        expect.objectContaining({
          messageId: mention.id,
          status: "uncertain",
          detailText: { key: "bridge.crashedMidTurn" },
        }),
      ]);
      // 重连拿到新快照：服务端仍是 running，也不会再被当成可以重跑
      await room.handlers.onSnapshot({
        self,
        latestSeq: mention.seq,
        messages: [],
        participants: [self],
        invocations: [invocationFor(mention, "running")],
      });
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(responder.calls).toHaveLength(0);
    });

    it("continues a crashed turn with side effects in its own session, listing what it already did", async () => {
      const mention = chat();
      room.messages.push(mention);
      await startBridge(
        {
          ...baseState(),
          inflight: crashed([mention.id], {
            mutated: true,
            threadId: "session-crashed",
            steps: [
              { summary: "src/a.ts", done: true },
              { summary: "pnpm test", done: false },
            ],
          }),
        },
        [invocationFor(mention, "running")],
      );
      await waitUntil(() => responder.calls.length === 1);
      expect(responder.calls[0]!.threadId).toBe("session-crashed");
      expect(responder.calls[0]!.prompt).toContain("会话已接上");
      expect(responder.calls[0]!.prompt).toContain("src/a.ts");
      expect(responder.calls[0]!.prompt).toContain("pnpm test（可能没执行完）");
      responder.finish("做完了", "session-crashed");
      await waitUntil(() => room.statuses(mention.id).includes("completed"));
      expect(room.statuses(mention.id)).not.toContain("uncertain");
    });

    it("says it is a new session when the crash came right after creating a task worktree", async () => {
      const checkout = path.join(directory, "checkout");
      const isolated = new ControlledResponder();
      taskWorkspace = { resolve: async () => checkout, responder: () => isolated };
      const mention = chat();
      room.messages.push(mention);
      await startBridge(
        {
          ...baseState(),
          threadId: "orig-session",
          inflight: crashed([mention.id], {
            mutated: true,
            threadId: "orig-session",
            cwd: directory,
            steps: [{ summary: "hive_worktree_create", done: true }],
          }),
        },
        [invocationFor(mention, "running")],
      );
      await waitUntil(() => isolated.calls.length === 1);
      // 已经切到新任务目录、开了新会话：不能说「会话已接上」，要按交接的口径交代
      expect(isolated.calls[0]!.threadId).toBeUndefined();
      expect(isolated.calls[0]!.prompt).toContain("这是新会话");
      expect(isolated.calls[0]!.prompt).not.toContain("会话已接上");
      expect(isolated.calls[0]!.prompt).toContain(`在 ${directory} 执行过`);
      isolated.finish("做完了", "new-session");
      await waitUntil(() => room.statuses(mention.id).includes("completed"));
    });

    it("hands an irreversible step that was mid-flight back to a human instead of continuing", async () => {
      const mention = chat();
      room.messages.push(mention);
      await startBridge(
        {
          ...baseState(),
          inflight: crashed([mention.id], {
            mutated: true,
            threadId: "session-crashed",
            steps: [{ summary: "git push origin main", done: false, irreversible: true }],
          }),
        },
        [invocationFor(mention, "running")],
      );
      await flush();
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(responder.calls).toHaveLength(0);
      expect(room.statuses(mention.id)).toContain("uncertain");
    });

    it("continues the interrupted turn's own session when the human clicks continue", async () => {
      const mention = chat();
      room.messages.push(mention);
      await startBridge(
        {
          ...baseState(),
          threadId: "older-session",
          inflight: crashed([mention.id], {
            mutated: true,
            threadId: "crashed-session",
            steps: [{ summary: "git push origin main", done: false, irreversible: true }],
          }),
        },
        [invocationFor(mention, "running")],
      );
      await waitUntil(() => room.statuses(mention.id).includes("uncertain"));
      // 人确认后点「继续」：接上的是中断那一轮的会话，不是更早的旧会话
      room.handlers.onMention(mention, mention.seq, true, false, false, false, undefined, true);
      await waitUntil(() => responder.calls.length === 1);
      expect(responder.calls[0]!.threadId).toBe("crashed-session");
      responder.finish("做完了", "crashed-session");
      await waitUntil(() => room.statuses(mention.id).includes("completed"));
    });

    it("reports a still-running old runtime first, even after an earlier auto-resume", async () => {
      extraTuning = { runtimeExitGraceMs: 50 };
      const { spawn } = await import("node:child_process");
      const orphan = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
        stdio: "ignore",
      });
      try {
        const mention = chat();
        room.messages.push(mention);
        await startBridge(
          {
            ...baseState(),
            crashResumes: { [mention.id]: 1 },
            inflight: crashed([mention.id], { runtimePids: [orphan.pid!] }),
          },
          [invocationFor(mention, "running")],
        );
        await waitUntil(() => room.statuses(mention.id).includes("uncertain"));
        // 不能报成「已自动恢复过」（那个人能点继续），旧进程还活着继续会并行跑两份
        expect(room.reports.find((report) => report.status === "uncertain")?.detailText).toEqual({
          key: "bridge.crashedRuntimeAlive",
        });
      } finally {
        orphan.kill();
      }
    });

    it("names the irreversible step on the card and hands the steps to the continued turn", async () => {
      const mention = chat();
      room.messages.push(mention);
      await startBridge(
        {
          ...baseState(),
          inflight: crashed([mention.id], {
            mutated: true,
            threadId: "s1",
            steps: [{ summary: "git push origin main", done: false, irreversible: true }],
          }),
        },
        [invocationFor(mention, "running")],
      );
      await waitUntil(() => room.statuses(mention.id).includes("uncertain"));
      expect(room.reports.find((report) => report.status === "uncertain")?.detailText).toEqual({
        key: "bridge.crashedIrreversible",
        params: { step: "git push origin main" },
      });
      room.handlers.onMention(mention, mention.seq, true, false, false, false, undefined, true);
      await waitUntil(() => responder.calls.length === 1);
      expect(responder.calls[0]!.prompt).toContain("git push origin main（可能没执行完）");
      responder.finish("核对过了", "s1");
      await waitUntil(() => room.statuses(mention.id).includes("completed"));
    });

    it("delivers the stop report it could not send before exiting once the next process joins", async () => {
      const mention = chat();
      room.messages.push(mention);
      await startBridge(baseState(), [invocationFor(mention, "queued")]);
      room.handlers.onMention(mention, mention.seq, false);
      await waitUntil(() => responder.calls.length === 1);
      // Server 先断开（重启、换代），Agent 随后被结束：停止回报只能进 outbox，进程就退出了
      room.disconnected = true;
      await bridge.stop();
      expect(room.statuses(mention.id)).not.toContain("cancelled");
      // 下一个进程用落盘的状态加入：服务端那条调用还挂在执行中，要补上停止回报，不能等 10 分钟判结果未知
      room = new FakeRoom();
      responder = new ControlledResponder();
      await startBridge(undefined, [invocationFor(mention, "running")]);
      await waitUntil(() => room.statuses(mention.id).includes("cancelled"));
      expect(room.reports.find((report) => report.status === "cancelled")?.detailText).toEqual({
        key: "bridge.offline",
      });
      expect(responder.calls).toHaveLength(0);
      expect((await store.load())?.undeliveredReports).toBeUndefined();
    });

    it("drops a saved stop report when the server already settled or was told to retry", async () => {
      const settled = chat();
      const retried = chat();
      room.messages.push(settled, retried);
      await store.save({
        ...baseState(),
        lastProcessedSeq: retried.seq,
        processedMessageIds: [settled.id, retried.id],
        undeliveredReports: {
          [settled.id]: { messageId: settled.id, status: "cancelled" },
          [retried.id]: { messageId: retried.id, status: "cancelled" },
        },
      });
      // settled 不在快照里（早已落定）；retried 被人点了重试、重新排队
      await startBridge(undefined, [invocationFor(retried, "queued")]);
      await flush();
      expect(room.statuses(settled.id)).toEqual([]);
      expect(room.statuses(retried.id)).not.toContain("cancelled");
      expect((await store.load())?.undeliveredReports).toBeUndefined();
    });

    it("still reports reconnectedGone for a running call it knows nothing about", async () => {
      const mention = chat();
      room.messages.push(mention);
      await startBridge(baseState(), [invocationFor(mention, "running")]);
      await flush();
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(responder.calls).toHaveLength(0);
      expect(room.reports).toContainEqual(
        expect.objectContaining({
          messageId: mention.id,
          status: "uncertain",
          detailText: { key: "bridge.reconnectedGone" },
        }),
      );
    });

    it("gives up after the resume limit and says how many times it resumed", async () => {
      const mention = chat();
      room.messages.push(mention);
      await startBridge(
        {
          ...baseState(),
          crashResumes: { [mention.id]: 2 },
          inflight: crashed([mention.id]),
        },
        [invocationFor(mention, "running")],
      );
      await flush();
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(responder.calls).toHaveLength(0);
      expect(room.reports).toContainEqual(
        expect.objectContaining({
          messageId: mention.id,
          status: "uncertain",
          detail: expect.stringContaining("已自动恢复过 2 次"),
          detailText: { key: "bridge.crashedAfterResume", params: { count: 2 } },
        }),
      );
      expect((await store.load())?.crashResumes).toBeUndefined();
    });

    it("crashes again during the resumed run count towards the limit", async () => {
      extraTuning = { crashResumeLimit: 1 };
      const mention = chat();
      room.messages.push(mention);
      await startBridge({ ...baseState(), inflight: crashed([mention.id]) }, [
        invocationFor(mention, "running"),
      ]);
      await waitUntil(() => responder.calls.length === 1);
      // 重跑途中进程又退出：模拟直接丢掉这个 Bridge，用落盘的状态再起一个
      const saved = (await store.load())!;
      expect(saved.inflight?.messageIds).toEqual([mention.id]);
      expect(saved.crashResumes).toEqual({ [mention.id]: 1 });
      room.reports = [];
      responder = new ControlledResponder();
      await startBridge(undefined, [invocationFor(mention, "running")]);
      await flush();
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(responder.calls).toHaveLength(0);
      expect(room.reports).toContainEqual(
        expect.objectContaining({
          messageId: mention.id,
          status: "uncertain",
          detailText: { key: "bridge.crashedAfterResume", params: { count: 1 } },
        }),
      );
    });

    it("does not rerun while the old runtime process is still alive", async () => {
      extraTuning = { runtimeExitGraceMs: 50 };
      const { spawn } = await import("node:child_process");
      const orphan = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
        stdio: "ignore",
      });
      try {
        const mention = chat();
        room.messages.push(mention);
        await startBridge(
          { ...baseState(), inflight: crashed([mention.id], { runtimePids: [orphan.pid!] }) },
          [invocationFor(mention, "running")],
        );
        await flush();
        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(responder.calls).toHaveLength(0);
        expect(room.reports).toContainEqual(
          expect.objectContaining({
            messageId: mention.id,
            status: "uncertain",
            detailText: { key: "bridge.crashedRuntimeAlive" },
          }),
        );
      } finally {
        orphan.kill();
      }
    });

    it("leaves calls the human already stopped or dismissed alone", async () => {
      const stopped = chat();
      const dismissed = chat();
      const finished = chat();
      room.messages.push(stopped, dismissed, finished);
      await startBridge(
        { ...baseState(), inflight: crashed([stopped.id, dismissed.id, finished.id]) },
        [
          invocationFor(stopped, "cancelling"),
          invocationFor(dismissed, "timed_out", { resolution: { kind: "dismissed" } }),
          // 已经落定的调用不在快照里
        ],
      );
      await flush();
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(responder.calls).toHaveLength(0);
      expect(room.reports).toEqual([
        expect.objectContaining({
          messageId: stopped.id,
          status: "cancelled",
          detailText: { key: "bridge.crashResumeStopped" },
        }),
      ]);
      expect((await store.load())?.processedMessageIds).toEqual(
        expect.arrayContaining([stopped.id, dismissed.id, finished.id]),
      );
    });

    it("fetches the original text even when the cursor is already past it", async () => {
      const mention = chat({ content: "@agent-a 光标之前的提及" });
      const later = chat({ content: "别的消息", mentions: [] });
      room.messages.push(mention, later);
      await startBridge(
        {
          ...baseState(),
          lastProcessedSeq: later.seq,
          inflight: crashed([mention.id], { minSeq: mention.seq }),
        },
        [invocationFor(mention, "timed_out")],
      );
      await waitUntil(() => responder.calls.length === 1);
      expect(responder.calls[0]!.prompt).toContain("光标之前的提及");
    });

    it("does not start a second run when the human retries during the automatic one", async () => {
      const mention = chat();
      room.messages.push(mention);
      await startBridge({ ...baseState(), inflight: crashed([mention.id]) }, [
        invocationFor(mention, "running"),
      ]);
      await waitUntil(() => responder.calls.length === 1);
      room.handlers.onMention(mention, mention.seq, true);
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(responder.calls).toHaveLength(1);
      responder.finish();
      await waitUntil(() => room.statuses(mention.id).includes("completed"));
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(responder.calls).toHaveLength(1);
    });

    it("persists the first side effect of a turn, not read-only steps", async () => {
      await startBridge(baseState());
      const mention = chat();
      room.messages.push(mention);
      room.handlers.onMention(mention, mention.seq, false);
      await waitUntil(() => responder.calls.length === 1);
      const at = new Date().toISOString();
      responder.calls[0]!.onTrace?.({
        id: "r1",
        kind: "tool",
        tool: "command",
        summary: "git status",
        startedAt: at,
      });
      responder.calls[0]!.onTrace?.({
        id: "h1",
        kind: "tool",
        tool: "collaboration",
        name: "hive.hive_room_read",
        startedAt: at,
      });
      await flush();
      expect((await store.load())?.inflight?.mutated).toBeUndefined();
      responder.calls[0]!.onTrace?.({
        id: "w1",
        kind: "tool",
        tool: "write",
        summary: "src/a.ts",
        startedAt: at,
      });
      // 落盘是异步的：等它写完再读，别在负载高时读到上一版
      const saved = async () => (await store.load())?.inflight?.mutated === true;
      for (let i = 0; i < 100 && !(await saved()); i++) await flush();
      expect(await saved()).toBe(true);
      responder.finish();
      await waitUntil(() => room.statuses(mention.id).includes("completed"));
    });
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

  it("sends the trace steps still waiting to be batched before reporting the turn as done", async () => {
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    // 最后一段思考刚结束、还没到合批时间，回合就结束了
    responder.calls[0]!.onTrace?.({
      id: "th",
      kind: "thinking",
      status: "ok",
      text: "最后想到的",
      startedAt: new Date().toISOString(),
    });
    responder.finish("做完了");
    await waitUntil(() => room.statuses(mention.id).includes("completed"));
    expect(room.traces.at(-1)?.steps).toEqual([
      expect.objectContaining({ id: "th", text: "最后想到的" }),
    ]);
    expect(room.order.lastIndexOf("trace")).toBeLessThan(room.order.lastIndexOf("completed"));
  });

  /** 先跑完一轮，让 Bridge 记住会话 old-thread，再对下一条 @ 开始一轮（续接旧会话、只带新消息） */
  async function resumeTurn(): Promise<ChatMessage> {
    await completePromptTurn("old-thread");
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 2);
    expect(responder.calls[1]!.threadId).toBe("old-thread");
    expect(responder.calls[1]!.refreshInstructions).toBe(false);
    return mention;
  }

  const encrypted =
    "The encrypted content for item rs_1 could not be verified. Reason: Encrypted content could not be decrypted or parsed.";

  it("drops a broken session and reruns once in a new session with the full context", async () => {
    await startBridge(baseState());
    const mention = await resumeTurn();
    responder.fail(new AgentSessionInvalidError(encrypted));
    await waitUntil(() => responder.calls.length === 3);
    const rerun = responder.calls[2]!;
    expect(rerun.threadId).toBeUndefined();
    expect(rerun.refreshInstructions).toBe(true);
    expect(rerun.prompt).toContain("<room_members>");
    expect(rerun.prompt).toContain(mention.content);
    expect(room.statuses(mention.id)).not.toContain("failed");
    const retrying = room.reports.find((report) => report.progress?.includes("已开新会话重试"));
    expect(retrying?.detailText?.key).toBe("bridge.sessionRetrying");
    expect((await store.load())?.threadId).toBeUndefined();
    responder.finish("做完了", "new-thread");
    await waitUntil(() => room.statuses(mention.id).includes("completed"));
    expect((await store.load())?.threadId).toBe("new-thread");
  });

  it("marks the task failed when the new session fails too, and a retry starts fresh", async () => {
    await startBridge(baseState());
    const mention = await resumeTurn();
    responder.fail(new AgentSessionInvalidError(encrypted));
    await waitUntil(() => responder.calls.length === 3);
    responder.fail(new AgentSessionInvalidError("previous response not found"));
    await waitUntil(() => room.statuses(mention.id).includes("failed"));
    const failed = room.reports.find((report) => report.status === "failed");
    expect(failed?.detail).toMatch(/^会话已失效：previous response not found/);
    expect(failed?.detail).toContain("开了新会话还是失败");
    expect(failed?.detail).toContain("点「重试」会开新会话");
    expect(failed?.detailText?.key).toBe("bridge.sessionInvalid");
    await flush();
    expect(responder.calls).toHaveLength(3);

    // 人点「重试」：一定是新会话，而且又可以自动重跑一次
    room.handlers.onMention(mention, mention.seq, true);
    await waitUntil(() => responder.calls.length === 4);
    expect(responder.calls[3]!.threadId).toBeUndefined();
    expect(responder.calls[3]!.refreshInstructions).toBe(true);
    responder.finish("好了", "fresh");
    await waitUntil(() => room.statuses(mention.id).includes("completed"));
  });

  it("does not rerun a broken session once a tool has run", async () => {
    await startBridge(baseState());
    const mention = await resumeTurn();
    // 只读工具也算：会话坏了说明之前的回复不可信，不能确定重跑不会重复做事
    responder.calls[1]!.onTrace?.({
      id: "r",
      kind: "tool",
      tool: "read",
      summary: "a.ts",
      startedAt: new Date().toISOString(),
    });
    responder.fail(new AgentSessionInvalidError(encrypted));
    await waitUntil(() => room.statuses(mention.id).includes("failed"));
    const failed = room.reports.find((report) => report.status === "failed");
    expect(failed?.detail).toContain("这一轮已经开始执行工具，不自动重跑");
    expect(failed?.detail).toContain("点「重试」会开新会话");
    await flush();
    expect(responder.calls).toHaveLength(2);
    expect((await store.load())?.threadId).toBeUndefined();

    room.handlers.onMention(mention, mention.seq, true);
    await waitUntil(() => responder.calls.length === 3);
    expect(responder.calls[2]!.threadId).toBeUndefined();
    expect(responder.calls[2]!.refreshInstructions).toBe(true);
    responder.finish();
    await waitUntil(() => room.statuses(mention.id).includes("completed"));
  });

  it("does not rerun when the runtime reports it had already started a tool", async () => {
    await startBridge(baseState());
    const mention = await resumeTurn();
    responder.fail(new AgentSessionInvalidError(encrypted, true));
    await waitUntil(() => room.statuses(mention.id).includes("failed"));
    await flush();
    expect(responder.calls).toHaveLength(2);
  });

  async function writeSettings(settings: {
    model?: string;
    effort?: string;
    compactWindow?: number | "auto";
    cacheTtl?: string;
  }) {
    settingsFile = path.join(directory, "agent-settings.json");
    await writeFile(settingsFile, JSON.stringify({ mcpDisabled: [], ...settings }));
  }

  it("uses the model from the agent settings on every turn", async () => {
    await writeSettings({ model: "gpt-main" });
    await startBridge(baseState());
    await completePromptTurn();
    expect(responder.calls[0]!.model).toBe("gpt-main");
    // 网页上改了模型：下一轮就用新的，不用重启
    await writeSettings({ model: "gpt-other" });
    await completePromptTurn();
    expect(responder.calls[1]!.model).toBe("gpt-other");
  });

  it("never switches models on its own; a retired model fails right away with a hint", async () => {
    await writeSettings({ model: "gpt-old" });
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    // 模型下线：等多久都不会好，不自动重试、也不自动换模型，交给人
    responder.fail(new AgentUpstreamError("model_not_found: gpt-old", "s1", "model_unavailable"));
    await waitUntil(() => room.statuses(mention.id).includes("failed"));
    const failed = room.reports.find((report) => report.status === "failed");
    expect(failed?.detail).toBe(
      "模型用不了：model_not_found: gpt-old。等多久都不会好，点「换个模型重试」选别的模型，或者在 Agent 设置里改模型。",
    );
    // 不是「上游出错、点继续」那种：网页上不会把「继续」当主按钮
    expect(failed?.detailText?.key).toBe("bridge.modelFailed");
    await flush();
    expect(responder.calls).toHaveLength(1);
  });

  it.each([
    ["quota", "Quota exceeded. Check your plan and billing details.", "bridge.fix.quota"],
    ["auth", "Invalid API key · Fix external API key", "bridge.fix.login"],
    ["billing", "Credit balance is too low", "bridge.fix.billing"],
    ["context_overflow", "Prompt is too long", "bridge.fix.context"],
    ["refused", "TestAgent 的模型拒绝回答这次请求", "bridge.fix.refused"],
    [
      "invalid_request",
      "API Error: 400 messages.0.content: Input should be a valid list",
      "bridge.fix.request",
    ],
  ] as const)(
    "does not retry a %s failure on its own and says what a person has to do",
    async (kind, reason, fix) => {
      await startBridge(baseState());
      const mention = chat();
      room.messages.push(mention);
      room.handlers.onMention(mention, mention.seq, false);
      await waitUntil(() => responder.calls.length === 1);
      responder.fail(new AgentUpstreamError(reason, "s1", kind));
      await waitUntil(() => room.statuses(mention.id).includes("failed"));
      const failed = room.reports.find((report) => report.status === "failed");
      // 仍是「上游出错、点继续接着原会话」那种，只是写明等多久都不会好、要人先处理什么
      expect(failed?.detailText?.key).toBe("bridge.upstreamFailed");
      expect((failed?.detailText?.params?.why as { key: string }).key).toBe(fix);
      expect(failed?.failure).toBe(kind);
      expect(room.reports.some((report) => report.progress?.includes("自动继续"))).toBe(false);
      await flush();
      expect(responder.calls).toHaveLength(1);
      // 人处理好后点「继续」：接着原会话
      room.handlers.onMention(mention, mention.seq, true);
      await waitUntil(() => responder.calls.length === 2);
      expect(responder.calls[1]!.threadId).toBe("s1");
    },
  );

  it("reports the failure kind while waiting to continue and when giving up", async () => {
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    for (let call = 1; call <= 3; call += 1) {
      await waitUntil(() => responder.calls.length === call);
      responder.fail(new AgentUpstreamError("API Error: 429 rate limited", "s1", "rate_limited"));
    }
    await waitUntil(() => room.statuses(mention.id).includes("failed"));
    const reports = room.reports.filter(
      (report) => report.messageId === mention.id && report.detail?.includes("429"),
    );
    expect(reports.length).toBeGreaterThan(0);
    for (const report of reports) expect(report.failure).toBe("rate_limited");
  });

  it("keeps using the same model while retrying an overloaded upstream", async () => {
    await writeSettings({ model: "gpt-main" });
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    for (let call = 1; call <= 3; call += 1) {
      await waitUntil(() => responder.calls.length === call);
      expect(responder.calls[call - 1]!.model).toBe("gpt-main");
      responder.fail(new AgentUpstreamError("API Error: 529 overloaded", "s1"));
    }
    await waitUntil(() => room.statuses(mention.id).includes("failed"));
    await flush();
    expect(responder.calls).toHaveLength(3);
  });

  it("retries once with the model a person picked", async () => {
    await writeSettings({ model: "gpt-main" });
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    responder.fail(new AgentNonRetryableError("boom"));
    await waitUntil(() => room.statuses(mention.id).includes("failed"));
    room.handlers.onMention(mention, mention.seq, true, false, false, false, "gpt-picked");
    await waitUntil(() => responder.calls.length === 2);
    expect(responder.calls[1]!.model).toBe("gpt-picked");
    const using = room.reports.find((report) => report.detailText?.key === "bridge.usingModel");
    expect(using?.progress).toBe("这次用 gpt-picked 重试");
    responder.fail(new AgentNonRetryableError("boom again"));
    await waitUntil(() => room.statuses(mention.id).filter((s) => s === "failed").length === 2);
    // 普通「重试」回到设置里的模型
    room.handlers.onMention(mention, mention.seq, true);
    await waitUntil(() => responder.calls.length === 3);
    expect(responder.calls[2]!.model).toBe("gpt-main");
    responder.finish();
    await waitUntil(() => room.statuses(mention.id).includes("completed"));
  });

  it("passes the reasoning effort from the agent settings and records it in the usage", async () => {
    await writeSettings({ model: "gpt-main", effort: "high" });
    await startBridge(baseState());
    const usage = {
      inputTokens: 10,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 5,
      requests: 1,
      peakContextTokens: 10,
      peakCacheWriteTokens: 0,
    };
    const first = chat();
    room.messages.push(first);
    room.handlers.onMention(first, first.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    expect(responder.calls[0]!.effort).toBe("high");
    responder.finish("好", "thread-1", usage);
    await waitUntil(() => room.statuses(first.id).includes("completed"));
    expect(room.reports.find((report) => report.usage)?.usage?.effort).toBe("high");
    // 网页上改回「跟随 CLI 配置」：下一轮就不传，用量里也不写
    await writeSettings({ model: "gpt-main" });
    const second = chat({ content: "@agent-a 再来" });
    room.messages.push(second);
    room.handlers.onMention(second, second.seq, false);
    await waitUntil(() => responder.calls.length === 2);
    expect(responder.calls[1]!.effort).toBeUndefined();
    responder.finish("好", "thread-1", usage);
    await waitUntil(() => room.statuses(second.id).includes("completed"));
    const latest = room.reports.filter((report) => report.messageId === second.id && report.usage);
    expect(latest[0]?.usage?.effort).toBeUndefined();
  });

  it("defaults the room's lead Claude agent to a 1h cache and follows lead changes", async () => {
    await writeSettings({});
    bridgeProvider = "claude";
    bridgeLead = "Agent-A";
    await startBridge(baseState());
    const turn = async (content: string) => {
      const message = chat({ content });
      room.messages.push(message);
      const before = responder.calls.length;
      room.handlers.onMention(message, message.seq, false);
      await waitUntil(() => responder.calls.length === before + 1);
      responder.finish();
      await waitUntil(() => room.statuses(message.id).includes("completed"));
      return responder.calls[before]!;
    };
    // 跟随 Claude Code（没设）且是主 Agent（名字不分大小写）：按 1 小时
    expect((await turn("@agent-a 一")).cacheTtl).toBe("1h");
    // 人手动选了 5 分钟：以人选的为准
    await writeSettings({ cacheTtl: "5m" });
    expect((await turn("@agent-a 二")).cacheTtl).toBe("5m");
    await writeSettings({});
    // 主 Agent 换人（房间设置改了，Server 推 rooms.changed）：下一轮交回 Claude Code 自己选
    const summary = {
      id: "general",
      name: "general",
      createdAt: "2026-07-18T00:00:00.000Z",
      onlineCount: 1,
      latestSeq: 0,
    };
    room.handlers.onRoomsChanged?.({ ...summary, leadAgent: "reviewer" });
    expect((await turn("@agent-a 三")).cacheTtl).toBeUndefined();
    // 别的房间的变化不算
    room.handlers.onRoomsChanged?.({ ...summary, id: "other", leadAgent: "agent-a" });
    expect((await turn("@agent-a 四")).cacheTtl).toBeUndefined();
    // 又换回来：下一轮按 1 小时
    room.handlers.onRoomsChanged?.({ ...summary, leadAgent: "agent-a" });
    expect((await turn("@agent-a 五")).cacheTtl).toBe("1h");
  });

  it("leaves the cache ttl to other runtimes even for the lead agent", async () => {
    await writeSettings({});
    bridgeLead = "agent-a";
    await startBridge(baseState());
    await completePromptTurn();
    expect(responder.calls[0]!.cacheTtl).toBeUndefined();
  });

  it("compacts at 400k by default, follows the settings file, and reports auto-compaction", async () => {
    // 设置文件里没有这两项（老 Agent）：按默认 40 万，缓存时长不传
    await writeSettings({});
    bridgeProvider = "claude";
    await startBridge(baseState());
    const usage = {
      inputTokens: 10,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 5,
      requests: 1,
      peakContextTokens: 10,
      peakCacheWriteTokens: 0,
    };
    const first = chat();
    room.messages.push(first);
    room.handlers.onMention(first, first.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    expect(responder.calls[0]!.compactWindow).toBe(400_000);
    expect(responder.calls[0]!.cacheTtl).toBeUndefined();
    responder.calls[0]!.onCompacted?.({
      preTokens: 289_737,
      postTokens: 10_079,
      durationMs: 12_835,
    });
    const note = room.reports.find((report) => report.detailText?.key === "bridge.compacted");
    expect(note?.progress).toBe("上下文已自动压缩（290k → 10k token）");
    responder.finish("好", "thread-1", usage);
    await waitUntil(() => room.statuses(first.id).includes("completed"));
    expect(room.reports.find((report) => report.usage)?.usage?.compactWindow).toBe(400_000);
    expect(room.reports.find((report) => report.usage)?.usage?.compactions).toEqual([
      { preTokens: 289_737, postTokens: 10_079, durationMs: 12_835 },
    ]);
    // 网页上选了 40 万、1 小时：下一轮就按新的传
    await writeSettings({ compactWindow: 400_000, cacheTtl: "1h" });
    const second = chat({ content: "@agent-a 再来" });
    room.messages.push(second);
    room.handlers.onMention(second, second.seq, false);
    await waitUntil(() => responder.calls.length === 2);
    expect(responder.calls[1]).toMatchObject({ compactWindow: 400_000, cacheTtl: "1h" });
    // 写了 1 小时缓存：用量里记下缓存有效期，网页据此算还剩几分钟
    responder.finish("好", "thread-1", {
      ...usage,
      cacheWriteTokens: 100,
      cacheWrite1hTokens: 100,
      lastContextTokens: 110,
      lastRequestAt: new Date().toISOString(),
    });
    await waitUntil(() => room.statuses(second.id).includes("completed"));
    const latest = room.reports.filter((report) => report.messageId === second.id && report.usage);
    expect(latest[0]?.usage?.compactions).toBeUndefined();
    expect(latest[0]?.usage).toMatchObject({ cacheTtlMs: 3_600_000, lastContextTokens: 110 });
    // 「不限制」：不传阈值，交给 Claude Code
    await writeSettings({ compactWindow: "auto" });
    const third = chat({ content: "@agent-a 第三条" });
    room.messages.push(third);
    room.handlers.onMention(third, third.seq, false);
    await waitUntil(() => responder.calls.length === 3);
    expect(responder.calls[2]!.compactWindow).toBeUndefined();
    responder.finish();
    await waitUntil(() => room.statuses(third.id).includes("completed"));
  });

  it("retries once with the effort a person picked, then goes back to the settings", async () => {
    await writeSettings({ effort: "low" });
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    responder.fail(new AgentNonRetryableError("boom"));
    await waitUntil(() => room.statuses(mention.id).includes("failed"));
    // 只换思考强度、不换模型
    room.handlers.onMention(
      mention,
      mention.seq,
      true,
      false,
      false,
      false,
      undefined,
      false,
      "xhigh",
    );
    await waitUntil(() => responder.calls.length === 2);
    expect(responder.calls[1]!.effort).toBe("xhigh");
    expect(responder.calls[1]!.model).toBeUndefined();
    const using = room.reports.find((report) => report.detailText?.key === "bridge.usingEffort");
    expect(using?.progress).toBe("这次用 xhigh 思考强度重试");
    responder.fail(new AgentNonRetryableError("boom again"));
    await waitUntil(() => room.statuses(mention.id).filter((s) => s === "failed").length === 2);
    room.handlers.onMention(mention, mention.seq, true, false, false, false, "gpt-b", false, "max");
    await waitUntil(() => responder.calls.length === 3);
    expect(responder.calls[2]).toMatchObject({ model: "gpt-b", effort: "max" });
    expect(
      room.reports.find((report) => report.detailText?.key === "bridge.usingModelEffort")?.progress,
    ).toBe("这次用 gpt-b（思考强度 max）重试");
    responder.fail(new AgentNonRetryableError("boom 3"));
    await waitUntil(() => room.statuses(mention.id).filter((s) => s === "failed").length === 3);
    // 普通「重试」回到设置里的强度
    room.handlers.onMention(mention, mention.seq, true);
    await waitUntil(() => responder.calls.length === 4);
    expect(responder.calls[3]!.effort).toBe("low");
    responder.finish();
    await waitUntil(() => room.statuses(mention.id).includes("completed"));
  });

  it("says so when the runtime cannot use the effort, and leaves it out of the usage", async () => {
    await writeSettings({ effort: "max" });
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    responder.calls[0]!.onEffortIgnored?.("max", ["off", "low"]);
    const note = room.reports.find(
      (report) => report.detailText?.key === "bridge.effortUnsupported",
    );
    expect(note?.progress).toBe(
      "当前模型不支持 max 思考强度（可选：off / low），这一轮按 CLI 配置的强度跑",
    );
    responder.finish("好", "thread-1", {
      inputTokens: 1,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 1,
      requests: 1,
      peakContextTokens: 1,
      peakCacheWriteTokens: 0,
    });
    await waitUntil(() => room.statuses(mention.id).includes("completed"));
    const report = room.reports.find((item) => item.usage);
    expect(report?.usage).toBeDefined();
    expect(report?.usage?.effort).toBeUndefined();
  });

  it("continues automatically on the same session after an upstream failure when nothing was changed", async () => {
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    // 只读了文件、跑了只读命令
    const now = new Date().toISOString();
    responder.calls[0]!.onTrace?.({
      id: "r",
      kind: "tool",
      tool: "read",
      summary: "a.ts",
      startedAt: now,
    });
    responder.calls[0]!.onTrace?.({
      id: "c",
      kind: "tool",
      tool: "command",
      summary: "git status && ls -la",
      startedAt: now,
    });
    responder.fail(new AgentUpstreamError("API Error: 429 rate limited", "session-upstream"));
    await waitUntil(() =>
      room.reports.some(
        (report) => report.messageId === mention.id && report.progress?.includes("自动继续"),
      ),
    );
    expect(room.statuses(mention.id)).not.toContain("failed");
    // 等着自动继续时还算忙：对话流里是「执行中」，成员列表也不能显示空闲
    expect(room.typing.at(-1)).toBe(true);
    // 等一会儿接着原会话继续，并提醒从断点往下做
    await waitUntil(() => responder.calls.length === 2);
    expect(responder.calls[1]!.threadId).toBe("session-upstream");
    expect(responder.calls[1]!.prompt).toContain("因上游模型服务出错在中途中断：API Error: 429");
    responder.finish("做完了", "session-upstream");
    await waitUntil(() => room.statuses(mention.id).includes("completed"));
  });

  it.each([false, true])(
    "auto-continues the same session after an upstream failure even with side effects (progress=%s)",
    async (progress) => {
      await startBridge(baseState());
      const mention = chat();
      room.messages.push(mention);
      room.handlers.onMention(mention, mention.seq, false);
      await waitUntil(() => responder.calls.length === 1);
      responder.calls[0]!.onTrace?.({
        id: "w",
        kind: "tool",
        tool: progress ? "collaboration" : "write",
        ...(progress ? { name: "hive.hive_message_send", hiveProgress: true as const } : {}),
        summary: "src/a.ts",
        startedAt: new Date().toISOString(),
      });
      responder.fail(new AgentUpstreamError("API Error: 529 overloaded", "session-x"));
      // 不报失败：等一会儿自动接着原会话继续，提示里写明做过哪些改动
      await waitUntil(() => room.reports.some((report) => report.progress?.includes("自动继续")));
      expect(room.statuses(mention.id)).not.toContain("failed");
      await waitUntil(() => responder.calls.length === 2);
      expect(responder.calls[1]!.threadId).toBe("session-x");
      expect(responder.calls[1]!.prompt).toContain("不要重复已经完成的");
      expect(responder.calls[1]!.prompt).toContain("src/a.ts");
      responder.finish("继续做完", "session-x");
      await waitUntil(() => room.statuses(mention.id).includes("completed"));
    },
  );

  it("runs a task waiting to auto-continue only once even if the mention arrives again", async () => {
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    responder.fail(new AgentUpstreamError("API Error: 429", "s1"));
    await waitUntil(() => room.reports.some((report) => report.progress?.includes("自动继续")));
    // 等待期间重连补拉、或同一条 @ 又到了
    room.handlers.onMention(mention, mention.seq, false);
    await room.handlers.onSnapshot({
      self,
      latestSeq: mention.seq,
      messages: [mention],
      participants: [self],
      invocations: [],
    });
    await waitUntil(() => responder.calls.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(responder.calls).toHaveLength(2);
    responder.finish("完成", "s1");
    await waitUntil(() => room.statuses(mention.id).includes("completed"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(responder.calls).toHaveLength(2);
  });

  it("confirms a stop right away while waiting to auto-continue", async () => {
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    responder.fail(new AgentUpstreamError("API Error: 429", "s1"));
    await waitUntil(() => room.reports.some((report) => report.progress?.includes("自动继续")));
    expect(room.typing.at(-1)).toBe(true);
    room.handlers.onCancel?.(mention.id);
    await waitUntil(() => room.statuses(mention.id).includes("cancelled"));
    // 停掉以后不再算忙
    expect(room.typing.at(-1)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(responder.calls).toHaveLength(1);
  });

  it("answers a stop right away for a turn that already ended with an unknown result", async () => {
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    responder.fail(new AgentExecutionUncertainError("结果未知"));
    await waitUntil(() => room.statuses(mention.id).includes("uncertain"));
    const before = room.reports.length;
    room.handlers.onCancel?.(mention.id);
    await waitUntil(() => room.reports.length > before);
    expect(room.reports.at(-1)).toMatchObject({ status: "uncertain" });
    expect(room.reports.at(-1)?.detail).toContain("没有在跑的回合");
    expect(responder.calls).toHaveLength(1);
  });

  it("auto-continues after the network drops (lid closed) even if the turn already changed things", async () => {
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    // 这一轮已经跑过会改东西的命令，然后合盖断网：Claude Code 重试用完后报连不上
    responder.calls[0]!.onTrace?.({
      id: "w",
      kind: "tool",
      tool: "command",
      name: "command",
      summary: "pnpm install",
      startedAt: new Date().toISOString(),
    });
    responder.fail(
      new AgentUpstreamError(
        "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)",
        "s1",
      ),
    );
    await waitUntil(() =>
      room.reports.some((report) => report.progress?.includes("连不上模型服务（网络中断）")),
    );
    // 网络回来后接着原会话继续，不报结果未知
    await waitUntil(() => responder.calls.length === 2);
    expect(responder.calls[1]?.threadId).toBe("s1");
    responder.finish("完成", "s1");
    await waitUntil(() => room.statuses(mention.id).includes("completed"));
    expect(room.statuses(mention.id)).not.toContain("uncertain");
  });

  it("keeps reporting running while waiting longer than a heartbeat to auto-continue", async () => {
    // 等待时间比 Server 判超时的窗口还长（线上第 5 次等 15 分钟 > 10 分钟）：等待期间也要按心跳报进度
    extraTuning = { heartbeatMs: 20, networkRetryDelaysMs: [200] };
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    responder.fail(new AgentUpstreamError("API Error: Can't reach the API server (ENOTFOUND)"));
    await waitUntil(() =>
      room.reports.some((report) => report.progress?.includes("连不上模型服务（网络中断）")),
    );
    const first = room.reports.length;
    await waitUntil(() =>
      room.reports
        .slice(first)
        .some(
          (report) =>
            report.messageId === mention.id &&
            report.status === "running" &&
            report.progress?.includes("后自动继续"),
        ),
    );
    // 等待心跳带着和第一次上报相同的 detail：Server 收到不带 detail 的回报会把出错原因清掉
    const heartbeat = room.reports
      .slice(first)
      .find((report) => report.progress?.includes("后自动继续"));
    expect(heartbeat?.detail).toBe(room.reports[first - 1]?.detail);
    expect(heartbeat?.detail).toContain("Can't reach the API server");
    await waitUntil(() => responder.calls.length === 2);
    const resumedAt = room.reports.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    // 恢复执行后不再报等待中的进度
    expect(
      room.reports.slice(resumedAt).some((report) => report.progress?.includes("后自动继续")),
    ).toBe(false);
    responder.finish("完成", "s1");
    await waitUntil(() => room.statuses(mention.id).includes("completed"));
  });

  it("stops the waiting heartbeat once a waiting task is stopped", async () => {
    extraTuning = { heartbeatMs: 20, networkRetryDelaysMs: [10_000] };
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    responder.fail(new AgentUpstreamError("API Error: Can't reach the API server (ENOTFOUND)"));
    await waitUntil(
      () => room.reports.filter((report) => report.progress?.includes("后自动继续")).length >= 2,
    );
    room.handlers.onCancel?.(mention.id);
    await waitUntil(() => room.statuses(mention.id).includes("cancelled"));
    const cancelledAt = room.reports.length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(room.reports.slice(cancelledAt).some((report) => report.status === "running")).toBe(
      false,
    );
  });

  it("tells the agent to check and carry on when a human continues an interrupted turn", async () => {
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, true, false, false, false, undefined, true);
    await waitUntil(() => responder.calls.length === 1);
    expect(responder.calls[0]!.prompt).toContain("上一次执行中途中断");
    expect(responder.calls[0]!.prompt).toContain("不要重复已经完成的");
    responder.finish();
    await waitUntil(() => room.statuses(mention.id).includes("completed"));
  });

  it("gives up auto-continuing after the configured attempts", async () => {
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    for (let call = 1; call <= 3; call += 1) {
      await waitUntil(() => responder.calls.length === call);
      responder.fail(new AgentUpstreamError("rate limit exceeded"));
    }
    await waitUntil(() => room.statuses(mention.id).includes("failed"));
    expect(room.reports.find((report) => report.status === "failed")?.detail).toContain(
      "已自动继续 2 次仍未成功",
    );
  });

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
    // Codex、Claude 会报告压缩，定时全量只留作兜底：8 轮还不重发，40 轮才重发
    await startBridge({ ...state, briefTurns: 8 });
    const notYet = await completePromptTurn();
    expect(notYet.refreshInstructions).toBe(false);
    expect(notYet.prompt).not.toContain("<room_members>");
    await bridge.stop();
    await startBridge({ ...(await store.load())!, briefTurns: 40 });
    const periodic = await completePromptTurn();
    expect(periodic.refreshInstructions).toBe(true);
    expect(periodic.prompt).toContain("完整快照");
    expect(periodic.prompt).toContain("summary-a");
    expect(periodic.prompt).toContain("summary-b");
    expect(periodic.prompt).toContain("reviewer");
  });

  it("says unchanged context is the same as before and stamps each turn with the current time", async () => {
    seedPromptContext();
    await startBridge(baseState());
    const first = await completePromptTurn();
    expect(first.prompt).not.toContain("同上");
    expect(first.prompt).toMatch(/当前时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}（/);
    const next = await completePromptTurn();
    expect(next.prompt).not.toContain("<room_members>");
    expect(next.prompt).toContain("成员列表、白板：同上，与上次相比没有变化。");
    expect(next.prompt).toMatch(/当前时间：/);
    room.participants[1] = { ...room.participants[1]!, status: "busy" };
    const changed = await completePromptTurn();
    expect(changed.prompt).toContain("reviewer（agent，busy）");
    expect(changed.prompt).toContain("白板：同上，与上次相比没有变化。");
  });

  it("resends the full context on the turn after the runtime compacted the conversation", async () => {
    seedPromptContext();
    await startBridge(baseState());
    await completePromptTurn();
    const compactedTurn = await completePromptTurn("thread-1", true);
    expect(compactedTurn.prompt).not.toContain("<room_members>");
    expect((await store.load())?.compactedSinceFull).toBe(true);
    const refreshed = await completePromptTurn();
    expect(refreshed.prompt).toContain("完整快照");
    expect(refreshed.prompt).toContain("summary-a");
    expect(refreshed.prompt).toContain("reviewer");
    expect((await store.load())?.compactedSinceFull).toBeUndefined();
    const after = await completePromptTurn();
    expect(after.prompt).not.toContain("<room_members>");
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
    room.handlers.onMention(extra, extra.seq, false, true);
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
    expect(room.reports.at(-1)?.detail).toContain("没有自动重跑");
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
    // 这一轮没停下：如实告诉服务端，不让这条一直显示「停止中」
    const deferred = room.reports.filter((report) => report.messageId === first.id).at(-1);
    expect(deferred).toMatchObject({ status: "running", stopDeferred: true });
    expect(deferred?.detail).toContain("这一轮会继续");
    expect(
      room.reports.some((report) => report.messageId === second.id && report.stopDeferred),
    ).toBe(false);
    responder.finish();
    await waitUntil(() => room.statuses(first.id).includes("cancelled"));
    expect(room.statuses(second.id)).toContain("completed");
  });

  it("stops the whole turn at once when the server stops every message of it together", async () => {
    await startBridge(baseState());
    const first = chat();
    const second = chat();
    room.messages.push(first, second);
    room.handlers.onMention(first, first.seq, false);
    room.handlers.onMention(second, second.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    // 服务端停整轮：第一条停止请求就带上同轮的全部消息，不等第二条到达
    room.handlers.onCancel!(first.id, [first.id, second.id]);
    expect(responder.calls[0]!.signal?.aborted).toBe(true);
    expect(room.reports.some((report) => report.stopDeferred)).toBe(false);
    // 随后到达的第二条停止请求不会被当成「同轮还有没停的」
    room.handlers.onCancel!(second.id, [first.id, second.id]);
    expect(room.reports.some((report) => report.stopDeferred)).toBe(false);
    await waitUntil(
      () =>
        room.statuses(first.id).includes("cancelled") &&
        room.statuses(second.id).includes("cancelled"),
    );
  });

  it("ignores turn members that aren't part of the running turn", async () => {
    await startBridge(baseState());
    const first = chat();
    const second = chat();
    room.messages.push(first, second);
    room.handlers.onMention(first, first.seq, false);
    room.handlers.onMention(second, second.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    room.handlers.onCancel!(first.id, [first.id, "00000000-0000-4000-8000-ffffffffffff"]);
    expect(responder.calls[0]!.signal?.aborted).toBe(false);
    expect(room.reports.filter((report) => report.stopDeferred).map((r) => r.messageId)).toEqual([
      first.id,
    ]);
    responder.finish();
    await waitUntil(() => room.statuses(second.id).includes("completed"));
  });

  it("picks the deepest trigger as the reply parent", () => {
    const human = chat({ hopCount: 0 });
    const agent = chat({ hopCount: 2, senderType: "agent" });
    const later = chat({ hopCount: 0 });
    expect(pickReplyParent([human, agent, later]).id).toBe(agent.id);
  });
});
