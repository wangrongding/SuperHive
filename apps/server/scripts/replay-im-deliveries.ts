import Database from "better-sqlite3";
import type { ChatMessage, ImDeliveryLevel } from "@superhive/protocol";
import { decideImDelivery } from "../src/im/im-policy.js";
import { FEISHU_CARD_BODY_LIMIT } from "../src/im/feishu-card.js";

const [databasePath, label, startTime, endTime = new Date().toISOString()] = process.argv.slice(2);
if (!databasePath || !label || !startTime) {
  throw new Error("Usage: tsx scripts/replay-im-deliveries.ts DATABASE LABEL START_ISO [END_ISO]");
}
const start = new Date(startTime).toISOString();
const end = new Date(endTime).toISOString();
const db = new Database(databasePath, { readonly: true, fileMustExist: true });

type Connection = { id: string; roomId: string; ownerName: string; level: ImDeliveryLevel };
type Delivery = {
  id: string;
  eventKey: string;
  messageId: string | null;
  chatId: string;
  externalId: string | null;
  createdAt: string;
  textLength: number;
};
type Invocation = {
  id: string;
  requesterId: string;
  parentId: string | null;
};

const messageQuery = db.prepare(`
  SELECT id, room_id AS roomId, seq, sender_id AS senderId, sender_name AS senderName,
    sender_type AS senderType, '' AS content, mentions, trace_id AS traceId, hop_count AS hopCount,
    created_at AS createdAt, kind, parent_message_id AS parentMessageId
  FROM messages WHERE id = ?
`);
const invocationQuery = db.prepare(`
  SELECT id, requester_id AS requesterId, parent_invocation_id AS parentId
  FROM invocations WHERE message_id = ? AND agent_id = ?
`);
const parentQuery = db.prepare(`
  SELECT id, requester_id AS requesterId, parent_invocation_id AS parentId
  FROM invocations WHERE id = ?
`);
const ownerQuery = db.prepare(`
  SELECT id FROM participants WHERE room_id = ? AND username_key = ? AND type = 'human'
`);
const agentQuery = db.prepare(`
  SELECT id FROM participants WHERE room_id = ? AND username_key = ? AND type = 'agent'
`);
const finalQuery = db.prepare(`
  SELECT id FROM invocations WHERE reply_message_id = ? AND requester_id = ?
`);
const linkQuery = db.prepare(`
  SELECT message_id FROM im_links WHERE message_id = ? AND connection_id = ? AND direction = 'in'
`);

function getMessage(id: string | null): ChatMessage | undefined {
  if (!id) return undefined;
  const row = messageQuery.get(id) as
    (Omit<ChatMessage, "mentions"> & { mentions: string }) | undefined;
  return row ? { ...row, mentions: JSON.parse(row.mentions) as string[] } : undefined;
}

function rootRequester(invocation: Invocation | undefined): string | undefined {
  const seen = new Set<string>();
  while (invocation?.parentId && !seen.has(invocation.id)) {
    seen.add(invocation.id);
    const parent = parentQuery.get(invocation.parentId) as Invocation | undefined;
    if (!parent) break;
    invocation = parent;
  }
  return invocation?.requesterId;
}

function fromIm(message: ChatMessage, connectionId: string): boolean {
  let current: ChatMessage | undefined = message;
  for (let depth = 0; current && depth < 64; depth += 1) {
    if (linkQuery.get(current.id, connectionId)) return true;
    current = getMessage(current.parentMessageId ?? null);
  }
  return false;
}

try {
  const connections = db
    .prepare(
      `
    SELECT id, room_id AS roomId, owner_name AS ownerName, level
    FROM im_connections WHERE label = ?
  `,
    )
    .all(label) as Connection[];
  const result = connections.map((connection) => {
    const deliveries = db
      .prepare(
        `
      SELECT id, event_key AS eventKey, message_id AS messageId, chat_id AS chatId,
        external_id AS externalId, created_at AS createdAt, length(text) AS textLength
      FROM im_deliveries WHERE connection_id = ? AND status = 'sent'
        AND created_at >= ? AND created_at < ? ORDER BY created_at, id
    `,
      )
      .all(connection.id, start, end) as Delivery[];
    const replay = (crossRoomAll: boolean) => {
      let immediate = 0;
      let retainedOrdinary = 0;
      let filtered = 0;
      const filteredKinds: Record<string, number> = {};
      const windows = new Map<string, { start: number; length: number; cards: number }>();
      for (const delivery of deliveries) {
        const message = getMessage(delivery.messageId);
        if (!delivery.eventKey.startsWith("msg:") || !message) {
          immediate += 1;
          continue;
        }
        const owner = ownerQuery.get(message.roomId, connection.ownerName.toLowerCase()) as
          { id: string } | undefined;
        const invocation = message.parentMessageId
          ? (invocationQuery.get(message.parentMessageId, message.senderId) as
              Invocation | undefined)
          : undefined;
        const context = {
          ownerId: owner?.id,
          mentionsOwner: message.mentions.some(
            (name) => name.toLowerCase() === connection.ownerName.toLowerCase(),
          ),
          ownersTask: Boolean(owner && invocation && rootRequester(invocation) === owner.id),
          fromIm: fromIm(message, connection.id),
          mentionsAgent: message.mentions.some((name) =>
            Boolean(agentQuery.get(message.roomId, name.toLowerCase())),
          ),
          parentSenderType: getMessage(message.parentMessageId ?? null)?.senderType,
        };
        const finalResult = owner && finalQuery.get(message.id, owner.id);
        const decision = finalResult
          ? "now"
          : decideImDelivery(
              { ...connection, config: { crossRoomAll: String(crossRoomAll) } },
              message,
              context,
            );
        if (decision === "skip") {
          filtered += 1;
          const kind = message.kind ?? (message.senderType === "human" ? "human" : "agent_reply");
          filteredKinds[kind] = (filteredKinds[kind] ?? 0) + 1;
        } else if (decision === "now") {
          immediate += 1;
        } else {
          retainedOrdinary += 1;
          const time = Date.parse(delivery.createdAt);
          const key = `${delivery.chatId}:${message.roomId}`;
          const window = windows.get(key);
          if (!window) {
            windows.set(key, { start: time, length: delivery.textLength + 9, cards: 1 });
          } else if (time - window.start >= 3 * 60_000) {
            window.cards += 1;
            window.start = time;
            window.length = delivery.textLength + 9;
          } else if (window.length + delivery.textLength + 9 > FEISHU_CARD_BODY_LIMIT) {
            window.cards += 1;
            window.length = delivery.textLength + 9;
          } else {
            window.length += delivery.textLength + 9;
          }
        }
      }
      const digests = [...windows.values()].reduce((total, window) => total + window.cards, 0);
      return {
        estimatedPushes: immediate + digests,
        immediate,
        digests,
        retainedOrdinary,
        filtered,
        filteredKinds,
      };
    };
    return {
      level: connection.level,
      originalDeliveries: deliveries.length,
      originalPlatformMessages: new Set(
        deliveries.map((delivery) => delivery.externalId ?? delivery.id),
      ).size,
      defaultCrossRoomRelevant: replay(false),
      explicitCrossRoomAll: replay(true),
    };
  });
  console.log(JSON.stringify({ start, end, result }, null, 2));
} finally {
  db.close();
}
