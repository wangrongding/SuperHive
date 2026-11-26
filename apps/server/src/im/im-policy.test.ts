import { describe, expect, it } from "vitest";
import type { ChatMessage, ImDeliveryLevel } from "@superhive/protocol";
import { decideImDelivery, type ImMessageContext } from "./im-policy.js";

const levels: ImDeliveryLevel[] = ["im", "mine", "agents", "all"];
const message: ChatMessage = {
  id: "message",
  roomId: "general",
  seq: 1,
  senderId: "helper",
  senderName: "helper",
  senderType: "agent",
  content: "更新",
  mentions: [],
  traceId: "trace",
  hopCount: 0,
  createdAt: "2026-11-26T00:00:00.000Z",
};
const context: ImMessageContext = {
  ownerId: "owner",
  mentionsOwner: false,
  ownersTask: false,
  fromIm: false,
  mentionsAgent: false,
  parentSenderType: undefined,
};

describe.each(levels)("IM 降噪：%s", (level) => {
  const connection = { roomId: "general", level, config: {} };
  const decide = (patch: Partial<ChatMessage>, facts: Partial<ImMessageContext> = {}) =>
    decideImDelivery(connection, { ...message, ...patch }, { ...context, ...facts });

  it.each(["human", "agent"] as const)("不推 %s 定时触发，即使提到房主或来自 IM", (senderType) => {
    expect(
      decide(
        { kind: "schedule", senderType },
        { mentionsOwner: true, ownersTask: true, fromIm: true },
      ),
    ).toBe("skip");
  });

  it("不回显房主自己发的消息，即使提到自己", () => {
    expect(decide({ senderType: "human", senderId: "owner" }, { mentionsOwner: true })).toBe(
      "skip",
    );
  });

  it.each(["delegation", "receipt"] as const)("内部 %s 不推，提到房主才立即推", (kind) => {
    expect(decide({ kind }, { ownersTask: true, fromIm: true })).toBe("skip");
    expect(decide({ kind }, { mentionsOwner: true })).toBe("now");
  });

  it("不是房主任务的进度不推，即使提到房主", () => {
    expect(decide({ kind: "progress" }, { mentionsOwner: true, fromIm: true })).toBe("skip");
    expect(decide({ kind: "progress" }, { ownersTask: true, fromIm: true })).toBe(
      level === "all" || level === "agents" ? "batch" : "now",
    );
    expect(decide({ kind: "progress" }, { ownersTask: true })).toBe(
      level === "im" ? "skip" : level === "mine" ? "now" : "batch",
    );
    expect(
      decide({ kind: "progress" }, { ownersTask: true, mentionsOwner: true, fromIm: true }),
    ).toBe("now");
  });

  it("Agent 互相回复不推，提到房主的回复立即推", () => {
    expect(decide({}, { mentionsAgent: true, ownersTask: true })).toBe("skip");
    expect(decide({}, { parentSenderType: "agent", fromIm: true })).toBe("skip");
    expect(decide({}, { mentionsOwner: true, mentionsAgent: true })).toBe("now");
  });

  it("房主提问及定时创建确认不受影响", () => {
    expect(decide({ kind: "question" }, { ownersTask: true, fromIm: true })).toBe("now");
    expect(decide({ content: "已创建定时任务" }, { mentionsOwner: true, fromIm: true })).toBe(
      "now",
    );
  });

  it("人类成员不是房主回显；普通人类消息仅 all 合并", () => {
    expect(decide({ senderType: "human", senderId: "guest" })).toBe(
      level === "all" ? "batch" : "skip",
    );
  });
});

describe("跨房间全部推送", () => {
  it.each([undefined, "false", "true"])("旧配置和未开启的配置默认只推相关：%s", (setting) => {
    const connection = {
      roomId: "general",
      level: "all" as const,
      config: setting === undefined ? {} : { crossRoomAll: setting },
    };
    const other = { ...message, roomId: "other" };
    expect(decideImDelivery(connection, other, context)).toBe(
      setting === "true" ? "batch" : "skip",
    );
    expect(decideImDelivery(connection, other, { ...context, mentionsOwner: true })).toBe("now");
    expect(
      decideImDelivery(
        connection,
        { ...other, kind: "schedule" },
        { ...context, mentionsOwner: true },
      ),
    ).toBe("skip");
    expect(decideImDelivery(connection, message, context)).toBe("batch");
  });

  it("开关不扩大其它档位，也不取消当前房间的提问即时推送", () => {
    expect(
      decideImDelivery(
        { roomId: "general", level: "mine", config: { crossRoomAll: "true" } },
        { ...message, roomId: "other" },
        context,
      ),
    ).toBe("skip");
    expect(
      decideImDelivery(
        { roomId: "general", level: "all", config: {} },
        { ...message, kind: "question" },
        context,
      ),
    ).toBe("now");
  });
});
