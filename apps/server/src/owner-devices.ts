import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";

/**
 * 房主在其他设备上的登录：每台设备一个独立的房主会话（hod_ 开头的令牌），
 * 可以列出、单独退出，不需要把总令牌（join token）交出去。
 * 登录票两种：
 * - 配对票（本机网页上的二维码 / 链接）：5 分钟有效、只能用一次，存在库里；
 * - 飞书票（卡片上的「在网页查看」）：24 小时有效（过期后在飞书里发 /web 取新的）、可重复使用，用服务端密钥签名，不入库，
 *   绑定发出它的 IM 连接，连接断开后失效。
 */

export const OWNER_DEVICE_PREFIX = "hod_";
const PAIR_PREFIX = "hop_";
const IM_PREFIX = "hoi_";
export const PAIR_TICKET_TTL_MS = 5 * 60_000;
export const IM_TICKET_TTL_MS = 24 * 60 * 60_000;
/** 最近活跃时间最多每分钟写一次库 */
const TOUCH_INTERVAL_MS = 60_000;

export type OwnerDevice = {
  id: string;
  name: string;
  /** 怎么登录的：pair=本机扫码；im=飞书卡片 */
  source: "pair" | "im";
  createdAt: string;
  lastSeenAt: string;
};

type DeviceRow = {
  id: string;
  token_hash: string;
  name: string;
  source: "pair" | "im";
  created_at: string;
  last_seen_at: string;
  revoked_at: string | null;
};

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const token = (prefix: string) => `${prefix}${randomBytes(32).toString("base64url")}`;

export function isOwnerDeviceToken(value: string | undefined): value is string {
  return Boolean(value?.startsWith(OWNER_DEVICE_PREFIX));
}

export class OwnerDevices {
  private readonly touched = new Map<string, number>();
  private readonly secret: Buffer;

  constructor(
    private readonly db: Database.Database,
    options: { secret: Buffer; now?: () => number },
  ) {
    this.secret = options.secret;
    this.now = options.now ?? Date.now;
    db.exec(`
      CREATE TABLE IF NOT EXISTS owner_devices (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS owner_pair_tickets (
        token_hash TEXT PRIMARY KEY,
        expires_at TEXT NOT NULL,
        used_at TEXT
      );
    `);
  }

  private readonly now: () => number;

  private iso(offset = 0): string {
    return new Date(this.now() + offset).toISOString();
  }

  /** 本机网页上生成配对票：二维码 / 链接里带它 */
  createPairTicket(): { ticket: string; expiresAt: string } {
    const ticket = token(PAIR_PREFIX);
    const expiresAt = this.iso(PAIR_TICKET_TTL_MS);
    this.db.prepare("DELETE FROM owner_pair_tickets WHERE expires_at < ?").run(this.iso());
    this.db
      .prepare("INSERT INTO owner_pair_tickets(token_hash, expires_at) VALUES(?, ?)")
      .run(hash(ticket), expiresAt);
    return { ticket, expiresAt };
  }

  /** 飞书卡片按钮上的登录票：签名里带连接 ID 和到期时间 */
  createImTicket(connectionId: string): string {
    const expires = this.now() + IM_TICKET_TTL_MS;
    const payload = `${connectionId}.${expires}`;
    return `${IM_PREFIX}${Buffer.from(payload).toString("base64url")}.${this.sign(payload)}`;
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.secret).update(`im-login:${payload}`).digest("base64url");
  }

  /**
   * 用登录票换一个设备会话。imConnectionValid 判断飞书票所属的连接是否还在。
   * 返回 undefined 表示票无效、过期或已用过。
   */
  redeem(
    ticket: string,
    deviceName: string,
    imConnectionValid: (connectionId: string) => boolean,
  ): { token: string; device: OwnerDevice } | undefined {
    let source: OwnerDevice["source"];
    if (ticket.startsWith(PAIR_PREFIX)) {
      const used = this.db
        .prepare(
          "UPDATE owner_pair_tickets SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?",
        )
        .run(this.iso(), hash(ticket), this.iso());
      if (used.changes !== 1) return undefined;
      source = "pair";
    } else if (ticket.startsWith(IM_PREFIX)) {
      const [encoded, signature] = ticket.slice(IM_PREFIX.length).split(".");
      if (!encoded || !signature) return undefined;
      const payload = Buffer.from(encoded, "base64url").toString();
      const expected = Buffer.from(this.sign(payload));
      const given = Buffer.from(signature);
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
      const [connectionId, expires] = payload.split(".");
      if (!connectionId || !(Number(expires) > this.now())) return undefined;
      if (!imConnectionValid(connectionId)) return undefined;
      source = "im";
    } else {
      return undefined;
    }
    const secret = token(OWNER_DEVICE_PREFIX);
    const id = randomUUID();
    const now = this.iso();
    const name = deviceName.trim().slice(0, 64) || "未命名设备";
    this.db
      .prepare(
        "INSERT INTO owner_devices(id, token_hash, name, source, created_at, last_seen_at) VALUES(?, ?, ?, ?, ?, ?)",
      )
      .run(id, hash(secret), name, source, now, now);
    return { token: secret, device: this.get(id)! };
  }

  /** 校验设备令牌，有效时返回设备 ID（并按需刷新最近活跃时间） */
  resolve(value: string): string | undefined {
    if (!isOwnerDeviceToken(value)) return undefined;
    const row = this.db
      .prepare("SELECT id FROM owner_devices WHERE token_hash = ? AND revoked_at IS NULL")
      .get(hash(value)) as { id: string } | undefined;
    if (!row) return undefined;
    const last = this.touched.get(row.id) ?? 0;
    if (this.now() - last > TOUCH_INTERVAL_MS) {
      this.touched.set(row.id, this.now());
      this.db
        .prepare("UPDATE owner_devices SET last_seen_at = ? WHERE id = ?")
        .run(this.iso(), row.id);
    }
    return row.id;
  }

  private get(id: string): OwnerDevice | undefined {
    const row = this.db.prepare("SELECT * FROM owner_devices WHERE id = ?").get(id) as
      DeviceRow | undefined;
    return row ? map(row) : undefined;
  }

  list(): OwnerDevice[] {
    return (
      this.db
        .prepare("SELECT * FROM owner_devices WHERE revoked_at IS NULL ORDER BY last_seen_at DESC")
        .all() as DeviceRow[]
    ).map(map);
  }

  revoke(id: string): boolean {
    return (
      this.db
        .prepare("UPDATE owner_devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
        .run(this.iso(), id).changes === 1
    );
  }
}

function map(row: DeviceRow): OwnerDevice {
  return {
    id: row.id,
    name: row.name,
    source: row.source,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}
