import { describe, expect, it } from "vitest";
import { cubicBezier, easeOutQuint, createFrameClock } from "./easing";

describe("cubicBezier", () => {
  it("端点固定为 0 和 1，越界值被夹紧", () => {
    const ease = cubicBezier(0.25, 0.1, 0.25, 1);
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(-0.5)).toBe(0);
    expect(ease(1.5)).toBe(1);
  });

  it("cubic-bezier(0,0,1,1) 近似线性", () => {
    const linear = cubicBezier(0, 0, 1, 1);
    for (const x of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      expect(linear(x)).toBeCloseTo(x, 3);
    }
  });

  it("easeOutQuint 单调递增且前段快后段慢", () => {
    let previous = 0;
    for (let i = 1; i <= 20; i += 1) {
      const value = easeOutQuint(i / 20);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
    expect(easeOutQuint(0.3)).toBeGreaterThan(0.6);
    expect(easeOutQuint(0.7)).toBeGreaterThan(0.9);
  });
});

describe("createFrameClock", () => {
  it("从第一帧开始计时，正常帧按实际间隔累计", () => {
    const clock = createFrameClock(32);
    expect(clock(1000)).toBe(0);
    expect(clock(1016)).toBe(16);
    expect(clock(1033)).toBe(33);
  });

  it("主线程卡住后恢复，单帧只推进上限，不会把卡住的时间一次补上", () => {
    const clock = createFrameClock(32);
    clock(1241);
    // 实测场景：一个 525ms 长任务之后的第一帧
    expect(clock(1781)).toBe(32);
    expect(clock(1789)).toBe(40);
  });

  it("时间倒退时不倒退进度", () => {
    const clock = createFrameClock(32);
    clock(100);
    expect(clock(90)).toBe(0);
  });
});
