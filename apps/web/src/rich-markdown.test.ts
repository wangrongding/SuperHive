// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { editorMarkdown, richComposerExtensions } from "./rich-markdown";

let editor: Editor | undefined;
afterEach(() => {
  editor?.destroy();
  editor = undefined;
});

function roundTrip(markdown: string): string {
  editor ??= new Editor({ extensions: richComposerExtensions(() => "") });
  editor.commands.setContent(markdown, { contentType: "markdown" });
  return editorMarkdown(editor);
}

describe("rich composer markdown", () => {
  it("keeps typed text as is instead of escaping it", () => {
    // 默认序列化会写成 rd\_x、@rd-claude\_2，提及就断了
    expect(roundTrip("a*b and rd_x @rd-claude_2 snake_case [x] ~/code")).toBe(
      "a*b and rd_x @rd-claude_2 snake_case [x] ~/code",
    );
    expect(roundTrip("<div>x</div> 5 < 6 & 7")).toBe("<div>x</div> 5 < 6 & 7");
  });

  it("keeps backslashes, entities and single tildes from pasted or restored text", () => {
    expect(roundTrip("C:\\Users\\rd\\_x 正则 \\d+\\.\\w a\\*b")).toBe(
      "C:\\Users\\rd\\_x 正则 \\d+\\.\\w a\\*b",
    );
    expect(roundTrip("a &amp; b &lt;c&gt; &#39; & d")).toBe("a &amp; b &lt;c&gt; &#39; & d");
    expect(roundTrip("价格 ~100~200 元，~~删掉~~")).toBe("价格 ~100~200 元，~~删掉~~");
  });

  it("links pasted text only when it is an explicit url", () => {
    editor = new Editor({ extensions: richComposerExtensions(() => "") });
    const paste = (text: string) => {
      editor!.commands.clearContent();
      // jsdom 没有 ClipboardEvent
      editor!.view.pasteText(text, new Event("paste") as ClipboardEvent);
      return editorMarkdown(editor!);
    };
    // .chat、.app、.tsx 这类后缀会被当成域名，类名、文件名不能变成链接
    expect(paste("div.chat-title · src/App.tsx:4880:13")).toBe(
      "div.chat-title · src/App.tsx:4880:13",
    );
    expect(paste("config.app index.dev")).toBe("config.app index.dev");
    expect(paste("见 https://example.com/a")).toBe(
      "见 [https://example.com/a](https://example.com/a)",
    );
    expect(paste("www.example.com")).toBe("[www.example.com](http://www.example.com)");
  });

  it("keeps task lists", () => {
    expect(roundTrip("- [ ] todo\n- [x] done")).toBe("- [ ] todo\n- [x] done");
  });

  it("uses a single newline for line breaks, like the message view", () => {
    expect(roundTrip("第一行\n第二行\n\n第三段")).toBe("第一行\n第二行\n\n第三段");
  });

  it("round-trips common blocks", () => {
    const blocks = [
      "# 标题\n\n正文 **粗** *斜* `code` ~~删~~ [链接](https://example.com)",
      "- a\n- b\n\n1. x\n2. y",
      "> 引用\n> 第二行",
      // 右键「引用回复」插的引用块：头一行的 #序号 · 名字发出去要原样，才认得回引用卡片
      "> #12 · rd-claude\n> 结论：＠rd 可以合\n>\n> 第二段\n\n@rd-claude 我的想法",
      "```ts\nconst a = 1;\n\nb\n```",
    ];
    for (const block of blocks) expect(roundTrip(block)).toBe(block);
  });

  it("keeps GFM tables", () => {
    expect(roundTrip("| a | b |\n| - | - |\n| 1 | 2 |")).toBe(
      "| a   | b   |\n| --- | --- |\n| 1   | 2   |",
    );
  });

  it("returns an empty string for an empty editor", () => {
    expect(roundTrip("")).toBe("");
  });
});
