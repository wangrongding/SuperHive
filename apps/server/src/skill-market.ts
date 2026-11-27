import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import {
  cleanExternalText,
  normalizeSkillQuery,
  normalizeSkillSearch,
  serverText,
  SKILL_ID_PATTERN,
  SKILL_OWNER_PATTERN,
  SKILL_SEARCH_URL,
  SKILL_SOURCE_PATTERN,
  type SkillInstallFile,
  type SkillSearchItem,
} from "@superhive/protocol";
import { HiveError } from "./database.js";
import { parseSkillFrontmatter } from "./runtime-skills.js";

/**
 * 从网上找 skill、下载到内存（只限本机房主，路由在 runtime-config-routes.ts）。借鉴 vercel-labs/skills
 * （`npx skills`）的做法，但不调用它的 CLI：
 * - 搜索：代理 skills.sh 的 `/api/search`，见 @superhive/protocol 的 skill-market.ts；
 * - 下载：先问 GitHub 当前提交号，按提交号取整棵目录树（可执行位、软链从树里读），找到这个 skill 的目录；
 *   内容先用 skills.sh 的 `/api/download` 快照（一次请求），每个文件都按树里的 Git blob sha 核对，
 *   缺的、对不上的（二进制、快照落后）再从 raw.githubusercontent.com 按提交号单独取；
 *   GitHub 接口匿名额度（60 次/小时）用完或暂时连不上时，只用快照，标成未核对；
 * - 只认 GitHub 的 owner/repo 和固定的几个域名，不跟随跳到别的域名；限制文件数、单个和总大小、超时；
 *   路径里有 ..、绝对路径、反斜杠、控制字符的整包拒绝。下载的东西只当数据，这里不执行任何文件。
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const ALLOWED_HOSTS = new Set([
  "skills.sh",
  "www.skills.sh",
  "api.github.com",
  "raw.githubusercontent.com",
]);
const DOWNLOAD_URL = "https://skills.sh/api/download";
const TIMEOUT_MS = 15_000;
const MAX_FILES = 300;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
/** 目录名对不上 skillId 时，最多读几个 SKILL.md 的 frontmatter 来认 */
const MAX_NAME_PROBES = 30;
const CONCURRENCY = 6;
const TREE_TTL_MS = 10 * 60 * 1000;
const EXCLUDED_FILES = new Set(["metadata.json"]);
const EXCLUDED_DIRS = new Set([".git", "__pycache__", "__pypackages__"]);
const SCRIPT_EXT =
  /\.(sh|bash|zsh|fish|py|pyw|js|mjs|cjs|ts|mts|cts|rb|pl|php|lua|ps1|psm1|bat|cmd|vbs|applescript|scpt|exe|dll|so|dylib|jar|bin|command)$/i;
const DOC_EXT = /\.(md|mdx|markdown|txt|rst|adoc)$/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export type SkillPackageFile = SkillInstallFile & { data: Buffer };

export type SkillPackage = {
  source: string;
  skillId: string;
  name: string;
  description: string;
  /** 目录名：装进各运行时用这个 */
  dirName: string;
  repoPath: string;
  commit?: string;
  verified: boolean;
  url: string;
  skillMd: string;
  files: SkillPackageFile[];
  skipped: Array<{ path: string; reason: "symlink" | "submodule" | "excluded" }>;
  totalBytes: number;
};

type TreeEntry = { path: string; mode: string; type: string; sha: string; size?: number };
type RepoTree = { commit: string; entries: TreeEntry[] };

class MarketFailure extends Error {
  constructor(
    readonly kind: "unavailable" | "rateLimited" | "notFound",
    readonly reason: string,
  ) {
    super(reason);
  }
}

function unavailable(site: string, reason: string) {
  return new HiveError(
    "SKILL_MARKET_UNAVAILABLE",
    serverText("error.skillMarket.unavailable", { site, reason }),
  );
}
function notFound(source: string, skill: string) {
  return new HiveError(
    "SKILL_MARKET_NOT_FOUND",
    serverText("error.skillMarket.notFound", { source, skill }),
  );
}
function badFile(skill: string, file: string, reason: string) {
  return new HiveError(
    "SKILL_MARKET_BAD_PACKAGE",
    serverText("error.skillMarket.badFile", { skill, path: file, reason }),
  );
}
function tooLarge(skill: string, reason: string) {
  return new HiveError(
    "SKILL_MARKET_BAD_PACKAGE",
    serverText("error.skillMarket.tooLarge", { skill, reason }),
  );
}

/** 相对 skill 目录的路径：不能逃出目录，不能是绝对路径、带反斜杠或控制字符 */
export function safeRelativePath(value: string): boolean {
  if (!value || value.length > 400 || CONTROL.test(value) || value.includes("\\")) return false;
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  const parts = value.split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== "..");
}

function excluded(relative: string) {
  const parts = relative.split("/");
  return parts.some((part, index) =>
    index < parts.length - 1 ? EXCLUDED_DIRS.has(part) : EXCLUDED_FILES.has(part),
  );
}

/** 和 skills.sh 一致的 slug：frontmatter name → skillId */
export function toSkillSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function classifyFile(
  relative: string,
  data: Buffer,
  executable: boolean,
): SkillInstallFile["kind"] {
  const head = data.subarray(0, 8000);
  if (head.includes(0)) return SCRIPT_EXT.test(relative) ? "script" : "binary";
  if (executable || SCRIPT_EXT.test(relative) || head.subarray(0, 2).toString() === "#!") {
    return "script";
  }
  return DOC_EXT.test(relative) ? "doc" : "other";
}

function gitBlobSha(data: Buffer) {
  return createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
}

async function mapLimit<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await run(items[index]!);
      }
    }),
  );
  return results;
}

export class SkillMarket {
  private readonly trees = new Map<string, { at: number; tree: RepoTree }>();

  constructor(
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    private readonly now: () => number = Date.now,
  ) {}

  /** 只去白名单里的域名；跳转到别处、超时、超大都当连不上 */
  private async get(url: string, accept: string, maxBytes: number) {
    const site = new URL(url).host;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { Accept: accept, "User-Agent": "superhive-skills" },
        redirect: "follow",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new MarketFailure("unavailable", (error as Error).name || "network error");
    }
    if (response.url) {
      const final = new URL(response.url);
      if (final.protocol !== "https:" || !ALLOWED_HOSTS.has(final.host)) {
        throw new MarketFailure("unavailable", `redirected to ${final.host}`);
      }
    }
    if (response.status === 404) throw new MarketFailure("notFound", "404");
    if (response.status === 403 || response.status === 429) {
      throw new MarketFailure("rateLimited", String(response.status));
    }
    if (!response.ok) throw new MarketFailure("unavailable", `HTTP ${response.status}`);
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > maxBytes) throw new MarketFailure("unavailable", "too large");
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > maxBytes) throw new MarketFailure("unavailable", "too large");
    return { data, site };
  }

  private async json(url: string, maxBytes = MAX_JSON_BYTES): Promise<unknown> {
    const { data } = await this.get(url, "application/json", maxBytes);
    try {
      return JSON.parse(data.toString("utf8"));
    } catch {
      throw new MarketFailure("unavailable", "invalid JSON");
    }
  }

  /* ---------- 搜索 ---------- */

  async search(rawQuery: string, owner?: string): Promise<SkillSearchItem[]> {
    const query = normalizeSkillQuery(rawQuery);
    if (!query || (owner !== undefined && !SKILL_OWNER_PATTERN.test(owner))) {
      throw new HiveError("RUNTIME_CONFIG_INVALID", serverText("error.skillMarket.query"));
    }
    const params = new URLSearchParams({ q: query });
    if (owner) params.set("owner", owner.toLowerCase());
    try {
      return normalizeSkillSearch(
        await this.json(`${SKILL_SEARCH_URL}?${params}`, 2 * 1024 * 1024),
      );
    } catch (error) {
      if (error instanceof MarketFailure) throw unavailable("skills.sh", error.reason);
      throw error;
    }
  }

  /* ---------- 下载 ---------- */

  async fetchSkill(source: string, skillId: string): Promise<SkillPackage> {
    if (!SKILL_SOURCE_PATTERN.test(source) || !SKILL_ID_PATTERN.test(skillId)) {
      throw new HiveError("RUNTIME_CONFIG_INVALID", serverText("error.request.invalid"));
    }
    let tree: RepoTree | undefined;
    try {
      tree = await this.tree(source);
    } catch (error) {
      if (!(error instanceof MarketFailure)) throw error;
      if (error.kind === "notFound") throw notFound(source, skillId);
      // GitHub 匿名额度用完或连不上：退回 skills.sh 的快照
      return this.fromSnapshot(source, skillId, error.reason);
    }
    return this.fromGitHub(source, skillId, tree);
  }

  private async tree(source: string): Promise<RepoTree> {
    const cached = this.trees.get(source.toLowerCase());
    if (cached && this.now() - cached.at < TREE_TTL_MS) return cached.tree;
    const { data } = await this.get(
      `https://api.github.com/repos/${source}/commits/HEAD`,
      "application/vnd.github.sha",
      1024,
    );
    const commit = data.toString("utf8").trim().toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new MarketFailure("unavailable", "bad commit");
    const body = (await this.json(
      `https://api.github.com/repos/${source}/git/trees/${commit}?recursive=1`,
    )) as { tree?: unknown; truncated?: unknown };
    if (!Array.isArray(body.tree) || body.truncated === true) {
      throw new MarketFailure("unavailable", "tree truncated");
    }
    const entries = body.tree.filter(
      (entry): entry is TreeEntry =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as TreeEntry).path === "string" &&
        typeof (entry as TreeEntry).sha === "string" &&
        typeof (entry as TreeEntry).mode === "string" &&
        typeof (entry as TreeEntry).type === "string",
    );
    const tree = { commit, entries };
    this.trees.set(source.toLowerCase(), { at: this.now(), tree });
    if (this.trees.size > 50) this.trees.delete(this.trees.keys().next().value!);
    return tree;
  }

  private raw(source: string, commit: string, file: string, maxBytes: number) {
    const encoded = file.split("/").map(encodeURIComponent).join("/");
    return this.get(
      `https://raw.githubusercontent.com/${source}/${commit}/${encoded}`,
      "*/*",
      maxBytes,
    ).then((result) => result.data);
  }

  /** 找这个 skill 在仓库里的目录：先按目录名对 skillId，再读 SKILL.md 的 name 对 */
  private async locate(source: string, skillId: string, tree: RepoTree): Promise<string> {
    const skillMds = tree.entries
      .filter((entry) => entry.type === "blob" && /(^|\/)skill\.md$/i.test(entry.path))
      .map((entry) => entry.path)
      .filter((file) => !file.split("/").some((part) => part === "node_modules"));
    const folderOf = (file: string) => file.split("/").slice(0, -1).join("/");
    const wanted = skillId.toLowerCase();
    const byFolder = skillMds
      .filter((file) => {
        const folder = folderOf(file);
        return folder && toSkillSlug(folder.split("/").at(-1)!) === wanted;
      })
      .sort((a, b) => a.split("/").length - b.split("/").length || a.length - b.length);
    if (byFolder.length) return byFolder[0]!;
    const probes = skillMds
      .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))
      .slice(0, MAX_NAME_PROBES);
    const names = await mapLimit(probes, CONCURRENCY, async (file) => {
      try {
        const content = (await this.raw(source, tree.commit, file, 256 * 1024)).toString("utf8");
        return parseSkillFrontmatter(content).name;
      } catch {
        return undefined;
      }
    });
    const index = names.findIndex((name) => name && toSkillSlug(name) === wanted);
    if (index < 0) throw notFound(source, skillId);
    return probes[index]!;
  }

  private async fromGitHub(source: string, skillId: string, tree: RepoTree) {
    const skillMdPath = await this.locate(source, skillId, tree);
    const folder = skillMdPath.split("/").slice(0, -1).join("/");
    const prefix = folder ? `${folder}/` : "";
    const skipped: SkillPackage["skipped"] = [];
    const wanted: TreeEntry[] = [];
    for (const entry of tree.entries) {
      if (folder ? !entry.path.startsWith(prefix) : entry.path !== skillMdPath) continue;
      const relative = entry.path.slice(prefix.length);
      if (entry.type === "tree") continue;
      if (!safeRelativePath(relative)) throw badFile(skillId, relative, "path");
      if (entry.type === "commit") {
        skipped.push({ path: relative, reason: "submodule" });
      } else if (entry.mode === "120000") {
        // 软链可能指向 skill 目录外面，不跟
        skipped.push({ path: relative, reason: "symlink" });
      } else if (excluded(relative)) {
        skipped.push({ path: relative, reason: "excluded" });
      } else if (entry.type === "blob") {
        wanted.push(entry);
      }
    }
    if (wanted.length > MAX_FILES) throw tooLarge(skillId, `> ${MAX_FILES} files`);
    const declared = wanted.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
    if (declared > MAX_TOTAL_BYTES) throw tooLarge(skillId, "> 10 MB");
    // 内容先用 skills.sh 的快照（一次请求），逐个文件按树里的 blob sha 核对；对不上或缺的再从
    // raw.githubusercontent.com 按提交号单独取（和 npx skills 的快速路径一样）
    const cached = new Map<string, Buffer>();
    if (wanted.length > 1) {
      for (const item of await this.snapshotFiles(source, skillId).catch(() => [])) {
        cached.set(item.path, item.data);
      }
    }
    const files = await mapLimit(wanted, CONCURRENCY, async (entry) => {
      const relative = entry.path.slice(prefix.length);
      let data = cached.get(relative);
      if (!data || gitBlobSha(data) !== entry.sha) {
        data = await this.rawWithRetry(source, tree.commit, entry.path);
      }
      if (gitBlobSha(data) !== entry.sha) throw badFile(skillId, relative, "sha mismatch");
      const executable = entry.mode === "100755";
      return {
        path: relative,
        size: data.length,
        executable,
        kind: classifyFile(relative, data, executable),
        data,
      } satisfies SkillPackageFile;
    });
    return this.finish({
      source,
      skillId,
      repoPath: folder,
      commit: tree.commit,
      verified: true,
      url: `https://github.com/${source}/tree/${tree.commit}${folder ? `/${folder}` : ""}`,
      files,
      skipped,
    });
  }

  /** raw.githubusercontent.com 偶尔连不上：失败再试一次 */
  private async rawWithRetry(source: string, commit: string, file: string) {
    let last: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.raw(source, commit, file, MAX_FILE_BYTES);
      } catch (error) {
        last = error;
        if (error instanceof MarketFailure && error.kind === "notFound") break;
      }
    }
    if (last instanceof MarketFailure) {
      throw unavailable("raw.githubusercontent.com", last.reason);
    }
    throw last;
  }

  /** skills.sh 的快照：{ files: [{ path, contents }] }，内容都是文本 */
  private async snapshotFiles(source: string, skillId: string) {
    const [owner, repo] = source.split("/");
    const body = await this.json(
      `${DOWNLOAD_URL}/${encodeURIComponent(owner!)}/${encodeURIComponent(repo!)}/${encodeURIComponent(skillId.toLowerCase())}`,
      MAX_TOTAL_BYTES * 2,
    );
    const list = (body as { files?: unknown } | null)?.files;
    if (!Array.isArray(list)) throw new MarketFailure("unavailable", "invalid snapshot");
    if (list.length > MAX_FILES) throw tooLarge(skillId, `> ${MAX_FILES} files`);
    return list.map((item) => {
      const entry = item as { path?: unknown; contents?: unknown } | null;
      if (typeof entry?.path !== "string" || typeof entry.contents !== "string") {
        throw new MarketFailure("unavailable", "invalid snapshot");
      }
      return { path: entry.path, data: Buffer.from(entry.contents, "utf8") };
    });
  }

  private async fromSnapshot(source: string, skillId: string, why: string) {
    let list: Array<{ path: string; data: Buffer }>;
    try {
      list = await this.snapshotFiles(source, skillId);
    } catch (error) {
      if (error instanceof MarketFailure) {
        if (error.kind === "notFound") throw notFound(source, skillId);
        throw unavailable("GitHub / skills.sh", `${why}; ${error.reason}`);
      }
      throw error;
    }
    const skipped: SkillPackage["skipped"] = [];
    const files: SkillPackageFile[] = [];
    let total = 0;
    for (const entry of list) {
      if (!safeRelativePath(entry.path)) {
        throw badFile(skillId, cleanExternalText(entry.path), "path");
      }
      if (excluded(entry.path)) {
        skipped.push({ path: entry.path, reason: "excluded" });
        continue;
      }
      if (entry.data.length > MAX_FILE_BYTES) throw tooLarge(skillId, `${entry.path} > 2 MB`);
      total += entry.data.length;
      if (total > MAX_TOTAL_BYTES) throw tooLarge(skillId, "> 10 MB");
      files.push({
        path: entry.path,
        size: entry.data.length,
        executable: false,
        kind: classifyFile(entry.path, entry.data, false),
        data: entry.data,
      });
    }
    return this.finish({
      source,
      skillId,
      repoPath: "",
      verified: false,
      url: `https://github.com/${source}`,
      files,
      skipped,
    });
  }

  private finish(
    base: Pick<
      SkillPackage,
      "source" | "skillId" | "repoPath" | "commit" | "verified" | "url" | "files" | "skipped"
    >,
  ): SkillPackage {
    // SKILL.md 放最前，其余按路径
    const rank = (file: SkillPackageFile) => (file.path.toLowerCase() === "skill.md" ? 0 : 1);
    const files = [...base.files].sort(
      (a, b) => rank(a) - rank(b) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    );
    const lower = new Set<string>();
    for (const file of files) {
      // 大小写不敏感的文件系统（macOS、Windows）上两个文件会写成一个
      const key = file.path.toLowerCase();
      if (lower.has(key)) throw badFile(base.skillId, file.path, "duplicate name");
      lower.add(key);
    }
    const skillMdFile = files.find((file) => file.path.toLowerCase() === "skill.md");
    if (!skillMdFile) throw badFile(base.skillId, "SKILL.md", "missing");
    const skillMd = skillMdFile.data.toString("utf8");
    const front = parseSkillFrontmatter(skillMd);
    const folderName = base.repoPath.split("/").at(-1) ?? "";
    const dirName = SKILL_ID_PATTERN.test(folderName) ? folderName : base.skillId;
    if (path.basename(dirName) !== dirName) throw badFile(base.skillId, dirName, "path");
    return {
      ...base,
      files,
      name: cleanExternalText(front.name, 128) || dirName,
      description: cleanExternalText(front.description, 1024),
      dirName,
      skillMd,
      totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    };
  }
}

const PLAN_TTL_MS = 10 * 60 * 1000;
const MAX_PLANS = 8;

/** 预览时下载好的内容：确认安装时写的就是这一份，用过一次或过期就作废 */
export class SkillInstallPlans {
  private readonly plans = new Map<string, { expiresAt: number; pkg: SkillPackage }>();

  constructor(private readonly now: () => number = Date.now) {}

  create(pkg: SkillPackage) {
    for (const [id, plan] of this.plans) if (plan.expiresAt <= this.now()) this.plans.delete(id);
    while (this.plans.size >= MAX_PLANS) this.plans.delete(this.plans.keys().next().value!);
    const id = randomUUID();
    const expiresAt = this.now() + PLAN_TTL_MS;
    this.plans.set(id, { expiresAt, pkg });
    return { id, expiresAt };
  }

  take(id: string): SkillPackage {
    const plan = this.plans.get(id);
    this.plans.delete(id);
    if (!plan || plan.expiresAt <= this.now()) {
      throw new HiveError("SKILL_MARKET_PLAN_STALE", serverText("error.skillMarket.planStale"));
    }
    return plan.pkg;
  }
}
