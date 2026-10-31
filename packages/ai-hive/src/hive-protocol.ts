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
  /** topic：话题分隔（开启新话题或清空房间），之前的会话上下文应被丢弃；delegation：hive_invoke 发出的委派；receipt：子任务回执；question：hive_ask_human 提的问题 */
  kind?: "topic" | "delegation" | "receipt" | "question";
  /** 随消息发出的附件元数据；内容需经 hive_attachment_read 或附件接口读取 */
  attachments?: Attachment[];
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
};

export type WhiteboardEntry = {
  id: string;
  key: string;
  slot: "ready" | "in_progress" | "blocked" | "milestone";
  summary: string;
  repo?: string;
  branch?: string;
  commit?: string;
  unblocks: string[];
  authorName: string;
  updatedAt: string;
};

/** Keep in sync with runtimeEventSchema in @ai-hive/protocol; contains no arbitrary runtime text. */
export type RuntimeEvent = {
  kind: "capabilities" | "activity" | "provider_error" | "recovered";
  observability?: "partial" | "full" | "heartbeat";
  phase?: "starting" | "working" | "thinking" | "tool_running" | "tool_completed";
  tool?: "read" | "write" | "search" | "command" | "collaboration" | "other";
  code?: number;
  retryAttempt?: number;
  retryInMs?: number;
};

/** Keep in sync with agentUsageSchema in @ai-hive/protocol；四个输入桶互斥 */
export type UsageBuckets = {
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
};
export type AgentUsage = UsageBuckets & {
  model?: string;
  requests: number;
  firstRequest?: Omit<UsageBuckets, "outputTokens">;
  peakContextTokens: number;
  peakCacheWriteTokens: number;
  contextWindow?: number;
  reportedCostUsd?: number;
  session?: "new" | "resumed";
  idleMs?: number;
};

export type InvocationReport = {
  type: "invocation.report";
  messageId: string;
  status: "received" | "running" | "completed" | "failed" | "cancelled" | "uncertain";
  detail?: string;
  progress?: string;
  replyMessageId?: string;
  contextSeq?: number;
  runtimeEvent?: RuntimeEvent;
  usage?: AgentUsage;
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
    }
  | { type: "message.created"; message: ChatMessage }
  | { type: "message.deleted"; message: ChatMessage }
  | { type: "agent.mentioned"; message: ChatMessage; latestSeq: number; retry?: boolean }
  | { type: "agent.cancel"; messageId: string }
  | { type: "invocation.updated"; invocation: Invocation }
  | { type: "presence.changed"; participant: Participant }
  | { type: "rooms.changed"; room: RoomSummary }
  | { type: "error"; code: string; message: string };

/* 与 @ai-hive/protocol 的 maskMarkdownCode / parseMentions 保持一致 */
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
 * 与 @ai-hive/protocol 中的同名函数保持一致：去掉控制符、bidi 覆盖/隔离符和行/段分隔符，
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
