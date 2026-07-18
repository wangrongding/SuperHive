// 标准 CSS cubic-bezier(p1x, p1y, p2x, p2y) 求值器：
// 用牛顿迭代把进度 x 反解为参数 t，再映射到 y。与浏览器 transition-timing-function 行为一致。
export function cubicBezier(
  p1x: number,
  p1y: number,
  p2x: number,
  p2y: number,
): (x: number) => number {
  const cx = 3 * p1x;
  const bx = 3 * (p2x - p1x) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * p1y;
  const by = 3 * (p2y - p1y) - cy;
  const ay = 1 - cy - by;

  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const sampleDerivativeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;

  return (x: number): number => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i += 1) {
      const error = sampleX(t) - x;
      if (Math.abs(error) < 1e-6) break;
      const derivative = sampleDerivativeX(t);
      if (Math.abs(derivative) < 1e-6) break;
      t -= error / derivative;
    }
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    return sampleY(t);
  };
}

// easeOutQuint：起步迅速、收尾有绵长的减速尾巴，widely used 的「丝滑」曲线
export const easeOutQuint = cubicBezier(0.22, 1, 0.36, 1);

// easeInOutCubic：慢起步、中段提速、慢收尾，适合长距离滚动（起步柔和不撞主线程高峰）
export const easeInOutCubic = cubicBezier(0.65, 0, 0.35, 1);
