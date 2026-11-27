import { serverText } from "@superhive/protocol";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Invite } from "@superhive/protocol";
import { HiveError } from "./database.js";

/**
 * 限时邀请与访客会话。
 * - 邀请：房主创建，带统一截止时间（null 为永久）；有效期内谁拿到链接都能用，每人各得一个会话。
 *   邀请到期、被续期或被撤销时，凭它进来的所有人一起生效。
 * - 访客会话：兑换邀请得到的人类会话，或访客为自己带入的 Agent 生成的会话；只能进入一个房间。
 *   Agent 会话没有自己的期限，始终跟随带它进来的访客：访客到期、续期或被移除，它同步生效。
 * 令牌明文只在创建时返回一次，库里只存 SHA-256 摘要。
 */

export type SessionKind = "human" | "agent";

export type AccessSession = {
  id: string;
  roomId: string;
  kind: SessionKind;
  username: string;
  sponsorId?: string;
  inviteId?: string;
  createdAt: string;
  revokedAt?: string;
  /** 房主暂停了这个访客 Agent：期间连不上，恢复后它自己会重连回来 */
  pausedAt?: string;
  /** 会话自身的截止时间；Agent 会话以带它进来的访客为准，见 ResolvedSession */
  expiresAt: string | null;
  allowAgents: boolean;
  /** 能看到 Agent 执行过程（命令、文件路径、中途说的话）；关掉时只看精简状态 */
  showTrace: boolean;
};

export type ResolvedSession = {
  session: AccessSession;
  /** 带入它的访客（仅 Agent 会话） */
  sponsor?: AccessSession;
  /** 实际生效的截止时间 */
  expiresAt: string | null;
  allowAgents: boolean;
  showTrace: boolean;
  /** paused：房主暂时请它下线，恢复后照常可用；与到期、移除不同，不会让 Agent 离开房间 */
  state: "active" | "expired" | "revoked" | "paused";
};

type InviteRow = {
  id: string;
  room_id: string;
  token_hash: string;
  created_at: string;
  expires_at: string | null;
  allow_agents: number;
  show_trace: number;
  revoked_at: string | null;
  uses?: number;
};

type SessionRow = {
  id: string;
  room_id: string;
  token_hash: string;
  kind: SessionKind;
  username: string;
  username_key: string;
  sponsor_id: string | null;
  invite_id: string | null;
  expires_at: string | null;
  allow_agents: number;
  show_trace: number;
  created_at: string;
  revoked_at: string | null;
  paused_at?: string | null;
};

const INVITE_PREFIX = "hvi_";
const SESSION_PREFIX = "hvs_";

export function isGuestToken(token: string): boolean {
  return token.startsWith(SESSION_PREFIX);
}

function newToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function mapInvite(row: InviteRow): Invite {
  return {
    id: row.id,
    roomId: row.room_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    allowAgents: row.allow_agents === 1,
    showTrace: row.show_trace === 1,
    uses: row.uses ?? 0,
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
  };
}

function mapSession(row: SessionRow): AccessSession {
  return {
    id: row.id,
    roomId: row.room_id,
    kind: row.kind,
    username: row.username,
    ...(row.sponsor_id ? { sponsorId: row.sponsor_id } : {}),
    ...(row.invite_id ? { inviteId: row.invite_id } : {}),
    createdAt: row.created_at,
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
    ...(row.paused_at ? { pausedAt: row.paused_at } : {}),
    expiresAt: row.expires_at,
    allowAgents: row.allow_agents === 1,
    showTrace: row.show_trace === 1,
  };
}

export function expiresAtFrom(minutes: number | null, now: number): string | null {
  return minutes === null ? null : new Date(now + minutes * 60_000).toISOString();
}

export class AccessStore {
  constructor(private readonly db: Database.Database) {
    this.migrate = () => {
      const columns = db.pragma("table_info(invites)") as Array<{ name: string }>;
      // 房主要能随时再复制已发出的链接，邀请令牌的明文也保存一份（只返回给房主）
      if (!columns.some((column) => column.name === "token")) {
        db.exec("ALTER TABLE invites ADD COLUMN token TEXT");
      }
      // 访客能否看到 Agent 的执行过程：房主要求默认可以看，已有的邀请和访客也按可以看
      if (!columns.some((column) => column.name === "show_trace")) {
        db.exec("ALTER TABLE invites ADD COLUMN show_trace INTEGER NOT NULL DEFAULT 1");
      }
      const sessionColumns = db.pragma("table_info(access_sessions)") as Array<{ name: string }>;
      if (!sessionColumns.some((column) => column.name === "show_trace")) {
        db.exec("ALTER TABLE access_sessions ADD COLUMN show_trace INTEGER NOT NULL DEFAULT 1");
      }
      if (!sessionColumns.some((column) => column.name === "paused_at")) {
        db.exec("ALTER TABLE access_sessions ADD COLUMN paused_at TEXT");
      }
    };
    db.exec(`
      CREATE TABLE IF NOT EXISTS invites (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        allow_agents INTEGER NOT NULL DEFAULT 0,
        redeemed_at TEXT,
        redeemed_by TEXT,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS invites_room ON invites(room_id, created_at);

      CREATE TABLE IF NOT EXISTS access_sessions (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK(kind IN ('human', 'agent')),
        username TEXT NOT NULL,
        username_key TEXT NOT NULL,
        sponsor_id TEXT,
        invite_id TEXT,
        expires_at TEXT,
        allow_agents INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS access_sessions_member
        ON access_sessions(room_id, username_key, created_at);
      CREATE INDEX IF NOT EXISTS access_sessions_sponsor ON access_sessions(sponsor_id);
    `);
    this.migrate();
  }

  private readonly migrate: () => void;

  /** 还没撤销、没到期的访客会话数：桌面端据此判断以前有没有别的设备连进来过 */
  activeSessionCount(now = Date.now()): number {
    const rows = this.db
      .prepare("SELECT expires_at FROM access_sessions WHERE revoked_at IS NULL")
      .all() as Array<{ expires_at: string | null }>;
    return rows.filter((row) => !row.expires_at || Date.parse(row.expires_at) > now).length;
  }

  createInvite(input: {
    roomId: string;
    expiresAt: string | null;
    allowAgents: boolean;
    showTrace: boolean;
  }): {
    invite: Invite;
    token: string;
  } {
    const token = newToken(INVITE_PREFIX);
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO invites(
          id, room_id, token_hash, token, created_at, expires_at, allow_agents, show_trace
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.roomId,
        digest(token),
        token,
        new Date().toISOString(),
        input.expiresAt,
        input.allowAgents ? 1 : 0,
        input.showTrace ? 1 : 0,
      );
    return { invite: this.getInvite(id)!, token };
  }

  getInvite(id: string): Invite | undefined {
    const row = this.db
      .prepare(
        `SELECT i.*, (SELECT COUNT(*) FROM access_sessions s
           WHERE s.invite_id = i.id AND s.kind = 'human') AS uses
         FROM invites i WHERE i.id = ?`,
      )
      .get(id) as InviteRow | undefined;
    return row ? mapInvite(row) : undefined;
  }

  /** 房间最近的邀请（含已撤销与已过期的，供房主核对与再次复制链接） */
  listInvites(roomId: string, limit = 50): Invite[] {
    const rows = this.db
      .prepare(
        `SELECT i.*, (SELECT COUNT(*) FROM access_sessions s
           WHERE s.invite_id = i.id AND s.kind = 'human') AS uses
         FROM invites i WHERE i.room_id = ? ORDER BY i.created_at DESC LIMIT ?`,
      )
      .all(roomId, limit) as Array<InviteRow & { token: string | null }>;
    return rows.map((row) => ({ ...mapInvite(row), ...(row.token ? { token: row.token } : {}) }));
  }

  /** 撤销邀请：链接失效，凭它进来的人（及其 Agent）一起被移除 */
  revokeInvite(id: string): Invite {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE invites SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?")
        .run(now, id);
      this.db
        .prepare(
          "UPDATE access_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE invite_id = ?",
        )
        .run(now, id);
    })();
    const invite = this.getInvite(id);
    if (!invite) throw new HiveError("INVITE_NOT_FOUND", serverText("error.invite.notFound"));
    return invite;
  }

  /** 续期邀请：链接与凭它进来的所有人一起延到新的截止时间 */
  renewInvite(id: string, expiresAt: string | null): Invite {
    const invite = this.getInvite(id);
    if (!invite) throw new HiveError("INVITE_NOT_FOUND", serverText("error.invite.notFound"));
    if (invite.revokedAt)
      throw new HiveError("INVITE_REVOKED", serverText("error.invite.revokedReinvite"));
    this.db.transaction(() => {
      this.db.prepare("UPDATE invites SET expires_at = ? WHERE id = ?").run(expiresAt, id);
      this.db
        .prepare(
          "UPDATE access_sessions SET expires_at = ? WHERE invite_id = ? AND revoked_at IS NULL",
        )
        .run(expiresAt, id);
    })();
    return this.getInvite(id)!;
  }

  /** 凭某个邀请进来的访客会话 ID，含他们带入的 Agent */
  sessionsOfInvite(id: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT id FROM access_sessions WHERE invite_id = ?
         UNION SELECT a.id FROM access_sessions a
           JOIN access_sessions h ON a.sponsor_id = h.id WHERE h.invite_id = ?`,
      )
      .all(id, id) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  /** 兑换前预览：链接对应的房间与截止时间，不消耗邀请 */
  peekInvite(token: string): Invite | undefined {
    const row = this.db.prepare("SELECT * FROM invites WHERE token_hash = ?").get(digest(token)) as
      InviteRow | undefined;
    return row ? mapInvite(row) : undefined;
  }

  /**
   * 兑换邀请：有效期内不限次数，每人签发一个独立的访客会话，截止时间与邀请一致。
   * isNameTaken 由调用方判断房间里是否已有同名的有效成员。
   */
  redeemInvite(
    token: string,
    username: string,
    now: number,
    isNameTaken: (roomId: string, username: string) => boolean,
  ): { session: AccessSession; token: string; invite: Invite } {
    return this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT * FROM invites WHERE token_hash = ?")
        .get(digest(token)) as InviteRow | undefined;
      if (!row) throw new HiveError("INVITE_INVALID", serverText("error.invite.invalid"));
      if (row.revoked_at) throw new HiveError("INVITE_REVOKED", serverText("error.invite.revoked"));
      if (row.expires_at && Date.parse(row.expires_at) <= now) {
        throw new HiveError("INVITE_EXPIRED", serverText("error.invite.expired"));
      }
      if (isNameTaken(row.room_id, username)) {
        throw new HiveError("USERNAME_TAKEN", serverText("error.name.takenInRoom"));
      }
      const created = this.insertSession({
        roomId: row.room_id,
        kind: "human",
        username,
        inviteId: row.id,
        expiresAt: row.expires_at,
        allowAgents: row.allow_agents === 1,
        showTrace: row.show_trace === 1,
      });
      return { ...created, invite: this.getInvite(row.id)! };
    })();
  }

  /** 访客为自己带入的 Agent 生成会话：同一房间，期限与权限都跟随访客 */
  createAgentSession(
    sponsor: AccessSession,
    username: string,
  ): { session: AccessSession; token: string } {
    return this.insertSession({
      roomId: sponsor.roomId,
      kind: "agent",
      username,
      sponsorId: sponsor.id,
      expiresAt: null,
      allowAgents: sponsor.allowAgents,
      showTrace: sponsor.showTrace,
    });
  }

  private insertSession(input: {
    roomId: string;
    kind: SessionKind;
    username: string;
    sponsorId?: string;
    inviteId?: string;
    expiresAt: string | null;
    allowAgents: boolean;
    showTrace: boolean;
  }): { session: AccessSession; token: string } {
    const token = newToken(SESSION_PREFIX);
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO access_sessions(
          id, room_id, token_hash, kind, username, username_key, sponsor_id, invite_id,
          expires_at, allow_agents, show_trace, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.roomId,
        digest(token),
        input.kind,
        input.username,
        input.username.toLocaleLowerCase(),
        input.sponsorId ?? null,
        input.inviteId ?? null,
        input.expiresAt,
        input.allowAgents ? 1 : 0,
        input.showTrace ? 1 : 0,
        new Date().toISOString(),
      );
    return { session: this.getSession(id)!, token };
  }

  getSession(id: string): AccessSession | undefined {
    const row = this.db.prepare("SELECT * FROM access_sessions WHERE id = ?").get(id) as
      SessionRow | undefined;
    return row ? mapSession(row) : undefined;
  }

  /** 解析会话的实际状态；Agent 会话的期限与撤销跟随带它进来的访客 */
  resolve(session: AccessSession, now: number): ResolvedSession {
    const sponsor = session.sponsorId ? this.getSession(session.sponsorId) : undefined;
    const owner = sponsor ?? session;
    const expiresAt = owner.expiresAt;
    const revoked = Boolean(
      session.revokedAt || (session.sponsorId && (!sponsor || sponsor.revokedAt)),
    );
    const state = revoked
      ? "revoked"
      : expiresAt && Date.parse(expiresAt) <= now
        ? "expired"
        : session.pausedAt
          ? "paused"
          : "active";
    return {
      session,
      ...(sponsor ? { sponsor } : {}),
      expiresAt,
      allowAgents: owner.allowAgents,
      showTrace: owner.showTrace,
      state,
    };
  }

  resolveToken(token: string, now: number): ResolvedSession | undefined {
    const row = this.db
      .prepare("SELECT * FROM access_sessions WHERE token_hash = ?")
      .get(digest(token)) as SessionRow | undefined;
    return row ? this.resolve(mapSession(row), now) : undefined;
  }

  /** 房间里某个名字最近的访客会话（成员列表据此显示剩余时间） */
  latestSessionFor(roomId: string, username: string): AccessSession | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM access_sessions WHERE room_id = ? AND username_key = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(roomId, username.toLocaleLowerCase()) as SessionRow | undefined;
    return row ? mapSession(row) : undefined;
  }

  /** 访客及其带入的 Agent 的会话 ID（撤销或到期时一起断开） */
  familyOf(sessionId: string): string[] {
    const rows = this.db
      .prepare("SELECT id FROM access_sessions WHERE id = ? OR sponsor_id = ?")
      .all(sessionId, sessionId) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  /** 续期只改访客本人；其 Agent 自动跟随 */
  renew(sessionId: string, expiresAt: string | null): AccessSession {
    const session = this.getSession(sessionId);
    if (!session) throw new HiveError("SESSION_NOT_FOUND", serverText("error.guest.notFound"));
    if (session.kind !== "human") {
      throw new HiveError("SESSION_NOT_RENEWABLE", serverText("error.guest.agentNotRenewable"));
    }
    if (session.revokedAt)
      throw new HiveError("SESSION_REVOKED", serverText("error.guest.removed"));
    this.db
      .prepare("UPDATE access_sessions SET expires_at = ? WHERE id = ?")
      .run(expiresAt, sessionId);
    return this.getSession(sessionId)!;
  }

  revoke(sessionId: string): AccessSession {
    this.db
      .prepare("UPDATE access_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?")
      .run(new Date().toISOString(), sessionId);
    const session = this.getSession(sessionId);
    if (!session) throw new HiveError("SESSION_NOT_FOUND", serverText("error.guest.notFound"));
    return session;
  }

  /** 暂停或恢复访客带入的 Agent；只有 Agent 会话能暂停（访客本人用续期和移除管理） */
  setPaused(sessionId: string, paused: boolean): AccessSession {
    const session = this.getSession(sessionId);
    if (!session) throw new HiveError("SESSION_NOT_FOUND", serverText("error.guest.notFound"));
    if (session.kind !== "agent") {
      throw new HiveError("SESSION_NOT_PAUSABLE", serverText("error.guest.notPausable"));
    }
    if (session.revokedAt)
      throw new HiveError("SESSION_REVOKED", serverText("error.guest.removed"));
    this.db
      .prepare("UPDATE access_sessions SET paused_at = ? WHERE id = ?")
      .run(paused ? (session.pausedAt ?? new Date().toISOString()) : null, sessionId);
    return this.getSession(sessionId)!;
  }
}
