import { createHash, randomUUID } from "node:crypto";
import {
  isMentioned,
  type ChatMessage,
  type Invocation,
  type InvocationReport,
  type RoomSummary,
  type WhiteboardEntry,
} from "./hive-protocol.js";
import {
  AgentExecutionUncertainError,
  AgentNonRetryableError,
  isCancelled,
  type AgentAccessMode,
  type AgentResponder,
} from "./responder.js";
import { resolveReplyText } from "./silent-reply.js";
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
import { AttachmentCache } from "./attachment-cache.js";
import {
  AttachmentPublisher,
  describeFailures,
  parseAttachmentDirective,
} from "./attachment-publisher.js";
import type { AttachmentPaths } from "./prompt-builder.js";

export function shouldProcessMention(input: {
  message: ChatMessage;
  username: string;
  ownParticipantId: string;
  processedMessageIds: string[];
  /**
   * 服务端已为本 Agent 建立了这条消息的调用（例如人回答了它的提问、没有再 @ 它）：
   * 服务端是派发的权威，正文里没有 @ 也要处理。
   */
  invited?: boolean;
}): boolean {
  return (
    !input.message.deletedAt &&
    input.message.senderId !== input.ownParticipantId &&
    (input.invited === true || isMentioned(input.message.content, input.username)) &&
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
  /** 多久未收到 Runtime 新进度时提示待核实；只告警，不自动取消或重试 */
  progressStaleMs?: number;
  /** 隔多少轮或多久重新发送一次完整上下文 */
  fullPromptEveryTurns?: number;
  fullPromptEveryMs?: number;
  /**
   * Agent 已经干完活、正要把结果交回时连不上 Server（例如 Server 正在换代重启），
   * 最多等这么久并反复重试，而不是把整轮当失败重跑一遍
   */
  offlineRetryMs?: number;
  offlineRetryIntervalMs?: number;
};

/** 连不上 Server 一类的错误：可以等 Server 回来再试，不代表这一轮做错了 */
export function isServerUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "TypeError" || error.name === "AbortError" || error.name === "TimeoutError")
    return true;
  return /ECONNREFUSED|ECONNRESET|fetch failed|socket hang up|聊天室连接|未在 15 秒内确认|\(5\d\d\)/.test(
    error.message,
  );
}

type ActiveBatch = {
  executionId: string;
  messages: ChatMessage[];
  controller: AbortController;
  cancelled: Set<string>;
  /** Provider 回合仍在进行、可以吸收 steer；回合结束后新消息改为排队 */
  accepting: boolean;
};

const MAX_ATTEMPTS = 3;
/** 这些 Provider 续接会话时不会换上新的系统 / 开发者规则（ACP 等由 refreshInstructions 重新注入） */
const RESUMED_SYSTEM_PROMPT_PROVIDERS = new Set(["claude", "codex"]);

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
  private readonly attachments: AttachmentCache | undefined;
  private readonly publisher: AttachmentPublisher | undefined;

  constructor(
    private readonly options: {
      serverUrl: string;
      roomId: string;
      username: string;
      persona: string;
      provider: string;
      token: string;
      access?: AgentAccessMode;
      /** 附件缓存目录；只读档不准备本地路径（它没有读文件工具），只能经 hive_attachment_read 读取 */
      attachmentCacheDir?: string;
      /** Agent 工作目录：回复里声明的附件只允许来自这里 */
      cwd?: string;
      /** 房间工作区没有采用时的原因，写进规则 */
      workspaceNote?: string;
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
      progressStaleMs: 120_000,
      fullPromptEveryTurns: 8,
      fullPromptEveryMs: 30 * 60_000,
      offlineRetryMs: 5 * 60_000,
      offlineRetryIntervalMs: 2_000,
      ...options.tuning,
    };
    this.attachments =
      options.attachmentCacheDir && options.access && options.access !== "read-only"
        ? new AttachmentCache({
            serverUrl: options.serverUrl,
            token: options.token,
            dir: options.attachmentCacheDir,
          })
        : undefined;
    this.publisher = options.cwd
      ? new AttachmentPublisher({
          serverUrl: options.serverUrl,
          roomId: options.roomId,
          token: options.token,
          cwd: options.cwd,
          access: options.access ?? "read-only",
        })
      : undefined;
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
        onMention: (message, _latestSeq, retry) => this.enqueue(message, { retry, invited: true }),
        onCancel: (messageId) => this.cancel(messageId),
        onMessageDeleted: (message) => this.onRecalled(message.id),
        ...(this.options.onRoomsChanged ? { onRoomsChanged: this.options.onRoomsChanged } : {}),
        onError: (error) => {
          this.log(`[hive] ${error.message}`);
          if (error instanceof RoomClientError && error.code === "ROOM_ARCHIVED") {
            this.options.onArchived?.();
          }
          // 凭限时邀请带入的 Agent：访客到期或被房主移除后不再重连，直接离开这个房间
          if (
            error instanceof RoomClientError &&
            (error.code === "SESSION_EXPIRED" || error.code === "SESSION_REVOKED")
          ) {
            this.log("[hive] 访问期限已到或已被房主移除，离开这个房间。");
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
      ...(this.options.cwd
        ? {
            workspace: {
              cwd: this.options.cwd,
              ...(this.options.workspaceNote ? { note: this.options.workspaceNote } : {}),
            },
          }
        : {}),
    });
    // 换了工作目录：旧会话（Codex 线程、Claude 续接）会沿用旧目录，丢掉它从新会话开始；消息游标保留
    if (this.options.cwd && this.state.workspace !== this.options.cwd) {
      if (this.state.threadId && this.state.workspace) {
        this.log(`[hive] 房间工作目录已改为 ${this.options.cwd}，开始新的会话`);
        delete this.state.threadId;
      }
      this.state.workspace = this.options.cwd;
    }
    await this.recoverInterruptedExecution();
    this.room.start();
    this.log(
      `[hive] ${this.options.username} 正在连接 ${this.options.serverUrl}/${this.options.roomId}`,
    );
  }

  /** 没有正在执行、排队或待恢复的回合时返回；切换房间工作区前用它等这一轮做完 */
  async whenIdle(pollMs = 500): Promise<void> {
    while (!this.stopped && (this.active || this.pending.length > 0 || this.state?.inflight)) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
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
        status: "uncertain",
        detail: "Agent 在处理途中意外退出，结果未知；未自动重跑，需先核对原执行与工具进程。",
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
      // 首次加入不回放历史聊天，但服务端仍为本 Agent 挂着的 queued 调用要接着做，
      // 否则这些 @ 永远没人处理，最后被扫成"结果未知"
      const queued = new Set(
        (snapshot.invocations ?? [])
          .filter(
            (invocation) =>
              invocation.agentId === this.ownParticipantId && invocation.status === "queued",
          )
          .map((invocation) => invocation.messageId),
      );
      this.state.lastProcessedSeq = snapshot.latestSeq;
      this.stateExisted = true;
      await this.store.save(this.state);
      for (const message of snapshot.messages) {
        if (queued.delete(message.id)) this.enqueue(message, { invited: true });
      }
      // 快照只带最近的消息；更早的提及拿不到原文，如实报告并交给人决定是否重试
      for (const messageId of queued) {
        this.room.report({
          messageId,
          status: "failed",
          detail: "Agent 首次加入时这条提及已超出补拉范围，未处理；可手动重试。",
        });
      }
      return;
    }
    const known = new Map<string, Invocation>();
    for (const invocation of snapshot.invocations ?? []) {
      if (invocation.agentId === this.ownParticipantId) known.set(invocation.messageId, invocation);
    }
    const missed = await this.room.fetchMessages(this.state.lastProcessedSeq);
    for (const message of missed.messages) {
      const invocation = known.get(message.id);
      if (!this.isEligible(message, Boolean(invocation))) continue;
      // 服务端是调用状态的权威：被拦下、已停止或已结束的提及不再补做
      if (snapshot.invocations && invocation && invocation.status !== "queued") {
        if (
          (invocation.status === "running" || invocation.status === "timed_out") &&
          !this.isLocal(message.id)
        ) {
          this.room.report({
            messageId: message.id,
            status: "uncertain",
            detail: "Agent 重新连接时这次处理已不在进行，结果未知；需先核对原执行与工具进程。",
          });
          this.rememberProcessed(message.id);
        }
        continue;
      }
      this.enqueue(message, { invited: Boolean(invocation) });
    }
    await this.store.save(this.state);
  }

  private isEligible(message: ChatMessage, invited = false): boolean {
    return shouldProcessMention({
      message,
      username: this.options.username,
      ownParticipantId: this.ownParticipantId,
      processedMessageIds: this.state.processedMessageIds,
      invited,
    });
  }

  private isLocal(messageId: string): boolean {
    return (
      this.steering.has(messageId) ||
      this.pending.some((message) => message.id === messageId) ||
      Boolean(this.active?.messages.some((message) => message.id === messageId))
    );
  }

  private enqueue(
    message: ChatMessage,
    options: { retry?: boolean; invited?: boolean } = {},
  ): void {
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
    if (this.isLocal(message.id) || !this.isEligible(message, options.invited)) return;
    if (this.cancelledEarly.delete(message.id)) {
      this.rememberProcessed(message.id);
      void this.store
        .save(this.state)
        .then(() => {
          this.room.report({
            messageId: message.id,
            status: "cancelled",
            detail: "任务在执行前被取消",
          });
        })
        .catch(() => this.room.report({ messageId: message.id, status: "uncertain" }));
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
      steered = await this.responder.steer!(
        buildSteerPrompt(message, await this.attachmentPaths([message])),
      );
    } catch (error) {
      if (error instanceof AgentExecutionUncertainError) {
        this.rememberProcessed(message.id);
        await this.store.save(this.state);
        this.room.report({
          messageId: message.id,
          status: "uncertain",
          detail: "消息已尝试注入但未获确认；禁止退回队列或自动重放。",
        });
        return;
      }
      steered = false;
    } finally {
      this.steering.delete(message.id);
    }
    if (this.cancelledEarly.delete(message.id)) {
      if (steered && this.active === active && active.accepting) {
        active.messages.push(message);
        active.cancelled.add(message.id);
      } else if (!steered) {
        this.rememberProcessed(message.id);
        await this.store.save(this.state);
        this.room.report({
          messageId: message.id,
          status: "cancelled",
          detail: "未注入的排队任务已移除",
        });
      } else {
        this.room.report({
          messageId: message.id,
          status: "uncertain",
          detail: "取消与注入并发，执行结果需核对",
        });
      }
      return;
    }
    // A confirmed steer that races completion may already have run; never queue it twice.
    if (steered && (this.active !== active || !active.accepting)) {
      this.rememberProcessed(message.id);
      await this.store.save(this.state);
      this.room.report({
        messageId: message.id,
        status: "uncertain",
        detail: "消息注入与回合结束并发，结果待核实；禁止自动重放。",
      });
      return;
    }
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
      void this.store
        .save(this.state)
        .then(() => {
          this.room.report({ messageId, status: "cancelled", detail: "尚未执行的排队任务已移除" });
        })
        .catch(() =>
          this.room.report({
            messageId,
            status: "uncertain",
            detail: "无法持久化取消结果，需核对",
          }),
        );
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
      // Bridge 存活不等于 Runtime 在推进；心跳不得刷新最后一次真实进度的时间。
      let lastRuntimeProgressAt = Date.now();
      let lastProgressReportAt: number | undefined;
      let lastRuntimeReportAt: number | undefined;
      let lastProgress: string | undefined;
      let lastActivityKey: string | undefined;
      let lastActivityReportAt: number | undefined;
      const reportProgress = (progress: string) => {
        lastProgressReportAt = Date.now();
        this.reportAll(active.messages, { status: "running", progress: progress.slice(0, 200) });
      };
      heartbeat = setInterval(() => {
        const now = Date.now();
        if (
          lastProgressReportAt !== undefined &&
          now - lastProgressReportAt < this.tuning.heartbeatMs
        ) {
          return;
        }
        const idleMs = Math.max(0, now - lastRuntimeProgressAt);
        const seconds = Math.floor(idleMs / 1000);
        const elapsed =
          seconds >= 60 ? `${Math.floor(seconds / 60)}分${seconds % 60}秒` : `${seconds}秒`;
        const warning = idleMs >= this.tuning.progressStaleMs ? "，状态待核实" : "";
        reportProgress(
          `仅 Bridge 心跳；${elapsed}未收到 Runtime 新进度${warning}${lastProgress ? `；上次：${lastProgress}` : ""}`,
        );
      }, this.tuning.heartbeatMs);
      heartbeat.unref?.();

      const prompt = await this.buildPrompt(this.applyTopicBoundary(context.messages), messages);
      this.log(
        `[hive] 正在处理 ${messages.map((message) => `#${message.seq}`).join("、")}（来自 ${[...new Set(messages.map((message) => message.senderName))].join("、")}）`,
      );
      const reply = await this.responder.reply({
        instructions: this.instructions,
        prompt: prompt.text,
        refreshInstructions: prompt.full,
        signal: active.controller.signal,
        onProgress: (progress) => {
          if (this.active !== active || active.controller.signal.aborted) return;
          lastRuntimeProgressAt = Date.now();
          lastProgress = progress.slice(0, 200);
          if (
            lastRuntimeReportAt !== undefined &&
            lastRuntimeProgressAt - lastRuntimeReportAt < this.tuning.progressThrottleMs
          ) {
            return;
          }
          lastRuntimeReportAt = lastRuntimeProgressAt;
          lastProgressReportAt = Date.now();
          this.reportAll(active.messages, {
            status: "running",
            progress: lastProgress,
            runtimeEvent: { kind: "activity", phase: "working" },
          });
        },
        onRuntimeEvent: (event) => {
          if (this.active !== active || active.controller.signal.aborted) return;
          const now = Date.now();
          if (event.kind === "activity" || event.kind === "recovered") lastRuntimeProgressAt = now;
          if (event.kind === "activity") {
            const key = `${event.phase}:${event.tool ?? ""}`;
            if (
              key === lastActivityKey &&
              lastActivityReportAt !== undefined &&
              now - lastActivityReportAt < this.tuning.progressThrottleMs
            )
              return;
            lastActivityKey = key;
            lastActivityReportAt = now;
            lastProgress =
              event.phase === "tool_running"
                ? "Runtime 正在执行工具"
                : event.phase === "tool_completed"
                  ? "Runtime 工具已返回（不代表任务完成）"
                  : event.phase === "starting"
                    ? "正在启动 Runtime"
                    : event.phase === "working"
                      ? "收到 Runtime 执行事件"
                      : "收到模型响应事件";
          }
          if (event.kind === "provider_error") lastProgress = "API 异常，等待恢复证据";
          if (event.kind === "recovered") lastProgress = "收到模型恢复证据";
          lastProgressReportAt = now;
          this.reportAll(
            active.messages.filter((message) => !active.cancelled.has(message.id)),
            {
              status: "running",
              runtimeEvent: event,
              ...(event.kind !== "capabilities" && lastProgress ? { progress: lastProgress } : {}),
            },
          );
        },
        ...(this.state.threadId ? { threadId: this.state.threadId } : {}),
      });
      active.accepting = false;
      if (reply.threadId) this.state.threadId = reply.threadId;
      this.notePromptSent(prompt);

      const resolved = resolveReplyText(reply.text);
      const directive = parseAttachmentDirective(resolved.silent ? "" : resolved.text);
      let content = directive.text;
      if (!resolved.silent && !content && directive.paths.length === 0) {
        throw new Error("Agent 回复为空。");
      }
      const live = active.messages.filter(
        (message) => !this.recalled.has(message.id) && !active.cancelled.has(message.id),
      );
      // 结果已经出来了：之后与 Server 的往来如果赶上它重启，等它回来再交，不把整轮重跑
      const messagesAfterReply = await this.whenOnline("补拉回复前后的消息", () =>
        this.room.fetchMessages(context.latestSeq),
      );
      // 经 hive_invoke 发出的委派、hive_ask_human 提的问题只是中间动作，不能当成这一轮的回复，否则最终答复会被吞掉
      const sentWithHiveTool = messagesAfterReply.messages.find(
        (message) =>
          message.senderId === this.ownParticipantId &&
          message.kind !== "delegation" &&
          message.kind !== "question",
      );
      let replyMessageId: string | undefined = sentWithHiveTool?.id;
      if (live.length === 0) {
        this.log("[hive] 本轮的触发消息都已被撤回或停止，不再发送回复");
      } else if (!sentWithHiveTool && resolved.silent) {
        this.log(
          `[hive] ${live.map((message) => `#${message.seq}`).join("、")} 无需回复，未发送消息`,
        );
      } else if (!sentWithHiveTool) {
        // 回复里声明的产物由本机 Bridge 上传成附件，随回复一起发出
        let attachmentIds: string[] = [];
        if (directive.paths.length) {
          const publisher = this.publisher;
          const published = publisher
            ? await this.whenOnline("上传附件", () => publisher.publish(directive.paths))
            : {
                attachmentIds: [],
                failures: directive.paths.map((item) => ({
                  path: item,
                  reason: "这个 Agent 没有配置工作目录，不能发布文件",
                })),
              };
          attachmentIds = published.attachmentIds;
          content = `${content}${describeFailures(published.failures)}`.trim();
          for (const failure of published.failures) {
            this.log(`[hive] 附件 ${failure.path} 未发出：${failure.reason}`);
          }
        }
        const sent = await this.whenOnline("发送回复", () =>
          this.room.sendMessage({
            content,
            ...(attachmentIds.length ? { attachmentIds } : {}),
            // 同一次执行（含本地重试）复用幂等键；人重试时换新键，确保会发出新回复
            clientMessageId: `agent-reply-${executionId}`,
            parentMessageId: pickReplyParent(live).id,
          }),
        );
        replyMessageId = sent.id;
      } else {
        this.log("[hive] 已通过 hive_message_send 发送，不再重复代发。");
        if (directive.paths.length) {
          this.log(
            "[hive] 回复里声明的附件只随 Bridge 代发的回复发出，这次已用工具发送，附件未发出",
          );
        }
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
      this.reportAll(
        active.messages.filter((message) => active.cancelled.has(message.id)),
        {
          status: "cancelled",
          detail: "本轮已结束，已停止的触发消息未发送回复",
        },
      );
      this.reportAll(live, {
        status: "completed",
        ...(replyMessageId ? { replyMessageId } : { detail: "无需回复" }),
      });
      this.log(
        `[hive] ${replyMessageId ? "已回复" : "已处理"} ${active.messages.map((message) => `#${message.seq}`).join("、")}`,
      );
    } catch (error) {
      await this.handleBatchError(active, error);
    } finally {
      active.accepting = false;
      if (heartbeat) clearInterval(heartbeat);
      this.room.setTyping(false);
      if (this.active === active) this.active = undefined;
    }
  }

  /** 连不上 Server 时等它回来再试；超过 offlineRetryMs 或遇到其它错误照常抛出 */
  private async whenOnline<T>(label: string, action: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + this.tuning.offlineRetryMs;
    let warned = false;
    for (;;) {
      try {
        return await action();
      } catch (error) {
        if (this.stopped || !isServerUnavailable(error) || Date.now() >= deadline) throw error;
        if (!warned) {
          warned = true;
          this.log(`[hive] ${label}时连不上 Hive Server，等它恢复后重试`);
        }
        await new Promise((resolve) => setTimeout(resolve, this.tuning.offlineRetryIntervalMs));
      }
    }
  }

  private async handleBatchError(active: ActiveBatch, error: unknown): Promise<void> {
    delete this.state.inflight;
    if (error instanceof AgentExecutionUncertainError) {
      // The provider may have completed side effects before its result stream was lost.
      for (const message of active.messages) this.rememberProcessed(message.id);
      await this.store.save(this.state);
      this.reportAll(active.messages, {
        status: "uncertain",
        detail: "执行结果未知，已禁止自动重放；请先核对已执行操作与相关进程，再决定是否手动重试。",
      });
      return;
    }
    if (error instanceof AgentNonRetryableError) {
      for (const message of active.messages) this.rememberProcessed(message.id);
      await this.store.save(this.state);
      this.reportAll(active.messages, { status: "failed", detail: error.message.slice(0, 500) });
      this.log(`[hive] Codex 调用不可自动重试：${error.message}`);
      return;
    }
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

  /**
   * 有人开启了新话题（或房主清空了房间）：丢弃 Provider 旧会话，上下文只保留分隔之后的消息。
   * 在每轮开始时检查而不是监听事件：Agent 离线期间发生的分隔，上线后第一轮同样生效。
   */
  private applyTopicBoundary(context: ChatMessage[]): ChatMessage[] {
    const boundary = context.filter((message) => message.kind === "topic").at(-1);
    if (!boundary) return context;
    if (boundary.seq > (this.state.topicSeq ?? 0)) {
      this.state.topicSeq = boundary.seq;
      if (this.state.threadId) {
        this.log(`[hive] #${boundary.seq} 开启了新话题，丢弃之前的会话，从新会话开始`);
        delete this.state.threadId;
      }
    }
    return context.filter((message) => message.seq > boundary.seq);
  }

  /** 决定这一轮发完整上下文还是只发增量，并按需附带白板 */
  private async buildPrompt(
    context: ChatMessage[],
    triggers: ChatMessage[],
  ): Promise<{ text: string; full: boolean; whiteboardDigest?: string }> {
    const lastFull = this.state.lastFullPromptAt ? Date.parse(this.state.lastFullPromptAt) : 0;
    const full =
      !this.state.threadId ||
      this.state.instructionsDigest !== this.instructionsDigest() ||
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
    const attachmentPaths = await this.attachmentPaths([...context, ...triggers]);
    // Claude --resume 与 Codex 线程都沿用会话创建时的系统规则：规则更新后在这一轮把完整新规则补发一次
    const rulesUpdated =
      Boolean(this.state.threadId && this.state.instructionsDigest) &&
      this.state.instructionsDigest !== this.instructionsDigest() &&
      RESUMED_SYSTEM_PROMPT_PROVIDERS.has(this.options.provider);
    const prompt = buildMentionPrompt({
      messages: context,
      triggers,
      mode: full ? "full" : "brief",
      agentName: this.options.username,
      ...(members ? { members } : {}),
      ...(whiteboard ? { whiteboard } : {}),
      attachmentPaths,
    });
    return {
      text: rulesUpdated
        ? `你的工作规则已更新，以下为完整的新规则，与之前的规则冲突时以这里为准：\n<updated_rules>\n${this.instructions}\n</updated_rules>\n\n${prompt}`
        : prompt,
      full,
      ...(whiteboardDigest ? { whiteboardDigest } : {}),
    };
  }

  /** 为消息里的附件准备本机路径；拿不到的只在日志里记一笔，Agent 仍可改用 hive_attachment_read */
  private async attachmentPaths(messages: ChatMessage[]): Promise<AttachmentPaths> {
    const cache = this.attachments;
    if (!cache) return {};
    const items = messages.flatMap((message) =>
      message.deletedAt ? [] : (message.attachments ?? []),
    );
    const paths: AttachmentPaths = {};
    await Promise.all(
      items.map(async (item) => {
        const located = await cache.locate(item);
        if ("path" in located) paths[item.id] = located.path;
        else this.log(`[hive] 附件 ${item.name}：${located.error}`);
      }),
    );
    return paths;
  }

  private instructionsDigest(): string {
    return createHash("sha256").update(this.instructions).digest("hex").slice(0, 16);
  }

  private notePromptSent(prompt: { full: boolean; whiteboardDigest?: string }): void {
    if (prompt.full) {
      this.state.briefTurns = 0;
      this.state.lastFullPromptAt = new Date().toISOString();
      this.state.instructionsDigest = this.instructionsDigest();
    } else {
      this.state.briefTurns = (this.state.briefTurns ?? 0) + 1;
    }
    if (prompt.whiteboardDigest) this.state.whiteboardDigest = prompt.whiteboardDigest;
  }
}
