import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ImChannel, ImConnection } from "@ai-hive/protocol";
import type { SecretBox } from "./secret-box.js";

/** 渠道私有的非机密配置，如飞书 appId、区域；机密部分加密后单独存放 */
export type ImConfig = Record<string, string>;

export type StoredConnection = ImConnection & {
  /** 扫码人在 IM 平台上的 ID：只有这个人的消息会以房主身份进入房间 */
  ownerActorId: string;
  config: ImConfig;
  /** 房主最近发消息的会话：不是由 IM 发起、但 @ 房主的消息推到这里 */
  lastChatId?: string;
};

type ConnectionRow = {
  id: string;
  room_id: string;
  channel: ImChannel;
  owner_name: string;
  owner_actor_id: string;
  label: string;
  status: ImConnection["status"];
  detail: string | null;
  config: string;
  secret: string | null;
  created_at: string;
  last_inbound_at: string | null;
  last_chat_id: string | null;
};

export type OutboxItem = {
  id: string;
  connectionId: string;
  messageId: string;
  chatId: string;
  replyToExternalId?: string;
  text: string;
  attempts: number;
};

/** 消息与 IM 会话的对应关系：入站消息是「源头」，出站消息记下 IM 侧的消息 ID 供回复引用 */
export type ImLink = {
  messageId: string;
  connectionId: string;
  chatId: string;
  externalId?: string;
  direction: "in" | "out";
};

function mapConnection(row: ConnectionRow): StoredConnection {
  return {
    id: row.id,
    roomId: row.room_id,
    channel: row.channel,
    ownerName: row.owner_name,
    ownerActorId: row.owner_actor_id,
    label: row.label,
    status: row.status,
    ...(row.detail ? { detail: row.detail } : {}),
    createdAt: row.created_at,
    ...(row.last_inbound_at ? { lastInboundAt: row.last_inbound_at } : {}),
    ...(row.last_chat_id ? { lastChatId: row.last_chat_id } : {}),
    config: JSON.parse(row.config) as ImConfig,
  };
}

export function publicConnection(connection: StoredConnection): ImConnection {
  return {
    id: connection.id,
    roomId: connection.roomId,
    channel: connection.channel,
    ownerName: connection.ownerName,
    label: connection.label,
    status: connection.status,
    ...(connection.detail ? { detail: connection.detail } : {}),
    createdAt: connection.createdAt,
    ...(connection.lastInboundAt ? { lastInboundAt: connection.lastInboundAt } : {}),
  };
}

export class ImStore {
  constructor(
    private readonly db: Database.Database,
    private readonly box: SecretBox,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS im_connections (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        owner_name TEXT NOT NULL,
        owner_actor_id TEXT NOT NULL,
        label TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT,
        config TEXT NOT NULL,
        secret TEXT,
        created_at TEXT NOT NULL,
        last_inbound_at TEXT,
        last_chat_id TEXT
      );
      CREATE TABLE IF NOT EXISTS im_inbound (
        connection_id TEXT NOT NULL,
        external_id TEXT NOT NULL,
        received_at TEXT NOT NULL,
        PRIMARY KEY (connection_id, external_id)
      );
      CREATE TABLE IF NOT EXISTS im_links (
        message_id TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        external_id TEXT,
        direction TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (message_id, connection_id)
      );
      CREATE INDEX IF NOT EXISTS im_links_external ON im_links(connection_id, external_id);
      CREATE TABLE IF NOT EXISTS im_outbox (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        reply_to_external_id TEXT,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_at TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (connection_id, message_id)
      );
      CREATE TABLE IF NOT EXISTS im_kv (
        connection_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (connection_id, key)
      );
    `);
  }

  /* ---------- 连接 ---------- */

  createConnection(input: {
    roomId: string;
    channel: ImChannel;
    ownerName: string;
    ownerActorId: string;
    label: string;
    config: ImConfig;
    secret: string;
    id?: string;
  }): StoredConnection {
    const id = input.id ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO im_connections(id, room_id, channel, owner_name, owner_actor_id, label, status, config, secret, created_at)
         VALUES(?, ?, ?, ?, ?, ?, 'connecting', ?, ?, ?)`,
      )
      .run(
        id,
        input.roomId,
        input.channel,
        input.ownerName,
        input.ownerActorId,
        input.label,
        JSON.stringify(input.config),
        this.box.seal(input.secret),
        new Date().toISOString(),
      );
    return this.getConnection(id)!;
  }

  getConnection(id: string): StoredConnection | undefined {
    const row = this.db.prepare("SELECT * FROM im_connections WHERE id = ?").get(id) as
      ConnectionRow | undefined;
    return row ? mapConnection(row) : undefined;
  }

  listConnections(roomId?: string): StoredConnection[] {
    const rows = (
      roomId
        ? this.db
            .prepare("SELECT * FROM im_connections WHERE room_id = ? ORDER BY created_at")
            .all(roomId)
        : this.db.prepare("SELECT * FROM im_connections ORDER BY created_at").all()
    ) as ConnectionRow[];
    return rows.map(mapConnection);
  }

  /** 同一个飞书应用 / 微信账号只保留一条连接：平台每条事件只投给一个长连接客户端 */
  findByIdentity(channel: ImChannel, key: string, value: string): StoredConnection | undefined {
    return this.listConnections().find(
      (connection) => connection.channel === channel && connection.config[key] === value,
    );
  }

  secretOf(id: string): string | undefined {
    const row = this.db.prepare("SELECT secret FROM im_connections WHERE id = ?").get(id) as
      { secret: string | null } | undefined;
    return row?.secret ? this.box.open(row.secret) : undefined;
  }

  updateSecret(id: string, secret: string): void {
    this.db
      .prepare("UPDATE im_connections SET secret = ? WHERE id = ?")
      .run(this.box.seal(secret), id);
  }

  setStatus(
    id: string,
    status: ImConnection["status"],
    detail?: string,
  ): StoredConnection | undefined {
    this.db
      .prepare("UPDATE im_connections SET status = ?, detail = ? WHERE id = ?")
      .run(status, detail ?? null, id);
    return this.getConnection(id);
  }

  update(
    id: string,
    patch: { roomId?: string; label?: string; ownerName?: string; config?: ImConfig },
  ): StoredConnection | undefined {
    const current = this.getConnection(id);
    if (!current) return undefined;
    this.db
      .prepare(
        "UPDATE im_connections SET room_id = ?, label = ?, owner_name = ?, config = ? WHERE id = ?",
      )
      .run(
        patch.roomId ?? current.roomId,
        patch.label ?? current.label,
        patch.ownerName ?? current.ownerName,
        JSON.stringify(patch.config ?? current.config),
        id,
      );
    return this.getConnection(id);
  }

  touchInbound(id: string, chatId: string): void {
    this.db
      .prepare("UPDATE im_connections SET last_inbound_at = ?, last_chat_id = ? WHERE id = ?")
      .run(new Date().toISOString(), chatId, id);
  }

  /** 断开：删除连接、凭据及其 SDK 状态；已经发进房间的消息保留 */
  deleteConnection(id: string): void {
    const run = this.db.transaction(() => {
      this.db.prepare("DELETE FROM im_connections WHERE id = ?").run(id);
      this.db.prepare("DELETE FROM im_kv WHERE connection_id = ?").run(id);
      this.db.prepare("DELETE FROM im_outbox WHERE connection_id = ?").run(id);
      this.db.prepare("DELETE FROM im_inbound WHERE connection_id = ?").run(id);
    });
    run();
  }

  /* ---------- 入站去重 ---------- */

  /** 第一次见到这条 IM 消息时返回 true；平台重推的同一条消息返回 false */
  claimInbound(connectionId: string, externalId: string): boolean {
    const result = this.db
      .prepare(
        "INSERT OR IGNORE INTO im_inbound(connection_id, external_id, received_at) VALUES(?, ?, ?)",
      )
      .run(connectionId, externalId, new Date().toISOString());
    return result.changes === 1;
  }

  /* ---------- 消息与会话的对应 ---------- */

  link(link: ImLink): void {
    this.db
      .prepare(
        `INSERT INTO im_links(message_id, connection_id, chat_id, external_id, direction, created_at)
         VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(message_id, connection_id) DO UPDATE SET external_id = COALESCE(excluded.external_id, im_links.external_id)`,
      )
      .run(
        link.messageId,
        link.connectionId,
        link.chatId,
        link.externalId ?? null,
        link.direction,
        new Date().toISOString(),
      );
  }

  linksOf(messageId: string): ImLink[] {
    const rows = this.db
      .prepare("SELECT * FROM im_links WHERE message_id = ?")
      .all(messageId) as Array<{
      message_id: string;
      connection_id: string;
      chat_id: string;
      external_id: string | null;
      direction: "in" | "out";
    }>;
    return rows.map((row) => ({
      messageId: row.message_id,
      connectionId: row.connection_id,
      chatId: row.chat_id,
      ...(row.external_id ? { externalId: row.external_id } : {}),
      direction: row.direction,
    }));
  }

  messageForExternal(connectionId: string, externalId: string): string | undefined {
    const row = this.db
      .prepare("SELECT message_id FROM im_links WHERE connection_id = ? AND external_id = ?")
      .get(connectionId, externalId) as { message_id: string } | undefined;
    return row?.message_id;
  }

  /** 这个会话最近收到的、仍可能在等回答的提问（按推送时间倒序） */
  recentOutboundMessages(connectionId: string, chatId: string, limit: number): string[] {
    const rows = this.db
      .prepare(
        "SELECT message_id FROM im_links WHERE connection_id = ? AND chat_id = ? AND direction = 'out' ORDER BY created_at DESC LIMIT ?",
      )
      .all(connectionId, chatId, limit) as Array<{ message_id: string }>;
    return rows.map((row) => row.message_id);
  }

  /* ---------- 出站队列 ---------- */

  enqueue(item: Omit<OutboxItem, "id" | "attempts">): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO im_outbox(id, connection_id, message_id, chat_id, reply_to_external_id, text, status, attempts, next_at, created_at)
         VALUES(?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
      )
      .run(
        randomUUID(),
        item.connectionId,
        item.messageId,
        item.chatId,
        item.replyToExternalId ?? null,
        item.text,
        new Date().toISOString(),
        new Date().toISOString(),
      );
    return result.changes === 1;
  }

  duePending(now: number, limit = 20): OutboxItem[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM im_outbox WHERE status = 'pending' AND next_at <= ? ORDER BY created_at LIMIT ?",
      )
      .all(new Date(now).toISOString(), limit) as Array<{
      id: string;
      connection_id: string;
      message_id: string;
      chat_id: string;
      reply_to_external_id: string | null;
      text: string;
      attempts: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      connectionId: row.connection_id,
      messageId: row.message_id,
      chatId: row.chat_id,
      ...(row.reply_to_external_id ? { replyToExternalId: row.reply_to_external_id } : {}),
      text: row.text,
      attempts: row.attempts,
    }));
  }

  markSent(id: string): void {
    this.db.prepare("UPDATE im_outbox SET status = 'sent', error = NULL WHERE id = ?").run(id);
  }

  markRetry(id: string, attempts: number, nextAt: number, error: string, give_up: boolean): void {
    this.db
      .prepare("UPDATE im_outbox SET status = ?, attempts = ?, next_at = ?, error = ? WHERE id = ?")
      .run(
        give_up ? "failed" : "pending",
        attempts,
        new Date(nextAt).toISOString(),
        error.slice(0, 500),
        id,
      );
  }

  /* ---------- SDK 私有状态（加密） ---------- */

  kvGet(connectionId: string, key: string): string | undefined {
    const row = this.db
      .prepare("SELECT value FROM im_kv WHERE connection_id = ? AND key = ?")
      .get(connectionId, key) as { value: string } | undefined;
    return row ? this.box.open(row.value) : undefined;
  }

  kvSet(connectionId: string, key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO im_kv(connection_id, key, value) VALUES(?, ?, ?) ON CONFLICT(connection_id, key) DO UPDATE SET value = excluded.value",
      )
      .run(connectionId, key, this.box.seal(value));
  }

  kvDelete(connectionId: string, key?: string): void {
    if (key === undefined) {
      this.db.prepare("DELETE FROM im_kv WHERE connection_id = ?").run(connectionId);
    } else {
      this.db
        .prepare("DELETE FROM im_kv WHERE connection_id = ? AND key = ?")
        .run(connectionId, key);
    }
  }

  kvMove(from: string, to: string): void {
    this.db
      .prepare("UPDATE OR REPLACE im_kv SET connection_id = ? WHERE connection_id = ?")
      .run(to, from);
  }
}
