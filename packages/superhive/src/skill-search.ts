import http from "node:http";
import { parseArgs } from "node:util";
import { useEnvProxy } from "./claude-models.js";

/**
 * `hive skill search <词> [--owner NAME] [--json]`：在 skills.sh 上搜 skill（和网页「MCP 与技能 →
 * 发现 / 安装 → 技能」用同一个接口、同样的排序），只列出来，不安装；要装请到网页里预览后再装。
 *
 * 这个包不依赖 @superhive/protocol：下面的校验和排序照抄 packages/protocol/src/skill-market.ts，
 * 测试直接拿两边的结果比对，改一边要同步另一边。
 */

const SKILL_SEARCH_URL = "https://skills.sh/api/search";
const SKILL_SOURCE_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const SKILL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const SKILL_OWNER_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38})$/i;
const POPULAR_OWNERS = [
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
];
const LIMIT = 100;

export type SkillSearchItem = {
  id: string;
  source: string;
  skillId: string;
  name: string;
  installs: number;
  popular: boolean;
};

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const clean = (value: unknown, max: number) =>
  typeof value === "string" ? value.replace(CONTROL, "").trim().slice(0, max) : "";

export function normalizeSkillQuery(value: string): string | undefined {
  const query = value.trim();
  // eslint-disable-next-line no-control-regex
  if (query.length < 2 || query.length > 100 || /[\u0000-\u001f\u007f]/.test(query))
    return undefined;
  return query;
}

export function normalizeSkillSearch(raw: unknown): SkillSearchItem[] {
  const list = (raw as { skills?: unknown } | null)?.skills;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const items: SkillSearchItem[] = [];
  for (const entry of list.slice(0, LIMIT * 2)) {
    const value = entry as Record<string, unknown> | null;
    if (!value || typeof value !== "object") continue;
    const source = clean(value.source, 140);
    const skillId = clean(value.skillId, 128);
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
      name: clean(value.name, 128) || skillId,
      installs,
      popular: POPULAR_OWNERS.includes(source.split("/")[0]!.toLowerCase()),
    });
  }
  items.sort((a, b) => b.installs - a.installs || Number(b.popular) - Number(a.popular));
  return items.slice(0, LIMIT);
}

export function formatSkillInstalls(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(count);
}

export type SkillSearchFetch = (url: string, init?: RequestInit) => Promise<Response>;

export async function searchSkills(
  query: string,
  owner: string | undefined,
  fetchImpl: SkillSearchFetch,
): Promise<SkillSearchItem[]> {
  const params = new URLSearchParams({ q: query });
  if (owner) params.set("owner", owner.toLowerCase());
  let response: Response;
  try {
    response = await fetchImpl(`${SKILL_SEARCH_URL}?${params}`, {
      headers: { Accept: "application/json", "User-Agent": "superhive-skills" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new Error(
      `skills.sh 暂时连不上（${(error as Error).name || "network error"}），稍后再试。`,
    );
  }
  if (!response.ok) throw new Error(`skills.sh 暂时连不上（HTTP ${response.status}），稍后再试。`);
  return normalizeSkillSearch(await response.json().catch(() => ({})));
}

export function formatSkillResults(items: SkillSearchItem[], query: string): string {
  if (!items.length) return `skills.sh 上没有找到「${query}」，换个词试试。\n`;
  const width = Math.min(48, Math.max(...items.map((item) => item.id.length)));
  const lines = items.map((item) => {
    const installs = formatSkillInstalls(item.installs).padStart(6);
    const popular = item.popular ? "  常用来源" : "";
    return `${item.id.padEnd(width)}  ${installs} 次安装${popular}`;
  });
  return [
    `skills.sh 上「${query}」的结果（${items.length} 个，按安装量排序）：`,
    ...lines,
    "",
    "要安装：在网页里打开「MCP 与技能 → 发现 / 安装 → 技能」，搜同一个词，预览后选要装给哪些 CLI。",
    "",
  ].join("\n");
}

export async function skillSearchCommand(
  args: string[],
  options: { fetch?: SkillSearchFetch; write?: (text: string) => void } = {},
): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { owner: { type: "string" }, json: { type: "boolean" } },
  });
  const query = normalizeSkillQuery(positionals.join(" "));
  if (!query) {
    throw new Error(
      "用法：hive skill search <词> [--owner GitHub用户名] [--json]（词要 2～100 个字）。",
    );
  }
  if (values.owner !== undefined && !SKILL_OWNER_PATTERN.test(values.owner)) {
    throw new Error(
      `--owner 要写 GitHub 用户名或组织名，例如 anthropics；收到的是“${values.owner}”。`,
    );
  }
  if (!options.fetch) {
    useEnvProxy(
      process.env,
      (http as { setGlobalProxyFromEnv?: (env: NodeJS.ProcessEnv) => unknown })
        .setGlobalProxyFromEnv,
    );
  }
  const items = await searchSkills(query, values.owner, options.fetch ?? fetch);
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  write(
    values.json
      ? `${JSON.stringify({ query, skills: items }, null, 2)}\n`
      : formatSkillResults(items, query),
  );
}
