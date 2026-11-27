import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHECK_INTERVAL_MS,
  LATEST_RELEASE_API,
  compareVersions,
  isAllowedReleaseUrl,
  loadUpdateCache,
  parseDigest,
  parseRelease,
  pickInstallPackage,
  pickAsset,
  saveUpdateCache,
  summarizeNotes,
  UPDATE_CACHE_VERSION,
  UpdateChecker,
  type UpdateCache,
  type UpdateFetch,
} from "./update-check.js";

const BASE = "https://github.com/wangrongding/SuperHive/releases";

function release(version: string, extra: Record<string, unknown> = {}) {
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    html_url: `${BASE}/tag/v${version}`,
    published_at: "2026-11-30T12:00:00Z",
    body: "## 本版改动 / What's changed\n\n- 新功能 A / Feature A\n- **修复** B / Fix `B`\n\n**Full Changelog**: x",
    assets: [
      {
        name: `SuperHive-${version}-arm64.dmg`,
        browser_download_url: `${BASE}/download/v${version}/SuperHive-${version}-arm64.dmg`,
        size: 100,
        state: "uploaded",
      },
      {
        name: `SuperHive-${version}-win-x64-Setup.exe`,
        browser_download_url: `${BASE}/download/v${version}/SuperHive-${version}-win-x64-Setup.exe`,
        size: 200,
        state: "uploaded",
      },
    ],
    ...extra,
  };
}

function response(status: number, body?: unknown, etag?: string) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => (name.toLowerCase() === "etag" ? (etag ?? null) : null) },
    json: async () => body,
  };
}

function setup(options: {
  current?: string;
  platform?: string;
  arch?: string;
  cache?: UpdateCache;
  replies?: Array<ReturnType<typeof response> | Error>;
}) {
  let now = 1_000_000;
  let cache: UpdateCache = options.cache ?? {};
  const saves: UpdateCache[] = [];
  const replies = [...(options.replies ?? [])];
  const fetch = vi.fn<UpdateFetch>(async () => {
    const next = replies.shift();
    if (!next) throw new Error("no reply");
    if (next instanceof Error) throw next;
    return next;
  });
  const checker = new UpdateChecker({
    currentVersion: options.current ?? "0.4.7",
    platform: options.platform ?? "darwin",
    arch: options.arch ?? "arm64",
    fetch,
    load: () => cache,
    save: (next) => {
      cache = next;
      saves.push(next);
    },
    now: () => now,
  });
  return {
    checker,
    fetch,
    saves,
    advance: (ms: number) => {
      now += ms;
    },
    cache: () => cache,
  };
}

describe("compareVersions", () => {
  it("按数字逐段比较，前缀 v 不影响", () => {
    expect(compareVersions("0.4.8", "0.4.7")).toBe(1);
    expect(compareVersions("v0.4.10", "0.4.9")).toBe(1);
    expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
    expect(compareVersions("1.0.0", "v1.0.0")).toBe(0);
    expect(compareVersions("0.4.7", "0.5.0")).toBe(-1);
  });

  it("预发布版比正式版旧，预发布标识按 semver 比", () => {
    expect(compareVersions("1.0.0-beta", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBe(1);
    expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.10")).toBe(-1);
    expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
    expect(compareVersions("1.0.0-1", "1.0.0-alpha")).toBe(-1);
  });

  it("不是版本号时当作一样（不提示）", () => {
    expect(compareVersions("latest", "0.4.7")).toBe(0);
    expect(compareVersions("0.4", "0.4.7")).toBe(0);
  });
});

describe("isAllowedReleaseUrl", () => {
  it("只放行 github.com 上本仓库 Release 下的 https 地址", () => {
    expect(isAllowedReleaseUrl(`${BASE}/tag/v0.4.8`)).toBe(true);
    expect(isAllowedReleaseUrl(`${BASE}/download/v0.4.8/SuperHive-0.4.8-arm64.dmg`)).toBe(true);
    expect(isAllowedReleaseUrl(`${BASE}/`)).toBe(true);
  });

  it.each([
    "http://github.com/wangrongding/SuperHive/releases/tag/v1.0.0",
    "https://github.com.evil.com/wangrongding/SuperHive/releases/tag/v1.0.0",
    "https://evil.com/wangrongding/SuperHive/releases/tag/v1.0.0",
    "https://github.com/someone/SuperHive/releases/tag/v1.0.0",
    "https://github.com/wangrongding/SuperHive/issues/1",
    "https://github.com/wangrongding/SuperHive/releases/../../../evil/repo",
    "https://github.com/wangrongding/SuperHive/releases%2F..%2F..%2Fevil",
    "https://github.com/wangrongding/SuperHive/releases/download/v1/a%2F..%2Fb",
    "https://user:pass@github.com/wangrongding/SuperHive/releases/tag/v1",
    "https://github.com:8443/wangrongding/SuperHive/releases/tag/v1",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "",
    42,
    undefined,
  ])("拒绝 %s", (url) => {
    expect(isAllowedReleaseUrl(url)).toBe(false);
  });
});

describe("pickAsset", () => {
  const assets = parseRelease(release("0.4.8"))!.assets;

  it("mac arm64 选 dmg，Windows x64 选 Setup.exe", () => {
    expect(pickAsset(assets, "darwin", "arm64")?.name).toBe("SuperHive-0.4.8-arm64.dmg");
    expect(pickAsset(assets, "win32", "x64")?.name).toBe("SuperHive-0.4.8-win-x64-Setup.exe");
  });

  it("没有对应安装包的平台不选", () => {
    expect(pickAsset(assets, "darwin", "x64")).toBeUndefined();
    expect(pickAsset(assets, "win32", "arm64")).toBeUndefined();
    expect(pickAsset(assets, "linux", "x64")).toBeUndefined();
  });

  it("Release 里缺本平台的包时不选", () => {
    const onlyMac = assets.filter((asset) => asset.name.endsWith(".dmg"));
    expect(pickAsset(onlyMac, "win32", "x64")).toBeUndefined();
  });

  it("地址不在本仓库的包不选", () => {
    expect(
      pickAsset(
        [{ name: "SuperHive-0.4.8-arm64.dmg", url: "https://evil.com/x.dmg", size: 1 }],
        "darwin",
        "arm64",
      ),
    ).toBeUndefined();
  });
});

describe("parseRelease", () => {
  it("取版本号、发布页、说明摘要和本仓库的安装包", () => {
    const parsed = parseRelease(release("0.4.8"))!;
    expect(parsed.version).toBe("0.4.8");
    expect(parsed.pageUrl).toBe(`${BASE}/tag/v0.4.8`);
    expect(parsed.notes).toEqual(["新功能 A / Feature A", "修复 B / Fix B"]);
    expect(parsed.assets).toHaveLength(2);
  });

  it("跳过 draft、prerelease 和带预发布标识的 tag", () => {
    expect(parseRelease(release("0.4.8", { draft: true }))).toBeUndefined();
    expect(parseRelease(release("0.4.8", { prerelease: true }))).toBeUndefined();
    expect(parseRelease(release("0.4.8-beta.1"))).toBeUndefined();
  });

  it("发布页不在本仓库、版本号不对的不要", () => {
    expect(parseRelease(release("0.4.8", { html_url: "https://evil.com/x" }))).toBeUndefined();
    expect(parseRelease(release("0.4.8", { tag_name: "nightly" }))).toBeUndefined();
    expect(parseRelease(null)).toBeUndefined();
  });

  it("丢掉地址不对、还没传完的安装包", () => {
    const parsed = parseRelease(
      release("0.4.8", {
        assets: [
          { name: "a.dmg", browser_download_url: "https://evil.com/a.dmg", size: 1 },
          {
            name: "SuperHive-0.4.8-arm64.dmg",
            browser_download_url: `${BASE}/download/v0.4.8/SuperHive-0.4.8-arm64.dmg`,
            size: 1,
            state: "starter",
          },
        ],
      }),
    )!;
    expect(parsed.assets).toEqual([]);
  });
});

describe("summarizeNotes", () => {
  it("没有「本版改动」一节时取正文里的列表项，去掉链接和 HTML，最多 8 条", () => {
    const body = Array.from({ length: 12 }, (_, i) => `* [第 ${i} 条](https://x) <b>粗</b>`).join(
      "\n",
    );
    const notes = summarizeNotes(body);
    expect(notes).toHaveLength(8);
    expect(notes[0]).toBe("第 0 条 粗");
  });

  it("太长的一条截断", () => {
    const [note] = summarizeNotes(`- ${"长".repeat(500)}`);
    expect(Array.from(note!).length).toBe(160);
    expect(note!.endsWith("…")).toBe(true);
  });

  it("不是字符串时为空", () => {
    expect(summarizeNotes(undefined)).toEqual([]);
  });
});

describe("UpdateChecker", () => {
  it("查到更新的正式版并且有本平台安装包时提示，不给网页任何链接", async () => {
    const { checker, fetch } = setup({ replies: [response(200, release("0.4.8"), '"e1"')] });
    const info = await checker.check();
    expect(fetch).toHaveBeenCalledWith(
      LATEST_RELEASE_API,
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: "application/vnd.github+json" }),
      }),
    );
    expect(info).toEqual({
      version: "0.4.8",
      currentVersion: "0.4.7",
      publishedAt: "2026-11-30T12:00:00Z",
      notes: ["新功能 A / Feature A", "修复 B / Fix B"],
      assetName: "SuperHive-0.4.8-arm64.dmg",
      assetSize: 100,
    });
    expect(JSON.stringify(info)).not.toContain("https://");
  });

  it("和当前一样或更旧的版本不提示", async () => {
    const same = setup({ replies: [response(200, release("0.4.7"))] });
    expect(await same.checker.check()).toBeNull();
    const older = setup({ current: "0.5.0", replies: [response(200, release("0.4.8"))] });
    expect(await older.checker.check()).toBeNull();
  });

  it("本平台没有安装包时不提示", async () => {
    const { checker } = setup({
      platform: "linux",
      arch: "x64",
      replies: [response(200, release("0.4.8"))],
    });
    expect(await checker.check()).toBeNull();
  });

  it("6 小时内再查直接用缓存，不发请求；过了 6 小时带 ETag 再查，304 时沿用缓存", async () => {
    const env = setup({ replies: [response(200, release("0.4.8"), '"e1"'), response(304)] });
    await env.checker.check();
    env.advance(CHECK_INTERVAL_MS - 1);
    expect((await env.checker.check())?.version).toBe("0.4.8");
    expect(env.fetch).toHaveBeenCalledTimes(1);
    expect(env.checker.msUntilNextCheck()).toBe(1);

    env.advance(1);
    expect((await env.checker.check())?.version).toBe("0.4.8");
    expect(env.fetch).toHaveBeenCalledTimes(2);
    expect(env.fetch.mock.calls[1]![1].headers["If-None-Match"]).toBe('"e1"');
    expect(env.cache().checkedAt).toBe(1_000_000 + CHECK_INTERVAL_MS);
  });

  it("启动时读到新鲜的缓存就不请求", async () => {
    const cache: UpdateCache = {
      checkedAt: 1_000_000 - 1000,
      release: parseRelease(release("0.4.9"))!,
    };
    const { checker, fetch } = setup({ cache });
    expect((await checker.check())?.version).toBe("0.4.9");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("系统时间往回拨时当作过期", async () => {
    const { checker } = setup({ cache: { checkedAt: 2_000_000 } });
    expect(checker.isStale()).toBe(true);
  });

  it("断网、限流、返回不对都安静跳过，保留上次的结果，不更新检查时间", async () => {
    const cache: UpdateCache = {
      checkedAt: 1_000_000 - CHECK_INTERVAL_MS,
      release: parseRelease(release("0.4.8"))!,
    };
    const env = setup({
      cache,
      replies: [
        new Error("offline"),
        response(403, { message: "rate limited" }),
        response(200, "<html>"),
      ],
    });
    expect((await env.checker.check())?.version).toBe("0.4.8");
    expect(env.checker.lastCheckFailed).toBe(true);
    expect((await env.checker.check())?.version).toBe("0.4.8");
    expect(env.saves).toHaveLength(0);
    // 200 但内容不是 Release：查成功了，只是没有可提示的版本
    expect(await env.checker.check()).toBeNull();
    expect(env.checker.lastCheckFailed).toBe(false);
  });

  it("同时多次检查只发一个请求", async () => {
    const { checker, fetch } = setup({ replies: [response(200, release("0.4.8"))] });
    const [a, b] = await Promise.all([checker.check(), checker.check(true)]);
    expect(a?.version).toBe("0.4.8");
    expect(b?.version).toBe("0.4.8");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("忽略这个版本后不再提示，出了更新的版本照常提示", async () => {
    const env = setup({
      replies: [response(200, release("0.4.8")), response(200, release("0.4.9"))],
    });
    await env.checker.check();
    expect(env.checker.dismiss("0.4.9")).toBe(false);
    expect(env.checker.dismiss("0.4.8")).toBe(true);
    expect(env.checker.current()).toBeNull();
    expect(env.cache().dismissed).toEqual(["0.4.8"]);
    expect(await env.checker.check(true)).toMatchObject({ version: "0.4.9" });
  });

  it("手动检查马上联网，之前忽略过的版本重新提示；查不到时 lastCheckFailed", async () => {
    const env = setup({
      replies: [response(200, release("0.4.8")), response(304, {}), new Error("offline")],
    });
    await env.checker.check();
    env.checker.dismiss("0.4.8");
    expect(env.checker.current()).toBeNull();
    // 刚查过、还在 6 小时内也照样发请求
    expect(await env.checker.checkNow()).toMatchObject({ version: "0.4.8" });
    expect(env.fetch).toHaveBeenCalledTimes(2);
    expect(env.cache().dismissed).toEqual([]);
    expect(env.checker.lastCheckFailed).toBe(false);
    // 断网：照旧给上次查到的结果，并标出这次没查成
    expect(await env.checker.checkNow()).toMatchObject({ version: "0.4.8" });
    expect(env.checker.lastCheckFailed).toBe(true);
  });

  it("要打开的地址只从检查结果里取：下载给本平台安装包，发布页给 Release 页；别的一律不给", async () => {
    const env = setup({
      platform: "win32",
      arch: "x64",
      replies: [response(200, release("0.4.8"))],
    });
    expect(env.checker.urlFor("download")).toBeUndefined();
    await env.checker.check();
    expect(env.checker.urlFor("download")).toBe(
      `${BASE}/download/v0.4.8/SuperHive-0.4.8-win-x64-Setup.exe`,
    );
    expect(env.checker.urlFor("release")).toBe(`${BASE}/tag/v0.4.8`);
    expect(env.checker.urlFor("https://evil.com")).toBeUndefined();
    expect(env.checker.urlFor(undefined)).toBeUndefined();
    env.checker.dismiss("0.4.8");
    expect(env.checker.urlFor("download")).toBeUndefined();
  });
});

describe("loadUpdateCache / saveUpdateCache", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("存了能读回来", () => {
    dir = mkdtempSync(path.join(tmpdir(), "update-cache-"));
    const file = path.join(dir, "update-check.json");
    const cache: UpdateCache = {
      checkedAt: 123,
      etag: '"e"',
      release: parseRelease(release("0.4.8"))!,
      dismissed: ["0.4.6"],
    };
    saveUpdateCache(file, cache);
    expect(loadUpdateCache(file)).toEqual(cache);
  });

  it("文件被改过：不在本仓库的地址、不是版本号的条目都丢掉", () => {
    dir = mkdtempSync(path.join(tmpdir(), "update-cache-"));
    const file = path.join(dir, "update-check.json");
    const parsed = parseRelease(release("0.4.8"))!;
    writeFileSync(
      file,
      JSON.stringify({
        version: UPDATE_CACHE_VERSION,
        checkedAt: "soon",
        release: {
          ...parsed,
          assets: [
            ...parsed.assets,
            { name: "SuperHive-9-arm64.dmg", url: "https://evil.com/x", size: 1 },
          ],
        },
        dismissed: ["0.4.6", "bad", 3],
      }),
    );
    const cache = loadUpdateCache(file);
    expect(cache.checkedAt).toBeUndefined();
    expect(cache.release?.assets).toHaveLength(2);
    expect(cache.dismissed).toEqual(["0.4.6"]);

    writeFileSync(
      file,
      JSON.stringify({
        version: UPDATE_CACHE_VERSION,
        release: { ...parsed, pageUrl: "https://evil.com" },
      }),
    );
    expect(loadUpdateCache(file).release).toBeUndefined();
  });

  it("文件不存在或坏了时是空缓存", () => {
    dir = mkdtempSync(path.join(tmpdir(), "update-cache-"));
    const file = path.join(dir, "update-check.json");
    expect(loadUpdateCache(file)).toEqual({});
    writeFileSync(file, "{oops");
    expect(loadUpdateCache(file)).toEqual({});
    expect(readFileSync(file, "utf8")).toBe("{oops");
  });
});

describe("应用内更新包", () => {
  const SHA = "a".repeat(64);
  const asset = (name: string, extra: Record<string, unknown> = {}, tag = "v0.4.8") => ({
    name,
    browser_download_url: `${BASE}/download/${tag}/${name}`,
    size: 300,
    state: "uploaded",
    ...extra,
  });
  const withAssets = (assets: unknown[]) =>
    parseRelease(release("0.4.8", { assets: [...release("0.4.8").assets, ...assets] }))!;

  it("parseDigest 只认 sha256:<64 位十六进制>", () => {
    expect(parseDigest(`sha256:${"A".repeat(64)}`)).toBe("a".repeat(64));
    expect(parseDigest(`sha1:${"a".repeat(40)}`)).toBeUndefined();
    expect(parseDigest(`sha256:${"a".repeat(63)}`)).toBeUndefined();
    expect(parseDigest(undefined)).toBeUndefined();
  });

  it("Mac 要 darwin-arm64 的 zip，并且必须带 sha256", () => {
    const zip = "SuperHive-darwin-arm64-0.4.8.zip";
    const parsed = withAssets([asset(zip, { digest: `sha256:${SHA}` })]);
    expect(pickInstallPackage(parsed, "darwin", "arm64")).toEqual({
      kind: "mac-zip",
      version: "0.4.8",
      url: `${BASE}/download/v0.4.8/${zip}`,
      size: 300,
      sha256: SHA,
    });
    expect(pickInstallPackage(withAssets([asset(zip)]), "darwin", "arm64")).toBeUndefined();
    // 版本号对不上的 zip 不要
    expect(
      pickInstallPackage(
        withAssets([asset("SuperHive-darwin-arm64-0.4.7.zip", { digest: `sha256:${SHA}` })]),
        "darwin",
        "arm64",
      ),
    ).toBeUndefined();
    expect(pickInstallPackage(parsed, "darwin", "x64")).toBeUndefined();
    expect(pickInstallPackage(parsed, "linux", "x64")).toBeUndefined();
  });

  it("Windows 要同一个 Release 下的 RELEASES 和 full.nupkg，feed 是那个下载目录", () => {
    const parsed = withAssets([asset("RELEASES"), asset("SuperHive-0.4.8-full.nupkg")]);
    expect(pickInstallPackage(parsed, "win32", "x64")).toEqual({
      kind: "squirrel",
      version: "0.4.8",
      feedUrl: `${BASE}/download/v0.4.8`,
      size: 300,
    });
    expect(pickInstallPackage(withAssets([asset("RELEASES")]), "win32", "x64")).toBeUndefined();
    expect(
      pickInstallPackage(
        withAssets([asset("RELEASES"), asset("SuperHive-0.4.8-full.nupkg", {}, "v0.4.7")]),
        "win32",
        "x64",
      ),
    ).toBeUndefined();
    expect(pickInstallPackage(parsed, "win32", "arm64")).toBeUndefined();
  });

  it("检查器只在有要提示的新版时给更新包", async () => {
    const zip = asset("SuperHive-darwin-arm64-0.4.8.zip", { digest: `sha256:${SHA}` });
    const body = release("0.4.8", { assets: [...release("0.4.8").assets, zip] });
    const make = (current: string) =>
      new UpdateChecker({
        currentVersion: current,
        platform: "darwin",
        arch: "arm64",
        fetch: async () => response(200, body),
        load: () => ({}),
        save: () => undefined,
      });
    const newer = make("0.4.7");
    await newer.check();
    expect(newer.installPackage()).toMatchObject({ kind: "mac-zip", sha256: SHA });
    const same = make("0.4.8");
    await same.check();
    expect(same.installPackage()).toBeUndefined();
  });

  it("老格式的缓存（没有 sha256 那一版）丢掉 release 和 ETag，重新查", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "update-cache-"));
    try {
      const file = path.join(dir, "update-check.json");
      const parsed = parseRelease(release("0.4.8"))!;
      writeFileSync(
        file,
        JSON.stringify({ checkedAt: 5, etag: '"e"', release: parsed, dismissed: ["0.4.6"] }),
      );
      expect(loadUpdateCache(file)).toEqual({ dismissed: ["0.4.6"] });
      saveUpdateCache(file, { checkedAt: 5, release: withAssets([]) });
      expect(JSON.parse(readFileSync(file, "utf8")).version).toBe(UPDATE_CACHE_VERSION);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
