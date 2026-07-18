export type ParticipantType = "human" | "agent";
export type ParticipantStatus = "online" | "offline" | "busy";

export type Participant = {
  id: string;
  roomId: string;
  username: string;
  type: ParticipantType;
  status: ParticipantStatus;
  persona?: string;
  provider?: string;
  joinedAt: string;
  lastSeenAt: string;
};

export type ChatMessage = {
  id: string;
  roomId: string;
  seq: number;
  senderId: string;
  senderName: string;
  senderType: ParticipantType;
  content: string;
  mentions: string[];
  replyToMessageId?: string;
  traceId: string;
  parentMessageId?: string;
  hopCount: number;
  clientMessageId?: string;
  createdAt: string;
};

export type MessagesResponse = {
  messages: ChatMessage[];
  latestSeq: number;
};

export type RoomSummary = {
  id: string;
  name: string;
  createdAt: string;
  createdBy?: string;
  archivedAt?: string;
  onlineCount: number;
  latestSeq: number;
};

export type ServerEvent =
  | {
      type: "room.snapshot";
      self: Participant;
      participants: Participant[];
      messages: ChatMessage[];
      latestSeq: number;
    }
  | { type: "message.created"; message: ChatMessage }
  | { type: "agent.mentioned"; message: ChatMessage; latestSeq: number }
  | { type: "presence.changed"; participant: Participant }
  | { type: "rooms.changed"; room: RoomSummary }
  | { type: "error"; code: string; message: string };

const mentionPattern = /@([\p{L}\p{N}_.-]{1,32})/gu;

export function isMentioned(content: string, username: string): boolean {
  const normalized = username.toLocaleLowerCase();
  return [...content.matchAll(mentionPattern)].some(
    (match) => match[1]?.toLocaleLowerCase() === normalized,
  );
}
