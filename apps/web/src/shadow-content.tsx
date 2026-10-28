import { useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

// 把文档级样式表适配到 shadow root 内：
// :root / html 前缀的选择器在 shadow 内不存在匹配对象，转写为 :host(...)，
// 配合把 documentElement 的 data-* 属性镜像到宿主元素，主题/字号/动效偏好在 shadow 内继续生效
export function adaptCssForShadow(css: string): string {
  return css
    .replace(/:root(\[[^\]]+\])/g, ":host($1)")
    .replace(/:root\b/g, ":host")
    .replace(/\bhtml(\[[^\]]+\])/g, ":host($1)");
}

/**
 * 同步读取文档样式：<style> 直接取文本，<link> 读已加载的 CSSOM 规则。
 * 头部样式表会阻塞模块脚本执行，所以 React 挂载时它们早已就绪，无需重新下载。
 * 任一样式表不可读（跨域、尚未加载）时返回 undefined，由调用方退回异步拉取。
 */
function readDocumentCssSync(): string | undefined {
  let css = "";
  for (const node of document.querySelectorAll('style, link[rel="stylesheet"]')) {
    if (node.tagName === "STYLE") {
      css += `${node.textContent ?? ""}\n`;
      continue;
    }
    const sheet = (node as HTMLLinkElement).sheet;
    if (!sheet) return undefined;
    try {
      for (const rule of sheet.cssRules) css += `${rule.cssText}\n`;
    } catch {
      return undefined;
    }
  }
  return css;
}

async function collectDocumentCss(): Promise<string> {
  let css = "";
  for (const node of document.querySelectorAll('style, link[rel="stylesheet"]')) {
    if (node.tagName === "STYLE") {
      css += `${node.textContent ?? ""}\n`;
    } else {
      const href = node.getAttribute("href");
      if (!href) continue;
      try {
        const response = await fetch(href);
        if (response.ok) css += `${await response.text()}\n`;
      } catch {
        // 样式拉取失败时跳过该表，shadow 内退化为无样式而非报错
      }
    }
  }
  return css;
}

function applyCss(shadow: ShadowRoot, css: string): void {
  const transformed = adaptCssForShadow(css);
  let styleElement = shadow.querySelector<HTMLStyleElement>("style[data-hive-shadow-styles]");
  if (!styleElement) {
    styleElement = document.createElement("style");
    styleElement.setAttribute("data-hive-shadow-styles", "");
    shadow.appendChild(styleElement);
  }
  if (styleElement.textContent !== transformed) {
    styleElement.textContent = transformed;
  }
}

/** 同步优先；只有样式表不可读时才异步拉取 */
async function syncStylesInto(shadow: ShadowRoot): Promise<void> {
  applyCss(shadow, readDocumentCssSync() ?? (await collectDocumentCss()));
}

function mirrorDataAttributes(host: HTMLElement): void {
  const source = document.documentElement;
  for (const { name, value } of [...source.attributes]) {
    if (name.startsWith("data-") && host.getAttribute(name) !== value) {
      host.setAttribute(name, value);
    }
  }
  for (const { name } of [...host.attributes]) {
    if (name.startsWith("data-") && !source.hasAttribute(name)) {
      host.removeAttribute(name);
    }
  }
}

// 将子树渲染进宿主元素的 Shadow DOM。
// 目的：页面级扩展（豆包助手、划词翻译等）的 MutationObserver、querySelector 和
// 逐节点事件监听默认无法进入 shadow root——高频变更的消息流对它们不可见，
// 避免其内存泄漏被我们的 DOM churn 放大（实测可导致 renderer OOM 崩溃）。
// attachShadow 不可用时回退为普通渲染。
export function ShadowContent({
  host,
  children,
}: {
  host: HTMLElement | null;
  children: ReactNode;
}) {
  const [root, setRoot] = useState<ShadowRoot | null>(null);
  const [fallback, setFallback] = useState(false);

  useLayoutEffect(() => {
    if (!host) return;
    let shadow: ShadowRoot;
    try {
      shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    } catch {
      setFallback(true);
      return;
    }
    mirrorDataAttributes(host);
    // 样式必须先于内容就位：否则内容会在无样式的 shadow root 里先渲染一帧
    // （未设尺寸的 SVG 撑满宽度、列表高度暴涨），随后再塌回去，滚动位置跟着跳
    let cancelled = false;
    const css = readDocumentCssSync();
    if (css !== undefined) {
      applyCss(shadow, css);
      setRoot(shadow);
    } else {
      void collectDocumentCss().then((fetched) => {
        if (cancelled) return;
        applyCss(shadow, fetched);
        setRoot(shadow);
      });
    }

    const headObserver = new MutationObserver(() => void syncStylesInto(shadow));
    headObserver.observe(document.head, { childList: true, subtree: true, characterData: true });
    const attrObserver = new MutationObserver(() => mirrorDataAttributes(host));
    attrObserver.observe(document.documentElement, { attributes: true });
    return () => {
      cancelled = true;
      headObserver.disconnect();
      attrObserver.disconnect();
    };
  }, [host]);

  if (fallback) return children;
  return root ? createPortal(children, root) : null;
}
