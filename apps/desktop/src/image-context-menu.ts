import type { ContextMenuParams, MenuItemConstructorOptions } from "electron";

/** 右击图片时要做的两件事，由主进程接到当前 webContents 上 */
export type ImageMenuActions = {
  /** 把 (x, y) 处的图片放进剪贴板 */
  copyImageAt: (x: number, y: number) => void;
  /** 下载图片：没有 will-download 处理时 Electron 会弹出「另存为」对话框 */
  downloadURL: (url: string) => void;
};

export type ImageMenuLabels = { copyImage: string; saveImageAs: string };

/**
 * Electron 没有浏览器那样的原生右键菜单：网页不接管的图片右击（预览大图、消息里的缩略图），
 * 这里补一个只针对图片的菜单，能「复制图片」「图片另存为」。
 * 不是图片、或网页已经弹了自己的菜单（会 preventDefault，Electron 就不发 context-menu）时返回 undefined
 */
export function imageContextMenu(
  params: Pick<ContextMenuParams, "mediaType" | "hasImageContents" | "srcURL" | "x" | "y">,
  actions: ImageMenuActions,
  labels: ImageMenuLabels,
): MenuItemConstructorOptions[] | undefined {
  if (params.mediaType !== "image") return undefined;
  const items: MenuItemConstructorOptions[] = [];
  if (params.hasImageContents) {
    items.push({ label: labels.copyImage, click: () => actions.copyImageAt(params.x, params.y) });
  }
  // data: / blob: / http(s): 都能下载；javascript: 之类的不给
  if (/^(https?|blob|data):/i.test(params.srcURL)) {
    const url = params.srcURL;
    items.push({ label: labels.saveImageAs, click: () => actions.downloadURL(url) });
  }
  return items.length ? items : undefined;
}
