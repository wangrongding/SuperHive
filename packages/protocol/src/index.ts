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
  /** hive_ask_human 的选项数上限（字母 A 起依次分配）与每项长度 */
  maxQuestionOptions: 10,
  maxQuestionOptionLength: 64,
  /** 点选回答里「其它」输入的长度上限 */
  maxQuestionOtherLength: 2000,
  /** 邀请与续期的最长时长（分钟），超过请选「永久」 */
  maxInviteMinutes: 365 * 24 * 60,
  /** 附件：单个文件、单条消息的件数与总量；房间总量与个人未发送暂存量可在 Server 配置里调整 */
  maxAttachmentBytes: 20 * 1024 * 1024,
  maxAttachmentsPerMessage: 10,
  maxMessageAttachmentBytes: 50 * 1024 * 1024,
  defaultRoomAttachmentQuotaBytes: 1024 * 1024 * 1024,
  defaultPendingAttachmentQuotaBytes: 200 * 1024 * 1024,
  /** 每个上传者每分钟最多上传次数 */
  maxAttachmentUploadsPerMinute: 30,
  /** 上传后一直没随消息发出的附件，过期即清理 */
  pendingAttachmentTtlMs: 24 * 60 * 60_000,
  maxAttachmentNameLength: 200,
} as const;

export const participantTypeSchema = z.enum(["human", "agent"]);
export const participantStatusSchema = z.enum(["online", "offline", "busy"]);
export const agentProviderSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9_.-]+$/);

/**
 * 凭限时邀请进入的访客（及其带入的 Agent）的访问期限；房主和本机 Agent 没有这个字段。
 * expiresAt 为 null 表示永久（仍可被房主撤销）。
 */
export const participantAccessSchema = z.object({
  kind: z.literal("guest"),
  sessionId: z.string().uuid(),
  expiresAt: z.string().datetime().nullable(),
  /** 访客带入的 Agent：带它进来的访客名字；它随访客一起到期或被移除 */
  sponsorName: z.string().optional(),
  /** 已到期或被移除：留在离线列表里（下次可能再被邀请），但不能再访问 */
  ended: z.boolean().optional(),
  /** 被房主移除或所在链接被撤销（区别于自然到期）：不能续期，只能重新邀请 */
  revoked: z.boolean().optional(),
});

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
  access: participantAccessSchema.optional(),
});

/** 外部 IM 渠道：飞书（含 Lark）与个人微信 */
export const imChannelSchema = z.enum(["feishu", "wechat"]);
/** 经外部 IM 发进房间的消息：发言者仍是本人，这里只标记来源，供界面显示「来自飞书」 */
export const messageViaSchema = z.object({
  channel: imChannelSchema,
});

/** 提问的选项：key 由服务端按顺序分配（A、B、C…），刷新或重连后保持不变 */
export const questionOptionSchema = z.object({
  key: z.string().regex(/^[A-Z]$/),
  label: z.string().min(1).max(LIMITS.maxQuestionOptionLength),
});
export const questionSpecSchema = z.object({
  options: z.array(questionOptionSchema).min(2).max(LIMITS.maxQuestionOptions),
  /** true=多选（复选框 + 提交）；false=单选（点一下即提交） */
  multiple: z.boolean(),
});
/** 点选产生的答案：正文由服务端按已存的题目生成，这里只记下所选，供界面高亮 */
export const questionAnswerSchema = z.object({
  questionMessageId: z.string().uuid(),
  selected: z.array(z.string().regex(/^[A-Z]$/)).max(LIMITS.maxQuestionOptions),
  other: z.string().max(LIMITS.maxQuestionOtherLength).optional(),
});

/**
 * 附件元数据由服务端在上传完成时生成：kind 与 mime 按文件内容嗅探，不信任浏览器给的类型。
 * image 只包括可安全内联显示的 PNG/JPEG/GIF/WebP；SVG、HTML 等一律当普通文件下载。
 */
export const attachmentKindSchema = z.enum(["image", "text", "file"]);
export const attachmentSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(LIMITS.maxAttachmentNameLength),
  mime: z.string().min(1).max(100),
  size: z.number().int().min(0),
  kind: attachmentKindSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});
/** 上传接口的返回：附件尚未随消息发出，只有上传者本人可读，过期后清理 */
export const uploadedAttachmentSchema = attachmentSchema.extend({
  roomId: z.string().min(1).max(64),
  expiresAt: z.string().datetime(),
});

/** 一条消息正文的通用约束；带附件的消息允许正文为空，见 message.send */
export const messageContentSchema = z.string().trim().min(1).max(LIMITS.maxMessageLength);

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
  /** kind=question 且带选项时的题目定义；没有它就是自由回答的问题 */
  question: questionSpecSchema.optional(),
  /** 经网页点选提交的答案；手打的回答没有这个字段，正文照样是答案 */
  answer: questionAnswerSchema.optional(),
  /** 经飞书、微信等外部 IM 发来的消息 */
  via: messageViaSchema.optional(),
  /** 随消息发出的附件；撤回后清空 */
  attachments: z.array(attachmentSchema).max(LIMITS.maxAttachmentsPerMessage).optional(),
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
  // 只发附件时正文可以为空；正文与附件都为空由服务端拒绝
  content: z.string().trim().max(LIMITS.maxMessageLength).default(""),
  /** 先经 HTTP 上传得到的附件 ID；WebSocket 只传 ID，不传文件内容 */
  attachmentIds: z.array(z.string().uuid()).max(LIMITS.maxAttachmentsPerMessage).optional(),
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
 * 人点选回答 Agent 的提问：服务端按已存的题目校验所选，生成完整正文后作为对提问的回复发出，
 * 与手打回答走同一条续接路径。clientMessageId 让双击、重试只生效一次。
 */
export const questionAnswerEventSchema = z.object({
  type: z.literal("question.answer"),
  clientMessageId: z.string().min(1).max(100),
  questionMessageId: z.string().uuid(),
  selected: z.array(z.string().regex(/^[A-Z]$/)).max(LIMITS.maxQuestionOptions),
  other: z.string().trim().max(LIMITS.maxQuestionOtherLength).optional(),
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
/**
 * guest_approval：访客（或访客带入的 Agent）@ 了房主的 Agent。房主的 Agent 可能拥有本机完全权限，
 * 不能让远程访客直接驱动，需房主点「批准」（即重试）后才派发；邀请时勾选「允许调度 Agent」可免批准。
 */
export const invocationBlockReasonSchema = z.enum([
  "hop_limit",
  "consecutive_limit",
  "pair_limit",
  "guest_approval",
]);

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
  /**
   * 失败、被拦、结果未知的调用已不再需要人处理：dismissed=人点了「忽略」；
   * superseded=之后同一 Agent 在这个房间正常完成了任务，或开启了新话题，服务端自动收起。
   * 状态本身不变（历史可查），只是不再算作「需要处理」；调用状态再变化时自动清除。
   */
  resolution: z
    .object({
      kind: z.enum(["dismissed", "superseded"]),
      at: z.string().datetime(),
      by: z.string().max(64).optional(),
      note: z.string().max(200).optional(),
    })
    .optional(),
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
/** 人把不再需要处理的失败、被拦、结果未知的调用标为已处理（可一次多条） */
export const invocationDismissEventSchema = z.object({
  type: z.literal("invocation.dismiss"),
  invocationIds: z.array(z.string().uuid()).min(1).max(500),
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
  questionAnswerEventSchema,
  invocationReportEventSchema,
  invocationRetryEventSchema,
  invocationDismissEventSchema,
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
  /**
   * 房间工作区：Server 所在电脑上的目录。本机 Agent 在它允许的根目录内时，在这个房间改用这里作工作目录；
   * 不在允许范围、或 Agent 在别的电脑上时，继续用 Agent 自己的目录。
   */
  workspace: z.string().max(4096).optional(),
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

/** 房间工作区：绝对路径或 ~ 开头；null 表示清除 */
export const roomWorkspaceSchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .regex(/^(\/|~(\/|$))/, "请填写绝对路径（以 / 或 ~ 开头）");

export const createRoomRequestSchema = z.object({
  id: roomIdSchema,
  name: z.string().trim().min(1).max(64).optional(),
  createdBy: z.string().trim().min(1).max(32).optional(),
  workspace: roomWorkspaceSchema.optional(),
});

export const updateRoomRequestSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  archived: z.boolean().optional(),
  workspace: roomWorkspaceSchema.nullable().optional(),
});

export const metaResponseSchema = z.object({
  name: z.string(),
  roomId: z.string(),
  httpUrl: z.string().url(),
  wsUrl: z.string().url(),
  mcpUrl: z.string().url(),
  /** 只返回给 Server 所在电脑上的房主；远程访问者凭邀请兑换的会话访问 */
  joinToken: z.string().optional(),
  agentCommand: z.string().optional(),
});

/* ---------- 限时邀请（房主发给其他人类） ---------- */

/** 邀请时长：分钟数；null 表示永久 */
export const inviteDurationSchema = z.number().int().min(1).max(LIMITS.maxInviteMinutes).nullable();

export const inviteSchema = z.object({
  id: z.string().uuid(),
  roomId: z.string(),
  createdAt: z.string().datetime(),
  /** 统一截止时间：链接兑换和兑换后的访问都不能超过它；null 为永久 */
  expiresAt: z.string().datetime().nullable(),
  /** 允许访客直接 @ 房主的 Agent 干活（否则需房主逐次批准） */
  allowAgents: z.boolean(),
  /** 有效期内不限次数：已凭它加入的人数 */
  uses: z.number().int().nonnegative(),
  revokedAt: z.string().datetime().optional(),
  /** 邀请令牌，只出现在房主的邀请列表里，用来再次复制链接 */
  token: z.string().optional(),
});

/**
 * 房间的 IM 连接：房主扫码把飞书机器人或个人微信接进来，之后在 IM 里发的消息以房主本人身份进入房间，
 * 由此发起的任务结果和需要房主回答的提问再回到原来的 IM 会话。
 */
export const imConnectionStatusSchema = z.enum(["connecting", "connected", "paused", "error"]);
/**
 * 往 IM 推哪些消息：
 * mine=与我相关（默认）：我的任务的最终结果、问我的问题、真正提到我的消息、我的任务出了问题或等我批准；
 * im=只推从 IM 发起的任务和提到我的消息（早期行为）；
 * agents=在「与我相关」之外，房间里其余 Agent 发言每 3 分钟合并成一条；
 * all=房间里所有消息（含人类）逐条推送，不合并。
 */
export const imDeliveryLevelSchema = z.enum(["mine", "im", "agents", "all"]);
export const imDeliveryStatsSchema = z.object({
  /** 最近一次推送尝试：已发出、发送失败（还会重试）或放弃 */
  lastAt: z.string().datetime().optional(),
  lastStatus: z.enum(["sent", "retrying", "failed"]).optional(),
  lastError: z.string().optional(),
  /** 排队待发的条数 */
  pending: z.number().int().nonnegative(),
  /** 按当前档位没有推送的消息条数（自连接起累计） */
  filtered: z.number().int().nonnegative(),
});
export const imConnectionSchema = z.object({
  id: z.string().uuid(),
  roomId: z.string(),
  channel: imChannelSchema,
  /** 消息以这个房间成员的身份发进房间（扫码的房主本人） */
  ownerName: z.string(),
  /** 机器人或账号的显示名，如「AI Hive 助手」 */
  label: z.string(),
  status: imConnectionStatusSchema,
  detail: z.string().optional(),
  level: imDeliveryLevelSchema,
  delivery: imDeliveryStatsSchema,
  createdAt: z.string().datetime(),
  /** 最近一次从 IM 收到房主消息的时间 */
  lastInboundAt: z.string().datetime().optional(),
});
export const imLoginStatusSchema = z.enum([
  "starting",
  "waiting_scan",
  "scanned",
  "need_code",
  "connecting",
  "succeeded",
  "failed",
  "cancelled",
]);
export const imLoginViewSchema = z.object({
  id: z.string().uuid(),
  channel: imChannelSchema,
  roomId: z.string(),
  status: imLoginStatusSchema,
  /** 待扫描的二维码（data URL）与它对应的链接 */
  qrDataUrl: z.string().optional(),
  qrUrl: z.string().optional(),
  expiresAt: z.string().datetime().optional(),
  error: z.string().optional(),
  connectionId: z.string().uuid().optional(),
});
export const imChannelsInfoSchema = z.object({
  feishu: z.object({ enabled: z.boolean() }),
  /** 个人微信走非官方的 iLink 通道：默认不显示，需房主确认风险后启用；HIVE_IM_WECHAT=0 可整体关闭 */
  wechat: z.object({ enabled: z.boolean() }),
});
export const startImLoginRequestSchema = z.object({
  channel: imChannelSchema,
  /** 房主在这个房间里的名字：IM 里发的消息以它的身份进入房间 */
  ownerName: z.string().trim().min(1).max(32),
  /** 个人微信必须显式确认风险 */
  acceptRisk: z.boolean().optional(),
});
export const setImDeliveryLevelRequestSchema = z.object({ level: imDeliveryLevelSchema });
export const submitImLoginCodeRequestSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{4,8}$/),
});

export const createInviteRequestSchema = z.object({
  expiresInMinutes: inviteDurationSchema,
  allowAgents: z.boolean().default(false),
});
export const renewAccessRequestSchema = z.object({ expiresInMinutes: inviteDurationSchema });
export const redeemInviteRequestSchema = z.object({
  token: z.string().min(16).max(200),
  username: z.string().trim().min(1).max(32),
});
export const createGuestAgentRequestSchema = z.object({
  username: z.string().trim().min(1).max(32),
});

/** 当前访问者的身份：本机房主、凭邀请进入的访客，或尚无访问权 */
export const accessResponseSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("owner"), joinToken: z.string(), ownerToken: z.string() }),
  z.object({
    role: z.literal("guest"),
    kind: z.enum(["human", "agent"]),
    sessionId: z.string().uuid(),
    roomId: z.string(),
    username: z.string(),
    expiresAt: z.string().datetime().nullable(),
    allowAgents: z.boolean(),
  }),
  z.object({
    role: z.literal("none"),
    reason: z.enum(["no_invite", "expired", "revoked"]),
  }),
]);

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
export type ImChannel = z.infer<typeof imChannelSchema>;
export type ImConnection = z.infer<typeof imConnectionSchema>;
export type ImDeliveryLevel = z.infer<typeof imDeliveryLevelSchema>;
export type ImLoginView = z.infer<typeof imLoginViewSchema>;
export type ImChannelsInfo = z.infer<typeof imChannelsInfoSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type Attachment = z.infer<typeof attachmentSchema>;
export type AttachmentKind = z.infer<typeof attachmentKindSchema>;
export type UploadedAttachment = z.infer<typeof uploadedAttachmentSchema>;
export type QuestionSpec = z.infer<typeof questionSpecSchema>;
export type QuestionAnswer = z.infer<typeof questionAnswerSchema>;
export type RoomSummary = z.infer<typeof roomSummarySchema>;
export type ClientEvent = z.infer<typeof clientEventSchema>;
export type ServerEvent = z.infer<typeof serverEventSchema>;
export type MessagesResponse = z.infer<typeof messagesResponseSchema>;
export type RoomsResponse = z.infer<typeof roomsResponseSchema>;
export type MetaResponse = z.infer<typeof metaResponseSchema>;
export type ParticipantAccess = z.infer<typeof participantAccessSchema>;
export type Invite = z.infer<typeof inviteSchema>;
export type AccessResponse = z.infer<typeof accessResponseSchema>;
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

/**
 * 把 Markdown 代码（``` / ~~~ 代码块、行内 `code`）替换成等长空白：代码里写的 @名字 是示例，不算提及。
 * 等长替换保留其余文字的位置。未闭合的反引号按普通文字处理（与 CommonMark 一致）；未闭合的代码块延续到结尾。
 */
export function maskMarkdownCode(content: string): string {
  const blank = (text: string) => text.replace(/[^\n]/g, " ");
  const fenced = content.replace(
    /^([ \t]{0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]{0,3}\2[`~]*[ \t]*$|(?![\s\S]))/gm,
    blank,
  );
  return fenced.replace(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, blank);
}

/** @ 前紧贴 ASCII 字母数字或点时是邮箱等，不算提及；中文后直接 @ 算 */
const mentionPattern = /(?<![A-Za-z0-9_.])@([\p{L}\p{N}_.-]{1,32})/gu;

export function parseMentions(content: string): string[] {
  const mentions = new Map<string, string>();
  for (const match of maskMarkdownCode(content).matchAll(mentionPattern)) {
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
