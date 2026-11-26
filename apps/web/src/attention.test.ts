import type { ChatMessage, Invocation } from "@superhive/protocol";
import { describe, expect, it } from "vitest";
import {
  attentionByRoom,
  attentionKind,
  attentionTarget,
  attentionTransition,
  collectAttention,
  questionOf,
  concernsMe,
  nextAttention,
  pinAttentionRooms,
  retryConsequence,
} from "./attention";

const call = (id: string, status: Invocation["status"], extra: Partial<Invocation> = {}) =>
  ({
    id,
    roomId: "build",
    messageId: `m-${id}`,
    agentId: "a",
    agentName: "rd-claude",
    requesterName: "rd",
    requesterType: "human",
    status,
    attempts: 1,
    createdAt: "2026-11-06T00:00:00.000Z",
    updatedAt: "2026-11-06T00:00:00.000Z",
    ...extra,
  }) as Invocation;

describe("attention targets", () => {
  it("uses the newest live question from the same agent, parent and room", () => {
    const invocation = call("target", "waiting_human");
    const question = (seq: number, extra: Partial<ChatMessage> = {}) =>
      ({
        id: `q-${seq}`,
        seq,
        roomId: invocation.roomId,
        senderId: invocation.agentId,
        parentMessageId: invocation.messageId,
        kind: "question",
        ...extra,
      }) as ChatMessage;
    const latest = question(20);
    const messages = [
      latest,
      question(30, { deletedAt: "now" }),
      question(40, { senderId: "other" }),
      question(50, { roomId: "other" }),
      question(60, { parentMessageId: "other" }),
      question(10),
    ];
    expect(questionOf(invocation, messages)).toBe(latest);
    expect(collectAttention([invocation], [], messages)[0]).toMatchObject({
      messageId: latest.id,
      messageSeq: 20,
    });
    expect(attentionTarget(invocation, [])).toMatchObject({
      messageId: invocation.messageId,
      invocation,
    });
  });

  it("keeps approval and decision actions on the trigger and unseen on the result", () => {
    for (const status of ["blocked", "failed", "timed_out"] as const) {
      const invocation = call(status, status, { replyMessageId: "result" });
      expect(attentionTarget(invocation, []).messageId).toBe(invocation.messageId);
    }
    const completed = call("done", "completed", { replyMessageId: "result" });
    expect(collectAttention([], [completed])[0]!.messageId).toBe("result");
  });
});

describe("attentionKind", () => {
  it("按状态归类，忽略或被取代的不算，等人回答始终算", () => {
    expect(attentionKind(call("1", "waiting_human"))).toBe("question");
    expect(attentionKind(call("2", "blocked"))).toBe("approval");
    expect(attentionKind(call("3", "failed"))).toBe("failed");
    expect(attentionKind(call("4", "timed_out"))).toBe("unknown");
    expect(attentionKind(call("5", "running"))).toBeUndefined();
    expect(attentionKind(call("6", "completed"))).toBeUndefined();
    const resolution = { kind: "dismissed" as const, at: "2026-11-06T00:00:00.000Z" };
    expect(attentionKind(call("7", "failed", { resolution }))).toBeUndefined();
  });

  it("中途中断、Agent 自己报的结果未知和上游出错用完次数，归为「等你决定」", () => {
    expect(
      attentionKind(call("1", "timed_out", { detailText: { key: "bridge.crashedMidTurn" } })),
    ).toBe("decide");
    expect(
      attentionKind(call("2", "failed", { detailText: { key: "bridge.upstreamFailed" } })),
    ).toBe("decide");
    // 服务端超时判的结果未知，Agent 可能还在跑：仍是结果未知，不能直接继续
    expect(attentionKind(call("3", "timed_out", { detailText: { key: "invocation.stale" } }))).toBe(
      "unknown",
    );
  });
});

describe("attentionTransition", () => {
  it("只在新进入需要提醒的状态时返回，同状态的重复推送不算", () => {
    expect(attentionTransition(call("1", "running"), call("1", "failed"))).toBe("failed");
    expect(attentionTransition(undefined, call("1", "waiting_human"))).toBe("question");
    expect(attentionTransition(call("1", "failed"), call("1", "failed"))).toBeUndefined();
    // 重试后又失败：算新的一次
    expect(attentionTransition(call("1", "failed"), call("1", "failed", { attempts: 2 }))).toBe(
      "failed",
    );
    expect(attentionTransition(call("1", "running"), call("1", "completed"))).toBe("unseen");
    // 快照里第一次见到已完成的调用不提醒：不知道它是不是刚完成
    expect(attentionTransition(undefined, call("1", "completed"))).toBeUndefined();
    expect(attentionTransition(call("1", "completed"), call("1", "completed"))).toBeUndefined();
  });
});

describe("concernsMe", () => {
  it("我发起的、或我是房主时被拦下的才提醒", () => {
    const me = { username: "RD", participantIds: new Set(["p-rd"]) };
    expect(concernsMe(call("1", "failed", { requesterId: "p-rd" }), me)).toBe(true);
    expect(concernsMe(call("1", "failed", { requesterId: "p-other" }), me)).toBe(false);
    // 旧数据没有 requesterId：按名字
    expect(concernsMe(call("1", "failed"), { username: "rd" })).toBe(true);
    expect(concernsMe(call("1", "failed", { requesterName: "ddd" }), { username: "rd" })).toBe(
      false,
    );
    // Agent 之间委派的不打扰人
    expect(
      concernsMe(call("1", "failed", { requesterType: "agent", requesterName: "rd" }), me),
    ).toBe(false);
    const guestCall = call("1", "blocked", { requesterName: "ddd" });
    expect(concernsMe(guestCall, { username: "rd" })).toBe(false);
    expect(concernsMe(guestCall, { username: "rd", isOwner: true })).toBe(true);
  });
});

describe("collectAttention / nextAttention / attentionByRoom", () => {
  const items = collectAttention(
    [
      call("u", "timed_out", { updatedAt: "2026-11-06T00:00:01.000Z" }),
      call("q2", "waiting_human", { updatedAt: "2026-11-06T00:00:05.000Z", roomId: "z" }),
      call("q1", "waiting_human", { updatedAt: "2026-11-06T00:00:02.000Z" }),
      call("r", "running"),
    ],
    [call("d", "completed", { finishedAt: "2026-11-06T00:00:00.000Z", roomId: "z" })],
  );

  it("按紧急程度、再按等待时间排序，不含进行中的", () => {
    expect(items.map((item) => item.invocation.id)).toEqual(["q1", "q2", "u", "d"]);
    expect(items.map((item) => item.kind)).toEqual(["question", "question", "unknown", "unseen"]);
  });

  it("下一个：取当前之后的一条，到尾回到第一条", () => {
    expect(nextAttention(items)?.invocation.id).toBe("q1");
    expect(nextAttention(items, "q2")?.invocation.id).toBe("u");
    expect(nextAttention(items, "d")?.invocation.id).toBe("q1");
    expect(nextAttention([], "d")).toBeUndefined();
  });

  it("按房间汇总条数和最急的一类", () => {
    const byRoom = attentionByRoom(items);
    expect(byRoom.get("build")).toEqual({ count: 2, top: "question" });
    expect(byRoom.get("z")).toEqual({ count: 2, top: "question" });
  });

  it("置顶需要处理的房间，组内保持原顺序", () => {
    const rooms = [{ id: "a" }, { id: "z" }, { id: "b" }, { id: "build" }];
    expect(pinAttentionRooms(rooms, attentionByRoom(items)).map((room) => room.id)).toEqual([
      "z",
      "build",
      "a",
      "b",
    ]);
  });
});

describe("retryConsequence", () => {
  const text = (key: string, params?: Record<string, unknown>) => ({
    detailText: { key, ...(params ? { params } : {}) },
  });
  it.each([
    ["failed", text("bridge.transientFailed"), "还没开始执行，重试安全"],
    ["failed", text("bridge.worktreeBusy"), "还没开始执行，重试安全"],
    ["timed_out", text("invocation.unacknowledged"), "还没开始执行，继续安全"],
    ["timed_out", text("bridge.uncertain"), "可能已执行过一部分，继续会先核对已做的，不从头重做"],
    [
      "timed_out",
      text("bridge.crashedIrreversible"),
      "可能已执行过一部分，继续会先核对已做的，不从头重做",
    ],
    ["failed", text("bridge.upstreamFailed"), "可能已执行过一部分，继续会先核对已做的，不从头重做"],
    [
      "failed",
      text("bridge.worktreeCheckBeforeContinue"),
      "可能已执行过一部分，重试会重新执行；先核对已做的再点",
    ],
    [
      "failed",
      text("bridge.sessionInvalid", { why: { key: "bridge.sessionExecuted" } }),
      "已执行过工具，重试会开新会话从头做；先核对已做的再点",
    ],
    [
      "failed",
      text("bridge.sessionInvalid", { why: { key: "bridge.sessionRetried" } }),
      "还没开始执行，重试安全",
    ],
    ["failed", text("bridge.unsafe"), "已拒绝，没有往下执行；原因不解决，重试还会被拒"],
    [
      "failed",
      text("bridge.modelFailed"),
      "还没执行完；用原模型重试还会失败，换个模型重试只对这一次生效",
    ],
    ["failed", text("bridge.failedRepeatedly"), "原因不明，重试会从头执行这一轮"],
    // 旧版 Bridge 只有中文说明
    ["failed", {}, "原因不明，重试会从头执行这一轮"],
    // 没有「重试 / 继续」可点的不说
    ["timed_out", text("bridge.alreadyEnded"), undefined],
    ["completed", text("bridge.unsafe"), undefined],
    ["failed", { ...text("bridge.unsafe"), resolution: { kind: "dismissed" } }, undefined],
  ] as Array<[Invocation["status"], Partial<Invocation>, string | undefined]>)(
    "%s %j → %s",
    (status, extra, expected) => {
      expect(retryConsequence(call("x", status, extra))).toBe(expected);
    },
  );
});
