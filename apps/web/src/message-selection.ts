/**
 * 右键消息时看清楚点在了什么上：选中的文字、链接、代码块、图片，还是输入框（输入框留给浏览器原生菜单）。
 * 对话流渲染在 shadow root 里，选区要从 shadow root 取，document 上只看得到宿主
 */

type SelectionSource = { getSelection?: () => Selection | null };
type ComposedSelection = Selection & {
  getComposedRanges?: (...args: unknown[]) => StaticRange[];
};

function selectionFor(element: Element): Selection | null {
  const root = element.getRootNode();
  // Chrome 的 ShadowRoot 有非标准的 getSelection，拿到的是 shadow 内的真实节点
  if (root instanceof ShadowRoot && typeof (root as SelectionSource).getSelection === "function") {
    return (root as SelectionSource).getSelection!();
  }
  return document.getSelection();
}

function selectedRange(selection: ComposedSelection, element: Element): AbstractRange | undefined {
  const root = element.getRootNode();
  if (root instanceof ShadowRoot && typeof selection.getComposedRanges === "function") {
    // Safari / 新版 Chrome：要显式声明 shadow root 才给出里面的节点；新旧两种参数写法都试
    try {
      const ranges = selection.getComposedRanges({ shadowRoots: [root] });
      if (ranges[0]) return ranges[0];
    } catch {
      try {
        const ranges = selection.getComposedRanges(root);
        if (ranges[0]) return ranges[0];
      } catch {
        // 退回 getRangeAt
      }
    }
  }
  return selection.rangeCount ? selection.getRangeAt(0) : undefined;
}

/** element 里选中的文字（选区两头都要落在 element 里）；没选或选到外面去了返回 undefined */
export function selectedTextWithin(element: Element): string | undefined {
  const selection = selectionFor(element) as ComposedSelection | null;
  if (!selection || selection.isCollapsed) return undefined;
  const range = selectedRange(selection, element);
  if (!range || !element.contains(range.startContainer) || !element.contains(range.endContainer)) {
    return undefined;
  }
  const text = selection.toString().trim();
  return text || undefined;
}

/** 右键点在了输入框或可编辑区域上：不接管，留给浏览器原生菜单（粘贴、拼写检查） */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'),
  );
}

export type MenuTarget = {
  /** 右键点在外链上 */
  link?: string;
  /** 右键点在代码块（或行内代码）上：代码文本 */
  code?: string;
  /** 右键点在图片上：点开它的那个按钮（附件缩略图），没有就是图片地址 */
  image?: { open: () => void };
};

/** 右键点中的东西：只在 within 里面找，不越过消息边界 */
export function menuTargetOf(target: EventTarget | null, within: Element): MenuTarget {
  if (!(target instanceof Element) || !within.contains(target)) return {};
  const result: MenuTarget = {};
  const anchor = target.closest<HTMLAnchorElement>("a[href]");
  if (anchor && within.contains(anchor) && /^(https?:|mailto:)/i.test(anchor.href)) {
    result.link = anchor.href;
  }
  const pre = target.closest("pre");
  const code = pre && within.contains(pre) ? pre : target.closest("code");
  if (code && within.contains(code) && code.textContent?.trim()) {
    result.code = code.textContent.replace(/\n$/, "");
  }
  const image =
    target instanceof HTMLImageElement ? target : target.querySelector?.(":scope > img");
  if (image instanceof HTMLImageElement && within.contains(image)) {
    const opener = image.closest<HTMLButtonElement>("button");
    result.image = {
      open: () => {
        if (opener && within.contains(opener) && !opener.disabled) opener.click();
        else window.open(image.src, "_blank", "noopener,noreferrer");
      },
    };
  }
  return result;
}
