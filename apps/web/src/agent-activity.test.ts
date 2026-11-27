import { describe, expect, it } from "vitest";
import type { Invocation, Participant } from "@superhive/protocol";
import { agentActivity } from "./agent-activity";

const agent = (
  id: string,
  username: string,
  status: Participant["status"] = "online",
): Participant => ({
  id,
  roomId: "general",
  username,
  type: "agent",
  status,
  joinedAt: "2026-10-31T00:00:00.000Z",
  lastSeenAt: "2026-10-31T00:00:00.000Z",
});
const invocation = (
  agentId: string,
  status: Invocation["status"],
  extra: Partial<Invocation> = {},
): Invocation => ({
  id: `${agentId}-${status}`,
  roomId: "general",
  messageId: `m-${agentId}-${status}`,
  agentId,
  agentName: agentId,
  requesterName: "rd",
  requesterType: "human",
  status,
  attempts: 1,
  createdAt: "2026-10-31T00:00:00.000Z",
  updatedAt: "2026-10-31T00:00:00.000Z",
  ...extra,
});

describe("底部的谁在干活", () => {
  it("每个 Agent 一行，等你回答排最前；执行中显示进展，只是忙碌的标正在思考", () => {
    const rows = agentActivity(
      [
        agent("a", "rd-codex", "busy"),
        agent("b", "rd-claude"),
        agent("c", "rd-omp", "busy"),
        agent("d", "rd-idle"),
        { ...agent("h", "rd"), type: "human" },
      ],
      [
        invocation("a", "running", { progress: "执行命令：pnpm test" }),
        invocation("b", "running"),
        invocation("b", "waiting_human"),
        invocation("d", "completed"),
        invocation("a", "queued", { roomId: "other" }),
      ],
      "general",
    );
    expect(rows.map((row) => [row.participant.username, row.state, row.label])).toEqual([
      ["rd-claude", "waiting", "等你回答"],
      ["rd-codex", "running", "执行命令：pnpm test"],
      ["rd-omp", "thinking", "正在思考"],
    ]);
    expect(rows[0]!.invocation?.messageId).toBe("m-b-waiting_human");
    expect(rows[2]!.invocation).toBeUndefined();
  });
});

describe("离线 Agent 的排队任务", () => {
  it("还没送达、Agent 离线：在等它上线，不算在干活（停掉的 Agent 不会一直挂着「正在处理」）", () => {
    const rows = agentActivity(
      [agent("a", "win-mr-watch-claude", "offline"), agent("b", "rd-claude")],
      [invocation("a", "queued"), invocation("b", "queued")],
      "general",
    );
    expect(rows.map((row) => [row.participant.username, row.state])).toEqual([
      ["rd-claude", "queued"],
    ]);
  });

  it("已经送达的照常列出", () => {
    const rows = agentActivity(
      [agent("a", "rd-codex", "offline")],
      [invocation("a", "queued", { receivedAt: "2026-10-31T00:00:01.000Z" })],
      "general",
    );
    expect(rows.map((row) => row.state)).toEqual(["queued"]);
  });
});
