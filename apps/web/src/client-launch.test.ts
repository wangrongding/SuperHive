// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { launchClient } from "./client-launch";

describe("launchClient", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("用隐藏 iframe 打开 superhive:// 链接，不动当前页，到时自己移除", () => {
    vi.useFakeTimers();
    const before = window.location.href;
    launchClient("superhive://join?server=https%3A%2F%2Fa.example");
    const frame = document.querySelector("iframe");
    expect(frame?.getAttribute("src")).toBe("superhive://join?server=https%3A%2F%2Fa.example");
    expect(frame?.style.display).toBe("none");
    expect(window.location.href).toBe(before);
    vi.advanceTimersByTime(2_000);
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("页面一直在前台没失焦：当没唤起，提示用网页加入", () => {
    vi.useFakeTimers();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const onMissed = vi.fn();
    launchClient("superhive://join", { onMissed });
    vi.advanceTimersByTime(2_000);
    expect(onMissed).toHaveBeenCalledTimes(1);
  });

  it("页面失焦（浏览器弹了确认框或切到了客户端）：不提示", () => {
    vi.useFakeTimers();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const onMissed = vi.fn();
    launchClient("superhive://join", { onMissed });
    window.dispatchEvent(new Event("blur"));
    vi.advanceTimersByTime(2_000);
    expect(onMissed).not.toHaveBeenCalled();
  });
});
