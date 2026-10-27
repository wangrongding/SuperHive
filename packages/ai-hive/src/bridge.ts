import { createHash, randomUUID } from "node:crypto";
import {
  isMentioned,
  type ChatMessage,
  type Invocation,
  type InvocationReport,
  type RoomSummary,
  type WhiteboardEntry,
} from "./hive-protocol.js";
import { isCancelled, type AgentAccessMode, type AgentResponder } from "./responder.js";
import {
  buildDeveloperInstructions,
  buildMentionPrompt,
  buildSteerPrompt,
} from "./prompt-builder.js";
import {
  RoomClient,
  RoomClientError,
  type RoomClientHandlers,
  type Snapshot,
} from "./room-client.js";
import { StateStore, type AgentState } from "./state-store.js";

export function shouldProcessMention(input: {
  message: ChatMessage;
  username: string;
  ownParticipantId: string;
  processedMessageIds: string[];
}): boolean {
  return (
    !input.message.deletedAt &&
    input.message.senderId !== input.ownParticipantId &&
    input.message.hopCount < 4 &&
    isMentioned(input.message.content, input.username) &&
    !input.processedMessageIds.includes(input.message.id)
  );
}

export function hasAgentMessage(messages: ChatMessage[], participantId: string): boolean {
  return messages.some((message) => message.senderId === participantId);
}

/**
 * 回复要挂在哪条触发消息下：取传递深度最大的一条（同深度取最新），
 * 这样合批后仍沿用最严格的 hop/trace 防循环链，而不会因为混入人类消息被"重置"。
 */
export function pickReplyParent(triggers: ChatMessage[]): ChatMessage {
  return triggers.reduce((best, message) =>
    message.hopCount > best.hopCount ||
    (message.hopCount === best.hopCount && message.seq > best.seq)
      ? message
      : best,
  );
}

export type BridgeTuning = {
  /** 第一条 @ 到达后等待多久再开工，以便把一阵连发合成一轮（参考 relay 的 500ms 合并窗口） */
  batchWindowMs?: number;
  /** 一轮最多合并多少条触发消息（参考 agent-bridge CodexRoomInbox） */
  maxBatchSize?: number;
  /** 运行中多久没有新进度时也回报一次心跳，避免被服务端判为结果未知 */
  heartbeatMs?: number;
  /** 进度回报的最小间隔 */
  progressThrottleMs?: number;
  /** 隔多少轮或多久重新发送一次完整上下文 */
  fullPromptEveryTurns?: number;
  fullPromptEveryMs?: number;
};

type ActiveBatch = {
  executionId: string;
  messages: ChatMessage[];
  controller: AbortController;
  cancelled: Set<string>;
  /** Provider 回合仍在进行、可以吸收 steer；回合结束后新消息改为排队 */
  accepting: boolean;
};

const MAX_ATTEMPTS = 3;

export class AgentBridge {
  private state!: AgentState;
  private stateExisted = false;
  private ownParticipantId = "";
  private instructions = "";
  private readonly pending: ChatMessage[] = [];
  private active: ActiveBatch | undefined;
  private draining: Promise<void> | undefined;
  private batchTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  private readonly steering = new Set<string>();
  // 排队或处理期间被发送者撤回的 @：处理前跳过，处理中则不再代发回复
  private readonly recalled = new Set<string>();
  // 人在 UI 点了"停止"但消息尚未到达本地队列（例如断线期间）的提及
  private readonly cancelledEarly = new Set<string>();
  private readonly attempts = new Map<string, number>();
  // 同一组触发消息在本地重试时复用 executionId，保证回复的幂等键不变
  private readonly executionIds = new Map<string, string>();
  private readonly room: RoomClient;
  private readonly tuning: Required<BridgeTuning>;

  constructor(
    private readonly options: {
      serverUrl: string;
      roomId: string;
      username: string;
      persona: string;
      provider: string;
      token: string;
      access?: AgentAccessMode;
      onRoomsChanged?: (room: RoomSummary) => void;
      onArchived?: () => void;
      tuning?: BridgeTuning;
    },
    private readonly store: StateStore,
    private readonly responder: AgentResponder,
    private readonly log: (message: string) => void = console.log,
    createRoom: (
      options: ConstructorParameters<typeof RoomClient>[0],
      handlers: RoomClientHandlers,
    ) => RoomClient = (roomOptions, handlers) => new RoomClient(roomOptions, handlers),
  ) {
    this.tuning = {
      batchWindowMs: 400,
      maxBatchSize: 10,
      heartbeatMs: 60_000,
      progressThrottleMs: 3_000,
      fullPromptEveryTurns: 8,
      fullPromptEveryMs: 30 * 60_000,
      ...options.tuning,
    };
    this.room = createRoom(
      {
        serverUrl: this.options.serverUrl,
        roomId: this.options.roomId,
        username: this.options.username,
        token: this.options.token,
        persona: this.options.persona,
        provider: this.options.provider,
      },
      {
        onSnapshot: (snapshot) => this.onSnapshot(snapshot),
        onMention: (message, _latestSeq, retry) => this.enqueue(message, { retry }),
        onCancel: (messageId) => this.cancel(messageId),
        onMessageDeleted: (message) => this.onRecalled(message.id),
        ...(this.options.onRoomsChanged ? { onRoomsChanged: this.options.onRoomsChanged } : {}),
        onError: (error) => {
          this.log(`[hive] ${error.message}`);
          if (error instanceof RoomClientError && error.code === "ROOM_ARCHIVED") {
            this.options.onArchived?.();
          }
        },
      },
    );
  }

  async start(): Promise<void> {
    const existing = await this.store.load();
    this.stateExisted = Boolean(existing);
    this.state =
      existing ??
      ({
        serverUrl: this.options.serverUrl,
        roomId: this.options.roomId,
        username: this.options.username,
        lastProcessedSeq: 0,
        processedMessageIds: [],
      } satisfies AgentState);
    const serverRules = await this.room.fetchInstructions();
    this.instructions = buildDeveloperInstructions({
      agentName: this.options.username,
      persona: this.options.persona,
      serverRules,
      ...(this.options.access ? { access: this.options.access } : {}),
    });
    await this.recoverInterruptedExecution();
    this.room.start();
    this.log(
      `[hive] ${this.options.username} 正在连接 ${this.options.serverUrl}/${this.options.roomId}`,
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.batchTimer) clearTimeout(this.batchTimer);
    // 停止进程时中断正在进行的回合；执行意图会在中断回报后清除
    this.active?.controller.abort();
    await this.draining?.catch(() => undefined);
    this.room.stop();
    await this.responder.close?.();
  }

  /**
   * 上次进程在执行途中退出（崩溃、断电、kill -9）：结果未知，不自动重跑，
   * 只把这些提及回报为失败并标记已处理，由人在 UI 中决定是否重试。
   */
  private async recoverInterruptedExecution(): Promise<void> {
    const inflight = this.state.inflight;
    if (!inflight) return;
    this.log(
      `[hive] 检测到上次执行中断（${inflight.messageIds.length} 条提及，开始于 ${inflight.startedAt}），结果未知，不会自动重跑。`,
    );
    for (const messageId of inflight.messageIds) {
      this.room.report({
        messageId,
        status: "failed",
        detail:
          "Agent 在处理途中意外退出，结果未知；为避免重复执行未自动重跑，可在界面中手动重试。",
      });
      this.rememberProcessed(messageId);
    }
    delete this.state.inflight;
    await this.store.save(this.state);
  }

  private async onSnapshot(snapshot: Snapshot): Promise<void> {
    this.ownParticipantId = snapshot.self.id;
    this.log(`[hive] 已加入 #${this.options.roomId}，公共消息最新 seq=${snapshot.latestSeq}`);
    if (!this.stateExisted) {
      this.state.lastProcessedSeq = snapshot.latestSeq;
      this.stateExisted = true;
      await this.store.save(this.state);
      return;
    }
    const known = new Map<string, Invocation>();
    for (const invocation of snapshot.invocations ?? []) {
      if (invocation.agentId === this.ownParticipantId) known.set(invocation.messageId, invocation);
    }
    const missed = await this.room.fetchMessages(this.state.lastProcessedSeq);
    for (const message of missed.messages) {
      if (!this.isEligible(message)) continue;
      const invocation = known.get(message.id);
      // 服务端是调用状态的权威：被拦下、已停止或已结束的提及不再补做
      if (snapshot.invocations && invocation && invocation.status !== "queued") {
        if (
          (invocation.status === "running" || invocation.status === "timed_out") &&
          !this.isLocal(message.id)
        ) {
          this.room.report({
            messageId: message.id,
            status: "failed",
            detail: "Agent 重新连接时这次处理已不在进行，结果未知；可在界面中手动重试。",
          });
          this.rememberProcessed(message.id);
        }
        continue;
      }
      this.enqueue(message);
    }
    await this.store.save(this.state);
  }

  private isEligible(message: ChatMessage): boolean {
    return shouldProcessMention({
      message,
      username: this.options.username,
      ownParticipantId: this.ownParticipantId,
      processedMessageIds: this.state.processedMessageIds,
    });
  }

  private isLocal(messageId: string): boolean {
    return (
      this.steering.has(messageId) ||
      this.pending.some((message) => message.id === messageId) ||
      Boolean(this.active?.messages.some((message) => message.id === messageId))
    );
  }

  private enqueue(message: ChatMessage, options: { retry?: boolean } = {}): void {
    if (this.stopped) return;
    if (options.retry) {
      // 人显式重试：忽略本地"已处理/已停止"记录，重新开始计数和幂等键
      this.state.processedMessageIds = this.state.processedMessageIds.filter(
        (id) => id !== message.id,
      );
      this.cancelledEarly.delete(message.id);
      this.attempts.delete(message.id);
      this.executionIds.delete(message.id);
    }
    if (this.isLocal(message.id) || !this.isEligible(message)) return;
    if (this.cancelledEarly.delete(message.id)) {
      this.rememberProcessed(message.id);
      void this.store.save(this.state);
      return;
    }
    this.room.report({ messageId: message.id, status: "received" });
    if (this.active?.accepting && this.responder.steer && !this.active.controller.signal.aborted) {
      void this.steerIntoActive(this.active, message);
      return;
    }
    this.pending.push(message);
    this.scheduleDrain(this.tuning.batchWindowMs);
  }

  /** 正在运行的 Codex 回合可以直接吸收新消息（turn/steer），失败时退回排队 */
  private async steerIntoActive(active: ActiveBatch, message: ChatMessage): Promise<void> {
    this.steering.add(message.id);
    let steered = false;
    try {
      steered = await this.responder.steer!(buildSteerPrompt(message));
    } catch {
      steered = false;
    } finally {
      this.steering.delete(message.id);
    }
    // 回合在注入期间已经结束时宁可再排队处理一次，也不能把消息算进一个没看到它的回复
    if (steered && this.active === active && active.accepting) {
      active.messages.push(message);
      this.log(`[hive] #${message.seq} 已注入正在进行的回合`);
      this.room.report({ messageId: message.id, status: "running", detail: "已注入当前回合" });
      return;
    }
    this.pending.push(message);
    this.scheduleDrain(this.tuning.batchWindowMs);
  }

  private scheduleDrain(delayMs: number): void {
    if (this.batchTimer || this.stopped) return;
    this.batchTimer = setTimeout(() => {
      this.batchTimer = undefined;
      void this.drain();
    }, delayMs);
    this.batchTimer.unref?.();
  }

  private drain(): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = (async () => {
      while (this.pending.length > 0 && !this.stopped) {
        const batch = this.pending.splice(0, this.tuning.maxBatchSize);
        await this.runBatch(batch);
      }
    })().finally(() => {
      this.draining = undefined;
    });
    return this.draining;
  }

  private onRecalled(messageId: string): void {
    if (this.isLocal(messageId)) this.recalled.add(messageId);
  }

  private cancel(messageId: string): void {
    const pendingIndex = this.pending.findIndex((message) => message.id === messageId);
    if (pendingIndex >= 0) {
      this.pending.splice(pendingIndex, 1);
      this.log(`[hive] 排队中的提及 ${messageId} 已被停止`);
      this.rememberProcessed(messageId);
      void this.store.save(this.state);
      return;
    }
    const active = this.active;
    if (active?.messages.some((message) => message.id === messageId)) {
      active.cancelled.add(messageId);
      // 合批中只要还有未被停止的消息，就继续这一轮
      if (active.messages.every((message) => active.cancelled.has(message.id))) {
        this.log("[hive] 收到停止请求，正在中断当前回合");
        active.controller.abort();
      }
      return;
    }
    this.cancelledEarly.add(messageId);
  }

  private rememberProcessed(messageId: string): void {
    this.state.processedMessageIds = [
      ...this.state.processedMessageIds.filter((id) => id !== messageId),
      messageId,
    ].slice(-1000);
    this.attempts.delete(messageId);
    this.executionIds.delete(messageId);
  }

  private reportAll(messages: ChatMessage[], report: Omit<InvocationReport, "type" | "messageId">) {
    for (const message of messages) this.room.report({ messageId: message.id, ...report });
  }

  private async runBatch(initial: ChatMessage[]): Promise<void> {
    const skipped = initial.filter(
      (message) =>
        this.recalled.has(message.id) || this.state.processedMessageIds.includes(message.id),
    );
    for (const message of skipped) {
      if (this.recalled.delete(message.id)) {
        this.log(`[hive] #${message.seq} 已被发送者撤回，跳过处理`);
        this.rememberProcessed(message.id);
      }
    }
    const messages = initial.filter((message) => !skipped.includes(message));
    if (messages.length === 0) {
      await this.store.save(this.state);
      return;
    }
    const executionId = this.executionIds.get(messages[0]!.id) ?? randomUUID();
    for (const message of messages) this.executionIds.set(message.id, executionId);
    const active: ActiveBatch = {
      executionId,
      messages: [...messages],
      controller: new AbortController(),
      cancelled: new Set(),
      accepting: true,
    };
    this.active = active;
    let heartbeat: NodeJS.Timeout | undefined;
    try {
      const context = await this.room.fetchMessages(this.state.lastProcessedSeq);
      // 先落盘执行意图，再调用 Provider：崩溃后据此判定"结果未知"而不是重跑
      this.state.inflight = {
        executionId,
        messageIds: messages.map((message) => message.id),
        startedAt: new Date().toISOString(),
      };
      await this.store.save(this.state);

      this.reportAll(active.messages, { status: "running", contextSeq: context.latestSeq });
      this.room.setTyping(true);
      let lastProgressAt = 0;
      let lastProgress: string | undefined;
      const reportProgress = (progress?: string) => {
        lastProgressAt = Date.now();
        if (progress) lastProgress = progress;
        this.reportAll(active.messages, {
          status: "running",
          ...(lastProgress ? { progress: lastProgress } : {}),
        });
      };
      heartbeat = setInterval(() => {
        if (Date.now() - lastProgressAt >= this.tuning.heartbeatMs) reportProgress();
      }, this.tuning.heartbeatMs);
      heartbeat.unref?.();

      const prompt = await this.buildPrompt(context.messages, messages);
      this.log(
        `[hive] 正在处理 ${messages.map((message) => `#${message.seq}`).join("、")}（来自 ${[...new Set(messages.map((message) => message.senderName))].join("、")}）`,
      );
      const reply = await this.responder.reply({
        instructions: this.instructions,
        prompt: prompt.text,
        refreshInstructions: prompt.full,
        signal: active.controller.signal,
        onProgress: (progress) => {
          if (Date.now() - lastProgressAt < this.tuning.progressThrottleMs) {
            lastProgress = progress.slice(0, 200);
            return;
          }
          reportProgress(progress.slice(0, 200));
        },
        ...(this.state.threadId ? { threadId: this.state.threadId } : {}),
      });
      active.accepting = false;
      if (reply.threadId) this.state.threadId = reply.threadId;
      this.notePromptSent(prompt);

      const content = reply.text.trim().slice(0, 4000);
      if (!content) throw new Error("Agent 回复为空。");
      const live = active.messages.filter(
        (message) => !this.recalled.has(message.id) && !active.cancelled.has(message.id),
      );
      const messagesAfterReply = await this.room.fetchMessages(context.latestSeq);
      const sentWithHiveTool = messagesAfterReply.messages.find(
        (message) => message.senderId === this.ownParticipantId,
      );
      let replyMessageId: string | undefined = sentWithHiveTool?.id;
      if (live.length === 0) {
        this.log("[hive] 本轮的触发消息都已被撤回或停止，不再发送回复");
      } else if (!sentWithHiveTool) {
        const sent = await this.room.sendMessage({
          content,
          // 同一次执行（含本地重试）复用幂等键；人重试时换新键，确保会发出新回复
          clientMessageId: `agent-reply-${executionId}`,
          parentMessageId: pickReplyParent(live).id,
        });
        replyMessageId = sent.id;
      } else {
        this.log("[hive] 已通过 hive_message_send 发送，不再重复代发。");
      }
      for (const message of active.messages) {
        this.recalled.delete(message.id);
        this.rememberProcessed(message.id);
      }
      this.state.lastProcessedSeq = Math.max(
        this.state.lastProcessedSeq,
        context.latestSeq,
        messagesAfterReply.latestSeq,
        ...active.messages.map((message) => message.seq),
      );
      delete this.state.inflight;
      // 先持久化"已处理"，再对外宣告完成：两步之间崩溃时宁可漏报，也不重复执行
      await this.store.save(this.state);
      this.reportAll(live, {
        status: "completed",
        ...(replyMessageId ? { replyMessageId } : {}),
      });
      this.log(`[hive] 已回复 ${active.messages.map((message) => `#${message.seq}`).join("、")}`);
    } catch (error) {
      await this.handleBatchError(active, error);
    } finally {
      active.accepting = false;
      if (heartbeat) clearInterval(heartbeat);
      this.room.setTyping(false);
      if (this.active === active) this.active = undefined;
    }
  }

  private async handleBatchError(active: ActiveBatch, error: unknown): Promise<void> {
    delete this.state.inflight;
    if (isCancelled(error, active.controller.signal)) {
      this.log("[hive] 当前回合已停止");
      for (const message of active.messages) this.rememberProcessed(message.id);
      await this.store.save(this.state);
      this.reportAll(active.messages, {
        status: "cancelled",
        ...(this.stopped ? { detail: "Agent 已下线，本轮被中断；可在界面中重试" } : {}),
      });
      return;
    }
    const reason = error instanceof Error ? error.message : String(error);
    this.log(`[hive] 处理 @mention 失败：${reason}`);
    const retryable: ChatMessage[] = [];
    const exhausted: ChatMessage[] = [];
    for (const message of active.messages) {
      const attempt = (this.attempts.get(message.id) ?? 0) + 1;
      this.attempts.set(message.id, attempt);
      if (attempt < MAX_ATTEMPTS) retryable.push(message);
      else exhausted.push(message);
    }
    // 本地重试耗尽：作为"死信"交给人处理，不再在重连时自动补做（先落盘再上报）
    for (const message of exhausted) this.rememberProcessed(message.id);
    await this.store.save(this.state);
    for (const message of exhausted) {
      this.log(
        `[hive] #${message.seq} 连续失败 ${MAX_ATTEMPTS} 次，已标记为失败，可在界面中重试。`,
      );
      this.room.report({
        messageId: message.id,
        status: "failed",
        detail: `连续失败 ${MAX_ATTEMPTS} 次：${reason}`.slice(0, 500),
      });
    }
    if (retryable.length === 0) return;
    const attempt = Math.max(...retryable.map((message) => this.attempts.get(message.id) ?? 1));
    this.reportAll(retryable, {
      status: "running",
      progress: `第 ${attempt} 次尝试失败，稍后自动重试`,
    });
    const timer = setTimeout(
      () => {
        if (this.stopped) return;
        this.pending.unshift(...retryable.filter((message) => !this.isLocal(message.id)));
        void this.drain();
      },
      1_000 * 2 ** (attempt - 1),
    );
    timer.unref?.();
  }

  /** 决定这一轮发完整上下文还是只发增量，并按需附带白板 */
  private async buildPrompt(
    context: ChatMessage[],
    triggers: ChatMessage[],
  ): Promise<{ text: string; full: boolean; whiteboardDigest?: string }> {
    const lastFull = this.state.lastFullPromptAt ? Date.parse(this.state.lastFullPromptAt) : 0;
    const full =
      !this.state.threadId ||
      (this.state.briefTurns ?? 0) >= this.tuning.fullPromptEveryTurns ||
      Date.now() - lastFull >= this.tuning.fullPromptEveryMs;
    let whiteboard: WhiteboardEntry[] | undefined;
    let whiteboardDigest: string | undefined;
    try {
      const entries = await this.room.fetchWhiteboard();
      whiteboardDigest = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
      if (entries.length > 0 && (full || whiteboardDigest !== this.state.whiteboardDigest)) {
        whiteboard = entries;
      }
    } catch (error) {
      this.log(`[hive] ${error instanceof Error ? error.message : String(error)}`);
    }
    let members;
    if (full) {
      members = await this.room.fetchParticipants().catch(() => undefined);
    }
    return {
      text: buildMentionPrompt({
        messages: context,
        triggers,
        mode: full ? "full" : "brief",
        agentName: this.options.username,
        ...(members ? { members } : {}),
        ...(whiteboard ? { whiteboard } : {}),
      }),
      full,
      ...(whiteboardDigest ? { whiteboardDigest } : {}),
    };
  }

  private notePromptSent(prompt: { full: boolean; whiteboardDigest?: string }): void {
    if (prompt.full) {
      this.state.briefTurns = 0;
      this.state.lastFullPromptAt = new Date().toISOString();
    } else {
      this.state.briefTurns = (this.state.briefTurns ?? 0) + 1;
    }
    if (prompt.whiteboardDigest) this.state.whiteboardDigest = prompt.whiteboardDigest;
  }
}
