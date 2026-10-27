import { describe, expect, it } from "vitest";
import { isMentioned, parseMentions, stripUnsafeCharacters } from "./index.js";

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

describe("stripUnsafeCharacters", () => {
  it("removes control and bidi characters but keeps newlines, tabs and emoji joiners", () => {
    expect(stripUnsafeCharacters("a\u0000b\u001bc‮d⁦e\r\nf\tg")).toBe("abcde\nf\tg");
    expect(stripUnsafeCharacters("\u{1F469}‍\u{1F4BB} ok")).toBe("\u{1F469}‍\u{1F4BB} ok");
    expect(stripUnsafeCharacters("x y")).toBe("x\ny");
  });
});
