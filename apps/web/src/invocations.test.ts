import type { ChatMessage, Invocation } from "@ai-hive/protocol";
import { describe, expect, it } from "vitest";
import { currentPausedInvocations } from "./invocations";

const now = new Date().toISOString();
const message = (id: string, seq: number, senderType: "human" | "agent") =>
  ({ id, seq, senderType }) as ChatMessage;
const blocked = (id: string, messageId: string, blockReason: Invocation["blockReason"]) =>
  ({
    id,
    messageId,
    status: "blocked",
    blockReason,
    agentName: "agent",
    attempts: 1,
    createdAt: now,
    updatedAt: now,
  }) as Invocation;

describe("currentPausedInvocations", () => {
  it("只提示人最后一次发言之后被拦下的调用", () => {
    const messages = [
      message("m1", 1, "agent"),
      message("m2", 2, "human"),
      message("m3", 3, "agent"),
    ];
    const paused = currentPausedInvocations(
      [
        blocked("old-hop", "m1", "hop_limit"),
        blocked("new-hop", "m3", "hop_limit"),
        blocked("new-turns", "m3", "consecutive_limit"),
        { ...blocked("queued", "m3", undefined), status: "queued" },
      ],
      messages,
    );
    expect(paused.map((invocation) => invocation.id)).toEqual(["new-hop", "new-turns"]);
  });
});
