// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { LOADING_COPY_MIN_MS, LOADING_SLOW_MS, mountLoadingStatus } from "./loading-status";
import { RoomLoading } from "./room-loading";
import { setLocalePreference } from "./i18n";

function mount() {
  const root = document.createElement("div");
  root.innerHTML =
    '<div role="status" aria-live="polite"><p data-loading-title></p><p data-loading-hint></p></div><p data-loading-help><a href="">Reload</a></p>';
  document.body.append(root);
  const controller = mountLoadingStatus(root, { phase: "connecting" });
  return {
    root,
    controller,
    title: root.querySelector("[data-loading-title]")!,
    hint: root.querySelector("[data-loading-hint]")!,
    help: root.querySelector<HTMLElement>("[data-loading-help]")!,
  };
}

describe("loading status", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setLocalePreference("zh-CN");
    vi.spyOn(Math, "random").mockReturnValue(0);
  });
  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    setLocalePreference("zh-CN");
  });

  it("shows real phases immediately, keeps each hint at least 1.5 seconds and never invents progress", () => {
    const { controller, title, hint } = mount();
    expect(title.textContent).toBe("连接 Hive");
    expect(hint.textContent).toBe("正在连接服务器…");
    controller.update({ phase: "joining" });
    expect(title.textContent).toBe("准备房间");
    vi.advanceTimersByTime(LOADING_COPY_MIN_MS - 1);
    expect(hint.textContent).toBe("正在连接服务器…");
    vi.advanceTimersByTime(1);
    expect(hint.textContent).toBe("正在进入房间…");
    controller.update({ phase: "messages" });
    vi.advanceTimersByTime(LOADING_COPY_MIN_MS - 1);
    expect(hint.textContent).toBe("正在进入房间…");
    vi.advanceTimersByTime(1);
    expect(hint.textContent).toBe("正在载入最近的消息…");
    controller.destroy();
  });

  it("keeps its random choice stable for a phase", () => {
    const { controller, hint } = mount();
    const original = hint.textContent;
    vi.mocked(Math.random).mockReturnValue(0.99);
    controller.update({ phase: "connecting" });
    vi.advanceTimersByTime(LOADING_COPY_MIN_MS);
    expect(hint.textContent).toBe(original);
    controller.destroy();
  });

  it("replaces the joke with a specific status and reload after four seconds", () => {
    const { controller, hint, help } = mount();
    controller.update({ phase: "messages" });
    vi.advanceTimersByTime(LOADING_SLOW_MS - 1);
    expect(help.hidden).toBe(true);
    vi.advanceTimersByTime(1);
    expect(hint.textContent).toBe("已连接，正在等待房间消息；暂时还没有收到消息快照。");
    expect(help.hidden).toBe(false);
    expect(help.querySelector("a")?.textContent).toBe("重新加载");
    controller.destroy();
  });

  it("shows errors immediately, stops logo motion, distinguishes actual retries and can recover", () => {
    const { root, controller, title, hint, help } = mount();
    controller.update({ phase: "joining", error: "Server unavailable", retrying: true });
    expect(root.dataset.failed).toBe("true");
    expect(title.textContent).toBe("连接中断，正在重试");
    expect(hint.textContent).toBe("Server unavailable");
    expect(help.hidden).toBe(false);
    controller.update({ phase: "connecting", error: "Timed out" });
    expect(title.textContent).toBe("暂时无法载入 Hive");
    controller.update({ phase: "messages" });
    vi.advanceTimersByTime(LOADING_COPY_MIN_MS);
    expect(root.dataset.failed).toBe("false");
    expect(title.textContent).toBe("载入房间消息");
    controller.destroy();
  });

  it("uses the English catalog for copy, slow status, errors and reload", () => {
    setLocalePreference("en");
    const { controller, title, hint, help } = mount();
    expect(title.textContent).toBe("Connecting to Hive");
    expect(hint.textContent).toBe("Connecting to the server…");
    controller.update({ phase: "joining" });
    vi.advanceTimersByTime(LOADING_SLOW_MS);
    expect(title.textContent).toBe("Preparing the room");
    expect(hint.textContent).toContain("Establishing the room connection");
    expect(help.querySelector("a")?.textContent).toBe("Reload");
    controller.update({ phase: "joining", error: "Network error", retrying: true });
    expect(title.textContent).toBe("Connection interrupted, retrying");
    controller.destroy();
  });

  it("does not take focus and cancels timers when the loading view is removed", () => {
    const button = document.createElement("button");
    document.body.append(button);
    button.focus();
    const { controller, hint } = mount();
    controller.update({ phase: "messages" });
    const original = hint.textContent;
    controller.destroy();
    vi.advanceTimersByTime(20_000);
    expect(hint.textContent).toBe(original);
    expect(document.activeElement).toBe(button);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up the room component controller on unmount", () => {
    const view = render(createElement(RoomLoading, { phase: "messages" }));
    expect(view.container.querySelector('[aria-live="polite"]')).toBeTruthy();
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the covered room loader out of the accessibility tree and tab order", () => {
    const splash = document.createElement("div");
    splash.id = "boot-splash";
    document.body.append(splash);
    const view = render(createElement(RoomLoading, { phase: "messages" }));
    const root = view.container.querySelector(".room-loading")!;
    expect(root.getAttribute("aria-hidden")).toBe("true");
    expect(root.hasAttribute("inert")).toBe(true);
    view.unmount();
  });
});
