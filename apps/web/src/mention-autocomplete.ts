import type { Participant } from "@ai-hive/protocol";

export type MentionContext = {
  start: number;
  end: number;
  query: string;
};

const usernameCharacter = /[\p{L}\p{N}_.-]/u;
/**
 * @ 紧贴在这些字符后面时不当作提及（如邮箱 a@b.com）。只排除 ASCII 字母数字：
 * 中文正文里习惯直接写「你好@rd-claude」，服务端也会照常唤醒，输入框和高亮要与之一致。
 */
const emailLocalCharacter = /[A-Za-z0-9_.]/;

export function findMentionContext(value: string, cursor: number): MentionContext | undefined {
  const safeCursor = Math.max(0, Math.min(cursor, value.length));
  const beforeCursor = value.slice(0, safeCursor);
  const atIndex = beforeCursor.lastIndexOf("@");
  if (atIndex < 0) return undefined;

  const characterBeforeAt = value[atIndex - 1];
  if (characterBeforeAt && emailLocalCharacter.test(characterBeforeAt)) return undefined;

  const query = beforeCursor.slice(atIndex + 1);
  if (query.length > 32 || [...query].some((character) => !usernameCharacter.test(character))) {
    return undefined;
  }
  return { start: atIndex, end: safeCursor, query };
}

export function filterMentionParticipants(
  participants: Participant[],
  query: string,
  currentUsername: string,
  limit = 8,
): Participant[] {
  const normalizedQuery = query.toLocaleLowerCase();
  const normalizedCurrentUsername = currentUsername.toLocaleLowerCase();
  return participants
    .filter(
      (participant) =>
        participant.username.toLocaleLowerCase() !== normalizedCurrentUsername &&
        participant.username.toLocaleLowerCase().includes(normalizedQuery),
    )
    .sort((left, right) => {
      const leftPrefix = left.username.toLocaleLowerCase().startsWith(normalizedQuery) ? 0 : 1;
      const rightPrefix = right.username.toLocaleLowerCase().startsWith(normalizedQuery) ? 0 : 1;
      if (leftPrefix !== rightPrefix) return leftPrefix - rightPrefix;
      const leftOffline = left.status === "offline" ? 1 : 0;
      const rightOffline = right.status === "offline" ? 1 : 0;
      if (leftOffline !== rightOffline) return leftOffline - rightOffline;
      return left.username.localeCompare(right.username);
    })
    .slice(0, limit);
}

export function applyMention(
  value: string,
  context: MentionContext,
  username: string,
): { value: string; cursor: number } {
  const hasWhitespaceAfter = /\s/u.test(value[context.end] ?? "");
  const replacement = `@${username}${hasWhitespaceAfter ? "" : " "}`;
  return {
    value: `${value.slice(0, context.start)}${replacement}${value.slice(context.end)}`,
    cursor: context.start + replacement.length + (hasWhitespaceAfter ? 1 : 0),
  };
}

// 与消息正文的高亮规则一致：@ 前不能紧贴 ASCII 字母数字（邮箱），中文后可以直接 @
const mentionTokenPattern = /(?<![A-Za-z0-9_.])@[\p{L}\p{N}_.-]+/gu;

export type DraftSegment = { text: string; mention: boolean };

/** 把草稿切成普通文本与 @提及 片段，供输入框背后的高亮层渲染 */
export function splitDraftMentions(value: string): DraftSegment[] {
  const segments: DraftSegment[] = [];
  let cursor = 0;
  for (const match of value.matchAll(mentionTokenPattern)) {
    if (match.index > cursor)
      segments.push({ text: value.slice(cursor, match.index), mention: false });
    segments.push({ text: match[0], mention: true });
    cursor = match.index + match[0].length;
  }
  if (cursor < value.length) segments.push({ text: value.slice(cursor), mention: false });
  return segments;
}

/** 草稿里是否已经 @ 了这个人（大小写不敏感，@bob 不算 @bobby） */
export function draftMentions(value: string, username: string): boolean {
  const normalized = `@${username}`.toLocaleLowerCase();
  for (const match of value.matchAll(mentionTokenPattern)) {
    if (match[0].toLocaleLowerCase() === normalized) return true;
  }
  return false;
}
