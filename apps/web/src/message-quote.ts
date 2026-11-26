/**
 * 引用回复：右键「引用回复」往输入框里插的 Markdown 引用块，以及发出去以后把它认回来渲染成引用卡片。
 *
 * 引用块长这样（第一行是固定格式的头，Agent 和旧客户端读到的就是这段 Markdown）：
 *
 *   > #123 · rd-claude
 *   > 摘要第一行
 *   > 摘要第二行…
 */

import { plainPreview } from "./activity";
import { t } from "./i18n";

/** 摘要最多几行、每行多少字；选中引用整段放进去，但也有上限 */
const EXCERPT_LINES = 3;
const EXCERPT_LINE_CHARS = 120;
const SELECTION_MAX_CHARS = 1000;

const headerPattern = /^> #(\d+) · (.+)$/;

/** 引用块的头一行 */
export function quoteHeader(seq: number, senderName: string): string {
  return `> #${seq} · ${senderName}`;
}

/**
 * 引用里的 @ 换成全角 ＠：引用别人的话不该再把原文里 @ 到的人重新叫醒一遍
 */
export function neutralizeMentions(text: string): string {
  return text.replace(/(?<![A-Za-z0-9_.])@(?=[\p{L}\p{N}_.-])/gu, "＠");
}

/** 正文开头的引用块（上一层引用）：摘要里不再套娃 */
export function stripLeadingQuote(content: string): string {
  const lines = content.split("\n");
  if (!headerPattern.test(lines[0] ?? "")) return content;
  let index = 1;
  while (index < lines.length && /^>/.test(lines[index]!)) index += 1;
  while (index < lines.length && !lines[index]!.trim()) index += 1;
  return lines.slice(index).join("\n");
}

function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
}

/**
 * 整条引用时的摘要：代码块缩成「[代码]」，每行去掉 Markdown 记号（**粗体**、列表符号、链接写法），
 * 取前几行、每行截短
 */
export function quoteExcerpt(content: string): string[] {
  const code = t(" [代码] ").trim();
  const lines = stripLeadingQuote(content)
    .replace(
      /^[ \t]*(`{3,}|~{3,})[^\n]*(?:\n[\s\S]*?)?(?:\n[ \t]*\1[`~]*[ \t]*(?=\n|$)|(?![\s\S]))/gm,
      code,
    )
    .split("\n")
    .map((line) => plainPreview(line))
    .filter(Boolean);
  const picked = lines.slice(0, EXCERPT_LINES).map((line) => clip(line, EXCERPT_LINE_CHARS));
  if (lines.length > EXCERPT_LINES && picked.length) picked[picked.length - 1] += "…";
  return picked;
}

/** 选中引用：原样保留选中的几行（空行也留着），只限总长度 */
function selectionLines(selection: string): string[] {
  const lines = clip(selection.trim(), SELECTION_MAX_CHARS).split("\n");
  return lines.map((line) => line.trimEnd());
}

/** 一整块引用；selection 有内容时只引用选中的那段 */
export function buildQuoteBlock(quote: {
  seq: number;
  senderName: string;
  content: string;
  selection?: string | undefined;
}): string {
  const body = quote.selection?.trim()
    ? selectionLines(quote.selection)
    : quoteExcerpt(quote.content);
  return [
    quoteHeader(quote.seq, quote.senderName),
    ...body.map((line) => (line ? `> ${neutralizeMentions(line)}` : ">")),
  ].join("\n");
}

/**
 * 把引用块放进草稿：草稿开头已有的引用块（上次点的引用）换掉，原来写的字留在引用下面；
 * mention 是要顺手 @ 的 Agent（草稿里已经 @ 过就不重复）。返回新草稿和光标位置（末尾）
 */
export function insertQuote(
  draft: string,
  block: string,
  mention?: string,
): { value: string; cursor: number } {
  const rest = stripLeadingQuote(draft).replace(/^\s+/, "");
  const mentioned =
    mention &&
    new RegExp(
      `(?<![A-Za-z0-9_.])@${mention.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_.-])`,
      "iu",
    ).test(rest);
  const prefix = mention && !mentioned ? `@${mention} ` : "";
  const value = `${block}\n\n${prefix}${rest}`;
  return { value, cursor: value.length };
}

/** 草稿里还留着引用 #seq 的头：发送时才带上引用关系，删掉了引用块就当没引用 */
export function draftQuotes(draft: string, seq: number): boolean {
  return draft.split("\n").some((line) => {
    const match = headerPattern.exec(line.trim());
    return match?.[1] === String(seq);
  });
}

/**
 * 发出去的消息里认回引用块：正文以 #seq 的引用头开头时拆成摘录和其余正文。
 * 对不上（引用块被改过、挪到中间）时返回 undefined，正文照原样显示
 */
export function splitQuote(
  content: string,
  seq: number,
): { excerpt: string; body: string } | undefined {
  const lines = content.split("\n");
  const match = headerPattern.exec(lines[0] ?? "");
  if (match?.[1] !== String(seq)) return undefined;
  let index = 1;
  const excerpt: string[] = [];
  while (index < lines.length && /^>/.test(lines[index]!)) {
    excerpt.push(lines[index]!.replace(/^> ?/, ""));
    index += 1;
  }
  return { excerpt: excerpt.join("\n").trim(), body: lines.slice(index).join("\n").trim() };
}
