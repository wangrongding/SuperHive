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

/** 处理完的卡片：成功变绿、其余（忽略、失效）变灰，按钮全部去掉 */
const RESOLVED_OK = { template: "green", tag: "green", icon: "done_outlined" };
const RESOLVED_OTHER = { template: "grey", tag: "neutral", icon: "done_outlined" };

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

/** 卡片回调里认这个字段：只处理我们自己发出的按钮 */
export const CARD_ACTION_KEY = "hive";
/** 表单里「其它答案」输入框与选项勾选框的字段名 */
export const OTHER_FIELD = "other";
export const OPTION_FIELD_PREFIX = "opt_";

const STEP_ICONS: Record<NonNullable<ImRich["steps"]>[number]["state"], string> = {
  queued: "⏳",
  running: "🔄",
  waiting: "❓",
  done: "✅",
  failed: "⚠️",
};

function button(
  label: string,
  value: Record<string, string>,
  type: string,
  extra: Record<string, unknown> = {},
) {
  return {
    tag: "button",
    text: { tag: "plain_text", content: plainText(label, 60) },
    type,
    behaviors: [{ type: "callback", value: { [CARD_ACTION_KEY]: "1", ...value } }],
    ...extra,
  };
}

/**
 * 按钮排版：少而短的横排一行；多了或文字长就竖排、每个占满一行。
 * 飞书电脑端的分栏不会换行，横排放不下时按钮文字会被截成「rd-…」。
 */
export function buttonLayout(
  buttons: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const label = (item: Record<string, unknown>) =>
    String((item.text as { content?: string } | undefined)?.content ?? "");
  const total = buttons.reduce((sum, item) => sum + label(item).length, 0);
  if (buttons.length <= 3 && total <= 18) return [buttonRow(buttons)];
  return buttons.map((item) => ({ ...item, width: "fill" }));
}

/** 一排按钮：放进分栏里横向排开 */
function buttonRow(buttons: Array<Record<string, unknown>>) {
  return {
    tag: "column_set",
    flex_mode: "flow",
    horizontal_spacing: "8px",
    columns: buttons.map((item) => ({ tag: "column", width: "auto", elements: [item] })),
  };
}

/** 提问的选项：可作答时是按钮或勾选框（加「其它」输入），已答或不能交互时是只读列表 */
function choiceElements(rich: ImRich): Array<Record<string, unknown>> {
  const options = rich.options ?? [];
  const selected = new Set(rich.selected ?? []);
  const label = (option: { key: string; label: string }) => `${option.key}. ${option.label}`;
  if (!rich.choice || rich.resolved) {
    return [
      {
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
            elements: options.map((option) =>
              markdown(
                selected.has(option.key)
                  ? `**<font color='green'>✓ ${option.key}</font>\u3000${escapeCardMarkdown(option.label)}**`
                  : `**<font color='violet'>${option.key}</font>**\u3000${escapeCardMarkdown(option.label)}`,
              ),
            ),
          },
        ],
      },
    ];
  }
  const other = {
    tag: "input",
    name: OTHER_FIELD,
    placeholder: { tag: "plain_text", content: "其它答案（选填）" },
    max_length: 1000,
    width: "fill",
  };
  const submit = (text: string) => ({
    tag: "button",
    text: { tag: "plain_text", content: text },
    type: "primary_filled",
    form_action_type: "submit",
    name: "answer_submit",
  });
  if (rich.choice.multiple) {
    return [
      {
        tag: "form",
        name: "answer_form",
        vertical_spacing: "8px",
        elements: [
          ...options.map((option) => ({
            tag: "checker",
            name: `${OPTION_FIELD_PREFIX}${option.key}`,
            checked: false,
            text: { tag: "plain_text", content: plainText(label(option), 100) },
          })),
          other,
          submit("提交"),
        ],
      },
    ];
  }
  return [
    ...options.map((option, index) =>
      button(
        label(option),
        { do: "answer", key: option.key },
        index === 0 ? "primary" : "default",
        {
          width: "fill",
        },
      ),
    ),
    {
      tag: "form",
      name: "answer_form",
      direction: "horizontal",
      horizontal_spacing: "8px",
      elements: [other, submit("提交")],
    },
  ];
}

/** 渲染成飞书消息卡片（JSON 2.0） */
export function renderFeishuCard(rich: ImRich): Record<string, unknown> {
  const tone = rich.resolved ? (rich.resolved.ok ? RESOLVED_OK : RESOLVED_OTHER) : TONES[rich.tone];
  const elements: Array<Record<string, unknown>> = [];
  if (rich.body?.trim()) elements.push(markdown(escapeCardMarkdown(rich.body)));
  if (rich.steps?.length) {
    elements.push(
      markdown(
        rich.steps
          .map(
            (step) =>
              `${STEP_ICONS[step.state]} **${escapeCardMarkdown(plainText(step.label, 60))}**${
                step.detail
                  ? `\u3000<font color='grey'>${escapeCardMarkdown(plainText(step.detail, 120))}</font>`
                  : ""
              }`,
          )
          .join("\n"),
      ),
    );
  }
  if (rich.options?.length) elements.push(...choiceElements(rich));
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
  if (rich.footer && !rich.resolved) {
    elements.push(
      markdown(`<font color='grey'>${escapeCardMarkdown(plainText(rich.footer, 120))}</font>`, {
        text_size: "notation",
      }),
    );
  }
  const buttons: Array<Record<string, unknown>> = rich.resolved
    ? []
    : (rich.actions ?? []).map((action, index) =>
        button(
          action.label,
          action.value,
          action.style === "danger"
            ? "danger"
            : action.style === "primary" || (!action.style && index === 0)
              ? "primary_filled"
              : "default",
        ),
      );
  if (rich.link) {
    buttons.push({
      tag: "button",
      text: { tag: "plain_text", content: plainText(rich.link.label, 40) },
      type: "default",
      behaviors: [{ type: "open_url", default_url: rich.link.url }],
    });
  }
  if (buttons.length) elements.push(...buttonLayout(buttons));
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
      ...(rich.resolved || rich.tag
        ? {
            text_tag_list: [
              {
                tag: "text_tag",
                text: {
                  tag: "plain_text",
                  content: plainText(rich.resolved?.text ?? rich.tag ?? "", 20),
                },
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
