/**
 * 打包版冒烟（只在 macOS）：打开时不读写系统钥匙串，换成新版后登录状态还在。
 *
 * 打包版开了 Cookie 加密 fuse；主进程加了 use-mock-keychain（见 src/keychain.ts），Chromium 用固定密钥加密 cookie，
 * 不去钥匙串读「SuperHive Safe Storage」，也就不会弹授权框。这里这样验证：
 * 1. 全新数据目录打开，过登录页进房间，写一个 cookie，退出；
 * 2. Cookies 库里这条 cookie 能用假钥匙串的固定密钥解开——说明 Chromium 没用钥匙串里的密钥；
 * 3. 把它换成用别的密钥加密的值，模拟旧版（用钥匙串密钥）写下的 cookie；
 * 4. 同一个数据目录再打开：不用重新登录、localStorage 原样，解不开的旧 cookie 被丢掉，应用照常工作。
 *
 *   SUPERHIVE_DESKTOP_APP=out/SuperHive-darwin-arm64/SuperHive.app/Contents/MacOS/SuperHive \
 *     pnpm --filter @superhive/desktop exec playwright test test/keychain.smoke.ts
 */
import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { desktopDir, enterRoom, serverAlive } from "./flows.js";

const executable = process.env.SUPERHIVE_DESKTOP_APP;
test.skip(
  !executable || process.platform !== "darwin",
  "macOS only; set SUPERHIVE_DESKTOP_APP to a packaged SuperHive executable",
);

const COOKIE = "superhive-keychain-smoke";
/** Chromium 在 Mac 上的 cookie 加密：AES-128-CBC，密钥由钥匙串里的密码经 PBKDF2 推出；假钥匙串的密码是固定的 */
const IV = Buffer.alloc(16, " ");
const keyFor = (password: string) => pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
const MOCK_KEY = keyFor("mock_password");

function decrypt(value: Uint8Array, key: Buffer): string | undefined {
  const data = Buffer.from(value);
  if (data.subarray(0, 3).toString() !== "v10") return undefined;
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, IV);
    const plain = Buffer.concat([decipher.update(data.subarray(3)), decipher.final()]);
    // 新版本 Chromium 在明文前加 32 字节的域名哈希
    return (plain.length > 32 ? plain.subarray(32) : plain).toString();
  } catch {
    return undefined;
  }
}

let dataDir: string;
let launchCwd: string;
const port = 18_990 + Math.floor(Math.random() * 9);

type Running = { child: ChildProcess; browser: Browser; page: Page };

async function launch(): Promise<Running> {
  const debugPort = 19_400 + Math.floor(Math.random() * 90);
  const inherited = { ...process.env };
  delete inherited.HIVE_LAUNCH_DIR;
  const child = spawn(
    path.resolve(desktopDir, executable!),
    [`--remote-debugging-port=${debugPort}`],
    {
      cwd: launchCwd,
      env: {
        ...inherited,
        SUPERHIVE_DESKTOP_DATA_DIR: dataDir,
        SUPERHIVE_DESKTOP_PORT: String(port),
        HIVE_NO_OPEN: "1",
      },
      stdio: "ignore",
    },
  );
  await expect.poll(() => serverAlive(port), { timeout: 60_000 }).toBe(true);
  await expect
    .poll(
      () =>
        fetch(`http://127.0.0.1:${debugPort}/json/version`).then(
          () => true,
          () => false,
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  const find = () =>
    browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((p) => p.url().startsWith(`http://127.0.0.1:${port}`));
  await expect.poll(() => Boolean(find()), { timeout: 30_000 }).toBe(true);
  return { child, browser, page: find()! };
}

/** 正常退出（等同菜单里的退出），Chromium 退出时把 cookie 和 localStorage 写回磁盘 */
async function quit({ child, browser }: Running): Promise<void> {
  await browser.close().catch(() => undefined);
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await exited;
  await expect.poll(() => serverAlive(port), { timeout: 20_000 }).toBe(false);
}

function cookieDb(): DatabaseSync {
  const userData = path.join(dataDir, "desktop-user-data");
  const file = [path.join(userData, "Cookies"), path.join(userData, "Network", "Cookies")].find(
    (candidate) => existsSync(candidate),
  );
  expect(file, "Chromium cookie store").toBeTruthy();
  return new DatabaseSync(file!);
}

const storage = (page: Page) =>
  page.evaluate(() => {
    const entries: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)!;
      entries[key] = localStorage.getItem(key)!;
    }
    return entries;
  });

test.beforeAll(() => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "superhive-desktop-keychain-"));
  launchCwd = mkdtempSync(path.join(os.tmpdir(), "superhive-desktop-cwd-"));
});

test.afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(launchCwd, { recursive: true, force: true });
});

test("packaged app on macOS: no system keychain, login survives an upgrade", async () => {
  // 第一次打开：全新数据目录，过登录页
  const first = await launch();
  await enterRoom(first.page, "keychain-smoke");
  await first.page.evaluate(
    (name) => (document.cookie = `${name}=fresh; max-age=86400; path=/`),
    COOKIE,
  );
  const before = await storage(first.page);
  expect(before["superhive.username"]).toBe("keychain-smoke");
  await quit(first);

  // cookie 是用假钥匙串的固定密钥加密的：Chromium 没去系统钥匙串取密钥
  const db = cookieDb();
  const row = db
    .prepare("SELECT rowid, encrypted_value FROM cookies WHERE name = ?")
    .get(COOKIE) as { rowid: number; encrypted_value: Uint8Array } | undefined;
  expect(row, "smoke cookie persisted").toBeTruthy();
  expect(decrypt(row!.encrypted_value, MOCK_KEY)).toBe("fresh");
  // 模拟旧版（用钥匙串里的真密钥）写下的 cookie：新版解不开
  const cipher = createCipheriv("aes-128-cbc", keyFor(randomBytes(12).toString("base64")), IV);
  const legacy = Buffer.concat([
    Buffer.from("v10"),
    cipher.update(Buffer.concat([randomBytes(32), Buffer.from("legacy")])),
    cipher.final(),
  ]);
  db.prepare("UPDATE cookies SET encrypted_value = ? WHERE rowid = ?").run(legacy, row!.rowid);
  db.close();

  // 第二次打开同一个数据目录：直接进房间，不用重新登录；localStorage 原样；旧 cookie 丢掉
  const second = await launch();
  await expect(second.page.locator("header.chat-header")).toBeVisible({ timeout: 30_000 });
  await expect(second.page.getByRole("textbox", { name: /你的用户名|Your username/ })).toHaveCount(
    0,
  );
  const after = await storage(second.page);
  for (const key of Object.keys(before).filter((key) => /token|username/.test(key))) {
    expect(after[key], key).toBe(before[key]);
  }
  expect(await second.page.evaluate(() => document.cookie)).not.toContain(COOKIE);
  await quit(second);
});
