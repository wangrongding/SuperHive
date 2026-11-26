// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DevStatusBanner } from "./dev-status-banner";
import { parseDevStatus, shouldReload, type DevStatus } from "./dev-status";

const ready = (generation: number): DevStatus => ({
  generation,
  state: "ready",
  updatedAt: "2026-10-29T08:00:00.000Z",
});

describe("dev status contract", () => {
  it("只接受合法状态", () => {
    expect(parseDevStatus(null)).toBeUndefined();
    expect(parseDevStatus({ generation: 1, state: "unknown" })).toBeUndefined();
    expect(parseDevStatus({ generation: "1", state: "ready" })).toBeUndefined();
    expect(
      parseDevStatus({ generation: 2, state: "failed", error: "boom", changedFiles: ["a", 1] }),
    ).toEqual({
      generation: 2,
      state: "failed",
      updatedAt: "",
      changedFiles: ["a"],
      error: "boom",
    });
  });

  it("只有基准之后的新代次更新成功才刷新", () => {
    expect(shouldReload(undefined, ready(3))).toBe(false);
    expect(shouldReload(3, ready(3))).toBe(false);
    expect(shouldReload(3, { ...ready(4), state: "building" })).toBe(false);
    expect(shouldReload(3, { ...ready(4), state: "failed" })).toBe(false);
    expect(shouldReload(3, ready(4))).toBe(true);
    expect(shouldReload(4, ready(3))).toBe(true);
  });

  it("保留自动恢复字段，忽略不可信的非法计数", () => {
    expect(
      parseDevStatus({ ...ready(3), state: "restarting", restartAttempt: 2, restartDelayMs: 2000 }),
    ).toMatchObject({ restartAttempt: 2, restartDelayMs: 2000 });
    expect(
      parseDevStatus({ ...ready(3), restartAttempt: -1, restartDelayMs: "2000" }),
    ).not.toHaveProperty("restartAttempt");
  });
});

describe("DevStatusBanner", () => {
  const respond = (value: unknown) =>
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(value)));

  beforeEach(() => sessionStorage.clear());
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("没有 supervisor 时不渲染", async () => {
    respond(null);
    const { container } = render(<DevStatusBanner />);
    await act(async () => {});
    expect(container.textContent).toBe("");
  });

  it("显示失败原因与触发文件", async () => {
    respond({
      generation: 5,
      state: "failed",
      error: "TS2345: bad",
      changedFiles: ["apps/server/src/app.ts"],
    });
    render(<DevStatusBanner />);
    expect(await screen.findByText("更新失败，修正后会自动重试")).toBeTruthy();
    expect(screen.getByText("TS2345: bad")).toBeTruthy();
    expect(screen.getByText(/代次 5 · apps\/server\/src\/app.ts/)).toBeTruthy();
  });

  it("自动恢复显示重启次数，崩溃保护显示已经停止", async () => {
    respond({ ...ready(5), state: "restarting", restartAttempt: 3 });
    const view = render(<DevStatusBanner />);
    expect(await screen.findByText("Server 意外退出，正在自动重启（第 3 次）")).toBeTruthy();
    view.unmount();
    respond({ ...ready(5), state: "failed", restartStopped: true, error: "60 秒内失败 5 次" });
    render(<DevStatusBanner />);
    expect(await screen.findByText("Server 反复崩溃，已停止自动重启")).toBeTruthy();
    expect(screen.getByText("60 秒内失败 5 次")).toBeTruthy();
  });

  it("刷新后短暂提示已运行最新改动", async () => {
    sessionStorage.setItem("hive-dev-reloaded-generation", "7");
    respond(ready(7));
    render(<DevStatusBanner />);
    expect(await screen.findByText("已运行最新改动")).toBeTruthy();
    expect(sessionStorage.getItem("hive-dev-reloaded-generation")).toBeNull();
  });

  it("首次加载的就绪状态不提示", async () => {
    respond(ready(7));
    const { container } = render(<DevStatusBanner />);
    await act(async () => {});
    expect(container.textContent).toBe("");
  });
});
