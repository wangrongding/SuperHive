import { describe, expect, it } from "vitest";
import type { ChatMessage } from "./hive-protocol.js";
import { buildDeveloperInstructions, buildMentionPrompt } from "./prompt-builder.js";

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

describe("buildDeveloperInstructions", () => {
  it.each([
    ["read-only", "不得修改本地文件"],
    ["workspace", "在当前工作目录中读写文件并运行必要命令"],
    ["full", "已授予完全访问权限"],
  ] as const)("injects the %s local access boundary", (access, expected) => {
    expect(
      buildDeveloperInstructions({
        agentName: "agent-a",
        persona: "协作 Agent",
        serverRules: "server rules",
        access,
      }),
    ).toContain(expected);
  });
});
