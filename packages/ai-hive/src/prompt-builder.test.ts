import { describe, expect, it } from "vitest";
import type { ChatMessage } from "./hive-protocol.js";
import { buildMentionPrompt } from "./prompt-builder.js";

describe("buildMentionPrompt", () => {
  it("includes stable message IDs for hive_message_send parentMessageId", () => {
    const mention: ChatMessage = {
      id: "00000000-0000-4000-8000-000000000001",
      roomId: "general",
      seq: 7,
      senderId: "00000000-0000-4000-8000-000000000002",
      senderName: "Alice",
      senderType: "human",
      content: "@agent 请委派",
      mentions: ["agent"],
      traceId: "00000000-0000-4000-8000-000000000003",
      hopCount: 0,
      createdAt: new Date().toISOString(),
    };

    const prompt = buildMentionPrompt({ messages: [mention], mention });
    expect(prompt).toContain("#7 id=00000000-0000-4000-8000-000000000001");
  });
});
