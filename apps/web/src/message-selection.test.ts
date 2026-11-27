// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { isImageTarget, isPortalBubble, keepsNativeContextMenu } from "./message-selection";

function setup() {
  document.body.innerHTML = `
    <div id="row"><span id="name">Alice</span><button id="thumb"><img id="img" /></button><input id="field" /></div>
    <div id="portal"><img id="big" /><p id="text">弹窗</p></div>`;
  const $ = (id: string) => document.getElementById(id)!;
  return { $, row: $("row") };
}

describe("右击要不要留给浏览器原生菜单", () => {
  it("目标不在监听元素里（从 portal 冒泡上来的）：房间、成员、发送者菜单都不接管", () => {
    const { $, row } = setup();
    expect(isPortalBubble({ target: $("big"), currentTarget: row })).toBe(true);
    expect(isPortalBubble({ target: $("text"), currentTarget: row })).toBe(true);
    expect(isPortalBubble({ target: $("name"), currentTarget: row })).toBe(false);
    expect(isPortalBubble({ target: row, currentTarget: row })).toBe(false);
    expect(isPortalBubble({ target: null, currentTarget: row })).toBe(true);
  });

  it("图片和只包着一张图的缩略图按钮算图片；普通文字不算", () => {
    const { $ } = setup();
    expect(isImageTarget($("img"))).toBe(true);
    expect(isImageTarget($("thumb"))).toBe(true);
    expect(isImageTarget($("name"))).toBe(false);
  });

  it("消息上：portal、图片、输入框留给原生菜单，正文才弹我们的菜单", () => {
    const { $, row } = setup();
    for (const id of ["big", "img", "thumb", "field"]) {
      expect(keepsNativeContextMenu({ target: $(id), currentTarget: row })).toBe(true);
    }
    expect(keepsNativeContextMenu({ target: $("name"), currentTarget: row })).toBe(false);
  });
});
