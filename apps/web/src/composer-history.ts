import type { ChatMessage } from "@superhive/protocol";

/**
 * 输入框方向键可翻到的历史：当前房间已加载的、自己手打的消息，最新的在前，重复内容只留最新一条。
 * 直接取自消息列表，换设备或刷新后也在，不用再往本地存一份。
 * 已撤回的正文已被清空；点选选项生成的答案不是手打的，都不算。
 */
export function composerHistory(messages: readonly ChatMessage[], username: string): string[] {
  const history = new Set<string>();
  const self = username.toLocaleLowerCase();
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (
      message.senderType === "human" &&
      message.senderName.toLocaleLowerCase() === self &&
      !message.kind &&
      !message.deletedAt &&
      !message.answer &&
      message.content
    ) {
      history.add(message.content);
    }
  }
  return [...history];
}

export type HistoryStep = {
  history: readonly string[];
  draft: string;
  /** 上一次翻到的内容；用户改过之后 draft 就和它不同，这段文字算作普通草稿 */
  browsing: string | undefined;
  direction: "older" | "newer";
  selectionStart: number;
  selectionEnd: number;
};

/**
 * 算出方向键之后输入框该显示什么；返回 undefined 表示不归历史管，让方向键照常移动光标。
 * - 只有输入框为空时才进入历史，正在写的内容不会被一个方向键换掉；
 * - 翻动中光标在开头或末尾才继续翻，把光标移进文字中间后方向键恢复为在多行之间移动；
 * - 翻过最新一条回到空输入框。
 */
export function stepComposerHistory(step: HistoryStep): string | undefined {
  const { history, draft, browsing, direction, selectionStart, selectionEnd } = step;
  if (selectionStart !== selectionEnd) return undefined;
  if (browsing === undefined || browsing !== draft) {
    return draft === "" && direction === "older" ? history[0] : undefined;
  }
  if (selectionStart !== 0 && selectionStart !== draft.length) return undefined;
  const position = history.indexOf(draft);
  if (position < 0) return undefined;
  if (direction === "older") return history[position + 1] ?? draft;
  return position === 0 ? "" : history[position - 1];
}
