import type { ChatMessage, Invocation } from "@superhive/protocol";
import { describe, expect, it } from "vitest";
import {
  canCancelInvocation,
  currentPausedInvocations,
  delegationLines,
  delegationSummary,
  invocationStatusLabel,
  isUpstreamInterrupted,
  waitingInvocationForQuestion,
} from "./invocations";

const now = new Date().toISOString();
const message = (id: string, seq: number, senderType: "human" | "agent") =>
  ({ id, seq, senderType }) as ChatMessage;
const blocked = (id: string, messageId: string, blockReason: Invocation["blockReason"]) =>
  ({
    id,
    messageId,
    status: "blocked",
    blockReason,
    agentName: "agent",
    attempts: 1,
    createdAt: now,
    updatedAt: now,
  }) as Invocation;

describe("currentPausedInvocations", () => {
  it("只提示人最后一次发言之后被拦下的调用", () => {
    const messages = [
      message("m1", 1, "agent"),
      message("m2", 2, "human"),
      message("m3", 3, "agent"),
    ];
    const paused = currentPausedInvocations(
      [
        blocked("old-hop", "m1", "hop_limit"),
        blocked("new-hop", "m3", "hop_limit"),
        blocked("new-turns", "m3", "consecutive_limit"),
        blocked("new-ping-pong", "m3", "ping_pong"),
        blocked("guest", "m3", "guest_approval"),
        { ...blocked("queued", "m3", undefined), status: "queued" },
      ],
      messages,
    );
    expect(paused.map((invocation) => invocation.id)).toEqual([
      "new-hop",
      "new-turns",
      "new-ping-pong",
    ]);
  });
});

describe("delegation view", () => {
  const base = {
    roomId: "general",
    agentId: "a",
    requesterName: "Alice",
    requesterType: "human" as const,
    attempts: 1,
    createdAt: now,
    updatedAt: now,
  };
  const planner = {
    ...base,
    id: "p",
    messageId: "m1",
    agentName: "planner",
    status: "running",
  } as Invocation;
  const worker = {
    ...base,
    id: "w",
    messageId: "m2",
    agentName: "worker",
    requesterName: "planner",
    requesterType: "agent",
    parentInvocationId: "p",
    continuation: "pending",
    status: "running",
  } as Invocation;
  const reviewer = {
    ...worker,
    id: "r",
    agentName: "reviewer",
    continuation: "delivered",
    status: "completed",
  } as Invocation;

  it("summarises upstream, receipts and open subtasks", () => {
    const all = [planner, worker, reviewer];
    expect(delegationSummary(planner, all)).toBe("派出 2 个子任务，1 个未结束");
    expect(delegationSummary(worker, all)).toBe("由 @planner 委派 · 结果待回执");
    expect(
      delegationSummary(
        { ...base, id: "x", messageId: "m", agentName: "x", status: "queued" } as Invocation,
        all,
      ),
    ).toBeUndefined();
  });

  it("marks an upstream that is not loaded instead of inventing it", () => {
    const lines = delegationLines(worker, [worker]);
    expect(lines?.upstream).toContain("不在当前已加载的记录里");
    expect(delegationLines(planner, [planner, worker])?.downstream).toEqual([
      "@worker · 进行中 · 结果待回执",
    ]);
  });
});

describe("waiting for a human answer", () => {
  const waiting = {
    id: "w1",
    messageId: "trigger",
    agentId: "agent-1",
    agentName: "helper",
    status: "waiting_human",
    attempts: 1,
    createdAt: now,
    updatedAt: now,
  } as Invocation;
  const question = {
    id: "q1",
    kind: "question",
    parentMessageId: "trigger",
    senderId: "agent-1",
  } as ChatMessage;

  it("找到提问对应的等待中调用，回答后或别人发的消息都不匹配", () => {
    expect(waitingInvocationForQuestion(question, [waiting])?.id).toBe("w1");
    expect(
      waitingInvocationForQuestion(question, [{ ...waiting, status: "completed" }]),
    ).toBeUndefined();
    expect(
      waitingInvocationForQuestion({ ...question, senderId: "other" }, [waiting]),
    ).toBeUndefined();
    expect(
      waitingInvocationForQuestion({ ...question, kind: undefined }, [waiting]),
    ).toBeUndefined();
  });

  it("显示为等你回答，并允许人放弃等待", () => {
    expect(invocationStatusLabel(waiting, true)).toBe("等你回答");
    expect(canCancelInvocation(waiting)).toBe(true);
  });

  it("运行回合结束不关闭待答入口，取消或失败后才关闭", () => {
    expect(waitingInvocationForQuestion(question, [{ ...waiting, finishedAt: now }])?.id).toBe(
      "w1",
    );
    for (const status of ["completed", "failed", "cancelled"] as const) {
      expect(
        waitingInvocationForQuestion(question, [{ ...waiting, status, finishedAt: now }]),
      ).toBeUndefined();
    }
  });
});

describe("isUpstreamInterrupted", () => {
  it("只把上游模型服务出错中断的失败当作可「继续」", () => {
    const failed = (detail: string) =>
      ({ id: "i", messageId: "m", status: "failed", detail, attempts: 1 }) as Invocation;
    expect(isUpstreamInterrupted(failed("上游模型服务出错：API Error: 429。点「继续」…"))).toBe(
      true,
    );
    expect(isUpstreamInterrupted(failed("连续失败 3 次：boom"))).toBe(false);
    expect(
      isUpstreamInterrupted({ ...failed("上游模型服务出错：x"), status: "running" } as Invocation),
    ).toBe(false);
  });
});
