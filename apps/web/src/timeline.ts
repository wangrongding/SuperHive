import type { ChatMessage } from "@superhive/protocol";
import { getLocale, t } from "./i18n";

export function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

export const messageGroupWindowMs = 5 * 60_000;
export type TimelineEntry = { message: ChatMessage; newDay: boolean; grouped: boolean };

export function buildTimeline(messages: ChatMessage[]): TimelineEntry[] {
  return messages.map((message, index) => {
    const previous = messages[index - 1];
    const newDay =
      !previous ||
      new Date(previous.createdAt).toDateString() !== new Date(message.createdAt).toDateString();
    const grouped =
      !newDay &&
      previous !== undefined &&
      previous.senderId === message.senderId &&
      // 房间提示以成员名义发出，但不是它的发言：前后的消息都不和它合成一组
      previous.kind !== "notice" &&
      message.kind !== "notice" &&
      new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime() <
        messageGroupWindowMs;
    return { message, newDay, grouped };
  });
}

export function dateDividerLabel(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return t("今天");
  if (date.toDateString() === yesterday.toDateString()) return t("昨天");
  return date.toLocaleDateString(getLocale(), { year: "numeric", month: "long", day: "numeric" });
}
