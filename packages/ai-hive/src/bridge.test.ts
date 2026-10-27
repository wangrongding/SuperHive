import { describe, expect, it } from "vitest";
import type { ChatMessage } from "./hive-protocol.js";
import { hasAgentMessage, shouldProcessMention } from "./bridge.js";

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    roomId: "general",
    seq: 1,
    senderId: "00000000-0000-4000-8000-000000000002",
    senderName: "Alice",
    senderType: "human",
    content: "@agent-a hello",
    mentions: ["agent-a"],
    traceId: "00000000-0000-4000-8000-000000000003",
    hopCount: 0,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("shouldProcessMention", () => {
  it("accepts only an explicit mention", () => {
    expect(
      shouldProcessMention({
        message: message(),
        username: "agent-a",
        ownParticipantId: "self",
        processedMessageIds: [],
      }),
    ).toBe(true);
    expect(
      shouldProcessMention({
        message: message({ content: "hello everyone", mentions: [] }),
        username: "agent-a",
        ownParticipantId: "self",
        processedMessageIds: [],
      }),
    ).toBe(false);
  });

  it("does not process its own or an already processed message", () => {
    const own = message({ senderId: "self" });
    expect(
      shouldProcessMention({
        message: own,
        username: "agent-a",
        ownParticipantId: "self",
        processedMessageIds: [],
      }),
    ).toBe(false);
    const duplicate = message();
    expect(
      shouldProcessMention({
        message: duplicate,
        username: "agent-a",
        ownParticipantId: "self",
        processedMessageIds: [duplicate.id],
      }),
    ).toBe(false);
  });

  it("does not process mentions at the hop limit", () => {
    expect(
      shouldProcessMention({
        message: message({ hopCount: 4 }),
        username: "agent-a",
        ownParticipantId: "self",
        processedMessageIds: [],
      }),
    ).toBe(false);
  });

  it("ignores recalled tombstones even when re-fetched after a reconnect", () => {
    expect(
      shouldProcessMention({
        message: message({ content: "", mentions: [], deletedAt: new Date().toISOString() }),
        username: "agent-a",
        ownParticipantId: "self",
        processedMessageIds: [],
      }),
    ).toBe(false);
  });

  it("detects when the Agent already sent through the Hive MCP tool", () => {
    expect(hasAgentMessage([message({ senderId: "self" })], "self")).toBe(true);
    expect(hasAgentMessage([message({ senderId: "another-agent" })], "self")).toBe(false);
  });
});
