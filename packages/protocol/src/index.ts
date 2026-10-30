import { z } from "zod";

export const LIMITS = {
  /** 一条 Agent 转交链的最大深度；人追加轮数时同步放宽，人一发言即恢复默认 */
  maxHopCount: 12,
  /** 一条转交链内 Agent 消息总数；同样随人追加的轮数放宽 */
  maxAgentMessagesPerTrace: 40,
  /** 单个 Agent 每分钟最多发言条数，防止失控刷屏 */
  maxAgentRepliesPerMinute: 12,
  /** 防止误粘巨型文件；展示折叠和模型上下文预算与此保护上限分开。单位为 UTF-16 code units。 */
  maxMessageLength: 100_000,
  /** 容纳上限内正文的 UTF-8 / JSON 转义开销，同时限制传输层的内存占用。 */
  maxClientPayloadBytes: 1_048_576,
  /** 自上一条人类消息以来，房间内 Agent 发言触发其他 Agent 的最多轮数；人一发言即清零 */
  maxConsecutiveAgentTurns: 16,
  /** 同一对 Agent（发起方 → 目标）在一个房间里 24 小时内的最多唤醒次数 */
  maxAgentPairTurnsPerDay: 100,
  /** running 调用超过这么久没有任何回报，视为结果未知（timed_out） */
  invocationStaleMs: 10 * 60_000,
  /** Agent 在线却一直没确认收到 @，视为投递未被接收 */
  invocationUnacknowledgedMs: 2 * 60_000,
  maxWhiteboardEntriesPerSlot: 50,
} as const;

export const participantTypeSchema = z.enum(["human", "agent"]);
export const participantStatusSchema = z.enum(["online", "offline", "busy"]);
export const agentProviderSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9_.-]+$/);

export const participantSchema = z.object({
  id: z.string().uuid(),
  roomId: z.string().min(1).max(64),
  username: z.string().min(1).max(32),
  type: participantTypeSchema,
  status: participantStatusSchema,
  persona: z.string().max(500).optional(),
  provider: agentProviderSchema.optional(),
  joinedAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
});

export const chatMessageSchema = z.object({
  id: z.string().uuid(),
  roomId: z.string().min(1).max(64),
  seq: z.number().int().positive(),
  senderId: z.string().uuid(),
  senderName: z.string(),
  senderType: participantTypeSchema,
  // 已撤回的消息正文会被清空，因此不要求 min(1)
  content: z.string().max(LIMITS.maxMessageLength),
  mentions: z.array(z.string()),
  replyToMessageId: z.string().uuid().optional(),
  traceId: z.string().uuid(),
  parentMessageId: z.string().uuid().optional(),
  hopCount: z.number().int().min(0),
  clientMessageId: z.string().min(1).max(100).optional(),
  createdAt: z.string().datetime(),
  deletedAt: z.string().datetime().optional(),
  /**
   * topic：话题分隔（有人开启了新话题，或房主清空了房间）。
   * Agent 遇到它会丢弃之前的 Provider 会话，只把分隔之后的消息当作上下文。
   * delegation：Agent 经 hive_invoke 委派子任务时发出的消息；只是中间动作，不算这一轮的回复。
   * receipt：子任务结束后服务端代被委派方发给委派方的结果回执。
   * question：Agent 经 hive_ask_human 向人提的问题；人回复它即可把答案交回并唤醒提问的 Agent。
   */
  kind: z.enum(["topic", "delegation", "receipt", "question"]).optional(),
});

export const participantJoinEventSchema = z.object({
  type: z.literal("participant.join"),
  username: z.string().trim().min(1).max(32),
  participantType: participantTypeSchema,
  roomId: z.string().trim().min(1).max(64).default("general"),
  token: z.string().min(1).max(256),
  persona: z.string().trim().max(500).optional(),
  provider: agentProviderSchema.optional(),
});

export const messageSendEventSchema = z.object({
  type: z.literal("message.send"),
  clientMessageId: z.string().min(1).max(100),
  content: z.string().trim().min(1).max(LIMITS.maxMessageLength),
  replyToMessageId: z.string().uuid().optional(),
  parentMessageId: z.string().uuid().optional(),
});

export const heartbeatEventSchema = z.object({ type: z.literal("presence.heartbeat") });
export const typingEventSchema = z.object({
  type: z.literal("agent.typing"),
  active: z.boolean(),
});
export const messageAckEventSchema = z.object({
  type: z.literal("message.ack"),
  seq: z.number().int().nonnegative(),
});
export const messageDeleteEventSchema = z.object({
  type: z.literal("message.delete"),
  messageId: z.string().uuid(),
});
/** 人开启新话题：服务端插入一条 kind=topic 的分隔消息 */
export const topicStartEventSchema = z.object({ type: z.literal("topic.start") });

/**
 * 一次 @ 唤醒对应一条 invocation：服务端在派发 agent.mentioned 时创建，
 * Agent 回报开工/进度/结束，人可以重试、停止或为被预算拦下的调用"续命"。
 * timed_out 表示"结果未知"，不等于失败；迟到的结果仍可以把它推进到终态。
 */
export const invocationStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "blocked",
  "timed_out",
  "cancelling",
  "cancelled",
  /**
   * Agent 经 hive_ask_human 提了问题、在等人回答：不计入卡住超时，轮次结束后也保持此状态；
   * 人回复问题消息后转为 completed，并以回答消息重新唤醒该 Agent。
   */
  "waiting_human",
]);
export const invocationBlockReasonSchema = z.enum(["hop_limit", "consecutive_limit", "pair_limit"]);

/** Structured runtime telemetry: deliberately excludes raw errors, tool arguments and model text. */
export const runtimeEventSchema = z
  .object({
    kind: z.enum(["capabilities", "activity", "provider_error", "recovered"]),
    observability: z.enum(["partial", "full", "heartbeat"]).optional(),
    phase: z.enum(["starting", "working", "thinking", "tool_running", "tool_completed"]).optional(),
    tool: z.enum(["read", "write", "search", "command", "collaboration", "other"]).optional(),
    code: z.number().int().min(100).max(599).optional(),
    retryAttempt: z.number().int().min(1).max(1000).optional(),
    retryInMs: z.number().int().min(0).max(86_400_000).optional(),
  })
  .strict();
export const runtimeTimelineEntrySchema = runtimeEventSchema.extend({ at: z.string().datetime() });
export const runtimeObservationSchema = z.object({
  observability: z.enum(["partial", "full", "heartbeat"]),
  lastHeartbeatAt: z.string().datetime(),
  lastRuntimeEventAt: z.string().datetime().optional(),
  lastProgressAt: z.string().datetime().optional(),
  tool: z.enum(["read", "write", "search", "command", "collaboration", "other"]).optional(),
  phase: z.enum(["starting", "working", "thinking", "tool_running", "tool_completed"]).optional(),
  lastError: z
    .object({
      at: z.string().datetime(),
      code: z.number().int().min(100).max(599).optional(),
      retryAttempt: z.number().int().min(1).max(1000).optional(),
      nextRetryAt: z.string().datetime().optional(),
      recoveredAt: z.string().datetime().optional(),
    })
    .optional(),
  history: z.array(runtimeTimelineEntrySchema).max(12),
});
export type RuntimeEvent = z.infer<typeof runtimeEventSchema>;
export type RuntimeObservation = z.infer<typeof runtimeObservationSchema>;

export const invocationSchema = z.object({
  id: z.string().uuid(),
  roomId: z.string().min(1).max(64),
  messageId: z.string().uuid(),
  agentId: z.string().uuid(),
  agentName: z.string(),
  /** 发起方成员 ID；同名成员改名或重建后仍能准确追溯 */
  requesterId: z.string().uuid().optional(),
  requesterName: z.string(),
  requesterType: participantTypeSchema,
  /**
   * 发起这次调用时，发起方 Agent 正在执行的调用（委派或转交的上游）。
   * 人直接发起的调用没有上游；任务概览据此画出真实的委派关系，而不是按名字拼凑。
   */
  parentInvocationId: z.string().uuid().optional(),
  /**
   * 经 hive_invoke 委派的子任务：结束后服务端自动把结果回执给委派方。
   * pending=待回执；delivered=已发出回执消息；consumed=委派方已用 hive_wait 拿到结果；
   * failed=回执无法投递（例如链条已到深度上限）。
   */
  continuation: z.enum(["pending", "delivered", "consumed", "failed"]).optional(),
  status: invocationStatusSchema,
  blockReason: invocationBlockReasonSchema.optional(),
  detail: z.string().max(500).optional(),
  progress: z.string().max(200).optional(),
  runtime: runtimeObservationSchema.optional(),
  replyMessageId: z.string().uuid().optional(),
  attempts: z.number().int().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  receivedAt: z.string().datetime().optional(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
});

export const whiteboardSlotSchema = z.enum(["ready", "in_progress", "blocked", "milestone"]);

export const whiteboardEntrySchema = z.object({
  id: z.string().uuid(),
  roomId: z.string().min(1).max(64),
  key: z.string().min(1).max(100),
  slot: whiteboardSlotSchema,
  summary: z.string().min(1).max(500),
  repo: z.string().max(200).optional(),
  branch: z.string().max(200).optional(),
  commit: z.string().max(100).optional(),
  unblocks: z.array(z.string().max(100)).max(20).default([]),
  authorId: z.string().uuid(),
  authorName: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/** Agent 回报自己对某条 @ 的处理进展；received 只确认送达，不改变 queued 状态 */
export const invocationReportEventSchema = z.object({
  type: z.literal("invocation.report"),
  messageId: z.string().uuid(),
  status: z.enum(["received", "running", "completed", "failed", "cancelled", "uncertain"]),
  detail: z.string().trim().max(500).optional(),
  progress: z.string().trim().max(200).optional(),
  runtimeEvent: runtimeEventSchema.optional(),
  replyMessageId: z.string().uuid().optional(),
  /** Agent 本轮已读到的公共消息 seq，Hive MCP 据此只附带之后的新消息 */
  contextSeq: z.number().int().nonnegative().optional(),
});
export const invocationRetryEventSchema = z.object({
  type: z.literal("invocation.retry"),
  invocationId: z.string().uuid(),
});
export const invocationCancelEventSchema = z.object({
  type: z.literal("invocation.cancel"),
  invocationId: z.string().uuid(),
});
/** 人为当前房间的 Agent 互相对话追加 N 轮预算，并恢复被预算拦下的调用 */
export const budgetExtendEventSchema = z.object({
  type: z.literal("budget.extend"),
  turns: z.number().int().min(1).max(50),
});
export const whiteboardRemoveEventSchema = z.object({
  type: z.literal("whiteboard.remove"),
  entryId: z.string().uuid(),
});

export const clientEventSchema = z.discriminatedUnion("type", [
  participantJoinEventSchema,
  messageSendEventSchema,
  heartbeatEventSchema,
  typingEventSchema,
  messageAckEventSchema,
  messageDeleteEventSchema,
  topicStartEventSchema,
  invocationReportEventSchema,
  invocationRetryEventSchema,
  invocationCancelEventSchema,
  budgetExtendEventSchema,
  whiteboardRemoveEventSchema,
]);

export const roomSnapshotEventSchema = z.object({
  type: z.literal("room.snapshot"),
  self: participantSchema,
  participants: z.array(participantSchema),
  messages: z.array(chatMessageSchema),
  latestSeq: z.number().int().nonnegative(),
  invocations: z.array(invocationSchema).default([]),
  whiteboard: z.array(whiteboardEntrySchema).default([]),
});
export const messageCreatedEventSchema = z.object({
  type: z.literal("message.created"),
  message: chatMessageSchema,
});
// 撤回后广播整条墓碑消息（content 已清空、deletedAt 已设置），客户端按 id 覆盖即可
export const messageDeletedEventSchema = z.object({
  type: z.literal("message.deleted"),
  message: chatMessageSchema,
});
/** 房主清空了房间：消息和调用记录已删除，message 是清空后插入的话题分隔 */
export const roomClearedEventSchema = z.object({
  type: z.literal("room.cleared"),
  message: chatMessageSchema,
});
export const agentMentionedEventSchema = z.object({
  type: z.literal("agent.mentioned"),
  message: chatMessageSchema,
  latestSeq: z.number().int().nonnegative(),
  /** 人在 UI 中显式重试：Agent 应忽略本地"已处理"记录重新执行 */
  retry: z.boolean().optional(),
});
export const agentCancelEventSchema = z.object({
  type: z.literal("agent.cancel"),
  messageId: z.string().uuid(),
});
export const invocationUpdatedEventSchema = z.object({
  type: z.literal("invocation.updated"),
  invocation: invocationSchema,
});
export const whiteboardUpdatedEventSchema = z.object({
  type: z.literal("whiteboard.updated"),
  entry: whiteboardEntrySchema,
});
export const whiteboardRemovedEventSchema = z.object({
  type: z.literal("whiteboard.removed"),
  roomId: z.string(),
  entryId: z.string().uuid(),
});
export const presenceChangedEventSchema = z.object({
  type: z.literal("presence.changed"),
  participant: participantSchema,
});
export const serverErrorEventSchema = z.object({
  type: z.literal("error"),
  code: z.string(),
  message: z.string(),
});

export const roomIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

export const roomSummarySchema = z.object({
  id: roomIdSchema,
  name: z.string().min(1).max(64),
  createdAt: z.string().datetime(),
  createdBy: z.string().max(32).optional(),
  archivedAt: z.string().datetime().optional(),
  onlineCount: z.number().int().nonnegative(),
  latestSeq: z.number().int().nonnegative(),
});

export const roomsChangedEventSchema = z.object({
  type: z.literal("rooms.changed"),
  room: roomSummarySchema,
});

export const roomActivityEventSchema = z.object({
  type: z.literal("room.activity"),
  roomId: z.string(),
  latestSeq: z.number().int().nonnegative(),
  onlineCount: z.number().int().nonnegative(),
});

export const serverEventSchema = z.discriminatedUnion("type", [
  roomSnapshotEventSchema,
  messageCreatedEventSchema,
  messageDeletedEventSchema,
  roomClearedEventSchema,
  agentMentionedEventSchema,
  agentCancelEventSchema,
  invocationUpdatedEventSchema,
  whiteboardUpdatedEventSchema,
  whiteboardRemovedEventSchema,
  presenceChangedEventSchema,
  roomsChangedEventSchema,
  roomActivityEventSchema,
  serverErrorEventSchema,
]);

export const messagesResponseSchema = z.object({
  messages: z.array(chatMessageSchema),
  latestSeq: z.number().int().nonnegative(),
});

export const whiteboardResponseSchema = z.object({
  entries: z.array(whiteboardEntrySchema),
});

export const invocationsResponseSchema = z.object({
  invocations: z.array(invocationSchema),
});

export const participantsResponseSchema = z.object({
  participants: z.array(participantSchema),
});

export const roomsResponseSchema = z.object({
  rooms: z.array(roomSummarySchema),
});

export const createRoomRequestSchema = z.object({
  id: roomIdSchema,
  name: z.string().trim().min(1).max(64).optional(),
  createdBy: z.string().trim().min(1).max(32).optional(),
});

export const updateRoomRequestSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  archived: z.boolean().optional(),
});

export const metaResponseSchema = z.object({
  name: z.string(),
  roomId: z.string(),
  httpUrl: z.string().url(),
  wsUrl: z.string().url(),
  mcpUrl: z.string().url(),
  joinToken: z.string(),
  agentCommand: z.string(),
});

/* ---------- 本机 Agent（仅 Hive Server 所在电脑上的房主可用） ---------- */

/** 可以由本机一键启动的 Provider */
export const localAgentProviderSchema = z.enum([
  "codex",
  "claude",
  "copilot",
  "opencode",
  "omp",
  "openclaw",
]);
export const localAgentAccessSchema = z.enum(["read-only", "workspace", "full"]);
export const localAgentStatusSchema = z.enum([
  "starting",
  "running",
  "restarting",
  "stopped",
  "crashed",
]);

export const createLocalAgentRequestSchema = z.object({
  provider: localAgentProviderSchema,
  name: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .regex(/^[\p{L}\p{N}_.-]+$/u),
  access: localAgentAccessSchema,
  /** workspace / full 必填：本机绝对路径 */
  cwd: z.string().trim().min(1).max(4096).optional(),
  model: z.string().trim().min(1).max(200).optional(),
});

export const localAgentSchema = z.object({
  id: z.string().uuid(),
  provider: localAgentProviderSchema,
  name: z.string(),
  access: localAgentAccessSchema,
  cwd: z.string().nullable(),
  model: z.string().nullable(),
  status: localAgentStatusSchema,
  pid: z.number().int().nullable(),
  startedAt: z.string().datetime().nullable(),
  lastExitCode: z.number().int().nullable(),
  /** 最近一次非正常退出的原因（日志尾部），便于界面直接展示 */
  lastError: z.string().nullable(),
  restarts: z.number().int(),
  createdAt: z.string().datetime(),
});

export const localSessionResponseSchema = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(true), ownerToken: z.string() }),
  z.object({ enabled: z.literal(false), reason: z.string() }),
]);

export const localProviderInfoSchema = z.object({
  provider: localAgentProviderSchema,
  command: z.string(),
  installed: z.boolean(),
  version: z.string().nullable(),
});

export const localProvidersResponseSchema = z.object({
  providers: z.array(localProviderInfoSchema),
});
export const localDirectoryListingSchema = z.object({
  path: z.string(),
  /** 已在文件系统根目录时为 null */
  parent: z.string().nullable(),
  entries: z.array(z.object({ name: z.string(), path: z.string() })),
  /** 子目录过多时只返回前若干条 */
  truncated: z.boolean(),
  defaults: z.object({
    /** 启动 Hive 服务时所在的目录 */
    launch: z.string(),
    home: z.string(),
  }),
});

export const localAgentsResponseSchema = z.object({ agents: z.array(localAgentSchema) });
export const localAgentResponseSchema = z.object({ agent: localAgentSchema });
export const localAgentLogsResponseSchema = z.object({ lines: z.array(z.string()) });

export type ParticipantType = z.infer<typeof participantTypeSchema>;
export type ParticipantStatus = z.infer<typeof participantStatusSchema>;
export type AgentProvider = z.infer<typeof agentProviderSchema>;
export type Participant = z.infer<typeof participantSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type RoomSummary = z.infer<typeof roomSummarySchema>;
export type ClientEvent = z.infer<typeof clientEventSchema>;
export type ServerEvent = z.infer<typeof serverEventSchema>;
export type MessagesResponse = z.infer<typeof messagesResponseSchema>;
export type RoomsResponse = z.infer<typeof roomsResponseSchema>;
export type MetaResponse = z.infer<typeof metaResponseSchema>;
export type InvocationStatus = z.infer<typeof invocationStatusSchema>;
export type InvocationBlockReason = z.infer<typeof invocationBlockReasonSchema>;
export type Invocation = z.infer<typeof invocationSchema>;
export type WhiteboardSlot = z.infer<typeof whiteboardSlotSchema>;
export type WhiteboardEntry = z.infer<typeof whiteboardEntrySchema>;
export type LocalAgentProvider = z.infer<typeof localAgentProviderSchema>;
export type LocalAgentAccess = z.infer<typeof localAgentAccessSchema>;
export type LocalAgentStatus = z.infer<typeof localAgentStatusSchema>;
export type CreateLocalAgentRequest = z.infer<typeof createLocalAgentRequestSchema>;
export type LocalAgent = z.infer<typeof localAgentSchema>;
export type LocalSessionResponse = z.infer<typeof localSessionResponseSchema>;
export type LocalProviderInfo = z.infer<typeof localProviderInfoSchema>;
export type LocalDirectoryListing = z.infer<typeof localDirectoryListingSchema>;

const mentionPattern = /@([\p{L}\p{N}_.-]{1,32})/gu;

export function parseMentions(content: string): string[] {
  const mentions = new Map<string, string>();
  for (const match of content.matchAll(mentionPattern)) {
    const username = match[1];
    if (username && !mentions.has(username.toLocaleLowerCase())) {
      mentions.set(username.toLocaleLowerCase(), username);
    }
  }
  return [...mentions.values()];
}

export function isMentioned(content: string, username: string): boolean {
  const normalized = username.toLocaleLowerCase();
  return parseMentions(content).some((mention) => mention.toLocaleLowerCase() === normalized);
}

/**
 * 去掉可能扰乱终端、Prompt 边界或文本方向的不可见字符：C0/C1 控制符（保留换行与制表）、
 * bidi 覆盖/隔离符和行/段分隔符。零宽连接符（emoji 组合需要）保留。
 */
export function stripUnsafeCharacters(value: string): string {
  return (
    value
      .replace(/\r\n?/g, "\n")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
      .replace(/[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/g, "")
      .replace(/[\u2028\u2029]/g, "\n")
  );
}
