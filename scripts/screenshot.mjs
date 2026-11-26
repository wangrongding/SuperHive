#!/usr/bin/env node
// 网页截图：开一个独立的无头 Chrome（临时 profile，用完即删），不碰你正在用的浏览器和登录状态。
//
//   pnpm screenshot --url http://127.0.0.1:PORT --room build --theme light,dark --action code
//   pnpm screenshot --compare output/before.png output/after.png --out output/compare.png
//
// 只依赖本机已装的 Chrome / Chromium / Edge 和 Node 自带的 WebSocket，不新增依赖。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const ROOT = path.resolve(import.meta.dirname, "..");
const HELP = `用法：
  pnpm screenshot --url <地址> [选项]
  pnpm screenshot --compare <改前.png> <改后.png> [...] [--labels 改前,改后] --out <输出.png>

截图选项：
  --url <地址>           网页地址，例如沙箱打印的 SANDBOX_URL（默认 http://127.0.0.1:5188）
  --room <房间>          打开的房间（默认地址里的 #房间，没有则 general）
  --user <名字>          以这个名字进入（写进 localStorage，默认 rd）
  --theme <主题>         light、dark，或 light,dark 一次截两张（默认 light）
  --locale <语言>        zh-CN 或 en（默认不改）
  --width / --height     视口宽高（默认 1600×1000）
  --scale <倍数>         设备像素比（默认 1；要高清图用 2）
  --action <动作>        可重复，按顺序执行：
                           code | artifacts            打开「代码」/「产物」面板
                           schedules                   打开左侧「定时任务」面板
                           settings[:分类]             打开设置，例如 settings:appearance
                           side:<members|whiteboard>   右侧栏切到某个 tab
                           click:<CSS 选择器>          点击元素（等它出现，最多 10 秒）
                           wait:<毫秒> | wait-for:<CSS 选择器>
                           eval:<JS 表达式>            在页面里执行
  --settle <毫秒>        每个动作后等页面稳定的时间（默认 800）
  --full-page            截整页（默认只截视口）
  --hide-sandbox-badge   隐藏沙箱预览标记
  --init-script <文件>   页面加载前先执行的 JS（可重复），用来放测试替身，比如拦截 fetch
                         返回沙箱里没有的本机 Agent 数据
  --out <文件>           输出 PNG（默认 output/screenshot-时间.png；多主题时自动加 -light/-dark）
  --chrome <路径>        Chrome 可执行文件（也可用环境变量 CHROME_PATH）`;

/** 首次进入时的引导、通知授权提示等都跳过；主题、语言按参数定 */
export function initialStorage({ user, theme, locale, room }) {
  return {
    "superhive.username": user,
    "superhive.theme": theme,
    "superhive.onboarding": "done",
    "superhive.notify-prompt-dismissed": "true",
    "superhive.reduce-motion": "true",
    "superhive.room": room,
    ...(locale ? { "superhive.locale": locale } : {}),
  };
}

/** 预置动作翻译成页面里执行的脚本；元素没出现会等一会儿，超时报错（不会静默截一张不对的图） */
export function actionScript(action) {
  const [name, ...rest] = action.split(":");
  const arg = rest.join(":");
  const click = (selector) => `window.__shot.click(${JSON.stringify(selector)})`;
  switch (name) {
    case "code":
      return click(".workspace-toggle");
    case "artifacts":
      return click(".artifacts-toggle");
    case "schedules":
      return click('[data-entry="schedules"]');
    case "settings":
      return `(async () => {
        await window.__shot.click(".sidebar-user-chip");
        await window.__shot.click('[role="menuitem"]', (el) => /^(设置|Settings)$/.test(el.textContent.trim()));
        ${arg ? `await window.__shot.click(${JSON.stringify(`[aria-controls="settings-panel-${arg}"]`)});` : ""}
      })()`;
    case "side":
      if (!arg) throw new Error("side 要写成 side:members / side:whiteboard");
      return click(`#side-tab-${arg}`);
    case "click":
      if (!arg) throw new Error("click 要带 CSS 选择器，例如 click:.workspace-toggle");
      return click(arg);
    case "wait-for":
      if (!arg) throw new Error("wait-for 要带 CSS 选择器");
      // 只等，不把元素当返回值：按值回传 DOM 元素会报「Object reference chain is too long」
      return `window.__shot.find(${JSON.stringify(arg)}).then(() => undefined)`;
    case "wait": {
      const ms = Number.parseInt(arg, 10);
      if (!(ms >= 0)) throw new Error(`wait 要带毫秒数：${action}`);
      return `new Promise((resolve) => setTimeout(resolve, ${ms}))`;
    }
    case "eval":
      if (!arg) throw new Error("eval 要带 JS 表达式");
      return arg;
    default:
      throw new Error(`不认识的动作：${action}`);
  }
}

/** 注入每个页面的辅助函数：轮询等元素出现再点，最多 10 秒 */
export const HELPERS = `window.__shot = {
  async find(selector, match) {
    const deadline = Date.now() + 10000;
    for (;;) {
      const found = [...document.querySelectorAll(selector)].find((el) => !match || match(el));
      if (found) return found;
      if (Date.now() > deadline) throw new Error("没找到元素：" + selector);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  },
  async click(selector, match) {
    (await this.find(selector, match)).click();
  },
};`;

/** 按输出路径和主题算文件名：只截一个主题就用原名，多个主题加后缀 */
export function outputFiles(out, themes, now = new Date()) {
  const base =
    out ??
    path.join("output", `screenshot-${now.toISOString().replace(/[:.]/g, "-").slice(0, 19)}.png`);
  const resolved = path.resolve(ROOT, base);
  if (themes.length === 1) return [resolved];
  const ext = path.extname(resolved) || ".png";
  const stem = resolved.slice(0, resolved.length - path.extname(resolved).length);
  return themes.map((theme) => `${stem}-${theme}${ext}`);
}

/** 找 Chrome：参数 > CHROME_PATH > 各系统的常见安装位置 */
export function findChrome(explicit = process.env.CHROME_PATH) {
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`找不到 Chrome：${explicit}`);
    return explicit;
  }
  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ]
      : process.platform === "win32"
        ? [
            `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
            `${process.env["PROGRAMFILES(X86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
            `${process.env.PROGRAMFILES}\\Microsoft\\Edge\\Application\\msedge.exe`,
          ]
        : [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/snap/bin/chromium",
          ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error("没找到 Chrome，用 --chrome 或环境变量 CHROME_PATH 指定");
  return found;
}

/** 起一个独立的无头 Chrome，连上它的 DevTools；close() 关掉进程并删掉临时 profile */
export async function launchChrome(executable) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "hive-shot-"));
  const child = spawn(
    executable,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      // 通知、定位等权限请求一律直接拒绝，不弹框卡住截图
      "--deny-permission-prompts",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--hide-scrollbars",
      "--mute-audio",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const close = async () => {
    if (child.exitCode === null) {
      await new Promise((resolve) => {
        const force = setTimeout(() => child.kill("SIGKILL"), 5_000);
        child.once("exit", () => {
          clearTimeout(force);
          resolve();
        });
        child.kill();
      });
    }
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  try {
    // 端口 0：Chrome 自己挑一个，写在 profile 里的 DevToolsActivePort
    const portFile = path.join(profile, "DevToolsActivePort");
    const deadline = Date.now() + 20_000;
    while (!fs.existsSync(portFile) || !fs.readFileSync(portFile, "utf8").includes("\n")) {
      if (child.exitCode !== null) throw new Error(`Chrome 启动失败（退出码 ${child.exitCode}）`);
      if (Date.now() > deadline) throw new Error("Chrome 启动超时");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const port = fs.readFileSync(portFile, "utf8").split("\n")[0];
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find((target) => target.type === "page");
    if (!page) throw new Error("Chrome 没有可用的页面");
    return { cdp: await connect(page.webSocketDebuggerUrl), close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** 最小的 CDP 客户端：发命令、等结果 */
async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("连不上 Chrome DevTools")), {
      once: true,
    });
  });
  let id = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const waiter = message.id && pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(`${message.error.message}`));
    else waiter.resolve(message.result);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const next = ++id;
      pending.set(next, { resolve, reject });
      socket.send(JSON.stringify({ id: next, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
      );
    return result.result?.value;
  };
  return { send, evaluate, close: () => socket.close() };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 把当前页面截成 PNG 写到 file */
async function capture(cdp, file, fullPage) {
  let clip;
  if (fullPage) {
    const { cssContentSize } = await cdp.send("Page.getLayoutMetrics");
    clip = { x: 0, y: 0, width: cssContentSize.width, height: cssContentSize.height, scale: 1 };
  }
  const shot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    ...(clip ? { clip, captureBeyondViewport: true } : {}),
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
}

async function screenshot(options) {
  const url = new URL(options.url);
  const room = options.room ?? (url.hash.slice(1) || "general");
  url.hash = room;
  const files = outputFiles(options.out, options.themes);
  const scripts = options.actions.map(actionScript);
  const chrome = await launchChrome(findChrome(options.chrome));
  try {
    const { cdp } = chrome;
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: options.width,
      height: options.height,
      deviceScaleFactor: options.scale,
      mobile: false,
    });
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    for (const [index, theme] of options.themes.entries()) {
      const storage = initialStorage({ user: options.user, theme, locale: options.locale, room });
      // 每张图都从头加载：先在空白页写好 localStorage，再打开目标页，首屏就是对的主题且没有引导弹窗
      const { identifier } = await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `${HELPERS}
          if (location.origin === ${JSON.stringify(url.origin)}) {
            for (const [key, value] of Object.entries(${JSON.stringify(storage)})) localStorage.setItem(key, value);
          }
          ${options.hideSandboxBadge ? `document.addEventListener("DOMContentLoaded", () => { const style = document.createElement("style"); style.textContent = ".sandbox-badge{display:none!important}"; document.head.append(style); });` : ""}
          ${options.initScripts.map((file) => fs.readFileSync(file, "utf8")).join("\n;\n")}`,
      });
      // 先回空白页：只差 #房间 的地址再 navigate 不会重新加载，换主题就不生效
      await cdp.send("Page.navigate", { url: "about:blank" });
      await cdp.send("Page.navigate", { url: url.href });
      await cdp.evaluate(`(async () => {
        const deadline = Date.now() + 20000;
        while (!document.querySelector(".app-shell, .login-page, .access-gate")) {
          if (Date.now() > deadline) throw new Error("页面 20 秒内没有加载出来");
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        await document.fonts.ready;
      })()`);
      await sleep(options.settle + 700);
      for (const [step, script] of scripts.entries()) {
        try {
          await cdp.evaluate(script);
        } catch (error) {
          throw new Error(
            `第 ${step + 1} 个动作（${options.actions[step]}）失败：${error.message}`,
          );
        }
        await sleep(options.settle);
      }
      await capture(cdp, files[index], options.fullPage);
      console.log(files[index]);
      await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
    }
    cdp.close();
  } finally {
    await chrome.close();
  }
}

const escapeHtml = (value) =>
  value.replace(
    /[&<>"]/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char],
  );

/** 改前 | 改后 拼图的页面：每张图上面一行标签，原尺寸并排 */
export function compareHtml(images, labels) {
  const cells = images
    .map(
      (image, index) => `<figure><figcaption>${escapeHtml(labels[index] ?? "")}</figcaption>
        <img src="${pathToFileURL(image).href}"></figure>`,
    )
    .join("");
  return `<!doctype html><meta charset="utf-8"><style>
    html, body { margin: 0; background: #e5e5e5; }
    body { display: inline-flex; gap: 24px; padding: 24px; align-items: flex-start;
      font: 600 28px -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif; color: #1f1f1f; }
    figure { margin: 0; display: flex; flex-direction: column; gap: 12px; }
    img { display: block; border: 1px solid #c8c8c8; }
  </style><body>${cells}</body>`;
}

async function compare(options) {
  const images = options.compare.map((file) => path.resolve(file));
  for (const image of images) if (!fs.existsSync(image)) throw new Error(`找不到图片：${image}`);
  const labels = options.labels
    ? options.labels.split(",")
    : images.length === 2
      ? ["改前", "改后"]
      : images.map((image) => path.basename(image));
  const [file] = outputFiles(options.out ?? path.join("output", "compare.png"), ["single"]);
  const html = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hive-compare-")), "compare.html");
  fs.writeFileSync(html, compareHtml(images, labels));
  const chrome = await launchChrome(findChrome(options.chrome));
  try {
    const { cdp } = chrome;
    await cdp.send("Page.enable");
    // 原尺寸拼：截图按 CSS 像素算，2 倍图也按原像素显示，不缩放
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 800,
      height: 600,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send("Page.navigate", { url: pathToFileURL(html).href });
    const size = await cdp.evaluate(`(async () => {
      const deadline = Date.now() + 15000;
      while (document.readyState !== "complete" || [...document.images].some((img) => !img.complete)) {
        if (Date.now() > deadline) throw new Error("图片加载超时");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if ([...document.images].some((img) => !img.naturalWidth)) throw new Error("有图片读不出来");
      await document.fonts.ready;
      return { width: Math.ceil(document.body.scrollWidth), height: Math.ceil(document.body.scrollHeight) };
    })()`);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      ...size,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await capture(cdp, file, false);
    console.log(file);
    cdp.close();
  } finally {
    await chrome.close();
    fs.rmSync(path.dirname(html), { recursive: true, force: true });
  }
}

export function parseOptions(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      url: { type: "string", default: "http://127.0.0.1:5188" },
      room: { type: "string" },
      user: { type: "string", default: "rd" },
      theme: { type: "string", default: "light" },
      locale: { type: "string" },
      width: { type: "string", default: "1600" },
      height: { type: "string", default: "1000" },
      scale: { type: "string", default: "1" },
      action: { type: "string", multiple: true, default: [] },
      settle: { type: "string", default: "800" },
      "full-page": { type: "boolean", default: false },
      "hide-sandbox-badge": { type: "boolean", default: false },
      "init-script": { type: "string", multiple: true, default: [] },
      out: { type: "string" },
      chrome: { type: "string" },
      compare: { type: "boolean", default: false },
      labels: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const number = (name, min) => {
    const value = Number(values[name]);
    if (!Number.isFinite(value) || value < min) throw new Error(`--${name} 不对：${values[name]}`);
    return value;
  };
  const themes = values.theme.split(",").map((theme) => theme.trim());
  for (const theme of themes)
    if (!["light", "dark"].includes(theme))
      throw new Error(`--theme 只能是 light / dark：${theme}`);
  if (values.compare && positionals.length < 2) throw new Error("--compare 至少要两张图");
  if (!values.compare && positionals.length)
    throw new Error(`多余的参数：${positionals.join(" ")}`);
  for (const action of values.action) actionScript(action);
  return {
    help: values.help,
    url: values.url,
    room: values.room,
    user: values.user,
    themes,
    locale: values.locale,
    width: number("width", 200),
    height: number("height", 200),
    scale: number("scale", 0.5),
    actions: values.action,
    settle: number("settle", 0),
    fullPage: values["full-page"],
    hideSandboxBadge: values["hide-sandbox-badge"],
    initScripts: values["init-script"].map((file) => {
      const resolved = path.resolve(file);
      if (!fs.existsSync(resolved)) throw new Error(`--init-script 文件不存在：${file}`);
      return resolved;
    }),
    out: values.out,
    chrome: values.chrome,
    compare: values.compare ? positionals : undefined,
    labels: values.labels,
  };
}

async function main() {
  let options;
  try {
    options = parseOptions(process.argv.slice(2));
  } catch (error) {
    console.error(`[screenshot] ${error.message}\n\n${HELP}`);
    process.exit(1);
  }
  if (options.help) {
    console.log(HELP);
    return;
  }
  try {
    if (options.compare) await compare(options);
    else await screenshot(options);
  } catch (error) {
    console.error(`[screenshot] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) await main();
