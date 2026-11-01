import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { IM_TICKET_TTL_MS, OwnerDevices, PAIR_TICKET_TTL_MS } from "./owner-devices.js";

function setup() {
  let now = Date.parse("2026-11-01T10:00:00.000Z");
  const devices = new OwnerDevices(new Database(":memory:"), {
    secret: randomBytes(32),
    now: () => now,
  });
  return { devices, advance: (ms: number) => (now += ms) };
}

describe("房主在其他设备上登录", () => {
  it("配对票只能用一次、5 分钟后失效；换到的设备令牌可以单独退出", () => {
    const { devices, advance } = setup();
    const { ticket } = devices.createPairTicket();
    const login = devices.redeem(ticket, "iPhone · Safari", () => true);
    expect(login?.token).toMatch(/^hod_/);
    expect(login?.device).toMatchObject({ name: "iPhone · Safari", source: "pair" });
    expect(devices.redeem(ticket, "again", () => true)).toBeUndefined();
    expect(devices.resolve(login!.token)).toBe(login!.device.id);

    const late = devices.createPairTicket().ticket;
    advance(PAIR_TICKET_TTL_MS + 1);
    expect(devices.redeem(late, "x", () => true)).toBeUndefined();

    expect(devices.list()).toHaveLength(1);
    expect(devices.revoke(login!.device.id)).toBe(true);
    expect(devices.resolve(login!.token)).toBeUndefined();
    expect(devices.list()).toHaveLength(0);
  });

  it("飞书票 24 小时内可重复使用，绑定连接；篡改、过期、连接已断开都无效", () => {
    const { devices, advance } = setup();
    const ticket = devices.createImTicket("conn-1");
    const valid = (id: string) => id === "conn-1";
    expect(devices.redeem(ticket, "飞书", valid)?.device.source).toBe("im");
    expect(devices.redeem(ticket, "飞书 2", valid)).toBeDefined();
    expect(devices.redeem(ticket, "飞书", () => false)).toBeUndefined();
    const forged = ticket.replace(/.$/, (char) => (char === "A" ? "B" : "A"));
    expect(devices.redeem(forged, "x", valid)).toBeUndefined();
    const other = devices.createImTicket("conn-2");
    expect(devices.redeem(other, "x", valid)).toBeUndefined();
    advance(IM_TICKET_TTL_MS + 1);
    expect(devices.redeem(ticket, "x", valid)).toBeUndefined();
    expect(devices.redeem("hod_not-a-ticket", "x", valid)).toBeUndefined();
  });

  it("退出一台经飞书登录的设备后，这个连接之前发出的票全部作废，新发的票照常可用", () => {
    const { devices, advance } = setup();
    const valid = () => true;
    const ticket = devices.createImTicket("conn-1");
    const other = devices.createImTicket("conn-2");
    const login = devices.redeem(ticket, "iPhone · 飞书", valid)!;
    advance(1_000);
    expect(devices.revoke(login.device.id)).toBe(true);
    expect(devices.redeem(ticket, "again", valid)).toBeUndefined();
    // 别的连接不受影响
    expect(devices.redeem(other, "x", valid)).toBeDefined();
    advance(1_000);
    expect(devices.redeem(devices.createImTicket("conn-1"), "new", valid)).toBeDefined();
  });
});
