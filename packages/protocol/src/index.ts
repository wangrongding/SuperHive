import { z } from "zod";

export const participantTypeSchema = z.enum(["human", "agent"]);
export const participantStatusSchema = z.enum(["online", "offline", "busy"]);
export const agentProviderSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9_.-]+$/);

export const participantSchema = z.object({
  id: z.string().uuid(),
  roomId: z.string().min(1).max(64),
  username: z.string().min(1).max(32),
  type: participantTypeSchema,
  status: participantStatusSchema,
  persona: z.string().max(500).optional(),
  provider: agentProviderSchema.optional(),
  joinedAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
});

export const chatMessageSchema = z.object({
  id: z.string().uuid(),
  roomId: z.string().min(1).max(64),
  seq: z.number().int().positive(),
  senderId: z.string().uuid(),
  senderName: z.string(),
  senderType: participantTypeSchema,
  content: z.string().min(1).max(4000),
  mentions: z.array(z.string()),
  replyToMessageId: z.string().uuid().optional(),
  traceId: z.string().uuid(),
  parentMessageId: z.string().uuid().optional(),
  hopCount: z.number().int().min(0),
  clientMessageId: z.string().min(1).max(100).optional(),
  createdAt: z.string().datetime(),
});

export const participantJoinEventSchema = z.object({
  type: z.literal("participant.join"),
  username: z.string().trim().min(1).max(32),
  participantType: participantTypeSchema,
  roomId: z.string().trim().min(1).max(64).default("general"),
  token: z.string().min(1).max(256),
  persona: z.string().trim().max(500).optional(),
  provider: agentProviderSchema.optional(),
});

export const messageSendEventSchema = z.object({
  type: z.literal("message.send"),
  clientMessageId: z.string().min(1).max(100),
  content: z.string().trim().min(1).max(4000),
  replyToMessageId: z.string().uuid().optional(),
  parentMessageId: z.string().uuid().optional(),
});

export const heartbeatEventSchema = z.object({ type: z.literal("presence.heartbeat") });
export const typingEventSchema = z.object({
  type: z.literal("agent.typing"),
  active: z.boolean(),
});
export const messageAckEventSchema = z.object({
  type: z.literal("message.ack"),
  seq: z.number().int().nonnegative(),
});

export const clientEventSchema = z.discriminatedUnion("type", [
  participantJoinEventSchema,
  messageSendEventSchema,
  heartbeatEventSchema,
  typingEventSchema,
  messageAckEventSchema,
]);

export const roomSnapshotEventSchema = z.object({
  type: z.literal("room.snapshot"),
  self: participantSchema,
  participants: z.array(participantSchema),
  messages: z.array(chatMessageSchema),
  latestSeq: z.number().int().nonnegative(),
});
export const messageCreatedEventSchema = z.object({
  type: z.literal("message.created"),
  message: chatMessageSchema,
});
export const agentMentionedEventSchema = z.object({
  type: z.literal("agent.mentioned"),
  message: chatMessageSchema,
  latestSeq: z.number().int().nonnegative(),
});
export const presenceChangedEventSchema = z.object({
  type: z.literal("presence.changed"),
  participant: participantSchema,
});
export const serverErrorEventSchema = z.object({
  type: z.literal("error"),
  code: z.string(),
  message: z.string(),
});

export const serverEventSchema = z.discriminatedUnion("type", [
  roomSnapshotEventSchema,
  messageCreatedEventSchema,
  agentMentionedEventSchema,
  presenceChangedEventSchema,
  serverErrorEventSchema,
]);

export const messagesResponseSchema = z.object({
  messages: z.array(chatMessageSchema),
  latestSeq: z.number().int().nonnegative(),
});

export const participantsResponseSchema = z.object({
  participants: z.array(participantSchema),
});

export const metaResponseSchema = z.object({
  name: z.string(),
  roomId: z.string(),
  httpUrl: z.string().url(),
  wsUrl: z.string().url(),
  mcpUrl: z.string().url(),
  joinToken: z.string(),
  agentCommand: z.string(),
});

export type ParticipantType = z.infer<typeof participantTypeSchema>;
export type ParticipantStatus = z.infer<typeof participantStatusSchema>;
export type AgentProvider = z.infer<typeof agentProviderSchema>;
export type Participant = z.infer<typeof participantSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ClientEvent = z.infer<typeof clientEventSchema>;
export type ServerEvent = z.infer<typeof serverEventSchema>;
export type MessagesResponse = z.infer<typeof messagesResponseSchema>;
export type MetaResponse = z.infer<typeof metaResponseSchema>;

const mentionPattern = /@([\p{L}\p{N}_.-]{1,32})/gu;

export function parseMentions(content: string): string[] {
  const mentions = new Map<string, string>();
  for (const match of content.matchAll(mentionPattern)) {
    const username = match[1];
    if (username && !mentions.has(username.toLocaleLowerCase())) {
      mentions.set(username.toLocaleLowerCase(), username);
    }
  }
  return [...mentions.values()];
}

export function isMentioned(content: string, username: string): boolean {
  const normalized = username.toLocaleLowerCase();
  return parseMentions(content).some((mention) => mention.toLocaleLowerCase() === normalized);
}

export const LIMITS = {
  maxHopCount: 4,
  maxAgentMessagesPerTrace: 12,
  maxAgentRepliesPerMinute: 6,
  maxMessageLength: 4000,
} as const;
