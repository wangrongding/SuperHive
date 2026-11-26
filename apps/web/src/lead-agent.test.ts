import { describe, expect, it } from "vitest";
import type { Participant } from "@superhive/protocol";
import { AUTO_LEAD, isAutoLead, leadChoiceOf, leadPatchOf, suggestLead } from "./lead-agent";
import { buildTimeline } from "./timeline";

function member(username: string, extra: Partial<Participant> = {}): Participant {
  return {
    id: username,
    roomId: "r",
    username,
    type: "agent",
    status: "online",
    joinedAt: "2026-11-26T06:00:00.000Z",
    lastSeenAt: "2026-11-26T06:00:00.000Z",
    ...extra,
  } as Participant;
}

describe("lead agent choices", () => {
  it("房间设置的初始选项：手动设的是名字、手动取消的是不设置，其余是自动", () => {
    expect(leadChoiceOf({ leadAgent: "a", leadMode: "manual" })).toBe("a");
    expect(leadChoiceOf({ leadMode: "manual" })).toBe("");
    expect(leadChoiceOf({ leadAgent: "a", leadMode: "auto" })).toBe(AUTO_LEAD);
    expect(leadChoiceOf({})).toBe(AUTO_LEAD);
    expect(isAutoLead({ leadAgent: "a", leadMode: "auto" })).toBe(true);
    expect(isAutoLead({ leadAgent: "a", leadMode: "manual" })).toBe(false);
    expect(isAutoLead({ leadMode: "auto" })).toBe(false);
  });

  it("保存时只发改了的：改回自动发 leadMode，选人或不设置发 leadAgent", () => {
    const auto = { leadAgent: "a", leadMode: "auto" as const };
    expect(leadPatchOf(auto, AUTO_LEAD)).toEqual({});
    expect(leadPatchOf(auto, "a")).toEqual({ leadAgent: "a" });
    expect(leadPatchOf(auto, "")).toEqual({ leadAgent: null });
    expect(leadPatchOf({ leadMode: "manual" }, AUTO_LEAD)).toEqual({ leadMode: "auto" });
  });

  it("建议人选：只看在线的 Agent，本机优先，再按加入先后", () => {
    const people = [
      member("human", { type: "human" }),
      member("off", { status: "offline" }),
      member("b", { joinedAt: "2026-11-26T05:00:00.000Z" }),
      member("c", { joinedAt: "2026-11-26T07:00:00.000Z" }),
    ];
    expect(suggestLead(people, [])?.username).toBe("b");
    expect(suggestLead(people, ["C", "off"])?.username).toBe("c");
    expect(suggestLead([member("off", { status: "offline" })], [])).toBeUndefined();
  });

  it("房间提示不和同一成员前后的消息合成一组", () => {
    const at = (seconds: number) => new Date(Date.UTC(2026, 10, 26, 6, 0, seconds)).toISOString();
    const base = { roomId: "r", senderId: "a", senderName: "a", senderType: "agent" } as const;
    const timeline = buildTimeline([
      { ...base, id: "1", seq: 1, content: "x", createdAt: at(0) },
      { ...base, id: "2", seq: 2, content: "notice", kind: "notice", createdAt: at(1) },
      { ...base, id: "3", seq: 3, content: "y", createdAt: at(2) },
    ] as never);
    expect(timeline.map((entry) => entry.grouped)).toEqual([false, false, false]);
  });
});
