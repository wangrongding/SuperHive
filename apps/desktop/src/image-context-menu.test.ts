import { describe, expect, it, vi } from "vitest";
import { imageContextMenu } from "./image-context-menu.js";

const labels = { copyImage: "复制图片", saveImageAs: "图片另存为…" };
const base = {
  mediaType: "image" as const,
  hasImageContents: true,
  srcURL: "blob:http://127.0.0.1:8787/abc",
  x: 10,
  y: 20,
};

describe("图片右键菜单", () => {
  it("图片：复制图片、另存为，分别调到 copyImageAt 和 downloadURL", () => {
    const actions = { copyImageAt: vi.fn(), downloadURL: vi.fn() };
    const items = imageContextMenu(base, actions, labels)!;
    expect(items.map((item) => item.label)).toEqual(["复制图片", "图片另存为…"]);
    (items[0]!.click as () => void)();
    (items[1]!.click as () => void)();
    expect(actions.copyImageAt).toHaveBeenCalledWith(10, 20);
    expect(actions.downloadURL).toHaveBeenCalledWith(base.srcURL);
  });

  it("不是图片（文字、输入框、视频）不弹", () => {
    const actions = { copyImageAt: vi.fn(), downloadURL: vi.fn() };
    expect(imageContextMenu({ ...base, mediaType: "none" }, actions, labels)).toBeUndefined();
    expect(imageContextMenu({ ...base, mediaType: "video" }, actions, labels)).toBeUndefined();
  });

  it("图片还没加载出来只给另存为；奇怪的地址不给另存为", () => {
    const actions = { copyImageAt: vi.fn(), downloadURL: vi.fn() };
    expect(
      imageContextMenu({ ...base, hasImageContents: false }, actions, labels)!.map((i) => i.label),
    ).toEqual(["图片另存为…"]);
    expect(
      imageContextMenu({ ...base, srcURL: "javascript:alert(1)" }, actions, labels)!.map(
        (i) => i.label,
      ),
    ).toEqual(["复制图片"]);
    expect(
      imageContextMenu(
        { ...base, hasImageContents: false, srcURL: "javascript:alert(1)" },
        actions,
        labels,
      ),
    ).toBeUndefined();
  });
});
