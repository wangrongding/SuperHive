import { describe, expect, it } from "vitest";
import { cubicBezier, easeOutQuint } from "./easing";

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
