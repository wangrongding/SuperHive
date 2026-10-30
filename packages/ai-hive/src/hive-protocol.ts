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
};

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

export type InvocationReport = {
  type: "invocation.report";
  messageId: string;
  status: "received" | "running" | "completed" | "failed" | "cancelled" | "uncertain";
  detail?: string;
  progress?: string;
  replyMessageId?: string;
  contextSeq?: number;
  runtimeEvent?: RuntimeEvent;
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

const mentionPattern = /@([\p{L}\p{N}_.-]{1,32})/gu;

export function isMentioned(content: string, username: string): boolean {
  const normalized = username.toLocaleLowerCase();
  return [...content.matchAll(mentionPattern)].some(
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
