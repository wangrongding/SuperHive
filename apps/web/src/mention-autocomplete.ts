import type { Participant } from "@ai-hive/protocol";

export type MentionContext = {
  start: number;
  end: number;
  query: string;
};

const usernameCharacter = /[\p{L}\p{N}_.-]/u;

export function findMentionContext(value: string, cursor: number): MentionContext | undefined {
  const safeCursor = Math.max(0, Math.min(cursor, value.length));
  const beforeCursor = value.slice(0, safeCursor);
  const atIndex = beforeCursor.lastIndexOf("@");
  if (atIndex < 0) return undefined;

  const characterBeforeAt = value[atIndex - 1];
  if (characterBeforeAt && usernameCharacter.test(characterBeforeAt)) return undefined;

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
