import { describe, expect, it } from "vitest";
import { escapeCardMarkdown, renderFeishuCard } from "./feishu-card.js";

describe("飞书卡片", () => {
  it("问题卡片：紫色标题与状态标签、选项单独成块、作答提示与网页按钮", () => {
    const card = renderFeishuCard({
      title: "helper 有问题问你",
      subtitle: "general · #12",
      tone: "question",
      tag: "单选",
      body: "发到哪个环境？",
      options: [
        { key: "A", label: "测试环境" },
        { key: "B", label: "正式环境" },
      ],
      note: "回复这张卡片作答",
      link: { label: "在网页查看 #12", url: "http://hive.test/?room=general" },
      summary: "helper：发到哪个环境？",
    }) as any;
    expect(card.schema).toBe("2.0");
    expect(card.config.summary.content).toBe("helper：发到哪个环境？");
    expect(card.header).toMatchObject({
      title: { content: "helper 有问题问你" },
      subtitle: { content: "general · #12" },
      template: "violet",
      text_tag_list: [{ text: { content: "单选" }, color: "violet" }],
    });
    const elements = card.body.elements as any[];
    expect(elements[0]).toEqual({ tag: "markdown", content: "发到哪个环境？" });
    const options = elements[1].columns[0].elements.map((item: any) => item.content);
    expect(options).toEqual([
      "**<font color='violet'>A</font>**　测试环境",
      "**<font color='violet'>B</font>**　正式环境",
    ]);
    expect(elements.at(-1)).toMatchObject({
      tag: "button",
      behaviors: [{ type: "open_url", default_url: "http://hive.test/?room=general" }],
    });
    // 卡片 JSON 要能序列化发送
    expect(() => JSON.stringify(card)).not.toThrow();
  });

  it("正文里的尖括号转义，代码块和引用语法保持原样", () => {
    expect(escapeCardMarkdown("用 <at id=all> 和 Map<K, V>")).toBe(
      "用 &#60;at id=all&#62; 和 Map&#60;K, V&#62;",
    );
    expect(escapeCardMarkdown("> 引用\n`a<b>`\n```ts\nconst x: Array<T> = [];\n```")).toBe(
      "> 引用\n`a<b>`\n```ts\nconst x: Array<T> = [];\n```",
    );
  });

  it("合并推送每条一节，没有正文时也不会发出空卡片", () => {
    const digest = renderFeishuCard({
      title: "2 条新消息",
      tone: "digest",
      sections: [
        { title: "a 的回复", subtitle: "general · #1", body: "一" },
        { title: "b 的回复", body: "二" },
      ],
      summary: "a：一；b：二",
    }) as any;
    expect(digest.header.template).toBe("grey");
    expect(digest.body.elements.map((item: any) => item.tag)).toEqual([
      "markdown",
      "markdown",
      "hr",
      "markdown",
      "markdown",
    ]);
    const empty = renderFeishuCard({ title: "x", tone: "reply", summary: "x" }) as any;
    expect(empty.body.elements).toHaveLength(1);
  });
});
