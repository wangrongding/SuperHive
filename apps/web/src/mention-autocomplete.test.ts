import { describe, expect, it } from "vitest";
import type { Participant } from "@superhive/protocol";
import {
  applyMention,
  draftMentions,
  filterMentionParticipants,
  findMentionContext,
  splitDraftMentions,
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
    // 中文后不用先打空格
    expect(findMentionContext("你好@", 3)).toEqual({ start: 2, end: 3, query: "" });
    expect(findMentionContext("请@rd", 4)).toEqual({ start: 1, end: 4, query: "rd" });
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

describe("draft mention highlighting", () => {
  it("splits mentions out of the draft with the same rules as message bodies", () => {
    expect(splitDraftMentions("@bob 看下 a@b.com，@前端-agent\n")).toEqual([
      { text: "@bob", mention: true },
      { text: " 看下 a@b.com，", mention: false },
      { text: "@前端-agent", mention: true },
      { text: "\n", mention: false },
    ]);
    expect(splitDraftMentions("")).toEqual([]);
  });

  it("detects an existing mention without matching longer names", () => {
    expect(draftMentions("hi @Bob ", "bob")).toBe(true);
    expect(draftMentions("hi @bobby ", "bob")).toBe(false);
    expect(draftMentions("mail a@bob.com", "bob.com")).toBe(false);
    expect(draftMentions("你好@Bob 看下", "bob")).toBe(true);
  });
});

describe("草稿高亮跳过代码", () => {
  it("代码里的 @ 不高亮也不算已提及", () => {
    expect(splitDraftMentions("看 `@rd` 和 @bob")).toEqual([
      { text: "看 `@rd` 和 ", mention: false },
      { text: "@bob", mention: true },
    ]);
    expect(draftMentions("```\n@rd\n```", "rd")).toBe(false);
  });
});
