// 真实界面的镜头：每个镜头一段脚本，驱动网页并录屏。
// 每个镜头先（不录）打开 web 等页面稳定，再开始录；鼠标移动、点击都放慢，录下来看得清。
export const APP_VIEWPORT = { width: 1440, height: 810, scale: 1920 / 1440 };

export const appStorage = (owner) => ({
  "superhive.username": owner,
  "superhive.theme": "dark",
  "superhive.onboarding": "done",
  "superhive.notify-prompt-dismissed": "true",
  "superhive.reduce-motion": "false",
  "superhive.room": "web",
  // 每个镜头都从中文界面开始（「中英文切换」镜头会切到英文）
  "superhive.locale": "zh-CN",
});

/** 页面文字里的演示 HOME 换成 ~；之后新渲染的也换 */
export const tildeHome = (home) => `
(() => {
  const home = ${JSON.stringify(home)};
  const fix = (root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode())
      if (node.nodeValue.includes(home)) node.nodeValue = node.nodeValue.replaceAll(home, "~");
  };
  const all = () => {
    if (!document.body) return;
    fix(document.body);
    for (const el of document.querySelectorAll("*")) if (el.shadowRoot) fix(el.shadowRoot);
    // 输入框（如接入 Agent 的工作目录）只改显示的值，不触发 input 事件
    for (const el of document.querySelectorAll("input, textarea"))
      if (el.value.includes(home)) el.value = el.value.replaceAll(home, "~");
  };
  const start = () => {
    all();
    new MutationObserver(all).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    setInterval(all, 100);
  };
  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start);
})();`;

/** 按文字匹配元素（在页面里执行的函数源码） */
const text = (pattern) => `(el) => ${pattern}.test(el.textContent)`;

/** 打开 web，等消息列表出来、滚到底 */
async function open(d, demo, room = "web") {
  await d.goto(`${demo.url}/#${room}`, `__promo.find(".message-list")`);
  await d.eval("document.fonts.ready");
  await d.wait(1800);
}

/** 在输入框里 @ 一个 Agent 并输入任务，点发送 */
async function send(d, agent, task) {
  await d.click(".rich-composer-content", { after: 250 });
  await d.type(`@${agent.slice(0, 4)}`, { delay: 90 });
  await d.wait(350);
  await d.click(".mention-option", { match: text(new RegExp(`@${agent}`)), after: 250 });
  await d.type(task, { delay: 45 });
  await d.wait(400);
  await d.click(".composer-send", { after: 300 });
}

/** 等页面（含 shadow DOM）里出现某段文字 */
const waitText = (d, selector, pattern, timeout = 60000) =>
  d.eval(`__promo.find(${JSON.stringify(selector)}, ${text(pattern)}, ${timeout})`);

/** 镜头推近到某个元素的上半部分（右侧栏这种又窄又高的面板，整块推不近） */
async function zoomTop(d, selector, height, { ms = 900, pad = 16 } = {}) {
  const r = await d.eval(`__promo.rect(${JSON.stringify(selector)}, null, { scroll: false })`);
  await d.camera(
    { x: r.x, y: r.y, width: r.width, height: Math.min(height, r.height) },
    { ms, pad },
  );
}

export const APP_SHOTS = [
  {
    // 总览：房间多、Agent 多、有人有 Agent
    name: "overview",
    async run(d, demo, dir) {
      await open(d, demo);
      await d.place(700, 900);
      const rec = await d.record(dir);
      await d.wait(600);
      const rooms = await d.highlight(".room-scroll", "8 个房间");
      await d.hover(".room-item", { match: text(/design/), ms: 900 });
      await d.hover(".room-item", { match: text(/payment/), ms: 700 });
      await d.hover(".room-item", { match: text(/infra/), ms: 700 });
      await d.wait(500);
      await d.unhighlight(rooms);
      const members = await d.highlight(".member-list", "12 个 Agent · 4 个人");
      await d.hover(".member-row", { match: text(/codex-1/), ms: 1000 });
      await d.scroll(".member-list", 420, 1400);
      await d.wait(900);
      await d.unhighlight(members);
      await d.wait(400);
      return rec.stop();
    },
  },
  {
    // @ 一个 Agent 派活 → 它委派三路 → 回执 → 汇总
    name: "delegate",
    async run(d, demo, dir) {
      await open(d, demo);
      await d.place(800, 700);
      const play = demo.scenes.delegate();
      const rec = await d.record(dir);
      await send(d, "claude-1", " 结算页改版：金额格式、优惠明细接口、文档，拆给大家并行做。");
      await d.move(900, 450, 900);
      await waitText(d, ".message-machine-card, article.message", /委派/, 30000);
      // 三张委派卡都出来后推近，看清派给了谁
      await d.wait(1100);
      const cards = await d.eval(`__promo.unionRect(".message-machine-card")`);
      await d.camera(cards, { pad: 70, ms: 900 });
      await d.wait(2600);
      await d.camera(null, { ms: 800 });
      await play;
      await waitText(d, "article.message", /三路都交回了/);
      await d.wait(600);
      await d.camera("article.message", { match: text(/三路都交回了/), pad: 60 });
      await d.wait(3400);
      return rec.stop();
    },
  },
  {
    // 右侧「进展」：等你处理、在做、最近完成，白板原文
    name: "progress",
    async run(d, demo, dir) {
      await open(d, demo);
      await d.place(900, 600);
      const rec = await d.record(dir);
      await d.click("#side-tab-whiteboard", { after: 700 });
      await zoomTop(d, "#side-panel-whiteboard", 470);
      await d.hover(".progress-item", { ms: 900 });
      await d.wait(1800);
      await d.camera(null, { ms: 800 });
      await d.click("details.progress-board summary, .progress-board > summary", { after: 900 });
      await d.scroll("#side-panel-whiteboard", 380, 1000);
      await d.wait(1500);
      return rec.stop();
    },
  },
  {
    // 回复带图片附件 + 让你点选，点完 Agent 接着做
    name: "designs",
    async run(d, demo, dir) {
      await open(d, demo);
      await d.place(800, 700);
      const play = demo.scenes.designs(demo.images);
      const rec = await d.record(dir);
      await send(d, "claude-2", " 结算页出两版设计稿，我来挑。");
      // 等图和选择题都到了、页面不再跳，再回头点开图片
      await d.eval(`__promo.find(".question-options:not(.locked) .question-option", null, 30000)`);
      await d.wait(1500);
      await d.click(".message-image", { after: 1500 });
      await d.eval(`__promo.find(".attachment-lightbox", null, 5000)`);
      await d.click(".attachment-lightbox-nav.next", { after: 1600 });
      await d.key("Escape");
      await d.wait(700);
      await d.hover(".question-options", { ms: 700 });
      await d.wait(300);
      await d.camera("article.message.question", { pad: 30, ms: 800 });
      const id = await d.highlight(".question-options", "等你决定：点一下就行");
      await d.hover(".question-option", { match: text(/方案 A/), ms: 800 });
      await d.wait(500);
      await d.click(".question-option", { match: text(/方案 B/), after: 400 });
      await d.unhighlight(id);
      await d.camera(null, { ms: 700 });
      await play;
      await waitText(d, "article.message", /按方案 B 开工|按\s*方案 B/);
      await d.wait(500);
      // 选完之后 Agent 接着做的结果推近看
      await d.camera("article.message", { match: text(/按\s*方案 B/), pad: 60 });
      await d.wait(3200);
      return rec.stop();
    },
  },
  {
    // 实时执行过程 + 白板登记、进展里的状态自动变化
    name: "live",
    async run(d, demo, dir) {
      await open(d, demo);
      await d.click("#side-tab-whiteboard", { after: 300 });
      await d.place(800, 700);
      const play = demo.scenes.live();
      const rec = await d.record(dir);
      await send(d, "codex-3", " 给金额格式化补上单元测试，跑一遍覆盖率。");
      await d.move(760, 520, 900);
      await d.eval(`__promo.find("article.thinking-card", null, 20000)`);
      await d.wait(900);
      await d.camera("article.thinking-card", { pad: 50, ms: 900 });
      await waitText(d, "article.thinking-card", /coverage/, 30000);
      await d.wait(1800);
      await d.camera(null, { ms: 800 });
      const id = await d.highlight(".progress-item", "白板：codex-3 自己登记进展", {
        match: text(/单元测试/),
      });
      await play;
      await d.wait(2600);
      await d.unhighlight(id);
      await d.wait(800);
      return rec.stop();
    },
  },
  {
    // 产物：房间里交付的文档、图片、代码集中在一处；预览停到右侧栏，用本机应用打开
    name: "artifacts",
    async run(d, demo, dir) {
      await open(d, demo);
      await d.place(900, 600);
      const rec = await d.record(dir);
      await d.click(".artifacts-toggle", { after: 1200 });
      await d.hover(".artifact-tile", { ms: 800 });
      await d.wait(600);
      await d.click(".artifact-open", { match: text(/金额显示规范/), after: 900 });
      await d.click(".artifact-detail-actions .btn-primary", { after: 1200 });
      await d.click('.file-preview-size[aria-label="在右侧栏打开"]', { after: 1400 });
      const id = await d.highlight('[aria-label="用本机应用打开"]', "用本机应用打开", {
        below: true,
      });
      await d.hover('[aria-label="用本机应用打开"]', { ms: 800 });
      await d.wait(400);
      await d.press();
      await d.wait(1600);
      await d.unhighlight(id);
      return rec.stop();
    },
  },
  {
    // 代码：改动列表、diff，任务线分支
    name: "code",
    async run(d, demo, dir) {
      await open(d, demo);
      await d.place(900, 600);
      const rec = await d.record(dir);
      await d.click(".workspace-toggle", { after: 1200 });
      await d.click(".workspace-change", { match: text(/price\.ts/), after: 1400 });
      await d.scroll(".workspace-viewer", 260, 1000);
      await d.wait(1200);
      await d.key("Escape");
      await d.wait(500);
      await d.click(".worktree-switcher-toggle", { after: 1600 });
      await d.hover(".worktree-switcher-row", { match: text(/price-format/), ms: 800 });
      await d.wait(1400);
      return rec.stop();
    },
  },
  {
    name: "schedules",
    async run(d, demo, dir) {
      await open(d, demo);
      await d.place(900, 600);
      const rec = await d.record(dir);
      await d.click('[data-entry="schedules"]', { after: 700 });
      await zoomTop(d, ".schedules-dialog", 420);
      await d.hover(".schedules-dialog li", { ms: 900 });
      await d.wait(2600);
      return rec.stop();
    },
  },
  {
    // 邀请人、接入 Agent
    // 邀请同事 → 关掉 → 接入 Agent：选 CLI → 权限 → 一键启动，一个镜头连着录
    name: "invite",
    async run(d, demo, dir) {
      await open(d, demo);
      await d.place(900, 600);
      const rec = await d.record(dir);
      await d.click(".member-invite-action", { match: text(/邀请/), after: 1000 });
      await d.click(".invite-submit", { after: 900 });
      await d.camera("[role=dialog]", { pad: 24, ms: 800 });
      const id = await d.highlight(".invite-link-row", "邀请链接，发给同事就能进房间");
      await d.wait(2400);
      await d.unhighlight(id);
      await d.camera(null, { ms: 600 });
      await d.key("Escape");
      await d.wait(500);
      await d.click(".sidebar-agent-entry", { after: 1000 });
      await d.click('.provider-selector [role="radio"]', { match: text(/Codex/), after: 700 });
      await d.click(".agent-dialog-nav button.primary", { after: 900 });
      await d.click(".agent-dialog-nav button.primary", { after: 700 });
      await d.camera("[role=dialog]", { pad: 24, ms: 800 });
      await d.wait(2600);
      return rec.stop();
    },
  },
  {
    // 界面中英文切换
    name: "i18n",
    async run(d, demo, dir) {
      await open(d, demo);
      await d.place(900, 600);
      const rec = await d.record(dir);
      // 悬停头像就会展开用户菜单（再点一下反而会收起）
      await d.hover(".sidebar-user-chip", { ms: 800 });
      await d.wait(600);
      await d.click('[role="menuitem"]', { match: text(/设置/), after: 900 });
      await d.click('[aria-controls="settings-panel-appearance"]', { after: 900 });
      await d.camera("#settings-panel-appearance .compact-choice", { pad: 220, ms: 800 });
      await d.click('.compact-choice [role="radio"]', { match: text(/^English$/), after: 1800 });
      await d.camera(null, { ms: 700 });
      await d.key("Escape");
      await d.wait(900);
      await d.hover("#side-tab-whiteboard", { ms: 900 });
      await d.hover(".composer-send", { ms: 900 });
      await d.wait(2000);
      return rec.stop();
    },
  },
  {
    // 连接飞书：假驱动，二维码是演示地址
    name: "im",
    async run(d, demo, dir) {
      await open(d, demo);
      await d.place(900, 600);
      const rec = await d.record(dir);
      await d.click(".sidebar-action", { match: text(/连接 IM/), after: 1000 });
      await d.click(".invite-submit", { match: text(/连接飞书/), after: 1000 });
      await d.click(".invite-submit", { match: text(/扫码连接飞书/), after: 400 });
      await d.eval(`__promo.find(".im-qr", null, 15000)`);
      await d.wait(300);
      await d.camera("[role=dialog]", { pad: 30, ms: 800 });
      const qr = await d.highlight(".im-qr", "演示二维码，不连真实账号");
      await d.wait(1600);
      await d.unhighlight(qr);
      demo.feishu.scan();
      await d.wait(1500);
      demo.feishu.confirm();
      await waitText(d, ".im-added, [role=dialog]", /飞书已连接/, 15000);
      await d.wait(1400);
      await d.click(".invite-submit, button", { match: text(/^完成$/), after: 300 });
      await d.camera(null, { ms: 700 });
      await d.wait(600);
      await d.wait(1200);
      return rec.stop();
    },
  },
];
