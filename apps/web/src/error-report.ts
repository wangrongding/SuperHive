import { isViteDevNoise, type ClientErrorReport } from "@superhive/protocol";
import { isStaleChunkError, reloadForStaleChunk } from "./stale-chunk";

/** 同一个报错在这么长时间内只报一次：渲染循环里反复抛的错不刷屏 */
export const ERROR_REPORT_DEDUPE_MS = 60_000;

/** 浏览器扩展、跨域脚本这类和我们代码无关的报错：不报 */
export function ignorableError(message: string, stack: string | undefined): boolean {
  if (/^Script error\.?$/i.test(message.trim())) return true;
  if (/ResizeObserver loop/i.test(message)) return true;
  return /(?:chrome|moz|safari(?:-web)?)-extension:\/\//.test(stack ?? "");
}

/**
 * 开发服务器热更新、依赖重新预构建之后这么久内的报错算开发噪音：改到一半的代码、
 * 热更新后 Hook 顺序对不上、新旧两份 React 混用，刷新即好，不是要修的故障
 */
export const DEV_RELOAD_GRACE_MS = 30_000;

let lastHotUpdateAt = Number.NEGATIVE_INFINITY;

/** 开发服务器刚推来热更新或要整页刷新（Vite 的 vite:beforeUpdate / vite:beforeFullReload） */
export function noteHotUpdate(at = Date.now()): void {
  lastHotUpdateAt = at;
}

if (import.meta.hot) {
  import.meta.hot.on("vite:beforeUpdate", () => noteHotUpdate());
  import.meta.hot.on("vite:beforeFullReload", () => noteHotUpdate());
}

/** 只在开发构建里判断：调用栈带着热更新、预构建的痕迹，或刚热更新过 */
export function isDevNoise(
  report: Pick<ClientErrorReport, "stack">,
  now = Date.now(),
  hotUpdateAt = lastHotUpdateAt,
): boolean {
  return isViteDevNoise(report.stack) || now - hotUpdateAt < DEV_RELOAD_GRACE_MS;
}

export function reportFrom(
  kind: ClientErrorReport["kind"],
  reason: unknown,
  fallbackMessage?: string,
): ClientErrorReport {
  const error = reason instanceof Error ? reason : undefined;
  return {
    kind,
    ...(error?.name ? { name: error.name.slice(0, 100) } : {}),
    message: (error?.message || fallbackMessage || String(reason)).slice(0, 1000),
    ...(error?.stack ? { stack: error.stack.slice(0, 8000) } : {}),
    url: window.location.href.slice(0, 2000),
    userAgent: navigator.userAgent.slice(0, 500),
  };
}

/**
 * 房主页面上的报错交给 Server 归档成故障单（访客的页面不报：Server 只收房主的）。
 * 只报未捕获的异常和没人处理的 Promise 拒绝；同一个报错一分钟内只报一次。返回卸载函数。
 */
export function installErrorReporter(options: {
  base: string;
  token: string;
  roomId: () => string | undefined;
  send?: (report: ClientErrorReport, roomId: string | undefined) => void;
  /** 开发构建（import.meta.env.DEV）：热更新造成的报错只打到控制台，不报故障 */
  dev?: boolean;
  /** 旧代码块加载失败时刷新页面（测试注入）；返回 false 表示刚刷新过仍失败，照常上报 */
  reloadForStaleChunk?: () => boolean;
}): () => void {
  const lastSent = new Map<string, number>();
  const send =
    options.send ??
    ((report: ClientErrorReport, roomId: string | undefined) => {
      void fetch(`${options.base}/api/client-errors`, {
        method: "POST",
        keepalive: true,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${options.token}`,
          ...(roomId ? { "X-Hive-Room": roomId } : {}),
        },
        body: JSON.stringify(report),
      }).catch(() => undefined);
    });
  const reload = options.reloadForStaleChunk ?? (() => reloadForStaleChunk());
  const submit = (report: ClientErrorReport) => {
    if (ignorableError(report.message, report.stack)) return;
    if (options.dev && isDevNoise(report)) {
      console.debug(
        "[hive] dev-server hot update noise, not reported as an incident:",
        report.message,
      );
      return;
    }
    // 发版后旧页面拿不到旧代码块：刷新一次就好，刷新后仍失败才报
    if (isStaleChunkError(report.message) && reload()) return;
    const key = `${report.kind} ${report.name ?? ""} ${report.message}`;
    const now = Date.now();
    if (now - (lastSent.get(key) ?? 0) < ERROR_REPORT_DEDUPE_MS) return;
    lastSent.set(key, now);
    send(report, options.roomId());
  };
  const onError = (event: ErrorEvent) => submit(reportFrom("error", event.error, event.message));
  const onRejection = (event: PromiseRejectionEvent) =>
    submit(reportFrom("unhandledrejection", event.reason));
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}
