import type { Invocation, Participant } from "@superhive/protocol";
import { localized, t } from "./i18n";

export type ActivityState = "waiting" | "running" | "cancelling" | "queued" | "thinking";

export type AgentActivityRow = {
  participant: Participant;
  state: ActivityState;
  /** 给人看的一句话：执行进展、等你回答… */
  label: string;
  /** 它正在处理的那次调用：点击跳到触发消息 */
  invocation?: Invocation;
};

/** 同一个 Agent 有多条进行中的调用时，最需要人看的排前面 */
const PRIORITY: Record<string, number> = {
  waiting_human: 0,
  running: 1,
  cancelling: 2,
  queued: 3,
};

const ORDER: Record<ActivityState, number> = {
  waiting: 0,
  running: 1,
  cancelling: 2,
  thinking: 3,
  queued: 4,
};

const STATE_TEXT: Record<Exclude<ActivityState, "running">, string> = localized(() => ({
  waiting: t("等你回答"),
  cancelling: t("停止中"),
  queued: t("排队中"),
  thinking: t("正在思考"),
}));

/**
 * 消息列表底部的「谁在干活」：当前房间每个有进行中调用（或显示忙碌）的 Agent 一行，
 * 等你回答的排最前。没有调用、只是显示忙碌的（例如旧版 Bridge）也算，标「正在思考」。
 */
export function agentActivity(
  participants: readonly Participant[],
  invocations: Iterable<Invocation>,
  roomId: string,
): AgentActivityRow[] {
  const byAgent = new Map<string, Invocation>();
  for (const invocation of invocations) {
    if (invocation.roomId !== roomId || !(invocation.status in PRIORITY)) continue;
    const current = byAgent.get(invocation.agentId);
    if (
      !current ||
      PRIORITY[invocation.status]! < PRIORITY[current.status]! ||
      (PRIORITY[invocation.status] === PRIORITY[current.status] &&
        invocation.updatedAt > current.updatedAt)
    ) {
      byAgent.set(invocation.agentId, invocation);
    }
  }
  const rows: AgentActivityRow[] = [];
  for (const participant of participants) {
    if (participant.type !== "agent") continue;
    const invocation = byAgent.get(participant.id);
    if (!invocation) {
      if (participant.status === "busy") {
        rows.push({ participant, state: "thinking", label: STATE_TEXT.thinking });
      }
      continue;
    }
    const state: ActivityState =
      invocation.status === "waiting_human"
        ? "waiting"
        : invocation.status === "running"
          ? "running"
          : invocation.status === "cancelling"
            ? "cancelling"
            : "queued";
    rows.push({
      participant,
      state,
      label: state === "running" ? invocation.progress?.trim() || t("执行中") : STATE_TEXT[state],
      invocation,
    });
  }
  return rows.sort(
    (a, b) =>
      ORDER[a.state] - ORDER[b.state] ||
      a.participant.username.localeCompare(b.participant.username),
  );
}
