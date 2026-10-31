import type { ImRich } from "./types.js";

/** 卡片 JSON 上限约 30KB；正文留足余量，超出部分由调用方截断并给网页链接 */
export const FEISHU_CARD_BODY_LIMIT = 12_000;

// 图标 token 只用官方常用表里的精确值，写错了图标不渲染
const TONES: Record<ImRich["tone"], { template: string; tag: string; icon: string }> = {
  reply: { template: "blue", tag: "blue", icon: "ai-common_colorful" },
  mention: { template: "wathet", tag: "wathet", icon: "bell_outlined" },
  question: { template: "violet", tag: "violet", icon: "todo_colorful" },
  warning: { template: "orange", tag: "orange", icon: "warning_outlined" },
  danger: { template: "red", tag: "red", icon: "warning_outlined" },
  approval: { template: "yellow", tag: "yellow", icon: "approval_colorful" },
  digest: { template: "grey", tag: "neutral", icon: "chat_outlined" },
};

/**
 * 卡片 Markdown 会解析 <font>、<at> 等标签：正文里的尖括号（代码块之外）转成实体，
 * 避免 Agent 回复里的 HTML/泛型被当成卡片标签吃掉或让整张卡片发送失败。
 */
export function escapeCardMarkdown(markdown: string): string {
  const parts = markdown.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g);
  return parts
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part
            .replace(/</g, "&#60;")
            // 行首（可带缩进）的 > 是引用语法，保留
            .replace(/(^|\n)([ \t]*)>|>/g, (match, start?: string, indent?: string) =>
              start !== undefined ? `${start}${indent ?? ""}>` : "&#62;",
            ),
    )
    .join("");
}

/** 卡片标题等纯文本字段：去掉换行、限制长度 */
function plainText(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

function markdown(content: string, extra: Record<string, unknown> = {}) {
  return { tag: "markdown", content, ...extra };
}

/** 渲染成飞书消息卡片（JSON 2.0） */
export function renderFeishuCard(rich: ImRich): Record<string, unknown> {
  const tone = TONES[rich.tone];
  const elements: Array<Record<string, unknown>> = [];
  if (rich.body?.trim()) elements.push(markdown(escapeCardMarkdown(rich.body)));
  if (rich.options?.length) {
    elements.push({
      tag: "column_set",
      flex_mode: "none",
      background_style: "violet-50",
      columns: [
        {
          tag: "column",
          width: "weighted",
          weight: 1,
          padding: "8px 12px 8px 12px",
          vertical_spacing: "4px",
          elements: rich.options.map((option) =>
            markdown(
              `**<font color='violet'>${option.key}</font>**\u3000${escapeCardMarkdown(option.label)}`,
            ),
          ),
        },
      ],
    });
  }
  for (const [index, section] of (rich.sections ?? []).entries()) {
    if (index > 0 || elements.length) elements.push({ tag: "hr" });
    elements.push(
      markdown(
        `**${escapeCardMarkdown(plainText(section.title, 80))}**${
          section.subtitle
            ? `\u3000<font color='grey'>${escapeCardMarkdown(plainText(section.subtitle, 80))}</font>`
            : ""
        }`,
      ),
    );
    elements.push(markdown(escapeCardMarkdown(section.body)));
  }
  if (rich.attachments?.length) {
    elements.push(
      markdown(
        [
          `**附件 ${rich.attachments.length} 个**`,
          ...rich.attachments.map(
            (item) =>
              `- ${escapeCardMarkdown(plainText(item.name, 120))}\u3000<font color='grey'>${item.size}</font>`,
          ),
        ].join("\n"),
      ),
    );
  }
  if (rich.note) {
    elements.push(
      markdown(`<font color='grey'>${escapeCardMarkdown(plainText(rich.note, 300))}</font>`, {
        text_size: "notation",
      }),
    );
  }
  if (rich.link) {
    elements.push({
      tag: "button",
      text: { tag: "plain_text", content: plainText(rich.link.label, 40) },
      type: "default",
      size: "small",
      behaviors: [{ type: "open_url", default_url: rich.link.url }],
    });
  }
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: { content: plainText(rich.summary, 100) },
    },
    header: {
      title: { tag: "plain_text", content: plainText(rich.title, 80) },
      ...(rich.subtitle
        ? { subtitle: { tag: "plain_text", content: plainText(rich.subtitle, 80) } }
        : {}),
      template: tone.template,
      icon: { tag: "standard_icon", token: tone.icon },
      ...(rich.tag
        ? {
            text_tag_list: [
              {
                tag: "text_tag",
                text: { tag: "plain_text", content: plainText(rich.tag, 20) },
                color: tone.tag,
              },
            ],
          }
        : {}),
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 16px 12px",
      vertical_spacing: "8px",
      elements: elements.length ? elements : [markdown("（无内容）")],
    },
  };
}
