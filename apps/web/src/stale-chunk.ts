/**
 * 发版或重新构建后，开着的旧页面再去加载按需拆分的代码块（终端、预览、编辑器……），旧文件名已经不在了，
 * 浏览器报「Failed to fetch dynamically imported module」。这不是代码缺陷，刷新一次拿到新页面就好：
 * 自动刷新一次，不报故障。刷新后几分钟内又遇到（Server 真的缺文件、网络不通）才照常上报。
 */

/** Chrome / Firefox / Safari 各自的说法，以及 Vite 预加载样式失败 */
const STALE_CHUNK =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i;

export const STALE_CHUNK_RELOAD_KEY = "hive:stale-chunk-reload";
/** 自动刷新过之后这么久内再遇到就不再刷新，改为上报，免得刷新循环 */
export const STALE_CHUNK_RELOAD_WINDOW_MS = 5 * 60_000;

export function isStaleChunkError(message: string | undefined): boolean {
  return Boolean(message && STALE_CHUNK.test(message));
}

type ReloadDeps = {
  storage?: Pick<Storage, "getItem" | "setItem"> | undefined;
  reload?: () => void;
  now?: number;
};

let reloading = false;

/** 测试用：回到页面刚打开的状态 */
export function resetStaleChunkRecovery(): void {
  reloading = false;
}

/**
 * 遇到旧代码块加载失败时调用：返回 true 表示已经（或正在）刷新页面，这次不用上报；
 * false 表示刚自动刷新过还是失败，交给错误上报。同一页面多次调用只刷新一次。
 */
export function reloadForStaleChunk(deps: ReloadDeps = {}): boolean {
  if (reloading) return true;
  const storage = deps.storage ?? safeSessionStorage();
  const now = deps.now ?? Date.now();
  const last = Number(storage?.getItem(STALE_CHUNK_RELOAD_KEY) ?? "");
  if (Number.isFinite(last) && last > 0 && now - last < STALE_CHUNK_RELOAD_WINDOW_MS) return false;
  // 记不下时间（隐私模式禁用存储）就无从防循环：不刷新，照常上报
  if (!storage) return false;
  try {
    storage.setItem(STALE_CHUNK_RELOAD_KEY, String(now));
  } catch {
    return false;
  }
  reloading = true;
  (deps.reload ?? (() => window.location.reload()))();
  return true;
}

function safeSessionStorage(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

function messageOf(reason: unknown): string | undefined {
  if (reason instanceof Error) return reason.message;
  return typeof reason === "string" ? reason : undefined;
}

/**
 * 所有页面（含访客）都装：按需加载的代码块拿不到时刷新一次。
 * vite:preloadError 是 Vite 打包后预加载失败时发的事件，取消它就不再往外抛错。返回卸载函数。
 */
export function installStaleChunkRecovery(deps: ReloadDeps = {}): () => void {
  const onPreloadError = (event: Event) => {
    const payload = (event as Event & { payload?: unknown }).payload;
    if (isStaleChunkError(messageOf(payload) ?? "Unable to preload CSS")) {
      if (reloadForStaleChunk(deps)) event.preventDefault();
    }
  };
  const onError = (event: ErrorEvent) => {
    if (isStaleChunkError(messageOf(event.error) ?? event.message)) reloadForStaleChunk(deps);
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    if (isStaleChunkError(messageOf(event.reason))) reloadForStaleChunk(deps);
  };
  window.addEventListener("vite:preloadError", onPreloadError);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    window.removeEventListener("vite:preloadError", onPreloadError);
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}
