import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ImChannel, ImConnection, ImDeliveryLevel } from "@ai-hive/protocol";
import type { SecretBox } from "./secret-box.js";

/** 渠道私有的非机密配置，如飞书 appId、区域；机密部分加密后单独存放 */
export type ImConfig = Record<string, string>;

export type StoredConnection = Omit<ImConnection, "delivery"> & {
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
  level: ImDeliveryLevel | null;
  filtered_count: number | null;
};

/**
 * 发送前复核：排队期间情况变了（问题已被回答、任务已恢复）就不再发过时的提醒。
 * question=这条提问仍在等人回答；invocation=调用仍是入队时的状态与执行次数。
 */
export type OutboxCheck =
  | { kind: "question"; messageId: string }
  | { kind: "invocation"; id: string; status: string; attempts: number };

export type OutboxItem = {
  id: string;
  connectionId: string;
  /** 去重键：同一事件（同一条消息、同一调用的同一次状态）只推一次 */
  eventKey: string;
  /** 推送对应的房间消息；回复引用和「在 IM 里回答提问」靠它对上 */
  messageId?: string;
  /** 目标会话；以 user: 开头时表示发到这个人的私聊 */
  chatId: string;
  replyToExternalId?: string;
  text: string;
  attempts: number;
  /** 合并推送：攒一段时间后与同一会话的其它合并项一起发 */
  batch?: boolean;
  check?: OutboxCheck;
  createdAt?: string;
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
    level: row.level ?? "mine",
    createdAt: row.created_at,
    ...(row.last_inbound_at ? { lastInboundAt: row.last_inbound_at } : {}),
    ...(row.last_chat_id ? { lastChatId: row.last_chat_id } : {}),
    config: JSON.parse(row.config) as ImConfig,
  };
}

export function publicConnection(
  connection: StoredConnection,
  delivery: ImConnection["delivery"],
): ImConnection {
  return {
    level: connection.level,
    delivery,
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
      CREATE TABLE IF NOT EXISTS im_deliveries (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL,
        event_key TEXT NOT NULL,
        message_id TEXT,
        chat_id TEXT NOT NULL,
        reply_to_external_id TEXT,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_at TEXT NOT NULL,
        batch INTEGER NOT NULL DEFAULT 0,
        check_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (connection_id, event_key)
      );
      CREATE INDEX IF NOT EXISTS im_deliveries_due ON im_deliveries(status, next_at);
      CREATE TABLE IF NOT EXISTS im_kv (
        connection_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (connection_id, key)
      );
    `);
    const columns = db.pragma("table_info(im_connections)") as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "level")) {
      db.exec("ALTER TABLE im_connections ADD COLUMN level TEXT");
      db.exec("ALTER TABLE im_connections ADD COLUMN filtered_count INTEGER NOT NULL DEFAULT 0");
    }
    // 旧版发送队列（每条消息只能推一次）里还没发出的，迁到按事件去重的新队列
    db.exec(`
      INSERT OR IGNORE INTO im_deliveries(id, connection_id, event_key, message_id, chat_id, reply_to_external_id, text, status, attempts, next_at, created_at, updated_at)
      SELECT id, connection_id, 'msg:' || message_id, message_id, chat_id, reply_to_external_id, text, status, attempts, next_at, created_at, created_at
      FROM im_outbox WHERE status = 'pending';
      DELETE FROM im_outbox WHERE status = 'pending';
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
      this.db.prepare("DELETE FROM im_deliveries WHERE connection_id = ?").run(id);
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

  setLevel(id: string, level: ImDeliveryLevel): void {
    this.db.prepare("UPDATE im_connections SET level = ? WHERE id = ?").run(level, id);
  }

  countFiltered(id: string): void {
    this.db
      .prepare(
        "UPDATE im_connections SET filtered_count = COALESCE(filtered_count, 0) + 1 WHERE id = ?",
      )
      .run(id);
  }

  /** 入队；同一事件已经入过队（不论是否发出）返回 false */
  enqueue(item: Omit<OutboxItem, "id" | "attempts" | "createdAt">): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO im_deliveries(id, connection_id, event_key, message_id, chat_id, reply_to_external_id, text, status, attempts, next_at, batch, check_json, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        item.connectionId,
        item.eventKey,
        item.messageId ?? null,
        item.chatId,
        item.replyToExternalId ?? null,
        item.text,
        now,
        item.batch ? 1 : 0,
        item.check ? JSON.stringify(item.check) : null,
        now,
        now,
      );
    return result.changes === 1;
  }

  duePending(now: number, limit = 50): OutboxItem[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM im_deliveries WHERE status = 'pending' AND next_at <= ? ORDER BY created_at, rowid LIMIT ?",
      )
      .all(new Date(now).toISOString(), limit) as Array<{
      id: string;
      connection_id: string;
      event_key: string;
      message_id: string | null;
      chat_id: string;
      reply_to_external_id: string | null;
      text: string;
      attempts: number;
      batch: number;
      check_json: string | null;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      connectionId: row.connection_id,
      eventKey: row.event_key,
      ...(row.message_id ? { messageId: row.message_id } : {}),
      chatId: row.chat_id,
      ...(row.reply_to_external_id ? { replyToExternalId: row.reply_to_external_id } : {}),
      text: row.text,
      attempts: row.attempts,
      ...(row.batch ? { batch: true } : {}),
      ...(row.check_json ? { check: JSON.parse(row.check_json) as OutboxCheck } : {}),
      createdAt: row.created_at,
    }));
  }

  markSent(id: string): void {
    this.db
      .prepare(
        "UPDATE im_deliveries SET status = 'sent', error = NULL, updated_at = ? WHERE id = ?",
      )
      .run(new Date().toISOString(), id);
  }

  /** 还没发出的合并项改为立即发送（它其实是交给房主的最终结果） */
  promote(connectionId: string, eventKey: string): void {
    this.db
      .prepare(
        "UPDATE im_deliveries SET batch = 0 WHERE connection_id = ? AND event_key = ? AND status = 'pending'",
      )
      .run(connectionId, eventKey);
  }

  /** 发送前复核发现已经过时：不发，也不算失败 */
  markSkipped(id: string): void {
    this.db
      .prepare("UPDATE im_deliveries SET status = 'skipped', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  }

  markRetry(id: string, attempts: number, nextAt: number, error: string, giveUp: boolean): void {
    this.db
      .prepare(
        "UPDATE im_deliveries SET status = ?, attempts = ?, next_at = ?, error = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        giveUp ? "failed" : "pending",
        attempts,
        new Date(nextAt).toISOString(),
        error.slice(0, 500),
        new Date().toISOString(),
        id,
      );
  }

  /** 暂停时丢弃还没发出的：恢复后不补发暂停期间攒下的旧消息 */
  dropPending(connectionId: string): void {
    this.db
      .prepare(
        "UPDATE im_deliveries SET status = 'dropped', updated_at = ? WHERE connection_id = ? AND status = 'pending'",
      )
      .run(new Date().toISOString(), connectionId);
  }

  deliveryStats(connectionId: string): ImConnection["delivery"] {
    const last = this.db
      .prepare(
        `SELECT status, attempts, error, updated_at FROM im_deliveries
         WHERE connection_id = ? AND (status IN ('sent', 'failed') OR (status = 'pending' AND attempts > 0))
         ORDER BY updated_at DESC, rowid DESC LIMIT 1`,
      )
      .get(connectionId) as
      { status: string; attempts: number; error: string | null; updated_at: string } | undefined;
    const pending = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM im_deliveries WHERE connection_id = ? AND status = 'pending'",
      )
      .get(connectionId) as { count: number };
    const filtered = this.db
      .prepare("SELECT COALESCE(filtered_count, 0) AS count FROM im_connections WHERE id = ?")
      .get(connectionId) as { count: number } | undefined;
    return {
      ...(last
        ? {
            lastAt: last.updated_at,
            lastStatus:
              last.status === "sent" ? "sent" : last.status === "failed" ? "failed" : "retrying",
            ...(last.status !== "sent" && last.error ? { lastError: last.error } : {}),
          }
        : {}),
      pending: pending.count,
      filtered: filtered?.count ?? 0,
    } as ImConnection["delivery"];
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
