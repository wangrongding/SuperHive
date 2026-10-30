import { runtimeObservationSchema, type RuntimeObservation } from "@ai-hive/protocol";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import {
  LIMITS,
  parseMentions,
  stripUnsafeCharacters,
  messageViaSchema,
  questionAnswerSchema,
  questionSpecSchema,
  type ChatMessage,
  type QuestionAnswer,
  type QuestionSpec,
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
  type WhiteboardEntry,
  type WhiteboardSlot,
} from "@ai-hive/protocol";

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
};

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
  };
}

type RoomRow = {
  id: string;
  name: string;
  created_at: string;
  created_by: string | null;
  archived_at: string | null;
  online_count: number;
  latest_seq: number;
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
  progress: string | null;
  runtime: string | null;
  reply_message_id: string | null;
  parent_invocation_id: string | null;
  continuation: InvocationContinuation | null;
  attempts: number;
  created_at: string;
  updated_at: string;
  received_at: string | null;
  started_at: string | null;
  finished_at: string | null;
};

type WhiteboardRow = {
  id: string;
  room_id: string;
  key: string;
  slot: WhiteboardSlot;
  summary: string;
  repo: string | null;
  branch: string | null;
  commit_ref: string | null;
  unblocks: string;
  author_id: string;
  author_name: string;
  created_at: string;
  updated_at: string;
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
  detail?: string | null;
  progress?: string | null;
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
  commit?: string | undefined;
  unblocks?: string[] | undefined;
};

export const TERMINAL_INVOCATION_STATUSES: readonly InvocationStatus[] = [
  "completed",
  "failed",
  "blocked",
  "cancelled",
];

export class HiveError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HiveError";
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
  /** 点选提交的答案（由服务端校验后生成） */
  answer?: QuestionAnswer;
  /** 经外部 IM 发来的消息（由服务端的 IM 连接设置） */
  via?: NonNullable<ChatMessage["via"]>;
};

export type CreateMessageResult = { message: ChatMessage; created: boolean };

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
    row.kind === "question"
      ? { kind: row.kind as NonNullable<ChatMessage["kind"]> }
      : {}),
    ...(row.deleted_at ? {} : parseMessageMeta(row.meta)),
  };
}

/** 损坏或不认识的元数据只当作没有：消息正文仍是唯一的语义来源 */
function parseMessageMeta(raw: string | null): Pick<ChatMessage, "question" | "answer" | "via"> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as { question?: unknown; answer?: unknown; via?: unknown };
    const question = questionSpecSchema.safeParse(value.question);
    const answer = questionAnswerSchema.safeParse(value.answer);
    const via = messageViaSchema.safeParse(value.via);
    return {
      ...(question.success ? { question: question.data } : {}),
      ...(answer.success ? { answer: answer.data } : {}),
      ...(via.success ? { via: via.data } : {}),
    };
  } catch {
    return {};
  }
}

function mapInvocation(row: InvocationRow): Invocation {
  let runtime: RuntimeObservation | undefined;
  try {
    const parsed = runtimeObservationSchema.safeParse(JSON.parse(row.runtime ?? "null"));
    if (parsed.success) runtime = parsed.data;
  } catch {
    /* A corrupt optional diagnostic field must not hide the invocation. */
  }
  return {
    ...(runtime ? { runtime } : {}),
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
    status: row.status,
    ...(row.block_reason ? { blockReason: row.block_reason } : {}),
    ...(row.detail ? { detail: row.detail } : {}),
    ...(row.progress ? { progress: row.progress } : {}),
    ...(row.reply_message_id ? { replyMessageId: row.reply_message_id } : {}),
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.received_at ? { receivedAt: row.received_at } : {}),
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
  };
}

function mapWhiteboard(row: WhiteboardRow): WhiteboardEntry {
  return {
    id: row.id,
    roomId: row.room_id,
    key: row.key,
    slot: row.slot,
    summary: row.summary,
    ...(row.repo ? { repo: row.repo } : {}),
    ...(row.branch ? { branch: row.branch } : {}),
    ...(row.commit_ref ? { commit: row.commit_ref } : {}),
    unblocks: JSON.parse(row.unblocks) as string[],
    authorId: row.author_id,
    authorName: row.author_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRoom(row: RoomRow): RoomSummary {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    ...(row.created_by ? { createdBy: row.created_by } : {}),
    ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
    onlineCount: row.online_count,
    latestSeq: row.latest_seq,
  };
}

const roomSummarySelect = `
  SELECT r.id, r.name, r.created_at, r.created_by, r.archived_at,
         COALESCE(p.online_count, 0) AS online_count,
         COALESCE(m.latest_seq, 0) AS latest_seq
  FROM rooms r
  LEFT JOIN (
    SELECT room_id, COUNT(*) AS online_count FROM participants
    WHERE status != 'offline' GROUP BY room_id
  ) p ON p.room_id = r.id
  LEFT JOIN (
    SELECT room_id, MAX(seq) AS latest_seq FROM messages GROUP BY room_id
  ) m ON m.room_id = r.id
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
    `);
    const participantColumns = this.db.pragma("table_info(participants)") as Array<{
      name: string;
    }>;
    if (!participantColumns.some((column) => column.name === "provider")) {
      this.db.exec("ALTER TABLE participants ADD COLUMN provider TEXT");
    }
    const invocationColumns = this.db.pragma("table_info(invocations)") as Array<{ name: string }>;
    if (!invocationColumns.some((column) => column.name === "runtime")) {
      this.db.exec("ALTER TABLE invocations ADD COLUMN runtime TEXT");
    }
    if (!invocationColumns.some((column) => column.name === "parent_invocation_id")) {
      // 委派关系与子任务回执状态（见 Invocation.parentInvocationId / continuation）
      this.db.exec("ALTER TABLE invocations ADD COLUMN parent_invocation_id TEXT");
      this.db.exec("ALTER TABLE invocations ADD COLUMN continuation TEXT");
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
    const roomColumns = this.db.pragma("table_info(rooms)") as Array<{ name: string }>;
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
  }): RoomSummary {
    const existing = this.db.prepare("SELECT id FROM rooms WHERE id = ?").get(input.id);
    if (existing) throw new HiveError("ROOM_EXISTS", "A room with this id already exists.");
    this.db
      .prepare("INSERT INTO rooms(id, name, created_at, created_by) VALUES(?, ?, ?, ?)")
      .run(input.id, input.name ?? input.id, new Date().toISOString(), input.createdBy ?? null);
    return this.getRoom(input.id)!;
  }

  ensureRoom(id: string, createdBy?: string): { room: RoomSummary; created: boolean } {
    const room = this.getRoom(id);
    if (room) return { room, created: false };
    return { room: this.createRoom({ id, createdBy }), created: true };
  }

  updateRoom(
    id: string,
    patch: { name?: string | undefined; archived?: boolean | undefined },
  ): RoomSummary {
    const room = this.getRoom(id);
    if (!room) throw new HiveError("ROOM_NOT_FOUND", "Room not found.");
    if (patch.archived === true && id === "general") {
      throw new HiveError("ROOM_PROTECTED", "The default room cannot be archived.");
    }
    if (patch.name !== undefined) {
      this.db.prepare("UPDATE rooms SET name = ? WHERE id = ?").run(patch.name, id);
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
        throw new HiveError("USERNAME_TAKEN", "This username belongs to another participant type.");
      }
      this.db
        .prepare(
          "UPDATE participants SET username = ?, persona = ?, provider = ?, status = 'online', last_seen_at = ? WHERE id = ?",
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
      .prepare(
        "SELECT * FROM participants WHERE room_id = ? ORDER BY CASE status WHEN 'busy' THEN 0 WHEN 'online' THEN 1 ELSE 2 END, username_key",
      )
      .all(roomId) as ParticipantRow[];
    return rows.map(mapParticipant);
  }

  setParticipantStatus(id: string, status: ParticipantStatus): Participant {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE participants SET status = ?, last_seen_at = ? WHERE id = ?")
      .run(status, now, id);
    const participant = this.getParticipant(id);
    if (!participant) throw new HiveError("PARTICIPANT_NOT_FOUND", "Participant not found.");
    return participant;
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
   * 清空房间的消息和调用记录；白板是跨话题的长期共识，保留。
   * seq 由 AUTOINCREMENT 保证继续递增，Agent 记录的处理进度不会因此错乱。
   */
  clearRoom(roomId: string): { messages: number; invocations: number } {
    return this.db.transaction(() => {
      const invocations = this.db.prepare("DELETE FROM invocations WHERE room_id = ?").run(roomId);
      const messages = this.db.prepare("DELETE FROM messages WHERE room_id = ?").run(roomId);
      return { messages: messages.changes, invocations: invocations.changes };
    })();
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
      throw new HiveError("MESSAGE_NOT_FOUND", "Message not found in this room.");
    }
    if (message.senderId !== actor.id) {
      throw new HiveError("FORBIDDEN", "Only the sender can recall a message.");
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
        throw new HiveError("PARENT_NOT_FOUND", "The parent message does not exist in this room.");
      }
      if (parent.senderId === sender.id) {
        throw new HiveError("SELF_RESPONSE", "An agent cannot respond to its own message.");
      }
      if (parent.hopCount >= LIMITS.maxHopCount + this.turnAllowance(sender.roomId)) {
        throw new HiveError("HOP_LIMIT", "This agent conversation has reached its hop limit.");
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
        throw new HiveError("TRACE_LIMIT", "This agent conversation has reached its trace limit.");
      }
      const since = new Date(Date.now() - 60_000).toISOString();
      const recentCount = this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM messages WHERE sender_id = ? AND sender_type = 'agent' AND created_at >= ?",
        )
        .get(sender.id, since) as { count: number };
      if (recentCount.count >= LIMITS.maxAgentRepliesPerMinute) {
        throw new HiveError("RATE_LIMIT", "This agent has reached its reply rate limit.");
      }
    }

    const content = stripUnsafeCharacters(input.content).trim();
    if (!content) throw new HiveError("EMPTY_MESSAGE", "Message content is empty.");
    const id = randomUUID();
    // 话题分隔只是界面上的分界线，不唤醒任何人
    const mentions = input.kind === "topic" ? [] : parseMentions(content);
    const createdAt = new Date().toISOString();
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
        input.question || input.answer || input.via
          ? JSON.stringify({
              ...(input.question ? { question: input.question } : {}),
              ...(input.answer ? { answer: input.answer } : {}),
              ...(input.via ? { via: input.via } : {}),
            })
          : null,
      );
    return { message: this.getMessage(id)!, created: true };
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
        "SELECT COALESCE(MAX(seq), 0) AS seq FROM messages WHERE room_id = ? AND sender_type = 'human'",
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
          "SELECT COUNT(*) AS count FROM messages WHERE room_id = ? AND sender_type = 'agent' AND seq > ?",
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
    if (!room) throw new HiveError("ROOM_NOT_FOUND", "Room not found.");
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
    detail?: string;
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
          requester_type, status, block_reason, detail, parent_invocation_id, continuation,
          attempts, created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
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
        input.detail ?? null,
        input.parentInvocationId ?? null,
        input.continuation ?? null,
        now,
        now,
      );
    return { invocation: this.getInvocation(id)!, created: true };
  }

  getInvocation(id: string): Invocation | undefined {
    const row = this.db.prepare("SELECT * FROM invocations WHERE id = ?").get(id) as
      InvocationRow | undefined;
    return row ? mapInvocation(row) : undefined;
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

  /** 已请求停止、尚未收到确认的调用：Agent 重新连接时需要再次下发停止请求 */
  listCancellingInvocations(agentId: string): Invocation[] {
    const rows = this.db
      .prepare("SELECT * FROM invocations WHERE agent_id = ? AND status = 'cancelling'")
      .all(agentId) as InvocationRow[];
    return rows.map(mapInvocation);
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

  updateInvocation(id: string, patch: InvocationPatch): Invocation {
    const columns: Record<keyof InvocationPatch, string> = {
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
    for (const [key, column] of Object.entries(columns) as Array<[keyof InvocationPatch, string]>) {
      if (patch[key] === undefined) continue;
      assignments.push(`${column} = ?`);
      values.push(key === "runtime" && patch.runtime ? JSON.stringify(patch.runtime) : patch[key]);
    }
    this.db
      .prepare(`UPDATE invocations SET ${assignments.join(", ")} WHERE id = ?`)
      .run(...values, id);
    const invocation = this.getInvocation(id);
    if (!invocation) throw new HiveError("INVOCATION_NOT_FOUND", "Invocation not found.");
    return invocation;
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

  listWhiteboard(roomId: string): WhiteboardEntry[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM whiteboard_entries WHERE room_id = ? ORDER BY updated_at DESC, rowid DESC",
      )
      .all(roomId) as WhiteboardRow[];
    return rows.map(mapWhiteboard);
  }

  /**
   * 按 key 写入白板：同一事项从"进行中"移到"已就绪"只需复用 key。
   * 60 秒内内容完全相同的重复发布视为节流，不产生更新；每个栏目最多保留 50 条。
   */
  upsertWhiteboardEntry(
    author: Participant,
    input: WhiteboardInput,
  ): { entry: WhiteboardEntry; changed: boolean; evicted: string[] } {
    const now = new Date();
    const unblocks = [...new Set(input.unblocks ?? [])];
    const existingRow = this.db
      .prepare("SELECT * FROM whiteboard_entries WHERE room_id = ? AND key = ?")
      .get(author.roomId, input.key) as WhiteboardRow | undefined;
    if (existingRow) {
      const existing = mapWhiteboard(existingRow);
      const unchanged =
        existing.slot === input.slot &&
        existing.summary === input.summary &&
        (existing.repo ?? undefined) === input.repo &&
        (existing.branch ?? undefined) === input.branch &&
        (existing.commit ?? undefined) === input.commit &&
        JSON.stringify(existing.unblocks) === JSON.stringify(unblocks);
      if (unchanged && now.getTime() - Date.parse(existing.updatedAt) < 60_000) {
        return { entry: existing, changed: false, evicted: [] };
      }
      this.db
        .prepare(
          `UPDATE whiteboard_entries SET slot = ?, summary = ?, repo = ?, branch = ?, commit_ref = ?,
             unblocks = ?, author_id = ?, author_name = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          input.slot,
          input.summary,
          input.repo ?? null,
          input.branch ?? null,
          input.commit ?? null,
          JSON.stringify(unblocks),
          author.id,
          author.username,
          now.toISOString(),
          existing.id,
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO whiteboard_entries(
            id, room_id, key, slot, summary, repo, branch, commit_ref, unblocks,
            author_id, author_name, created_at, updated_at
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          author.roomId,
          input.key,
          input.slot,
          input.summary,
          input.repo ?? null,
          input.branch ?? null,
          input.commit ?? null,
          JSON.stringify(unblocks),
          author.id,
          author.username,
          now.toISOString(),
          now.toISOString(),
        );
    }
    const overflow = this.db
      .prepare(
        `SELECT id FROM whiteboard_entries WHERE room_id = ? AND slot = ?
         ORDER BY updated_at DESC, rowid DESC LIMIT -1 OFFSET ?`,
      )
      .all(author.roomId, input.slot, LIMITS.maxWhiteboardEntriesPerSlot) as Array<{ id: string }>;
    for (const { id } of overflow) {
      this.db.prepare("DELETE FROM whiteboard_entries WHERE id = ?").run(id);
    }
    const row = this.db
      .prepare("SELECT * FROM whiteboard_entries WHERE room_id = ? AND key = ?")
      .get(author.roomId, input.key) as WhiteboardRow;
    return { entry: mapWhiteboard(row), changed: true, evicted: overflow.map(({ id }) => id) };
  }

  removeWhiteboardEntry(roomId: string, entryId: string): boolean {
    return (
      this.db
        .prepare("DELETE FROM whiteboard_entries WHERE room_id = ? AND id = ?")
        .run(roomId, entryId).changes > 0
    );
  }

  /* ---------- 本机 Agent 配置（只存配置，进程状态由 LocalAgentSupervisor 维护） ---------- */

  listLocalAgents(): LocalAgentConfig[] {
    const rows = this.db
      .prepare("SELECT * FROM local_agents ORDER BY created_at ASC, rowid ASC")
      .all() as LocalAgentRow[];
    return rows.map(mapLocalAgent);
  }

  createLocalAgent(
    input: Omit<LocalAgentConfig, "id" | "createdAt" | "autostart">,
  ): LocalAgentConfig {
    const existing = this.db
      .prepare("SELECT id FROM local_agents WHERE name_key = ?")
      .get(input.name.toLocaleLowerCase());
    if (existing)
      throw new HiveError("LOCAL_AGENT_NAME_TAKEN", `本机已有名为 ${input.name} 的 Agent。`);
    const config: LocalAgentConfig = {
      ...input,
      id: randomUUID(),
      autostart: true,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO local_agents(id, provider, name, name_key, access, cwd, model, autostart, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
    return config;
  }

  /** 手动停止的 Agent 不随服务重启自动拉起，再次启动后恢复 */
  setLocalAgentAutostart(id: string, autostart: boolean): void {
    this.db
      .prepare("UPDATE local_agents SET autostart = ? WHERE id = ?")
      .run(autostart ? 1 : 0, id);
  }

  deleteLocalAgent(id: string): boolean {
    return this.db.prepare("DELETE FROM local_agents WHERE id = ?").run(id).changes > 0;
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
            OR (status IN ('failed', 'blocked', 'timed_out') AND updated_at >= ?)
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(since, limit) as InvocationRow[];
    return rows.map(mapInvocation);
  }
}
