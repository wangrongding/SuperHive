/**
 * 飞书里没法 @ 房间的 Agent（它们不在飞书通讯录里），这里把消息里的简写解析成 Agent 全名：
 * 「@codex 看下」「codex 看下」→「@rd-codex 看下」。按匹配强度分层，取最强的一层：
 * 全名相同 > 去掉公共前缀后相同 > 去掉前缀后开头相同 > 包含。后两层只用于带 @ 的写法：
 * 不带 @ 的开头一个词必须和名字完全对上，否则「code review」「open 一下」会被误当成 rd-codex、rd-opencode。
 * 一层里多个候选就交给人点选，不猜。
 */

export type AliasResult =
  | { kind: "none" }
  | { kind: "resolved"; content: string }
  | { kind: "ambiguous"; token: string; candidates: string[] };

/** 房间里 Agent 名字的公共前缀（到最后一个分隔符为止），如 rd-claude、rd-codex 的「rd-」 */
export function commonPrefix(names: string[]): string {
  if (names.length < 2) return "";
  let prefix = names[0]!.toLowerCase();
  for (const name of names.slice(1)) {
    const lower = name.toLowerCase();
    let index = 0;
    while (index < prefix.length && prefix[index] === lower[index]) index += 1;
    prefix = prefix.slice(0, index);
  }
  const cut = Math.max(prefix.lastIndexOf("-"), prefix.lastIndexOf("_"), prefix.lastIndexOf("."));
  return cut >= 0 ? prefix.slice(0, cut + 1) : "";
}

export function matchAgents(token: string, agents: string[], mode: "exact" | "loose"): string[] {
  const query = token.toLowerCase();
  if (!query) return [];
  const prefix = commonPrefix(agents);
  const short = (name: string) => {
    const lower = name.toLowerCase();
    return prefix && lower.startsWith(prefix) ? lower.slice(prefix.length) : lower;
  };
  const tiers: Array<(name: string) => boolean> = [
    (name) => name.toLowerCase() === query,
    (name) => short(name) === query,
    ...(mode === "loose"
      ? [
          (name: string) => short(name).startsWith(query) || name.toLowerCase().startsWith(query),
          ...(query.length >= 2 ? [(name: string) => name.toLowerCase().includes(query)] : []),
        ]
      : []),
  ];
  for (const tier of tiers) {
    const hits = agents.filter(tier);
    if (hits.length) return hits;
  }
  return [];
}

const MENTION = /@([\p{L}\p{N}_.-]+)/gu;
const LEADING_WORD = /^([A-Za-z][A-Za-z0-9_.-]{1,31})(?=[\s,，:：])/;

export function resolveAliases(text: string, agents: string[]): AliasResult {
  if (!agents.length) return { kind: "none" };
  const exact = new Set(agents.map((name) => name.toLowerCase()));
  let changed = false;
  let ambiguous: AliasResult | undefined;
  const content = text.replace(MENTION, (whole, token: string) => {
    if (ambiguous || exact.has(token.toLowerCase())) return whole;
    const hits = matchAgents(token, agents, "loose");
    if (hits.length === 1) {
      changed = true;
      return `@${hits[0]}`;
    }
    if (hits.length > 1) ambiguous = { kind: "ambiguous", token, candidates: hits };
    return whole;
  });
  if (ambiguous) return ambiguous;
  if (changed) return { kind: "resolved", content };
  // 不带 @ 的开头一个词：只认完全对上的名字，避免把普通英文单词误当成 Agent
  if (/@[\p{L}\p{N}_.-]/u.test(text)) return { kind: "none" };
  const word = LEADING_WORD.exec(text)?.[1];
  if (!word) return { kind: "none" };
  const hits = matchAgents(word, agents, "exact");
  if (hits.length === 1) {
    return { kind: "resolved", content: `@${hits[0]}${text.slice(word.length)}` };
  }
  if (hits.length > 1) return { kind: "ambiguous", token: word, candidates: hits };
  return { kind: "none" };
}

/** 选好之后：把简写换成选中的全名（开头不带 @ 的词也一起换掉） */
export function applyChoice(text: string, token: string, agent: string): string {
  // u 模式下「-」不能转义，它在字符类外本来就不是元字符
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const withAt = new RegExp(`@${escaped}(?![\\p{L}\\p{N}_.-])`, "u");
  if (withAt.test(text)) return text.replace(withAt, `@${agent}`);
  const leading = new RegExp(`^${escaped}(?=[\\s,，:：])`, "u");
  if (leading.test(text)) return text.replace(leading, `@${agent}`);
  return `@${agent} ${text}`;
}
