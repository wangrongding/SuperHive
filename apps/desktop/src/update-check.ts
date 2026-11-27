/**
 * 桌面端检查新版：查 GitHub Releases 的最新正式版，有比当前新、并且带本平台安装包的版本时，
 * 交给网页显示一个不打扰的「有新版本」入口。下载和安装在 update-install.ts（Windows 用 Squirrel，
 * Mac 自己下载 zip 替换 .app），这里只负责查、缓存和挑出要下载的包，见 docs/research/desktop-auto-update.md。
 *
 * - 启动后查一次，之后每 6 小时一次；距上次查不到 6 小时就直接用缓存，不发请求。
 * - 断网、限流、返回格式不对都安静跳过，照旧用上次缓存的结果。
 * - 跳过 draft 和 prerelease；只认 mac arm64 的 dmg 和 Windows x64 的 Setup.exe，别的平台不提示。
 * - 网页拿到的只有版本号、说明摘要和发布时间；打开链接时网页只说「下载」还是「看发布页」，
 *   地址由主进程自己从缓存里取，并且只放行 github.com 上本仓库 Release 下的地址。
 */
import { readFileSync, writeFileSync } from "node:fs";

export const RELEASE_REPO = { owner: "wangrongding", name: "SuperHive" } as const;
export const LATEST_RELEASE_API = `https://api.github.com/repos/${RELEASE_REPO.owner}/${RELEASE_REPO.name}/releases/latest`;
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
/** 说明摘要最多几条、每条多长：只是提示，完整说明点「发布说明」去看 */
const MAX_NOTES = 8;
const MAX_NOTE_CHARS = 160;

// ---------- 版本比较 ----------

type ParsedVersion = { core: number[]; pre: string[] };

function parseVersion(input: string): ParsedVersion | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    input.trim(),
  );
  if (!match) return undefined;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split(".") : [],
  };
}

export function isValidVersion(input: unknown): input is string {
  return typeof input === "string" && parseVersion(input) !== undefined;
}

/** 按 semver 比较：a 比 b 新返回正数，旧返回负数，一样（或有一个不是版本号）返回 0 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  for (let i = 0; i < 3; i += 1) {
    const diff = left.core[i]! - right.core[i]!;
    if (diff !== 0) return Math.sign(diff);
  }
  // 1.0.0-beta < 1.0.0
  if (!left.pre.length && !right.pre.length) return 0;
  if (!left.pre.length) return 1;
  if (!right.pre.length) return -1;
  const length = Math.max(left.pre.length, right.pre.length);
  for (let i = 0; i < length; i += 1) {
    const x = left.pre[i];
    const y = right.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return Math.sign(diff);
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

// ---------- 链接白名单 ----------

/** 只放行 https://github.com/<本仓库>/releases/...（下载地址和发布页都在这下面） */
export function isAllowedReleaseUrl(input: unknown): input is string {
  if (typeof input !== "string") return false;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com") return false;
  if (url.username || url.password || url.port) return false;
  const prefix = `/${RELEASE_REPO.owner}/${RELEASE_REPO.name}/releases/`.toLowerCase();
  const pathname = url.pathname.toLowerCase();
  // 不接受 ..、编码过的斜杠：URL 会把 .. 规范化掉，这里再拦一次编码形式
  if (/%2f|%5c/i.test(url.pathname)) return false;
  return pathname.startsWith(prefix);
}

// ---------- 选本平台安装包 ----------

export type ReleaseAsset = {
  name: string;
  url: string;
  size: number;
  /** GitHub 给的 sha256（小写十六进制）；老 Release 或老缓存里没有 */
  sha256?: string;
};

/** GitHub asset 的 digest 形如 "sha256:<64 位十六进制>"；别的算法或格式不对一律不认 */
export function parseDigest(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const match = /^sha256:([0-9a-f]{64})$/i.exec(input.trim());
  return match ? match[1]!.toLowerCase() : undefined;
}

function isSha256(input: unknown): input is string {
  return typeof input === "string" && /^[0-9a-f]{64}$/.test(input);
}

/** 本平台认的安装包文件名；没有对应安装包的平台（Intel Mac、Linux、Windows ARM）返回 undefined */
export function assetPattern(platform: string, arch: string): RegExp | undefined {
  if (platform === "darwin" && arch === "arm64") return /^SuperHive-[^/\\]+-arm64\.dmg$/i;
  if (platform === "win32" && arch === "x64") return /^SuperHive-[^/\\]+-win-x64-Setup\.exe$/i;
  return undefined;
}

export function pickAsset(
  assets: readonly ReleaseAsset[],
  platform: string,
  arch: string,
): ReleaseAsset | undefined {
  const pattern = assetPattern(platform, arch);
  if (!pattern) return undefined;
  return assets.find((asset) => pattern.test(asset.name) && isAllowedReleaseUrl(asset.url));
}

// ---------- 应用内更新用的包 ----------

/**
 * 应用内更新要下载的东西：
 * - Mac：Release 里的 `SuperHive-darwin-arm64-<版本>.zip`（Forge maker-zip 的产物），必须带 GitHub 的 sha256；
 * - Windows：Squirrel 的 `RELEASES` 和 `SuperHive-<版本>-full.nupkg`，feed 就是它们所在的 Release 下载目录。
 */
export type InstallPackage =
  | { kind: "mac-zip"; version: string; url: string; size: number; sha256: string }
  | { kind: "squirrel"; version: string; feedUrl: string; size: number };

export const macZipName = (version: string) => `SuperHive-darwin-arm64-${version}.zip`;
export const nupkgName = (version: string) => `SuperHive-${version}-full.nupkg`;

const DOWNLOAD_DIR = new RegExp(
  `^https://github\\.com/${RELEASE_REPO.owner}/${RELEASE_REPO.name}/releases/download/[^/?#%]+$`,
);

/** 本平台能在应用里直接更新时返回要下载的包；Release 里缺文件、缺 sha256 时返回 undefined（退回打开下载页） */
export function pickInstallPackage(
  release: Pick<LatestRelease, "version" | "assets">,
  platform: string,
  arch: string,
): InstallPackage | undefined {
  const find = (name: string) =>
    release.assets.find((asset) => asset.name === name && isAllowedReleaseUrl(asset.url));
  if (platform === "darwin" && arch === "arm64") {
    const zip = find(macZipName(release.version));
    if (!zip?.sha256 || zip.size <= 0) return undefined;
    return {
      kind: "mac-zip",
      version: release.version,
      url: zip.url,
      size: zip.size,
      sha256: zip.sha256,
    };
  }
  if (platform === "win32" && arch === "x64") {
    const releases = find("RELEASES");
    const nupkg = find(nupkgName(release.version));
    if (!releases || !nupkg || !releases.url.endsWith("/RELEASES")) return undefined;
    const feedUrl = releases.url.slice(0, -"/RELEASES".length);
    // 两个文件必须在同一个 Release 的下载目录下：Squirrel 按 feed 目录拼 nupkg 的地址
    if (!DOWNLOAD_DIR.test(feedUrl) || nupkg.url !== `${feedUrl}/${nupkg.name}`) return undefined;
    return { kind: "squirrel", version: release.version, feedUrl, size: nupkg.size };
  }
  return undefined;
}

// ---------- 解析 Release ----------

export type LatestRelease = {
  version: string;
  pageUrl: string;
  publishedAt?: string;
  notes: string[];
  assets: ReleaseAsset[];
};

function stripMarkdown(line: string): string {
  return line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : value;
}

/**
 * 发布说明摘要：优先取「本版改动 / What's changed」那一节的列表项（一条里中英文用 / 隔开，网页按语言取一半）；
 * 没有这一节就取正文里的列表项。纯文本，不带链接和 HTML。
 */
export function summarizeNotes(body: unknown): string[] {
  if (typeof body !== "string") return [];
  const lines = body.split(/\r?\n/);
  const heading = lines.findIndex((line) => /^#{1,6}\s.*(本版改动|what'?s changed)/i.test(line));
  let scope = lines;
  if (heading >= 0) {
    const next = lines.findIndex((line, index) => index > heading && /^#{1,6}\s/.test(line));
    scope = lines.slice(heading + 1, next >= 0 ? next : lines.length);
  }
  const notes: string[] = [];
  for (const line of scope) {
    const item = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (!item) continue;
    const text = stripMarkdown(item[1]!);
    if (text) notes.push(clip(text, MAX_NOTE_CHARS));
    if (notes.length >= MAX_NOTES) break;
  }
  return notes;
}

/** 解析 /releases/latest 的返回；draft、prerelease、版本号不对、发布页不在本仓库的一律不要 */
export function parseRelease(input: unknown): LatestRelease | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = input as Record<string, unknown>;
  if (value.draft === true || value.prerelease === true) return undefined;
  const tag = typeof value.tag_name === "string" ? value.tag_name : "";
  if (!isValidVersion(tag) || parseVersion(tag)!.pre.length) return undefined;
  if (!isAllowedReleaseUrl(value.html_url)) return undefined;
  const assets: ReleaseAsset[] = [];
  if (Array.isArray(value.assets)) {
    for (const raw of value.assets) {
      if (!raw || typeof raw !== "object") continue;
      const asset = raw as Record<string, unknown>;
      if (asset.state !== undefined && asset.state !== "uploaded") continue;
      if (typeof asset.name !== "string" || !isAllowedReleaseUrl(asset.browser_download_url))
        continue;
      const sha256 = parseDigest(asset.digest);
      assets.push({
        name: asset.name,
        url: asset.browser_download_url,
        size: typeof asset.size === "number" ? asset.size : 0,
        ...(sha256 ? { sha256 } : {}),
      });
    }
  }
  return {
    version: tag.replace(/^v/, ""),
    pageUrl: value.html_url,
    ...(typeof value.published_at === "string" ? { publishedAt: value.published_at } : {}),
    notes: summarizeNotes(value.body),
    assets,
  };
}

// ---------- 缓存 ----------

/** 缓存格式版本：2 起 asset 带 sha256。老格式的 release 和 ETag 丢掉重查，免得 304 一直沿用没有 sha256 的结果 */
export const UPDATE_CACHE_VERSION = 2;

export type UpdateCache = {
  version?: number;
  /** 上次成功查到的时间（毫秒）；查失败不改它 */
  checkedAt?: number;
  etag?: string;
  release?: LatestRelease;
  /** 用户点过「忽略这个版本」的版本号 */
  dismissed?: string[];
};

export function loadUpdateCache(file: string): UpdateCache {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const cache: UpdateCache = {};
    if (typeof value.checkedAt === "number" && Number.isFinite(value.checkedAt))
      cache.checkedAt = value.checkedAt;
    if (typeof value.etag === "string") cache.etag = value.etag;
    // 缓存里的 release 也按同样的规则再校验一遍，文件被改过也打不开别的地址
    const release = value.release as Partial<LatestRelease> | undefined;
    if (value.version !== UPDATE_CACHE_VERSION) {
      // 老格式：只留「忽略的版本」，其余丢掉，下次马上重查
      delete cache.etag;
      delete cache.checkedAt;
    }
    if (
      value.version === UPDATE_CACHE_VERSION &&
      release &&
      isValidVersion(release.version) &&
      isAllowedReleaseUrl(release.pageUrl) &&
      Array.isArray(release.assets) &&
      Array.isArray(release.notes)
    ) {
      cache.release = {
        version: release.version,
        pageUrl: release.pageUrl,
        ...(typeof release.publishedAt === "string" ? { publishedAt: release.publishedAt } : {}),
        notes: release.notes
          .filter((note): note is string => typeof note === "string")
          .slice(0, MAX_NOTES)
          .map((note) => clip(note, MAX_NOTE_CHARS)),
        assets: release.assets
          .filter(
            (asset): asset is ReleaseAsset =>
              Boolean(asset) &&
              typeof asset.name === "string" &&
              typeof asset.size === "number" &&
              isAllowedReleaseUrl(asset.url),
          )
          .map((asset) => ({
            name: asset.name,
            url: asset.url,
            size: asset.size,
            ...(isSha256(asset.sha256) ? { sha256: asset.sha256 } : {}),
          })),
      };
    }
    if (Array.isArray(value.dismissed))
      cache.dismissed = value.dismissed.filter(isValidVersion).slice(-20);
    return cache;
  } catch {
    return {};
  }
}

export function saveUpdateCache(file: string, cache: UpdateCache): void {
  try {
    writeFileSync(file, `${JSON.stringify({ ...cache, version: UPDATE_CACHE_VERSION })}\n`);
  } catch {
    /* 存不下来只是下次多查一次 */
  }
}

// ---------- 检查器 ----------

function withoutRelease(cache: UpdateCache): UpdateCache {
  const next = { ...cache };
  delete next.release;
  delete next.etag;
  return next;
}

/** 交给网页的内容：没有链接，只有展示用的信息 */
export type UpdateInfo = {
  version: string;
  currentVersion: string;
  publishedAt?: string;
  notes: string[];
  /** 安装包文件名和大小，按钮旁边显示 */
  assetName: string;
  assetSize: number;
};

export type UpdateFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

export type UpdateCheckerOptions = {
  currentVersion: string;
  platform: string;
  arch: string;
  fetch: UpdateFetch;
  load: () => UpdateCache;
  save: (cache: UpdateCache) => void;
  now?: () => number;
  intervalMs?: number;
  timeoutMs?: number;
  userAgent?: string;
};

export class UpdateChecker {
  private cache: UpdateCache;
  private inflight: Promise<UpdateInfo | null> | undefined;
  /** 最近一次真的发了请求时有没有查成功（手动检查时用来区分「已是最新」和「没查到」） */
  lastCheckFailed = false;
  private readonly now: () => number;
  private readonly intervalMs: number;

  constructor(private readonly options: UpdateCheckerOptions) {
    this.cache = options.load();
    this.now = options.now ?? Date.now;
    this.intervalMs = options.intervalMs ?? CHECK_INTERVAL_MS;
  }

  /** 当前要提示的新版；没有、已忽略、本平台没有安装包时是 null */
  current(): UpdateInfo | null {
    const release = this.cache.release;
    if (!release) return null;
    if (compareVersions(release.version, this.options.currentVersion) <= 0) return null;
    if (this.cache.dismissed?.includes(release.version)) return null;
    const asset = pickAsset(release.assets, this.options.platform, this.options.arch);
    if (!asset) return null;
    return {
      version: release.version,
      currentVersion: this.options.currentVersion,
      ...(release.publishedAt ? { publishedAt: release.publishedAt } : {}),
      notes: release.notes,
      assetName: asset.name,
      assetSize: asset.size,
    };
  }

  /** 距上次查到还不到间隔时直接用缓存；force 时不管间隔（菜单里手动检查） */
  async check(force = false): Promise<UpdateInfo | null> {
    if (!force && !this.isStale()) return this.current();
    this.inflight ??= this.fetchLatest().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  /**
   * 人主动点「检查更新」：不管间隔马上查；查到的新版之前被「忽略这个版本」过也重新提示——
   * 人特意来查，就不能回一句「已是最新」
   */
  async checkNow(): Promise<UpdateInfo | null> {
    await this.check(true);
    const version = this.cache.release?.version;
    if (version && this.cache.dismissed?.includes(version)) {
      const dismissed = this.cache.dismissed.filter((item) => item !== version);
      this.cache = { ...this.cache, dismissed };
      this.options.save(this.cache);
    }
    return this.current();
  }

  isStale(): boolean {
    const checkedAt = this.cache.checkedAt;
    if (checkedAt === undefined) return true;
    const age = this.now() - checkedAt;
    // 系统时间往回拨了也当作过期
    return age < 0 || age >= this.intervalMs;
  }

  /** 下次该查的时间距现在多久（毫秒），给定时器用 */
  msUntilNextCheck(): number {
    if (this.isStale()) return 0;
    return this.intervalMs - (this.now() - this.cache.checkedAt!);
  }

  /** 「忽略这个版本」：只认当前正在提示的版本 */
  dismiss(version: unknown): boolean {
    const info = this.current();
    if (!info || version !== info.version) return false;
    const dismissed = [...(this.cache.dismissed ?? []), info.version].slice(-20);
    this.cache = { ...this.cache, dismissed };
    this.options.save(this.cache);
    return true;
  }

  /** 当前提示的新版能不能在应用里直接更新：能就返回要下载的包 */
  installPackage(): InstallPackage | undefined {
    const release = this.cache.release;
    if (!release || !this.current()) return undefined;
    return pickInstallPackage(release, this.options.platform, this.options.arch);
  }

  /** 网页点「下载」/「发布说明」时要打开的地址；只从缓存里取，并再过一遍白名单 */
  urlFor(target: unknown): string | undefined {
    const release = this.cache.release;
    if (!release || !this.current()) return undefined;
    let url: string | undefined;
    if (target === "download")
      url = pickAsset(release.assets, this.options.platform, this.options.arch)?.url;
    else if (target === "release") url = release.pageUrl;
    return isAllowedReleaseUrl(url) ? url : undefined;
  }

  private async fetchLatest(): Promise<UpdateInfo | null> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": this.options.userAgent ?? `SuperHive-Desktop/${this.options.currentVersion}`,
    };
    // 有上次的 ETag 时带上：没变化返回 304，不算进 GitHub 的匿名限额
    if (this.cache.etag && this.cache.release) headers["If-None-Match"] = this.cache.etag;
    try {
      const response = await this.options.fetch(LATEST_RELEASE_API, {
        headers,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? REQUEST_TIMEOUT_MS),
      });
      if (response.status === 304) {
        this.cache = { ...this.cache, checkedAt: this.now() };
      } else if (response.status === 404) {
        // 还没有任何正式版
        this.cache = { ...withoutRelease(this.cache), checkedAt: this.now() };
      } else if (response.ok) {
        const release = parseRelease(await response.json());
        const etag = response.headers.get("etag") ?? undefined;
        this.cache = {
          ...withoutRelease(this.cache),
          checkedAt: this.now(),
          ...(release ? { release } : {}),
          ...(release && etag ? { etag } : {}),
        };
      } else {
        // 限流（403/429）、服务出错：安静跳过，下次再查
        this.lastCheckFailed = true;
        return this.current();
      }
      this.lastCheckFailed = false;
      this.options.save(this.cache);
    } catch {
      // 断网、超时、返回的不是 JSON：安静跳过
      this.lastCheckFailed = true;
    }
    return this.current();
  }
}
