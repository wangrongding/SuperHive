import type { Participant, RoomSummary } from "@superhive/protocol";

/** 房间设置里「主 Agent」下拉的「自动」项；成员名不能含 *，不会和名字撞 */
export const AUTO_LEAD = "*auto";

/** 主 Agent 是服务端自动设的（第一个加入的 Agent，或自动顺延的） */
export function isAutoLead(room: Pick<RoomSummary, "leadAgent" | "leadMode"> | undefined): boolean {
  return Boolean(room?.leadAgent) && room?.leadMode === "auto";
}

/**
 * 房间设置里下拉的初始值：房主手动设的就是那个名字，手动取消的是「不设置」（空），
 * 其余（自动设的、还没设过的）是「自动」
 */
export function leadChoiceOf(room: Pick<RoomSummary, "leadAgent" | "leadMode">): string {
  if (room.leadMode === "manual") return room.leadAgent ?? "";
  if (room.leadMode === "auto") return AUTO_LEAD;
  return room.leadAgent ?? AUTO_LEAD;
}

/** 保存房间设置时要发的主 Agent 改动；没改就是空对象 */
export function leadPatchOf(
  room: Pick<RoomSummary, "leadAgent" | "leadMode">,
  choice: string,
): { leadAgent?: string | null; leadMode?: "auto" } {
  if (choice === leadChoiceOf(room)) return {};
  if (choice === AUTO_LEAD) return { leadMode: "auto" };
  return { leadAgent: choice || null };
}

/**
 * 建议谁当主 Agent（和服务端自动顺延的规则一致）：在线的 Agent 里本机的优先，其次先加入房间的。
 * 没有在线的 Agent 就不建议
 */
export function suggestLead(
  participants: readonly Participant[],
  localNames: readonly string[],
): Participant | undefined {
  const local = new Set(localNames.map((name) => name.toLocaleLowerCase()));
  const isLocal = (participant: Participant) => local.has(participant.username.toLocaleLowerCase());
  return participants
    .filter(
      (participant) =>
        participant.type === "agent" && participant.status !== "offline" && !participant.hidden,
    )
    .sort(
      (a, b) =>
        Number(isLocal(b)) - Number(isLocal(a)) ||
        a.joinedAt.localeCompare(b.joinedAt) ||
        a.username.localeCompare(b.username),
    )[0];
}
