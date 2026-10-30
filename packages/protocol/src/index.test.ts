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

describe("parseMentions 跳过代码", () => {
  it("行内代码与代码块里的提及不算，邮箱也不算", () => {
    expect(parseMentions("示例：正文开头写了 `@rd`，真正找 @alice")).toEqual(["alice"]);
    expect(parseMentions("``用 `@rd` 举例``")).toEqual([]);
    expect(parseMentions("```text\n@rd-codex 看下\n```\n@bob 你来")).toEqual(["bob"]);
    expect(parseMentions("~~~\n@rd\n")).toEqual([]);
    expect(parseMentions("未闭合的 ` 反引号 @carol")).toEqual(["carol"]);
    expect(parseMentions("邮件 me@example.com 与中文后直接@小明")).toEqual(["小明"]);
  });
});
