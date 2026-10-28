/**
 * "无需回复"约定：Agent 被唤醒后若判断没有需要补充或执行的内容，只输出 NO_REPLY，
 * Bridge 据此不发送任何消息（沿用 OpenClaw 的 SILENT_REPLY_TOKEN 约定）。
 * 不发消息也就不会再唤醒其他 Agent，Agent 之间的客套往返在这里自然终止。
 */
export const SILENT_REPLY_TOKEN = "NO_REPLY";

/** 模型常把标记包在代码、加粗或引号里，或在末尾带句号 */
const wrapper = String.raw`[\s*_\x60"'“”「」]*`;
const exactPattern = new RegExp(`^${wrapper}${SILENT_REPLY_TOKEN}${wrapper}[.。!！]?\\s*$`, "i");
/** 正文之后另起一段或用空白隔开的结尾标记 */
const trailingPattern = new RegExp(
  String.raw`(?:^|\s)${wrapper}${SILENT_REPLY_TOKEN}${wrapper}[.。!！]?\s*$`,
  "i",
);
/** 开头的标记，可能紧贴正文（如 "NO_REPLY好的…"）；不含 _，避免误伤 NO_REPLY_TIMEOUT 之类的正文 */
const quote = String.raw`[*\x60"'“”「」]*`;
const leadingPattern = new RegExp(
  String.raw`^\s*${quote}${SILENT_REPLY_TOKEN}(?![A-Za-z0-9_])${quote}[:：,，]?\s*`,
  "i",
);

export type ResolvedReply = { silent: true } | { silent: false; text: string };

/**
 * 解析 Agent 的最终输出：
 * - 只有标记 → silent
 * - 标记与正文混在一起 → 去掉标记后照常发送正文（模型有话要说，标记是多余的）
 */
export function resolveReplyText(text: string): ResolvedReply {
  const trimmed = text.trim();
  // 空输出仍按失败处理（多半是 Provider 出错），不当作有意的沉默
  if (!trimmed) return { silent: false, text: "" };
  if (exactPattern.test(trimmed)) return { silent: true };
  const stripped = trimmed.replace(trailingPattern, "").replace(leadingPattern, "").trim();
  if (!stripped) return { silent: true };
  return { silent: false, text: stripped };
}
