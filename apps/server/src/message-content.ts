import type { ChatMessage } from "@ai-hive/protocol";

export const MESSAGE_PREVIEW_CHARS = 4000;
export const MESSAGE_READ_MAX_CHARS = 8000;

export type MessageContentPage = {
  messageId: string;
  seq: number;
  senderName: string;
  senderType: ChatMessage["senderType"];
  content: string;
  /** Offsets and lengths use UTF-16 code units, as do protocol message length limits. */
  offset: number;
  totalLength: number;
  nextOffset: number | null;
  offsetUnit: "utf16";
};

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** Bounded exact slices of stored text; never split a surrogate pair or skip unread text. */
export function readMessageContent(
  message: ChatMessage,
  offset = 0,
  maxChars = MESSAGE_PREVIEW_CHARS,
): MessageContentPage {
  const text = message.content;
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length) {
    throw new Error("offset 超出正文范围；请使用返回的 nextOffset，或从 0 开始读取。");
  }
  if (!Number.isInteger(maxChars) || maxChars < 2 || maxChars > MESSAGE_READ_MAX_CHARS) {
    throw new Error(`maxChars 必须是 2 到 ${MESSAGE_READ_MAX_CHARS} 之间的整数。`);
  }
  if (offset > 0 && isHigh(text.charCodeAt(offset - 1)) && isLow(text.charCodeAt(offset))) {
    throw new Error("offset 不能落在字符的 UTF-16 代理对中间；请使用返回的 nextOffset。");
  }
  let end = Math.min(offset + maxChars, text.length);
  if (isHigh(text.charCodeAt(end - 1)) && isLow(text.charCodeAt(end))) end -= 1;
  return {
    messageId: message.id,
    seq: message.seq,
    senderName: message.senderName,
    senderType: message.senderType,
    content: text.slice(offset, end),
    offset,
    totalLength: text.length,
    nextOffset: end < text.length ? end : null,
    offsetUnit: "utf16",
  };
}

/** History reads stay previews; callers explicitly page only the long messages they need. */
export function previewMessage(message: ChatMessage, maxChars = MESSAGE_PREVIEW_CHARS) {
  if (message.content.length <= maxChars) return message;
  const page = readMessageContent(message, 0, maxChars);
  return {
    ...message,
    content: page.content,
    contentTruncated: true,
    totalLength: page.totalLength,
    nextOffset: page.nextOffset,
    offsetUnit: page.offsetUnit,
  };
}
