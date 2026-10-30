import type { Invocation, Participant } from "@ai-hive/protocol";
import { describe, expect, it } from "vitest";
import { agentRuntimeRows, needsAttention, orderByDelegation, plainPreview } from "./activity";

describe("plainPreview", () => {
  it("strips markdown markers for list previews", () => {
    expect(
      plainPreview(
        "好，按 **REST** 来做，字段用 `snake_case`：\n\n1. 登录返回 token\n> 只处理一种错误",
      ),
    ).toBe("好，按 REST 来做，字段用 snake_case： 登录返回 token 只处理一种错误");
    expect(plainPreview("看下\n```ts\nconst a = 1;\n```\n[文档](https://x.y)")).toBe(
      "看下 [代码] 文档",
    );
  });
});

describe("agentRuntimeRows", () => {
  const agent = (id: string, username: string, status: Participant["status"] = "online") =>
    ({ id, username, status, type: "agent" }) as Participant;
  const call = (
    id: string,
    agentId: string,
    status: Invocation["status"],
    updatedAt = "2026-01-01T00:00:00.000Z",
  ) => ({ id, agentId, status, updatedAt, messageId: `m-${id}` }) as Invocation;

  it("按需要处理、工作中、空闲、离线排序，并忽略已结束和人类成员", () => {
    const rows = agentRuntimeRows(
      [
        agent("a", "alpha"),
        agent("b", "beta"),
        agent("c", "gamma", "offline"),
        agent("d", "delta"),
        { id: "h", username: "rd", status: "online", type: "human" } as Participant,
      ],
      [
        call("1", "a", "running"),
        call("2", "b", "failed"),
        call("3", "b", "running"),
        call("4", "c", "queued"),
        call("5", "d", "completed"),
      ],
    );
    expect(rows.map((row) => [row.participant.username, row.state])).toEqual([
      ["beta", "attention"],
      ["alpha", "working"],
      ["delta", "idle"],
      ["gamma", "offline"],
    ]);
    expect(rows[0]).toMatchObject({ attention: 1, inFlight: 1, current: { id: "2" } });
    expect(rows[2]?.current).toBeUndefined();
  });

  it("等你回答排在最前，当前任务指向提问的调用", () => {
    const rows = agentRuntimeRows(
      [agent("a", "alpha"), agent("b", "beta")],
      [call("1", "a", "failed"), call("2", "b", "waiting_human"), call("3", "b", "failed")],
    );
    expect(rows.map((row) => [row.participant.username, row.state])).toEqual([
      ["beta", "waiting"],
      ["alpha", "attention"],
    ]);
    expect(rows[0]?.current?.id).toBe("2");
  });

  it("只有排队中的调用时仍算空闲，不冒充工作中", () => {
    const [row] = agentRuntimeRows([agent("a", "alpha")], [call("1", "a", "queued")]);
    expect(row).toMatchObject({ state: "idle", inFlight: 1 });
  });
});

describe("orderByDelegation", () => {
  const call = (id: string, parentInvocationId?: string) =>
    ({ id, ...(parentInvocationId ? { parentInvocationId } : {}) }) as Invocation;

  it("子任务紧跟上游并缩进，上游不在列表里的当作根", () => {
    const ordered = orderByDelegation([
      call("child", "root"),
      call("orphan", "missing"),
      call("root"),
      call("grandchild", "child"),
    ]);
    expect(ordered.map(({ invocation, depth }) => [invocation.id, depth])).toEqual([
      ["orphan", 0],
      ["root", 0],
      ["child", 1],
      ["grandchild", 2],
    ]);
  });

  it("委派关系成环时不死循环且每条只出现一次", () => {
    const ordered = orderByDelegation([call("a", "b"), call("b", "a")]);
    expect(ordered.map(({ invocation }) => invocation.id).sort()).toEqual(["a", "b"]);
  });
});

describe("needsAttention", () => {
  it("收起的异常不算需要处理；等你回答始终算", () => {
    const base = { status: "timed_out" } as Invocation;
    expect(needsAttention(base)).toBe(true);
    const resolution = { kind: "dismissed" as const, at: "2026-10-30T10:00:00.000Z" };
    expect(needsAttention({ ...base, resolution })).toBe(false);
    expect(needsAttention({ ...base, status: "waiting_human", resolution })).toBe(true);
  });
});
