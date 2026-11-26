import { describe, expect, it } from "vitest";
import { parseMentions } from "@superhive/protocol";
import {
  buildQuoteBlock,
  draftQuotes,
  insertQuote,
  neutralizeMentions,
  quoteExcerpt,
  splitQuote,
} from "./message-quote";

describe("引用块", () => {
  it("整条引用：#序号 + 发送者 + 前三行摘要，代码块缩成 [代码]、去掉 Markdown 记号和空行", () => {
    const block = buildQuoteBlock({
      seq: 42,
      senderName: "rd-claude",
      content: "第一行\n\n```ts\nconst a = 1;\n```\n- **第三行** 见 [文档](https://x.y)\n第四行",
    });
    expect(block).toBe("> #42 · rd-claude\n> 第一行\n> [代码]\n> 第三行 见 文档…");
  });

  it("引用一条本身带引用的消息时不套娃，只摘它自己的话", () => {
    expect(quoteExcerpt("> #3 · bob\n> 旧的\n\n新的回答")).toEqual(["新的回答"]);
  });

  it("超长行截短", () => {
    const [line] = quoteExcerpt("长".repeat(200));
    expect([...line!].length).toBe(121);
    expect(line!.endsWith("…")).toBe(true);
  });

  it("选中引用只引用选中的那段，保留空行", () => {
    expect(
      buildQuoteBlock({ seq: 7, senderName: "Alice", content: "全文", selection: "甲\n\n乙" }),
    ).toBe("> #7 · Alice\n> 甲\n>\n> 乙");
  });

  it("引用里原文的 @ 不再叫醒人", () => {
    const block = buildQuoteBlock({
      seq: 1,
      senderName: "Alice",
      content: "@rd-claude 看下，邮件 a@b.com",
    });
    expect(block).toContain("＠rd-claude 看下，邮件 a@b.com");
    expect(parseMentions(block)).toEqual([]);
    expect(neutralizeMentions("@x and @y")).toBe("＠x and ＠y");
  });
});

describe("放进输入框", () => {
  const block = "> #5 · rd-claude\n> 原话";

  it("引用在上，原来写的字和 @ 接在下面，光标在末尾", () => {
    expect(insertQuote("", block, "rd-claude")).toEqual({
      value: `${block}\n\n@rd-claude `,
      cursor: `${block}\n\n@rd-claude `.length,
    });
    expect(insertQuote("我想说", block).value).toBe(`${block}\n\n我想说`);
  });

  it("再点一次引用换掉开头旧的引用块，已经 @ 过的不再补", () => {
    const first = insertQuote("草稿", "> #1 · bob\n> 旧", "rd-claude").value;
    expect(insertQuote(first, block, "rd-claude").value).toBe(`${block}\n\n@rd-claude 草稿`);
  });

  it("草稿里还留着引用头才算引用", () => {
    expect(draftQuotes(`${block}\n\n好的`, 5)).toBe(true);
    expect(draftQuotes(`${block}\n\n好的`, 6)).toBe(false);
    expect(draftQuotes("好的", 5)).toBe(false);
  });
});

describe("发出去以后认回引用块", () => {
  it("拆成摘录和其余正文", () => {
    expect(splitQuote("> #5 · rd-claude\n> 原话\n> 第二行\n\n@rd-claude 补充", 5)).toEqual({
      excerpt: "原话\n第二行",
      body: "@rd-claude 补充",
    });
  });

  it("序号对不上或引用块不在开头时原样显示", () => {
    expect(splitQuote("> #5 · rd-claude\n> 原话", 6)).toBeUndefined();
    expect(splitQuote("前言\n> #5 · rd-claude", 5)).toBeUndefined();
  });
});
