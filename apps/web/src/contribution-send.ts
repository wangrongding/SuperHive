import { LIMITS, serverEventSchema } from "@superhive/protocol";
import { createClientMessageId } from "./client-id";
import { t } from "./i18n";

export function sendContribution(
  socket: WebSocket | null | undefined,
  agent: string,
  task: string,
  timeoutMs = 10_000,
): Promise<boolean> {
  if (!socket || socket.readyState !== WebSocket.OPEN)
    return Promise.reject(new Error(t("连接已中断，请连接后再发送任务。")));
  const content = `@${agent} ${task}`;
  if (content.length > LIMITS.maxMessageLength)
    return Promise.reject(new Error(t("贡献任务太长，请缩短反馈内容。")));
  const clientMessageId = createClientMessageId();
  return new Promise((resolve, reject) => {
    const finish = (confirmed: boolean) => {
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      resolve(confirmed);
    };
    const onMessage = (event: MessageEvent) => {
      try {
        const parsed = serverEventSchema.safeParse(JSON.parse(String(event.data)));
        if (
          parsed.success &&
          parsed.data.type === "message.created" &&
          parsed.data.message.clientMessageId === clientMessageId
        )
          finish(true);
      } catch {
        return;
      }
    };
    const onClose = () => finish(false);
    const timer = window.setTimeout(() => finish(false), timeoutMs);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    try {
      socket.send(JSON.stringify({ type: "message.send", clientMessageId, content }));
    } catch {
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      reject(new Error(t("任务发送失败。")));
    }
  });
}
