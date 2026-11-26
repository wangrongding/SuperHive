import { LIMITS, type ChatMessage, type TodoInput, type TodoUpdate } from "@superhive/protocol";
import { createClientMessageId } from "./client-id";
import { plainPreview } from "./activity";
import { getLocale, t } from "./i18n";
import { serverError } from "./server-text";

export function todoFromMessage(message: ChatMessage): TodoInput {
  return {
    title:
      plainPreview(message.content).slice(0, LIMITS.maxTodoTitleLength).trim() ||
      t("消息 #{0}", { 0: message.seq }),
    notes: "",
    assigneeId: null,
    sourceMessageId: message.id,
  };
}

export function todoApi(
  base: string,
  authToken: string | undefined,
  roomId: string,
  username: string,
) {
  const root = `${base}/api/rooms/${encodeURIComponent(roomId)}/todos`;
  async function request(method: string, suffix: string, body?: unknown) {
    const response = await fetch(`${root}${suffix}`, {
      method,
      headers: {
        Authorization: `Bearer ${authToken}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload: unknown = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(serverError(payload) ?? t("待办操作失败，请重试。"));
  }
  return {
    add: (input: TodoInput) => request("POST", "", { ...input, username }),
    update: (id: string, input: TodoUpdate) =>
      request("PATCH", `/${encodeURIComponent(id)}`, input),
    remove: (id: string) => request("DELETE", `/${encodeURIComponent(id)}`),
    handoff: (id: string, agentId: string, clientMessageId: string = createClientMessageId()) =>
      request("POST", `/${encodeURIComponent(id)}/handoff`, {
        username,
        agentId,
        clientMessageId,
        locale: getLocale(),
      }),
  };
}
