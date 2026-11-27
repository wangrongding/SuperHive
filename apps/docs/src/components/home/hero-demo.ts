// 首屏可交互演示：大屏上按需加载（landing-client 里动态 import），盖在首屏截图上面。
// 页面 HTML 里只有那张截图，演示的结构、文案、样式都在这个模块和它的 CSS 里，不占页面体积，也不影响搜索引擎看到的内容。
// 能做的事：回答提问卡片、停止执行中的一轮、@ 成员发消息（Agent 回一句）、切房间、点开交回的文件在右侧预览、
// 切成员 / 进展、开关终端并敲几条命令。亮点标在这些能点的地方，点过就消失。
import "./hero-demo.css";
import { demoText, type DemoMember, type DemoText } from "./hero-demo-text";

type Lang = keyof typeof demoText;
type RoomId = "api" | "web";
type State = "waiting" | "running" | "done" | "stopping" | "stopped";

const ESC: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const esc = (value: string) => value.replace(/[&<>"']/g, (char) => ESC[char]);
/** 转义后把 @名字 标成蓝色 */
const rich = (value: string) =>
  esc(value).replace(/@[\w一-龥-]+/g, (mention) => `<span class="hd-at">${mention}</span>`);

function el<T extends HTMLElement = HTMLElement>(html: string): T {
  const template = document.createElement("template");
  template.innerHTML = html.trim();
  return template.content.firstElementChild as T;
}

const ICONS = {
  plus: '<path d="M8 3v10M3 8h10"/>',
  search: '<circle cx="7" cy="7" r="4.2"/><path d="m10.2 10.2 3 3"/>',
  at: '<circle cx="8" cy="8" r="2.4"/><path d="M10.4 8v1a1.8 1.8 0 0 0 3.6 0V8a6 6 0 1 0-2.4 4.8"/>',
  pulse: '<path d="M1.5 8h3l1.8-4 3.4 8 1.8-4h3"/>',
  warn: '<path d="M8 2.2 14.2 13H1.8z"/><path d="M8 6.5v3M8 11.2v.1"/>',
  terminal:
    '<rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.6"/><path d="m4.6 6.4 2 1.6-2 1.6M8.4 10h3"/>',
  users:
    '<circle cx="6" cy="5.5" r="2.3"/><path d="M1.8 13c.4-2.3 2.1-3.6 4.2-3.6s3.8 1.3 4.2 3.6M10.6 3.4a2.2 2.2 0 0 1 0 4.2M12 9.6c1.2.4 2 1.6 2.2 3.4"/>',
  board:
    '<rect x="3" y="2" width="10" height="12" rx="1.4"/><path d="M5.6 5.6h4.8M5.6 8h4.8M5.6 10.4h3"/>',
  file: '<path d="M4 1.8h5l3 3v9.4H4z"/><path d="M9 1.8v3h3M6 8.4h4M6 10.8h4"/>',
  close: '<path d="m4 4 8 8M12 4l-8 8"/>',
  panel: '<rect x="1.8" y="2.6" width="12.4" height="10.8" rx="1.6"/><path d="M5.6 2.6v10.8"/>',
  panelRight:
    '<rect x="1.8" y="2.6" width="12.4" height="10.8" rx="1.6"/><path d="M10.4 2.6v10.8"/>',
  box: '<path d="M4.4 2.2h5.4l2.6 2.6v8.4a.8.8 0 0 1-.8.8H4.4a.8.8 0 0 1-.8-.8V3a.8.8 0 0 1 .8-.8z"/><path d="M6 1.4v1.6M6 6h4M6 8.4h4"/>',
  code: '<path d="m5.2 4.6-3.2 3.4 3.2 3.4M10.8 4.6 14 8l-3.2 3.4M9.2 3l-2.4 10"/>',
  share:
    '<path d="M8 10V2.4M5 5.2l3-3 3 3"/><path d="M3 8.6v4.2c0 .5.4.8.8.8h8.4c.4 0 .8-.3.8-.8V8.6"/>',
  back: '<path d="M10 3.5 5.5 8l4.5 4.5"/>',
  download: '<path d="M8 2.5v8M4.8 7.4 8 10.6l3.2-3.2M3 13.2h10"/>',
  expand: '<path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9"/>',
  shrink: '<path d="M13.5 6.5h-4v-4M2.5 9.5h4v4M9.5 6.5l4-4M6.5 9.5l-4 4"/>',
  popout: '<rect x="2" y="3.5" width="9" height="9" rx="1.4"/><path d="M8 2h6v6M14 2 8.5 7.5"/>',
  folder:
    '<path d="M2 4.2c0-.6.4-1 1-1h3.2l1.4 1.6H13c.6 0 1 .4 1 1v6.4c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1z"/>',
  up: '<path d="M8 13V3.5M4 7.2 8 3.2l4 4"/>',
  clip: '<path d="m13 7.2-5 5a3 3 0 0 1-4.3-4.3l5.3-5.2a2 2 0 0 1 2.8 2.8L6.6 10.6a1 1 0 0 1-1.4-1.4L10 4.5"/>',
};
const icon = (name: keyof typeof ICONS) =>
  `<svg class="hd-i" viewBox="0 0 16 16" aria-hidden="true">${ICONS[name]}</svg>`;

const HIVE =
  '<svg class="hd-logo" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5 20.2 7.2v9.6L12 21.5 3.8 16.8V7.2z"/><path d="M12 7.6 16 9.9v4.6L12 16.8 8 14.5V9.9z"/></svg>';

export function mountDemo(host: HTMLElement, lang: Lang): HTMLElement {
  const t: DemoText = demoText[lang];
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  const member = (id: string) => t.memberList.find((item) => item.id === id)!;
  const me = t.memberList[0];

  // 虚拟时钟：演示不在视口里或页面切到后台时暂停，不白跑
  let visible = true;
  let now = 0;
  const jobs: { at: number; run: () => void }[] = [];
  const later = (ms: number, run: () => void) => jobs.push({ at: now + ms, run });
  window.setInterval(() => {
    if (!visible || document.hidden) return;
    now += 100;
    for (let index = 0; index < jobs.length;) {
      if (jobs[index].at <= now) jobs.splice(index, 1)[0].run();
      else index += 1;
    }
  }, 100);

  const busy = new Set<string>(["claude-2"]);
  const board = t.board.map((group) => ({ slot: group.slot, items: [...group.items] }));

  const avatar = (who: DemoMember) =>
    `<span class="hd-av" style="--c:${who.color}" aria-hidden="true">${esc([...who.name][0].toUpperCase())}</span>`;

  const root = el(`
    <div class="hd" role="region" aria-label="${esc(t.label)}">
      <div class="hd-app">
        <aside class="hd-side">
          <div class="hd-brand">${HIVE}<b>SuperHive</b><i class="hd-online"></i></div>
          <nav class="hd-nav">
            <span>${icon("plus")}${esc(t.newRoom)}</span>
            <span>${icon("search")}${esc(t.search)}</span>
            <span>${icon("at")}${esc(t.mentions)}</span>
            <span>${icon("pulse")}${esc(t.tasks)}<em class="hd-count is-green" data-busy-count>2</em></span>
            <span>${icon("warn")}${esc(t.incidents)}<em class="hd-count is-warm">3</em></span>
          </nav>
          <p class="hd-side-title">${esc(t.needsYou)}<em data-needs-count>${t.needs.length}</em></p>
          <ul class="hd-needs">
            ${t.needs
              .map(
                (
                  item,
                ) => `<li><button type="button" ${item.go ? `data-go="${item.go}"` : "disabled"}>
                  <span class="hd-tag is-${item.tone}">${esc(item.tag)}</span><span>${esc(item.text)}</span></button></li>`,
              )
              .join("")}
          </ul>
          <p class="hd-side-title">${esc(t.roomsTitle)}<em>${t.rooms.length}</em></p>
          <ul class="hd-rooms">
            ${t.rooms
              .map(
                (
                  room,
                  index,
                ) => `<li><button type="button" data-room="${room.id}" ${index > 1 ? "disabled" : ""}
                  aria-current="${index === 0 ? "true" : "false"}"><span># ${esc(room.name)}</span><small>${esc(room.online)}</small></button></li>`,
              )
              .join("")}
          </ul>
          <div class="hd-me">${avatar(me)}<span><b>${esc(t.me)}</b><small>${esc(t.meNote)}</small></span></div>
        </aside>
        <section class="hd-chat">
          <header class="hd-head">
            <button type="button" class="hd-head-icon" data-toggle="side-left" aria-pressed="true" aria-label="${esc(t.head.rooms)}" title="${esc(t.head.rooms)}">${icon("panel")}</button>
            <b class="hd-room-name"># api</b><small class="hd-room-meta">${esc(t.rooms[0].online)} · main</small>
            <span class="hd-head-actions">
              <button type="button" class="hd-head-btn" data-topic>${icon("plus")}<span>${esc(t.head.topic)}</span></button>
              <button type="button" class="hd-head-btn" data-sheet="artifacts" aria-pressed="false">${icon("box")}<span>${esc(t.head.artifacts)}</span><em>${t.artifacts.items.length}</em></button>
              <button type="button" class="hd-head-btn" data-sheet="code" aria-pressed="false">${icon("code")}<span>${esc(t.head.code)}</span><em>${t.code.changes.length}</em></button>
              <button type="button" class="hd-head-btn" data-terminal aria-pressed="false">${icon("terminal")}<span>${esc(t.terminal)}</span></button>
              <button type="button" class="hd-head-btn" data-share aria-pressed="false">${icon("share")}<span data-share-label>${esc(t.head.share)}</span></button>
              <button type="button" class="hd-head-icon" data-toggle="side-right" aria-pressed="true" aria-label="${esc(t.head.side)}" title="${esc(t.head.side)}">${icon("panelRight")}</button>
            </span>
          </header>
          <div class="hd-msgs" data-msgs="api" aria-live="polite"></div>
          <div class="hd-msgs" data-msgs="web" hidden aria-live="polite"></div>
          <div class="hd-share-bar" hidden>
            <span data-share-count></span>
            <button type="button" data-share-all>${esc(t.share.all)}</button>
            <button type="button" data-share-copy>${esc(t.share.copy)}</button>
            <button type="button" data-share-download>${esc(t.share.download)}</button>
            <button type="button" data-share-image>${esc(t.share.image)}</button>
            <small data-share-note role="status"></small>
            <button type="button" class="hd-share-exit" data-share>${esc(t.share.exit)}</button>
          </div>
          <form class="hd-composer">
            <div class="hd-menu" role="listbox" hidden></div>
            <input class="hd-input" type="text" maxlength="200" autocomplete="off" spellcheck="false"
              aria-label="${esc(t.composer)}" placeholder="${esc(t.composer)}" />
            <div class="hd-composer-bar">${icon("clip")}<button type="submit" class="hd-send" aria-label="${esc(t.send)}">${icon("up")}</button></div>
          </form>
          <div class="hd-term" hidden>
            <div class="hd-term-tabs"><span class="hd-term-tab"><small>1</small> zsh <em>api</em></span>
              <button type="button" class="hd-term-close" aria-label="${esc(t.terminal)}" data-terminal>${icon("close")}</button></div>
            <pre class="hd-term-out"></pre>
            <label class="hd-term-line"><span>❯</span><input type="text" maxlength="80" autocomplete="off" spellcheck="false" aria-label="${esc(t.terminal)}" /></label>
          </div>
        </section>
        <aside class="hd-right">
          <div class="hd-tabs" role="tablist">
            <button type="button" role="tab" aria-selected="true" data-tab="members">${icon("users")}${esc(t.members)}<em>${t.memberList.length}</em></button>
            <button type="button" role="tab" aria-selected="false" data-tab="progress">${icon("board")}${esc(t.progress)}<em data-board-count></em></button>
          </div>
          <ul class="hd-members" data-pane="members"></ul>
          <div class="hd-board" data-pane="progress" hidden></div>
          <div class="hd-preview" hidden>
            <div class="hd-preview-head">${icon("file")}<span><b>${esc(t.web.file)}</b><small>${esc(t.web.size)}</small></span>
              <button type="button" aria-label="${esc(t.web.undock)}" title="${esc(t.web.undock)}" data-undock>${icon("popout")}</button>
              <button type="button" aria-label="${esc(t.web.close)}" title="${esc(t.web.close)}" data-close-preview>${icon("close")}</button></div>
            <article class="hd-preview-body"><h3>${esc(t.web.previewTitle)}</h3>${t.web.previewBody}</article>
          </div>
        </aside>
        <section class="hd-sheet" hidden aria-modal="false" role="dialog"></section>
      </div>
      <div class="hd-modal" hidden>
        <div class="hd-modal-box" role="dialog" aria-label="${esc(t.web.file)}">
          <header class="hd-modal-head">${icon("file")}<span><b>${esc(t.web.file)}</b><small>${esc(t.web.size)}</small></span>
            <span class="hd-seg" role="radiogroup">
              <button type="button" role="radio" aria-checked="true" data-view="preview">${esc(t.web.view)}</button>
              <button type="button" role="radio" aria-checked="false" data-view="raw">${esc(t.web.raw)}</button>
            </span>
            <span class="hd-modal-actions">
              <button type="button" class="hd-modal-text" data-download>${icon("download")}${esc(t.web.download)}</button>
              <button type="button" aria-label="${esc(t.web.dock)}" title="${esc(t.web.dock)}" data-dock>${icon("panelRight")}</button>
              <button type="button" aria-label="${esc(t.web.maximize)}" title="${esc(t.web.maximize)}" data-maximize>${icon("expand")}</button>
              <button type="button" aria-label="${esc(t.web.close)}" title="${esc(t.web.close)}" data-close-modal>${icon("close")}</button>
            </span>
          </header>
          <article class="hd-preview-body hd-modal-body" data-modal-preview><h3>${esc(t.web.previewTitle)}</h3>${t.web.previewBody}</article>
          <pre class="hd-code hd-modal-raw" data-modal-raw hidden>${esc(t.web.source)}</pre>
        </div>
      </div>
    </div>`);

  const q = <T extends HTMLElement = HTMLElement>(selector: string) =>
    root.querySelector<T>(selector)!;
  const lists: Record<RoomId, HTMLElement> = {
    api: q('[data-msgs="api"]'),
    web: q('[data-msgs="web"]'),
  };
  let room: RoomId = "api";

  const scrollDown = (list: HTMLElement) =>
    list.scrollTo({ top: list.scrollHeight, behavior: reduce.matches ? "auto" : "smooth" });

  // ---------- 亮点：标在能点的地方，用过就消失 ----------
  const hints = new Map<string, HTMLElement>();
  const hint = (key: string, target: HTMLElement | null) => {
    if (!target || used.has(key) || hints.get(key)?.isConnected) return;
    const dot = el(
      `<span class="hd-dot" data-tip="${esc(t.tips[key])}" aria-hidden="true"></span>`,
    );
    target.classList.add("hd-has-dot");
    target.append(dot);
    hints.set(key, dot);
  };
  const used = new Set<string>();
  const use = (key: string) => {
    used.add(key);
    hints.get(key)?.remove();
    hints.delete(key);
  };

  // ---------- 成员、进展 ----------
  const renderMembers = () => {
    q("[data-pane=members]").innerHTML = t.memberList
      .map(
        (who) =>
          `<li>${avatar(who)}<span class="hd-member"><b>${esc(who.name)}${
            who.lead ? `<em class="hd-badge is-lead">${esc(t.lead)}</em>` : ""
          }${who.local ? `<em class="hd-badge">${esc(t.local)}</em>` : ""}</b><small>${esc(who.role)}</small></span>${
            busy.has(who.id) ? '<i class="hd-busy" aria-hidden="true"></i>' : ""
          }</li>`,
      )
      .join("");
    q("[data-busy-count]").textContent = String(busy.size);
  };
  const renderBoard = () => {
    q("[data-pane=progress]").innerHTML = board
      .map(
        (group) =>
          `<section><h4>${esc(group.slot)}<em>${group.items.length}</em></h4>${group.items
            .map(
              (item) =>
                `<div class="hd-card"><code>${esc(item.key)}</code><p>${esc(item.text)}</p><small>${esc(item.who)}</small></div>`,
            )
            .join("")}</section>`,
      )
      .join("");
    q("[data-board-count]").textContent = String(board[0].items.length);
  };

  // ---------- 消息 ----------
  let clock = 15 * 60 + 4;
  const stamp = () => {
    clock += 1;
    return `${Math.floor(clock / 60)}:${String(clock % 60).padStart(2, "0")}`;
  };

  const message = (list: HTMLElement, who: DemoMember, text: string, time = stamp()) => {
    const mine = who.id === me.id;
    const node = el(`<article class="hd-msg${mine ? " is-mine" : ""}">
      ${mine ? "" : avatar(who)}
      <div class="hd-msg-body">
        <p class="hd-msg-meta"><b>${esc(who.name)}</b>${who.kind === "agent" ? `<em>${esc(t.agentTag)}</em>` : ""}<time>${time}</time></p>
        <div class="hd-bubble">${rich(text)}</div>
      </div></article>`);
    list.append(node);
    return node;
  };

  /** 消息下面那条状态：@谁 · 状态 · 详情 */
  const chip = (target: HTMLElement, agent: string, state: State) => {
    const node = el(
      `<p class="hd-chip"><i></i><span class="hd-at">@${esc(agent)}</span><span class="hd-chip-state"></span><span class="hd-chip-more">${esc(t.status.details)} ›</span></p>`,
    );
    target.querySelector(".hd-msg-body")!.append(node);
    const set = (next: State) => {
      node.dataset.state = next;
      node.querySelector(".hd-chip-state")!.textContent =
        next === "waiting"
          ? t.status.waiting
          : next === "running"
            ? t.status.running
            : next === "done"
              ? t.status.done
              : t.status.stopped;
    };
    set(state);
    return set;
  };

  /** 执行中的卡片：步骤一条条往下走，计时，带「停止」；做完换成回复 */
  const run = (
    list: HTMLElement,
    agentId: string,
    steps: string[],
    options: {
      reply: string;
      stepMs: number;
      startAt?: number;
      onState?: (state: State) => void;
      onDone?: () => void;
    },
  ) => {
    const who = member(agentId);
    busy.add(agentId);
    renderMembers();
    const node =
      el(`<article class="hd-msg hd-run">${avatar(who)}<div class="hd-msg-body"><div class="hd-run-card">
      <p class="hd-run-head"><b>${esc(who.name)}</b><span class="hd-run-state">${esc(t.status.running)}</span>
        <span class="hd-run-now"></span><time></time><button type="button" class="hd-stop">${esc(t.status.stop)}</button></p>
      <ol class="hd-steps"></ol></div></div></article>`);
    list.append(node);
    const current = node.querySelector<HTMLElement>(".hd-run-now")!;
    const time = node.querySelector<HTMLElement>("time")!;
    const trail = node.querySelector<HTMLElement>(".hd-steps")!;
    const stop = node.querySelector<HTMLButtonElement>(".hd-stop")!;
    let seconds = options.startAt ?? 3;
    let step = 0;
    let ended = false;
    time.textContent = t.elapsed(seconds);
    const tick = () => {
      if (ended) return;
      seconds += 1;
      time.textContent = t.elapsed(seconds);
      later(1000, tick);
    };
    later(1000, tick);
    const finish = (state: State) => {
      ended = true;
      busy.delete(agentId);
      renderMembers();
      options.onState?.(state);
    };
    const advance = () => {
      if (ended) return;
      if (step < steps.length) {
        const line = steps[step];
        current.textContent = line;
        trail.append(el(`<li>${esc(line)}</li>`));
        while (trail.children.length > 3) trail.firstElementChild!.remove();
        step += 1;
        if (list === lists[room]) scrollDown(list);
        later(options.stepMs, advance);
        return;
      }
      finish("done");
      node.replaceWith(message(document.createElement("div"), who, options.reply));
      // replaceWith 之前 message 先挂在临时容器里，换回列表后再滚到底
      if (list === lists[room]) scrollDown(list);
      options.onDone?.();
    };
    advance();
    stop.addEventListener("click", () => {
      use("stop");
      stop.disabled = true;
      stop.textContent = t.status.stopping;
      later(700, () => {
        finish("stopped");
        node.classList.add("is-stopped");
        node.querySelector(".hd-run-state")!.textContent = t.status.stopped;
        current.textContent = t.api.stoppedNote;
        stop.remove();
        time.remove();
      });
    });
    return { node, stop };
  };

  // ---------- #api ----------
  const shop = lists.api;
  const ask = message(shop, me, t.api.ask, "15:02");
  const setAsk = chip(ask, "codex", "waiting");
  const question = el(`<article class="hd-msg">${avatar(member("codex"))}<div class="hd-msg-body">
      <p class="hd-msg-meta"><b>codex</b><em>${esc(t.agentTag)}</em><time>15:03</time></p>
      <div class="hd-bubble is-question">${rich(t.api.question)}</div>
      <div class="hd-options" role="group"><small>${esc(t.api.single)}</small>
        ${t.api.options
          .map(
            (option, index) =>
              `<button type="button" data-option="${index}"><b>${"ABC"[index]}</b>${esc(option)}</button>`,
          )
          .join("")}
      </div><small class="hd-options-note">${esc(t.api.waiting)}</small></div></article>`);
  shop.append(question);
  const zhou = message(shop, member("zhou"), t.api.zhou, "15:04");
  const setZhou = chip(zhou, "claude-2", "running");
  const first = run(shop, "claude-2", t.api.claude2Steps, {
    reply: t.api.claude2Reply,
    stepMs: 4200,
    startAt: 36 * 60 + 12,
    onState: setZhou,
  });

  const choices = [...question.querySelectorAll<HTMLButtonElement>("[data-option]")];
  choices.forEach((button) =>
    button.addEventListener("click", () => {
      use("option");
      choices.forEach((item) => {
        item.disabled = true;
        item.classList.toggle("is-picked", item === button);
      });
      question.querySelector(".hd-options-note")!.textContent =
        `${t.api.answered} · ${"ABC"[Number(button.dataset.option)]}`;
      setAsk("running");
      root.querySelector('[data-go="question"]')?.closest("li")?.remove();
      q("[data-needs-count]").textContent = String(root.querySelectorAll(".hd-needs li").length);
      later(600, () => {
        const codex = run(shop, "codex", t.api.codexSteps, {
          reply: t.api.codexReply,
          stepMs: 1500,
          onState: setAsk,
          onDone: () => {
            board[0].items = board[0].items.filter((item) => item.key !== t.boardDone.key);
            board[1].items.unshift(t.boardDone);
            renderBoard();
          },
        });
        if (!used.has("stop") && !first.node.isConnected) hint("stop", codex.stop);
      });
    }),
  );

  // ---------- #web ----------
  const design = lists.web;
  const designAsk = message(design, me, t.web.ask, "15:20");
  chip(designAsk, "claude", "done");
  const delivered = message(design, member("claude"), t.web.reply, "15:28");
  const file = el<HTMLButtonElement>(
    `<button type="button" class="hd-file">${icon("file")}<span><b>${esc(t.web.file)}</b><small>${esc(t.web.fileMeta)}</small></span></button>`,
  );
  delivered.querySelector(".hd-msg-body")!.append(file);

  const preview = q(".hd-preview");
  const setPreview = (open: boolean) => {
    preview.hidden = !open;
    q(".hd-tabs").hidden = open;
    root.querySelectorAll<HTMLElement>("[data-pane]").forEach((pane) => {
      pane.hidden = open || pane.dataset.pane !== q('[role=tab][aria-selected="true"]').dataset.tab;
    });
  };
  // 点文件默认打开大弹窗（和客户端一样）；弹窗里点「在右侧栏打开」停到右栏，之后再点文件直接停右栏，
  // 在右栏点「放大成弹窗」改回来
  const modal = q(".hd-modal");
  const modalBox = q(".hd-modal-box");
  let preferDock = false;
  const setModal = (open: boolean) => {
    modal.hidden = !open;
    if (open) q<HTMLButtonElement>("[data-close-modal]").focus({ preventScroll: true });
  };
  const setView = (view: string) => {
    root
      .querySelectorAll<HTMLButtonElement>("[data-view]")
      .forEach((button) =>
        button.setAttribute("aria-checked", String(button.dataset.view === view)),
      );
    q("[data-modal-preview]").hidden = view !== "preview";
    q("[data-modal-raw]").hidden = view !== "raw";
  };
  file.addEventListener("click", () => {
    use("file");
    if (preferDock) setPreview(true);
    else setModal(true);
  });
  q("[data-close-preview]").addEventListener("click", () => setPreview(false));
  q("[data-undock]").addEventListener("click", () => {
    preferDock = false;
    setPreview(false);
    setModal(true);
  });
  q("[data-dock]").addEventListener("click", () => {
    preferDock = true;
    setModal(false);
    if (app.classList.contains("no-side-right"))
      q<HTMLButtonElement>('[data-toggle="side-right"]').click();
    setPreview(true);
  });
  root
    .querySelectorAll<HTMLButtonElement>("[data-view]")
    .forEach((button) => button.addEventListener("click", () => setView(button.dataset.view!)));
  q("[data-maximize]").addEventListener("click", (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const big = modalBox.classList.toggle("is-max");
    button.innerHTML = icon(big ? "shrink" : "expand");
    button.title = big ? t.web.restore : t.web.maximize;
    button.setAttribute("aria-label", button.title);
  });
  q("[data-download]").addEventListener("click", () => {
    const url = URL.createObjectURL(new Blob([t.web.source], { type: "text/markdown" }));
    Object.assign(document.createElement("a"), { href: url, download: t.web.file }).click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  q("[data-close-modal]").addEventListener("click", () => setModal(false));
  modal.addEventListener("click", (event) => {
    if (event.target === modal) setModal(false);
  });

  // 窗口标题栏（在演示外面，页面里那条）跟着当前房间走
  const windowTitle = host.closest("[data-hl-window]")?.querySelector(".hl-window-title");
  const setTitle = () => {
    if (windowTitle) windowTitle.textContent = `SuperHive · #${room}`;
  };

  // ---------- 切房间 ----------
  const switchRoom = (next: RoomId) => {
    room = next;
    root
      .querySelectorAll<HTMLButtonElement>("[data-room]")
      .forEach((button) =>
        button.setAttribute("aria-current", String(button.dataset.room === next)),
      );
    (Object.keys(lists) as RoomId[]).forEach((id) => (lists[id].hidden = id !== next));
    q(".hd-room-name").textContent = `# ${next}`;
    setTitle();
    q(".hd-room-meta").textContent = `${t.rooms.find((item) => item.id === next)!.online} · main`;
    if (next === "web") hint("file", file);
    if (next !== "web") setPreview(false);
    if (sharing) setSharing(false);
    lists[next].scrollTop = lists[next].scrollHeight;
  };
  root.querySelectorAll<HTMLButtonElement>("[data-room]").forEach((button) =>
    button.addEventListener("click", () => {
      if (button.dataset.room === "web") use("room");
      switchRoom(button.dataset.room as RoomId);
    }),
  );
  root.querySelector<HTMLButtonElement>('[data-go="question"]')?.addEventListener("click", () => {
    switchRoom("api");
    question.scrollIntoView({ block: "nearest", behavior: reduce.matches ? "auto" : "smooth" });
    question.classList.remove("is-flash");
    void question.offsetWidth;
    question.classList.add("is-flash");
  });

  // ---------- 右侧标签 ----------
  const tabs = [...root.querySelectorAll<HTMLButtonElement>("[data-tab]")];
  tabs.forEach((tab) =>
    tab.addEventListener("click", () => {
      if (tab.dataset.tab === "progress") use("progress");
      tabs.forEach((item) => item.setAttribute("aria-selected", String(item === tab)));
      root
        .querySelectorAll<HTMLElement>("[data-pane]")
        .forEach((pane) => (pane.hidden = pane.dataset.pane !== tab.dataset.tab));
    }),
  );

  // ---------- 输入框：@ 选成员、发消息 ----------
  const form = q<HTMLFormElement>(".hd-composer");
  const input = q<HTMLInputElement>(".hd-input");
  const menu = q(".hd-menu");
  let picks: DemoMember[] = [];
  let active = 0;
  const closeMenu = () => {
    menu.hidden = true;
    picks = [];
  };
  const drawMenu = () => {
    menu.innerHTML = picks.length
      ? picks
          .map(
            (
              who,
              index,
            ) => `<button type="button" role="option" aria-selected="${index === active}" data-pick="${index}">
              ${avatar(who)}<b>${esc(who.name)}</b><small>${esc(who.role)}</small></button>`,
          )
          .join("")
      : `<p>${esc(t.noMatch)}</p>`;
  };
  const pick = (who: DemoMember) => {
    input.value = input.value.replace(/@([^\s@]*)$/, `@${who.name} `);
    closeMenu();
    input.focus();
  };
  input.addEventListener("focus", () => use("composer"));
  input.addEventListener("input", () => {
    const match = /@([^\s@]*)$/.exec(input.value);
    if (!match) return closeMenu();
    const word = match[1].toLowerCase();
    picks = t.memberList
      .filter((who) => who.id !== me.id && who.name.toLowerCase().includes(word))
      .slice(0, 6);
    active = 0;
    menu.hidden = false;
    drawMenu();
  });
  input.addEventListener("keydown", (event) => {
    if (menu.hidden || !picks.length) {
      if (event.key === "Escape") closeMenu();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      active = (active + (event.key === "ArrowDown" ? 1 : picks.length - 1)) % picks.length;
      drawMenu();
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      pick(picks[active]);
    } else if (event.key === "Escape") closeMenu();
  });
  menu.addEventListener("mousedown", (event) => {
    const button = (event.target as Element).closest<HTMLElement>("[data-pick]");
    if (!button) return;
    event.preventDefault();
    pick(picks[Number(button.dataset.pick)]);
  });
  input.addEventListener("blur", () => window.setTimeout(closeMenu, 100));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    closeMenu();
    const list = lists[room];
    message(list, me, text);
    // 第一个 @ 到的 Agent 回话；没 @ Agent 时交给主 Agent；只 @ 了人就没人回
    const mentioned = [...text.matchAll(/@([\w一-龥-]+)/g)].map((match) =>
      t.memberList.find((who) => who.name === match[1]),
    );
    const agent =
      mentioned.find((who) => who?.kind === "agent") ??
      (mentioned.some(Boolean) ? undefined : member("claude"));
    scrollDown(list);
    if (!agent) return;
    later(500, () =>
      run(list, agent.id, t.chat.steps, { reply: t.chat.reply(agent.name), stepMs: 1100 }),
    );
  });

  // ---------- 终端 ----------
  const term = q(".hd-term");
  const out = q(".hd-term-out");
  const termInput = q<HTMLInputElement>(".hd-term-line input");
  const termButton = q(".hd-head [data-terminal]");
  out.textContent = `${t.term.hint}\n`;
  const print = (text: string) => {
    out.textContent += `${text}\n`;
    out.scrollTop = out.scrollHeight;
  };
  root.querySelectorAll<HTMLButtonElement>("[data-terminal]").forEach((button) =>
    button.addEventListener("click", () => {
      use("terminal");
      const open = term.hidden;
      term.hidden = !open;
      termButton.setAttribute("aria-pressed", String(open));
      if (open) termInput.focus({ preventScroll: true });
    }),
  );
  let printing = false;
  termInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || printing) return;
    const command = termInput.value.trim();
    termInput.value = "";
    print(`❯ ${command}`);
    if (!command) return;
    if (command === "clear") {
      out.textContent = "";
      return;
    }
    if (/^ls\b/.test(command)) return print(t.term.ls);
    if (/^git\b/.test(command)) return print(t.term.git);
    if (/test|vitest/.test(command)) {
      printing = true;
      t.term.test.forEach((line, index) =>
        later(index * 160, () => {
          print(line);
          if (index === t.term.test.length - 1) printing = false;
        }),
      );
      return;
    }
    print(t.term.unknown(command.slice(0, 40)));
  });

  // ---------- 顶栏：收起两侧、新话题 ----------
  const app = q(".hd-app");
  root.querySelectorAll<HTMLButtonElement>("[data-toggle]").forEach((button) =>
    button.addEventListener("click", () => {
      const side = button.dataset.toggle!;
      const hidden = app.classList.toggle(`no-${side}`);
      button.setAttribute("aria-pressed", String(!hidden));
    }),
  );
  q("[data-topic]").addEventListener("click", () => {
    const list = lists[room];
    if (list.lastElementChild?.classList.contains("hd-topic")) return;
    list.append(
      el(
        `<div class="hd-topic" role="separator"><span>${esc(t.topic.title)} · ${stamp()}</span><small>${esc(t.topic.note)}</small></div>`,
      ),
    );
    scrollDown(list);
  });

  // ---------- 产物、代码：盖在对话和右栏上的大面板 ----------
  const sheet = q(".hd-sheet");
  let sheetKind = "";
  const sheetButtons = [...root.querySelectorAll<HTMLButtonElement>("[data-sheet]")];
  const closeSheet = () => {
    sheet.hidden = true;
    sheetKind = "";
    sheetButtons.forEach((button) => button.setAttribute("aria-pressed", "false"));
  };
  const sheetHead = (kind: "box" | "code", title: string, extra = "") =>
    `<header class="hd-sheet-head">${icon(kind)}<b>${esc(title)}</b>${extra}
      <button type="button" class="hd-sheet-close" aria-label="${esc(t.web.close)}" data-close-sheet>${icon("close")}</button></header>`;

  const fakeShot = (art: "before" | "after") =>
    `<div class="hd-shot is-${art}" aria-hidden="true"><i></i><b></b><span></span><span></span><span></span><em>${esc(
      art === "before" ? t.artifacts.badge.before : t.artifacts.badge.after,
    )}</em></div>`;

  const renderArtifacts = (filter = "all", open = -1) => {
    const items = t.artifacts.items;
    const count = (kind: string) =>
      items.filter((item) => kind === "all" || item.kind === kind).length;
    const nav = (["all", "images", "files"] as const)
      .map((key) => {
        const kind = key === "images" ? "image" : key === "files" ? "file" : "all";
        return `<button type="button" data-filter="${kind}" aria-current="${filter === kind}">${esc(t.artifacts[key])}<em>${count(kind)}</em></button>`;
      })
      .join("");
    let main: string;
    if (open >= 0) {
      const item = items[open];
      const body =
        item.kind === "image"
          ? `${fakeShot(item.art!)}<p class="hd-muted">${esc(t.artifacts.imageNote)}</p>`
          : item.name.endsWith(".md")
            ? `<article class="hd-preview-body"><h3>${esc(t.web.previewTitle)}</h3>${t.web.previewBody}</article>`
            : `<pre class="hd-code">${esc(t.term.test.join("\n"))}</pre>`;
      main = `<div class="hd-art-open"><button type="button" class="hd-link" data-art-back>${icon("back")}${esc(t.artifacts.back)}</button>
        <p><b>${esc(item.name)}</b> <small>${esc(item.meta)}</small></p>${body}</div>`;
    } else {
      main = `<div class="hd-art-grid">${items
        .map((item, index) =>
          filter !== "all" && item.kind !== filter
            ? ""
            : `<button type="button" class="hd-art" data-art="${index}">${
                item.kind === "image"
                  ? fakeShot(item.art!)
                  : `<span class="hd-art-file">${icon("file")}<small>${esc(item.name.split(".").pop()!.toUpperCase())}</small></span>`
              }<b>${esc(item.name)}</b><small>${esc(item.meta)}</small></button>`,
        )
        .join("")}</div>`;
    }
    sheet.innerHTML = `${sheetHead("box", t.artifacts.title)}<div class="hd-sheet-body">
      <nav class="hd-sheet-nav"><span class="hd-fake-input">${esc(t.artifacts.search)}</span><small>${esc(t.artifacts.kinds)}</small>${nav}</nav>
      <div class="hd-sheet-main">${main}</div></div>`;
    sheet
      .querySelectorAll<HTMLButtonElement>("[data-filter]")
      .forEach((button) =>
        button.addEventListener("click", () => renderArtifacts(button.dataset.filter)),
      );
    sheet
      .querySelectorAll<HTMLButtonElement>("[data-art]")
      .forEach((button) =>
        button.addEventListener("click", () => renderArtifacts(filter, Number(button.dataset.art))),
      );
    sheet
      .querySelector("[data-art-back]")
      ?.addEventListener("click", () => renderArtifacts(filter));
  };

  const diffLine = (line: string) => {
    const kind = line.startsWith("@@")
      ? "hunk"
      : line.startsWith("+")
        ? "add"
        : line.startsWith("-")
          ? "del"
          : "";
    return `<span class="hd-diff-line ${kind}">${esc(line)}</span>`;
  };
  const renderCode = (tab = 0, pick = 0) => {
    const c = t.code;
    const tabs = c.tabs
      .map(
        (label, index) =>
          `<button type="button" data-code-tab="${index}" aria-selected="${index === tab}">${esc(label)}</button>`,
      )
      .join("");
    let side = "";
    let main = "";
    if (tab === 0) {
      side = `<p class="hd-muted">${esc(c.against)} · ${esc(c.summary)}</p>${c.changes
        .map(
          (
            file,
            index,
          ) => `<button type="button" class="hd-file-row" data-pick="${index}" aria-current="${index === pick}">
            <em class="is-${file.flag}">${file.flag}</em>${esc(file.path.split("/").pop()!)}<small>${esc(file.dir)}</small>
            <span><i class="is-add">+${file.add}</i>${file.del ? `<i class="is-del">-${file.del}</i>` : ""}</span></button>`,
        )
        .join("")}`;
      const file = c.changes[pick];
      main = `<p class="hd-code-path">${esc(file.path)}</p><pre class="hd-code">${file.diff.map(diffLine).join("")}</pre>`;
    } else if (tab === 1) {
      side = c.tree
        .map(
          (entry, index) =>
            `<button type="button" class="hd-file-row is-tree" style="--depth:${entry.depth}" ${
              entry.dir ? "disabled" : `data-pick="${index}" aria-current="${index === pick}"`
            }>${icon(entry.dir ? "folder" : "file")}${esc(entry.path)}</button>`,
        )
        .join("");
      const entry = c.tree[pick];
      main = entry?.body
        ? `<p class="hd-code-path">${esc(entry.path)}</p><pre class="hd-code">${esc(entry.body)}</pre>`
        : `<p class="hd-muted hd-pick">${esc(c.pick)}</p>`;
    } else {
      main = `<ol class="hd-commits">${c.commits
        .map(
          (commit) =>
            `<li><code>${commit.hash}</code><span>${esc(commit.text)}</span><small>${esc(commit.who)} · ${esc(commit.when)}</small></li>`,
        )
        .join("")}</ol>`;
    }
    sheet.innerHTML = `${sheetHead("code", c.title, `<small>api</small>`)}
      <div class="hd-code-bar"><span class="hd-seg">${tabs}</span><span class="hd-branch">${esc(c.branch)}</span></div>
      <div class="hd-sheet-body${tab === 2 ? " is-wide" : ""}">${tab === 2 ? "" : `<nav class="hd-sheet-nav is-files">${side}</nav>`}
      <div class="hd-sheet-main">${main}</div></div>`;
    sheet.querySelectorAll<HTMLButtonElement>("[data-code-tab]").forEach((button) =>
      button.addEventListener("click", () => {
        const next = Number(button.dataset.codeTab);
        renderCode(next, next === 1 ? 2 : 0);
      }),
    );
    sheet
      .querySelectorAll<HTMLButtonElement>("[data-pick]")
      .forEach((button) =>
        button.addEventListener("click", () => renderCode(tab, Number(button.dataset.pick))),
      );
  };

  sheetButtons.forEach((button) =>
    button.addEventListener("click", () => {
      const kind = button.dataset.sheet!;
      use(kind);
      if (sheetKind === kind) return closeSheet();
      sheetKind = kind;
      if (kind === "artifacts") renderArtifacts();
      else renderCode();
      sheet.hidden = false;
      sheetButtons.forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
    }),
  );
  sheet.addEventListener("click", (event) => {
    if ((event.target as Element).closest("[data-close-sheet]")) closeSheet();
  });
  root.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!modal.hidden) setModal(false);
    else if (!sheet.hidden) closeSheet();
  });

  // ---------- 分享：点选消息，复制成 Markdown 或下载 ----------
  const shareBar = q(".hd-share-bar");
  const shareNote = q("[data-share-note]");
  let sharing = false;
  const picked = () => [...lists[room].querySelectorAll<HTMLElement>(".hd-msg.is-picked")];
  const updateShare = () => {
    q("[data-share-count]").textContent = t.share.selected(picked().length);
  };
  const setSharing = (on: boolean) => {
    sharing = on;
    root.classList.toggle("is-sharing", on);
    shareBar.hidden = !on;
    form.hidden = on;
    q("[data-share-label]").textContent = on ? t.head.cancel : t.head.share;
    q(".hd-head [data-share]").setAttribute("aria-pressed", String(on));
    if (!on)
      root
        .querySelectorAll(".hd-msg.is-picked")
        .forEach((node) => node.classList.remove("is-picked"));
    shareNote.textContent = "";
    updateShare();
  };
  root.querySelectorAll<HTMLButtonElement>("[data-share]").forEach((button) =>
    button.addEventListener("click", () => {
      use("share");
      setSharing(!sharing);
    }),
  );
  (Object.values(lists) as HTMLElement[]).forEach((list) =>
    list.addEventListener(
      "click",
      (event) => {
        if (!sharing) return;
        const node = (event.target as Element).closest<HTMLElement>(".hd-msg:not(.hd-run)");
        if (!node) return;
        event.preventDefault();
        event.stopPropagation();
        node.classList.toggle("is-picked");
        updateShare();
      },
      true,
    ),
  );
  const markdown = () =>
    picked()
      .map((node) => {
        const name = node.querySelector(".hd-msg-meta b")?.textContent ?? "";
        const time = node.querySelector(".hd-msg-meta time")?.textContent ?? "";
        const text = node.querySelector(".hd-bubble")?.textContent ?? "";
        return `**${name}** ${time}\n\n${text}`;
      })
      .join("\n\n---\n\n");
  const note = (text: string) => {
    shareNote.textContent = text;
  };
  q("[data-share-all]").addEventListener("click", () => {
    lists[room]
      .querySelectorAll(".hd-msg:not(.hd-run)")
      .forEach((node) => node.classList.add("is-picked"));
    updateShare();
  });
  q("[data-share-copy]").addEventListener("click", () => {
    if (!picked().length) return note(t.share.empty);
    navigator.clipboard?.writeText(`# ${room}\n\n${markdown()}\n`).then(
      () => note(t.share.copied),
      () => note(t.share.empty),
    );
  });
  q("[data-share-download]").addEventListener("click", () => {
    if (!picked().length) return note(t.share.empty);
    const url = URL.createObjectURL(
      new Blob([`# ${room}\n\n${markdown()}\n`], { type: "text/markdown" }),
    );
    const link = Object.assign(document.createElement("a"), {
      href: url,
      download: `superhive-${room}.md`,
    });
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    note(t.share.downloaded);
  });
  q("[data-share-image]").addEventListener("click", () => note(t.share.imageNote));

  // ---------- 挂上 ----------
  setTitle();
  renderMembers();
  renderBoard();
  host.append(root);
  shop.scrollTop = shop.scrollHeight;
  hint("option", question.querySelector(".hd-options"));
  hint("stop", first.stop);
  hint("composer", form);
  hint("terminal", termButton);
  hint("artifacts", q('[data-sheet="artifacts"]'));
  hint("code", q('[data-sheet="code"]'));
  hint("progress", tabs[1]);
  hint("room", root.querySelector('[data-room="web"]'));

  // 滚轮：没点过演示时，滚轮一律交给页面，鼠标路过不会被对话流卡住；点过之后里面的列表才吃滚轮，
  // 滚到头了照常接着滚页面（CSS 里没有 overscroll-behavior: contain）。演示滚出视口后恢复成交给页面
  let engaged = false;
  root.addEventListener("pointerdown", () => (engaged = true));
  root.addEventListener(
    "wheel",
    (event) => {
      if (engaged || event.ctrlKey) return;
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
      window.scrollBy({ top: event.deltaY * unit, left: 0, behavior: "instant" as ScrollBehavior });
    },
    { passive: false },
  );
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (!visible) engaged = false;
  }).observe(root);
  requestAnimationFrame(() => root.classList.add("is-on"));
  return root;
}
