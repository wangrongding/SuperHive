import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CHECK_CACHE_MS,
  checkLatest,
  compareVersions,
  detectInstall,
  fetchLatestVersion,
  npmRegistry,
  refreshLatest,
  shouldCheckForUpdate,
  updateNotice,
  upgradeCommand,
  restartArgsFor,
} from "./update.js";

describe("detectInstall", () => {
  it("按包的真实位置认出安装方式", () => {
    expect(detectInstall("/usr/local/lib/node_modules/superhive", "darwin")).toEqual({
      kind: "npm",
      prefix: "/usr/local",
    });
    expect(
      detectInstall("/Users/a/.nvm/versions/node/v22.12.0/lib/node_modules/superhive", "darwin"),
    ).toEqual({ kind: "npm", prefix: "/Users/a/.nvm/versions/node/v22.12.0" });
    expect(
      detectInstall("C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\superhive", "win32"),
    ).toEqual({
      kind: "npm",
      prefix: "C:\\Users\\a\\AppData\\Roaming\\npm",
    });
    expect(detectInstall("/Users/a/.npm/_npx/1a2b/node_modules/superhive", "darwin")).toEqual({
      kind: "npx",
    });
    expect(
      detectInstall(
        "/Users/a/Library/pnpm/global/5/.pnpm/superhive@0.3.1/node_modules/superhive",
        "darwin",
      ),
    ).toEqual({ kind: "pnpm" });
    expect(detectInstall("/Users/a/.bun/install/global/node_modules/superhive", "darwin")).toEqual({
      kind: "bun",
    });
    expect(detectInstall("/Users/a/.config/yarn/global/node_modules/superhive", "darwin")).toEqual({
      kind: "yarn",
    });
    // 仓库里直接跑 / pnpm link
    expect(detectInstall("/Users/a/Coding/ai-hive/packages/superhive", "darwin")).toEqual({
      kind: "source",
    });
  });
});

describe("upgradeCommand", () => {
  it("pins web updates to the confirmed version and preserves the data directory", () => {
    expect(upgradeCommand({ kind: "npm", prefix: "/stage" }, { version: "0.4.9" })?.args).toContain(
      "superhive@0.4.9",
    );
    expect(restartArgsFor({ wait: true, "data-dir": "/isolated" })).toEqual([
      "restart",
      "--wait",
      "--data-dir",
      "/isolated",
    ]);
  });
  it("npm 用 node 旁边的 npm 并锁定原来的全局目录", () => {
    const command = upgradeCommand(
      { kind: "npm", prefix: "/Users/a/my npm" },
      { execPath: "/opt/node/bin/node", platform: "darwin", exists: () => true },
    );
    expect(command?.file).toBe("/opt/node/bin/npm");
    expect(command?.args).toEqual([
      "install",
      "-g",
      "--prefix",
      "/Users/a/my npm",
      "superhive@latest",
    ]);
    expect(command?.display).toBe(
      "/opt/node/bin/npm install -g --prefix '/Users/a/my npm' superhive@latest",
    );
  });

  it("node 旁边没有 npm 就用 PATH 里的；其他包管理器用各自的全局安装命令", () => {
    expect(
      upgradeCommand(
        { kind: "npm", prefix: "/usr/local" },
        { platform: "darwin", exists: () => false },
      )?.file,
    ).toBe("npm");
    expect(upgradeCommand({ kind: "pnpm" }, { platform: "darwin" })?.display).toBe(
      "pnpm add -g superhive@latest",
    );
    expect(upgradeCommand({ kind: "bun" })?.display).toBe("bun add -g superhive@latest");
    expect(upgradeCommand({ kind: "yarn" })?.display).toBe("yarn global add superhive@latest");
    expect(upgradeCommand({ kind: "npx" })).toBeUndefined();
    expect(upgradeCommand({ kind: "source" })).toBeUndefined();
  });
});

describe("compareVersions", () => {
  it("按数字比较，预发布版比同号正式版旧", () => {
    expect(compareVersions("0.3.10", "0.3.9")).toBeGreaterThan(0);
    expect(compareVersions("0.3.1", "0.3.1")).toBe(0);
    expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("0.4.0", "v0.3.9")).toBeGreaterThan(0);
  });
});

describe("npmRegistry", () => {
  it("环境变量 > ~/.npmrc > 官方源", () => {
    const home = mkdtempSync(path.join(tmpdir(), "hive-npmrc-"));
    expect(npmRegistry({}, home)).toBe("https://registry.npmjs.org/");
    writeFileSync(
      path.join(home, ".npmrc"),
      "fund=false\nregistry=https://registry.npmmirror.com\n",
    );
    expect(npmRegistry({}, home)).toBe("https://registry.npmmirror.com/");
    expect(npmRegistry({ npm_config_registry: "https://r.example.com/npm/" }, home)).toBe(
      "https://r.example.com/npm/",
    );
  });
});

describe("fetchLatestVersion", () => {
  it("读 dist-tags 的 latest，出错或格式不对返回 undefined", async () => {
    const ok = vi.fn(async () => Response.json({ latest: "0.4.0", next: "0.5.0-beta.1" }));
    await expect(
      fetchLatestVersion(100, { registry: "https://r.example.com/npm/", fetchImpl: ok }),
    ).resolves.toBe("0.4.0");
    expect(String((ok.mock.calls[0] as unknown[])[0])).toBe(
      "https://r.example.com/npm/-/package/superhive/dist-tags",
    );
    const broken = vi.fn(async () => {
      throw new Error("offline");
    });
    await expect(fetchLatestVersion(100, { fetchImpl: broken })).resolves.toBeUndefined();
    const weird = vi.fn(async () => Response.json({ latest: "<script>" }));
    await expect(fetchLatestVersion(100, { fetchImpl: weird })).resolves.toBeUndefined();
  });
});

describe("checkLatest", () => {
  it("also caches offline results instead of hitting the registry on every refresh", async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "hive-update-offline-")), "check.json");
    const fetchLatest = vi.fn(async () => undefined);
    await checkLatest("0.4.8", { file, now: 100, fetchLatest });
    await checkLatest("0.4.8", { file, now: 200, fetchLatest });
    expect(fetchLatest).toHaveBeenCalledOnce();
  });
  it("有新版返回新版本号并缓存 1 小时；缓存过期再查；查不到不报错", async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "hive-update-")), "update-check.json");
    const fetchLatest = vi.fn(async () => "0.4.0");
    await expect(checkLatest("0.3.1", { file, now: 1_000, fetchLatest })).resolves.toBe("0.4.0");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ checkedAt: 1_000, latest: "0.4.0" });
    // 缓存期内不联网
    await expect(checkLatest("0.3.1", { file, now: 2_000, fetchLatest })).resolves.toBe("0.4.0");
    expect(fetchLatest).toHaveBeenCalledTimes(1);
    // 已经是最新
    await expect(checkLatest("0.4.0", { file, now: 2_000, fetchLatest })).resolves.toBeUndefined();
    // 过期重新查；网络不通返回 undefined
    const offline = vi.fn(async () => undefined);
    await expect(
      checkLatest("0.3.1", { file, now: 1_000 + CHECK_CACHE_MS, fetchLatest: offline }),
    ).resolves.toBeUndefined();
    expect(offline).toHaveBeenCalledTimes(1);
  });
});

describe("refreshLatest", () => {
  it("手动检查不看缓存马上查，查到了更新缓存，已是最新时不报新版", async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "hive-refresh-")), "update-check.json");
    writeFileSync(file, JSON.stringify({ checkedAt: 1_000, latest: "0.4.8" }));
    const fetchLatest = vi.fn(async () => "0.4.9");
    await expect(refreshLatest("0.4.8", { file, now: 1_001, fetchLatest })).resolves.toEqual({
      latest: "0.4.9",
      failed: false,
    });
    expect(fetchLatest).toHaveBeenCalledOnce();
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ checkedAt: 1_001, latest: "0.4.9" });
    await expect(refreshLatest("0.4.9", { file, fetchLatest })).resolves.toEqual({
      failed: false,
    });
  });
  it("没查到时报 failed，退回缓存里上次查到的新版，缓存不动", async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "hive-refresh-")), "update-check.json");
    const offline = vi.fn(async () => undefined);
    await expect(refreshLatest("0.4.8", { file, fetchLatest: offline })).resolves.toEqual({
      failed: true,
    });
    writeFileSync(file, JSON.stringify({ checkedAt: 1_000, latest: "0.4.9" }));
    await expect(refreshLatest("0.4.8", { file, fetchLatest: offline })).resolves.toEqual({
      latest: "0.4.9",
      failed: true,
    });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ checkedAt: 1_000, latest: "0.4.9" });
  });
});

describe("shouldCheckForUpdate / updateNotice", () => {
  it("只在终端里、没关提示时查", () => {
    expect(shouldCheckForUpdate({}, true)).toBe(true);
    expect(shouldCheckForUpdate({}, false)).toBe(false);
    expect(shouldCheckForUpdate({ CI: "1" }, true)).toBe(false);
    expect(shouldCheckForUpdate({ NO_UPDATE_NOTIFIER: "1" }, true)).toBe(false);
  });

  it("按安装方式给出更新办法", () => {
    expect(updateNotice("0.3.1", "0.4.0", { kind: "npm", prefix: "/usr/local" })).toContain(
      "hive update",
    );
    expect(updateNotice("0.3.1", "0.4.0", { kind: "npx" })).toContain(
      "npx superhive@latest restart",
    );
    expect(updateNotice("0.3.1", "0.4.0", { kind: "source" })).toContain("git pull");
  });
});
