import { describe, expect, it } from "vitest";
import { expiresSoon, formatRemaining, parseInviteHash } from "./access-api";

describe("限时邀请的前端工具", () => {
  it("从地址栏解析房间与邀请令牌", () => {
    expect(parseInviteHash("#build?invite=hvi_abc")).toEqual({ roomId: "build", token: "hvi_abc" });
    expect(parseInviteHash("#build")).toEqual({ roomId: "build" });
    expect(parseInviteHash("")).toEqual({});
  });

  it("剩余时间按量级描述，不到 1 小时提醒", () => {
    const now = Date.parse("2026-10-30T00:00:00Z");
    const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
    expect(formatRemaining(null, now)).toBe("永久");
    expect(formatRemaining(at(-1), now)).toBe("已到期");
    expect(formatRemaining(at(30), now)).toBe("剩 30 分钟");
    expect(formatRemaining(at(90), now)).toBe("剩 1 小时 30 分");
    expect(formatRemaining(at(72 * 60), now)).toBe("剩 3 天");
    expect(expiresSoon(at(30), now)).toBe(true);
    expect(expiresSoon(at(120), now)).toBe(false);
    expect(expiresSoon(null, now)).toBe(false);
  });
});
