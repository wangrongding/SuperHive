import type { ChatMessage } from "@superhive/protocol";
import type { StoredConnection } from "./im-store.js";

export type ImMessageContext = {
  ownerId: string | undefined;
  mentionsOwner: boolean;
  ownersTask: boolean;
  fromIm: boolean;
  mentionsAgent: boolean;
  parentSenderType: ChatMessage["senderType"] | undefined;
};

export function decideImDelivery(
  connection: Pick<StoredConnection, "level" | "roomId" | "config">,
  message: ChatMessage,
  context: ImMessageContext,
): "now" | "batch" | "skip" {
  if (message.kind === "schedule") return "skip";
  if (message.senderType === "human" && message.senderId === context.ownerId) return "skip";
  const level =
    connection.level === "all" &&
    message.roomId !== connection.roomId &&
    connection.config.crossRoomAll !== "true"
      ? "mine"
      : connection.level;
  // 房间里的系统提示（例如自动设了主 Agent）只给网页看，不推到 IM
  if (message.kind === "notice") return "skip";
  if (message.kind === "delegation" || message.kind === "receipt") {
    return context.mentionsOwner ? "now" : "skip";
  }
  if (message.kind === "progress") {
    if (!context.ownersTask) return "skip";
    if (level === "im") return context.fromIm ? "now" : "skip";
    return context.mentionsOwner || level === "mine" ? "now" : "batch";
  }
  if (context.mentionsOwner) return "now";
  if (message.senderType !== "agent") return level === "all" ? "batch" : "skip";
  if (message.via || message.kind === "topic") return "skip";
  if (
    message.kind !== "question" &&
    (context.mentionsAgent || context.parentSenderType === "agent")
  ) {
    return "skip";
  }
  if (level === "im") return context.fromIm ? "now" : "skip";
  if (message.kind === "question" && (level === "all" || context.ownersTask)) return "now";
  if (level === "agents" || level === "all") return "batch";
  return "skip";
}
