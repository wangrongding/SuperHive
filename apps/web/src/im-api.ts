import type {
  ImChannel,
  ImChannelsInfo,
  ImConnection,
  ImDeliveryLevel,
  ImLoginView,
} from "@ai-hive/protocol";

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

/** 推送档位：名称与一句说明 */
export const IM_LEVELS: Array<{ level: ImDeliveryLevel; label: string; hint: string }> = [
  {
    level: "mine",
    label: "与我相关",
    hint: "你的任务的最终结果、问你的问题、提到你的消息、任务失败或等你批准",
  },
  { level: "im", label: "IM 任务与提及", hint: "只推从 IM 发起的任务和提到你的消息" },
  {
    level: "agents",
    label: "全部 Agent",
    hint: "与我相关的马上推，其余 Agent 发言每 3 分钟合并成一条",
  },
  { level: "all", label: "全部消息", hint: "房间里所有人和 Agent 的消息逐条推送，不合并" },
];

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
