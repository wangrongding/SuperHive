#!/usr/bin/env node
// 重截文档里的界面配图（public/media/screens/*.{light,dark}.png）：一条命令起演示 Server、截图、压缩。
//
//   pnpm --filter @superhive/docs screens                    # 全部重截
//   pnpm --filter @superhive/docs screens --only overview,progress
//   pnpm --filter @superhive/docs screens --locale en        # 英文界面，存成 *.en.{light,dark}.png
//
// 演示 Server（screens/demo-server.mjs）在临时目录里起：独立 HOME、独立数据库、演示仓库，只监听 127.0.0.1，
// 不连 IM、不拉起真实 Agent、不联网；截完关掉并删除临时目录。截图用独立的无头 Chrome（仓库根
// scripts/screenshot.mjs 的同一套），按 2 倍像素截，再转成 8 位调色板 PNG。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { HELPERS, findChrome, initialStorage, launchChrome } from "../../../scripts/screenshot.mjs";
import { EXACT, TEXT } from "./screens/demo-text.en.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const OUT_DIR = path.resolve(import.meta.dirname, "../public/media/screens");
const SCALE = 2;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 每张图：打开哪个房间、视口多大、先做什么、截哪一块。
 * prepare / clip 是在页面里执行的脚本；clip 返回 CSS 像素的矩形，pad 往外留白。
 * 消息在 .message-list 的 shadow DOM 里，用 __shot.deep 找。
 */
export const SHOTS = [
  {
    name: "overview",
    room: "web",
    // 合入可清理的提示条要等任务目录状态算完
    prepare: [`__shot.find(".worktree-batch")`],
  },
  {
    // 首页首屏的大图（和 README 顶部的图）：和 overview 同一个房间，但按桌面端打开，底部开着终端面板。
    // 首页在大屏上会换成可以点的演示（home/hero-demo.ts），这张图是首屏先显示的画面、手机上的展示和搜索引擎看到的图
    name: "studio",
    room: "web",
    desktop: true,
    prepare: [
      `__shot.find(".worktree-batch")`,
      `__shot.click(".terminal-toggle")`,
      `__shot.find(".xterm-rows")`,
      // 终端占了下半截：把执行中的卡片滚到输入框上方，提问卡片和执行过程都在画面里
      `__shot.find("article.thinking-card").then((el) => el.scrollIntoView({ block: "end" }))`,
    ],
  },
  {
    name: "sidebar",
    room: "web",
    clip: `__shot.rect(".rooms-panel")`,
  },
  {
    name: "mention",
    // 没有聊天记录的房间：弹窗背后是空白，不压在消息上
    room: "api",
    // 视口高一些：空房间居中的「开始第一条消息」离输入框远，不进截图
    height: 1400,
    prepare: [
      `__shot.focus(".rich-composer-content")`,
      { type: "@" },
      `__shot.find(".mention-menu, [role=listbox]")`,
    ],
    clip: `__shot.union([".composer", ".mention-menu, [role=listbox]"], { x: 12, y: 12 })`,
  },
  {
    name: "running",
    room: "web",
    clip: `__shot.rect("article.thinking-card", { x: 12, y: 12 }, true)`,
  },
  {
    name: "ask",
    room: "web",
    clip: `__shot.rect("article.message.question", { x: 12, y: 12 }, true)`,
  },
  {
    name: "decide",
    room: "infra",
    clip: `__shot.rect("article.message:has(.invocation-chip.failed)", { x: 12, y: 12 }, true)`,
  },
  {
    name: "progress",
    room: "web",
    prepare: [`__shot.click("#side-tab-whiteboard")`],
    clip: `__shot.until(".members-panel", ".progress-board", 12)`,
  },
  {
    name: "worktrees",
    room: "web",
    // 顶栏「⎇ 分支」下拉底部「管理任务目录」打开的大面板，默认是右侧抽屉
    prepare: [
      `__shot.click(".worktree-switcher-toggle")`,
      `__shot.click(".worktree-switcher-manage")`,
      `__shot.find(".worktree-sheet .worktree-entry")`,
    ],
    clip: `__shot.until(".worktree-sheet", ".worktree-panel > .worktree-toolbar", 24)`,
  },
  {
    name: "incidents",
    room: "web",
    // 左侧「故障」入口打开的弹出面板：升级给人的排在最前
    prepare: [
      `__shot.click(".sidebar-action[aria-haspopup=dialog]", (el) => /^(故障|Incidents)/.test(el.textContent.trim()))`,
      `__shot.find(".incidents-dialog li.incident")`,
    ],
    // 面板比内容高：截到最后一个折叠分组下面
    clip: `__shot.until(".incidents-dialog", ".incidents-dialog-body > :last-child", 20)`,
  },
  {
    name: "preview-dock",
    room: "design",
    // 点开 claude 交付的 Markdown，再点「在右侧栏打开」：预览停在对话旁边，输入框照常能用
    prepare: [
      `__shot.click(".message-file")`,
      `__shot.click('.file-preview-size:is([aria-label="在右侧栏打开"], [aria-label="Open in side panel"])')`,
      `__shot.find(".file-preview-text.markdown h1")`,
    ],
  },
  {
    name: "onboard",
    room: "web",
    prepare: [`__shot.click(".sidebar-agent-entry")`, `__shot.find("[role=dialog]")`],
    clip: `__shot.rect("[role=dialog]")`,
  },
  {
    name: "clis",
    room: "web",
    // 设置弹窗最高 720px，放不下八个 CLI：截图时视口加高、弹窗放开到视口高，一屏看到全部
    height: 1200,
    prepare: [
      `__shot.click(".sidebar-user-chip")`,
      `__shot.click('[role="menuitem"]', (el) => /^(设置|Settings)$/.test(el.textContent.trim()))`,
      `__shot.click('[aria-controls="settings-panel-runtimes"]')`,
      `document.querySelector(".settings-dialog").style.height = "calc(100dvh - 48px)"`,
      `__shot.find("#settings-panel-runtimes .agent-cli-path")`,
    ],
    // 截到最后一个 CLI 下面，去掉弹窗底部的空白
    clip: `__shot.until("[role=dialog]", "#settings-panel-runtimes .settings-group:has(.agent-cli)", 24)`,
  },
];

/** 截图页面里的辅助函数：在 shadow DOM 里也能找；量位置前先滚到可见 */
const SHOT_HELPERS = `${HELPERS}
Object.assign(window.__shot, {
  deep(selector, match) {
    const roots = [document, ...[...document.querySelectorAll("*")].filter((el) => el.shadowRoot).map((el) => el.shadowRoot)];
    for (const root of roots) {
      const found = [...root.querySelectorAll(selector)].filter((el) => !match || match(el));
      if (found.length) return found[found.length - 1];
    }
  },
  async find(selector, match) {
    const deadline = Date.now() + 15000;
    for (;;) {
      const found = this.deep(selector, match);
      if (found) return found;
      if (Date.now() > deadline) throw new Error("没找到元素：" + selector);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  },
  async focus(selector) {
    (await this.find(selector)).focus();
  },
  async scrollIntoView(selector) {
    (await this.find(selector)).scrollIntoView({ block: "start" });
  },
  async rect(selector, pad = { x: 0, y: 0 }, scroll = false) {
    const el = await this.find(selector);
    if (scroll) el.scrollIntoView({ block: "center" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const r = el.getBoundingClientRect();
    return { x: r.left - pad.x, y: r.top - pad.y, width: r.width + pad.x * 2, height: r.height + pad.y * 2 };
  },
  async union(selectors, pad = { x: 0, y: 0 }) {
    const rects = await Promise.all(selectors.map(async (selector) => (await this.find(selector)).getBoundingClientRect()));
    const left = Math.min(...rects.map((r) => r.left)) - pad.x;
    const top = Math.min(...rects.map((r) => r.top)) - pad.y;
    const right = Math.max(...rects.map((r) => r.right)) + pad.x;
    const bottom = Math.max(...rects.map((r) => r.bottom)) + pad.y;
    return { x: left, y: top, width: right - left, height: bottom - top };
  },
  /** 把页面（含 shadow DOM）文字里的演示 HOME 换成 ~；之后新渲染的也换 */
  tildeHome(home) {
    const fix = (root) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode())
        if (node.nodeValue.includes(home)) node.nodeValue = node.nodeValue.replaceAll(home, "~");
    };
    const all = () => {
      fix(document.body);
      for (const el of document.querySelectorAll("*")) if (el.shadowRoot) fix(el.shadowRoot);
    };
    all();
    if (!this.homeObserver) {
      this.homeObserver = new MutationObserver(all);
      this.homeObserver.observe(document.body, { subtree: true, childList: true, characterData: true });
    }
  },
  /** 英文截图：把演示数据里的中文换成英文（pairs 已按长度从长到短排好）；之后新渲染的也换 */
  translate(pairs, exact) {
    const fix = (root) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const value = node.nodeValue;
        if (!/[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/.test(value)) continue;
        const key = value.trim();
        let next = key in exact ? value.replace(key, exact[key]) : value;
        for (const [from, to] of pairs) if (next.includes(from)) next = next.replaceAll(from, to);
        if (next !== value) node.nodeValue = next;
      }
    };
    const all = () => {
      fix(document.body);
      for (const el of document.querySelectorAll("*")) if (el.shadowRoot) fix(el.shadowRoot);
    };
    all();
    if (!this.textObserver) {
      this.textObserver = new MutationObserver(all);
      this.textObserver.observe(document.body, { subtree: true, childList: true, characterData: true });
    }
  },
  /** 截图范围里还剩的中文，方便补 demo-text.en.mjs */
  leftovers(clip) {
    const found = new Set();
    const roots = [document.body, ...[...document.querySelectorAll("*")].filter((el) => el.shadowRoot).map((el) => el.shadowRoot)];
    for (const root of roots) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!/[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/.test(node.nodeValue) || !node.parentElement) continue;
        const r = node.parentElement.getBoundingClientRect();
        if (!r.width || r.right < clip.x || r.left > clip.x + clip.width || r.bottom < clip.y || r.top > clip.y + clip.height) continue;
        found.add(node.nodeValue.trim());
      }
    }
    return [...found];
  },
  /** 取 container 的左右和上沿，下沿截到 last 元素下方 pad 处（去掉底部空白） */
  async until(container, last, pad = 0) {
    const c = (await this.find(container)).getBoundingClientRect();
    const l = (await this.find(last)).getBoundingClientRect();
    return { x: c.left, y: c.top, width: c.width, height: Math.min(c.bottom, l.bottom + pad) - c.top };
  },
  /** 从 start 元素上方 gap 处截到 container 底部，宽度取 container */
  async from(start, container, gap = 0) {
    const s = (await this.find(start)).getBoundingClientRect();
    const c = (await this.find(container)).getBoundingClientRect();
    const top = Math.max(c.top, s.top - gap);
    return { x: c.left, y: top, width: c.width, height: c.bottom - top };
  },
});`;

function parseOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      only: { type: "string" },
      theme: { type: "string", default: "light,dark" },
      "no-build": { type: "boolean", default: false },
      out: { type: "string", default: OUT_DIR },
      keep: { type: "boolean", default: false },
      locale: { type: "string", default: "zh-CN" },
      chrome: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const names = values.only?.split(",").map((name) => name.trim());
  for (const name of names ?? [])
    if (!SHOTS.some((shot) => shot.name === name)) throw new Error(`没有这张图：${name}`);
  if (!["zh-CN", "en"].includes(values.locale))
    throw new Error(`--locale 只能是 zh-CN / en：${values.locale}`);
  const themes = values.theme.split(",").map((theme) => theme.trim());
  for (const theme of themes)
    if (!["light", "dark"].includes(theme))
      throw new Error(`--theme 只能是 light / dark：${theme}`);
  return {
    help: values.help,
    shots: names ? SHOTS.filter((shot) => names.includes(shot.name)) : SHOTS,
    themes,
    build: !values["no-build"],
    out: path.resolve(values.out),
    keep: values.keep,
    chrome: values.chrome,
    locale: values.locale,
  };
}

const HELP = `用法：pnpm --filter @superhive/docs screens [选项]

  --only <名字,...>   只截这几张（${SHOTS.map((shot) => shot.name).join("、")}）
  --theme <主题>      light、dark 或 light,dark（默认两套都截）
  --no-build          不重新构建 protocol 与网页，直接用现有的 apps/web/dist
  --out <目录>        输出目录（默认 public/media/screens）
  --keep              保留演示 Server 的临时目录（会打印路径）
  --locale <语言>     zh-CN（默认）或 en：英文界面，演示数据按 screens/demo-text.en.mjs 换成英文，
                      存成 名字.en.主题.png，英文文档页自动换用
  --chrome <路径>     Chrome 可执行文件（也可用环境变量 CHROME_PATH）`;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} 失败`)),
    );
  });
}

/** 起演示 Server：HOME 指向临时目录，等它打印 DEMO_READY */
async function startDemo(home) {
  const log = path.join(home, "demo-server.log");
  const child = spawn(
    process.execPath,
    ["--import", "tsx", path.join(import.meta.dirname, "screens/demo-server.mjs")],
    {
      cwd: path.join(ROOT, "apps/server"),
      env: {
        // 只带运行要用的环境：不把本机的 HIVE_* 配置、令牌带进演示 Server
        PATH: process.env.PATH,
        HOME: home,
        HIVE_DEMO_ROOT: home,
        TZ: process.env.TZ ?? "Asia/Shanghai",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const output = fs.createWriteStream(log);
  child.stderr.pipe(output);
  // 失败时把日志末尾带进报错：临时目录随后会被删掉
  const tail = () => {
    output.end();
    const text = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
    return text.trim().split("\n").slice(-15).join("\n");
  };
  const ready = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`演示 Server 启动超时：\n${tail()}`)), 90_000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      output.write(chunk);
      const line = buffer.split("\n").find((item) => item.startsWith("DEMO_READY "));
      if (!line) return;
      clearTimeout(timer);
      resolve(JSON.parse(line.slice("DEMO_READY ".length)));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      // 等日志写完再读
      setTimeout(() => reject(new Error(`演示 Server 退出（退出码 ${code}）：\n${tail()}`)), 200);
    });
  });
  const stop = () =>
    new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      const force = setTimeout(() => child.kill("SIGKILL"), 5_000);
      child.once("exit", () => {
        clearTimeout(force);
        resolve();
      });
      child.kill("SIGTERM");
    });
  return { ...ready, stop };
}

/** returnValue=false 时丢掉结果：按值回传 DOM 元素会报「Object reference chain is too long」 */
async function evaluate(cdp, script, label, returnValue = false) {
  try {
    return await cdp.evaluate(
      returnValue ? `(async () => await (${script}))()` : `(async () => { await (${script}); })()`,
    );
  } catch (error) {
    throw new Error(`${label}：${error.message}`);
  }
}

/**
 * 截图用的假桌面端：网页只有在桌面端里才显示终端入口。这里给一个形状对的 window.superhiveDesktop，
 * 新开终端时回放一段固定输出，不起真的 shell。
 */
const FAKE_DESKTOP = (cwd) => {
  const esc = "\\u001b";
  const prompt = `${esc}[1;36mweb${esc}[0m ${esc}[2mon${esc}[0m ${esc}[1;35mmain${esc}[0m\\r\\n${esc}[1;32m❯${esc}[0m `;
  const replay = [
    prompt + "pnpm vitest run src/mobile/checkout\\r\\n\\r\\n",
    ` ${esc}[32m✓${esc}[0m src/mobile/checkout/price.test.ts ${esc}[2m(6 tests)${esc}[0m ${esc}[33m41ms${esc}[0m\\r\\n`,
    ` ${esc}[32m✓${esc}[0m src/mobile/checkout/summary.test.ts ${esc}[2m(4 tests)${esc}[0m ${esc}[33m28ms${esc}[0m\\r\\n\\r\\n`,
    ` ${esc}[2m Test Files${esc}[0m  ${esc}[1;32m2 passed${esc}[0m ${esc}[2m(2)${esc}[0m\\r\\n`,
    ` ${esc}[2m      Tests${esc}[0m  ${esc}[1;32m10 passed${esc}[0m ${esc}[2m(10)${esc}[0m\\r\\n\\r\\n`,
    prompt,
  ].join("");
  return `(() => {
    const listeners = new Set();
    window.superhiveDesktop = {
      version: 1,
      platform: "darwin",
      terminal: {
        async create() {
          setTimeout(() => listeners.forEach((listener) => listener("demo-1", "${replay}")), 50);
          return { id: "demo-1", shell: "/bin/zsh", cwd: ${JSON.stringify(cwd)} };
        },
        write() {},
        resize() {},
        kill() {},
        onData(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        onExit() { return () => {}; },
        onNewRequest() { return () => {}; },
      },
    };
  })();`;
};

const TEXT_PAIRS = Object.entries(TEXT).sort(([a], [b]) => b.length - a.length);

async function captureShot(cdp, demo, shot, theme, file, locale) {
  const width = shot.width ?? 1440;
  const height = shot.height ?? 900;
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: SCALE,
    mobile: false,
  });
  const url = new URL(demo.url);
  url.hash = shot.room;
  const english = locale === "en";
  const storage = initialStorage({
    user: demo.owner,
    theme,
    room: shot.room,
    ...(english ? { locale } : {}),
  });
  const translate = english
    ? `__shot.translate(${JSON.stringify(TEXT_PAIRS)}, ${JSON.stringify(EXACT)})`
    : "";
  const { identifier } = await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `${SHOT_HELPERS}
      if (location.origin === ${JSON.stringify(url.origin)}) {
        ${shot.desktop ? FAKE_DESKTOP(path.join(demo.home, "work", shot.room)) : ""}
        ${shot.desktop ? `localStorage.setItem("superhive.terminal-layout", JSON.stringify({ position: "bottom", maximized: false, height: 200, width: 560 }));` : `localStorage.removeItem("superhive.terminal-layout");`}
        // 输入框草稿按房间存在 localStorage：上一张图（如浅色版）敲的「@」会留到下一张，再敲就成了「@@」
        for (const key of Object.keys(localStorage)) if (key.startsWith("superhive.draft.")) localStorage.removeItem(key);
        // 点过「在右侧栏打开」会记住：浅色版点过后，深色版一打开就已经停在右侧栏，找不到那个按钮
        localStorage.removeItem("superhive.preview-docked");
        for (const [key, value] of Object.entries(${JSON.stringify(storage)})) localStorage.setItem(key, value);
      }`,
  });
  try {
    await cdp.send("Page.navigate", { url: "about:blank" });
    await cdp.send("Page.navigate", { url: url.href });
    await evaluate(
      cdp,
      `(async () => {
        await __shot.find(".app-shell");
        await __shot.find(".message-list");
        await document.fonts.ready;
      })()`,
      `${shot.name} 页面没加载出来`,
    );
    await sleep(1500);
    // 演示目录显示成 ~（和平时在自己电脑上看到的一样），不露出临时目录
    await evaluate(cdp, `__shot.tildeHome(${JSON.stringify(demo.home)})`, "替换演示目录");
    if (english) await evaluate(cdp, translate, "演示数据换成英文");
    for (const [index, step] of (shot.prepare ?? []).entries()) {
      if (typeof step === "string") await evaluate(cdp, step, `${shot.name} 第 ${index + 1} 步`);
      else await cdp.send("Input.insertText", { text: step.type });
      await sleep(500);
    }
    const clip = shot.clip
      ? await evaluate(cdp, shot.clip, `${shot.name} 量截图范围`, true)
      : { x: 0, y: 0, width, height };
    await evaluate(cdp, `__shot.tildeHome(${JSON.stringify(demo.home)})`, "替换演示目录");
    if (english) {
      await evaluate(cdp, translate, "演示数据换成英文");
      await sleep(300);
      const left = await evaluate(cdp, `__shot.leftovers(${JSON.stringify(clip)})`, "查中文", true);
      if (left.length) console.warn(`[screens] ${shot.name} 还有中文：${JSON.stringify(left)}`);
    }
    // 截到整像素，避免 2 倍图边缘出现半像素的模糊
    const rounded = {
      x: Math.max(0, Math.round(clip.x)),
      y: Math.max(0, Math.round(clip.y)),
      width: Math.round(clip.width),
      height: Math.round(clip.height),
      scale: 1,
    };
    const shotData = await cdp.send("Page.captureScreenshot", { format: "png", clip: rounded });
    await sharp(Buffer.from(shotData.data, "base64"))
      .png({ palette: true, colors: 256, effort: 10, compressionLevel: 9 })
      .toFile(file);
    console.log(
      `${path.relative(process.cwd(), file)}  ${rounded.width * SCALE}×${rounded.height * SCALE}`,
    );
  } finally {
    await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
  }
}

async function main() {
  let options;
  try {
    options = parseOptions(process.argv.slice(2));
  } catch (error) {
    console.error(`[screens] ${error.message}\n\n${HELP}`);
    process.exit(1);
  }
  if (options.help) {
    console.log(HELP);
    return;
  }
  if (options.build) {
    for (const pkg of ["@superhive/protocol", "@superhive/web"])
      await run("pnpm", ["--filter", pkg, "build"]);
  }
  if (!fs.existsSync(path.join(ROOT, "apps/web/dist/index.html")))
    throw new Error("没有网页构建产物（apps/web/dist），去掉 --no-build 重新构建");

  // realpath：macOS 的临时目录经 /var → /private/var 软链，HOME 要和真实路径一致，界面上才显示成 ~
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hive-docs-screens-")));
  let demo;
  let chrome;
  try {
    demo = await startDemo(home);
    chrome = await launchChrome(findChrome(options.chrome));
    const { cdp } = chrome;
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    fs.mkdirSync(options.out, { recursive: true });
    for (const shot of options.shots)
      for (const theme of options.themes)
        await captureShot(
          cdp,
          demo,
          shot,
          theme,
          path.join(
            options.out,
            `${shot.name}${options.locale === "en" ? ".en" : ""}.${theme}.png`,
          ),
          options.locale,
        );
    cdp.close();
  } finally {
    await chrome?.close();
    await demo?.stop();
    if (options.keep) console.log(`[screens] 保留临时目录：${home}`);
    else fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  try {
    await main();
  } catch (error) {
    console.error(`[screens] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
