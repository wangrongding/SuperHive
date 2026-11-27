/**
 * 「允许局域网设备访问」：新装默认只听 127.0.0.1；打开开关后交接重启换到 0.0.0.0；
 * 从老版本升上来（没存过选择）、已经有访客连进来过的，第一次启动后保持开启。
 * 独立的数据目录和端口，不碰 ~/.superhive。
 */
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

test("新装只听本机；打开开关后换到所有网卡，网页不用重开", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "superhive-desktop-lan-"));
  const { app, page } = await launch(dataDir);
  try {
    await enterRoom(page);
    expect(await reachable("127.0.0.1")).toBe(true);
    expect(await reachable(lanIp!)).toBe(false);
    expect(JSON.parse(readFileSync(settingFile(dataDir), "utf8"))).toEqual({ enabled: false });
    expect(await page.evaluate(() => (window as any).superhiveDesktop.lan.get())).toEqual({
      enabled: false,
      managed: true,
      restarting: false,
    });
    const before = await instanceId();

    const after = await page.evaluate(() => (window as any).superhiveDesktop.lan.set(true));
    expect(after).toEqual({ enabled: true, managed: true, restarting: false });
    expect(await reachable(lanIp!)).toBe(true);
    expect(await instanceId()).not.toBe(before);
    expect(JSON.parse(readFileSync(settingFile(dataDir), "utf8"))).toEqual({ enabled: true });
    // 不是 Windows：不查防火墙
    expect(await page.evaluate(() => (window as any).superhiveDesktop.lan.firewall())).toBeNull();
    // 页面还连着（同一个地址，自己重连）
    await expect(page.locator("header.chat-header")).toBeVisible();

    await page.evaluate(() => (window as any).superhiveDesktop.lan.set(false));
    expect(await reachable(lanIp!)).toBe(false);
    expect(await reachable("127.0.0.1")).toBe(true);
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("老版本升上来、有访客连进来过：第一次启动后保持局域网访问", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "superhive-desktop-lan-legacy-"));
  try {
    // 先起一次，造一个访客会话，然后删掉存下的选择，假装是升级前的版本留下的数据
    const first = await launch(dataDir);
    await enterRoom(first.page);
    const access = (await (await fetch(`http://127.0.0.1:${port}/api/access`)).json()) as {
      joinToken: string;
    };
    const owner = {
      Authorization: `Bearer ${access.joinToken}`,
      "Content-Type": "application/json",
    };
    const invite = (await (
      await fetch(`http://127.0.0.1:${port}/api/rooms/general/invites`, {
        method: "POST",
        headers: owner,
        body: JSON.stringify({ expiresInMinutes: 60, allowAgents: false }),
      })
    ).json()) as { token: string };
    const redeemed = await fetch(`http://127.0.0.1:${port}/api/invites/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: invite.token, username: "phone" }),
    });
    expect(redeemed.status).toBe(200);
    await first.app.close();
    rmSync(settingFile(dataDir));
    expect(existsSync(path.join(dataDir, "hive.sqlite"))).toBe(true);

    const second = await launch(dataDir);
    try {
      await enterRoom(second.page);
      expect(JSON.parse(readFileSync(settingFile(dataDir), "utf8"))).toEqual({ enabled: true });
      expect(await reachable(lanIp!)).toBe(true);
    } finally {
      await second.app.close();
    }

    // 没有别的设备连进来过的老数据：升级后只听本机
    const fresh = mkdtempSync(path.join(os.tmpdir(), "superhive-desktop-lan-quiet-"));
    try {
      const third = await launch(fresh);
      await enterRoom(third.page);
      await third.app.close();
      rmSync(settingFile(fresh));
      const fourth = await launch(fresh);
      try {
        await enterRoom(fourth.page);
        expect(JSON.parse(readFileSync(settingFile(fresh), "utf8"))).toEqual({ enabled: false });
        expect(await reachable(lanIp!)).toBe(false);
      } finally {
        await fourth.app.close();
      }
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
