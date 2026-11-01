import { afterEach, describe, expect, it, vi } from "vitest";
import { watchSupervisor } from "./run.js";

describe("watchSupervisor", () => {
  afterEach(() => vi.useRealTimers());

  it("does nothing without a valid supervisor pid", () => {
    expect(watchSupervisor(undefined, () => undefined)).toBeUndefined();
    expect(watchSupervisor("abc", () => undefined)).toBeUndefined();
    expect(watchSupervisor("0", () => undefined)).toBeUndefined();
  });

  it("calls back once when the Hive Server that started the agent is gone", () => {
    vi.useFakeTimers();
    let alive = true;
    const onGone = vi.fn();
    watchSupervisor("4242", onGone, { intervalMs: 100, isAlive: () => alive });

    vi.advanceTimersByTime(300);
    expect(onGone).not.toHaveBeenCalled();
    alive = false;
    vi.advanceTimersByTime(100);
    vi.advanceTimersByTime(500);
    expect(onGone).toHaveBeenCalledTimes(1);
  });

  it("treats EPERM as alive", () => {
    vi.useFakeTimers();
    const onGone = vi.fn();
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("not permitted"), { code: "EPERM" });
    });
    watchSupervisor("4242", onGone, { intervalMs: 100 });
    vi.advanceTimersByTime(300);
    expect(onGone).not.toHaveBeenCalled();
    kill.mockRestore();
  });

  it("waits for a successor Hive Server instead of exiting at once", async () => {
    vi.useFakeTimers();
    let clock = 0;
    const alive = new Set([4242]);
    let successor: number | undefined;
    const onGone = vi.fn();
    watchSupervisor("4242", onGone, {
      intervalMs: 100,
      isAlive: (pid) => alive.has(pid),
      graceMs: 1_000,
      now: () => clock,
      findSuccessor: async () => successor,
    });
    alive.delete(4242);
    clock = 100;
    await vi.advanceTimersByTimeAsync(100);
    expect(onGone).not.toHaveBeenCalled();
    // 新 Server 起来了：改为看护它
    successor = 5151;
    alive.add(5151);
    clock = 300;
    await vi.advanceTimersByTimeAsync(200);
    clock = 5_000;
    await vi.advanceTimersByTimeAsync(500);
    expect(onGone).not.toHaveBeenCalled();
    // 新 Server 也走了，且宽限期内没有再出现接管者：退出
    alive.delete(5151);
    successor = undefined;
    await vi.advanceTimersByTimeAsync(100);
    clock = 7_000;
    await vi.advanceTimersByTimeAsync(100);
    expect(onGone).toHaveBeenCalledTimes(1);
  });
});
