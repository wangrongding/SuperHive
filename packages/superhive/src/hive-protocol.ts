export type ParticipantType = "human" | "agent";
export type ParticipantStatus = "online" | "offline" | "busy";

export type Participant = {
  id: string;
  roomId: string;
  username: string;
  type: ParticipantType;
  status: ParticipantStatus;
  persona?: string;
  provider?: string;
  joinedAt: string;
  lastSeenAt: string;
};

export type ChatMessage = {
  id: string;
  roomId: string;
  seq: number;
  senderId: string;
  senderName: string;
  senderType: ParticipantType;
  content: string;
  mentions: string[];
  replyToMessageId?: string;
  traceId: string;
  parentMessageId?: string;
  hopCount: number;
  clientMessageId?: string;
  createdAt: string;
  /** 已撤回：content 与 mentions 已被服务端清空 */
  deletedAt?: string;
  /** topic：话题分隔（开启新话题或清空房间），之前的会话上下文应被丢弃；delegation：hive_invoke 发出的委派；receipt：子任务回执；question：hive_ask_human 提的问题；schedule：定时任务到点后服务端代发起人发出的触发消息 */
  kind?: "topic" | "delegation" | "receipt" | "question" | "schedule" | "progress" | "notice";
  /** 随消息发出的附件元数据；内容需经 hive_attachment_read 或附件接口读取 */
  attachments?: Attachment[];
  /** 服务端代发消息的结构化正文（键见 protocol 的 server-text.ts），比如 roomPost.forwarded */
  text?: { key: string; params?: Record<string, unknown> };
  todoHandoff?: { todoId: string; notes: string };
};

export type Attachment = {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: "image" | "text" | "file";
  sha256: string;
  width?: number;
  height?: number;
};

/** 与服务端单个附件上限一致，下载时据此截断异常大的响应 */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export type MessagesResponse = {
  messages: ChatMessage[];
  latestSeq: number;
};

export type RoomSummary = {
  id: string;
  name: string;
  createdAt: string;
  createdBy?: string;
  archivedAt?: string;
  /** 房间工作区（Server 所在电脑上的路径） */
  workspace?: string;
  /** 主 Agent 的名字；不设就没有 */
  leadAgent?: string;
  leadMode?: "auto" | "manual";
  onlineCount: number;
  latestSeq: number;
};

export type InvocationStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelling"
  | "timed_out"
  | "cancelled"
  | "waiting_human";

/** 服务端对一次 @ 唤醒的追踪记录（Agent 侧只用到其中一部分字段） */
export type Invocation = {
  id: string;
  roomId: string;
  messageId: string;
  agentId: string;
  agentName: string;
  status: InvocationStatus;
  blockReason?: string;
  detail?: string;
  attempts: number;
  /** 人已收起（标为已处理）或被后来的结果取代：这类调用不再自动重跑 */
  resolution?: { kind: string };
  /** 落在 Agent 的哪一道会话：main 或开启这件子任务的委派调用 ID；老服务端没有 */
  laneKey?: string;
};

export type WhiteboardEntry = {
  id: string;
  key: string;
  kind?: "task_directory";
  slot: "ready" | "in_progress" | "blocked" | "milestone";
  summary: string;
  repo?: string;
  branch?: string;
  commit?: string;
  unblocks: string[];
  authorName: string;
  updatedAt: string;
  archivedAt?: string;
};

/** Keep in sync with runtimeEventSchema in @superhive/protocol; contains no arbitrary runtime text. */
export type RuntimeEvent = {
  kind: "capabilities" | "activity" | "provider_error" | "recovered";
  observability?: "partial" | "full" | "heartbeat";
  usage?: boolean;
  phase?: "starting" | "working" | "thinking" | "tool_running" | "tool_completed";
  tool?: "read" | "write" | "search" | "command" | "collaboration" | "other";
  code?: number;
  retryAttempt?: number;
  retryInMs?: number;
};

/** Keep in sync with traceStepSchema in @superhive/protocol：执行过程的一步，同一个 id 再报即更新 */
export type TraceStep = {
  id: string;
  kind: "text" | "thinking" | "tool";
  tool?: "read" | "write" | "search" | "command" | "collaboration" | "other";
  name?: string;
  hiveProgress?: true;
  summary?: string;
  text?: string;
  status?: "running" | "ok" | "error";
  startedAt: string;
  endedAt?: string;
};

/** Keep in sync with agentUsageSchema in @superhive/protocol；四个输入桶互斥 */
export type UsageBuckets = {
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
};
export type AgentUsage = UsageBuckets & {
  model?: string;
  /** 这一轮的思考强度：Hive 传给运行时的，或运行时报出的会话当前值（ACP）；都不知道（沿用 CLI 配置）时不填 */
  effort?: string;
  /** 这一轮里 Claude Code 自动压缩了上下文（一轮里可能不止一次） */
  compactions?: Array<{ preTokens: number; postTokens?: number; durationMs?: number }>;
  /** 这一轮传给 Claude Code 的自动压缩阈值；模型上下文比它小时实际按模型上限压缩 */
  compactWindow?: number;
  /** 这一轮最后一次请求的上下文大小（会话现在有多大） */
  lastContextTokens?: number;
  /** 缓存有效期：这一轮观测到的写入类型，没写入时沿用上一轮的；不知道就不填 */
  cacheTtlMs?: number;
  requests: number;
  firstRequest?: Omit<UsageBuckets, "outputTokens">;
  peakContextTokens: number;
  peakCacheWriteTokens: number;
  contextWindow?: number;
  reportedCostUsd?: number;
  cacheWrite1hTokens?: number;
  firstRequestAt?: string;
  lastRequestAt?: string;
  /** 从 Bridge 开始处理这一轮到运行时第一段输出、到这一轮结束（毫秒，Bridge 本机计时） */
  firstOutputMs?: number;
  turnMs?: number;
  session?: "new" | "resumed";
  idleMs?: number;
  idleBasis?: "request" | "turn";
  previousCacheTtlMs?: number;
  outcome?: "completed" | "failed" | "cancelled" | "uncertain";
};

export type InvocationReport = {
  type: "invocation.report";
  messageId: string;
  status: "received" | "running" | "completed" | "failed" | "cancelled" | "uncertain";
  detail?: string;
  /** detail 的结构化文案（键见 bridge-text.ts） */
  detailText?: import("./bridge-text.js").BridgeText;
  /** 失败原因（见 failure.ts）：自动重试等待中和最终失败时带上 */
  failure?: import("./failure.js").FailureKind;
  progress?: string;
  replyMessageId?: string;
  contextSeq?: number;
  runtimeEvent?: RuntimeEvent;
  usage?: AgentUsage;
  /** 收到停止但同轮还有没停的消息、这一轮继续（status 为 running） */
  stopDeferred?: boolean;
};

export type ServerEvent =
  | {
      type: "room.snapshot";
      self: Participant;
      participants: Participant[];
      messages: ChatMessage[];
      latestSeq: number;
      /** 旧版服务端没有这两个字段 */
      invocations?: Invocation[];
      whiteboard?: WhiteboardEntry[];
      /** 服务端支持的可选能力；旧版服务端没有 */
      features?: string[];
    }
  | { type: "message.created"; message: ChatMessage }
  | { type: "message.deleted"; message: ChatMessage }
  | {
      type: "agent.mentioned";
      message: ChatMessage;
      latestSeq: number;
      retry?: boolean;
      /** 人要求把这条插进正在执行的当前任务（不排队） */
      steer?: boolean;
      /** 人要求停下当前任务改做这条：排到队首，下一轮只做它 */
      first?: boolean;
      /** 这条没有 @ 任何人，派给你是因为你是房间的主 Agent */
      lead?: boolean;
      /** 人点「换个模型重试」选的模型：只对这一次生效 */
      model?: string;
      /** 人点「换个模型重试」选的思考强度：只对这一次生效 */
      effort?: string;
      /** 这条提及落在哪一道会话（Invocation.laneKey） */
      laneKey?: string;
      /** 人对一次中途中断点了「继续」：接着原会话核对现状再往下做 */
      resume?: boolean;
    }
  /** turn：同一轮一起停的几条消息（含 messageId），旧版服务端不带 */
  | { type: "agent.cancel"; messageId: string; turn?: string[] }
  /** 人对 Agent 执行中申请的权限做了决定（或过时） */
  | { type: "approval.decision"; requestId: string; allow: boolean; reason?: string }
  | { type: "agent.shutdown" }
  | { type: "invocation.updated"; invocation: Invocation }
  | { type: "presence.changed"; participant: Participant }
  | { type: "rooms.changed"; room: RoomSummary }
  | { type: "error"; code: string; message: string };

/* 与 @superhive/protocol 的 maskMarkdownCode / parseMentions 保持一致 */
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

export function isMentioned(content: string, username: string): boolean {
  const normalized = username.toLocaleLowerCase();
  return [...maskMarkdownCode(content).matchAll(mentionPattern)].some(
    (match) => match[1]?.toLocaleLowerCase() === normalized,
  );
}

/**
 * 与 @superhive/protocol 中的同名函数保持一致：去掉控制符、bidi 覆盖/隔离符和行/段分隔符，
 * 保留换行、制表和 emoji 需要的零宽连接符。
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
