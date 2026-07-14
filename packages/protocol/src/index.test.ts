import { describe, expect, it } from "vitest";
import { isMentioned, parseMentions } from "./index.js";

describe("mentions", () => {
  it("parses unicode names, de-duplicates case-insensitively, and ignores @all semantics", () => {
    expect(parseMentions("hi @frontend-agent @小王 and @Frontend-Agent")).toEqual([
      "frontend-agent",
      "小王",
    ]);
  });

  it("matches an exact username", () => {
    expect(isMentioned("hello @agent-a", "agent-a")).toBe(true);
    expect(isMentioned("hello @agent-ab", "agent-a")).toBe(false);
  });
});
