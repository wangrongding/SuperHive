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
});
