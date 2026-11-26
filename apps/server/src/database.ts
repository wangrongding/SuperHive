import {
  agentUsageSchema,
  claudeCacheTtlSchema,
  claudeCompactWindowSchema,
  type ClaudeCacheTtl,
  type ClaudeCompactWindow,
  failureKindSchema,
  runtimeObservationSchema,
  type FailureKind,
  type AgentLastModel,
  type AgentUsage,
  type RuntimeObservation,
  type UsageRecord,
  type UsageSummary,
  type UsageTotals,
  serverText,
  isTaskDirectoryEntry,
  serverTextSchema,
  renderServerText,
  zhText,
  type ServerText,
  type WireServerText,
  type RoomClearOptions,
  localAgentProviderSchema,
  type RemovedLocalAgent,
} from "@superhive/protocol";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import {
  LIMITS,
  sortParticipantsByLastSeen,
  parseMentions,
  stripUnsafeCharacters,
  messageViaSchema,
  questionAnswerSchema,
  approvalRefSchema,
  questionSpecSchema,
  attachmentSchema,
  type ChatMessage,
  type QuestionAnswer,
  type QuestionSpec,
  type ApprovalRef,
  type Invocation,
  type InvocationBlockReason,
  type InvocationStatus,
  type LocalAgentAccess,
  type LocalAgentProvider,
  type Participant,
  type AgentProvider,
  type ParticipantStatus,
  type ParticipantType,
  type RoomSummary,
  type Schedule,
  type ScheduleStatus,
  type WhiteboardEntry,
  type WhiteboardSlot,
} from "@superhive/protocol";

type ParticipantRow = {
  id: string;
  room_id: string;
  username: string;
  type: ParticipantType;
  status: ParticipantStatus;
  persona: string | null;
  provider: string | null;
  joined_at: string;
  last_seen_at: string;
  hidden: number;
};

type MessageRow = {
  id: string;
  room_id: string;
  seq: number;
  sender_id: string;
  sender_name: string;
  sender_type: ParticipantType;
  content: string;
  mentions: string;
  reply_to_message_id: string | null;
  trace_id: string;
  parent_message_id: string | null;
  hop_count: number;
  client_message_id: string | null;
  created_at: string;
  deleted_at: string | null;
  kind: string | null;
  meta: string | null;
};

type LocalAgentRow = {
  id: string;
  provider: LocalAgentProvider;
  name: string;
  access: LocalAgentAccess;
  cwd: string | null;
  model: string | null;
  autostart: number;
  created_at: string;
  pid?: number | null;
  pid_started_at?: string | null;
  mcp_disabled?: string | null;
  effort?: string | null;
  compact_window?: string | null;
  cache_ttl?: string | null;
};

export type LocalAgentConfig = {
  id: string;
  provider: LocalAgentProvider;
  name: string;
  access: LocalAgentAccess;
  cwd: string | null;
  model: string | null;
  autostart: boolean;
  createdAt: string;
  /** 上一个 Server 留下、可能仍在运行的进程：Server 交接重启后据此接管，而不是另起一个 */
  pid?: number | null;
  pidStartedAt?: string | null;
  /** 网页上关掉的本机 MCP 名称 */
  mcpDisabled?: string[];
  /** 思考强度；null 表示不传参数，沿用 CLI 自己的配置 */
  effort?: string | null;
  /** Claude 自动压缩阈值；null 表示没设过（按默认 20 万），"auto" 表示交给 Claude Code 自己定 */
  compactWindow?: ClaudeCompactWindow | null;
  /** Claude 缓存时长；null 表示不传，由 Claude Code 自动选 */
  cacheTtl?: ClaudeCacheTtl | null;
};

/** 库里存的是文本："auto" 或 token 数；认不出的当没设过 */
function parseCompactWindow(value: string | null | undefined): ClaudeCompactWindow | null {
  if (!value) return null;
  const parsed = claudeCompactWindowSchema.safeParse(value === "auto" ? value : Number(value));
  return parsed.success ? parsed.data : null;
}

function parseCacheTtl(value: string | null | undefined): ClaudeCacheTtl | null {
  const parsed = claudeCacheTtlSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseNameList(value: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(value ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function mapLocalAgent(row: LocalAgentRow): LocalAgentConfig {
  return {
    id: row.id,
    provider: row.provider,
    name: row.name,
    access: row.access,
    cwd: row.cwd,
    model: row.model,
    autostart: row.autostart === 1,
    createdAt: row.created_at,
    pid: row.pid ?? null,
    pidStartedAt: row.pid_started_at ?? null,
    mcpDisabled: parseNameList(row.mcp_disabled),
    effort: row.effort ?? null,
    compactWindow: parseCompactWindow(row.compact_window),
    cacheTtl: parseCacheTtl(row.cache_ttl),
  };
}

type RoomRow = {
  id: string;
  name: string;
  created_at: string;
  created_by: string | null;
  archived_at: string | null;
  workspace: string | null;
  lead_agent: string | null;
  workspace_files_guests: number | null;
  online_count: number;
  latest_seq: number;
  last_activity_at: string | null;
};

type InvocationRow = {
  id: string;
  room_id: string;
  message_id: string;
  agent_id: string;
  agent_name: string;
  requester_id: string;
  requester_name: string;
  requester_type: ParticipantType;
  status: InvocationStatus;
  block_reason: InvocationBlockReason | null;
  detail: string | null;
  detail_text: string | null;
  failure?: string | null;
  progress: string | null;
  progress_text: string | null;
  runtime: string | null;
  usage: string | null;
  reply_message_id: string | null;
  parent_invocation_id: string | null;
  continuation: InvocationContinuation | null;
  lane_key?: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
  received_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  resolution_kind: "dismissed" | "superseded" | null;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
  resolution_note_text: string | null;
};

type WhiteboardRow = {
  id: string;
  room_id: string;
  key: string;
  slot: WhiteboardSlot;
  summary: string;
  repo: string | null;
  branch: string | null;
  claim_repo: string | null;
  claim_branch: string | null;
  commit_ref: string | null;
  unblocks: string;
  author_id: string;
  author_name: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  message_id: string | null;
  message_seq: number | null;
  merged_at: string | null;
  merged_commit: string | null;
};

type ScheduleRow = {
  id: string;
  room_id: string;
  agent_id: string;
  agent_name: string;
  requester_id: string;
  requester_name: string;
  origin_message_id: string;
  origin_seq: number;
  client_id: string;
  task: string;
  run_at: string;
  time_zone: string;
  every_minutes: number | null;
  until_at: string | null;
  series_id: string | null;
  occurrence: number | null;
  status: ScheduleStatus;
  detail: string | null;
  detail_text: string | null;
  trigger_message_id: string | null;
  invocation_id: string | null;
  fired_at: string | null;
  reported_at: string | null;
  cancelled_by: string | null;
  created_at: string;
  updated_at: string;
};

export type SchedulePatch = {
  status?: ScheduleStatus;
  detail?: DetailInput;
  triggerMessageId?: string | null;
  invocationId?: string | null;
  firedAt?: string | null;
  reportedAt?: string | null;
  cancelledBy?: string | null;
};

export type InvocationContinuation = NonNullable<Invocation["continuation"]>;

/** 子任务进入这些状态即可把结果回执给委派方；blocked 还可能被人放行，不算结束 */
export const CONTINUATION_READY_STATUSES: readonly InvocationStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "timed_out",
];

export type InvocationPatch = {
  status?: InvocationStatus;
  blockReason?: InvocationBlockReason | null;
  detail?: DetailInput;
  /** 失败原因：属于 detail，改 detail 时一起写入（省略即清掉） */
  failure?: FailureKind | null | undefined;
  progress?: DetailInput;
  runtime?: RuntimeObservation | null;
  replyMessageId?: string | null;
  attempts?: number;
  receivedAt?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
};

export type WhiteboardInput = {
  key: string;
  slot: WhiteboardSlot;
  summary: string;
  repo?: string | undefined;
  branch?: string | undefined;
  claim?: { repo: string; branch: string } | undefined;
  commit?: string | undefined;
  unblocks?: string[] | undefined;
  /** 登记时 Agent 正在处理的消息；不给就沿用上次的 */
  source?: { id: string; seq: number } | undefined;
};

export const TERMINAL_INVOCATION_STATUSES: readonly InvocationStatus[] = [
  "completed",
  "failed",
  "blocked",
  "cancelled",
];

export class HiveError extends Error {
  /** 给人看的结构化文案（见 protocol 的 server-text.ts）；message 是它的中文 */
  readonly text: ServerText | undefined;
  constructor(
    public readonly code: string,
    message: string | ServerText,
  ) {
    super(typeof message === "string" ? message : zhText(message));
    this.name = "HiveError";
    this.text = typeof message === "string" ? undefined : message;
  }
}

/** 状态说明：结构化文案同时写中文兼容字段与 *_text；只给字符串时清掉旧的结构化文案 */
export type DetailInput = string | ServerText | WireServerText | null;

function detailColumns(detail: DetailInput, limit = 500): [string | null, string | null] {
  if (detail === null) return [null, null];
  if (typeof detail === "string") return [detail, null];
  return [(renderServerText(detail, "zh-CN") ?? "").slice(0, limit), JSON.stringify(detail)];
}

function parseText(raw: string | null | undefined): WireServerText | undefined {
  if (!raw) return undefined;
  try {
    const parsed = serverTextSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export type CreateMessageInput = {
  content: string;
  clientMessageId: string;
  replyToMessageId?: string;
  parentMessageId?: string;
  /** 只由服务端设置（开启新话题、清空房间、委派与回执），客户端的普通消息没有 kind */
  kind?: NonNullable<ChatMessage["kind"]>;
  /** 带选项的提问的题目定义 */
  question?: QuestionSpec;
  /** 权限申请（kind=question 时） */
  approval?: ApprovalRef;
  /** 点选提交的答案（由服务端校验后生成） */
  answer?: QuestionAnswer;
  /** 经外部 IM 发来的消息（由服务端的 IM 连接设置） */
  via?: NonNullable<ChatMessage["via"]>;
  /** 已校验过的待发附件；有附件时正文可以为空 */
  attachments?: NonNullable<ChatMessage["attachments"]>;
  /** 服务端代发的系统消息的结构化正文（网页按语言渲染；content 是中文给 Agent 读） */
  text?: ServerText;
  /** 与写消息在同一事务里执行（把附件绑定到这条消息）；抛错则整条消息不写入 */
  onInsert?: (messageId: string) => void;
};

export type CreateMessageResult = {
  message: ChatMessage;
  created: boolean;
  participant?: Participant;
};

function mapParticipant(row: ParticipantRow): Participant {
  return {
    id: row.id,
    roomId: row.room_id,
    username: row.username,
    type: row.type,
    status: row.status,
    ...(row.persona ? { persona: row.persona } : {}),
    ...(row.provider ? { provider: row.provider } : {}),
    joinedAt: row.joined_at,
    lastSeenAt: row.last_seen_at,
    ...(row.hidden ? { hidden: true } : {}),
  };
}

function mapMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    roomId: row.room_id,
    seq: row.seq,
    senderId: row.sender_id,
    senderName: row.sender_name,
    senderType: row.sender_type,
    content: row.content,
    mentions: JSON.parse(row.mentions) as string[],
    ...(row.reply_to_message_id ? { replyToMessageId: row.reply_to_message_id } : {}),
    traceId: row.trace_id,
    ...(row.parent_message_id ? { parentMessageId: row.parent_message_id } : {}),
    hopCount: row.hop_count,
    ...(row.client_message_id ? { clientMessageId: row.client_message_id } : {}),
    createdAt: row.created_at,
    ...(row.deleted_at ? { deletedAt: row.deleted_at } : {}),
    ...(row.kind === "topic" ||
    row.kind === "delegation" ||
    row.kind === "receipt" ||
    row.kind === "question" ||
    row.kind === "schedule" ||
    row.kind === "progress"
      ? { kind: row.kind as NonNullable<ChatMessage["kind"]> }
      : {}),
    ...(row.deleted_at ? {} : parseMessageMeta(row.meta)),
  };
}

/** 损坏或不认识的元数据只当作没有：消息正文仍是唯一的语义来源 */
function parseMessageMeta(
  raw: string | null,
): Pick<ChatMessage, "question" | "answer" | "approval" | "via" | "attachments" | "text"> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as {
      question?: unknown;
      answer?: unknown;
      approval?: unknown;
      via?: unknown;
      attachments?: unknown;
      text?: unknown;
    };
    const text = serverTextSchema.safeParse(value.text);
    const question = questionSpecSchema.safeParse(value.question);
    const answer = questionAnswerSchema.safeParse(value.answer);
    const approval = approvalRefSchema.safeParse(value.approval);
    const via = messageViaSchema.safeParse(value.via);
    const attachments = attachmentSchema.array().min(1).safeParse(value.attachments);
    return {
      ...(question.success ? { question: question.data } : {}),
      ...(answer.success ? { answer: answer.data } : {}),
      ...(approval.success ? { approval: approval.data } : {}),
      ...(via.success ? { via: via.data } : {}),
      ...(attachments.success ? { attachments: attachments.data } : {}),
      ...(text.success ? { text: text.data } : {}),
    };
  } catch {
    return {};
  }
}

function parseUsage(value: string | null | undefined): AgentUsage | undefined {
  try {
    const parsed = agentUsageSchema.safeParse(JSON.parse(value ?? "null"));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function emptyTotals(): UsageTotals {
  return {
    inputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    turns: 0,
    requests: 0,
    reportedCostUsd: 0,
    largeCacheWrites: 0,
  };
}

function addUsage(totals: UsageTotals, usage: AgentUsage, alertTokens: number): void {
  totals.inputTokens += usage.inputTokens;
  totals.cacheWriteTokens += usage.cacheWriteTokens;
  totals.cacheReadTokens += usage.cacheReadTokens;
  totals.outputTokens += usage.outputTokens;
  totals.turns += 1;
  totals.requests += usage.requests;
  totals.reportedCostUsd += usage.reportedCostUsd ?? 0;
  if (usage.peakCacheWriteTokens >= alertTokens) totals.largeCacheWrites += 1;
}

/** 服务端本地时区的日期，用作按天汇总的键 */
function localDay(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function mapInvocation(row: InvocationRow): Invocation {
  let runtime: RuntimeObservation | undefined;
  try {
    const parsed = runtimeObservationSchema.safeParse(JSON.parse(row.runtime ?? "null"));
    if (parsed.success) runtime = parsed.data;
  } catch {
    /* A corrupt optional diagnostic field must not hide the invocation. */
  }
  const usage = parseUsage(row.usage);
  return {
    ...(runtime ? { runtime } : {}),
    ...(usage ? { usage } : {}),
    id: row.id,
    roomId: row.room_id,
    messageId: row.message_id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    requesterId: row.requester_id,
    requesterName: row.requester_name,
    requesterType: row.requester_type,
    ...(row.parent_invocation_id ? { parentInvocationId: row.parent_invocation_id } : {}),
    ...(row.continuation ? { continuation: row.continuation } : {}),
    ...(row.lane_key ? { laneKey: row.lane_key } : {}),
    status: row.status,
    ...(row.block_reason ? { blockReason: row.block_reason } : {}),
    ...(row.detail ? { detail: row.detail } : {}),
    ...(row.detail && parseText(row.detail_text)
      ? { detailText: parseText(row.detail_text)! }
      : {}),
    ...(row.detail && failureKindSchema.safeParse(row.failure).success
      ? { failure: failureKindSchema.parse(row.failure) }
      : {}),
    ...(row.progress ? { progress: row.progress } : {}),
    ...(row.progress && parseText(row.progress_text)
      ? { progressText: parseText(row.progress_text)! }
      : {}),
    ...(row.reply_message_id ? { replyMessageId: row.reply_message_id } : {}),
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.received_at ? { receivedAt: row.received_at } : {}),
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
    ...(row.resolution_kind && row.resolved_at
      ? {
          resolution: {
            kind: row.resolution_kind,
            at: row.resolved_at,
            ...(row.resolved_by ? { by: row.resolved_by } : {}),
            ...(row.resolution_note ? { note: row.resolution_note } : {}),
            ...(row.resolution_note && parseText(row.resolution_note_text)
              ? { noteText: parseText(row.resolution_note_text)! }
              : {}),
          },
        }
      : {}),
  };
}

function mapSchedule(row: ScheduleRow): Schedule {
  return {
    id: row.id,
    roomId: row.room_id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    requesterId: row.requester_id,
    requesterName: row.requester_name,
    originMessageId: row.origin_message_id,
    originSeq: row.origin_seq,
    task: row.task,
    runAt: row.run_at,
    timeZone: row.time_zone,
    ...(row.every_minutes ? { everyMinutes: row.every_minutes } : {}),
    ...(row.until_at ? { until: row.until_at } : {}),
    ...(row.series_id ? { seriesId: row.series_id } : {}),
    ...(row.occurrence ? { occurrence: row.occurrence } : {}),
    status: row.status,
    ...(row.detail ? { detail: row.detail } : {}),
    ...(row.detail && parseText(row.detail_text)
      ? { detailText: parseText(row.detail_text)! }
      : {}),
    ...(row.trigger_message_id ? { triggerMessageId: row.trigger_message_id } : {}),
    ...(row.invocation_id ? { invocationId: row.invocation_id } : {}),
    ...(row.fired_at ? { firedAt: row.fired_at } : {}),
    ...(row.cancelled_by ? { cancelledBy: row.cancelled_by } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapWhiteboard(row: WhiteboardRow): WhiteboardEntry {
  return {
    id: row.id,
    roomId: row.room_id,
    key: row.key,
    ...(isTaskDirectoryEntry(row) ? { kind: "task_directory" as const } : {}),
    slot: row.slot,
    summary: row.summary,
    ...(row.repo ? { repo: row.repo } : {}),
    ...(row.branch ? { branch: row.branch } : {}),
    ...(row.claim_repo && row.claim_branch
      ? { claim: { repo: row.claim_repo, branch: row.claim_branch } }
      : {}),
    ...(row.commit_ref ? { commit: row.commit_ref } : {}),
    unblocks: JSON.parse(row.unblocks) as string[],
    authorId: row.author_id,
    authorName: row.author_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
    ...(row.message_id && row.message_seq
      ? { messageId: row.message_id, messageSeq: row.message_seq }
      : {}),
    ...(row.merged_at ? { mergedAt: row.merged_at } : {}),
  };
}

function mapRoom(row: RoomRow): RoomSummary {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    ...(row.created_by ? { createdBy: row.created_by } : {}),
    ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
    ...(row.workspace ? { workspace: row.workspace } : {}),
    ...(row.lead_agent ? { leadAgent: row.lead_agent } : {}),
    ...(row.workspace_files_guests ? { workspaceFilesGuests: true } : {}),
    onlineCount: row.online_count,
    latestSeq: row.latest_seq,
    ...(row.last_activity_at ? { lastActivityAt: row.last_activity_at } : {}),
  };
}

const roomSummarySelect = `
  SELECT r.id, r.name, r.created_at, r.created_by, r.archived_at, r.workspace, r.lead_agent,
         r.workspace_files_guests,
         COALESCE(p.online_count, 0) AS online_count,
         COALESCE(m.latest_seq, 0) AS latest_seq,
         lm.created_at AS last_activity_at
  FROM rooms r
  LEFT JOIN (
    SELECT room_id, COUNT(*) AS online_count FROM participants
    WHERE status != 'offline' GROUP BY room_id
  ) p ON p.room_id = r.id
  LEFT JOIN (
    SELECT room_id, MAX(seq) AS latest_seq FROM messages GROUP BY room_id
  ) m ON m.room_id = r.id
  LEFT JOIN messages lm ON lm.seq = m.latest_seq
`;

export class HiveDatabase {
  private readonly db: Database.Database;

  constructor(filename: string) {
    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    // 撤回会清空正文；secure_delete 让被覆盖的旧内容在页内被清零，而不是留在空闲空间里
    this.db.pragma("secure_delete = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS participants (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        username TEXT NOT NULL,
        username_key TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('human', 'agent')),
        status TEXT NOT NULL CHECK(status IN ('online', 'offline', 'busy')),
        persona TEXT,
        provider TEXT,
        joined_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        UNIQUE(room_id, username_key)
      );

      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        room_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        sender_type TEXT NOT NULL CHECK(sender_type IN ('human', 'agent')),
        content TEXT NOT NULL,
        mentions TEXT NOT NULL,
        reply_to_message_id TEXT,
        trace_id TEXT NOT NULL,
        parent_message_id TEXT,
        hop_count INTEGER NOT NULL,
        client_message_id TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(sender_id) REFERENCES participants(id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS messages_sender_client_id
        ON messages(sender_id, client_message_id)
        WHERE client_message_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS messages_room_seq ON messages(room_id, seq);
      CREATE INDEX IF NOT EXISTS messages_trace ON messages(trace_id, sender_type);

      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_by TEXT,
        archived_at TEXT
      );

      CREATE TABLE IF NOT EXISTS invocations (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        requester_id TEXT NOT NULL,
        requester_name TEXT NOT NULL,
        requester_type TEXT NOT NULL CHECK(requester_type IN ('human', 'agent')),
        status TEXT NOT NULL,
        block_reason TEXT,
        detail TEXT,
        progress TEXT,
        reply_message_id TEXT,
        attempts INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        received_at TEXT,
        started_at TEXT,
        finished_at TEXT,
        UNIQUE(message_id, agent_id)
      );
      CREATE INDEX IF NOT EXISTS invocations_room ON invocations(room_id, created_at);
      CREATE INDEX IF NOT EXISTS invocations_agent_status ON invocations(agent_id, status);
      CREATE INDEX IF NOT EXISTS invocations_status ON invocations(status);
      CREATE INDEX IF NOT EXISTS invocations_pair
        ON invocations(room_id, requester_id, agent_id, created_at);

      CREATE TABLE IF NOT EXISTS whiteboard_entries (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        key TEXT NOT NULL,
        slot TEXT NOT NULL CHECK(slot IN ('ready', 'in_progress', 'blocked', 'milestone')),
        summary TEXT NOT NULL,
        repo TEXT,
        branch TEXT,
        commit_ref TEXT,
        unblocks TEXT NOT NULL DEFAULT '[]',
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(room_id, key)
      );

      -- 用量账本：每个 Agent 回合一行（同一调用重试会有多行）。清空房间不删除，费用统计不会因开新话题而丢失
      CREATE TABLE IF NOT EXISTS agent_usage (
        turn_key TEXT PRIMARY KEY,
        invocation_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        model TEXT,
        usage TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_usage_room ON agent_usage(room_id, created_at);

      -- 定时任务：到点由服务端代发起人发出触发消息（见 Schedule）；执行状态记在 invocation_id 对应的调用上。
      -- reported_at：没有正常回复、错过或无法发出时，服务端补发说明后记下，补发靠扫描重试且只发一次
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        requester_id TEXT NOT NULL,
        requester_name TEXT NOT NULL,
        origin_message_id TEXT NOT NULL,
        origin_seq INTEGER NOT NULL,
        client_id TEXT NOT NULL,
        task TEXT NOT NULL,
        run_at TEXT NOT NULL,
        time_zone TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT,
        trigger_message_id TEXT,
        invocation_id TEXT,
        fired_at TEXT,
        reported_at TEXT,
        cancelled_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(agent_id, client_id)
      );
      CREATE INDEX IF NOT EXISTS schedules_due ON schedules(status, run_at);
      CREATE INDEX IF NOT EXISTS schedules_room ON schedules(room_id, created_at);
      CREATE INDEX IF NOT EXISTS schedules_invocation ON schedules(invocation_id);

      CREATE TABLE IF NOT EXISTS local_agents (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        name TEXT NOT NULL,
        name_key TEXT NOT NULL UNIQUE,
        access TEXT NOT NULL,
        cwd TEXT,
        model TEXT,
        autostart INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS removed_local_agents (
        name_key TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        cwd TEXT
      );
    `);
    const localAgentColumns = this.db.pragma("table_info(local_agents)") as Array<{ name: string }>;
    if (!localAgentColumns.some((column) => column.name === "pid")) {
      this.db.exec("ALTER TABLE local_agents ADD COLUMN pid INTEGER");
      this.db.exec("ALTER TABLE local_agents ADD COLUMN pid_started_at TEXT");
    }
    if (!localAgentColumns.some((column) => column.name === "mcp_disabled")) {
      this.db.exec("ALTER TABLE local_agents ADD COLUMN mcp_disabled TEXT");
    }
    if (!localAgentColumns.some((column) => column.name === "effort")) {
      this.db.exec("ALTER TABLE local_agents ADD COLUMN effort TEXT");
    }
    if (!localAgentColumns.some((column) => column.name === "compact_window")) {
      this.db.exec("ALTER TABLE local_agents ADD COLUMN compact_window TEXT");
    }
    if (!localAgentColumns.some((column) => column.name === "cache_ttl")) {
      this.db.exec("ALTER TABLE local_agents ADD COLUMN cache_ttl TEXT");
    }
    const participantColumns = this.db.pragma("table_info(participants)") as Array<{
      name: string;
    }>;
    if (!participantColumns.some((column) => column.name === "provider")) {
      this.db.exec("ALTER TABLE participants ADD COLUMN provider TEXT");
    }
    if (!participantColumns.some((column) => column.name === "hidden")) {
      this.db.exec("ALTER TABLE participants ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0");
    }
    const boardColumns = this.db.pragma("table_info(whiteboard_entries)") as Array<{
      name: string;
    }>;
    if (!boardColumns.some((column) => column.name === "archived_at")) {
      this.db.exec("ALTER TABLE whiteboard_entries ADD COLUMN archived_at TEXT");
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS whiteboard_archive
      ON whiteboard_entries(room_id, archived_at, updated_at)`);
    if (!boardColumns.some((column) => column.name === "claim_repo")) {
      this.db.exec("ALTER TABLE whiteboard_entries ADD COLUMN claim_repo TEXT");
      this.db.exec("ALTER TABLE whiteboard_entries ADD COLUMN claim_branch TEXT");
    }
    if (!boardColumns.some((column) => column.name === "message_id")) {
      this.db.exec("ALTER TABLE whiteboard_entries ADD COLUMN message_id TEXT");
      this.db.exec("ALTER TABLE whiteboard_entries ADD COLUMN message_seq INTEGER");
    }
    if (!boardColumns.some((column) => column.name === "merged_at")) {
      this.db.exec("ALTER TABLE whiteboard_entries ADD COLUMN merged_at TEXT");
      this.db.exec("ALTER TABLE whiteboard_entries ADD COLUMN merged_commit TEXT");
    }
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS whiteboard_branch_claim
      ON whiteboard_entries(claim_repo, claim_branch)
      WHERE slot = 'in_progress' AND claim_repo IS NOT NULL AND claim_branch IS NOT NULL`);
    const invocationColumns = this.db.pragma("table_info(invocations)") as Array<{ name: string }>;
    if (!invocationColumns.some((column) => column.name === "runtime")) {
      this.db.exec("ALTER TABLE invocations ADD COLUMN runtime TEXT");
    }
    // 这一次执行已发的进度条数（重试清零，提问后续上的调用接着算）
    if (!invocationColumns.some((column) => column.name === "progress_count")) {
      this.db.exec("ALTER TABLE invocations ADD COLUMN progress_count INTEGER NOT NULL DEFAULT 0");
    }
    if (!invocationColumns.some((column) => column.name === "resolution_kind")) {
      this.db.exec(`
        ALTER TABLE invocations ADD COLUMN resolution_kind TEXT;
        ALTER TABLE invocations ADD COLUMN resolved_at TEXT;
        ALTER TABLE invocations ADD COLUMN resolved_by TEXT;
        ALTER TABLE invocations ADD COLUMN resolution_note TEXT;
      `);
    }
    const usageColumns = this.db.pragma("table_info(agent_usage)") as Array<{ name: string }>;
    if (!usageColumns.some((column) => column.name === "turn_key")) {
      // 早期账本按调用 ID 唯一，重试会覆盖上一次的用量：改为按回合记账
      this.db.exec(`
        ALTER TABLE agent_usage RENAME TO agent_usage_v1;
        CREATE TABLE agent_usage (
          turn_key TEXT PRIMARY KEY,
          invocation_id TEXT NOT NULL,
          room_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          agent_name TEXT NOT NULL,
          model TEXT,
          usage TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        INSERT INTO agent_usage SELECT invocation_id, invocation_id, room_id, message_id, agent_id,
          agent_name, model, usage, created_at FROM agent_usage_v1;
        DROP TABLE agent_usage_v1;
        DROP INDEX IF EXISTS agent_usage_room;
        CREATE INDEX agent_usage_room ON agent_usage(room_id, created_at);
      `);
    }
    if (!invocationColumns.some((column) => column.name === "detail_text")) {
      // detail 的结构化文案（JSON，见 protocol 的 server-text.ts），网页按用户语言渲染
      this.db.exec("ALTER TABLE invocations ADD COLUMN detail_text TEXT");
    }
    if (!invocationColumns.some((column) => column.name === "failure")) {
      // 失败原因（protocol 的 failureKindSchema），随 detail 一起写入、一起清掉
      this.db.exec("ALTER TABLE invocations ADD COLUMN failure TEXT");
    }
    if (!invocationColumns.some((column) => column.name === "resolution_note_text")) {
      this.db.exec("ALTER TABLE invocations ADD COLUMN resolution_note_text TEXT");
    }
    if (!invocationColumns.some((column) => column.name === "progress_text")) {
      this.db.exec("ALTER TABLE invocations ADD COLUMN progress_text TEXT");
    }
    if (!invocationColumns.some((column) => column.name === "usage")) {
      this.db.exec("ALTER TABLE invocations ADD COLUMN usage TEXT");
    }
    if (!invocationColumns.some((column) => column.name === "parent_invocation_id")) {
      // 委派关系与子任务回执状态（见 Invocation.parentInvocationId / continuation）
      this.db.exec("ALTER TABLE invocations ADD COLUMN parent_invocation_id TEXT");
      this.db.exec("ALTER TABLE invocations ADD COLUMN continuation TEXT");
    }
    if (!invocationColumns.some((column) => column.name === "lane_key")) {
      // 这次调用属于 Agent 的哪一道会话（见 Invocation.laneKey）；老数据为空，按主道处理
      this.db.exec("ALTER TABLE invocations ADD COLUMN lane_key TEXT");
    }
    const messageColumns = this.db.pragma("table_info(messages)") as Array<{ name: string }>;
    if (!messageColumns.some((column) => column.name === "deleted_at")) {
      this.db.exec("ALTER TABLE messages ADD COLUMN deleted_at TEXT");
    }
    if (!messageColumns.some((column) => column.name === "kind")) {
      this.db.exec("ALTER TABLE messages ADD COLUMN kind TEXT");
    }
    if (!messageColumns.some((column) => column.name === "meta")) {
      // 提问的题目定义 / 点选答案（JSON，见 ChatMessage.question / answer）
      this.db.exec("ALTER TABLE messages ADD COLUMN meta TEXT");
    }
    const scheduleColumns = this.db.pragma("table_info(schedules)") as Array<{ name: string }>;
    if (!scheduleColumns.some((column) => column.name === "detail_text")) {
      this.db.exec("ALTER TABLE schedules ADD COLUMN detail_text TEXT");
    }
    if (!scheduleColumns.some((column) => column.name === "every_minutes")) {
      // 周期任务：同一个周期的每一次各占一行，到点时登记下一次
      this.db.exec(`
        ALTER TABLE schedules ADD COLUMN every_minutes INTEGER;
        ALTER TABLE schedules ADD COLUMN until_at TEXT;
        ALTER TABLE schedules ADD COLUMN series_id TEXT;
        ALTER TABLE schedules ADD COLUMN occurrence INTEGER;
      `);
    }
    const roomColumns = this.db.pragma("table_info(rooms)") as Array<{ name: string }>;
    if (!roomColumns.some((column) => column.name === "workspace")) {
      this.db.exec("ALTER TABLE rooms ADD COLUMN workspace TEXT");
    }
    if (!roomColumns.some((column) => column.name === "lead_agent")) {
      this.db.exec("ALTER TABLE rooms ADD COLUMN lead_agent TEXT");
    }
    if (!roomColumns.some((column) => column.name === "workspace_files_guests")) {
      // 房主允许访客只读查看工作区文件与 git 变更；默认关
      this.db.exec(
        "ALTER TABLE rooms ADD COLUMN workspace_files_guests INTEGER NOT NULL DEFAULT 0",
      );
    }
    if (!roomColumns.some((column) => column.name === "agent_turn_allowance")) {
      // 人为 Agent 互相对话追加的轮数；只在授予时的那条人类消息之后有效
      this.db.exec("ALTER TABLE rooms ADD COLUMN agent_turn_allowance INTEGER NOT NULL DEFAULT 0");
      this.db.exec("ALTER TABLE rooms ADD COLUMN allowance_after_seq INTEGER NOT NULL DEFAULT 0");
    }
    if (!participantColumns.some((column) => column.name === "inbox_seq")) {
      // Hive MCP 未读游标；NULL 表示该 Agent 还没建立过游标
      this.db.exec("ALTER TABLE participants ADD COLUMN inbox_seq INTEGER");
    }
    // 全文索引：trigram 分词可直接按子串匹配中文；外部内容表随 messages 触发器同步（撤回会清空正文）
    const ftsExists = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'")
      .get();
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content, content='messages', content_rowid='seq', tokenize='trigram'
      );
      CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.seq, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.seq, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE OF content ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.seq, old.content);
        INSERT INTO messages_fts(rowid, content) VALUES (new.seq, new.content);
      END;
    `);
    if (!ftsExists) this.db.exec("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')");
    const roomSeedTime = new Date().toISOString();
    this.db
      .prepare("INSERT OR IGNORE INTO rooms(id, name, created_at) VALUES('general', 'general', ?)")
      .run(roomSeedTime);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO rooms(id, name, created_at)
         SELECT room_id, room_id, ? FROM (
           SELECT room_id FROM participants UNION SELECT room_id FROM messages
         )`,
      )
      .run(roomSeedTime);
    this.db.prepare("UPDATE participants SET status = 'offline'").run();
  }

  /** 供同库的其他存储（如限时邀请）建表与读写 */
  connection(): Database.Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }

  /** 服务端的小设置（存在 meta 表里，JSON） */
  getSetting(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(`setting:${key}`) as
      { value: string } | undefined;
    return row?.value;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(`setting:${key}`, value);
  }

  getOrCreateToken(configuredToken?: string): string {
    if (configuredToken) {
      this.db
        .prepare(
          "INSERT INTO meta(key, value) VALUES('join_token', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(configuredToken);
      return configuredToken;
    }
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'join_token'").get() as
      { value: string } | undefined;
    if (row) return row.value;
    const token = randomUUID().replaceAll("-", "");
    this.db.prepare("INSERT INTO meta(key, value) VALUES('join_token', ?)").run(token);
    return token;
  }

  listRooms(includeArchived = false): RoomSummary[] {
    const rows = this.db
      .prepare(
        `${roomSummarySelect} WHERE (? = 1 OR r.archived_at IS NULL) ORDER BY r.created_at, r.id`,
      )
      .all(includeArchived ? 1 : 0) as RoomRow[];
    return rows.map(mapRoom);
  }

  getRoom(id: string): RoomSummary | undefined {
    const row = this.db.prepare(`${roomSummarySelect} WHERE r.id = ?`).get(id) as
      RoomRow | undefined;
    return row ? mapRoom(row) : undefined;
  }

  createRoom(input: {
    id: string;
    name?: string | undefined;
    createdBy?: string | undefined;
    workspace?: string | undefined;
  }): RoomSummary {
    const existing = this.db.prepare("SELECT id FROM rooms WHERE id = ?").get(input.id);
    if (existing) throw new HiveError("ROOM_EXISTS", serverText("error.room.exists"));
    this.db
      .prepare(
        "INSERT INTO rooms(id, name, created_at, created_by, workspace) VALUES(?, ?, ?, ?, ?)",
      )
      .run(
        input.id,
        input.name ?? input.id,
        new Date().toISOString(),
        input.createdBy ?? null,
        input.workspace ?? null,
      );
    return this.getRoom(input.id)!;
  }

  ensureRoom(id: string, createdBy?: string): { room: RoomSummary; created: boolean } {
    const room = this.getRoom(id);
    if (room) return { room, created: false };
    return { room: this.createRoom({ id, createdBy }), created: true };
  }

  updateRoom(
    id: string,
    patch: {
      name?: string | undefined;
      archived?: boolean | undefined;
      workspace?: string | null | undefined;
      leadAgent?: string | null | undefined;
      workspaceFilesGuests?: boolean | undefined;
    },
  ): RoomSummary {
    const room = this.getRoom(id);
    if (!room) throw new HiveError("ROOM_NOT_FOUND", serverText("error.room.notFound"));
    if (patch.archived === true && id === "general") {
      throw new HiveError("ROOM_PROTECTED", serverText("error.room.defaultProtected"));
    }
    if (patch.name !== undefined) {
      this.db.prepare("UPDATE rooms SET name = ? WHERE id = ?").run(patch.name, id);
    }
    if (patch.workspace !== undefined) {
      this.db.prepare("UPDATE rooms SET workspace = ? WHERE id = ?").run(patch.workspace, id);
    }
    if (patch.leadAgent !== undefined) {
      this.db.prepare("UPDATE rooms SET lead_agent = ? WHERE id = ?").run(patch.leadAgent, id);
    }
    if (patch.workspaceFilesGuests !== undefined) {
      this.db
        .prepare("UPDATE rooms SET workspace_files_guests = ? WHERE id = ?")
        .run(patch.workspaceFilesGuests ? 1 : 0, id);
    }
    if (patch.archived === true) {
      this.db
        .prepare("UPDATE rooms SET archived_at = COALESCE(archived_at, ?) WHERE id = ?")
        .run(new Date().toISOString(), id);
    } else if (patch.archived === false) {
      this.db.prepare("UPDATE rooms SET archived_at = NULL WHERE id = ?").run(id);
    }
    return this.getRoom(id)!;
  }

  onlineCount(roomId: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM participants WHERE room_id = ? AND status != 'offline'",
      )
      .get(roomId) as { count: number };
    return row.count;
  }

  upsertParticipant(input: {
    roomId: string;
    username: string;
    type: ParticipantType;
    persona?: string;
    provider?: AgentProvider;
  }): Participant {
    const usernameKey = input.username.toLocaleLowerCase();
    const existing = this.db
      .prepare("SELECT * FROM participants WHERE room_id = ? AND username_key = ?")
      .get(input.roomId, usernameKey) as ParticipantRow | undefined;
    const now = new Date().toISOString();
    if (existing) {
      if (existing.type !== input.type) {
        throw new HiveError("USERNAME_TAKEN", serverText("error.name.otherType"));
      }
      this.db
        .prepare(
          "UPDATE participants SET username = ?, persona = ?, provider = ?, status = 'online', hidden = 0, last_seen_at = ? WHERE id = ?",
        )
        .run(input.username, input.persona ?? null, input.provider ?? null, now, existing.id);
      return this.getParticipant(existing.id)!;
    }

    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO participants(id, room_id, username, username_key, type, status, persona, provider, joined_at, last_seen_at) VALUES(?, ?, ?, ?, ?, 'online', ?, ?, ?, ?)",
      )
      .run(
        id,
        input.roomId,
        input.username,
        usernameKey,
        input.type,
        input.persona ?? null,
        input.provider ?? null,
        now,
        now,
      );
    return this.getParticipant(id)!;
  }

  /** Hive MCP 未读游标：未建立过时返回 undefined */
  getInboxCursor(participantId: string): number | undefined {
    const row = this.db
      .prepare("SELECT inbox_seq FROM participants WHERE id = ?")
      .get(participantId) as { inbox_seq: number | null } | undefined;
    return row?.inbox_seq ?? undefined;
  }

  setInboxCursor(participantId: string, seq: number): void {
    this.db.prepare("UPDATE participants SET inbox_seq = ? WHERE id = ?").run(seq, participantId);
  }

  getParticipant(id: string): Participant | undefined {
    const row = this.db.prepare("SELECT * FROM participants WHERE id = ?").get(id) as
      ParticipantRow | undefined;
    return row ? mapParticipant(row) : undefined;
  }

  listParticipants(roomId: string): Participant[] {
    const rows = this.db
      .prepare("SELECT * FROM participants WHERE room_id = ?")
      .all(roomId) as ParticipantRow[];
    return sortParticipantsByLastSeen(rows.map(mapParticipant));
  }

  setParticipantStatus(id: string, status: ParticipantStatus): Participant {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE participants SET status = ?, last_seen_at = ? WHERE id = ?")
      .run(status, now, id);
    const participant = this.getParticipant(id);
    if (!participant)
      throw new HiveError("PARTICIPANT_NOT_FOUND", serverText("error.member.notFound"));
    return participant;
  }

  /** 房间最近一条消息的时间（seq 递增，最大 seq 那条就是最新的） */
  lastActivityAt(roomId: string): string | undefined {
    const row = this.db
      .prepare("SELECT created_at FROM messages WHERE room_id = ? ORDER BY seq DESC LIMIT 1")
      .get(roomId) as { created_at: string } | undefined;
    return row?.created_at;
  }

  latestSeq(roomId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS latest FROM messages WHERE room_id = ?")
      .get(roomId) as { latest: number };
    return row.latest;
  }

  getMessages(roomId: string, afterSeq = 0, limit = 200): ChatMessage[] {
    const rows = this.db
      .prepare("SELECT * FROM messages WHERE room_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?")
      .all(roomId, afterSeq, limit) as MessageRow[];
    return rows.map(mapMessage);
  }

  getRecentMessages(roomId: string, limit = 100): ChatMessage[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM (SELECT * FROM messages WHERE room_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC",
      )
      .all(roomId, limit) as MessageRow[];
    return rows.map(mapMessage);
  }

  /** 当前话题的起点：最近一条话题分隔的 seq，没有则为 0 */
  currentTopicSeq(roomId: string): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(seq), 0) AS seq FROM messages WHERE room_id = ? AND kind = 'topic'",
      )
      .get(roomId) as { seq: number };
    return row.seq;
  }

  /**
   * 清空房间的消息和调用记录，默认同时归档当前白板。
   * seq 由 AUTOINCREMENT 保证继续递增，Agent 记录的处理进度不会因此错乱。
   */
  clearRoom(
    roomId: string,
    by?: string,
    options: RoomClearOptions = { whiteboard: "archive" },
  ): { messages: number; invocations: number; archivedEntries: WhiteboardEntry[] } {
    return this.db.transaction(() => {
      let archivedEntries: WhiteboardEntry[] = [];
      if (options.whiteboard === "archive") {
        const current = this.listWhiteboard(roomId);
        const protectedCount = current.filter((entry) => entry.archiveProtected).length;
        if (protectedCount)
          throw new HiveError(
            "WHITEBOARD_PROTECTED",
            serverText("error.room.whiteboardProtected", { count: protectedCount }),
          );
        const currentVersions = new Map(current.map((entry) => [entry.id, entry.updatedAt]));
        if (
          options.entries &&
          (options.entries.length !== current.length ||
            new Set(options.entries.map((entry) => entry.id)).size !== current.length ||
            options.entries.some((entry) => currentVersions.get(entry.id) !== entry.updatedAt))
        )
          throw new HiveError("WHITEBOARD_CONFLICT", serverText("error.whiteboard.conflict"));
        if (current.length)
          archivedEntries = this.changeWhiteboardArchive(
            roomId,
            current.map(({ id, updatedAt }) => ({ id, updatedAt })),
            true,
          );
      }
      const invocations = this.db.prepare("DELETE FROM invocations WHERE room_id = ?").run(roomId);
      const messages = this.db.prepare("DELETE FROM messages WHERE room_id = ?").run(roomId);
      // 消息和调用都没了：待执行的定时任务一并取消，已发出的不再补发说明（界面上仍留着记录）
      const now = new Date().toISOString();
      this.db
        .prepare(
          `UPDATE schedules SET status = 'cancelled', detail = ?, detail_text = ?, cancelled_by = ?,
             updated_at = ? WHERE room_id = ? AND status IN ('scheduled', 'firing')`,
        )
        .run(...detailColumns(serverText("schedule.roomCleared")), by ?? null, now, roomId);
      this.db
        .prepare(
          "UPDATE schedules SET reported_at = ?, updated_at = ? WHERE room_id = ? AND reported_at IS NULL",
        )
        .run(now, now, roomId);
      return { messages: messages.changes, invocations: invocations.changes, archivedEntries };
    })();
  }

  /** 这次执行已发的进度条数 */
  progressCount(invocationId: string): number {
    const row = this.db
      .prepare("SELECT progress_count FROM invocations WHERE id = ?")
      .get(invocationId) as { progress_count: number } | undefined;
    return row?.progress_count ?? 0;
  }

  setProgressCount(invocationId: string, count: number): void {
    this.db
      .prepare("UPDATE invocations SET progress_count = ? WHERE id = ?")
      .run(count, invocationId);
  }

  getMessage(id: string): ChatMessage | undefined {
    const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as
      MessageRow | undefined;
    return row ? mapMessage(row) : undefined;
  }

  /**
   * 撤回消息：保留 seq 占位（客户端靠 seq 增量同步），但把正文和提及从库里真正清掉，
   * 误发的敏感内容不会留在 sqlite 文件里。只有发送者本人可以撤回；重复撤回幂等。
   */
  deleteMessage(actor: Participant, messageId: string): ChatMessage {
    const message = this.getMessage(messageId);
    if (!message || message.roomId !== actor.roomId) {
      throw new HiveError("MESSAGE_NOT_FOUND", serverText("error.message.notInRoom"));
    }
    if (message.senderId !== actor.id) {
      throw new HiveError("FORBIDDEN", serverText("error.message.recallSenderOnly"));
    }
    if (message.deletedAt) return message;
    const deletedAt = new Date().toISOString();
    this.db
      .prepare("UPDATE messages SET content = '', mentions = '[]', deleted_at = ? WHERE id = ?")
      .run(deletedAt, messageId);
    // WAL 里仍保留着含原文的旧页面镜像，立刻 checkpoint 并截断，避免正文残留在 -wal 文件中
    this.db.pragma("wal_checkpoint(TRUNCATE)");
    return this.getMessage(messageId)!;
  }

  createMessage(sender: Participant, input: CreateMessageInput): CreateMessageResult {
    const existing = this.db
      .prepare("SELECT * FROM messages WHERE sender_id = ? AND client_message_id = ?")
      .get(sender.id, input.clientMessageId) as MessageRow | undefined;
    if (existing) return { message: mapMessage(existing), created: false };

    let parent: ChatMessage | undefined;
    if (sender.type === "agent" && input.parentMessageId) {
      parent = this.getMessage(input.parentMessageId);
      if (!parent || parent.roomId !== sender.roomId) {
        throw new HiveError("PARENT_NOT_FOUND", serverText("error.message.parentMissing"));
      }
      // hive_room_post 替房主转来的派活以接活 Agent 同名成员的身份发出（每个房间各是一个成员、各有会话），
      // 接活的就是这条消息的发送者本人：它的回复要能挂上去，否则活干完了话发不出来
      if (parent.senderId === sender.id && parent.text?.key !== "roomPost.forwarded") {
        throw new HiveError("SELF_RESPONSE", serverText("error.message.selfResponse"));
      }
      if (parent.hopCount >= LIMITS.maxHopCount + this.turnAllowance(sender.roomId)) {
        throw new HiveError("HOP_LIMIT", serverText("error.message.hopLimit"));
      }
    }

    const traceId = parent?.traceId ?? randomUUID();
    const hopCount = parent ? parent.hopCount + 1 : 0;
    if (sender.type === "agent") {
      const traceCount = this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM messages WHERE trace_id = ? AND sender_type = 'agent'",
        )
        .get(traceId) as { count: number };
      if (traceCount.count >= LIMITS.maxAgentMessagesPerTrace + this.turnAllowance(sender.roomId)) {
        throw new HiveError("TRACE_LIMIT", serverText("error.message.traceLimit"));
      }
      const since = new Date(Date.now() - 60_000).toISOString();
      const recentCount = this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM messages WHERE sender_id = ? AND sender_type = 'agent' AND created_at >= ?",
        )
        .get(sender.id, since) as { count: number };
      if (recentCount.count >= LIMITS.maxAgentRepliesPerMinute) {
        throw new HiveError("RATE_LIMIT", serverText("error.message.rateLimit"));
      }
    }

    const content = stripUnsafeCharacters(input.content).trim();
    const attachments = input.attachments?.length ? input.attachments : undefined;
    if (!content && !attachments) {
      throw new HiveError("EMPTY_MESSAGE", serverText("error.message.empty"));
    }
    const id = randomUUID();
    // 话题分隔只是界面上的分界线，不唤醒任何人
    const mentions = input.kind === "topic" ? [] : parseMentions(content);
    const createdAt = new Date().toISOString();
    const insert = () =>
      this.db
        .prepare(
          `INSERT INTO messages(
          id, room_id, sender_id, sender_name, sender_type, content, mentions,
          reply_to_message_id, trace_id, parent_message_id, hop_count, client_message_id, created_at,
          kind, meta
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          sender.roomId,
          sender.id,
          sender.username,
          sender.type,
          content,
          JSON.stringify(mentions),
          input.replyToMessageId ?? null,
          traceId,
          parent?.id ?? null,
          hopCount,
          input.clientMessageId,
          createdAt,
          input.kind ?? null,
          input.question || input.answer || input.approval || input.via || attachments || input.text
            ? JSON.stringify({
                ...(input.text ? { text: input.text } : {}),
                ...(input.question ? { question: input.question } : {}),
                ...(input.approval ? { approval: input.approval } : {}),
                ...(input.answer ? { answer: input.answer } : {}),
                ...(input.via ? { via: input.via } : {}),
                ...(attachments ? { attachments } : {}),
              })
            : null,
        );
    const participant = this.db.transaction(() => {
      insert();
      input.onInsert?.(id);
      if (
        input.text ||
        input.kind === "receipt" ||
        input.kind === "schedule" ||
        input.kind === "topic"
      )
        return undefined;
      this.db
        .prepare("UPDATE participants SET last_seen_at = ? WHERE id = ?")
        .run(createdAt, sender.id);
      return this.getParticipant(sender.id);
    })();
    return {
      message: this.getMessage(id)!,
      created: true,
      ...(participant ? { participant } : {}),
    };
  }

  findMessageByClientId(senderId: string, clientMessageId: string): ChatMessage | undefined {
    const row = this.db
      .prepare("SELECT * FROM messages WHERE sender_id = ? AND client_message_id = ?")
      .get(senderId, clientMessageId) as MessageRow | undefined;
    return row ? mapMessage(row) : undefined;
  }

  findParticipant(roomId: string, username: string): Participant | undefined {
    const row = this.db
      .prepare("SELECT * FROM participants WHERE room_id = ? AND username_key = ?")
      .get(roomId, username.toLocaleLowerCase()) as ParticipantRow | undefined;
    return row ? mapParticipant(row) : undefined;
  }

  private lastHumanSeq(roomId: string): number {
    const row = this.db
      .prepare(
        // 定时任务的触发消息以发起人名义发出，但那时人并不在场：不算人发言，不重置 Agent 连续轮数
        "SELECT COALESCE(MAX(seq), 0) AS seq FROM messages WHERE room_id = ? AND sender_type = 'human' AND (kind IS NULL OR kind != 'schedule')",
      )
      .get(roomId) as { seq: number };
    return row.seq;
  }

  /**
   * 自最近一条人类消息以来的 Agent 发言轮数与可用上限。
   * 人一发言计数就归零，授予的额外轮数也随之失效。
   */
  agentTurnBudget(roomId: string): { used: number; limit: number } {
    const lastHumanSeq = this.lastHumanSeq(roomId);
    const used = (
      this.db
        .prepare(
          // 进度消息只是给人看的，不唤醒任何 Agent；子任务回执由服务端代发，是已放行的委派的收尾。都不占连续轮数
          "SELECT COUNT(*) AS count FROM messages WHERE room_id = ? AND sender_type = 'agent' AND seq > ? AND (kind IS NULL OR kind NOT IN ('progress', 'receipt'))",
        )
        .get(roomId, lastHumanSeq) as { count: number }
    ).count;
    return { used, limit: LIMITS.maxConsecutiveAgentTurns + this.turnAllowance(roomId) };
  }

  /**
   * 人为当前这段 Agent 对话追加的轮数。连续轮数、转交深度、单链条数共用这一份额度，
   * 人点「继续」后三者一起放宽，不会出现轮数放开了却被深度卡住的情况；人一发言即失效。
   */
  turnAllowance(roomId: string): number {
    const room = this.db
      .prepare("SELECT agent_turn_allowance, allowance_after_seq FROM rooms WHERE id = ?")
      .get(roomId) as { agent_turn_allowance: number; allowance_after_seq: number } | undefined;
    return room && room.allowance_after_seq === this.lastHumanSeq(roomId)
      ? room.agent_turn_allowance
      : 0;
  }

  /** 为当前这段 Agent 连续对话追加轮数；返回追加后的总额外轮数 */
  extendAgentTurns(roomId: string, turns: number): number {
    const lastHumanSeq = this.lastHumanSeq(roomId);
    const room = this.db
      .prepare("SELECT agent_turn_allowance, allowance_after_seq FROM rooms WHERE id = ?")
      .get(roomId) as { agent_turn_allowance: number; allowance_after_seq: number } | undefined;
    if (!room) throw new HiveError("ROOM_NOT_FOUND", serverText("error.room.notFound"));
    const current = room.allowance_after_seq === lastHumanSeq ? room.agent_turn_allowance : 0;
    const next = current + turns;
    this.db
      .prepare("UPDATE rooms SET agent_turn_allowance = ?, allowance_after_seq = ? WHERE id = ?")
      .run(next, lastHumanSeq, roomId);
    return next;
  }

  /** 发起方 Agent 在 24 小时内唤醒目标 Agent 的次数（被拦下的不计） */
  pairTurnsToday(roomId: string, requesterId: string, agentId: string): number {
    const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM invocations
         WHERE room_id = ? AND requester_id = ? AND agent_id = ? AND created_at >= ?
           AND status != 'blocked'`,
      )
      .get(roomId, requesterId, agentId, since) as { count: number };
    return row.count;
  }

  /** 幂等：同一条消息对同一个 Agent 只会有一条调用记录 */
  createInvocation(input: {
    message: ChatMessage;
    agent: Participant;
    status: "queued" | "blocked";
    blockReason?: InvocationBlockReason;
    detail?: DetailInput;
    parentInvocationId?: string;
    continuation?: "pending";
  }): { invocation: Invocation; created: boolean } {
    const existing = this.getInvocationFor(input.message.id, input.agent.id);
    if (existing) return { invocation: existing, created: false };
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO invocations(
          id, room_id, message_id, agent_id, agent_name, requester_id, requester_name,
          requester_type, status, block_reason, detail, detail_text, parent_invocation_id,
          continuation, lane_key, attempts, created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        id,
        input.message.roomId,
        input.message.id,
        input.agent.id,
        input.agent.username,
        input.message.senderId,
        input.message.senderName,
        input.message.senderType,
        input.status,
        input.blockReason ?? null,
        ...detailColumns(input.detail ?? null),
        input.parentInvocationId ?? null,
        input.continuation ?? null,
        this.laneFor(id, input.message, input.agent.id, input.parentInvocationId),
        now,
        now,
      );
    return { invocation: this.getInvocation(id)!, created: true };
  }

  /**
   * 新调用落在 Agent 的哪一道会话（docs/research/task-scoped-sessions.md 1.1）：
   * 委派开一道新的（同一请求方在同一件上游的活里再派来的返修、补充，沿用之前那道）；
   * 回执、回复唤醒沿用委派链上这个 Agent 自己那件活的道；人回复了某道里 Agent 发的消息，进那一道；
   * 其余是主道 main。
   */
  private laneFor(
    id: string,
    message: ChatMessage,
    agentId: string,
    parentInvocationId: string | undefined,
  ): string {
    const parent = parentInvocationId ? this.getInvocation(parentInvocationId) : undefined;
    if (message.kind === "delegation") {
      if (!parent || !message.senderId) return id;
      const root = this.workRoot(parent);
      const rows = this.db
        .prepare(
          `SELECT i.* FROM invocations i JOIN messages m ON m.id = i.message_id
             WHERE i.agent_id = ? AND i.requester_id = ? AND m.kind = 'delegation'
               AND i.lane_key IS NOT NULL AND i.parent_invocation_id IS NOT NULL
             ORDER BY i.created_at DESC, i.rowid DESC LIMIT 20`,
        )
        .all(agentId, message.senderId) as InvocationRow[];
      for (const row of rows) {
        const previous = this.getInvocation(row.parent_invocation_id!);
        if (previous && this.workRoot(previous) === root) return row.lane_key!;
      }
      return id;
    }
    if (parent) {
      for (const invocation of [parent, ...this.invocationAncestors(parent.id)]) {
        if (invocation.agentId === agentId) return invocation.laneKey ?? "main";
      }
    }
    if (message.senderType === "human") {
      for (const target of [message.replyToMessageId, message.parentMessageId]) {
        const replied = target ? this.getMessage(target) : undefined;
        if (!replied || replied.senderId !== agentId || !replied.parentMessageId) continue;
        const lane = this.getInvocationFor(replied.parentMessageId, agentId)?.laneKey;
        if (lane) return lane;
      }
    }
    return "main";
  }

  /** 这次调用所在那件活的起点：沿委派链往上，走到这个 Agent 接的委派为止 */
  private workRoot(invocation: Invocation): string {
    const chain = this.workAncestors(invocation.id);
    return (chain.at(-1) ?? invocation).id;
  }

  getInvocation(id: string): Invocation | undefined {
    const row = this.db.prepare("SELECT * FROM invocations WHERE id = ?").get(id) as
      InvocationRow | undefined;
    return row ? mapInvocation(row) : undefined;
  }

  /** 正在执行的调用数（保持唤醒用；等人回答、排队未开始的不算） */
  countActiveInvocations(): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM invocations WHERE status IN ('running', 'cancelling')",
      )
      .get() as { count: number };
    return row.count;
  }

  /** 一条消息触发的所有调用（按创建顺序） */
  invocationsForMessage(messageId: string): Invocation[] {
    const rows = this.db
      .prepare("SELECT * FROM invocations WHERE message_id = ? ORDER BY created_at, rowid")
      .all(messageId) as InvocationRow[];
    return rows.map(mapInvocation);
  }

  getInvocationFor(messageId: string, agentId: string): Invocation | undefined {
    const row = this.db
      .prepare("SELECT * FROM invocations WHERE message_id = ? AND agent_id = ?")
      .get(messageId, agentId) as InvocationRow | undefined;
    return row ? mapInvocation(row) : undefined;
  }

  /**
   * 原子地把回执状态从 pending 推进到 next；返回 false 表示已被别处处理（例如 hive_wait 已取走结果），
   * 用来保证同一个子任务的结果只回执一次。
   */
  claimContinuation(id: string, next: Exclude<InvocationContinuation, "pending">): boolean {
    return (
      this.db
        .prepare(
          "UPDATE invocations SET continuation = ?, updated_at = ? WHERE id = ? AND continuation = 'pending'",
        )
        .run(next, new Date().toISOString(), id).changes === 1
    );
  }

  /** 回执发送失败时撤回占用：暂时性错误放回 pending 等扫描重试，永久性错误标为 failed */
  releaseContinuation(id: string, next: "pending" | "failed"): void {
    this.db
      .prepare(
        "UPDATE invocations SET continuation = ?, updated_at = ? WHERE id = ? AND continuation = 'delivered'",
      )
      .run(next, new Date().toISOString(), id);
  }

  /**
   * 子任务提问后由人的回答续上：待回执连同委派方、上游一起交给回答触发的新调用，
   * 旧调用不再回执——否则委派方会先收到一句"在等人回答"的中间结果。
   */
  adoptContinuation(fromId: string, toId: string): boolean {
    return this.db.transaction(() => {
      const from = this.db.prepare("SELECT * FROM invocations WHERE id = ?").get(fromId) as
        InvocationRow | undefined;
      if (!from || from.continuation !== "pending") return false;
      const now = new Date().toISOString();
      this.db
        .prepare("UPDATE invocations SET continuation = NULL, updated_at = ? WHERE id = ?")
        .run(now, fromId);
      this.db
        .prepare(
          `UPDATE invocations SET continuation = 'pending', requester_id = ?, requester_name = ?,
             requester_type = ?, parent_invocation_id = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          from.requester_id,
          from.requester_name,
          from.requester_type,
          from.parent_invocation_id,
          now,
          toId,
        );
      return true;
    })();
  }

  /** 已结束但回执还没发出的子任务：服务重启或投递暂时失败后由扫描补发 */
  listPendingContinuations(): Invocation[] {
    const statuses = CONTINUATION_READY_STATUSES.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT * FROM invocations WHERE continuation = 'pending' AND status IN (${statuses})
         ORDER BY updated_at ASC`,
      )
      .all(...CONTINUATION_READY_STATUSES) as InvocationRow[];
    return rows.map(mapInvocation);
  }

  /** 发送者对这条请求的回复是否已经给请求方派过调用（同一请求只代为送达一次回复） */
  hasReplyDelivery(
    requesterId: string,
    senderId: string,
    requestMessageId: string,
    exceptMessageId: string,
  ): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM invocations i JOIN messages m ON m.id = i.message_id
          WHERE i.agent_id = ? AND m.sender_id = ? AND m.parent_message_id = ? AND m.id <> ?
          LIMIT 1`,
      )
      .get(requesterId, senderId, requestMessageId, exceptMessageId);
    return Boolean(row);
  }

  /** 沿 parentInvocationId 向上的委派链（不含自身），用来拒绝会形成相互等待的委派 */
  invocationAncestors(id: string): Invocation[] {
    const chain: Invocation[] = [];
    const seen = new Set<string>([id]);
    let current = this.getInvocation(id)?.parentInvocationId;
    while (current && !seen.has(current) && chain.length < 100) {
      seen.add(current);
      const invocation = this.getInvocation(current);
      if (!invocation) break;
      chain.push(invocation);
      current = invocation.parentInvocationId;
    }
    return chain;
  }

  /**
   * 委派链上和这一轮算「同一件活」的上游（不含自身）：子任务回执、回复唤醒的那一轮接着上游往下做。
   * 别的 Agent 用 hive_invoke 派给这个 Agent 的是一件新活，链到这里为止：这一轮本身是委派就没有上游，
   * 往上走到这个 Agent 自己接的委派就停在那一轮，更早的是它之前的另一件活
   */
  workAncestors(id: string): Invocation[] {
    const self = this.getInvocation(id);
    const delegated = (invocation: Invocation) =>
      invocation.agentId === self?.agentId &&
      this.getMessage(invocation.messageId)?.kind === "delegation";
    if (!self || delegated(self)) return [];
    const chain: Invocation[] = [];
    for (const invocation of this.invocationAncestors(id)) {
      chain.push(invocation);
      if (delegated(invocation)) break;
    }
    return chain;
  }

  /** 已请求停止、尚未收到确认的调用：Agent 重新连接时需要再次下发停止请求 */
  listCancellingInvocations(agentId: string): Invocation[] {
    const rows = this.db
      .prepare("SELECT * FROM invocations WHERE agent_id = ? AND status = 'cancelling'")
      .all(agentId) as InvocationRow[];
    return rows.map(mapInvocation);
  }

  /** Agent 手上没结束的调用（排队、执行中、停止中、提问后本轮未结束）：解释排队位置用 */
  listOpenInvocationsForAgent(agentId: string): Invocation[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM invocations WHERE agent_id = ?
           AND (status IN ('queued', 'running', 'cancelling')
             OR (status = 'waiting_human' AND finished_at IS NULL))`,
      )
      .all(agentId) as InvocationRow[];
    return rows.map(mapInvocation);
  }

  /**
   * 手上有没结束的调用（排队、执行中、停止中、提问后本轮未结束）的 Agent 名字（小写），跨所有房间。
   * 同一个本机 Agent 在每个房间是不同的成员，所以按名字而不是成员 ID 汇总。
   */
  busyAgentNames(): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT agent_name AS name FROM invocations
           WHERE status IN ('queued', 'running', 'cancelling')
              OR (status = 'waiting_human' AND finished_at IS NULL)`,
      )
      .all() as Array<{ name: string }>;
    return new Set(rows.map((row) => row.name.toLocaleLowerCase()));
  }

  /** Agent 当前正在执行（含停止中、提问后本轮尚未结束）的调用 */
  listExecutingInvocations(agentId: string): Invocation[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM invocations WHERE agent_id = ?
           AND (status IN ('running', 'cancelling')
             OR (status = 'waiting_human' AND finished_at IS NULL))`,
      )
      .all(agentId) as InvocationRow[];
    return rows.map(mapInvocation);
  }

  /** 这个名字的 Agent（跨房间，不分大小写）当前正在执行（含停止中、提问后本轮尚未结束）的调用 */
  listExecutingInvocationsNamed(agentName: string): Invocation[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM invocations WHERE lower(agent_name) = lower(?)
           AND (status IN ('running', 'cancelling')
             OR (status = 'waiting_human' AND finished_at IS NULL))`,
      )
      .all(agentName) as InvocationRow[];
    return rows.map(mapInvocation);
  }

  updateInvocation(id: string, patch: InvocationPatch): Invocation {
    const columns: Record<Exclude<keyof InvocationPatch, "failure">, string> = {
      status: "status",
      blockReason: "block_reason",
      detail: "detail",
      progress: "progress",
      runtime: "runtime",
      replyMessageId: "reply_message_id",
      attempts: "attempts",
      receivedAt: "received_at",
      startedAt: "started_at",
      finishedAt: "finished_at",
    };
    const assignments: string[] = ["updated_at = ?"];
    const values: unknown[] = [new Date().toISOString()];
    // 状态一变（重试、迟到的结果等），之前的「已忽略 / 已被取代」就不再成立
    if (patch.status !== undefined) {
      assignments.push(
        "resolution_kind = NULL",
        "resolved_at = NULL",
        "resolved_by = NULL",
        "resolution_note = NULL",
      );
    }
    for (const [key, column] of Object.entries(columns) as Array<
      [Exclude<keyof InvocationPatch, "failure">, string]
    >) {
      if (patch[key] === undefined) continue;
      if (key === "detail" || key === "progress") {
        assignments.push(`${column} = ?`, `${column}_text = ?`);
        values.push(...detailColumns(patch[key] ?? null, key === "progress" ? 200 : 500));
        if (key === "detail") {
          assignments.push("failure = ?");
          values.push(patch.failure ?? null);
        }
        continue;
      }
      assignments.push(`${column} = ?`);
      values.push(key === "runtime" && patch.runtime ? JSON.stringify(patch.runtime) : patch[key]);
    }
    this.db
      .prepare(`UPDATE invocations SET ${assignments.join(", ")} WHERE id = ?`)
      .run(...values, id);
    const invocation = this.getInvocation(id);
    if (!invocation)
      throw new HiveError("INVOCATION_NOT_FOUND", serverText("error.invocation.notFound"));
    return invocation;
  }

  /**
   * 记下一个回合的真实用量：写入账本并挂到调用上（调用上只保留最近一轮）。
   * 用量与调用状态无关——迟到、已停止的回合同样花了钱，一律记账。
   */
  /** 这个成员最近一轮实际用的模型（用量账本里最新一条带模型的） */
  latestUsageModel(agentId: string): AgentLastModel | undefined {
    const row = this.db
      .prepare(
        `SELECT model, usage, created_at FROM agent_usage
         WHERE agent_id = ? AND model IS NOT NULL AND model != ''
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(agentId) as { model: string; usage: string; created_at: string } | undefined;
    if (!row) return undefined;
    let usage: Partial<AgentUsage> = {};
    try {
      usage = JSON.parse(row.usage) as Partial<AgentUsage>;
    } catch {
      // 坏的 JSON 只是拿不到思考强度和时间
    }
    const at =
      typeof usage.lastRequestAt === "string" && Number.isFinite(Date.parse(usage.lastRequestAt))
        ? usage.lastRequestAt
        : row.created_at;
    return {
      id: row.model.slice(0, 120),
      ...(typeof usage.effort === "string" && usage.effort
        ? { effort: usage.effort.slice(0, 32) }
        : {}),
      at,
    };
  }

  recordUsage(
    invocation: Invocation,
    usage: AgentUsage,
    now = new Date().toISOString(),
  ): Invocation {
    const json = JSON.stringify(usage);
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO agent_usage(turn_key, invocation_id, room_id, message_id, agent_id, agent_name, model, usage, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(turn_key) DO UPDATE SET model = excluded.model, usage = excluded.usage`,
        )
        .run(
          // 同一回合重复上报（断线重发）只记一次；重试是新的回合，第一次请求时间不同
          `${invocation.id}:${usage.firstRequestAt ?? ""}`,
          invocation.id,
          invocation.roomId,
          invocation.messageId,
          invocation.agentId,
          invocation.agentName,
          usage.model ?? null,
          json,
          now,
        );
      this.db
        .prepare("UPDATE invocations SET usage = ?, updated_at = ? WHERE id = ?")
        .run(json, now, invocation.id);
    })();
    return this.getInvocation(invocation.id) ?? invocation;
  }

  /** 房间在 since 之后的用量汇总：合计、按 Agent、按模型、按天，以及最近的明细 */
  usageSummary(
    roomId: string,
    since: string,
    alertTokens: number,
    recentLimit = 100,
  ): UsageSummary {
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_usage WHERE room_id = ? AND created_at >= ?
         ORDER BY created_at DESC LIMIT 50000`,
      )
      .all(roomId, since) as Array<{
      invocation_id: string;
      room_id: string;
      message_id: string;
      agent_id: string;
      agent_name: string;
      model: string | null;
      usage: string;
      created_at: string;
    }>;
    const totals = emptyTotals();
    const agents = new Map<string, UsageSummary["agents"][number]>();
    const cells = new Map<string, UsageSummary["cells"][number]>();
    const recent: UsageRecord[] = [];
    for (const row of rows) {
      const usage = parseUsage(row.usage);
      if (!usage) continue;
      const record: UsageRecord = {
        invocationId: row.invocation_id,
        roomId: row.room_id,
        messageId: row.message_id,
        agentId: row.agent_id,
        agentName: row.agent_name,
        createdAt: row.created_at,
        usage,
      };
      if (recent.length < recentLimit) recent.push(record);
      addUsage(totals, usage, alertTokens);
      let agent = agents.get(row.agent_id);
      if (!agent) {
        // 行按时间倒序，第一次遇到的就是这个 Agent 最近的一轮
        agent = {
          ...emptyTotals(),
          agentId: row.agent_id,
          agentName: row.agent_name,
          models: [],
          latest: record,
        };
        agents.set(row.agent_id, agent);
      }
      addUsage(agent, usage, alertTokens);
      const model = usage.model ?? "unknown";
      if (!agent.models.includes(model)) agent.models.push(model);
      const day = localDay(row.created_at);
      const key = JSON.stringify([row.agent_id, day, model]);
      let cell = cells.get(key);
      if (!cell) cells.set(key, (cell = { ...emptyTotals(), agentId: row.agent_id, day, model }));
      addUsage(cell, usage, alertTokens);
    }
    return {
      roomId,
      since,
      cacheWriteAlertTokens: alertTokens,
      totals,
      agents: [...agents.values()],
      cells: [...cells.values()].sort((a, b) => b.day.localeCompare(a.day)),
      recent,
    };
  }

  /** 房间最近的调用记录，外加所有尚未结束的调用（避免长任务被窗口挤掉） */
  listInvocations(roomId: string, limit = 200): Invocation[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM invocations WHERE id IN (
           SELECT id FROM invocations WHERE room_id = ? ORDER BY created_at DESC LIMIT ?
         ) OR (room_id = ? AND status IN ('queued', 'running', 'cancelling', 'timed_out', 'waiting_human'))
         ORDER BY created_at ASC`,
      )
      .all(roomId, limit, roomId) as InvocationRow[];
    return rows.map(mapInvocation);
  }

  listBlockedInvocations(roomId: string, afterSeq: number): Invocation[] {
    const rows = this.db
      .prepare(
        `SELECT i.* FROM invocations i JOIN messages m ON m.id = i.message_id
         WHERE i.room_id = ? AND i.status = 'blocked'
           AND i.block_reason IN ('hop_limit', 'consecutive_limit', 'pair_limit') AND m.seq > ?
         ORDER BY m.seq ASC`,
      )
      .all(roomId, afterSeq) as InvocationRow[];
    return rows.map(mapInvocation);
  }

  lastHumanMessageSeq(roomId: string): number {
    return this.lastHumanSeq(roomId);
  }

  /** 人点「忽略」：只收起失败、被拦、结果未知且尚未收起的调用，返回实际改动的 */
  dismissInvocations(roomId: string | null, ids: string[], by: string): Invocation[] {
    const now = new Date().toISOString();
    const statement = this.db.prepare(
      `UPDATE invocations SET resolution_kind = 'dismissed', resolved_at = ?, resolved_by = ?,
         resolution_note = NULL
       WHERE id = ? AND (? IS NULL OR room_id = ?) AND resolved_at IS NULL
         AND status IN ('failed', 'blocked', 'timed_out')`,
    );
    const changed: Invocation[] = [];
    this.db.transaction(() => {
      for (const id of new Set(ids)) {
        if (statement.run(now, by, id, roomId, roomId).changes === 1) {
          changed.push(this.getInvocation(id)!);
        }
      }
    })();
    return changed;
  }

  supersedeCompletedInvocation(id: string, note: ServerText): Invocation {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE invocations SET resolution_kind = 'superseded', resolved_at = ?, resolution_note = ?, resolution_note_text = ? WHERE id = ? AND status = 'completed' AND resolved_at IS NULL",
      )
      .run(now, ...detailColumns(note, 200), id);
    return this.getInvocation(id)!;
  }

  /**
   * 自动收起已经过时的异常：之后同一 Agent 在同一房间又正常完成了任务，或房间开启了新话题。
   * 等房主批准的访客请求（guest_approval）是待决事项，不自动收起。
   */
  supersedeStaleInvocations(roomId?: string): Invocation[] {
    const rows = this.db
      .prepare(
        `SELECT c.*,
           EXISTS (SELECT 1 FROM invocations d WHERE d.room_id = c.room_id AND d.agent_id = c.agent_id
             AND d.status = 'completed' AND d.created_at > c.created_at) AS later_completed
         FROM invocations c
         WHERE c.resolved_at IS NULL
           AND (? IS NULL OR c.room_id = ?)
           AND (c.status IN ('failed', 'timed_out')
             OR (c.status = 'blocked' AND COALESCE(c.block_reason, '') <> 'guest_approval'))
           AND (
             EXISTS (SELECT 1 FROM invocations d WHERE d.room_id = c.room_id AND d.agent_id = c.agent_id
               AND d.status = 'completed' AND d.created_at > c.created_at)
             OR EXISTS (SELECT 1 FROM messages m WHERE m.room_id = c.room_id AND m.kind = 'topic'
               AND m.created_at > c.created_at)
           )`,
      )
      .all(roomId ?? null, roomId ?? null) as Array<InvocationRow & { later_completed: number }>;
    if (rows.length === 0) return [];
    const now = new Date().toISOString();
    const statement = this.db.prepare(
      `UPDATE invocations SET resolution_kind = 'superseded', resolved_at = ?, resolution_note = ?,
         resolution_note_text = ? WHERE id = ? AND resolved_at IS NULL`,
    );
    this.db.transaction(() => {
      for (const row of rows) {
        statement.run(
          now,
          ...detailColumns(
            row.later_completed
              ? serverText("invocation.supersededCompleted", { agent: row.agent_name })
              : serverText("invocation.supersededTopic"),
            200,
          ),
          row.id,
        );
      }
    })();
    return rows.map((row) => this.getInvocation(row.id)!);
  }

  /** 停止请求发出后迟迟没有确认的调用（Agent 已离开、进程丢失等） */
  listStaleCancelling(now = Date.now()): Invocation[] {
    const stale = new Date(now - LIMITS.invocationStaleMs).toISOString();
    const rows = this.db
      .prepare("SELECT * FROM invocations WHERE status = 'cancelling' AND updated_at < ?")
      .all(stale) as InvocationRow[];
    return rows.map(mapInvocation);
  }

  /** queued 且未确认送达、或 running 但长时间没有回报的调用 */
  listStaleInvocations(now = Date.now()): Invocation[] {
    const staleRunning = new Date(now - LIMITS.invocationStaleMs).toISOString();
    const unacknowledged = new Date(now - LIMITS.invocationUnacknowledgedMs).toISOString();
    const rows = this.db
      .prepare(
        `SELECT * FROM invocations
         WHERE (status = 'running' AND updated_at < ?)
            OR (status = 'queued' AND received_at IS NULL AND updated_at < ?)`,
      )
      .all(staleRunning, unacknowledged) as InvocationRow[];
    return rows.map(mapInvocation);
  }

  /** 幂等：同一个 Agent 用同一个 clientId 重试创建，返回已有的那条 */
  createSchedule(input: {
    roomId: string;
    agent: Participant;
    requester: Participant;
    origin: ChatMessage;
    clientId: string;
    task: string;
    runAt: string;
    timeZone: string;
    recurrence?: { everyMinutes: number; until: string; seriesId: string; occurrence: number };
  }): { schedule: Schedule; created: boolean } {
    const existing = this.db
      .prepare("SELECT * FROM schedules WHERE agent_id = ? AND client_id = ?")
      .get(input.agent.id, input.clientId) as ScheduleRow | undefined;
    if (existing) return { schedule: mapSchedule(existing), created: false };
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO schedules(
          id, room_id, agent_id, agent_name, requester_id, requester_name, origin_message_id,
          origin_seq, client_id, task, run_at, time_zone, every_minutes, until_at, series_id,
          occurrence, status, created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)`,
      )
      .run(
        id,
        input.roomId,
        input.agent.id,
        input.agent.username,
        input.requester.id,
        input.requester.username,
        input.origin.id,
        input.origin.seq,
        input.clientId,
        input.task,
        input.runAt,
        input.timeZone,
        input.recurrence?.everyMinutes ?? null,
        input.recurrence?.until ?? null,
        input.recurrence?.seriesId ?? null,
        input.recurrence?.occurrence ?? null,
        now,
        now,
      );
    return { schedule: this.getSchedule(id)!, created: true };
  }

  /** 同一个周期任务的每一次 */
  listSeriesSchedules(seriesId: string): Schedule[] {
    const rows = this.db
      .prepare("SELECT * FROM schedules WHERE series_id = ? ORDER BY occurrence ASC")
      .all(seriesId) as ScheduleRow[];
    return rows.map(mapSchedule);
  }

  createScheduleLookup(agentId: string, clientId: string): Schedule | undefined {
    const row = this.db
      .prepare("SELECT * FROM schedules WHERE agent_id = ? AND client_id = ?")
      .get(agentId, clientId) as ScheduleRow | undefined;
    return row ? mapSchedule(row) : undefined;
  }

  isScheduleUnreported(id: string): boolean {
    return Boolean(
      this.db.prepare("SELECT 1 FROM schedules WHERE id = ? AND reported_at IS NULL").get(id),
    );
  }

  getSchedule(id: string): Schedule | undefined {
    const row = this.db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as
      ScheduleRow | undefined;
    return row ? mapSchedule(row) : undefined;
  }

  /** 房间的定时任务：待执行的全部在前（按执行时间），之后是最近结束的 */
  listSchedules(roomId: string, limit = 50): Schedule[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM schedules WHERE room_id = ?
         ORDER BY CASE WHEN status IN ('scheduled', 'firing') THEN 0 ELSE 1 END,
           CASE WHEN status IN ('scheduled', 'firing') THEN run_at END ASC,
           updated_at DESC
         LIMIT ?`,
      )
      .all(roomId, limit) as ScheduleRow[];
    return rows.map(mapSchedule);
  }

  countActiveSchedules(roomId: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM schedules WHERE room_id = ? AND status IN ('scheduled', 'firing')",
      )
      .get(roomId) as { count: number };
    return row.count;
  }

  /** 到点（run_at 不晚于 now）还没发出的定时任务 */
  listDueSchedules(now: number): Schedule[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM schedules WHERE status = 'scheduled' AND run_at <= ? ORDER BY run_at ASC",
      )
      .all(new Date(now).toISOString()) as ScheduleRow[];
    return rows.map(mapSchedule);
  }

  /** 最近一个待执行定时任务的时间（毫秒）；没有返回 undefined */
  nextScheduleRunAt(): number | undefined {
    const row = this.db
      .prepare("SELECT MIN(run_at) AS runAt FROM schedules WHERE status = 'scheduled'")
      .get() as { runAt: string | null };
    return row.runAt ? Date.parse(row.runAt) : undefined;
  }

  /** 发出途中被中断（服务崩溃、重启）的定时任务，由扫描按幂等键补完 */
  listFiringSchedules(): Schedule[] {
    const rows = this.db
      .prepare("SELECT * FROM schedules WHERE status = 'firing' ORDER BY run_at ASC")
      .all() as ScheduleRow[];
    return rows.map(mapSchedule);
  }

  /** 已发出、错过或无法发出、还没确认是否需要补发说明的定时任务 */
  listUnreportedSchedules(): Schedule[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM schedules WHERE reported_at IS NULL
           AND status IN ('fired', 'missed', 'failed') ORDER BY updated_at ASC`,
      )
      .all() as ScheduleRow[];
    return rows.map(mapSchedule);
  }

  scheduleForInvocation(invocationId: string): Schedule | undefined {
    const row = this.db
      .prepare("SELECT * FROM schedules WHERE invocation_id = ?")
      .get(invocationId) as ScheduleRow | undefined;
    return row ? mapSchedule(row) : undefined;
  }

  /**
   * 原子地把状态从 from 之一推进到 next，同时写入 patch；返回 undefined 表示已被别处处理
   * （同一个定时任务只会被认领发出一次，取消与到点同时发生时只有一方生效）。
   */
  transitionSchedule(
    id: string,
    from: readonly ScheduleStatus[],
    next: ScheduleStatus,
    patch: SchedulePatch = {},
  ): Schedule | undefined {
    const { sets, values } = this.schedulePatchSql({ ...patch, status: next });
    const placeholders = from.map(() => "?").join(", ");
    const changed = this.db
      .prepare(`UPDATE schedules SET ${sets} WHERE id = ? AND status IN (${placeholders})`)
      .run(...values, id, ...from).changes;
    return changed === 1 ? this.getSchedule(id) : undefined;
  }

  updateSchedule(id: string, patch: SchedulePatch): Schedule {
    const { sets, values } = this.schedulePatchSql(patch);
    this.db.prepare(`UPDATE schedules SET ${sets} WHERE id = ?`).run(...values, id);
    const schedule = this.getSchedule(id);
    if (!schedule) throw new HiveError("SCHEDULE_NOT_FOUND", serverText("error.schedule.missing"));
    return schedule;
  }

  /** 原子地标记已补发说明；返回 false 表示已经标记过 */
  markScheduleReported(id: string): boolean {
    const now = new Date().toISOString();
    return (
      this.db
        .prepare(
          "UPDATE schedules SET reported_at = ?, updated_at = ? WHERE id = ? AND reported_at IS NULL",
        )
        .run(now, now, id).changes === 1
    );
  }

  private schedulePatchSql(patch: SchedulePatch): { sets: string; values: unknown[] } {
    const columns: Record<keyof SchedulePatch, string> = {
      status: "status",
      detail: "detail",
      triggerMessageId: "trigger_message_id",
      invocationId: "invocation_id",
      firedAt: "fired_at",
      reportedAt: "reported_at",
      cancelledBy: "cancelled_by",
    };
    const sets = ["updated_at = ?"];
    const values: unknown[] = [new Date().toISOString()];
    for (const [key, column] of Object.entries(columns) as Array<[keyof SchedulePatch, string]>) {
      if (patch[key] === undefined) continue;
      if (key === "detail") {
        sets.push("detail = ?", "detail_text = ?");
        values.push(...detailColumns(patch.detail ?? null));
        continue;
      }
      sets.push(`${column} = ?`);
      values.push(patch[key]);
    }
    return { sets: sets.join(", "), values };
  }

  listWhiteboard(
    roomId: string,
    view: "current" | "archived" | "all" = "current",
  ): WhiteboardEntry[] {
    const filter =
      view === "all" ? "" : ` AND archived_at IS ${view === "archived" ? "NOT " : ""}NULL`;
    const rows = this.db
      .prepare(
        `SELECT * FROM whiteboard_entries WHERE room_id = ?${filter} ORDER BY updated_at DESC, rowid DESC`,
      )
      .all(roomId) as WhiteboardRow[];
    return rows.map((row) => this.mapWhiteboardEntry(row));
  }

  /**
   * 只有还挂着已登记 worktree（目录或分支占用）的条目不能归档或删除：归档会让占用从白板上消失。
   * 单纯的进行中/阻塞不算：Agent 崩了、换了 key 或忘了收尾，留下的旧条目房主得能清掉。
   */
  private whiteboardProtected(row: WhiteboardRow): boolean {
    if (!row.key.startsWith("worktree:") && !row.claim_repo) return false;
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'managed_worktrees'").get())
      return false;
    return Boolean(
      this.db
        .prepare("SELECT 1 FROM managed_worktrees WHERE id = ? OR (repo = ? AND branch = ?)")
        .get(row.key.slice("worktree:".length), row.claim_repo, row.claim_branch),
    );
  }

  private mapWhiteboardEntry(row: WhiteboardRow): WhiteboardEntry {
    return {
      ...mapWhiteboard(row),
      ...(this.whiteboardProtected(row) ? { archiveProtected: true } : {}),
    };
  }

  changeWhiteboardArchive(
    roomId: string,
    entries: Array<{ id: string; updatedAt: string }>,
    archive: boolean,
  ): WhiteboardEntry[] {
    return this.db.transaction(() => {
      if (!entries.length || new Set(entries.map((entry) => entry.id)).size !== entries.length)
        throw new HiveError("WHITEBOARD_CONFLICT", serverText("error.whiteboard.conflict"));
      const rows = entries.map((entry) => {
        const row = this.db
          .prepare("SELECT * FROM whiteboard_entries WHERE room_id = ? AND id = ?")
          .get(roomId, entry.id) as WhiteboardRow | undefined;
        if (!row)
          throw new HiveError("WHITEBOARD_NOT_FOUND", serverText("error.whiteboard.notFound"));
        if (row.updated_at !== entry.updatedAt || Boolean(row.archived_at) === archive)
          throw new HiveError("WHITEBOARD_CONFLICT", serverText("error.whiteboard.conflict"));
        if (archive && this.whiteboardProtected(row))
          throw new HiveError("WHITEBOARD_PROTECTED", serverText("error.whiteboard.protected"));
        if (!archive && row.slot === "in_progress" && row.claim_repo && row.claim_branch)
          this.assertBranchClaimAvailable(row.claim_repo, row.claim_branch, row.id);
        return row;
      });
      return rows.map((row) => {
        const updatedAt = new Date(
          Math.max(Date.now(), Date.parse(row.updated_at) + 1),
        ).toISOString();
        const archivedAt = archive ? updatedAt : null;
        this.db
          .prepare("UPDATE whiteboard_entries SET archived_at = ?, updated_at = ? WHERE id = ?")
          .run(archivedAt, updatedAt, row.id);
        return this.mapWhiteboardEntry({ ...row, archived_at: archivedAt, updated_at: updatedAt });
      });
    })();
  }

  /**
   * 按 key 写入白板：同一事项从"进行中"移到"已就绪"只需复用 key。
   * 60 秒内内容完全相同的重复发布视为节流，不产生更新；不按数量自动删除。
   */
  assertBranchClaimAvailable(repo: string, branch: string, entryId?: string): void {
    const claimed = this.db
      .prepare(
        `SELECT * FROM whiteboard_entries
      WHERE slot = 'in_progress' AND claim_repo = ? AND claim_branch = ?
      AND (? IS NULL OR id != ?) LIMIT 1`,
      )
      .get(repo, branch, entryId ?? null, entryId ?? null) as WhiteboardRow | undefined;
    if (claimed) {
      throw new HiveError(
        "WORKTREE_CLAIM_CONFLICT",
        serverText("error.worktree.claim", {
          branch,
          agent: claimed.author_name,
          key: claimed.key,
        }),
      );
    }
  }

  upsertWhiteboardEntry(
    author: Participant,
    input: WhiteboardInput,
  ): { entry: WhiteboardEntry; changed: boolean; evicted: string[] } {
    const now = new Date();
    const unblocks = [...new Set(input.unblocks ?? [])];
    const existingRow = this.db
      .prepare("SELECT * FROM whiteboard_entries WHERE room_id = ? AND key = ?")
      .get(author.roomId, input.key) as WhiteboardRow | undefined;
    if (
      existingRow?.slot === "in_progress" &&
      existingRow.claim_repo &&
      existingRow.author_id !== author.id
    ) {
      throw new HiveError(
        "WORKTREE_CLAIM_CONFLICT",
        serverText("error.worktree.claim", {
          branch: existingRow.claim_branch ?? "",
          agent: existingRow.author_name,
          key: existingRow.key,
        }),
      );
    }
    const claim =
      input.claim ??
      (existingRow?.author_id === author.id && existingRow.claim_repo && existingRow.claim_branch
        ? { repo: existingRow.claim_repo, branch: existingRow.claim_branch }
        : undefined);
    if (claim && input.slot === "in_progress") {
      this.assertBranchClaimAvailable(claim.repo, claim.branch, existingRow?.id);
    }
    if (existingRow) {
      const existing = this.mapWhiteboardEntry(existingRow);
      const unchanged =
        !existing.archivedAt &&
        existing.slot === input.slot &&
        existing.summary === input.summary &&
        (existing.repo ?? undefined) === input.repo &&
        (existing.branch ?? undefined) === input.branch &&
        JSON.stringify(existing.claim) === JSON.stringify(claim) &&
        (existing.commit ?? undefined) === input.commit &&
        JSON.stringify(existing.unblocks) === JSON.stringify(unblocks);
      if (unchanged && now.getTime() - Date.parse(existing.updatedAt) < 60_000) {
        return { entry: existing, changed: false, evicted: [] };
      }
      this.db
        .prepare(
          `UPDATE whiteboard_entries SET slot = ?, summary = ?, repo = ?, branch = ?, claim_repo = ?, claim_branch = ?, commit_ref = ?,
             unblocks = ?, author_id = ?, author_name = ?, updated_at = ?, archived_at = NULL, merged_at = NULL,
             message_id = COALESCE(?, message_id), message_seq = COALESCE(?, message_seq) WHERE id = ?`,
        )
        .run(
          input.slot,
          input.summary,
          input.repo ?? null,
          input.branch ?? null,
          claim?.repo ?? null,
          claim?.branch ?? null,
          input.commit ?? null,
          JSON.stringify(unblocks),
          author.id,
          author.username,
          new Date(Math.max(now.getTime(), Date.parse(existing.updatedAt) + 1)).toISOString(),
          input.source?.id ?? null,
          input.source?.seq ?? null,
          existing.id,
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO whiteboard_entries(
            id, room_id, key, slot, summary, repo, branch, claim_repo, claim_branch, commit_ref, unblocks,
            author_id, author_name, created_at, updated_at, message_id, message_seq
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          author.roomId,
          input.key,
          input.slot,
          input.summary,
          input.repo ?? null,
          input.branch ?? null,
          claim?.repo ?? null,
          claim?.branch ?? null,
          input.commit ?? null,
          JSON.stringify(unblocks),
          author.id,
          author.username,
          now.toISOString(),
          now.toISOString(),
          input.source?.id ?? null,
          input.source?.seq ?? null,
        );
    }
    const row = this.db
      .prepare("SELECT * FROM whiteboard_entries WHERE room_id = ? AND key = ?")
      .get(author.roomId, input.key) as WhiteboardRow;
    return { entry: this.mapWhiteboardEntry(row), changed: true, evicted: [] };
  }

  removeWhiteboardEntry(roomId: string, entryId: string, updatedAt?: string): boolean {
    const row = this.db
      .prepare("SELECT * FROM whiteboard_entries WHERE room_id = ? AND id = ?")
      .get(roomId, entryId) as WhiteboardRow | undefined;
    if (row && updatedAt && (row.updated_at !== updatedAt || !row.archived_at))
      throw new HiveError("WHITEBOARD_CONFLICT", serverText("error.whiteboard.conflict"));
    if (row && this.whiteboardProtected(row))
      throw new HiveError("WHITEBOARD_PROTECTED", serverText("error.whiteboard.protected"));
    return (
      this.db
        .prepare("DELETE FROM whiteboard_entries WHERE room_id = ? AND id = ?")
        .run(roomId, entryId).changes > 0
    );
  }

  /**
   * 分支已合入目标分支：这条分支上还没收尾的条目（进行中、已就绪）转成里程碑，「进展」里归到最近完成。
   * 同一个合入提交只转一次：Agent 之后又把它登记回进行中（比如在同一分支上接着做），不再反复改回去。
   * 进行中的条目只在目录干净时转（mergedClean），免得把合入后还在改的活当成做完了。
   */
  completeMergedWhiteboard(
    roomId: string,
    branch: string,
    headCommit: string,
    options: { includeInProgress: boolean },
  ): WhiteboardEntry[] {
    return this.db.transaction(() => {
      const slots = options.includeInProgress ? ["ready", "in_progress"] : ["ready"];
      const rows = this.db
        .prepare(
          `SELECT * FROM whiteboard_entries
          WHERE room_id = ? AND archived_at IS NULL AND key NOT LIKE 'worktree:%'
          AND slot IN (${slots.map(() => "?").join(", ")})
          AND (branch = ? OR claim_branch = ?)
          AND (merged_commit IS NULL OR merged_commit != ?)`,
        )
        .all(roomId, ...slots, branch, branch, headCommit) as WhiteboardRow[];
      return rows.map((row) => {
        const updatedAt = new Date(
          Math.max(Date.now(), Date.parse(row.updated_at) + 1),
        ).toISOString();
        // 占用只对进行中有意义；转成里程碑后清掉，几天后才能自动归档
        this.db
          .prepare(
            `UPDATE whiteboard_entries SET slot = 'milestone', claim_repo = NULL, claim_branch = NULL,
            merged_at = ?, merged_commit = ?, updated_at = ? WHERE id = ?`,
          )
          .run(updatedAt, headCommit, updatedAt, row.id);
        return this.mapWhiteboardEntry({
          ...row,
          slot: "milestone",
          claim_repo: null,
          claim_branch: null,
          merged_at: updatedAt,
          merged_commit: headCommit,
          updated_at: updatedAt,
        });
      });
    })();
  }

  /** 超过 olderThan 没再更新的里程碑自动归档（仍占着任务目录的除外）；历史里照样能看到、能恢复 */
  archiveStaleMilestones(olderThan: string): WhiteboardEntry[] {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT * FROM whiteboard_entries
          WHERE slot = 'milestone' AND archived_at IS NULL AND key NOT LIKE 'worktree:%' AND updated_at < ?`,
        )
        .all(olderThan) as WhiteboardRow[];
      return rows
        .filter((row) => !this.whiteboardProtected(row))
        .map((row) => {
          const updatedAt = new Date(
            Math.max(Date.now(), Date.parse(row.updated_at) + 1),
          ).toISOString();
          this.db
            .prepare("UPDATE whiteboard_entries SET archived_at = ?, updated_at = ? WHERE id = ?")
            .run(updatedAt, updatedAt, row.id);
          return this.mapWhiteboardEntry({ ...row, archived_at: updatedAt, updated_at: updatedAt });
        });
    })();
  }

  /* ---------- 本机 Agent 配置（只存配置，进程状态由 LocalAgentSupervisor 维护） ---------- */

  listLocalAgents(): LocalAgentConfig[] {
    const rows = this.db
      .prepare("SELECT * FROM local_agents ORDER BY created_at ASC, rowid ASC")
      .all() as LocalAgentRow[];
    return rows.map(mapLocalAgent);
  }

  participantsNamed(name: string): Participant[] {
    return (
      this.db
        .prepare("SELECT * FROM participants WHERE username_key = ?")
        .all(name.toLocaleLowerCase()) as ParticipantRow[]
    ).map(mapParticipant);
  }

  listRemovedLocalAgents(): RemovedLocalAgent[] {
    const current = new Set(this.listLocalAgents().map((agent) => agent.name.toLocaleLowerCase()));
    const removed = new Map<string, RemovedLocalAgent>();
    const rows = this.db
      .prepare("SELECT name, provider, cwd FROM removed_local_agents")
      .all() as RemovedLocalAgent[];
    for (const agent of rows) removed.set(agent.name.toLocaleLowerCase(), agent);
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'managed_worktrees'").get()) {
      const legacy = this.db
        .prepare(
          "SELECT agent_name AS name, repo AS cwd FROM managed_worktrees ORDER BY rowid DESC",
        )
        .all() as Array<{ name: string; cwd: string }>;
      for (const record of legacy) {
        const key = record.name.toLocaleLowerCase();
        if (removed.has(key) || current.has(key)) continue;
        for (const member of this.participantsNamed(record.name)) {
          const provider = localAgentProviderSchema.safeParse(member.provider);
          if (member.type === "agent" && provider.success) {
            removed.set(key, { name: member.username, cwd: record.cwd, provider: provider.data });
            break;
          }
        }
      }
    }
    return [...removed.values()].filter((agent) => !current.has(agent.name.toLocaleLowerCase()));
  }

  hideParticipant(id: string): Participant {
    this.db.prepare("UPDATE participants SET hidden = 1 WHERE id = ?").run(id);
    return this.getParticipant(id)!;
  }

  createLocalAgent(
    input: Omit<LocalAgentConfig, "id" | "createdAt" | "autostart">,
  ): LocalAgentConfig {
    const existing = this.db
      .prepare("SELECT id FROM local_agents WHERE name_key = ?")
      .get(input.name.toLocaleLowerCase());
    if (existing)
      throw new HiveError(
        "LOCAL_AGENT_NAME_TAKEN",
        serverText("error.localAgent.nameExists", { name: input.name }),
      );
    const config: LocalAgentConfig = {
      ...input,
      id: randomUUID(),
      autostart: true,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO local_agents(id, provider, name, name_key, access, cwd, model, autostart, created_at, mcp_disabled)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        config.id,
        config.provider,
        config.name,
        config.name.toLocaleLowerCase(),
        config.access,
        config.cwd,
        config.model,
        1,
        config.createdAt,
        JSON.stringify(config.mcpDisabled ?? []),
      );
    return config;
  }

  /** 手动停止的 Agent 不随服务重启自动拉起，再次启动后恢复 */
  setLocalAgentAutostart(id: string, autostart: boolean): void {
    this.db
      .prepare("UPDATE local_agents SET autostart = ? WHERE id = ?")
      .run(autostart ? 1 : 0, id);
  }

  /** 记下本机 Agent 当前的进程；null 表示已退出 */
  setLocalAgentProcess(id: string, pid: number | null, startedAt: string | null): void {
    this.db
      .prepare("UPDATE local_agents SET pid = ?, pid_started_at = ? WHERE id = ?")
      .run(pid, startedAt, id);
  }

  /** 工作目录用不了时由 Supervisor 改成主目录（见 local-agents.ts checkCwd） */
  setLocalAgentCwd(id: string, cwd: string | null): void {
    this.db.prepare("UPDATE local_agents SET cwd = ? WHERE id = ?").run(cwd, id);
  }

  /** 网页上勾掉的本机 MCP；名称排序去重后保存 */
  setLocalAgentModel(id: string, model: string | null): string | null {
    this.db.prepare("UPDATE local_agents SET model = ? WHERE id = ?").run(model, id);
    return model;
  }

  /** 网页上选的思考强度；null 表示沿用 CLI 自己的配置 */
  setLocalAgentEffort(id: string, effort: string | null): string | null {
    this.db.prepare("UPDATE local_agents SET effort = ? WHERE id = ?").run(effort, id);
    return effort;
  }

  /** Claude 的自动压缩阈值和缓存时长；null 表示恢复默认 */
  setLocalAgentContext(
    id: string,
    compactWindow: ClaudeCompactWindow | null,
    cacheTtl: ClaudeCacheTtl | null,
  ): void {
    this.db
      .prepare("UPDATE local_agents SET compact_window = ?, cache_ttl = ? WHERE id = ?")
      .run(compactWindow === null ? null : String(compactWindow), cacheTtl, id);
  }

  setLocalAgentMcpDisabled(id: string, names: string[]): string[] {
    const normalized = [...new Set(names)].sort();
    this.db
      .prepare("UPDATE local_agents SET mcp_disabled = ? WHERE id = ?")
      .run(JSON.stringify(normalized), id);
    return normalized;
  }

  deleteLocalAgent(id: string): boolean {
    return this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO removed_local_agents(name_key, name, provider, cwd)
           SELECT name_key, name, provider, cwd FROM local_agents WHERE id = ?
           ON CONFLICT(name_key) DO UPDATE SET name = excluded.name, provider = excluded.provider,
             cwd = excluded.cwd`,
        )
        .run(id);
      return this.db.prepare("DELETE FROM local_agents WHERE id = ?").run(id).changes > 0;
    })();
  }

  /**
   * 跨房间搜索公共消息（不含已撤回）。3 个字符以上走 trigram 全文索引，更短的查询退回 LIKE。
   * 结果按时间倒序，最多 limit 条。
   */
  searchMessages(query: string, limit = 50): ChatMessage[] {
    const text = query.trim();
    if (!text) return [];
    if ([...text].length >= 3) {
      const phrase = `"${text.replaceAll('"', '""')}"`;
      const rows = this.db
        .prepare(
          `SELECT m.* FROM messages_fts f JOIN messages m ON m.seq = f.rowid
           WHERE messages_fts MATCH ? AND m.deleted_at IS NULL
           ORDER BY m.seq DESC LIMIT ?`,
        )
        .all(phrase, limit) as MessageRow[];
      return rows.map(mapMessage);
    }
    const pattern = `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM messages WHERE deleted_at IS NULL AND content LIKE ? ESCAPE '\\'
         ORDER BY seq DESC LIMIT ?`,
      )
      .all(pattern, limit) as MessageRow[];
    return rows.map(mapMessage);
  }

  /** 跨房间列出 @ 了某人的消息（不含撤回与本人发送），按时间倒序 */
  listMentions(username: string, limit = 100): ChatMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE deleted_at IS NULL AND lower(sender_name) != lower(?)
           AND EXISTS (SELECT 1 FROM json_each(messages.mentions) WHERE lower(value) = lower(?))
         ORDER BY seq DESC LIMIT ?`,
      )
      .all(username, username, limit) as MessageRow[];
    return rows.map(mapMessage);
  }

  /** 跨房间列出仍需关注的调用：进行中，以及最近 7 天内失败、被拦截或结果未知的 */
  listActiveInvocations(limit = 200): Invocation[] {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT * FROM invocations
         WHERE status IN ('queued', 'running', 'cancelling', 'waiting_human')
            OR (status IN ('failed', 'blocked', 'timed_out') AND updated_at >= ?
                AND resolved_at IS NULL)
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(since, limit) as InvocationRow[];
    return rows.map(mapInvocation);
  }
}
