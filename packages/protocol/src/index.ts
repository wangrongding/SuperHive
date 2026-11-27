import { z } from "zod";
import { reasoningEffortSchema } from "./reasoning-effort.js";
import {
  claudeCacheTtlSchema,
  claudeCompactWindowSchema,
  contextCompactionSchema,
} from "./claude-context.js";
import { agentCodeVersionSchema } from "./agent-version.js";
import { failureKindSchema } from "./failure-kind.js";
import { serverTextSchema } from "./server-text.js";
import { worktreeCleanupEventSchema } from "./worktree.js";
import { pluginsChangedEventSchema } from "./plugin-manifest.js";

export const LIMITS = {
  /**
   * 单个 Agent 每分钟最多发言条数，防止失控刷屏。服务端代发的子任务回执不算这个 Agent 发言。
   * 转交链本身不再限深度、不限总条数：hive_invoke 派活 → 回执 → 再派活是正常推进，多少轮都不拦；
   * 真正的死循环由下面的「来回检测」和每分钟条数兜住（rd #6608）。
   */
  maxAgentRepliesPerMinute: 12,
  /**
   * 来回检测：同一对 Agent 不经人、互相 @ 的连续消息条数（沿回复链往上数，两边交替发言）达到这个数，
   * 下一次唤醒就暂停等人确认。8 条＝各说 4 次：一问一答、review 一来一回改两轮都在 8 条以内，
   * 再往下仍没人插话、也没有附件或白板更新这类实际产出，基本是在客套或绕圈子。
   * 派活（hive_invoke）、子任务回执、定时触发不算互相 @，遇到就断开计数；人点「继续」按追加的轮数放宽。
   */
  maxAgentPingPongMessages: 8,
  /** 防止误粘巨型文件；展示折叠和模型上下文预算与此保护上限分开。单位为 UTF-16 code units。 */
  maxMessageLength: 100_000,
  /** 容纳上限内正文的 UTF-8 / JSON 转义开销，同时限制传输层的内存占用。 */
  maxClientPayloadBytes: 1_048_576,
  /**
   * 自上一条人类消息以来，房间内 Agent 发言触发其他 Agent 的最多轮数；人一发言即清零。
   * 这是费用刹车，不是防循环：环路由来回检测、每分钟条数、同一对每天次数兜住，
   * 所以放得比较宽，一次委派几个 Agent、来回 review 两轮的协作不用人中途点「继续」。
   * 服务端代发的子任务回执、进度消息不计入；hive_invoke 的派活消息和被委派方对派活的最终答复
   * （不再 @ 别人时）也不计入，委派链来回多少轮都不占这份额度。
   */
  maxConsecutiveAgentTurns: 50,
  /** 同一对 Agent（发起方 → 目标）在一个房间里 24 小时内经普通 @ 的最多唤醒次数；派活和回执不计 */
  maxAgentPairTurnsPerDay: 100,
  /** running 调用超过这么久没有任何回报，视为结果未知（timed_out） */
  invocationStaleMs: 10 * 60_000,
  /** Agent 在线却一直没确认收到 @，视为投递未被接收 */
  invocationUnacknowledgedMs: 2 * 60_000,
  maxWhiteboardEntriesPerSlot: 50,
  maxTodoTitleLength: 200,
  maxTodoNoteLength: 5000,
  maxTodosPerRoom: 1000,
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
  /** 定时任务：每个房间同时待执行的上限、最远可以排到多久以后、到点后多久内仍照常执行（超过即标为已错过） */
  maxActiveSchedulesPerRoom: 20,
  maxScheduleAheadMs: 30 * 24 * 60 * 60_000,
  scheduleGraceMs: 10 * 60_000,
  maxScheduleTaskLength: 4000,
  /** 周期定时任务：最短间隔（分钟）、一个周期最多执行几次 */
  minScheduleIntervalMinutes: 5,
  maxScheduleOccurrences: 288,
  /** 执行中途发给人看的进度消息：人发起的任务每个最多几条（Agent 之间的委派只允许一条，防止刷屏） */
  maxProgressPerTask: 3,
  /** Agent 执行中申请权限（运行时的审批请求）等人批的最长时间，过时按拒绝 */
  approvalTimeoutMs: 10 * 60_000,
  /** 执行过程：每步摘要与中途文字的长度上限、每次调用在内存里最多保留的步数 */
  maxTraceSummaryLength: 300,
  maxTraceTextLength: 2000,
  maxTraceSteps: 300,
  maxTraceStepsPerEvent: 50,
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
  /** 房主暂停了这个访客 Agent：暂时连不上，恢复后它自己会重连回来 */
  paused: z.boolean().optional(),
});

/** Agent 在某个房间实际的工作目录：加入房间时上报，成员列表据此显示、提示工作区变更是否已生效 */
export const agentWorkspaceSchema = z.object({
  /** Provider 进程实际的工作目录 */
  cwd: z.string().min(1).max(4096),
  /** 建这个房间的会话时房间设置的工作区（原样）；和房间当前的不同，说明变更还没生效 */
  roomWorkspace: z.string().min(1).max(4096).optional(),
  /** 房间工作区没有用上的原因（目录不存在、不在允许范围内等） */
  note: z.string().max(2000).optional(),
  /**
   * 工作区档却没有系统沙箱（Windows 上的 Claude Code）：命令能访问工作区以外的文件，
   * 有风险的操作靠运行时的审核加人工审批。成员列表据此显示「无沙箱」
   */
  noSandbox: z.boolean().optional(),
});
export type AgentWorkspace = z.infer<typeof agentWorkspaceSchema>;

/**
 * Agent 的 Hive 工具（hive_* MCP）连不上：Agent 读不到附件、看不到白板，回复只能靠 Bridge 代发。
 * Bridge 从运行时的启动信息里看到 hive MCP 失败时上报，连上后清除。
 */
export const agentHiveToolsSchema = z.object({
  status: z.literal("unavailable"),
  /** 运行时给出的原因（已截断、去掉本机用户目录）；运行时没说时为空 */
  detail: z.string().max(500).optional(),
  at: z.string().datetime(),
});
export type AgentHiveTools = z.infer<typeof agentHiveToolsSchema>;

/**
 * Agent 最近一轮结束时的上下文和缓存，由 Server 从这一轮的用量算出：会话现在多大、离自动压缩还有多远、
 * 缓存大约什么时候过期。只放拿得准的数：Runtime 没报缓存有效期就没有 cacheExpiresAt。
 */
export const agentContextStatusSchema = z.object({
  /** 最后一次请求的上下文 token（压缩过的话是压缩后的） */
  contextTokens: z.number().int().min(0).max(100_000_000),
  /** 这一轮传给 Claude Code 的自动压缩阈值 */
  compactWindow: z.number().int().min(0).max(100_000_000).optional(),
  /** 模型的上下文窗口 */
  contextWindow: z.number().int().min(0).max(100_000_000).optional(),
  /** 最后一次请求 + 缓存有效期：缓存大约在这时过期 */
  cacheExpiresAt: z.string().datetime().optional(),
  /** 最后一次模型请求的时间 */
  at: z.string().datetime(),
});

/** Agent 最近一轮实际用的模型（运行时报的；设置里选「运行时默认」时靠它知道到底是哪个） */
export const agentLastModelSchema = z.object({
  id: z.string().min(1).max(120),
  /** 那一轮的思考强度（传给运行时的，或运行时报出的会话当前值）；不知道不填 */
  effort: z.string().max(32).optional(),
  at: z.string().datetime(),
});
export type AgentLastModel = z.infer<typeof agentLastModelSchema>;
export type AgentContextStatus = z.infer<typeof agentContextStatusSchema>;

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
  /** 在线的 Agent 上报的代码版本（旧版 Bridge 不上报） */
  version: agentCodeVersionSchema.optional(),
  /** 在线的 Agent 运行的代码比 Server 当前的旧：重启后才用上新代码 */
  outdated: z.boolean().optional(),
  /** 在线的 Agent 在本房间实际的工作目录（旧版 Bridge 不上报） */
  workspace: agentWorkspaceSchema.optional(),
  /** 在线的 Agent 的 Hive 工具连不上（连得上、旧版 Bridge 不上报时没有） */
  hiveTools: agentHiveToolsSchema.optional(),
  /** 在线的 Agent 最近一轮结束时的上下文和缓存（从用量算；Runtime 不报时没有） */
  context: agentContextStatusSchema.optional(),
  /** Agent 在这个房间最近一轮实际用的模型（从用量账本取，Hive 重启后也在） */
  lastModel: agentLastModelSchema.optional(),
  hidden: z.boolean().optional(),
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
/** Agent 执行中申请权限时发出的批准请求：提问消息带上它，人点「允许 / 拒绝」后服务端把结果交回正在跑的这一轮 */
export const approvalRefSchema = z.object({
  requestId: z.string().uuid(),
  /** 申请的工具或动作，例如 Bash、commandExecution */
  tool: z.string().max(64),
});
/** 点选产生的答案：正文由服务端按已存的题目生成，这里只记下所选，供界面高亮 */
export const questionAnswerSchema = z.object({
  questionMessageId: z.string().uuid(),
  /** 提问的序号：隔了很久才回答时，Agent 端据此按 seq+id 补拉提问原文；旧消息没有这个字段 */
  questionSeq: z.number().int().positive().optional(),
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

export const todoHandoffSchema = z.object({
  todoId: z.string().uuid(),
  notes: z.string().max(LIMITS.maxTodoNoteLength),
});

/**
 * 这条消息引用了哪条（网页右键「引用回复」）：服务端发送时按房间内的原消息补上序号和发送者，
 * 原消息之后撤回也不改；正文里照样带着人看的 Markdown 引用块
 */
export const messageQuoteSchema = z.object({
  messageId: z.string().uuid(),
  seq: z.number().int().positive(),
  senderName: z.string().max(64),
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
   * schedule：定时任务到点后服务端代发起人发出的触发消息；不算人在场，不重置 Agent 连续轮数。
   * progress：Agent 执行中途发给人看的进度（hive_message_send progress=true）；不算这一轮的回复，不唤醒其他 Agent。
   * notice：服务端发的房间提示（例如自动设了主 Agent），以相关成员名义发出；不唤醒任何人，网页显示成一行系统提示。
   */
  kind: z
    .enum(["topic", "delegation", "receipt", "question", "schedule", "progress", "notice"])
    .optional(),
  /** kind=question 且带选项时的题目定义；没有它就是自由回答的问题 */
  question: questionSpecSchema.optional(),
  /** 经网页点选提交的答案；手打的回答没有这个字段，正文照样是答案 */
  answer: questionAnswerSchema.optional(),
  /** kind=question 且是 Agent 执行中申请权限：人点选允许 / 拒绝，结果直接交回正在跑的这一轮，不另起一轮 */
  approval: approvalRefSchema.optional(),
  todoHandoff: todoHandoffSchema.optional(),
  /** 经飞书、微信等外部 IM 发来的消息 */
  via: messageViaSchema.optional(),
  /** 随消息发出的附件；撤回后清空 */
  attachments: z.array(attachmentSchema).max(LIMITS.maxAttachmentsPerMessage).optional(),
  /** 引用的原消息；撤回后清空 */
  quote: messageQuoteSchema.optional(),
  /**
   * 服务端代发的系统消息（回执、定时、权限申请、话题分隔……）的结构化正文：网页按用户语言渲染。
   * content 仍是中文原文，给 Agent 读、给旧客户端显示。
   */
  text: serverTextSchema.optional(),
});

export const participantJoinEventSchema = z.object({
  type: z.literal("participant.join"),
  username: z.string().trim().min(1).max(32),
  participantType: participantTypeSchema,
  roomId: z.string().trim().min(1).max(64).default("general"),
  token: z.string().min(1).max(256),
  persona: z.string().trim().max(500).optional(),
  provider: agentProviderSchema.optional(),
  /** Agent 运行的代码版本；格式不对时当作没上报，不影响加入 */
  version: agentCodeVersionSchema.optional().catch(undefined),
  /** Agent 在这个房间实际的工作目录；格式不对时当作没上报，不影响加入 */
  workspace: agentWorkspaceSchema.optional().catch(undefined),
});

export const roomSwitchEventSchema = z.object({
  type: z.literal("room.switch"),
  roomId: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/),
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
  /** 引用回复：同房间、未撤回的消息才记下，否则当作没引用，消息照常发出 */
  quotedMessageId: z.string().uuid().optional(),
  /** 发送并引导：@ 到的 Agent 正在执行任务时，把这条用来引导当前任务而不是排队（只对人发的消息有效） */
  steer: z.boolean().optional(),
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
  /**
   * 撤回时一起停掉这条消息派出、还没结束的任务（排队中的取消，执行中的按「停止」处理）。
   * 不传等于只撤回：已经在做的照常做完，只是不再回复。
   */
  stop: z.boolean().optional(),
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
 * hop_limit：旧版的转交深度上限，已取消（rd #6608），只为读得懂历史记录保留；
 * ping_pong：同一对 Agent 不经人互相 @ 来回太多轮，见 LIMITS.maxAgentPingPongMessages。
 * guest_approval：访客（或访客带入的 Agent）@ 了房主的 Agent。房主的 Agent 可能拥有本机完全权限，
 * 不能让远程访客直接驱动，需房主点「批准」（即重试）后才派发；邀请时勾选「允许调度 Agent」可免批准。
 */
export const invocationBlockReasonSchema = z.enum([
  "hop_limit",
  "consecutive_limit",
  "pair_limit",
  "ping_pong",
  "guest_approval",
]);

/** Structured runtime telemetry: deliberately excludes raw errors, tool arguments and model text. */
export const runtimeEventSchema = z
  .object({
    kind: z.enum(["capabilities", "activity", "provider_error", "recovered"]),
    observability: z.enum(["partial", "full", "heartbeat"]).optional(),
    /** capabilities 事件：这个 Runtime 是否会上报每轮用量，用来区分「没采集」和「不支持」 */
    usage: z.boolean().optional(),
    phase: z.enum(["starting", "working", "thinking", "tool_running", "tool_completed"]).optional(),
    tool: z.enum(["read", "write", "search", "command", "collaboration", "other"]).optional(),
    code: z.number().int().min(100).max(599).optional(),
    retryAttempt: z.number().int().min(1).max(1000).optional(),
    retryInMs: z.number().int().min(0).max(86_400_000).optional(),
  })
  .strict();
/**
 * 执行过程的一步（像 CLI 那样实时显示：中途说的话、思考、跑的命令、改的文件）。
 * 只在执行中实时推给房主的页面，服务端只放内存、调用结束即丢弃，不落库、不发 IM、不给访客和 Agent。
 * 同一个 id 再次上报表示更新这一步（例如命令从执行中变为完成）。Bridge 上报前已脱敏、截断。
 */
export const traceStepSchema = z
  .object({
    id: z.string().min(1).max(120),
    kind: z.enum(["text", "thinking", "tool"]),
    tool: z.enum(["read", "write", "search", "command", "collaboration", "other"]).optional(),
    /** 原工具名，例如 Bash、Edit、commandExecution */
    name: z.string().max(64).optional(),
    /** 一行摘要：命令、文件路径、搜索词 */
    summary: z.string().max(LIMITS.maxTraceSummaryLength).optional(),
    /** 中途说的话 */
    text: z.string().max(LIMITS.maxTraceTextLength).optional(),
    status: z.enum(["running", "ok", "error"]).optional(),
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime().optional(),
  })
  .strict();
export const runtimeTimelineEntrySchema = runtimeEventSchema.extend({ at: z.string().datetime() });
export const runtimeObservationSchema = z.object({
  observability: z.enum(["partial", "full", "heartbeat"]),
  /** Runtime 声明会上报用量；未声明时为 undefined（旧版 Bridge 或不支持的 Runtime） */
  usage: z.boolean().optional(),
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
const tokenCount = z.number().int().min(0).max(1_000_000_000_000);
/**
 * 一次调用（Agent 的一轮）实际消耗的 token，取自 Runtime 返回的真实用量，不做估算。
 * 四个输入桶互斥：inputTokens 是未命中缓存的普通输入，cacheWriteTokens 是写入缓存，
 * cacheReadTokens 是命中缓存读取；命中率 = cacheRead / (input + cacheWrite + cacheRead)。
 */
export const usageBucketsSchema = z.object({
  inputTokens: tokenCount,
  cacheWriteTokens: tokenCount,
  cacheReadTokens: tokenCount,
  outputTokens: tokenCount,
});
export const agentUsageSchema = usageBucketsSchema.extend({
  model: z.string().max(120).optional(),
  /** 这一轮的思考强度：Hive 传给运行时的，或运行时报出的会话当前值（ACP）；都不知道（沿用 CLI 配置）时不填 */
  effort: z.string().max(32).optional(),
  /** 这一轮里 Claude Code 自动压缩了上下文（一轮里可能不止一次） */
  compactions: z.array(contextCompactionSchema).max(20).optional(),
  /** 这一轮传给 Claude Code 的自动压缩阈值；模型上下文比它小时实际按模型上限压缩 */
  compactWindow: z.number().int().min(0).max(100_000_000).optional(),
  /** 这一轮最后一次请求的上下文大小（会话现在有多大；压缩过的话是压缩后的） */
  lastContextTokens: tokenCount.optional(),
  /** 缓存有效期（毫秒）：这一轮观测到的写入类型，没写入时沿用上一轮的；不知道就不填 */
  cacheTtlMs: z.number().int().min(0).max(86_400_000).optional(),
  /** 本轮向模型发出的请求数（工具往返越多越大） */
  requests: z.number().int().min(0).max(100_000),
  /** 本轮第一次请求：决定这一轮是续上缓存还是整段重写 */
  firstRequest: usageBucketsSchema.omit({ outputTokens: true }).optional(),
  /** 单次请求的最大上下文（三个输入桶之和），近似当前会话大小 */
  peakContextTokens: tokenCount,
  /** 单次请求的最大缓存写入；超过阈值时面板提示整段重写 */
  peakCacheWriteTokens: tokenCount,
  contextWindow: tokenCount.optional(),
  /** Runtime 自己按官方价目估的费用（Claude Code 的 total_cost_usd），仅供参考 */
  reportedCostUsd: z.number().min(0).max(1_000_000).optional(),
  /** 其中按 1 小时有效期写入的缓存（其余按 5 分钟）；Runtime 不区分时不填 */
  cacheWrite1hTokens: tokenCount.optional(),
  /** 本轮第一次、最后一次模型请求的时间（Bridge 本机观测） */
  firstRequestAt: z.string().datetime().optional(),
  lastRequestAt: z.string().datetime().optional(),
  /**
   * Bridge 本机计时，都从 Bridge 开始处理这一轮算起（含选任务目录、拼提示、拉起运行时）：
   * firstOutputMs 到运行时交出第一段输出（思考、文字或工具调用），turnMs 到这一轮结束。
   * 没有任何输出就结束的回合不填 firstOutputMs。
   */
  firstOutputMs: z.number().int().min(0).max(604_800_000).optional(),
  turnMs: z.number().int().min(0).max(604_800_000).optional(),
  /** Bridge 补充：这一轮开始时是新会话还是续接旧会话 */
  session: z.enum(["new", "resumed"]).optional(),
  /**
   * 续接会话时距上一次模型请求的间隔。request=上轮最后一次请求到本轮第一次请求（最接近缓存视角）；
   * turn=上轮结束到本轮开始（拿不到请求时间时的退路，会把排队、准备时间算进来）。
   */
  idleMs: z.number().int().min(0).max(31_536_000_000).optional(),
  idleBasis: z.enum(["request", "turn"]).optional(),
  /** 上一轮写入的缓存按什么有效期写的（观测到 1 小时写入就是 1 小时）；未知时不填 */
  previousCacheTtlMs: z.number().int().min(0).max(86_400_000).optional(),
  /** 这一轮怎么结束的；失败、停止、结果未知时用量照样记账 */
  outcome: z.enum(["completed", "failed", "cancelled", "uncertain"]).optional(),
});
export type UsageBuckets = z.infer<typeof usageBucketsSchema>;
export type AgentUsage = z.infer<typeof agentUsageSchema>;

/**
 * 没观测到上一轮缓存写入类型时假定的缓存有效期（Anthropic 默认 5 分钟），网页可改。
 * 只用于推测原因，不是事实：网关的实际有效期、路由都可能不同。
 */
export const DEFAULT_PROMPT_CACHE_TTL_MS = 5 * 60_000;
/** 单次缓存写入超过这个值就在面板上标出来 */
export const DEFAULT_CACHE_WRITE_ALERT_TOKENS = 200_000;
/** 会话大小超过这个值就建议开新话题（不会自动执行） */
export const DEFAULT_SESSION_SIZE_ALERT_TOKENS = 300_000;
/**
 * 大额缓存写入的「可能原因」——是推测，不是结论：
 * new_session=新会话本来就要整段写入（这一条是事实）；
 * idle_beyond_ttl=距上次请求超过了缓存有效期，可能已过期；
 * unknown=间隔在有效期内却仍整段写入，可能是会话压缩、上游换了路由或网关没命中。
 */
export type CacheWriteReason = "new_session" | "idle_beyond_ttl" | "unknown";
export function cacheTtlFor(
  usage: Pick<AgentUsage, "previousCacheTtlMs">,
  fallbackMs: number,
): {
  ttlMs: number;
  observed: boolean;
} {
  return usage.previousCacheTtlMs
    ? { ttlMs: usage.previousCacheTtlMs, observed: true }
    : { ttlMs: fallbackMs, observed: false };
}
export function cacheWriteReason(
  usage: Pick<AgentUsage, "session" | "idleMs" | "previousCacheTtlMs">,
  fallbackTtlMs = DEFAULT_PROMPT_CACHE_TTL_MS,
): CacheWriteReason {
  if (usage.session === "new") return "new_session";
  const { ttlMs } = cacheTtlFor(usage, fallbackTtlMs);
  if (usage.idleMs !== undefined && usage.idleMs >= ttlMs) return "idle_beyond_ttl";
  return "unknown";
}
export function usageInputTokens(usage: UsageBuckets): number {
  return usage.inputTokens + usage.cacheWriteTokens + usage.cacheReadTokens;
}
/** token 加权的缓存命中率；没有输入时为 undefined */
export function cacheHitRate(usage: UsageBuckets): number | undefined {
  const input = usageInputTokens(usage);
  return input > 0 ? usage.cacheReadTokens / input : undefined;
}

export const usageTotalsSchema = usageBucketsSchema.extend({
  /** 记录到的 Agent 回合数 */
  turns: z.number().int().min(0),
  requests: z.number().int().min(0),
  reportedCostUsd: z.number().min(0),
  /** 单次缓存写入超过阈值的回合数 */
  largeCacheWrites: z.number().int().min(0),
});
export const usageRecordSchema = z.object({
  invocationId: z.string().uuid(),
  roomId: z.string(),
  messageId: z.string().uuid(),
  agentId: z.string().uuid(),
  agentName: z.string(),
  createdAt: z.string().datetime(),
  usage: agentUsageSchema,
});
export const usageSummarySchema = z.object({
  roomId: z.string(),
  since: z.string().datetime(),
  cacheWriteAlertTokens: z.number().int().min(1),
  totals: usageTotalsSchema,
  agents: z.array(
    usageTotalsSchema.extend({
      agentId: z.string().uuid(),
      agentName: z.string(),
      models: z.array(z.string()),
      /** 最近一轮：开局请求与会话大小 */
      latest: usageRecordSchema.optional(),
    }),
  ),
  /**
   * 按 Agent × 日期（服务端本地时区）× 模型细分；价格按模型配置在网页端，
   * 网页据此算出各维度的估算费用，不需要逐条明细。
   */
  cells: z.array(
    usageTotalsSchema.extend({ agentId: z.string().uuid(), day: z.string(), model: z.string() }),
  ),
  /** 最近的回合明细（新的在前） */
  recent: z.array(usageRecordSchema),
});
export type UsageTotals = z.infer<typeof usageTotalsSchema>;
export type UsageRecord = z.infer<typeof usageRecordSchema>;
export type UsageSummary = z.infer<typeof usageSummarySchema>;

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
  /**
   * 这次调用落在 Agent 的哪一道会话：main=房间主对话；别的值是开启这件活的那次委派的调用 ID。
   * Bridge 按它把子任务放进单独的会话；老服务端没有这一项，一律按 main 处理。
   */
  laneKey: z.string().min(1).max(64).optional(),
  status: invocationStatusSchema,
  messageRecalled: z.boolean().optional(),
  blockReason: invocationBlockReasonSchema.optional(),
  detail: z.string().max(500).optional(),
  /** detail 的结构化版本：网页按用户语言渲染；没有时显示 detail 原文 */
  detailText: serverTextSchema.optional(),
  /** 失败原因（上游限流、额度用完、认证失效……）；Bridge 说不清或旧版 Bridge 时没有 */
  failure: failureKindSchema.optional(),
  progress: z.string().max(200).optional(),
  /** progress 的结构化版本（服务端写的进度，例如等你批准） */
  progressText: serverTextSchema.optional(),
  runtime: runtimeObservationSchema.optional(),
  usage: agentUsageSchema.optional(),
  replyMessageId: z.string().uuid().optional(),
  /**
   * 等人回答时 Agent 用 hive_ask_human 发的那条提问：网页「等你回答」的入口据此直接跳过去，
   * 提问没载入也能按 seq 补拉。只在发提问时写入，老服务端或旧数据没有，网页退回按父消息找。
   */
  questionMessageId: z.string().uuid().optional(),
  questionSeq: z.number().int().positive().optional(),
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
      noteText: serverTextSchema.optional(),
    })
    .optional(),
});

export const whiteboardSlotSchema = z.enum(["ready", "in_progress", "blocked", "milestone"]);

export const todoInputSchema = z.object({
  title: z.string().trim().min(1).max(LIMITS.maxTodoTitleLength),
  notes: z.string().trim().max(LIMITS.maxTodoNoteLength).default(""),
  assigneeId: z.string().uuid().nullable().default(null),
  sourceMessageId: z.string().uuid().nullable().default(null),
});
export const todoUpdateSchema = todoInputSchema
  .omit({ sourceMessageId: true })
  .partial()
  .extend({ completed: z.boolean().optional() })
  .refine((input) => Object.keys(input).length > 0);
export const todoSchema = todoInputSchema.extend({
  id: z.string().uuid(),
  roomId: z.string().min(1).max(64),
  creatorId: z.string().uuid(),
  creatorName: z.string(),
  creatorType: z.enum(["human", "agent"]),
  assigneeName: z.string().nullable(),
  sourceMessageSeq: z.number().int().positive().nullable(),
  completed: z.boolean(),
  sortOrder: z.number().int().safe().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
});
export type Todo = z.infer<typeof todoSchema>;
export type TodoInput = z.infer<typeof todoInputSchema>;
export type TodoUpdate = z.infer<typeof todoUpdateSchema>;

export {
  worktreeClaimSchema,
  createWorktreeRequestSchema,
  removeWorktreeRequestSchema,
  managedWorktreeSchema,
  worktreeStatusSchema,
  repairWorktreeRequestSchema,
  worktreeDiscardPreviewSchema,
  discardWorktreeRequestSchema,
  worktreeDependenciesSchema,
} from "./worktree.js";
export type {
  WorktreeClaim,
  CreateWorktreeRequest,
  ManagedWorktree,
  WorktreeStatus,
  RepairWorktreeRequest,
  WorktreeDiscardPreview,
  WorktreeDependencies,
} from "./worktree.js";

export const whiteboardEntrySchema = z.object({
  id: z.string().uuid(),
  roomId: z.string().min(1).max(64),
  key: z.string().min(1).max(100),
  kind: z.literal("task_directory").optional(),
  slot: whiteboardSlotSchema,
  summary: z.string().min(1).max(500),
  repo: z.string().max(200).optional(),
  branch: z.string().max(200).optional(),
  claim: z
    .object({ repo: z.string().min(1).max(4096), branch: z.string().min(1).max(200) })
    .optional(),
  commit: z.string().max(100).optional(),
  unblocks: z.array(z.string().max(100)).max(20).default([]),
  authorId: z.string().uuid(),
  authorName: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  archivedAt: z.string().datetime().optional(),
  archiveProtected: z.boolean().optional(),
  /** 最近一次登记时 Agent 正在处理的那条消息：「进展」里点一条跳回聊天里对应的讨论 */
  messageId: z.string().uuid().optional(),
  messageSeq: z.number().int().positive().optional(),
  /** 服务端发现条目对应的分支已合入、自动转成里程碑的时间；Agent 再登记会清掉 */
  mergedAt: z.string().datetime().optional(),
});

export function isTaskDirectoryEntry(entry: { key: string; kind?: "task_directory" }): boolean {
  return entry.kind === "task_directory" || entry.key.startsWith("worktree:");
}

export const whiteboardArchiveRequestSchema = z.object({
  entries: z
    .array(z.object({ id: z.string().uuid(), updatedAt: z.string().datetime() }))
    .min(1)
    .max(200)
    .refine((entries) => new Set(entries.map((entry) => entry.id)).size === entries.length),
});

export const roomClearRequestSchema = z
  .object({
    username: z.string().trim().min(1),
    whiteboard: z.enum(["archive", "keep"]).default("archive"),
    entries: z
      .array(z.object({ id: z.string().uuid(), updatedAt: z.string().datetime() }))
      .refine((entries) => new Set(entries.map((entry) => entry.id)).size === entries.length)
      .optional(),
  })
  .refine((input) => input.whiteboard !== "keep" || input.entries === undefined);

/**
 * 定时任务（hive_schedule_create 创建）。到点后服务端代发起人发一条触发消息 @ 执行的 Agent，
 * 之后的执行状态以 invocationId 对应的调用为准。
 * scheduled 待执行 / firing 正在发出 / fired 已发出 / missed 已错过 / cancelled 已取消 / failed 无法发出
 */
export const scheduleStatusSchema = z.enum([
  "scheduled",
  "firing",
  "fired",
  "missed",
  "cancelled",
  "failed",
]);
export const scheduleSchema = z.object({
  id: z.string().uuid(),
  roomId: z.string().min(1).max(64),
  agentId: z.string().uuid(),
  agentName: z.string(),
  /** 发起人：创建它的那次调用所在委派链源头的人；到点后以其名义发出触发消息 */
  requesterId: z.string().uuid(),
  requesterName: z.string(),
  /** 创建时 Agent 正在处理的消息 */
  originMessageId: z.string().uuid(),
  originSeq: z.number().int().nonnegative(),
  task: z.string().min(1).max(LIMITS.maxScheduleTaskLength),
  runAt: z.string().datetime(),
  /** 显示用的 IANA 时区 */
  timeZone: z.string().min(1).max(64),
  /** 周期任务：每隔多少分钟一次、到什么时候为止；同一个周期的每一次共用 seriesId，occurrence 从 1 开始 */
  everyMinutes: z.number().int().positive().optional(),
  until: z.string().datetime().optional(),
  seriesId: z.string().uuid().optional(),
  occurrence: z.number().int().positive().optional(),
  status: scheduleStatusSchema,
  detail: z.string().max(500).optional(),
  detailText: serverTextSchema.optional(),
  triggerMessageId: z.string().uuid().optional(),
  invocationId: z.string().uuid().optional(),
  firedAt: z.string().datetime().optional(),
  cancelledBy: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/** Agent 回报自己对某条 @ 的处理进展；received 只确认送达，不改变 queued 状态 */
/** Agent 执行中遇到运行时的审批请求（命令、改文件、MCP 确认），交给人批 */
export const approvalRequestEventSchema = z.object({
  type: z.literal("approval.request"),
  /** 正在执行的触发消息 */
  messageId: z.string().uuid(),
  requestId: z.string().uuid(),
  tool: z.string().trim().min(1).max(64),
  /** 一行摘要：要跑的命令、要改的文件 */
  summary: z.string().trim().min(1).max(1000),
  /** 补充说明（原因、目录等） */
  detail: z.string().max(4000).optional(),
});

/** Agent 在这个房间当前用的 Provider 会话：人可以在终端里 resume 接着同一个会话 */
export const agentSessionEventSchema = z.object({
  type: z.literal("agent.session"),
  // 只收常见的会话 ID 字符，不能以 - 开头：拼进命令时既不能注入 shell，也不能被当成命令行选项
  sessionId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/),
  /** Provider 实际的工作目录：Claude 等按目录存会话，resume 要在同一个目录里 */
  cwd: z.string().min(1).max(4096),
});

/** Agent 的 Hive 工具（MCP）这一轮连上了没有：Bridge 从运行时的启动信息里得知，状态变了才发 */
export const agentToolsEventSchema = z.object({
  type: z.literal("agent.tools"),
  hive: z.enum(["connected", "unavailable"]),
  detail: z.string().trim().max(500).optional(),
});

export const invocationReportEventSchema = z.object({
  type: z.literal("invocation.report"),
  messageId: z.string().uuid(),
  status: z.enum(["received", "running", "completed", "failed", "cancelled", "uncertain"]),
  detail: z.string().trim().max(500).optional(),
  /** detail 的结构化版本（Bridge 写的说明，例如上游出错、连续失败），网页按语言渲染 */
  detailText: serverTextSchema.optional(),
  /** 失败原因（见 failure-kind.ts）：自动重试等待中（running）和最终失败时都带上 */
  failure: failureKindSchema.optional(),
  progress: z.string().trim().max(200).optional(),
  runtimeEvent: runtimeEventSchema.optional(),
  /** 本轮真实用量；同一轮合并处理多条消息时只随其中一条上报，避免重复计费 */
  usage: agentUsageSchema.optional(),
  replyMessageId: z.string().uuid().optional(),
  /** Agent 本轮已读到的公共消息 seq，Hive MCP 据此只附带之后的新消息 */
  contextSeq: z.number().int().nonnegative().optional(),
  /**
   * 收到停止，但这一轮还在处理同轮其它没停的消息、不会马上停下（status 为 running）：
   * 服务端据此把「停止中」改回执行中并写明原因，这一轮结束时这条再落定为已停止
   */
  stopDeferred: z.boolean().optional(),
});
export const invocationRetryEventSchema = z.object({
  type: z.literal("invocation.retry"),
  invocationId: z.string().uuid(),
  /** 「换个模型重试」：这次重试用的模型，只对这一次生效（只有房主能指定） */
  model: z.string().trim().min(1).max(200).optional(),
  /** 「换个模型重试」时一起选的思考强度，只对这一次生效（只有房主能指定） */
  effort: reasoningEffortSchema.optional(),
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
  updatedAt: z.string().datetime().optional(),
});
/** Agent 上报执行过程（只在执行中有意义；服务端转给房主的页面，不落库） */
export const invocationTraceEventSchema = z.object({
  type: z.literal("invocation.trace"),
  messageId: z.string().uuid(),
  steps: z.array(traceStepSchema).min(1).max(LIMITS.maxTraceStepsPerEvent),
});
/** 人把一条排队中的消息插进这个 Agent 正在执行的当前任务 */
export const invocationSteerEventSchema = z.object({
  type: z.literal("invocation.steer"),
  invocationId: z.string().uuid(),
});
/** 人要求停下这个 Agent 正在执行的任务，停下后先做这一条 */
export const invocationPreemptEventSchema = z.object({
  type: z.literal("invocation.preempt"),
  invocationId: z.string().uuid(),
});
/** 人取消一个还没到点的定时任务 */
export const scheduleCancelEventSchema = z.object({
  type: z.literal("schedule.cancel"),
  scheduleId: z.string().uuid(),
});

export const clientEventSchema = z.discriminatedUnion("type", [
  participantJoinEventSchema,
  roomSwitchEventSchema,
  messageSendEventSchema,
  heartbeatEventSchema,
  typingEventSchema,
  messageAckEventSchema,
  messageDeleteEventSchema,
  topicStartEventSchema,
  questionAnswerEventSchema,
  approvalRequestEventSchema,
  agentSessionEventSchema,
  agentToolsEventSchema,
  invocationReportEventSchema,
  invocationRetryEventSchema,
  invocationDismissEventSchema,
  invocationCancelEventSchema,
  budgetExtendEventSchema,
  whiteboardRemoveEventSchema,
  scheduleCancelEventSchema,
  invocationTraceEventSchema,
  invocationSteerEventSchema,
  invocationPreemptEventSchema,
]);

export const roomSnapshotEventSchema = z.object({
  type: z.literal("room.snapshot"),
  self: participantSchema,
  participants: z.array(participantSchema),
  messages: z.array(chatMessageSchema),
  latestSeq: z.number().int().nonnegative(),
  firstSeq: z.number().int().nonnegative().optional(),
  invocations: z.array(invocationSchema).default([]),
  whiteboard: z.array(whiteboardEntrySchema).default([]),
  todos: z.array(todoSchema).optional(),
  schedules: z.array(scheduleSchema).default([]),
  /** 还在等人批的权限申请（对应提问消息的 ID） */
  approvals: z.array(z.string().uuid()).default([]),
  /** 服务端支持的可选能力，例如 trace（接收执行过程） */
  features: z.array(z.string()).default([]),
});
/** 权限申请有了结果（或过时）：网页据此关掉选项 */
export const approvalUpdatedEventSchema = z.object({
  type: z.literal("approval.updated"),
  roomId: z.string(),
  messageId: z.string().uuid(),
  state: z.enum(["allowed", "denied", "expired"]),
});
/** 发给申请权限的 Agent：人批了还是拒了 */
export const approvalDecisionEventSchema = z.object({
  type: z.literal("approval.decision"),
  requestId: z.string().uuid(),
  allow: z.boolean(),
  /** 拒绝或过时的原因，交给 Agent 看 */
  reason: z.string().max(500).optional(),
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
  whiteboardArchived: z.boolean().optional(),
});
export const agentMentionedEventSchema = z.object({
  type: z.literal("agent.mentioned"),
  message: chatMessageSchema,
  latestSeq: z.number().int().nonnegative(),
  /** 人在 UI 中显式重试：Agent 应忽略本地"已处理"记录重新执行 */
  retry: z.boolean().optional(),
  /** 人要求把这条插进正在执行的当前任务（不排队） */
  steer: z.boolean().optional(),
  /** 人要求停下当前任务改做这条：排到队首，下一轮只做它 */
  first: z.boolean().optional(),
  /** 这条没有 @ 任何人，派给你是因为你是房间的主 Agent */
  lead: z.boolean().optional(),
  /** 人点「换个模型重试」选的模型：只对这一次生效 */
  model: z.string().trim().min(1).max(200).optional(),
  /** 人点「换个模型重试」选的思考强度：只对这一次生效 */
  effort: reasoningEffortSchema.optional(),
  /** 人对一次中途中断（结果未知、上游出错）点了「继续」：接着原会话核对现状再往下做，不从头重做 */
  resume: z.boolean().optional(),
  /** 这条提及落在 Agent 的哪一道会话（见 Invocation.laneKey）；没有时按 main */
  laneKey: z.string().min(1).max(64).optional(),
});
/** 本机 Hive Server 请它拉起的 Agent 自行退出（Windows 上没有可用的结束信号，信号一律是强制结束） */
export const agentShutdownEventSchema = z.object({
  type: z.literal("agent.shutdown"),
});

export const agentCancelEventSchema = z.object({
  type: z.literal("agent.cancel"),
  messageId: z.string().uuid(),
  /**
   * 同一轮一起停的几条消息（含 messageId 本身）：人停的是整轮，Bridge 收到第一条就把它们一起标为停止，
   * 不会因为几条停止请求先后到达而误以为「同轮还有没停的」。旧版 Bridge 忽略它，逐条处理也能停下
   */
  turn: z.array(z.string().uuid()).max(100).optional(),
});
export const invocationUpdatedEventSchema = z.object({
  type: z.literal("invocation.updated"),
  invocation: invocationSchema,
});
export const whiteboardUpdatedEventSchema = z.object({
  type: z.literal("whiteboard.updated"),
  entry: whiteboardEntrySchema,
});
export const todoUpdatedEventSchema = z.object({
  type: z.literal("todo.updated"),
  todo: todoSchema,
});
export const todoRemovedEventSchema = z.object({
  type: z.literal("todo.removed"),
  roomId: z.string(),
  todoId: z.string().uuid(),
});
export const whiteboardRemovedEventSchema = z.object({
  type: z.literal("whiteboard.removed"),
  roomId: z.string(),
  entryId: z.string().uuid(),
  archivedEntry: whiteboardEntrySchema.optional(),
});
export const scheduleUpdatedEventSchema = z.object({
  type: z.literal("schedule.updated"),
  schedule: scheduleSchema,
});
/** 执行过程的增量（只发给房主的页面）；steps 按 id 合并，ended=true 表示这次调用已结束、可以清掉 */
export const invocationTraceUpdatedEventSchema = z.object({
  type: z.literal("invocation.trace"),
  roomId: z.string(),
  invocationId: z.string().uuid(),
  steps: z.array(traceStepSchema),
  ended: z.boolean().optional(),
});
export const presenceChangedEventSchema = z.object({
  type: z.literal("presence.changed"),
  participant: participantSchema,
});
export const serverErrorEventSchema = z.object({
  type: z.literal("error"),
  code: z.string(),
  message: z.string(),
  /** message 的结构化版本（见 server-text.ts） */
  text: serverTextSchema.optional(),
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
  /** 工作区所在 git 仓库的当前分支（分离 HEAD 时是短提交号）；不是仓库就没有 */
  branch: z.string().max(200).optional(),
  /** 主 Agent 的名字：人发的、没有 @ 任何人的消息默认交给它接话和调度；不设就和以前一样没人接 */
  leadAgent: z.string().max(32).optional(),
  /**
   * 主 Agent 是怎么定的：auto=服务端自动设的（第一个加入的 Agent；它被删除或移出时自动顺延给下一个在线的），
   * manual=房主手动设的或手动取消的（自动逻辑不再改它）。没有这个字段且没有 leadAgent 时，下一个加入的 Agent 会自动成为主 Agent
   */
  leadMode: z.enum(["auto", "manual"]).optional(),
  /** 房主允许访客只读查看工作区文件与 git 变更；默认关（没有这个字段） */
  workspaceFilesGuests: z.boolean().optional(),
  onlineCount: z.number().int().nonnegative(),
  latestSeq: z.number().int().nonnegative(),
  /** 最近一条消息的时间：侧栏不置顶的房间按它倒序排；还没有消息时没有 */
  lastActivityAt: z.string().datetime().optional(),
  /** 房主把这个房间置顶时，它在置顶区里的位置（从 0 开始）；没置顶就没有 */
  pinned: z.number().int().nonnegative().optional(),
});

/** 房主的置顶房间：按顺序存一份，换设备也一样 */
export const roomPinsRequestSchema = z.object({
  roomIds: z.array(roomIdSchema).max(100),
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
  lastActivityAt: z.string().datetime().optional(),
});

/**
 * Server 上一次超过阈值的慢操作（锁、git 子进程、重查询、HTTP 请求）。只记操作名和耗时，
 * 不记命令参数、请求体或查询串。
 */
export const slowOperationSchema = z.object({
  id: z.string(),
  /** 结束时间 */
  at: z.string().datetime(),
  /** lock=任务目录写锁；git=git 子进程；operation=重查询；request=HTTP 请求 */
  kind: z.enum(["lock", "git", "operation", "request"]),
  /** 操作名：git 只到子命令（git status），请求是「方法 路由模板」 */
  name: z.string(),
  /** 执行耗时；锁是拿到锁之后持有的时长 */
  durationMs: z.number(),
  /** 排队等锁的时长（只有锁有） */
  waitMs: z.number().optional(),
  /** 调用来源：外层的 HTTP 路由、MCP 工具或操作名 */
  source: z.string().optional(),
  repo: z.string().optional(),
  roomId: z.string().optional(),
  /** HTTP 状态码 */
  status: z.number().optional(),
  /** 以出错或超时结束 */
  failed: z.boolean().optional(),
  /** 特别慢（合计超过 alertMs 或等锁超过 lockWaitAlertMs）：页面弹一次提示 */
  alert: z.boolean().optional(),
});
export const slowOperationsResponseSchema = z.object({
  operations: z.array(slowOperationSchema),
  /** 普通操作和 HTTP 请求的阈值（毫秒） */
  thresholdMs: z.number(),
  requestThresholdMs: z.number(),
  /** 最多保留多少条 */
  capacity: z.number(),
  /** 提醒阈值：合计耗时、等锁时长（毫秒） */
  alertMs: z.number(),
  lockWaitAlertMs: z.number(),
});
/** 这台电脑上的房主页面连上（含重连）时先给一份最近慢操作的全集，之后逐条推 slow-op.recorded */
export const slowOperationSnapshotEventSchema = slowOperationsResponseSchema.extend({
  type: z.literal("slow-op.snapshot"),
});
/** 新记了一条慢操作：只推给这台电脑上的房主页面 */
export const slowOperationRecordedEventSchema = z.object({
  type: z.literal("slow-op.recorded"),
  operation: slowOperationSchema,
});
/**
 * 故障单有变化：只推给这台电脑上的房主页面。attention=升级给人的故障单 + 待批准的规则提议，
 * 页面据此在设置入口上标数字；详情打开面板时再拉 /api/local/incidents。
 */
export const incidentsChangedEventSchema = z.object({
  type: z.literal("incidents.changed"),
  attention: z.number().int().min(0),
});
export type SlowOperation = z.infer<typeof slowOperationSchema>;
export type SlowOperationsResponse = z.infer<typeof slowOperationsResponseSchema>;
export type SlowOperationRecordedEvent = z.infer<typeof slowOperationRecordedEventSchema>;

export const serverEventSchema = z.discriminatedUnion("type", [
  worktreeCleanupEventSchema,
  roomSnapshotEventSchema,
  messageCreatedEventSchema,
  messageDeletedEventSchema,
  roomClearedEventSchema,
  agentMentionedEventSchema,
  agentCancelEventSchema,
  agentShutdownEventSchema,
  invocationUpdatedEventSchema,
  whiteboardUpdatedEventSchema,
  todoUpdatedEventSchema,
  todoRemovedEventSchema,
  whiteboardRemovedEventSchema,
  scheduleUpdatedEventSchema,
  invocationTraceUpdatedEventSchema,
  approvalUpdatedEventSchema,
  approvalDecisionEventSchema,
  presenceChangedEventSchema,
  roomsChangedEventSchema,
  roomActivityEventSchema,
  slowOperationSnapshotEventSchema,
  slowOperationRecordedEventSchema,
  incidentsChangedEventSchema,
  pluginsChangedEventSchema,
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
  // POSIX 绝对路径、~、Windows 盘符路径（C:\ 或 C:/）与 UNC（\\server\share）
  .regex(
    /^(\/|~([\\/]|$)|[A-Za-z]:[\\/]|\\\\[^\\])/,
    "请填写绝对路径（以 /、~ 或盘符如 C:\\ 开头）",
  );

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
  /** 设为 null 取消主 Agent（之后不再自动设）；房主手动设的都记为 manual */
  leadAgent: z.string().trim().min(1).max(32).nullable().optional(),
  /** 改回「自动」：交给服务端挑（在线的本机 Agent 优先），之后被删除或移出时自动顺延；不能和 leadAgent 一起给 */
  leadMode: z.literal("auto").optional(),
  /** 允许访客只读查看工作区文件与 git 变更 */
  workspaceFilesGuests: z.boolean().optional(),
});

export const metaResponseSchema = z.object({
  name: z.string(),
  roomId: z.string(),
  httpUrl: z.string().url(),
  wsUrl: z.string().url(),
  mcpUrl: z.string().url(),
  feedback: z
    .object({
      version: z.string(),
      commit: z.string().optional(),
      runMode: z.enum(["source", "npm"]),
    })
    .optional(),
  /** 只返回给 Server 所在电脑上的房主；远程访问者凭邀请兑换的会话访问 */
  joinToken: z.string().optional(),
  agentCommand: z.string().optional(),
  /** 沙箱预览模式（HIVE_SANDBOX=1）：不连 IM、不起本机 Agent、不跑定时任务，网页顶部标出 */
  sandbox: z.boolean().optional(),
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
  /** 访客能看到 Agent 的执行过程（命令、文件路径、中途说的话）；关掉时只看精简状态 */
  showTrace: z.boolean().default(true),
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
 * agents=在「与我相关」之外，房间里其余给人看的 Agent 发言每 3 分钟合并成一条；
 * all=默认房间的人类消息和给人看的 Agent 回复每 3 分钟合并，其它房间默认仅与我相关。
 */
export const imDeliveryLevelSchema = z.enum(["mine", "im", "agents", "all"]);
export const imDeliveryStatsSchema = z.object({
  /** 最近一次推送尝试：已发出、发送失败（还会重试）或放弃 */
  lastAt: z.string().datetime().optional(),
  lastStatus: z.enum(["sent", "retrying", "failed"]).optional(),
  lastError: z.string().optional(),
  /** 最近一次推送成功的时间 */
  lastSentAt: z.string().datetime().optional(),
  /** 排队待发的条数 */
  pending: z.number().int().nonnegative(),
  /** 按当前档位没有推送的消息条数（自连接起累计） */
  filtered: z.number().int().nonnegative(),
});
/** IM 机器人说话用的语言（卡片、按钮、提示）；用户和 Agent 写的内容不翻译 */
export const imLocaleSchema = z.enum(["zh-CN", "en"]);
/** IM 连接接收哪些房间的推送：all=房主所在的所有房间（默认），current=只收当前房间 */
export const imScopeSchema = z.enum(["all", "current"]);
export const imConnectionSchema = z.object({
  id: z.string().uuid(),
  roomId: z.string(),
  channel: imChannelSchema,
  /** 消息以这个房间成员的身份发进房间（扫码的房主本人） */
  ownerName: z.string(),
  /** 机器人或账号的显示名，如「SuperHive 助手」 */
  label: z.string(),
  status: imConnectionStatusSchema,
  detail: z.string().optional(),
  /** detail 的结构化版本：网页按语言显示（见 server-text.ts） */
  detailText: serverTextSchema.optional(),
  level: imDeliveryLevelSchema,
  locale: imLocaleSchema.optional(),
  scope: imScopeSchema.optional(),
  crossRoomAll: z.boolean().optional(),
  /** 默认发到的房间名（roomId 对应的显示名） */
  roomName: z.string().optional(),
  /**
   * 需要房主处理的情况：needs_message=个人微信要你先给机器人发一条消息才能继续推送（推送已暂停，收到后补发）；
   * relogin=登录失效，要重新扫码；push_failing=最近推送失败、还在重试
   */
  attention: z.enum(["needs_message", "relogin", "push_failing"]).optional(),
  /** needs_message 从什么时候开始 */
  heldSince: z.string().datetime().optional(),
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
  /** error 的结构化版本 */
  errorText: serverTextSchema.optional(),
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
  /** 机器人的语言，默认跟随房主当前网页的语言 */
  locale: imLocaleSchema.optional(),
});
export const setImDeliveryLevelRequestSchema = z.object({ level: imDeliveryLevelSchema });
export const setImLocaleRequestSchema = z.object({ locale: imLocaleSchema });
export const setImScopeRequestSchema = z.object({ scope: imScopeSchema });
export const setImCrossRoomAllRequestSchema = z.object({ crossRoomAll: z.boolean() });
export const setImRoomRequestSchema = z.object({ roomId: z.string().min(1).max(64) });
export const submitImLoginCodeRequestSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{4,8}$/),
});

export const createInviteRequestSchema = z.object({
  expiresInMinutes: inviteDurationSchema,
  allowAgents: z.boolean().default(false),
  showTrace: z.boolean().default(true),
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
    showTrace: z.boolean().default(true),
  }),
  z.object({
    role: z.literal("none"),
    reason: z.enum(["no_invite", "expired", "revoked"]),
  }),
]);

/* ---------- 本机 Agent（Hive Server 所在电脑上的房主，或房主登录的其他设备） ---------- */

/** 可以由本机一键启动的 Provider */
export const localAgentProviderSchema = z.enum([
  "codex",
  "claude",
  "copilot",
  "opencode",
  "omp",
  "openclaw",
  "gemini",
  "agy",
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
  /** 接入时就关掉的本机 MCP（仅 Claude Code / Codex），之后可在 Agent 设置里改 */
  mcpDisabled: z.array(z.string().trim().min(1).max(200)).max(200).optional(),
  rejoinParticipantId: z.string().uuid().optional(),
});

export const localAgentSchema = z.object({
  id: z.string().uuid(),
  provider: localAgentProviderSchema,
  name: z.string(),
  access: localAgentAccessSchema,
  cwd: z.string().nullable(),
  model: z.string().nullable(),
  /** 这个 Agent 的思考强度；null 表示不传参数，沿用 CLI 自己的配置 */
  effort: z.string().nullable().default(null),
  /** Claude：自动压缩阈值；null 表示没设过，按默认 20 万；"auto" 表示交给 Claude Code 自己定 */
  compactWindow: claudeCompactWindowSchema.nullable().default(null),
  /** Claude：缓存时长；null 表示不传，由 Claude Code 自动选 */
  cacheTtl: claudeCacheTtlSchema.nullable().default(null),
  status: localAgentStatusSchema,
  pid: z.number().int().nullable(),
  startedAt: z.string().datetime().nullable(),
  lastExitCode: z.number().int().nullable(),
  /** 最近一次非正常退出的原因（日志尾部），便于界面直接展示 */
  lastError: z.string().nullable(),
  restarts: z.number().int(),
  createdAt: z.string().datetime(),
  /** 在网页上关掉的本机 MCP 名称；空数组表示全部按 Agent CLI 自己的配置加载 */
  mcpDisabled: z.array(z.string()).default([]),
  /** 人发给它的消息在它忙时自动用来引导当前任务（默认关，排队） */
  autoSteer: z.boolean().default(false),
  /** 进程启动时还不支持设置文件（升级前就在运行）：MCP 勾选、模型要重启这个 Agent 一次才生效 */
  settingsPendingRestart: z.boolean().optional(),
  /** 在任一房间有排队、执行中或停止中的调用（提问后本轮还没结束也算） */
  busy: z.boolean().optional(),
  /** 进程上报的代码版本；还没上线或旧版 Bridge 不上报时没有 */
  version: agentCodeVersionSchema.optional(),
  /** 运行的代码比当前的旧（含旧版 Bridge 不上报版本）：重启后才用上新代码 */
  outdated: z.boolean().optional(),
  /** 已安排在空闲后重启（手动点了「重启」，或自动更新在等它忙完） */
  restartWhenIdle: z.boolean().optional(),
  /**
   * 这次启动没用配置里的工作目录，退回了主目录：installDir=指向桌面端安装目录（配置已改成 to），
   * missing=目录不存在（配置没改，目录回来后重启即恢复）
   */
  cwdFallback: z
    .object({ reason: z.enum(["installDir", "missing"]), from: z.string(), to: z.string() })
    .optional(),
});

/** 重启本机 Agent：默认等它手上的任务做完再重启；now 立即重启，正在做的任务会中断 */
export const restartLocalAgentRequestSchema = z
  .object({ when: z.enum(["idle", "now"]).default("idle") })
  .default({});

/** 本机 Agent 落后于当前代码时，在空闲后自动重启一次（默认开） */
export const localAgentAutoUpdateSchema = z.object({ enabled: z.boolean() });

export const updateLocalAgentSettingsRequestSchema = z
  .object({
    mcpDisabled: z.array(z.string().trim().min(1).max(200)).max(200).optional(),
    autoSteer: z.boolean().optional(),
    /** 这个 Agent 用的模型；null 或空串表示用运行时自己的默认。下一轮生效，不用重启 */
    model: z.string().trim().max(200).nullable().optional(),
    /** 这个 Agent 的思考强度；null 表示沿用 CLI 自己的配置。下一轮生效，不用重启 */
    effort: reasoningEffortSchema.nullable().optional(),
    /** Claude：自动压缩阈值；null 表示恢复默认（20 万）。下一轮生效，不用重启 */
    compactWindow: claudeCompactWindowSchema.nullable().optional(),
    /** Claude：缓存时长；null 表示不传，由 Claude Code 自动选。下一轮生效 */
    cacheTtl: claudeCacheTtlSchema.nullable().optional(),
  })
  .refine(
    (value) =>
      value.mcpDisabled !== undefined ||
      value.autoSteer !== undefined ||
      value.model !== undefined ||
      value.effort !== undefined ||
      value.compactWindow !== undefined ||
      value.cacheTtl !== undefined,
  );

/** Agent CLI 在本机会加载的一个 MCP（hive 自己不在其中，始终加载） */
export const localMcpServerSchema = z.object({
  name: z.string(),
  /** user：全局；local：只对这个项目；project：项目 .mcp.json；plugin：插件自带 */
  scope: z.enum(["user", "local", "project", "plugin"]),
  transport: z.enum(["stdio", "http", "sse"]),
  enabled: z.boolean(),
  /** false：插件提供或 CLI 自己已关闭，不能在 Hive 里开关 */
  configurable: z.boolean(),
  disabledByCli: z.boolean().optional(),
  measurement: z
    .discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), tools: z.number().int(), tokens: z.number().int() }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ])
    .optional(),
});

/** 运行时能用的模型（网页上选模型、「换个模型重试」用） */
export const localModelSchema = z.object({
  /** 传给运行时的模型名 */
  id: z.string(),
  label: z.string().optional(),
  /** 运行时自己的默认模型 */
  isDefault: z.boolean().optional(),
  /** 这个模型支持的思考强度（运行时按模型列出时才有，如 Codex、omp） */
  efforts: z.array(z.string()).optional(),
  /** 这个模型默认用的思考强度 */
  defaultEffort: z.string().optional(),
});
export const localAgentModelsResponseSchema = z.object({
  /** runtime：从运行时拉到的；preset：运行时没有列模型的命令，给的常用选项（都可以手填） */
  source: z.enum(["runtime", "preset"]),
  models: z.array(localModelSchema),
  /** 运行时接受的全部思考强度；空数组表示不支持按 Agent 切换 */
  efforts: z.array(z.string()).default([]),
  /** 拉取失败的原因 */
  error: z.string().optional(),
  /** 为什么只给常用选项（不算失败）：oauth=Claude 用账号登录、没有 API key；cloud=走 Bedrock / Vertex 等云平台 */
  presetReason: z.enum(["oauth", "cloud"]).optional(),
});

export const localAgentMcpResponseSchema = z.object({
  /** 不支持按勾选加载的 provider 为 false */
  supported: z.boolean(),
  servers: z.array(localMcpServerSchema),
  /** 不带任何 MCP 时 Agent 开局的大约 token 数（系统提示与内置工具），仅供参考 */
  baselineTokens: z.number().int().nullable(),
});

/**
 * 能不能在网页上管理 Server 所在电脑：
 * - local：页面就开在这台电脑上，下发进程房主凭证（X-Hive-Owner），全部功能可用；
 * - device：房主在其他设备上登录（扫码或飞书），凭自己的设备令牌（Authorization）使用，
 *   不下发进程凭证。查看直接可用；启动 Agent、改设置要先申请管理权（经本机或 IM 批准），
 *   用完全权限起进程还要逐次批准；生成登录二维码、显示总令牌只限 local。
 */
export const localSessionResponseSchema = z.union([
  z.object({
    enabled: z.literal(true),
    mode: z.literal("local"),
    ownerToken: z.string(),
    hostLabel: z.string(),
    /** Server 所在电脑（本机 Agent 跑在这里）的平台，即 Node 的 process.platform；旧版 Server 不给 */
    hostPlatform: z.string().optional(),
  }),
  z.object({
    enabled: z.literal(true),
    mode: z.literal("device"),
    deviceId: z.string(),
    hostLabel: z.string(),
    hostPlatform: z.string().optional(),
    /** 获准管理这台电脑到什么时候；null：只能查看，要先申请 */
    manageUntil: z.string().nullable(),
    /** 申请在哪里批准：im=推到可批准的 IM 账号（也可在本机批准）；local=只能到本机批准 */
    approval: z.enum(["im", "local"]),
  }),
  z.object({
    enabled: z.literal(false),
    reason: z.string(),
    reasonText: serverTextSchema.optional(),
  }),
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

export const removedLocalAgentSchema = z.object({
  name: z.string(),
  provider: localAgentProviderSchema,
  cwd: z.string().nullable(),
});
export type RemovedLocalAgent = z.infer<typeof removedLocalAgentSchema>;

export const localAgentsResponseSchema = z.object({
  agents: z.array(localAgentSchema),
  removedAgents: z.array(removedLocalAgentSchema).optional(),
  /** 自动更新开关；旧版 Server 不返回 */
  autoUpdate: z.boolean().optional(),
  /** 本机 Agent 用的这份代码当前的版本；判断不出来时没有 */
  currentVersion: agentCodeVersionSchema.optional(),
});
export const localAgentResponseSchema = z.object({ agent: localAgentSchema });
export const localAgentLogsResponseSchema = z.object({ lines: z.array(z.string()) });

export type ParticipantType = z.infer<typeof participantTypeSchema>;
export type ParticipantStatus = z.infer<typeof participantStatusSchema>;
export type AgentProvider = z.infer<typeof agentProviderSchema>;
export type Participant = z.infer<typeof participantSchema>;
export type ImChannel = z.infer<typeof imChannelSchema>;
export type ImConnection = z.infer<typeof imConnectionSchema>;
export type ImDeliveryLevel = z.infer<typeof imDeliveryLevelSchema>;
export type ImLocale = z.infer<typeof imLocaleSchema>;
export type ImScope = z.infer<typeof imScopeSchema>;
export type ImLoginView = z.infer<typeof imLoginViewSchema>;
export type ImChannelsInfo = z.infer<typeof imChannelsInfoSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type Attachment = z.infer<typeof attachmentSchema>;
export type AttachmentKind = z.infer<typeof attachmentKindSchema>;
export type UploadedAttachment = z.infer<typeof uploadedAttachmentSchema>;
export type QuestionSpec = z.infer<typeof questionSpecSchema>;
export type QuestionAnswer = z.infer<typeof questionAnswerSchema>;
export type ApprovalRef = z.infer<typeof approvalRefSchema>;
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
export type Schedule = z.infer<typeof scheduleSchema>;
export type TraceStep = z.infer<typeof traceStepSchema>;
export type ScheduleStatus = z.infer<typeof scheduleStatusSchema>;
export type WhiteboardSlot = z.infer<typeof whiteboardSlotSchema>;
export type WhiteboardEntry = z.infer<typeof whiteboardEntrySchema>;
export type RoomClearOptions = Omit<z.infer<typeof roomClearRequestSchema>, "username">;
export type LocalAgentProvider = z.infer<typeof localAgentProviderSchema>;
export type LocalAgentAccess = z.infer<typeof localAgentAccessSchema>;
export type LocalAgentStatus = z.infer<typeof localAgentStatusSchema>;
export type CreateLocalAgentRequest = z.infer<typeof createLocalAgentRequestSchema>;
export type UpdateLocalAgentSettingsRequest = z.infer<typeof updateLocalAgentSettingsRequestSchema>;
export type LocalMcpServer = z.infer<typeof localMcpServerSchema>;
export type LocalAgentMcpResponse = z.infer<typeof localAgentMcpResponseSchema>;
export type LocalModel = z.infer<typeof localModelSchema>;
export type LocalAgentModelsResponse = z.infer<typeof localAgentModelsResponseSchema>;
export type LocalAgent = z.infer<typeof localAgentSchema>;
export type LocalAgentsResponse = z.infer<typeof localAgentsResponseSchema>;
export type RestartLocalAgentRequest = z.infer<typeof restartLocalAgentRequestSchema>;
export type LocalSessionResponse = z.infer<typeof localSessionResponseSchema>;

/**
 * 熄屏后保持在线：只阻止系统空闲睡眠，屏幕照常熄灭。设置存在服务端、对这台电脑生效。
 * whenIm=有启用中的 IM 连接时保持（默认开）；whenTasks=有 Agent 任务在跑时保持（默认关）；
 * onBattery=用电池时也保持（默认关）。
 */
/**
 * 运行时接口地址与密钥（只限本机房主）：直接读写对应 CLI 的全局配置，终端里的 CLI 也一起变。
 * 列表只给打码后的值；完整值要单独确认后取，不进聊天、数据库和日志。
 */
export const runtimeCredentialProviderSchema = z.enum([
  "claude",
  "codex",
  "opencode",
  "omp",
  "openclaw",
  "copilot",
]);
export const runtimeCredentialFieldSchema = z.enum(["baseUrl", "apiKey"]);
export const runtimeCredentialFieldInfoSchema = z.object({
  set: z.boolean(),
  /** 打码后的值；没有设置时为 null */
  masked: z.string().nullable(),
  /** 能不能在网页上改（配置写法不认识、由环境变量或账号登录提供时不能） */
  editable: z.boolean(),
  /** 值写在哪里，例如 settings.json 的 env.ANTHROPIC_BASE_URL */
  location: z.string(),
  /** 不能改时的原因（中文；noteText 供网页按语言渲染） */
  note: z.string().optional(),
  noteText: serverTextSchema.optional(),
  /** 改文件不生效：被这里的值覆盖（环境变量名或优先级更高的配置文件） */
  shadowedBy: z.string().optional(),
});
/**
 * 改完怎么生效：nextTurn=不用重启，Agent 下一轮就用新值（每轮新起进程，或常驻进程发现凭据变了会换新）；restart=常驻进程，要重启 Agent；
 * gateway=Agent 每轮新起进程，但经 OpenClaw gateway 执行，gateway 要重新加载配置
 */
export const runtimeCredentialEffectSchema = z.enum(["nextTurn", "restart", "gateway"]);
export const runtimeCredentialsSchema = z.object({
  provider: runtimeCredentialProviderSchema,
  /** 全局配置文件（家目录写成 ~） */
  files: z.array(z.string()),
  /** false：没装或没配置自定义接口（note 里说明原因），两项都只读 */
  configured: z.boolean(),
  note: z.string().optional(),
  noteText: serverTextSchema.optional(),
  /** 当前用的 provider 条目名（opencode、omp、OpenClaw、Copilot、Codex 自定义 provider） */
  providerId: z.string().optional(),
  effect: runtimeCredentialEffectSchema,
  baseUrl: runtimeCredentialFieldInfoSchema,
  apiKey: runtimeCredentialFieldInfoSchema,
});
export const updateRuntimeCredentialsRequestSchema = z
  .object({
    baseUrl: z
      .string()
      .trim()
      .max(2048)
      .regex(/^https?:\/\/[^\s]+$/)
      .optional(),
    apiKey: z
      .string()
      .trim()
      .min(1)
      .max(4096)
      .regex(/^[\x21-\x7e]+$/)
      .optional(),
  })
  .refine((value) => value.baseUrl !== undefined || value.apiKey !== undefined);
export type RuntimeCredentialProvider = z.infer<typeof runtimeCredentialProviderSchema>;
export type RuntimeCredentialField = z.infer<typeof runtimeCredentialFieldSchema>;
export type RuntimeCredentialFieldInfo = z.infer<typeof runtimeCredentialFieldInfoSchema>;
export type RuntimeCredentials = z.infer<typeof runtimeCredentialsSchema>;
export type RuntimeCredentialEffect = z.infer<typeof runtimeCredentialEffectSchema>;
export type UpdateRuntimeCredentialsRequest = z.infer<typeof updateRuntimeCredentialsRequestSchema>;

/**
 * Agent CLI 的配置面板（只限本机房主）：在接入地址与密钥之外，补上模型等附加项、常用行为设置、
 * 全局 MCP 服务器、全局提示词文件和原始配置文件。读写的都是 CLI 自己的全局配置。
 */
export const runtimeConfigFieldSchema = z.object({
  id: z.string(),
  group: z.enum(["access", "behavior"]),
  /** text：自由文本；select：只能选 options 之一；boolean：开关 */
  kind: z.enum(["text", "select", "boolean"]),
  options: z.array(z.string()).optional(),
  /** 当前值；没设置时为 null（CLI 用自己的默认） */
  value: z.union([z.string(), z.boolean()]).nullable(),
  editable: z.boolean(),
  /** 值写在哪里 */
  location: z.string(),
  note: z.string().optional(),
  noteText: serverTextSchema.optional(),
  shadowedBy: z.string().optional(),
});
export const runtimeMcpServerSchema = z.object({
  name: z.string(),
  transport: z.enum(["stdio", "http", "sse"]),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  /** 只给变量名，不给值（值里常有密钥） */
  envKeys: z.array(z.string()),
  enabled: z.boolean(),
});
export const runtimeConfigFileSchema = z.object({
  id: z.string(),
  path: z.string(),
  format: z.enum(["json", "jsonc", "toml", "yaml", "markdown"]),
  exists: z.boolean(),
});
export const runtimeConfigSchema = z.object({
  provider: runtimeCredentialProviderSchema,
  credentials: runtimeCredentialsSchema,
  fields: z.array(runtimeConfigFieldSchema),
  mcp: z.object({
    /** 不支持时 note 说明原因 */
    supported: z.boolean(),
    file: z.string(),
    /** 能不能单独停用某个 MCP（Claude Code 的全局配置没有停用开关） */
    canToggle: z.boolean(),
    servers: z.array(runtimeMcpServerSchema),
    note: z.string().optional(),
    noteText: serverTextSchema.optional(),
  }),
  /** 全局提示词文件（CLAUDE.md、AGENTS.md…）；不支持时为 null */
  prompt: runtimeConfigFileSchema.nullable(),
  /** 可以查看、编辑原文的配置文件 */
  rawFiles: z.array(runtimeConfigFileSchema),
});
const mcpNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_.-]+$/);
/** MCP 名字：字母、数字和 _ . - */
export const runtimeMcpNameSchema = mcpNameSchema;
export const runtimeMcpServerInputSchema = z
  .object({
    transport: z.enum(["stdio", "http", "sse"]),
    command: z.string().trim().min(1).max(4096).optional(),
    args: z.array(z.string().max(4096)).max(100).optional(),
    url: z
      .string()
      .trim()
      .max(2048)
      .regex(/^https?:\/\/\S+$/)
      .optional(),
    /** null 表示保留原来的值（列表里只给了变量名） */
    env: z
      .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(8192).nullable())
      .optional(),
    enabled: z.boolean().optional(),
  })
  .refine((value) => (value.transport === "stdio" ? Boolean(value.command) : Boolean(value.url)));
export const putRuntimeMcpServerRequestSchema = z.object({
  name: mcpNameSchema,
  /** 改名时原来的名字 */
  previousName: mcpNameSchema.optional(),
  server: runtimeMcpServerInputSchema,
});
export const updateRuntimeConfigFieldsRequestSchema = z.object({
  /** null 表示删掉这一项、回到 CLI 默认 */
  values: z.record(z.string(), z.union([z.string().max(4096), z.boolean()]).nullable()),
});
export const updateRuntimeConfigFileRequestSchema = z.object({
  content: z.string().max(2 * 1024 * 1024),
  /** 打开时那份内容的哈希：期间被别人改过就拒绝，免得覆盖 */
  baseHash: z.string().nullable(),
});
export type RuntimeConfigField = z.infer<typeof runtimeConfigFieldSchema>;
export type RuntimeMcpServer = z.infer<typeof runtimeMcpServerSchema>;
export type RuntimeMcpServerInput = z.infer<typeof runtimeMcpServerInputSchema>;
export type RuntimeConfigFile = z.infer<typeof runtimeConfigFileSchema>;
export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;

/**
 * 全局 skills（只限本机房主）：按运行时列出它会读取的全局 skills 目录里的 SKILL.md，
 * 按各运行时原生的开关启停（Claude Code 的 skillOverrides、Codex 的 [[skills.config]]…），
 * 删除是把目录挪进同级的 .superhive-skill-backups/，可以手动还原。
 */
export const runtimeSkillSourceSchema = z.enum(["user", "shared", "plugin", "system", "superhive"]);
export const runtimeSkillSchema = z.object({
  /** 在这个运行时里唯一：<目录来源>/<目录名> */
  id: z.string(),
  name: z.string(),
  description: z.string(),
  /** user：运行时自己的目录；shared：几个运行时共用的目录；plugin：插件带的；system：CLI 自带；superhive：Hive 装的 */
  source: runtimeSkillSourceSchema,
  plugin: z.string().optional(),
  /** skill 目录（家目录写成 ~） */
  path: z.string(),
  /** 目录是软链时指向哪里 */
  linkTarget: z.string().optional(),
  enabled: z.boolean(),
  canToggle: z.boolean(),
  canDelete: z.boolean(),
  canSync: z.boolean(),
  /** 这个目录还会被哪些运行时读到（删除时一起受影响） */
  sharedWith: z.array(runtimeCredentialProviderSchema),
  note: z.string().optional(),
  noteText: serverTextSchema.optional(),
});
export const runtimeSkillsSchema = z.object({
  provider: runtimeCredentialProviderSchema,
  /** 启停写在哪里；不能在这里启停时为空，note 说明原因 */
  toggleLocation: z.string().optional(),
  dirs: z.array(
    z.object({ path: z.string(), exists: z.boolean(), source: runtimeSkillSourceSchema }),
  ),
  skills: z.array(runtimeSkillSchema),
  note: z.string().optional(),
  noteText: serverTextSchema.optional(),
});
export const runtimeOverviewSchema = z.object({
  /** 这台电脑上有配置目录的运行时 */
  providers: z.array(
    z.object({
      provider: runtimeCredentialProviderSchema,
      mcpSupported: z.boolean(),
      mcpCanToggle: z.boolean(),
      /** 不支持 MCP 时的原因 */
      mcpNote: z.string().optional(),
      mcpNoteText: serverTextSchema.optional(),
    }),
  ),
  mcp: z.array(
    z.object({
      name: z.string(),
      entries: z.array(
        z.object({
          provider: runtimeCredentialProviderSchema,
          enabled: z.boolean(),
          transport: z.enum(["stdio", "http", "sse"]),
        }),
      ),
    }),
  ),
  skills: z.array(
    z.object({
      name: z.string(),
      entries: z.array(
        z.object({
          provider: runtimeCredentialProviderSchema,
          id: z.string(),
          enabled: z.boolean(),
          source: runtimeSkillSourceSchema,
          canToggle: z.boolean(),
          canSync: z.boolean(),
          /** 不能在这里启停的原因 */
          note: z.string().optional(),
          noteText: serverTextSchema.optional(),
        }),
      ),
    }),
  ),
});
/** 统一管理里新增一个 MCP，一次写进多个运行时 */
export const addRuntimeMcpRequestSchema = z.object({
  name: mcpNameSchema,
  server: runtimeMcpServerInputSchema,
  targets: z.array(runtimeCredentialProviderSchema).min(1).max(6),
});
export const toggleRuntimeSkillRequestSchema = z.object({ enabled: z.boolean() });
export const syncRuntimeItemRequestSchema = z.object({
  targets: z.array(runtimeCredentialProviderSchema).min(1).max(6),
});
/**
 * MCP 快速安装（只限本机房主）：仓库里维护的精选清单只描述「配方」（固定版本的启动命令或远程地址、
 * 要填的参数），不存密钥，也不是另一份 MCP 主列表——装完照旧从各 CLI 自己的配置文件读回来。
 * 流程：选配方、填参数 → 预览冻结的计划（预览不写文件）→ 确认后按同一份计划写；计划过期、
 * 参数或目标文件变了就拒绝，要重新预览。
 */
const localizedTextSchema = z.object({ zh: z.string(), en: z.string() });
export const mcpCatalogParamSchema = z.object({
  id: z.string().regex(/^[a-z][a-zA-Z0-9]*$/),
  label: localizedTextSchema,
  help: localizedTextSchema.optional(),
  /** secret 只能出现在 env / 请求头里，绝不进命令行参数；paths 一行一个绝对路径 */
  kind: z.enum(["text", "path", "paths", "secret"]),
  required: z.boolean(),
  placeholder: z.string().optional(),
  /** 去哪拿这个密钥：发布者申请页面的具体地址（网页上显示成「去哪拿这个密钥」） */
  getUrl: z.string().url().optional(),
});
/** 商店里的分类 */
export const mcpCatalogCategorySchema = z.enum(["browser", "code", "docs", "design", "other"]);
/** 模板里的 {参数 id} 换成填的值；可选参数没填时，含它的那一项（参数 / 环境变量 / 请求头）整项去掉 */
export const mcpCatalogEntrySchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  /** 写进 CLI 配置时默认用的 MCP 名字 */
  name: z.string(),
  title: z.string(),
  publisher: z.string(),
  description: localizedTextSchema,
  /** 卡片上的一句话：它能帮 Agent 干什么（不写术语） */
  tagline: localizedTextSchema.optional(),
  category: mcpCatalogCategorySchema.optional(),
  /** 卡片上额外的标签，例如「需要 Figma 桌面版」 */
  badge: localizedTextSchema.optional(),
  /** 发布者的文档 */
  docs: z.string().url(),
  transport: z.enum(["stdio", "http", "sse"]),
  /** stdio：固定版本的启动命令，逐项 argv */
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  /** 远程：地址和写死值的请求头 */
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  params: z.array(mcpCatalogParamSchema),
  /** 能装进哪些 CLI */
  runtimes: z.array(runtimeCredentialProviderSchema),
  /** 装之前要知道的：需要 Node / uv、要先开 Figma 桌面版等 */
  requires: localizedTextSchema.optional(),
});
export const mcpCatalogSchema = z.object({
  /** 清单版本：改了任何配方都要升 */
  version: z.string(),
  entries: z.array(mcpCatalogEntrySchema),
});
export const runtimeInstallRequestSchema = z.object({
  recipeId: z.string().max(64),
  name: mcpNameSchema,
  /** 参数值（含密钥）只在请求里，不进日志、审计和响应 */
  params: z.record(z.string().max(64), z.string().max(8192)),
  targets: z.array(runtimeCredentialProviderSchema).min(1).max(6),
});
export const runtimeInstallApplyRequestSchema = runtimeInstallRequestSchema.extend({
  planId: z.string().max(64),
});
const planValueSchema = z.object({
  key: z.string(),
  /** 含密钥的值打码成 •••••• */
  value: z.string(),
  secret: z.boolean(),
});
export const runtimeInstallPlanSchema = z.object({
  id: z.string(),
  /** 毫秒时间戳；过了就要重新预览 */
  expiresAt: z.number(),
  recipeId: z.string(),
  catalogVersion: z.string(),
  name: z.string(),
  transport: z.enum(["stdio", "http", "sse"]),
  /** 以后 CLI 启动这个 MCP 时会执行的命令，逐项 argv（这一步不执行） */
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  env: z.array(planValueSchema),
  headers: z.array(planValueSchema),
  targets: z.array(
    z.object({
      provider: runtimeCredentialProviderSchema,
      /** 会改的配置文件（家目录写成 ~） */
      file: z.string(),
      /** 用这个 CLI 的本机 Agent：要重启才会加载 */
      agents: z.array(z.object({ id: z.string(), name: z.string(), status: z.string() })),
    }),
  ),
});
export const runtimeInstallResultSchema = z.object({
  results: z.array(
    z.object({
      provider: runtimeCredentialProviderSchema,
      ok: z.boolean(),
      file: z.string().optional(),
      error: z.string().optional(),
      /** error 的结构化文案，网页按语言渲染 */
      text: serverTextSchema.optional(),
    }),
  ),
  overview: runtimeOverviewSchema,
});
export type McpCatalogParam = z.infer<typeof mcpCatalogParamSchema>;
export type McpCatalogCategory = z.infer<typeof mcpCatalogCategorySchema>;
export type McpCatalogEntry = z.infer<typeof mcpCatalogEntrySchema>;
export type McpCatalog = z.infer<typeof mcpCatalogSchema>;
export type RuntimeInstallRequest = z.infer<typeof runtimeInstallRequestSchema>;
export type RuntimeInstallPlan = z.infer<typeof runtimeInstallPlanSchema>;
export type RuntimeInstallResult = z.infer<typeof runtimeInstallResultSchema>;
export type RuntimeSkillSource = z.infer<typeof runtimeSkillSourceSchema>;
export type RuntimeSkill = z.infer<typeof runtimeSkillSchema>;
export type RuntimeSkills = z.infer<typeof runtimeSkillsSchema>;
export type RuntimeOverview = z.infer<typeof runtimeOverviewSchema>;

export const keepAwakeSettingsSchema = z.object({
  whenIm: z.boolean(),
  whenTasks: z.boolean(),
  onBattery: z.boolean(),
});
export const keepAwakeStateSchema = keepAwakeSettingsSchema.extend({
  /** 这个系统能不能做（目前只有 macOS） */
  supported: z.boolean(),
  /** 实际状态：active=正在阻止睡眠；idle=不需要；battery=用电池中已暂停；disabled=都关了；unsupported；failed */
  status: z.enum(["active", "idle", "battery", "disabled", "unsupported", "failed"]),
  power: z.enum(["ac", "battery", "unknown"]),
  /** 给人看的原因，例如「有 1 个 IM 连接在线」 */
  reasons: z.array(z.string()),
  detail: z.string().optional(),
  since: z.string().datetime().optional(),
  lastWakeAt: z.string().datetime().optional(),
});
export type KeepAwakeSettings = z.infer<typeof keepAwakeSettingsSchema>;
export type KeepAwakeState = z.infer<typeof keepAwakeStateSchema>;

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

/**
 * 房间「产物」：房间里随消息发出、没撤回的附件（人上传的、Agent 用 hive-attachments 发的）。
 * 同一个人发的同名文件（不分大小写）算同一个产物的不同版本，列表只显示最新版，旧版本放在 versions 里。
 */

/** 细分类型：按服务端嗅探出的 kind / MIME 和扩展名归类，网页筛选和图标都用它 */
export const artifactCategorySchema = z.enum([
  "image",
  "document",
  "code",
  "data",
  "archive",
  "media",
  "other",
]);
export type ArtifactCategory = z.infer<typeof artifactCategorySchema>;

/** 筛选：all 全部，file 除图片以外的全部，其余是单个细分类型 */
export const artifactFilterSchema = z.union([z.enum(["all", "file"]), artifactCategorySchema]);
export type ArtifactFilter = z.infer<typeof artifactFilterSchema>;

const EXTENSION_CATEGORY: Record<string, ArtifactCategory> = {};
for (const [category, extensions] of [
  ["document", "pdf md markdown mdx txt rtf doc docx odt ppt pptx odp key pages html htm epub"],
  ["data", "json jsonl ndjson csv tsv xls xlsx ods numbers yaml yml toml xml sql db sqlite log"],
  [
    "code",
    "ts tsx js jsx mjs cjs py rb go rs java kt kts swift c h cc cpp hpp cs php sh bash zsh fish ps1 css scss less vue svelte astro lua dart scala r m mm pl ex exs erl hs clj zig nim patch diff svg ini conf env lock gradle mk cmake dockerfile",
  ],
  ["archive", "zip tar gz tgz bz2 xz 7z rar zst br lz4 jar war dmg iso"],
  ["media", "mp4 m4v mov webm mkv avi mp3 m4a aac wav ogg oga opus flac"],
] as const) {
  for (const extension of extensions.split(" ")) EXTENSION_CATEGORY[extension] = category;
}

export function artifactCategory(
  attachment: Pick<Attachment, "kind" | "mime" | "name">,
): ArtifactCategory {
  if (attachment.kind === "image") return "image";
  if (attachment.mime.startsWith("video/") || attachment.mime.startsWith("audio/")) return "media";
  if (attachment.mime === "application/pdf") return "document";
  const extension = /\.([a-z0-9]{1,10})$/i.exec(attachment.name)?.[1]?.toLowerCase() ?? "";
  // 没有扩展名的 Dockerfile、Makefile 之类按文件名认
  const byName = /^(dockerfile|makefile|rakefile|gemfile|procfile)$/i.test(attachment.name)
    ? "code"
    : undefined;
  return (
    EXTENSION_CATEGORY[extension] ?? byName ?? (attachment.kind === "text" ? "document" : "other")
  );
}

export function matchesArtifactFilter(category: ArtifactCategory, filter: ArtifactFilter): boolean {
  if (filter === "all") return true;
  if (filter === "file") return category !== "image";
  return category === filter;
}

/** 同一产物的分组键：发送者 + 文件名（不分大小写） */
export function artifactGroupKey(senderId: string, name: string): string {
  return `${senderId}\u0000${name.normalize("NFKC").toLocaleLowerCase()}`;
}

export const artifactItemSchema = attachmentSchema.extend({
  category: artifactCategorySchema,
  messageId: z.string().uuid(),
  messageSeq: z.number().int().positive(),
  senderId: z.string().uuid(),
  senderName: z.string(),
  senderType: participantTypeSchema,
  createdAt: z.string().datetime(),
});
export type ArtifactItem = z.infer<typeof artifactItemSchema>;

export const artifactSchema = artifactItemSchema.extend({
  /** 同一产物更早的版本，新的在前；只有一个版本时省略 */
  versions: z.array(artifactItemSchema).optional(),
});
export type Artifact = z.infer<typeof artifactSchema>;

export const artifactCountsSchema = z.record(artifactFilterSchema, z.number().int().min(0));
export type ArtifactCounts = Partial<Record<ArtifactFilter, number>>;

export const artifactsQuerySchema = z.object({
  type: artifactFilterSchema.default("all"),
  q: z.string().trim().max(200).default(""),
  /** 只看某个发送者（参与者 ID）的产物 */
  sender: z.string().uuid().optional(),
  /** 只看这个时间之后发出的产物（按最新版的时间） */
  since: z.string().datetime({ offset: true }).optional(),
  /** 上一页最后一项的游标（服务端给的 nextCursor，原样带回） */
  cursor: z
    .string()
    .regex(/^\d{1,15}\.[0-9a-f-]{36}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(60),
});
export type ArtifactsQuery = z.infer<typeof artifactsQuerySchema>;

/** 房间里发过产物的人，给「发送者」筛选用 */
export const artifactSenderSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  type: participantTypeSchema,
  /** 这个人发的产物数（同名文件的多个版本算一个） */
  count: z.number().int().min(0),
});
export type ArtifactSender = z.infer<typeof artifactSenderSchema>;

export const artifactsResponseSchema = z.object({
  artifacts: z.array(artifactSchema),
  /** 还有下一页时给出；不带它就是到底了 */
  nextCursor: z.string().optional(),
  /** 不计搜索词和类型的各类型产物数（每个产物只算一次），按发送者、时间筛过；给筛选按钮和入口角标用 */
  counts: artifactCountsSchema,
  /** 发过产物的人，按产物数从多到少；不受任何筛选影响 */
  senders: z.array(artifactSenderSchema).optional(),
});
export type ArtifactsResponse = z.infer<typeof artifactsResponseSchema>;

export * from "./invocation-state.js";
export * from "./agent-session.js";
export * from "./plural.js";
export * from "./participant-order.js";
export * from "./invocation-decision.js";
export * from "./failure-kind.js";
export * from "./agent-clis.js";
export * from "./reasoning-effort.js";
export * from "./claude-context.js";
export * from "./workspace-files.js";
export * from "./attachment-open.js";
export * from "./server-text.js";
export * from "./agent-version.js";
export * from "./incidents.js";
export * from "./docs-links.js";
export * from "./network-proxy.js";
export * from "./remote-join.js";
export * from "./plugin-manifest.js";
export type {
  NpmUpdateInfo,
  NpmUpdateBlocker,
  NpmUpdateChoice,
  NpmUpdateJob,
} from "./npm-update.js";
