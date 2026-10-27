import { z } from "zod";

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
  content: z.string().max(4000),
  mentions: z.array(z.string()),
  replyToMessageId: z.string().uuid().optional(),
  traceId: z.string().uuid(),
  parentMessageId: z.string().uuid().optional(),
  hopCount: z.number().int().min(0),
  clientMessageId: z.string().min(1).max(100).optional(),
  createdAt: z.string().datetime(),
  deletedAt: z.string().datetime().optional(),
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
  content: z.string().trim().min(1).max(4000),
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
  "cancelled",
]);
export const invocationBlockReasonSchema = z.enum(["hop_limit", "consecutive_limit", "pair_limit"]);

export const invocationSchema = z.object({
  id: z.string().uuid(),
  roomId: z.string().min(1).max(64),
  messageId: z.string().uuid(),
  agentId: z.string().uuid(),
  agentName: z.string(),
  requesterName: z.string(),
  requesterType: participantTypeSchema,
  status: invocationStatusSchema,
  blockReason: invocationBlockReasonSchema.optional(),
  detail: z.string().max(500).optional(),
  progress: z.string().max(200).optional(),
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
  status: z.enum(["received", "running", "completed", "failed", "cancelled"]),
  detail: z.string().trim().max(500).optional(),
  progress: z.string().trim().max(200).optional(),
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

export const LIMITS = {
  maxHopCount: 4,
  maxAgentMessagesPerTrace: 12,
  maxAgentRepliesPerMinute: 6,
  maxMessageLength: 4000,
  /** 自上一条人类消息以来，房间内 Agent 发言触发其他 Agent 的最多轮数；人一发言即清零 */
  maxConsecutiveAgentTurns: 8,
  /** 同一对 Agent（发起方 → 目标）在一个房间里 24 小时内的最多唤醒次数 */
  maxAgentPairTurnsPerDay: 40,
  /** running 调用超过这么久没有任何回报，视为结果未知（timed_out） */
  invocationStaleMs: 10 * 60_000,
  /** Agent 在线却一直没确认收到 @，视为投递未被接收 */
  invocationUnacknowledgedMs: 2 * 60_000,
  maxWhiteboardEntriesPerSlot: 50,
} as const;

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
