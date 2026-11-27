import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NOTICE_MS,
  collapseUpdateCard,
  dismissUpdateNotice,
  expandUpdateCard,
  registerNpmUpdateCheck,
  resetUpdateCenter,
  showUpdateNotice,
  updateCenter,
  updateCheckPending,
} from "./update-center";

afterEach(() => {
  vi.useRealTimers();
  resetUpdateCenter();
});

describe("update center", () => {
  it("检查中的提示一直在，结果几秒后自己消失；自动消失不会关掉后来的提示", () => {
    vi.useFakeTimers();
    showUpdateNotice("pending", "正在检查更新…");
    expect(updateCheckPending()).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(updateCenter().notice?.tone).toBe("pending");
    const first = showUpdateNotice("ok", "已是最新版本 0.4.9");
    vi.advanceTimersByTime(NOTICE_MS.ok - 1);
    expect(updateCenter().notice?.id).toBe(first);
    const second = showUpdateNotice("danger", "没能检查更新");
    vi.advanceTimersByTime(NOTICE_MS.ok);
    expect(updateCenter().notice?.id).toBe(second);
    dismissUpdateNotice(first);
    expect(updateCenter().notice?.id).toBe(second);
    vi.advanceTimersByTime(NOTICE_MS.danger);
    expect(updateCenter().notice).toBeUndefined();
  });

  it("进度卡片收起 / 展开；网页版检查只认最后注册的那一个", () => {
    collapseUpdateCard();
    expect(updateCenter().cardCollapsed).toBe(true);
    expandUpdateCard();
    expect(updateCenter().cardCollapsed).toBe(false);
    const a = vi.fn(async () => undefined);
    const b = vi.fn(async () => undefined);
    const offA = registerNpmUpdateCheck(a);
    const offB = registerNpmUpdateCheck(b);
    offA();
    expect(updateCenter().npmCheck).toBe(b);
    offB();
    expect(updateCenter().npmCheck).toBeUndefined();
  });
});
