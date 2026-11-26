/**
 * 「结果未知」里哪些是 Agent 确认自己已经不在跑这一轮的：人可以点「继续」，接着原会话核对现状再往下做。
 * 白名单而不是前缀：旧进程还活着（crashedRuntimeAlive）、停止未确认（alreadyEnded、cancelNotPersisted）、
 * 插入的消息可能已经执行过（steerEndRace）这些也是 Bridge 报的，但重新派发会让同一任务并行跑两份。
 * 服务端（是否放行重试）和网页（是否显示「等你决定」）共用这一份。
 */
export const RESUMABLE_UNKNOWN_KEYS: readonly string[] = [
  "bridge.crashedMidTurn",
  "bridge.crashedAfterResume",
  // 中断时正在跑一个撤不回的对外操作：卡片上写明是哪一步，人核对后可以继续
  "bridge.crashedIrreversible",
  "bridge.reconnectedGone",
  "bridge.uncertain",
  // 从没确认收到：一定还没开工
  "invocation.unacknowledged",
];

export function isResumableUnknown(invocation: {
  status: string;
  detailText?: { key: string } | undefined;
}): boolean {
  return (
    invocation.status === "timed_out" &&
    RESUMABLE_UNKNOWN_KEYS.includes(invocation.detailText?.key ?? "")
  );
}

/**
 * 失败统一分三类，网页据此在「重试 / 继续 / 换个模型重试」下写明点了会怎样：
 * - transient：暂时忙、还没开始执行（Bridge 已自动退避重试过），重试安全
 * - uncertain：可能已经执行过（中途中断、执行完没能复核），交人核对后「继续」或「忽略」
 * - unsafe：Bridge 判定不能做（身份不符、会话锁定、运行时不支持……），直接拒绝并写明原因
 * 按 Bridge 上报的结构化文案键判断；旧版 Bridge 只有中文说明，判断不了的返回 undefined。
 */
export type FailureClass = "transient" | "uncertain" | "unsafe";

const FAILURE_CLASSES: Readonly<Record<string, FailureClass>> = {
  "bridge.transientFailed": "transient",
  "bridge.worktreeBusy": "transient",
  // 首次加入时超出补拉范围：从没执行过
  "bridge.beyondCatchUp": "transient",
  // 从没确认收到：一定还没开工
  "invocation.unacknowledged": "transient",
  "bridge.crashedMidTurn": "uncertain",
  "bridge.crashedAfterResume": "uncertain",
  "bridge.crashedIrreversible": "uncertain",
  "bridge.crashedRuntimeAlive": "uncertain",
  "bridge.reconnectedGone": "uncertain",
  "bridge.uncertain": "uncertain",
  "bridge.alreadyEnded": "uncertain",
  "bridge.cancelNotPersisted": "uncertain",
  "bridge.steerUnconfirmed": "uncertain",
  "bridge.steerCancelRace": "uncertain",
  "bridge.steerEndRace": "uncertain",
  "bridge.upstreamFailed": "uncertain",
  "bridge.worktreeCheckBeforeContinue": "uncertain",
  "bridge.unsafe": "unsafe",
  // Server 主动结束了 Agent 进程：这一轮可能已执行过一部分
  "invocation.interruptedAgentStopped": "uncertain",
  "invocation.interruptedAgentRestarted": "uncertain",
  "invocation.interruptedServerStopped": "uncertain",
};

export function failureClass(invocation: {
  status: string;
  detailText?: { key: string; params?: Record<string, unknown> } | undefined;
}): FailureClass | undefined {
  if (invocation.status !== "failed" && invocation.status !== "timed_out") return undefined;
  const text = invocation.detailText;
  if (!text) return undefined;
  // 会话失效：这一轮执行过工具才算可能已执行；没执行过的重试（开新会话）是安全的
  if (text.key === "bridge.sessionInvalid") {
    const why = text.params?.why as { key?: unknown } | undefined;
    return why?.key === "bridge.sessionExecuted" ? "uncertain" : "transient";
  }
  return FAILURE_CLASSES[text.key];
}
