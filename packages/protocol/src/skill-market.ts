import { z } from "zod";

/**
 * 从网上找 skill：搜索借用 skills.sh 公开的 `GET /api/search?q=…[&owner=…]`（vercel-labs/skills 的
 * `npx skills find` 用的同一个接口，不用认证）。Server 端和 `hive skill search` 都用这里的校验和排序，
 * 网页、CLI 看到的一样。返回的名字、来源都是外部数据：只认 GitHub 的 owner/repo 写法，去掉控制字符。
 */

export const SKILL_SEARCH_URL = "https://skills.sh/api/search";
/** 搜索词：skills.sh 少于 2 个字符直接报错 */
export const SKILL_QUERY_MIN = 2;
export const SKILL_QUERY_MAX = 100;
/** skills.sh 一次最多回 100 条 */
export const SKILL_SEARCH_LIMIT = 100;

/** GitHub owner/repo */
export const SKILL_SOURCE_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
/** skills.sh 的 skillId：frontmatter name 的 slug */
export const SKILL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const SKILL_OWNER_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38})$/i;

/**
 * 「常用来源」：知名机构自己维护的 skill 仓库（按 GitHub owner 认）。只是帮人挑，不代表审计过内容。
 */
export const SKILL_POPULAR_OWNERS = [
  "anthropics",
  "openai",
  "vercel-labs",
  "vercel",
  "github",
  "microsoft",
  "google",
  "google-gemini",
  "cloudflare",
  "huggingface",
] as const;

export const skillSearchItemSchema = z.object({
  /** owner/repo/skillId */
  id: z.string(),
  /** GitHub owner/repo */
  source: z.string(),
  skillId: z.string(),
  name: z.string(),
  installs: z.number(),
  /** 来源仓库属于「常用来源」 */
  popular: z.boolean(),
});
export const skillSearchResponseSchema = z.object({
  query: z.string(),
  skills: z.array(skillSearchItemSchema),
});
export type SkillSearchItem = z.infer<typeof skillSearchItemSchema>;
export type SkillSearchResponse = z.infer<typeof skillSearchResponseSchema>;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/** 外部来的一行字：去掉控制字符和首尾空白，截到 max */
export function cleanExternalText(value: unknown, max = 200): string {
  if (typeof value !== "string") return "";
  return value.replace(CONTROL, "").trim().slice(0, max);
}

export function isPopularSkillSource(source: string): boolean {
  const owner = source.split("/")[0]!.toLowerCase();
  return (SKILL_POPULAR_OWNERS as readonly string[]).includes(owner);
}

/** 搜索词合不合用：去掉首尾空白后 2～100 个字符、没有控制字符 */
export function normalizeSkillQuery(value: string): string | undefined {
  const query = value.trim();
  if (query.length < SKILL_QUERY_MIN || query.length > SKILL_QUERY_MAX) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(query)) return undefined;
  return query;
}

/**
 * skills.sh 搜索结果 → 我们的列表：认不出的条目丢掉，同一 id 只留一条，按安装量从多到少，
 * 安装量一样时常用来源在前。
 */
export function normalizeSkillSearch(raw: unknown): SkillSearchItem[] {
  const list = (raw as { skills?: unknown } | null)?.skills;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const items: SkillSearchItem[] = [];
  for (const entry of list.slice(0, SKILL_SEARCH_LIMIT * 2)) {
    const value = entry as Record<string, unknown> | null;
    if (!value || typeof value !== "object") continue;
    const source = cleanExternalText(value.source, 140);
    const skillId = cleanExternalText(value.skillId, 128);
    if (!SKILL_SOURCE_PATTERN.test(source) || !SKILL_ID_PATTERN.test(skillId)) continue;
    const id = `${source}/${skillId}`;
    if (seen.has(id.toLowerCase())) continue;
    seen.add(id.toLowerCase());
    const installs =
      typeof value.installs === "number" && Number.isFinite(value.installs) && value.installs > 0
        ? Math.floor(value.installs)
        : 0;
    items.push({
      id,
      source,
      skillId,
      name: cleanExternalText(value.name, 128) || skillId,
      installs,
      popular: isPopularSkillSource(source),
    });
  }
  items.sort((a, b) => b.installs - a.installs || Number(b.popular) - Number(a.popular) || 0);
  return items.slice(0, SKILL_SEARCH_LIMIT);
}

/** 1234 → 1.2K，给列表和 CLI 用 */
export function formatSkillInstalls(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(count);
}
