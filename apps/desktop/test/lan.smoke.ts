/**
 * 「允许局域网设备访问」：新装、从老版本升上来（没存过选择）都默认开启，听 0.0.0.0；
 * 关掉后交接重启换到 127.0.0.1，存下的选择下次启动照旧。
 * 独立的数据目录和端口，不碰 ~/.superhive。
 */
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { desktopDir, enterRoom } from "./flows.js";

const port = 18_300 + Math.floor(Math.random() * 150);
const lanIp = Object.values(os.networkInterfaces())
  .flat()
  .find((entry) => entry && entry.family === "IPv4" && !entry.internal)?.address;

async function reachable(host: string): Promise<boolean> {
  try {
    const response = await fetch(`http://${host}:${port}/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function launch(dataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [path.join(desktopDir, ".stage/app")],
    env: {
      ...process.env,
      SUPERHIVE_DESKTOP_DATA_DIR: dataDir,
      SUPERHIVE_DESKTOP_PORT: String(port),
      HIVE_NO_OPEN: "1",
    } as Record<string, string>,
  });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const found = app.windows().find((win) => win.url().startsWith("http://127.0.0.1:"));
    if (found) return { app, page: found };
    await app.waitForEvent("window", { timeout: 5_000 }).catch(() => undefined);
  }
  throw new Error("main window did not open");
}

const settingFile = (dataDir: string) => path.join(dataDir, "desktop-user-data", "lan-access.json");
const instanceId = async () =>
  ((await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as { instanceId: string })
    .instanceId;

test.skip(!lanIp, "这台机器没有局域网地址");

test("新装默认能从局域网连上；关掉后只听本机，网页不用重开", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "superhive-desktop-lan-"));
  const { app, page } = await launch(dataDir);
  try {
    await enterRoom(page);
    expect(await reachable("127.0.0.1")).toBe(true);
    expect(await reachable(lanIp!)).toBe(true);
    expect(JSON.parse(readFileSync(settingFile(dataDir), "utf8"))).toEqual({ enabled: true });
    expect(await page.evaluate(() => (window as any).superhiveDesktop.lan.get())).toEqual({
      enabled: true,
      managed: true,
      restarting: false,
    });
    // 不是 Windows：不查防火墙
    expect(await page.evaluate(() => (window as any).superhiveDesktop.lan.firewall())).toBeNull();
    const before = await instanceId();

    const after = await page.evaluate(() => (window as any).superhiveDesktop.lan.set(false));
    expect(after).toEqual({ enabled: false, managed: true, restarting: false });
    expect(await reachable(lanIp!)).toBe(false);
    expect(await reachable("127.0.0.1")).toBe(true);
    expect(await instanceId()).not.toBe(before);
    expect(JSON.parse(readFileSync(settingFile(dataDir), "utf8"))).toEqual({ enabled: false });
    // 页面还连着（同一个地址，自己重连）
    await expect(page.locator("header.chat-header")).toBeVisible();

    await page.evaluate(() => (window as any).superhiveDesktop.lan.set(true));
    expect(await reachable(lanIp!)).toBe(true);
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("存过的选择按存的来；老版本升上来没存过的按开启", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "superhive-desktop-lan-saved-"));
  try {
    // 先起一次造出数据库，再存成关闭：下次启动只听本机
    const first = await launch(dataDir);
    await enterRoom(first.page);
    await first.app.close();
    writeFileSync(settingFile(dataDir), `${JSON.stringify({ enabled: false })}\n`);
    const second = await launch(dataDir);
    try {
      await enterRoom(second.page);
      expect(await reachable(lanIp!)).toBe(false);
      expect(JSON.parse(readFileSync(settingFile(dataDir), "utf8"))).toEqual({ enabled: false });
    } finally {
      await second.app.close();
    }

    // 删掉存下的选择，假装是升级前的版本留下的数据：直接开启，只起一次
    rmSync(settingFile(dataDir));
    expect(existsSync(path.join(dataDir, "hive.sqlite"))).toBe(true);
    const third = await launch(dataDir);
    try {
      await enterRoom(third.page);
      expect(JSON.parse(readFileSync(settingFile(dataDir), "utf8"))).toEqual({ enabled: true });
      expect(await reachable(lanIp!)).toBe(true);
    } finally {
      await third.app.close();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
