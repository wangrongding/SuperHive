// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { MessageMarkdown } from "./message-markdown";

afterEach(() => {
  cleanup();
});

describe("MessageMarkdown", () => {
  it("渲染 GFM Markdown：标题、列表、表格、删除线", () => {
    const { container } = render(
      <MessageMarkdown
        content={"## 标题\n\n- 一\n- 二\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n~~划掉~~"}
      />,
    );
    expect(container.querySelector("h2")?.textContent).toBe("标题");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("table th")?.textContent).toBe("A");
    expect(container.querySelector("del")?.textContent).toBe("划掉");
  });

  it("代码块和行内代码原样保留，不渲染其中的 Markdown", () => {
    const { container } = render(
      <MessageMarkdown content={"```js\nconst a = **1**;\n```\n\n行内 `**code**`"} />,
    );
    expect(container.querySelector("pre code")?.textContent).toBe("const a = **1**;\n");
    expect(container.querySelector("p > code")?.textContent).toBe("**code**");
    expect(container.querySelector("strong")).toBeNull();
  });

  it("高亮 @提及，但不影响代码和链接内部", () => {
    const { container } = render(
      <MessageMarkdown content={"@Alice 看下 `@notme` 和 https://example.com/@path"} />,
    );
    const marks = [...container.querySelectorAll("mark")].map((mark) => mark.textContent);
    expect(marks).toEqual(["@Alice"]);
  });

  it("链接在新标签页打开并带安全属性，裸 URL 自动成链", () => {
    const { container } = render(<MessageMarkdown content={"看这里 https://example.com/a"} />);
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://example.com/a");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toContain("noopener");
  });

  it("不渲染原始 HTML，防止注入", () => {
    const { container } = render(
      <MessageMarkdown content={"<img src=x onerror=alert(1)><script>alert(2)</script>"} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
  });

  it("单个换行渲染为换行符", () => {
    const { container } = render(<MessageMarkdown content={"第一行\n第二行"} />);
    expect(container.querySelector("br")).not.toBeNull();
  });

  it("代码块带语法高亮、语言标签和复制按钮", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <MessageMarkdown content={'```js\nconst greeting = "hi";\n```'} />,
    );
    expect(container.querySelector("code.hljs")).not.toBeNull();
    expect(container.querySelector(".hljs-keyword")?.textContent).toBe("const");
    expect(container.querySelector(".code-block-language")?.textContent).toBe("js");

    await user.click(screen.getByRole("button", { name: "复制代码" }));
    expect(await navigator.clipboard.readText()).toBe('const greeting = "hi";');
    expect(screen.getByRole("button", { name: "复制代码" }).textContent).toContain("已复制");
  });
});
