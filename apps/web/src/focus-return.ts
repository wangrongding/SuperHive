/**
 * 弹窗、菜单关上后把焦点还给打开它的按钮。
 * 用鼠标或触屏关的，按钮不画焦点框、也不弹悬停提示（不然点完关闭，按钮上一直挂着一圈框）；
 * 用键盘关的（Esc、Tab 到关闭按钮再回车）照常画，键盘用户看得清焦点回到哪里。
 */
let lastInputWasKeyboard = false;

if (typeof window !== "undefined") {
  window.addEventListener("keydown", () => (lastInputWasKeyboard = true), true);
  window.addEventListener("pointerdown", () => (lastInputWasKeyboard = false), true);
}

export function returnFocus(element: HTMLElement | null | undefined) {
  element?.focus({ focusVisible: lastInputWasKeyboard } as FocusOptions);
}
