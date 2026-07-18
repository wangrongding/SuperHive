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

async function syncStylesInto(shadow: ShadowRoot): Promise<void> {
  const transformed = adaptCssForShadow(await collectDocumentCss());
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
    void syncStylesInto(shadow);
    mirrorDataAttributes(host);
    setRoot(shadow);

    const headObserver = new MutationObserver(() => void syncStylesInto(shadow));
    headObserver.observe(document.head, { childList: true, subtree: true, characterData: true });
    const attrObserver = new MutationObserver(() => mirrorDataAttributes(host));
    attrObserver.observe(document.documentElement, { attributes: true });
    return () => {
      headObserver.disconnect();
      attrObserver.disconnect();
    };
  }, [host]);

  if (fallback) return children;
  return root ? createPortal(children, root) : null;
}
