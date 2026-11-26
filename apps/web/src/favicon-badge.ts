import { useEffect, useRef } from "react";
import faviconSvg from "virtual:hive-favicon";

/**
 * 标签页图标上的状态小圆点：按「跟你有关」的最重要的一种状态显示，优先级从高到低：
 * 需要你处理（红）> 有任务在跑（蓝）> 做完了还没看（绿）；都没有时恢复原图标。
 * 标题前缀「(n)」数的是需要你处理的条数。
 */
export type FaviconBadge = "attention" | "running" | "unseen";

export function pickFaviconBadge(state: {
  attention: number;
  running: number;
  unseen: number;
}): FaviconBadge | undefined {
  if (state.attention > 0) return "attention";
  if (state.running > 0) return "running";
  if (state.unseen > 0) return "unseen";
  return undefined;
}

const badgeColors: Record<FaviconBadge, string> = {
  attention: "#e5484d",
  running: "#3b82f6",
  unseen: "#30a46c",
};

/**
 * 在原图标右下角叠一个圆点，圆点外面描一圈和标签栏同色的边，深浅色标签栏上都分得出来。
 * 直接拼 SVG 而不是用 canvas 画成位图：原图标靠 prefers-color-scheme 切深浅色，SVG 能保留这一点，
 * 16px 下也更清楚。
 */
export function badgedFaviconSvg(badge: FaviconBadge): string {
  const dot =
    `<style>.hive-badge-ring{fill:#ffffff}` +
    `@media (prefers-color-scheme: dark){.hive-badge-ring{fill:#202124}}</style>` +
    `<circle class="hive-badge-ring" cx="37" cy="37" r="11"/>` +
    `<circle cx="37" cy="37" r="8" fill="${badgeColors[badge]}"/>`;
  return faviconSvg.replace(/<\/svg>\s*$/, `${dot}</svg>`);
}

export function faviconHref(badge: FaviconBadge | undefined): string {
  if (!badge) return "/favicon.svg";
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(badgedFaviconSvg(badge))}`;
}

/** 标题前缀：有需要你处理的就写「(n) 」，没有就去掉 */
export function badgedTitle(base: string, attention: number): string {
  const plain = base.replace(/^\(\d+\+?\)\s*/, "") || "SuperHive";
  if (attention <= 0) return plain;
  return `(${attention > 99 ? "99+" : attention}) ${plain}`;
}

/** 把状态写到 <link rel="icon"> 和标题上；状态没变时不动 */
export function useFaviconBadge(state: { attention: number; running: number; unseen: number }) {
  const badge = pickFaviconBadge(state);
  const applied = useRef<string | undefined>(undefined);
  useEffect(() => {
    const key = `${badge ?? "none"}:${state.attention}`;
    if (applied.current === key) return;
    applied.current = key;
    const link =
      document.querySelector<HTMLLinkElement>('link[rel~="icon"]') ??
      Object.assign(document.head.appendChild(document.createElement("link")), { rel: "icon" });
    link.type = "image/svg+xml";
    link.href = faviconHref(badge);
    if (badge) link.dataset.badge = badge;
    else delete link.dataset.badge;
    document.title = badgedTitle(document.title, state.attention);
  }, [badge, state.attention]);
  // 离开页面（比如退出登录卸载）时恢复原样
  useEffect(
    () => () => {
      applied.current = undefined;
      const link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
      if (link) {
        link.href = "/favicon.svg";
        delete link.dataset.badge;
      }
      document.title = badgedTitle(document.title, 0);
    },
    [],
  );
}
