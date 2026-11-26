import type {
  ImChannel,
  ImChannelsInfo,
  ImConnection,
  ImDeliveryLevel,
  ImLocale,
  ImScope,
  ImLoginView,
  WireServerText,
} from "@superhive/protocol";
import { localized, t } from "./i18n";
import { localizeServerPayload, serverError, serverString } from "./server-text";

/** 服务端的结构化文案按网页当前语言显示；没有或不认识时用中文原文 */
export function serverMessage(text: WireServerText | undefined, fallback: string): string;
export function serverMessage(
  text: WireServerText | undefined,
  fallback: string | undefined,
): string | undefined;
export function serverMessage(
  text: WireServerText | undefined,
  fallback: string | undefined,
): string | undefined {
  return serverString(text, fallback);
}

async function call<T>(url: string, token: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(url, { ...init, headers });
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new Error(serverError(payload) ?? t("请求失败 ({0})", { 0: response.status }));
  }
  return localizeServerPayload(payload);
}

export const IM_CHANNEL_LABELS: Record<ImChannel, string> = localized(() => ({
  feishu: t("飞书"),
  wechat: t("个人微信"),
}));

export function fetchImChannels(base: string, token: string): Promise<ImChannelsInfo> {
  return call(`${base}/api/im/channels`, token);
}

/** 房主的全部 IM 连接（不分房间） */
export async function listAllImConnections(base: string, token: string): Promise<ImConnection[]> {
  const result = await call<{ connections: ImConnection[] }>(`${base}/api/im/connections`, token);
  return result.connections;
}

/** 改默认房间：直接发的消息进这个房间 */
export function setImRoom(
  base: string,
  token: string,
  id: string,
  roomId: string,
): Promise<ImConnection> {
  return call(`${base}/api/im/connections/${id}/room`, token, {
    method: "POST",
    body: JSON.stringify({ roomId }),
  });
}

export async function listImConnections(
  base: string,
  token: string,
  roomId: string,
): Promise<ImConnection[]> {
  const result = await call<{ connections: ImConnection[] }>(
    `${base}/api/rooms/${encodeURIComponent(roomId)}/im`,
    token,
  );
  return result.connections;
}

export function startImLogin(
  base: string,
  token: string,
  roomId: string,
  input: { channel: ImChannel; ownerName: string; acceptRisk?: boolean; locale?: ImLocale },
): Promise<ImLoginView> {
  return call(`${base}/api/rooms/${encodeURIComponent(roomId)}/im/login`, token, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getImLogin(base: string, token: string, id: string): Promise<ImLoginView> {
  return call(`${base}/api/im/logins/${id}`, token);
}

export function cancelImLogin(base: string, token: string, id: string): Promise<ImLoginView> {
  return call(`${base}/api/im/logins/${id}`, token, { method: "DELETE" });
}

export function submitImLoginCode(
  base: string,
  token: string,
  id: string,
  code: string,
): Promise<ImLoginView> {
  return call(`${base}/api/im/logins/${id}/code`, token, {
    method: "POST",
    body: JSON.stringify({ code }),
  });
}

export function setImConnectionPaused(
  base: string,
  token: string,
  id: string,
  paused: boolean,
): Promise<ImConnection> {
  return call(`${base}/api/im/connections/${id}/${paused ? "pause" : "resume"}`, token, {
    method: "POST",
  });
}

export function removeImConnection(base: string, token: string, id: string): Promise<unknown> {
  return call(`${base}/api/im/connections/${id}`, token, { method: "DELETE" });
}

/** 推送档位：名称与一句说明 */
export const IM_LEVELS: Array<{ level: ImDeliveryLevel; label: string; hint: string }> = localized(
  () => [
    {
      level: "mine",
      label: t("与我相关"),
      hint: t("你的任务的最终结果、问你的问题、提到你的消息、任务失败或等你批准"),
    },
    { level: "im", label: t("IM 任务与提及"), hint: t("只推从 IM 发起的任务和提到你的消息") },
    {
      level: "agents",
      label: t("全部 Agent"),
      hint: t("与你相关的马上推，其余给人看的 Agent 发言每 3 分钟合并；不推 Agent 内部讨论"),
    },
    {
      level: "all",
      label: t("全部消息"),
      hint: t("默认房间的人类消息和 Agent 给人看的回复每 3 分钟合并；其它房间默认只推与你相关的"),
    },
  ],
);

export function setImCrossRoomAll(
  base: string,
  token: string,
  id: string,
  crossRoomAll: boolean,
): Promise<ImConnection> {
  return call(`${base}/api/im/connections/${id}/cross-room-all`, token, {
    method: "POST",
    body: JSON.stringify({ crossRoomAll }),
  });
}

/** 接收哪些房间的推送：所有房间（默认）或只收当前房间；在 IM 里发 /scope 也能切 */
export function setImScope(
  base: string,
  token: string,
  id: string,
  scope: ImScope,
): Promise<ImConnection> {
  return call(`${base}/api/im/connections/${id}/scope`, token, {
    method: "POST",
    body: JSON.stringify({ scope }),
  });
}

/** 机器人在 IM 里说话用的语言；在 IM 里发 /lang 也能切 */
export function setImLocale(
  base: string,
  token: string,
  id: string,
  locale: ImLocale,
): Promise<ImConnection> {
  return call(`${base}/api/im/connections/${id}/locale`, token, {
    method: "POST",
    body: JSON.stringify({ locale }),
  });
}

export function setImDeliveryLevel(
  base: string,
  token: string,
  id: string,
  level: ImDeliveryLevel,
): Promise<ImConnection> {
  return call(`${base}/api/im/connections/${id}/level`, token, {
    method: "POST",
    body: JSON.stringify({ level }),
  });
}
