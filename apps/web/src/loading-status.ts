import en from "./i18n/en.json";

export type LoadingPhase = "starting" | "connecting" | "joining" | "messages";
export type LoadingStatus = { phase: LoadingPhase; error?: string; retrying?: boolean };

export const LOADING_SLOW_MS = 4_000;
export const LOADING_COPY_MIN_MS = 1_500;

const titles: Record<LoadingPhase, string> = {
  starting: "打开蜂巢",
  connecting: "连接 Hive",
  joining: "准备房间",
  messages: "载入房间消息",
};
const hints: Record<LoadingPhase, string[]> = {
  starting: ["正在把蜂巢搬到你的屏幕上…", "给蜂巢轻轻敲个门…"],
  connecting: ["正在寻找回蜂巢的路…", "给蜂巢轻轻敲个门…"],
  joining: ["给 Agent 们留个座位…", "看看蜂巢里都有谁…"],
  messages: ["把蜂巢里的新鲜消息捎过来…", "整理一下大家留下的花粉笔记…"],
};
const slowHints: Record<LoadingPhase, string> = {
  starting: "网页资源还在载入，请检查网络或重新加载。",
  connecting: "正在等待 Hive Server 响应，请确认服务已启动、网络可用。",
  joining: "正在建立房间连接，请检查网络；连接中断后会自动重试。",
  messages: "已连接，正在等待房间消息；暂时还没有收到消息快照。",
};

function translate(source: string, doc: Document): string {
  return doc.documentElement.lang === "en"
    ? ((en as Record<string, string>)[source] ?? source)
    : source;
}

export function mountLoadingStatus(root: HTMLElement, initial: LoadingStatus, elapsedMs = 0) {
  const doc = root.ownerDocument;
  const title = root.querySelector<HTMLElement>("[data-loading-title]")!;
  const hint = root.querySelector<HTMLElement>("[data-loading-hint]")!;
  const help = root.querySelector<HTMLElement>("[data-loading-help]")!;
  const reload = help.querySelector<HTMLAnchorElement>("a")!;
  const startedAt = Date.now() - elapsedMs;
  const choices = new Map<LoadingPhase, string>();
  let status = initial;
  let shownPhase = initial.phase;
  let hintChangedAt = Date.now();
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  root.dataset.managed = "true";
  root.querySelector("[data-loading-fallback]")?.remove();
  reload.href = doc.defaultView?.location.href ?? "";
  const onReload = (event: MouseEvent) => {
    event.preventDefault();
    doc.defaultView?.location.reload();
  };
  reload.addEventListener("click", onReload);
  const render = () => {
    if (stopped) return;
    const slow = Date.now() - startedAt >= LOADING_SLOW_MS;
    root.dataset.failed = String(Boolean(status.error));
    title.textContent = translate(
      status.error
        ? status.retrying
          ? "连接中断，正在重试"
          : "暂时无法载入 Hive"
        : titles[status.phase],
      doc,
    );
    help.hidden = !slow && !status.error;
    reload.textContent = translate("重新加载", doc);
    if (status.error || slow) {
      hint.textContent = status.error ?? translate(slowHints[status.phase], doc);
      hintChangedAt = Date.now();
      return;
    }
    if (shownPhase !== status.phase) {
      const wait = LOADING_COPY_MIN_MS - (Date.now() - hintChangedAt);
      if (wait > 0) {
        clearTimeout(copyTimer);
        copyTimer = setTimeout(render, wait);
        return;
      }
      shownPhase = status.phase;
      hintChangedAt = Date.now();
    }
    if (!choices.has(shownPhase)) {
      const options = hints[shownPhase];
      choices.set(shownPhase, options[Math.floor(Math.random() * options.length)]!);
    }
    hint.textContent = translate(choices.get(shownPhase)!, doc);
  };
  render();
  const slowTimer = setTimeout(render, Math.max(0, LOADING_SLOW_MS - elapsedMs));
  return {
    update(next: LoadingStatus) {
      status = next;
      render();
    },
    destroy() {
      stopped = true;
      clearTimeout(copyTimer);
      clearTimeout(slowTimer);
      reload.removeEventListener("click", onReload);
    },
  };
}

let bootStatus: LoadingStatus = { phase: "starting" };
let bootController: ReturnType<typeof mountLoadingStatus> | undefined;

export function startBootLoadingStatus(doc: Document = document): void {
  const root = doc.getElementById("boot-splash");
  if (root && !root.classList.contains("is-leaving") && !bootController)
    bootController = mountLoadingStatus(root, bootStatus, doc.defaultView?.performance.now() ?? 0);
}

export function updateBootLoadingStatus(status: LoadingStatus): void {
  bootStatus = status;
  bootController?.update(status);
}

export function failBootLoadingStatus(doc: Document = document): void {
  updateBootLoadingStatus({
    phase: "starting",
    error: translate("网页资源加载失败或超时，请检查网络后重新加载。", doc),
  });
}

export function stopBootLoadingStatus(): void {
  bootController?.destroy();
  bootController = undefined;
}
