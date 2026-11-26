/**
 * 首屏加载画面的收尾。
 *
 * - 浏览器：index.html 里有一个内联的蜂巢 logo 占位（#boot-splash，纯 CSS + SVG，不等脚本就能画出来），
 *   首屏画好后淡出并移除；
 * - 桌面端：加载动画由桌面端自己盖在窗口上（网页里的占位用 CSS 藏起来），这里通知它收起。
 *
 * 「画好了」的时机：进了房间、消息快照到了；或者停在登录、邀请、没有权限这类页面上。
 * 都不满足时（比如一直连不上）由调用方的兜底计时触发，不会永远盖着。
 */
import { useEffect } from "react";
import { desktopBridge, type DesktopBridge } from "./desktop-bridge";
import {
  stopBootLoadingStatus,
  updateBootLoadingStatus,
  type LoadingStatus,
} from "./loading-status";

export const BOOT_SPLASH_ID = "boot-splash";
/** 和 index.html 里退场动画的时长一致 */
export const BOOT_SPLASH_LEAVE_MS = 360;

let signaled = false;

/** 测试用：恢复成还没通知过的状态 */
export function resetAppReadyForTest(): void {
  signaled = false;
}

function prefersReducedMotion(doc: Document): boolean {
  if (doc.documentElement.dataset.reduceMotion === "true") return true;
  return Boolean(doc.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

/** 等这一帧真正画出来再动手，免得露出来的是还没排好的界面 */
function afterPaint(callback: () => void): void {
  const raf = globalThis.requestAnimationFrame;
  if (typeof raf !== "function") {
    setTimeout(callback, 0);
    return;
  }
  raf(() => setTimeout(callback, 0));
}

/** 首屏画好了：收起加载画面。只生效一次，之后再调用什么都不做 */
export function signalAppReady(
  doc: Document = document,
  bridge: DesktopBridge | undefined = desktopBridge(),
): void {
  if (signaled) return;
  signaled = true;
  stopBootLoadingStatus();
  afterPaint(() => {
    try {
      bridge?.ready?.();
    } catch {
      /* 桌面端接口出问题不影响网页本身 */
    }
    const splash = doc.getElementById(BOOT_SPLASH_ID);
    if (!splash) return;
    if (prefersReducedMotion(doc)) {
      splash.remove();
      return;
    }
    splash.classList.add("is-leaving");
    setTimeout(() => splash.remove(), BOOT_SPLASH_LEAVE_MS);
  });
}

/** 条件满足（首屏内容到了）就收起加载画面 */
export function useAppReady(ready: boolean): void {
  useEffect(() => {
    if (ready) signalAppReady();
  }, [ready]);
}

export function useAppLoadingStatus({ phase, error, retrying }: LoadingStatus): void {
  useEffect(() => {
    if (!signaled) updateBootLoadingStatus({ phase, error, retrying });
  }, [phase, error, retrying]);
}

/** 兜底：从挂载起过了 ms 还没收起就直接收起 */
export function useAppReadyFallback(active: boolean, ms: number): void {
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => signalAppReady(), ms);
    return () => clearTimeout(timer);
  }, [active, ms]);
}
