/**
 * 加入别人的房间：本机页面经桌面端打开另一个 Hive，对方的页面开在单独的窗口里、拿不到桌面端能力；
 * superhive:// 链接同样能打开；侧栏列出「别人的服务器」，忘掉后窗口关掉、列表清空。
 * 「别人的 Hive」用同一个桌面端包里的 Server 再起一份（独立端口和数据目录）。
 */
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { desktopDir, enterRoom, shotDir } from "./flows.js";

let app: ElectronApplication;
let page: Page;
let dataDir: string;
let remoteDir: string;
let remote: ChildProcess;
const port = 18_700 + Math.floor(Math.random() * 200);
const remotePort = port + 300;
const remoteOrigin = `http://localhost:${remotePort}`;

async function waitFor(predicate: () => Promise<boolean>, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("timed out");
}

test.beforeAll(async () => {
  remoteDir = mkdtempSync(path.join(os.tmpdir(), "superhive-remote-smoke-"));
  const superhive = path.join(desktopDir, ".stage/app/superhive");
  remote = spawn(process.execPath, [path.join(superhive, "dist/server/index.js")], {
    env: {
      ...process.env,
      HIVE_HOST: "127.0.0.1",
      HIVE_PORT: String(remotePort),
      HIVE_DATABASE: path.join(remoteDir, "hive.sqlite"),
      HIVE_STATIC_DIR: path.join(superhive, "web"),
      HIVE_LOCAL_AGENTS: "0",
    },
    stdio: "ignore",
  });
  await waitFor(async () => (await fetch(`${remoteOrigin}/health`)).ok);

  dataDir = mkdtempSync(path.join(os.tmpdir(), "superhive-desktop-smoke-"));
  app = await electron.launch({
    args: [path.join(desktopDir, ".stage/app")],
    env: {
      ...process.env,
      SUPERHIVE_DESKTOP_DATA_DIR: dataDir,
      SUPERHIVE_DESKTOP_PORT: String(port),
      HIVE_NO_OPEN: "1",
    } as Record<string, string>,
  });
  const deadline = Date.now() + 60_000;
  while (!page && Date.now() < deadline) {
    const found = app.windows().find((win) => win.url().startsWith("http://127.0.0.1:"));
    if (found) page = found;
    else await app.waitForEvent("window", { timeout: 5_000 }).catch(() => undefined);
  }
  await enterRoom(page);
});

test.afterAll(async () => {
  await app?.close();
  remote?.kill();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(remoteDir, { recursive: true, force: true });
});

async function remoteWindow(): Promise<Page> {
  let found: Page | undefined;
  await waitFor(async () => {
    found = app.windows().find((win) => win.url().startsWith(remoteOrigin));
    return Boolean(found);
  });
  return found!;
}

test("pasting someone else's link opens their room in its own window without desktop powers", async () => {
  await page.getByRole("button", { name: /^(加入别人的房间|Join someone else's room)$/ }).click();
  const dialog = page.getByRole("dialog", { name: /加入别人的房间|Join someone else's room/ });
  await dialog.getByRole("textbox").fill(`${remoteOrigin}/#general`);
  await expect(dialog).toContainText(/单独的窗口|its own window/);
  await page.screenshot({ path: path.join(shotDir, "remote-paste.png") });
  await dialog.getByRole("button", { name: /^(加入|Join)$/ }).click();

  const other = await remoteWindow();
  await other.waitForLoadState("domcontentloaded");
  // 对方的页面拿不到终端、选文件这些本机能力
  expect(await other.evaluate(() => "superhiveDesktop" in window)).toBe(false);
  expect(await page.evaluate(() => "superhiveDesktop" in window)).toBe(true);
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle())),
    )
    .toContainEqual(expect.stringContaining(`localhost:${remotePort}`));
  await other.screenshot({ path: path.join(shotDir, "remote-window.png") });

  // 本机侧栏列出这个服务器，标出窗口开着
  const list = page.getByRole("group", { name: /别人的服务器|Other servers/ });
  await expect(list).toContainText(`localhost:${remotePort}`);
  await page.screenshot({ path: path.join(shotDir, "remote-sidebar.png") });
});

test("superhive:// links open the room too, and forgetting a server closes it", async () => {
  const other = await remoteWindow();
  await other.close();
  // 深链接先弹原生确认框：替换成记下内容；第一次点取消（什么都不做），第二次点加入
  await app.evaluate(({ dialog }) => {
    const answers = [1, 0];
    const seen: string[] = [];
    (globalThis as { __confirms?: string[] }).__confirms = seen;
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = args.at(-1) as { message: string; detail?: string };
      seen.push(`${options.message}\n${options.detail ?? ""}`);
      return { response: answers.shift() ?? 1, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  });
  const joinLink = `superhive://join?url=${encodeURIComponent(`${remoteOrigin}/#general`)}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await app.evaluate(({ app: electronApp }, url) => {
      electronApp.emit("open-url", { preventDefault() {} }, url);
    }, joinLink);
    await expect
      .poll(() =>
        app.evaluate(() => (globalThis as { __confirms?: string[] }).__confirms?.length ?? 0),
      )
      .toBe(attempt + 1);
    if (attempt === 0) {
      await page.waitForTimeout(500);
      expect(app.windows().some((window) => window.url().startsWith(remoteOrigin))).toBe(false);
    }
  }
  const confirms = await app.evaluate(
    () => (globalThis as { __confirms?: string[] }).__confirms ?? [],
  );
  expect(confirms[0]).toContain(remoteOrigin);
  expect(confirms[0]).toContain("general");
  await remoteWindow();

  // 带 Agent 加入的链接让本机页面弹出选 Agent 的对话框
  await app.evaluate(
    ({ app: electronApp }, url) => {
      electronApp.emit("open-url", { preventDefault() {} }, url);
    },
    `superhive://agent-join?server=${encodeURIComponent(remoteOrigin)}&room=general&name=guest-bot&token=hvs_abcdefgh1234`,
  );
  const agentDialog = page.getByRole("dialog", { name: /带 Agent 加入|Bring an agent/ });
  await expect(agentDialog).toContainText("guest-bot");
  await page.screenshot({ path: path.join(shotDir, "remote-agent-join.png") });
  await agentDialog.getByRole("button", { name: /^(关闭|Close)$/ }).click();

  const list = page.getByRole("group", { name: /别人的服务器|Other servers/ });
  await list.hover();
  await list
    .getByRole("button", { name: /忘掉|Forget/ })
    .first()
    .click();
  await list.getByRole("button", { name: /^(忘掉|Forget)$/ }).click();
  await expect(list).toHaveCount(0);
  await waitFor(async () => !app.windows().some((win) => win.url().startsWith(remoteOrigin)));
});
