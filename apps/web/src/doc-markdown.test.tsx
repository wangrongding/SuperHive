// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FilePreview } from "./attachments";
import { DocMarkdown, headingSlug, splitFrontmatter } from "./doc-markdown";
import { MessageMarkdown } from "./message-markdown";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const SAMPLE = `---
title: "发布计划"
tags: [web, docs]
owners:
  - rd
  - rd-claude
---

# 发布计划

第一行
第二行

## 范围

| 模块 | 状态 |
| --- | --- |
| web | 完成 |

## 任务

- [x] 写文档
- [ ] 截图

### 细节

跳到 [范围](#范围)。

\`\`\`ts
const a = 1;
\`\`\`
`;

describe("splitFrontmatter", () => {
  it("开头的 YAML 拆成键值：引号去掉，行内和多行列表合成一行", () => {
    const { meta, body } = splitFrontmatter(SAMPLE);
    expect(meta?.entries).toEqual([
      { key: "title", value: "发布计划" },
      { key: "tags", value: "web, docs" },
      { key: "owners", value: "rd, rd-claude" },
    ]);
    expect(body.startsWith("\n# 发布计划")).toBe(true);
  });

  it("不是 key: value 的 --- 块、不在开头的 --- 都当正文", () => {
    expect(splitFrontmatter("---\n就是一段话\n---\n正文").meta).toBeUndefined();
    expect(splitFrontmatter("正文\n---\ntitle: x\n---\n").meta).toBeUndefined();
    expect(splitFrontmatter("没有 frontmatter").body).toBe("没有 frontmatter");
  });
});

describe("headingSlug", () => {
  it("小写、去标点、空格换成 -，重名递增；中文保留", () => {
    const used = new Map<string, number>();
    expect(headingSlug("Hello, World!", used)).toBe("hello-world");
    expect(headingSlug("Hello World", used)).toBe("hello-world-1");
    expect(headingSlug("安装 / 卸载", used)).toBe("安装--卸载");
    expect(headingSlug("！！", used)).toBe("section");
  });
});

describe("DocMarkdown", () => {
  it("挂文档排版：frontmatter 成元信息块，表格包一层可横向滚动，任务列表是只读复选框", () => {
    render(<DocMarkdown content={SAMPLE} />);
    const article = document.querySelector("article.doc-markdown")!;
    expect(article).toBeTruthy();
    // 不是聊天气泡的样式
    expect(article.closest(".message-body")).toBeNull();

    const meta = document.querySelector("details.doc-meta")!;
    expect(meta.hasAttribute("open")).toBe(true);
    expect(meta.textContent).toContain("文档信息");
    expect(screen.getByText("rd, rd-claude").tagName).toBe("DD");
    // frontmatter 不再当正文糊成一段
    expect(article.textContent).not.toContain("owners:");

    expect(document.querySelector(".doc-table > table")).toBeTruthy();
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.map((box) => [box.checked, box.disabled])).toEqual([
      [true, true],
      [false, true],
    ]);
    // 代码块沿用语言标签和复制按钮
    expect(document.querySelector(".code-block-language")?.textContent).toBe("ts");
    expect(screen.getByRole("button", { name: "复制代码" })).toBeTruthy();
    // 按标准 Markdown：单个换行不算换行（聊天消息才会）
    expect(screen.getByText(/第一行/).querySelector("br")).toBeNull();
  });

  it("标题够多时生成目录，点目录滚到对应标题并标为当前位置", () => {
    render(<DocMarkdown content={SAMPLE} />);
    const toc = screen.getByRole("navigation", { name: "目录" });
    const items = [...toc.querySelectorAll("li")].map((li) => [li.className, li.textContent]);
    expect(items).toEqual([
      ["level-1", "发布计划"],
      ["level-2", "范围"],
      ["level-2", "任务"],
      ["level-3", "细节"],
    ]);

    const scroller = document.querySelector<HTMLElement>(".doc-view-scroll")!;
    const heading = screen.getByRole("heading", { name: "任务" });
    expect(heading.getAttribute("data-heading")).toBe("任务");
    // 页面里不加 id，免得和别的元素撞名
    expect(heading.id).toBe("");
    vi.spyOn(heading, "getBoundingClientRect").mockReturnValue({ top: 412 } as DOMRect);
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue({ top: 100 } as DOMRect);
    const item = screen.getByRole("button", { name: "任务" });
    fireEvent.click(item);
    expect(scroller.scrollTop).toBe(300);
    expect(item.getAttribute("aria-current")).toBe("location");
  });

  it("文档内 #锚点 链接在预览里滚动，不改地址栏；外链新窗口打开", () => {
    render(<DocMarkdown content={`${SAMPLE}\n[外链](https://example.com)`} />);
    const scroller = document.querySelector<HTMLElement>(".doc-view-scroll")!;
    const heading = screen.getByRole("heading", { name: "范围" });
    vi.spyOn(heading, "getBoundingClientRect").mockReturnValue({ top: 62 } as DOMRect);
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue({ top: 0 } as DOMRect);
    const anchor = screen.getByRole("link", { name: "范围" });
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    anchor.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(scroller.scrollTop).toBe(50);
    expect(screen.getByRole("link", { name: "外链" }).getAttribute("target")).toBe("_blank");
  });

  it("标题少的短文档不显示目录", () => {
    render(<DocMarkdown content={"# 标题\n\n## 一节\n\n正文"} />);
    expect(screen.queryByRole("navigation", { name: "目录" })).toBeNull();
    expect(document.querySelector(".doc-view.has-toc")).toBeNull();
  });
});

describe("聊天消息不受影响", () => {
  it("MessageMarkdown 不挂文档排版，单个换行照旧换行、不生成目录", () => {
    const { container } = render(
      <MessageMarkdown content={"# 一\n\n## 二\n\n## 三\n\n第一行\n第二行"} />,
    );
    expect(container.querySelector(".doc-markdown, .doc-view, .doc-toc")).toBeNull();
    expect(screen.getByText(/第一行/).querySelector("br")).toBeTruthy();
    expect(container.querySelector("[data-heading]")).toBeNull();
  });
});

describe("附件预览里的 .md", () => {
  it("默认按文档排版显示，可以切到源码再切回来", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(SAMPLE)),
    );
    vi.stubGlobal(
      "URL",
      Object.assign(URL, { createObjectURL: () => "blob:plan", revokeObjectURL: () => {} }),
    );
    render(
      <FilePreview
        attachment={{
          id: "00000000-0000-4000-8000-0000000000f1",
          name: "plan.md",
          kind: "text",
          mime: "text/markdown",
          size: SAMPLE.length,
          sha256: "0".repeat(64),
        }}
        base="http://hive"
        token="t"
        onClose={vi.fn()}
      />,
    );
    await screen.findByRole("heading", { name: "范围" }, { timeout: 5_000 });
    expect(document.querySelector(".file-preview-body .doc-markdown")).toBeTruthy();
    const rendered = screen.getByRole("radio", { name: "渲染" });
    expect(rendered.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(screen.getByRole("radio", { name: "源码" }));
    expect(document.querySelector(".doc-markdown")).toBeNull();
    const source = await screen.findByText(/owners:/, {}, { timeout: 5_000 });
    expect(source.closest(".file-preview-text pre")).toBeTruthy();

    fireEvent.click(rendered);
    expect(await screen.findByRole("navigation", { name: "目录" })).toBeTruthy();
  });
});
