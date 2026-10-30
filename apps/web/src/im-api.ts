import type { ImChannel, ImChannelsInfo, ImConnection, ImLoginView } from "@ai-hive/protocol";

async function call<T>(url: string, token: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(url, { ...init, headers });
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `请求失败 (${response.status})`);
  return payload;
}

export const IM_CHANNEL_LABELS: Record<ImChannel, string> = {
  feishu: "飞书",
  wechat: "个人微信",
};

export function fetchImChannels(base: string, token: string): Promise<ImChannelsInfo> {
  return call(`${base}/api/im/channels`, token);
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
  input: { channel: ImChannel; ownerName: string; acceptRisk?: boolean },
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
