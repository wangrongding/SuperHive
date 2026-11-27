#!/usr/bin/env node
// 宣传截图：起「两步验证从需求到上线」的演示 Server（promo/stills-server.mjs），用独立的无头 Chrome 按 2 倍像素
// 截客户端界面：主界面、终端、代码 diff、产物预览、进展、手机版，浅色深色各一张，16:10 和 16:9 各一套。
//
//   pnpm --filter @superhive/docs promo:stills                    # 全部
//   pnpm --filter @superhive/docs promo:stills --only code,terminal --format 16x10 --theme dark
//
// 成品在仓库根的 output/promo/（已被 .gitignore 忽略）。演示 Server 的 HOME、数据库、演示仓库都在临时目录，
// 只监听 127.0.0.1，不连 IM、不起真实 Agent；截图前检查画面里没有本机路径和用户名。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { findChrome, initialStorage, launchChrome } from "../../../../scripts/screenshot.mjs";
import { SHOT_HELPERS, evaluate, startDemo } from "../screens.mjs";
import { promptHtml, setupHtml } from "./stills-assets.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../../..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 两种比例：2 倍像素后分别是 2880×1800 和 3200×1800 */
const FORMATS = {
  "16x10": { width: 1440, height: 900 },
  "16x9": { width: 1600, height: 900 },
};
/** 手机版：iPhone 尺寸，3 倍像素 1170×2532 */
const MOBILE = { width: 390, height: 844, scale: 3 };

/**
 * 每张图：打开哪个房间、先做什么。prepare 是页面里执行的脚本（可用 __shot 辅助函数）。
 * terminal: true 时开着内置终端，回放一段测试输出。
 */
export const SHOTS = [
  {
    name: "overview",
    title:
      "主界面全景：林夏提需求，claude-1 拆成四路派给 Gemini、Codex、Claude、Copilot，回执、提问、执行中的卡片都在消息流里",
    prepare: [`__shot.find("article.thinking-card")`],
  },
  {
    name: "delegation",
    title: "派活与回执：主 Agent 拆分后用 hive_invoke 派出四个子任务，林夏点选回答 claude-2 的提问",
    prepare: [
      `__shot.find("article.message.question")`,
      // 滚到开头：需求、拆分、派活卡片和提问在一屏里
      `__shot.scrollTo((el) => /这周要上两步验证/.test(el.textContent))`,
      `__shot.scrollTo((el) => /这周要上两步验证/.test(el.textContent))`,
    ],
  },
  {
    name: "terminal",
    title: "内置终端：在 codex-1 的任务线上跑 vitest，32 个用例通过，旁边 codex-2 正在跑 E2E",
    terminal: true,
    prepare: [
      `__shot.click(".terminal-toggle")`,
      `__shot.find(".xterm-rows")`,
      `__shot.find("article.thinking-card").then((el) => el.scrollIntoView({ block: "end" }))`,
    ],
  },
  {
    name: "code",
    title:
      "代码面板：codex-1 任务线相对 main 的彩色 diff（login.ts 加登录第二步），左边是改动文件列表",
    prepare: [
      `__shot.click(".workspace-toggle")`,
      `__shot.click(".workspace-panel [role=row], .workspace-panel li, .workspace-panel button", (el) => /login\\.ts/.test(el.textContent))`,
      `__shot.find(".workspace-panel .diff-line, .workspace-panel [class*=diff]")`,
    ],
  },
  {
    name: "commits",
    title: "代码面板 · 最近提交：codex-1 的四个提交和 main 上的历史",
    prepare: [
      `__shot.click(".workspace-toggle")`,
      `__shot.click("#workspace-tab-commits")`,
      `__shot.click(".workspace-commit", (el) => /开启两步验证后登录/.test(el.textContent))`,
      `__shot.click(".workspace-panel button, .workspace-panel [role=row]", (el) => /login\\.ts/.test(el.textContent) && !el.closest(".workspace-commits"))`,
    ],
  },
  {
    name: "artifacts",
    title: "产物面板：Agent 交回的调研报告、安全 review、两张界面截图，打开安全 review 报告预览",
    prepare: [
      `__shot.click(".artifacts-toggle")`,
      `__shot.click(".artifact-open", (el) => /安全 review\\.md/.test(el.textContent))`,
      `__shot.click("button", (el) => el.textContent.trim() === "预览")`,
      `new Promise((resolve) => setTimeout(resolve, 1500))`,
    ],
  },
  {
    name: "artifact-image",
    title: "产物预览：claude-2 交回的「绑定两步验证」界面截图",
    prepare: [
      `__shot.click(".artifacts-toggle")`,
      `__shot.click(".artifact-open, .artifact-tile", (el) => /绑定两步验证/.test(el.textContent + (el.getAttribute("aria-label") ?? "")))`,
      `new Promise((resolve) => setTimeout(resolve, 1500))`,
    ],
  },
  {
    name: "progress",
    title: "进展：白板上两步验证各路的状态，在做、卡住等你决定、做完待验收",
    prepare: [`__shot.click("#side-tab-whiteboard")`, `__shot.find(".progress-board")`],
  },
];

const MOBILE_SHOTS = [
  {
    name: "mobile",
    title: "手机版：同一个房间，claude-1 汇总四路结果的表格和林夏的下一步安排",
    prepare: [`__shot.scrollTo((el) => /两步验证四路都交回了，我 review 过/.test(el.textContent))`],
  },
];

/** 假桌面端：网页只有在桌面端里才显示终端入口；新开终端时回放一段固定输出，不起真的 shell */
const FAKE_DESKTOP = (cwd, log) => {
  const e = "\u001b";
  const dim = (text) => `${e}[2m${text}${e}[0m`;
  const green = (text) => `${e}[32m${text}${e}[0m`;
  const prompt = `${e}[1;36mweb${e}[0m ${dim("on")} ${e}[1;35m⎇ feat/codex-1-two-factor${e}[0m ${e}[33m[!]${e}[0m\r\n${e}[1;32m❯${e}[0m `;
  const pass = (file, tests, ms) =>
    ` ${green("✓")} ${file} ${dim(`(${tests} tests)`)} ${e}[33m${ms}ms${e}[0m\r\n`;
  const replay = [
    `${prompt}pnpm vitest run src/auth\r\n\r\n`,
    ` ${e}[1;46;30m RUN ${e}[0m ${e}[36mv3.2.4${e}[0m ${dim("~/work/web")}\r\n\r\n`,
    pass("src/auth/totp.test.ts", 11, 18),
    pass("src/auth/backup-codes.test.ts", 7, 24),
    pass("src/auth/login.test.ts", 9, 41),
    pass("src/auth/session.test.ts", 5, 12),
    `\r\n ${dim("Test Files")}  ${e}[1;32m4 passed${e}[0m ${dim("(4)")}\r\n`,
    ` ${dim("     Tests")}  ${e}[1;32m32 passed${e}[0m ${dim("(32)")}\r\n`,
    ` ${dim("  Duration")}  1.42s ${dim("(transform 96ms, setup 0ms, collect 210ms, tests 95ms)")}\r\n\r\n`,
    `${prompt}git log --oneline -4\r\n`,
    ...log.map(
      ([hash, subject], index) =>
        `${e}[33m${hash}${e}[0m ${index ? "" : `${e}[1;36m(HEAD -> feat/codex-1-two-factor)${e}[0m `}${subject}\r\n`,
    ),
    "\r\n",
    prompt,
  ].join("");
  return `(() => {
    const listeners = new Set();
    window.superhiveDesktop = {
      version: 1,
      platform: "darwin",
      terminal: {
        async create() {
          setTimeout(() => listeners.forEach((listener) => listener("demo-1", ${JSON.stringify(replay)})), 50);
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

const EXTRA_HELPERS = `Object.assign(window.__shot, {
  /** 消息列表滚到匹配的那条消息在顶部 */
  async scrollTo(match) {
    await this.find("article.message", match);
    const roots = [document, ...[...document.querySelectorAll("*")].filter((el) => el.shadowRoot).map((el) => el.shadowRoot)];
    // 取第一条：后面回复它的消息里也带着它的引用
    const el = roots.flatMap((root) => [...root.querySelectorAll("article.message")]).find(match);
    el.scrollIntoView({ block: "start" });
    // 滚到中间时底部会浮出「回到最新消息」，宣传图里挡字，藏掉
    if (!document.querySelector("#promo-hide-jump")) {
      const style = document.createElement("style");
      style.id = "promo-hide-jump";
      style.textContent = ".jump-to-bottom{display:none!important}";
      document.head.append(style);
    }
  },
  /** 画面里（含 shadow DOM、输入框）还有没有本机路径或用户名 */
  leaks(words) {
    const found = [];
    const roots = [document.body, ...[...document.querySelectorAll("*")].filter((el) => el.shadowRoot).map((el) => el.shadowRoot)];
    for (const root of roots) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode())
        for (const word of words) if (node.nodeValue.includes(word)) found.push(node.nodeValue.trim().slice(0, 120));
    }
    for (const el of document.querySelectorAll("input, textarea"))
      for (const word of words) if (el.value.includes(word)) found.push(el.value.slice(0, 120));
    const rows = document.querySelector(".xterm-rows");
    for (const word of words) if (rows?.textContent.includes(word)) found.push("终端：" + word);
    return found;
  },
});`;

function parseOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      only: { type: "string" },
      theme: { type: "string", default: "light,dark" },
      format: { type: "string", default: "16x10,16x9,mobile" },
      "no-build": { type: "boolean", default: false },
      out: { type: "string", default: path.join(ROOT, "output/promo") },
      keep: { type: "boolean", default: false },
      chrome: { type: "string" },
    },
  });
  const all = [...SHOTS, ...MOBILE_SHOTS].map((shot) => shot.name);
  const only = values.only?.split(",").map((name) => name.trim());
  for (const name of only ?? []) if (!all.includes(name)) throw new Error(`没有这张图：${name}`);
  const formats = values.format.split(",").map((name) => name.trim());
  for (const name of formats)
    if (!(name in FORMATS) && name !== "mobile") throw new Error(`没有这种比例：${name}`);
  return {
    only,
    themes: values.theme.split(",").map((theme) => theme.trim()),
    formats,
    build: !values["no-build"],
    out: path.resolve(values.out),
    keep: values.keep,
    chrome: values.chrome,
  };
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} 失败`)),
    );
  });
}

/** 设计稿 HTML → PNG（2 倍像素），给演示 Server 当附件 */
async function renderAsset(cdp, html, file) {
  const width = 1200;
  const height = 760;
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await cdp.send("Page.navigate", {
    url: `data:text/html;base64,${Buffer.from(html).toString("base64")}`,
  });
  await cdp.evaluate(`(async () => {
    while (document.readyState !== "complete") await new Promise((r) => setTimeout(r, 50));
    await document.fonts.ready;
  })()`);
  const shot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    clip: { x: 0, y: 0, width, height, scale: 1 },
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
}

async function capture(cdp, demo, shot, { theme, viewport, mobile, file }) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: viewport.scale ?? 2,
    mobile: Boolean(mobile),
  });
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: Boolean(mobile) });
  const url = new URL(demo.url);
  url.hash = "web";
  const storage = initialStorage({ user: demo.owner, theme, room: "web" });
  const { identifier } = await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `${SHOT_HELPERS}
      ${EXTRA_HELPERS}
      if (location.origin === ${JSON.stringify(url.origin)}) {
        ${mobile ? "" : FAKE_DESKTOP(path.join(demo.home, "work/web"), demo.log)}
        localStorage.setItem("superhive.terminal-layout", JSON.stringify({ position: "bottom", maximized: false, height: 490, width: 560 }));
        for (const key of Object.keys(localStorage)) if (key.startsWith("superhive.draft.")) localStorage.removeItem(key);
        localStorage.removeItem("superhive.preview-docked");
        localStorage.removeItem("superhive.workspace");
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
    await sleep(1800);
    await evaluate(cdp, `__shot.tildeHome(${JSON.stringify(demo.home)})`, "替换演示目录");
    for (const [index, step] of shot.prepare.entries()) {
      await evaluate(cdp, step, `${shot.name} 第 ${index + 1} 步`);
      await sleep(700);
    }
    await sleep(900);
    await evaluate(cdp, `__shot.tildeHome(${JSON.stringify(demo.home)})`, "替换演示目录");
    const leaks = await evaluate(
      cdp,
      `__shot.leaks(${JSON.stringify([demo.home, "/Users/", "/private/var", os.userInfo().username])})`,
      "查本机路径",
      true,
    );
    if (leaks.length)
      throw new Error(`${shot.name} 画面里有本机路径或用户名：\n${leaks.join("\n")}`);
    const data = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(data.data, "base64"));
    console.log(path.relative(ROOT, file));
  } finally {
    await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.build)
    for (const pkg of ["@superhive/protocol", "@superhive/web"])
      await run("pnpm", ["--filter", pkg, "build"]);
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hive-promo-stills-")));
  let chrome;
  let demo;
  try {
    chrome = await launchChrome(findChrome(options.chrome));
    const { cdp } = chrome;
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await renderAsset(cdp, setupHtml(), path.join(home, "assets/setup.png"));
    await renderAsset(cdp, promptHtml(), path.join(home, "assets/prompt.png"));
    demo = await startDemo(home, path.join(import.meta.dirname, "stills-server.mjs"));
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    const want = (shot) => !options.only || options.only.includes(shot.name);
    const captions = [];
    for (const format of options.formats) {
      const shots = format === "mobile" ? MOBILE_SHOTS : SHOTS;
      for (const shot of shots.filter(want))
        for (const theme of options.themes) {
          const file = path.join(options.out, format, `${shot.name}-${theme}.png`);
          await capture(cdp, demo, shot, {
            theme,
            viewport: format === "mobile" ? MOBILE : FORMATS[format],
            mobile: format === "mobile",
            file,
          });
          captions.push(`- \`${format}/${shot.name}-${theme}.png\`：${shot.title}`);
        }
    }
    fs.mkdirSync(options.out, { recursive: true });
    fs.writeFileSync(path.join(options.out, "README.md"), `# 宣传截图\n\n${captions.join("\n")}\n`);
    cdp.close();
  } finally {
    await chrome?.close();
    await demo?.stop();
    if (options.keep) console.log(`[stills] 保留临时目录：${home}`);
    else fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

try {
  await main();
} catch (error) {
  console.error(`[stills] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
