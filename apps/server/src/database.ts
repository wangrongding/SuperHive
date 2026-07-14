import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import {
  LIMITS,
  parseMentions,
  type ChatMessage,
  type Participant,
  type AgentProvider,
  type ParticipantStatus,
  type ParticipantType,
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
};

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
  };
}

export class HiveDatabase {
  private readonly db: Database.Database;

  constructor(filename: string) {
    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
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
    `);
    const participantColumns = this.db.pragma("table_info(participants)") as Array<{
      name: string;
    }>;
    if (!participantColumns.some((column) => column.name === "provider")) {
      this.db.exec("ALTER TABLE participants ADD COLUMN provider TEXT");
    }
    this.db.prepare("UPDATE participants SET status = 'offline'").run();
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

  private getMessage(id: string): ChatMessage | undefined {
    const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as
      MessageRow | undefined;
    return row ? mapMessage(row) : undefined;
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
      if (parent.hopCount >= LIMITS.maxHopCount) {
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
      if (traceCount.count >= LIMITS.maxAgentMessagesPerTrace) {
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

    const id = randomUUID();
    const mentions = parseMentions(input.content);
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO messages(
          id, room_id, sender_id, sender_name, sender_type, content, mentions,
          reply_to_message_id, trace_id, parent_message_id, hop_count, client_message_id, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        sender.roomId,
        sender.id,
        sender.username,
        sender.type,
        input.content,
        JSON.stringify(mentions),
        input.replyToMessageId ?? null,
        traceId,
        parent?.id ?? null,
        hopCount,
        input.clientMessageId,
        createdAt,
      );
    return { message: this.getMessage(id)!, created: true };
  }
}
