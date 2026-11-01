import type { AccessResponse, Invite } from "@superhive/protocol";
import { localized, t } from "./i18n";

/** 访客会话令牌：兑换邀请后保存在本机，之后刷新、重连都靠它 */
export const GUEST_TOKEN_KEY = "superhive.guest-token";
/** 远程房主手动填入的共享接入令牌（本机房主不需要） */
export const OWNER_TOKEN_KEY = "superhive.owner-token";

/** 邀请链接形如 `#build?invite=hvi_xxx`；返回房间与邀请令牌 */
export function parseInviteHash(hash: string): { roomId?: string; token?: string } {
  const value = hash.replace(/^#/, "");
  const [room, query = ""] = value.split("?", 2);
  const token = new URLSearchParams(query).get("invite") ?? undefined;
  return { ...(room ? { roomId: room } : {}), ...(token ? { token } : {}) };
}

/** 邀请时长选项（分钟）；null 为永久 */
export const DURATION_PRESETS: Array<{ label: string; minutes: number | null }> = localized(() => [
  { label: t("1 小时"), minutes: 60 },
  { label: t("12 小时"), minutes: 12 * 60 },
  { label: t("24 小时"), minutes: 24 * 60 },
  { label: t("永久"), minutes: null },
]);

/** 剩余时间的简短描述；null 为永久 */
export function formatRemaining(expiresAt: string | null, now: number): string {
  if (expiresAt === null) return t("永久");
  const ms = Date.parse(expiresAt) - now;
  if (ms <= 0) return t("已到期");
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return t("剩 {0} 分钟", { 0: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    const rest = minutes % 60;
    return rest ? t("剩 {0} 小时 {1} 分", { 0: hours, 1: rest }) : t("剩 {0} 小时", { 0: hours });
  }
  return t("剩 {0} 天", { 0: Math.floor(hours / 24) });
}

/** 不到 1 小时就提醒续期 */
export function expiresSoon(expiresAt: string | null, now: number): boolean {
  return expiresAt !== null && Date.parse(expiresAt) - now < 60 * 60_000;
}

export function formatDeadline(expiresAt: string | null): string {
  if (expiresAt === null) return t("永久有效");
  return t("{0} 到期", {
    0: new Date(expiresAt).toLocaleString("zh-CN", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }),
  });
}

async function call<T>(
  url: string,
  init: RequestInit & { token?: string | undefined } = {},
): Promise<T> {
  const { token, ...rest } = init;
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (rest.body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(url, { ...rest, headers });
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? t("请求失败 ({0})", { 0: response.status }));
  return payload;
}

export function fetchAccess(base: string, token?: string): Promise<AccessResponse> {
  return call(`${base}/api/access`, { token });
}

export type InvitePreview = {
  roomId: string;
  expiresAt: string | null;
  state: "valid" | "expired" | "revoked";
};

export function previewInvite(base: string, token: string): Promise<InvitePreview> {
  return call(`${base}/api/invites/preview?token=${encodeURIComponent(token)}`);
}

export type GuestSession = Extract<AccessResponse, { role: "guest" }> & { token: string };

export function redeemInvite(base: string, token: string, username: string): Promise<GuestSession> {
  return call(`${base}/api/invites/redeem`, {
    method: "POST",
    body: JSON.stringify({ token, username }),
  });
}

export function createInvite(
  base: string,
  adminToken: string,
  roomId: string,
  expiresInMinutes: number | null,
  allowAgents: boolean,
): Promise<{ invite: Invite; token: string }> {
  return call(`${base}/api/rooms/${encodeURIComponent(roomId)}/invites`, {
    method: "POST",
    token: adminToken,
    body: JSON.stringify({ expiresInMinutes, allowAgents }),
  });
}

export function listInvites(base: string, adminToken: string, roomId: string) {
  return call<{ invites: Invite[] }>(`${base}/api/rooms/${encodeURIComponent(roomId)}/invites`, {
    token: adminToken,
  });
}

export function renewInvite(
  base: string,
  adminToken: string,
  inviteId: string,
  expiresInMinutes: number | null,
) {
  return call<{ invite: Invite }>(`${base}/api/invites/${inviteId}/renew`, {
    method: "POST",
    token: adminToken,
    body: JSON.stringify({ expiresInMinutes }),
  });
}

export function revokeInvite(base: string, adminToken: string, inviteId: string) {
  return call<{ invite: Invite }>(`${base}/api/invites/${inviteId}`, {
    method: "DELETE",
    token: adminToken,
  });
}

export function renewGuest(
  base: string,
  adminToken: string,
  sessionId: string,
  expiresInMinutes: number | null,
) {
  return call(`${base}/api/guests/${sessionId}/renew`, {
    method: "POST",
    token: adminToken,
    body: JSON.stringify({ expiresInMinutes }),
  });
}

export function removeGuest(base: string, adminToken: string, sessionId: string) {
  return call(`${base}/api/guests/${sessionId}`, { method: "DELETE", token: adminToken });
}

export function createGuestAgent(base: string, guestToken: string, username: string) {
  return call<{ command: string; expiresAt: string | null; username: string }>(
    `${base}/api/guest-agents`,
    { method: "POST", token: guestToken, body: JSON.stringify({ username }) },
  );
}
