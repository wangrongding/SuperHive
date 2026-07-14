import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ChatMessage, Participant } from "@ai-hive/protocol";
import { z } from "zod";

export type HiveMcpContext = {
  roomId: string;
  username: string;
  readMessages: (
    afterSeq: number,
    limit: number,
  ) => {
    messages: ChatMessage[];
    latestSeq: number;
  };
  listMembers: () => Participant[];
  sendMessage: (input: {
    content: string;
    clientMessageId: string;
    parentMessageId?: string;
    replyToMessageId?: string;
  }) => ChatMessage;
};

function toolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function toolError(error: unknown) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: error instanceof Error ? error.message : String(error),
      },
    ],
  };
}

export function createHiveMcpServer(context: HiveMcpContext): McpServer {
  const server = new McpServer({ name: "ai-hive", version: "0.1.0" });

  server.registerTool(
    "hive_room_read",
    {
      title: "Read Hive room messages",
      description: `读取 Hive 房间 #${context.roomId} 的公共消息。当前身份：${context.username}。`,
      inputSchema: {
        afterSeq: z.number().int().min(0).default(0).describe("只返回 seq 大于此值的消息"),
        limit: z.number().int().min(1).max(200).default(100).describe("最多返回的消息数"),
      },
    },
    async ({ afterSeq, limit }) => {
      try {
        return toolResult(context.readMessages(afterSeq, limit));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "hive_members_list",
    {
      title: "List Hive room members",
      description: `列出 Hive 房间 #${context.roomId} 的人类与 Agent，以及在线状态和 Runtime。`,
      inputSchema: {},
    },
    async () => {
      try {
        return toolResult({ roomId: context.roomId, members: context.listMembers() });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "hive_message_send",
    {
      title: "Send a Hive room message",
      description:
        "以当前已连接 Agent 身份向 Hive 房间发送一条公共消息。可在 content 中 @其他在线 Agent。主动消息省略 parentMessageId；回复或委派时传入触发消息 ID。",
      inputSchema: {
        content: z.string().trim().min(1).max(4000).describe("要发送到公共房间的文本"),
        clientMessageId: z
          .string()
          .min(1)
          .max(100)
          .optional()
          .describe("可选幂等键；重试同一发送时复用"),
        parentMessageId: z.string().uuid().optional().describe("触发本次回复或委派的父消息 ID"),
        replyToMessageId: z.string().uuid().optional().describe("仅用于 UI 回复关系"),
      },
    },
    async ({ content, clientMessageId, parentMessageId, replyToMessageId }) => {
      try {
        const message = context.sendMessage({
          content,
          clientMessageId: clientMessageId ?? randomUUID(),
          ...(parentMessageId ? { parentMessageId } : {}),
          ...(replyToMessageId ? { replyToMessageId } : {}),
        });
        return toolResult({ sent: true, message });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  return server;
}
