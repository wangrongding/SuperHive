import { describe, expect, it } from "vitest";
import { escapeCardMarkdown, renderFeishuCard } from "./feishu-card.js";
import { normalizeCardAction } from "./feishu.js";
import type { ImRich } from "./types.js";

const question: ImRich = {
  title: "helper 有问题问你",
  tone: "question",
  body: "通知谁？",
  options: [
    { key: "A", label: "测试" },
    { key: "B", label: "产品" },
  ],
  summary: "helper：通知谁？",
};
const flatten = (elements: any[]): any[] =>
  elements.flatMap((item) => [
    item,
    ...flatten(item.elements ?? []),
    ...flatten((item.columns ?? []).flatMap((column: any) => column.elements ?? [])),
  ]);

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
    expect(elements.at(-1).columns[0].elements[0]).toMatchObject({
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

  it("单选：每个选项一个回调按钮，另有「其它」输入框和提交", () => {
    const card = renderFeishuCard({ ...question, choice: { multiple: false } }) as any;
    const all = flatten(card.body.elements);
    const options = all.filter(
      (item) => item.tag === "button" && item.behaviors?.[0]?.type === "callback",
    );
    expect(options.map((item) => [item.text.content, item.behaviors[0].value])).toEqual([
      ["A. 测试", { hive: "1", do: "answer", key: "A" }],
      ["B. 产品", { hive: "1", do: "answer", key: "B" }],
    ]);
    const form = card.body.elements.find((item: any) => item.tag === "form");
    expect(form.elements.map((item: any) => item.tag)).toEqual(["input", "button"]);
    expect(form.elements[1]).toMatchObject({ form_action_type: "submit" });
  });

  it("多选：表单里的勾选框加「其它」，提交一次带回全部；已回答后去掉所有控件并标出选中项", () => {
    const card = renderFeishuCard({ ...question, choice: { multiple: true } }) as any;
    const form = card.body.elements.find((item: any) => item.tag === "form");
    expect(form.elements.map((item: any) => item.name ?? item.tag)).toEqual([
      "opt_A",
      "opt_B",
      "other",
      "answer_submit",
    ]);
    const answered = renderFeishuCard({
      ...question,
      choice: { multiple: true },
      selected: ["B"],
      resolved: { text: "已回答", ok: true },
    }) as any;
    const all = flatten(answered.body.elements);
    expect(all.some((item) => ["form", "button", "checker", "input"].includes(item.tag))).toBe(
      false,
    );
    expect(answered.header).toMatchObject({
      template: "green",
      text_tag_list: [{ text: { content: "已回答" } }],
    });
    expect(JSON.stringify(answered)).toContain("✓ B");
  });

  it("操作按钮、进度步骤；回调只认我们自己的按钮和表单", () => {
    const card = renderFeishuCard({
      title: "helper 处理失败",
      tone: "danger",
      steps: [
        { label: "helper", state: "running", detail: "执行命令" },
        { label: "codex", state: "done" },
      ],
      actions: [
        { label: "重试", value: { do: "retry" }, style: "primary" },
        { label: "忽略", value: { do: "dismiss" } },
      ],
      summary: "x",
    }) as any;
    expect(card.body.elements[0].content).toBe(
      "🔄 **helper**\u3000<font color='grey'>执行命令</font>\n✅ **codex**",
    );
    const buttons = card.body.elements[1].columns.map((column: any) => column.elements[0]);
    expect(buttons.map((item: any) => [item.type, item.behaviors[0].value.do])).toEqual([
      ["primary_filled", "retry"],
      ["default", "dismiss"],
    ]);
    expect(
      normalizeCardAction({
        context: { open_message_id: "om_1", open_chat_id: "oc_1" },
        operator: { open_id: "ou_1" },
        action: { value: { hive: "1", do: "retry" }, tag: "button" },
      }),
    ).toEqual({
      externalId: "om_1",
      chatId: "oc_1",
      operatorId: "ou_1",
      value: { hive: "1", do: "retry" },
    });
    expect(
      normalizeCardAction({
        context: { open_message_id: "om_1", open_chat_id: "oc_1" },
        operator: { open_id: "ou_1" },
        action: { value: { other: "x" }, tag: "button" },
      }),
    ).toBeUndefined();
    expect(
      normalizeCardAction({
        context: { open_message_id: "om_1", open_chat_id: "oc_1" },
        operator: { open_id: "ou_1" },
        action: { tag: "button", name: "answer_submit", form_value: { opt_A: true } },
      }),
    ).toMatchObject({ value: { do: "answer_form" }, form: { opt_A: true } });
  });
});
