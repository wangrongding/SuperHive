import { describe, expect, it } from "vitest";
import type { Participant } from "@ai-hive/protocol";
import {
  applyMention,
  filterMentionParticipants,
  findMentionContext,
} from "./mention-autocomplete";

function participant(
  username: string,
  status: Participant["status"] = "online",
  type: Participant["type"] = "human",
): Participant {
  return {
    id: crypto.randomUUID(),
    roomId: "general",
    username,
    type,
    status,
    joinedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  };
}

describe("mention autocomplete", () => {
  it("finds an empty or partial mention at the caret", () => {
    expect(findMentionContext("hello @", 7)).toEqual({ start: 6, end: 7, query: "" });
    expect(findMentionContext("hello @fro", 10)).toEqual({ start: 6, end: 10, query: "fro" });
    expect(findMentionContext("mail a@b", 8)).toBeUndefined();
    expect(findMentionContext("@agent done", 11)).toBeUndefined();
  });

  it("filters case-insensitively, excludes self, and ranks online prefix matches first", () => {
    const participants = [
      participant("myself"),
      participant("backend-agent", "online", "agent"),
      participant("agent-backup", "offline", "agent"),
      participant("Backend-Bot", "offline", "agent"),
    ];
    expect(
      filterMentionParticipants(participants, "back", "myself").map((item) => item.username),
    ).toEqual(["backend-agent", "Backend-Bot", "agent-backup"]);
  });

  it("replaces only the active mention and returns the next caret position", () => {
    expect(
      applyMention("ask @fro about this", { start: 4, end: 8, query: "fro" }, "frontend-agent"),
    ).toEqual({ value: "ask @frontend-agent about this", cursor: 20 });
  });
});
