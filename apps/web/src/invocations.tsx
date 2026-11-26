import { useEffect, useState } from "react";
import { InvocationDetails } from "./invocation-details";
import {
  explainInvocationState,
  type ChatMessage,
  type Invocation,
  type Participant,
  type TraceStep,
} from "@superhive/protocol";
import { localized, t } from "./i18n";
import {
  isUpstreamInterrupted,
  needsDecision,
  retryConsequence,
  UPSTREAM_FAILURE_PREFIX,
} from "./attention";
import { Tooltip } from "./tooltip";
import { Button } from "./button";

/** 人点一次「继续」为当前 Agent 对话追加的轮数，同时放宽连续轮数、同一对每天次数和来回检测 */
export const BUDGET_EXTEND_TURNS = 10;

/**
 * 被防循环预算拦下、可以由人点「继续」恢复的调用：几种预算都随追加的轮数一起放宽。
 * hop_limit 是旧版转交深度上限留下的记录（上限已取消），点「继续」同样能恢复。
 */
export function isExtendableBlock(invocation: Invocation): boolean {
  return (
    !invocation.messageRecalled &&
    invocation.status === "blocked" &&
    (invocation.blockReason === "hop_limit" ||
      invocation.blockReason === "consecutive_limit" ||
      invocation.blockReason === "pair_limit" ||
      invocation.blockReason === "ping_pong")
  );
}

/**
 * 顶部「继续」提示只针对人最后一次发言之后被拦下的调用，与服务端追加额度的范围一致；
 * 更早的拦截已经被人的发言越过，点「继续」也不会恢复，不再提示。
 */
export function currentPausedInvocations(
  invocations: Iterable<Invocation>,
  messages: readonly ChatMessage[],
): Invocation[] {
  let lastHumanSeq = 0;
  const seqById = new Map<string, number>();
  for (const message of messages) {
    seqById.set(message.id, message.seq);
    if (message.senderType === "human" && message.seq > lastHumanSeq) lastHumanSeq = message.seq;
  }
  return [...invocations].filter(
    (invocation) =>
      isExtendableBlock(invocation) && (seqById.get(invocation.messageId) ?? 0) >= lastHumanSeq,
  );
}

export { UPSTREAM_FAILURE_PREFIX, isUpstreamInterrupted, needsDecision };

export function retryLabel(invocation: Invocation): string {
  if (invocation.blockReason === "guest_approval") return t("批准");
  return needsDecision(invocation) ? t("继续") : t("重试");
}

export function canRetryInvocation(invocation: Invocation, agentOnline = true): boolean {
  if (invocation.messageRecalled) return false;
  return (
    // 结果未知要 Agent 在线才能继续：离线时派发会丢掉「接着原会话」的提示
    (invocation.status === "timed_out" && needsDecision(invocation) && agentOnline) ||
    invocation.status === "failed" ||
    invocation.status === "cancelled" ||
    invocation.status === "blocked"
  );
}

/** 可以「忽略」的调用：失败、被拦、结果未知，且还没被收起 */
export function canDismissInvocation(invocation: Invocation): boolean {
  return (
    !invocation.resolution &&
    (invocation.status === "failed" ||
      invocation.status === "blocked" ||
      invocation.status === "timed_out")
  );
}

/** 支持把新消息插进正在执行的这一轮的运行时 */
const STEERABLE_PROVIDERS = new Set(["claude", "codex", "opencode", "omp"]);

/**
 * 能「引导」：人发的、还在排队的消息，而且同一个 Agent 在这个房间正有任务在执行、
 * 它的运行时支持引导。服务端会再核对一遍（定时触发、Agent 发的消息都会被拒绝）。
 */
export function canSteerInvocation(
  invocation: Invocation,
  all: Iterable<Invocation>,
  provider: string | undefined,
): boolean {
  if (invocation.status !== "queued" || invocation.resolution) return false;
  if (invocation.requesterType !== "human") return false;
  if (!provider || !STEERABLE_PROVIDERS.has(provider)) return false;
  for (const other of all) {
    if (
      other.id !== invocation.id &&
      other.agentId === invocation.agentId &&
      other.roomId === invocation.roomId &&
      other.status === "running"
    ) {
      return true;
    }
  }
  return false;
}

/** 正在执行的任务（「停下当前，改做这条」需要有它；不要求运行时支持引导） */
export function hasRunningTask(invocation: Invocation, all: Iterable<Invocation>): boolean {
  for (const other of all) {
    if (
      other.id !== invocation.id &&
      other.agentId === invocation.agentId &&
      other.roomId === invocation.roomId &&
      other.status === "running"
    ) {
      return true;
    }
  }
  return false;
}

/** 是否在 Agent 正跑着的这一轮里：执行中、停止中，或提问后这一轮还没结束（与服务端同一判定） */
function inRunningTurn(invocation: Invocation): boolean {
  return (
    invocation.status === "running" ||
    invocation.status === "cancelling" ||
    (invocation.status === "waiting_human" && !invocation.finishedAt)
  );
}

/**
 * 和这条合在同一轮里处理的其它调用：Agent 在一个房间里同一时间只跑一轮，所以它在跑的都在这一轮里。
 * 在其中任意一条下面点「停止」，服务端会把整轮一起停下
 */
export function turnSiblings(invocation: Invocation, all: Iterable<Invocation>): Invocation[] {
  if (!inRunningTurn(invocation)) return [];
  const siblings: Invocation[] = [];
  for (const other of all) {
    if (
      other.id !== invocation.id &&
      other.agentId === invocation.agentId &&
      other.roomId === invocation.roomId &&
      inRunningTurn(other)
    ) {
      siblings.push(other);
    }
  }
  return siblings;
}

/** 访客能不能停下这一轮：同一轮里有别人发起的消息时不能（服务端同样这么判） */
export function guestCanStopTurn(
  invocation: Invocation,
  all: Iterable<Invocation>,
  selfName: string,
): boolean {
  const self = selfName.toLocaleLowerCase();
  return [invocation, ...turnSiblings(invocation, all)].every(
    (item) => item.requesterType === "human" && item.requesterName.toLocaleLowerCase() === self,
  );
}

export function canCancelInvocation(invocation: Invocation): boolean {
  if (invocation.resolution) return false;
  return (
    invocation.status === "queued" ||
    invocation.status === "running" ||
    invocation.status === "timed_out" ||
    invocation.status === "waiting_human"
  );
}

/** Agent 的提问消息对应的、仍在等人回答的调用（提问挂在触发消息下，由提问的 Agent 发出） */
export function waitingInvocationForQuestion(
  question: ChatMessage,
  invocations: Iterable<Invocation>,
): Invocation | undefined {
  if (question.kind !== "question" || !question.parentMessageId || question.deletedAt) {
    return undefined;
  }
  for (const invocation of invocations) {
    if (
      invocation.status === "waiting_human" &&
      invocation.messageId === question.parentMessageId &&
      invocation.agentId === question.senderId
    ) {
      return invocation;
    }
  }
  return undefined;
}

export function upsertInvocation(
  current: ReadonlyMap<string, Invocation>,
  invocation: Invocation,
): Map<string, Invocation> {
  const existing = current.get(invocation.id);
  // 乱序到达的旧快照不能覆盖更新的状态
  if (existing && existing.updatedAt > invocation.updatedAt)
    return current as Map<string, Invocation>;
  const next = new Map(current);
  next.set(invocation.id, invocation);
  return next;
}

/** 按触发消息分组，组内按创建时间排序，渲染时 O(1) 取用 */
export function groupInvocationsByMessage(
  invocations: ReadonlyMap<string, Invocation>,
): Map<string, Invocation[]> {
  const groups = new Map<string, Invocation[]>();
  for (const invocation of invocations.values()) {
    const group = groups.get(invocation.messageId);
    if (group) group.push(invocation);
    else groups.set(invocation.messageId, [invocation]);
  }
  for (const group of groups.values()) {
    group.sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.agentName.localeCompare(b.agentName),
    );
  }
  return groups;
}

const continuationLabels: Record<NonNullable<Invocation["continuation"]>, string> = localized(
  () => ({
    pending: t("结果待回执"),
    delivered: t("结果已回执"),
    consumed: t("结果已被取走"),
    failed: t("回执失败"),
  }),
);

export type DelegationView = {
  /** 上游：谁派来的；relation 区分 hive_invoke 委派和普通 @ 转交 */
  upstream?: { invocation?: Invocation; requesterName: string; relation: "委派" | "转交" };
  downstream: Invocation[];
  /** 子任务结果回执状态（只有 hive_invoke 委派的子任务才有） */
  continuation?: string;
};

/**
 * 从调用记录里还原委派关系：上游按 parentInvocationId 精确查找，下游是以它为上游的调用。
 * 上游不在已加载的记录里时只给出发起方名字，不拼凑不存在的关系。
 */
export function delegationView(
  invocation: Invocation,
  all: Iterable<Invocation>,
): DelegationView | undefined {
  const list = [...all];
  const downstream = list
    .filter((candidate) => candidate.parentInvocationId === invocation.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const relation = invocation.continuation ? t("委派") : t("转交");
  const upstream =
    invocation.requesterType === "agent"
      ? {
          ...(invocation.parentInvocationId
            ? {
                invocation: list.find(
                  (candidate) => candidate.id === invocation.parentInvocationId,
                ),
              }
            : {}),
          requesterName: invocation.requesterName,
          relation,
        }
      : undefined;
  if (!upstream && downstream.length === 0) return undefined;
  return {
    ...(upstream ? { upstream: upstream as NonNullable<DelegationView["upstream"]> } : {}),
    downstream,
    ...(invocation.continuation
      ? { continuation: continuationLabels[invocation.continuation] }
      : {}),
  };
}

/** 调用详情里的委派关系，逐行展示上下游及其状态 */
export function delegationLines(
  invocation: Invocation,
  all: Iterable<Invocation>,
): { upstream?: string; downstream: string[]; continuation?: string } | undefined {
  const view = delegationView(invocation, all);
  if (!view) return undefined;
  const upstream = view.upstream
    ? view.upstream.invocation
      ? t("@{0} {1}（上游调用：{2}）", {
          0: view.upstream.requesterName,
          1: view.upstream.relation,
          2: invocationStatusLabel(view.upstream.invocation, true),
        })
      : t("@{0} {1}（上游调用不在当前已加载的记录里）", {
          0: view.upstream.requesterName,
          1: view.upstream.relation,
        })
    : undefined;
  return {
    ...(upstream ? { upstream } : {}),
    downstream: view.downstream.map(
      (child) =>
        `@${child.agentName} · ${invocationStatusLabel(child, true)}${
          child.continuation ? ` · ${continuationLabels[child.continuation]}` : ""
        }`,
    ),
    ...(view.continuation ? { continuation: view.continuation } : {}),
  };
}

/** 一句话概括委派关系，用于任务列表和调用状态行 */
export function delegationSummary(
  invocation: Invocation,
  all: Iterable<Invocation>,
): string | undefined {
  const view = delegationView(invocation, all);
  if (!view) return undefined;
  const parts: string[] = [];
  if (view.upstream)
    parts.push(t("由 @{0} {1}", { 0: view.upstream.requesterName, 1: view.upstream.relation }));
  if (view.continuation) parts.push(view.continuation);
  if (view.downstream.length) {
    const open = view.downstream.filter((child) =>
      ["queued", "running", "cancelling", "blocked", "timed_out", "waiting_human"].includes(
        child.status,
      ),
    ).length;
    parts.push(
      open
        ? t("派出 {0} 个子任务，{1} 个未结束", { 0: view.downstream.length, 1: open })
        : t("派出的 {0} 个子任务都已结束", { 0: view.downstream.length }),
    );
  }
  return parts.join(" · ");
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return t("{0}秒", { 0: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t("{0}分钟", { 0: minutes });
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? t("{0}小时{1}分", { 0: hours, 1: rest }) : t("{0}小时", { 0: hours });
}

export function invocationStatusLabel(invocation: Invocation, agentOnline: boolean): string {
  const error = invocation.runtime?.lastError;
  if (invocation.status === "running" && error && !error.recoveredAt) {
    return error.code === 429
      ? t("服务限流 · HTTP 429")
      : t("API 异常{0}", { 0: error.code ? ` · HTTP ${error.code}` : "" });
  }
  switch (invocation.status as string) {
    case "queued":
      if (invocation.receivedAt) return t("已送达，排队中");
      return agentOnline ? t("排队中") : t("等待上线");
    case "running":
      return t("进行中");
    case "completed":
      return t("已完成");
    case "failed":
      return needsDecision(invocation) ? t("等你决定") : t("失败");
    case "blocked":
      return invocation.blockReason === "guest_approval" ? t("等房主批准") : t("已暂停");
    case "timed_out":
      return needsDecision(invocation) ? t("等你决定") : t("结果未知");
    case "cancelled":
      return t("已停止");
    case "cancelling":
      return t("正在停止 · 待确认");
    case "waiting_human":
      return t("等你回答");
    default:
      return t("状态待核实");
  }
}

function invocationHint(invocation: Invocation, agentOnline: boolean): string | undefined {
  if (invocation.status === "cancelling")
    return t("已请求停止，等待 Runtime 确认；确认前不能重试。");
  if (needsDecision(invocation)) {
    return [
      invocation.detail,
      invocation.status === "timed_out" && !agentOnline
        ? t("{0} 上线后可以点「继续」", { 0: invocation.agentName })
        : t("点「继续」会接着原会话核对现状再往下做，不从头重做；不要了就点「忽略」"),
    ]
      .filter(Boolean)
      .join(" · ");
  }
  if (invocation.status === "timed_out") {
    return [invocation.detail, t("长时间未收到结果，这不一定是失败，迟到的回复仍可能到达。")]
      .filter(Boolean)
      .join(" · ");
  }
  if (invocation.status === "queued" && !invocation.receivedAt && !agentOnline) {
    return t("{0} 当前离线，上线后会自动收到这条消息。", { 0: invocation.agentName });
  }
  if (invocation.status === "running") return invocation.progress ?? invocation.detail;
  if (invocation.status === "waiting_human") {
    return [invocation.detail, t("回复它的提问即可继续")].filter(Boolean).join(" · ");
  }
  return invocation.detail;
}

function ElapsedTime({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <span className="invocation-elapsed">{formatElapsed(now - new Date(since).getTime())}</span>
  );
}

/**
 * 排队中的调用为什么还没开始：前面有几个任务、派出多久还没确认收到。离线已由状态文字说明，这里不重复。
 * 每秒自己刷新，过了 5 秒的活动门闩就换成警示样式。
 */
function QueueHint({
  invocation,
  agentOnline,
  others,
}: {
  invocation: Invocation;
  agentOnline: boolean;
  others: readonly Invocation[];
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const state = explainInvocationState({ invocation, agentOnline, others, now });
  const seconds = Math.round(state.waitedMs / 1000);
  const waited =
    seconds < 60 ? t("{0} 秒", { 0: seconds }) : t("{0} 分钟", { 0: Math.floor(seconds / 60) });
  const text =
    state.code === "queued_behind"
      ? t("前面还有 {0} 个", { 0: state.ahead })
      : state.code === "queued_undelivered" && state.stalled
        ? t("派出 {0} 还没确认收到", { 0: waited })
        : state.code === "queued_received" && state.stalled
          ? t("已收到 {0}，还没开始", { 0: waited })
          : undefined;
  if (!text) return null;
  return (
    // 正常排队不算异常；没确认收到、收到了却不开始才用警示色
    <span
      className={`invocation-progress queue-hint${state.stalled && state.code !== "queued_behind" ? " stalled" : ""}`}
    >
      {text}
    </span>
  );
}

/** 连不上模型服务：失败了，或者正在等网络恢复后自动重试 */
export function isNetworkFailure(invocation: Invocation): boolean {
  return (
    invocation.failure === "network" &&
    (invocation.status === "failed" || invocation.status === "running") &&
    !invocation.resolution
  );
}

export function InvocationChips({
  invocations,
  participants,
  canJumpTo,
  onJump,
  onRetry,
  onCancel,
  onExtend,
  connectionState,
  allInvocations,
  isOwner = true,
  selfName,
  onLocate,
  onDismiss,
  traces,
  onSteer,
  onPreempt,
  onOpenTerminal,
  onViewChanges,
  onRetryWithModel,
  onOpenProxySettings,
  onViewProcess,
  flashedIds,
  recalled = false,
}: {
  recalled?: boolean;
  /**
   * 「查看过程」：进行中、等你回答、排队时跳到对话流里那张过程卡。
   * 对话流里有对应卡片时才返回处理函数，没有就不出按钮
   */
  onViewProcess?: ((invocation: Invocation) => (() => void) | undefined) | undefined;
  /** 刚从另一头跳过来（或从这里跳走）的调用：状态条短暂高亮 */
  flashedIds?: ReadonlySet<string>;
  /** 连不上模型服务（网络错误）时的「网络代理设置」：本机 Agent、房主才返回处理函数 */
  onOpenProxySettings?: ((invocation: Invocation) => (() => void) | undefined) | undefined;
  /** 「看改动」：打开「代码」面板并切到这个 Agent 的任务线 */
  onViewChanges?: ((invocation: Invocation) => void) | undefined;
  /** 「换个模型重试」：只有房主能用，失败的任务上才有 */
  onRetryWithModel?: ((invocation: Invocation) => void) | undefined;
  /** 「在终端打开会话」：本机 Agent 才返回处理函数 */
  onOpenTerminal?: ((invocation: Invocation) => (() => void) | undefined) | undefined;
  /** 「引导」：把排队中的这条插进 Agent 正在执行的这一轮 */
  onSteer?: (invocation: Invocation) => void;
  /** 「停下当前，改做这条」 */
  onPreempt?: (invocation: Invocation) => void;
  /** 执行过程（房主和获准看过程的访客的页面有）：状态行显示当前这一步，详情弹窗里看完整过程 */
  traces?: ReadonlyMap<string, TraceStep[]>;
  /** 「忽略」：标为已处理，不再算作需要处理 */
  onDismiss?: (invocation: Invocation) => void;
  /** 底部状态栏里用：跳到触发这条调用的消息 */
  onLocate?: (messageId: string) => void;
  /** 访客看不到「批准」：访客的请求只能由房主放行 */
  isOwner?: boolean;
  /** 自己的名字：访客停止时据此判断同一轮里有没有别人发起的消息 */
  selfName?: string;
  invocations: Invocation[];
  /** 房间里全部调用，用来展示委派关系；省略时只看本条消息的调用 */
  allInvocations?: ReadonlyMap<string, Invocation>;
  participants: Participant[];
  canJumpTo: (messageId: string) => boolean;
  /** origin：从哪条调用跳过去的，跳转时它也闪一下 */
  onJump: (messageId: string, origin?: Invocation) => void;
  onRetry: (invocation: Invocation) => void;
  onCancel: (invocation: Invocation) => void;
  onExtend: () => void;
  connectionState?: "online" | "connecting" | "offline";
}) {
  const [selectedId, setSelectedId] = useState<string>();
  const selected = invocations.find((invocation) => invocation.id === selectedId);
  if (recalled || (invocations.length > 0 && invocations.every((item) => item.messageRecalled))) {
    const active = invocations.filter(
      (invocation) =>
        invocation.status === "queued" ||
        invocation.status === "running" ||
        invocation.status === "cancelling" ||
        (invocation.status === "waiting_human" && !invocation.finishedAt),
    );
    if (!active.length) return null;
    return (
      <div className="invocation-row invocation-recalled" role="status">
        {active.map((invocation) => {
          const stopping = invocation.status === "cancelling";
          const canStop =
            canCancelInvocation(invocation) &&
            (isOwner ||
              (selfName !== undefined &&
                guestCanStopTurn(invocation, allInvocations?.values() ?? invocations, selfName)));
          return (
            <span key={invocation.id} className="invocation-recalled-status">
              <span>
                {t("@{0} · {1}", {
                  0: invocation.agentName,
                  1: stopping ? t("停止中…") : t("任务仍在继续"),
                })}
              </span>
              {canStop && (
                <Button
                  size="sm"
                  variant="ghost"
                  tone="danger"
                  aria-label={t("停止 @{0} 这一轮", { 0: invocation.agentName })}
                  disabled={connectionState !== undefined && connectionState !== "online"}
                  onClick={() => onCancel(invocation)}
                >
                  {t("停止")}
                </Button>
              )}
            </span>
          );
        })}
      </div>
    );
  }
  return (
    <>
      <div className="invocation-row" role="list" aria-label={t("Agent 调用状态")}>
        {invocations.map((invocation) => {
          const agentOnline = participants.some(
            (participant) =>
              participant.id === invocation.agentId && participant.status !== "offline",
          );
          const label = invocationStatusLabel(invocation, agentOnline);
          const delegation = delegationSummary(invocation, allInvocations?.values() ?? invocations);
          const rawHint = [invocationHint(invocation, agentOnline), delegation]
            .filter(Boolean)
            .join(" · ");
          const hint = !rawHint || rawHint === label ? undefined : rawHint;
          // 「重试 / 继续 / 换个模型重试」下的一句后果说明：只在真有这些按钮时显示
          const canRetry =
            !isExtendableBlock(invocation) &&
            canRetryInvocation(invocation, agentOnline) &&
            (invocation.blockReason !== "guest_approval" || isOwner);
          const canRetryWithModel = Boolean(
            onRetryWithModel && isOwner && invocation.status === "failed",
          );
          const consequence =
            canRetry || canRetryWithModel ? retryConsequence(invocation) : undefined;
          const consequenceId = consequence ? `invocation-consequence-${invocation.id}` : undefined;
          // 有执行过程时，当前这一步显示在对话流的「思考中」卡片里，状态行不再重复
          const traced = Boolean(traces?.get(invocation.id)?.length);
          const jumpTarget =
            invocation.status === "completed" &&
            invocation.replyMessageId &&
            canJumpTo(invocation.replyMessageId)
              ? invocation.replyMessageId
              : undefined;
          const viewProcess = jumpTarget ? undefined : onViewProcess?.(invocation);
          const summary = (
            <>
              <span className="invocation-indicator" aria-hidden="true">
                {invocation.status === "completed" && (
                  <svg viewBox="0 0 24 24">
                    <path d="m5 12 4 4L19 6" />
                  </svg>
                )}
              </span>
              <span className="invocation-agent">@{invocation.agentName}</span>
              <span className="invocation-status">{label}</span>
              {invocation.status === "running" && !traced && invocation.progress && (
                <span className="invocation-progress">{invocation.progress}</span>
              )}
              {/* 引导的进展（正在插入、已并入 #n、没插进去转回排队……） */}
              {((invocation.status === "running" && !traced && !invocation.progress) ||
                invocation.status === "queued") &&
                invocation.detail &&
                // 服务端收到确认时写的「已送达，排队中」和状态文字一样，不重复显示
                invocation.detail !== label && (
                  <span className="invocation-progress">{invocation.detail}</span>
                )}
              {(invocation.status === "blocked" ||
                invocation.status === "failed" ||
                invocation.status === "waiting_human" ||
                // 完成但没有回复消息：Agent 判断无需回复，标出来免得像是漏处理
                (invocation.status === "completed" && !invocation.replyMessageId)) &&
                invocation.detail && (
                  <span className="invocation-progress">{invocation.detail}</span>
                )}
              {invocation.status === "queued" && agentOnline && (
                <QueueHint
                  invocation={invocation}
                  agentOnline={agentOnline}
                  others={[...(allInvocations?.values() ?? invocations)]}
                />
              )}
              {invocation.status === "running" && (
                <ElapsedTime since={invocation.startedAt ?? invocation.updatedAt} />
              )}
              {invocation.attempts > 1 && (
                <span className="invocation-attempts">
                  {t("第{0}次", { 0: invocation.attempts })}
                </span>
              )}
              {delegation && <span className="invocation-delegation">{delegation}</span>}
              {invocation.resolution && (
                <span className="invocation-resolution">
                  {invocation.resolution.kind === "dismissed"
                    ? t("{0}已忽略", { 0: invocation.resolution.by ?? "" })
                    : (invocation.resolution.note ?? t("已被后续处理取代"))}
                </span>
              )}
            </>
          );
          const ariaSummary = [
            `@${invocation.agentName}`,
            label,
            invocation.attempts > 1 ? t("第{0}次", { 0: invocation.attempts }) : undefined,
            hint,
          ]
            .filter(Boolean)
            .join(t("，"));
          return (
            <div
              key={invocation.id}
              role="listitem"
              data-invocation-id={invocation.id}
              className={`invocation-chip ${invocation.status}${invocation.resolution ? " resolved" : ""}${consequence ? " has-consequence" : ""}${flashedIds?.has(invocation.id) ? " jump-flash" : ""}`}
              title={hint}
              onClick={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                className="invocation-summary"
                aria-label={t("{0}，查看调用详情", { 0: ariaSummary })}
                aria-haspopup="dialog"
                onClick={() => setSelectedId(invocation.id)}
              >
                {summary}
                <span className="invocation-details-affordance" aria-hidden="true">
                  {t("详情 ›")}
                </span>
              </button>
              {onLocate && canJumpTo(invocation.messageId) && (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t("{0}，定位到原消息", { 0: ariaSummary })}
                  onClick={() => onLocate(invocation.messageId)}
                >
                  {t("原消息")}
                </Button>
              )}
              {jumpTarget && (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t("{0}，跳到回复", { 0: ariaSummary })}
                  onClick={() => onJump(jumpTarget, invocation)}
                >
                  {t("查看回复")}
                </Button>
              )}
              {viewProcess && (
                <Tooltip
                  content={
                    invocation.status === "queued"
                      ? t("还在排队，先看 @{0} 正在做的", { 0: invocation.agentName })
                      : t("跳到对话流里这一轮的过程")
                  }
                >
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t("{0}，跳到执行过程", { 0: ariaSummary })}
                    onClick={viewProcess}
                  >
                    {t("查看过程")}
                  </Button>
                </Tooltip>
              )}
              {isExtendableBlock(invocation) ? (
                <Button
                  size="sm"
                  aria-label={t("为 Agent 对话追加 {0} 轮，恢复 @{1}", {
                    0: BUDGET_EXTEND_TURNS,
                    1: invocation.agentName,
                  })}
                  onClick={onExtend}
                >
                  {t("继续 {0} 轮", { 0: BUDGET_EXTEND_TURNS })}
                </Button>
              ) : (
                canRetry && (
                  <Tooltip
                    content={
                      needsDecision(invocation)
                        ? t("接着原会话从中断处继续，不会从头重做")
                        : undefined
                    }
                  >
                    <Button
                      size="sm"
                      variant={
                        invocation.blockReason === "guest_approval" || needsDecision(invocation)
                          ? "secondary"
                          : "ghost"
                      }
                      aria-label={`${retryLabel(invocation)} @${invocation.agentName}`}
                      aria-describedby={consequenceId}
                      onClick={() => onRetry(invocation)}
                    >
                      {retryLabel(invocation)}
                    </Button>
                  </Tooltip>
                )
              )}
              {canRetryWithModel && (
                <Tooltip content={t("选一个模型，只对这一次重试生效")}>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t("换个模型重试 @{0}", { 0: invocation.agentName })}
                    aria-describedby={consequenceId}
                    onClick={() => onRetryWithModel!(invocation)}
                  >
                    {t("换个模型重试")}
                  </Button>
                </Tooltip>
              )}
              {(() => {
                if (!isNetworkFailure(invocation)) return null;
                const open = onOpenProxySettings?.(invocation);
                if (!open) return null;
                return (
                  <Tooltip
                    content={t(
                      "连不上模型服务。在国内用 agy、Gemini、Claude 等海外服务时，多半要给本机 Agent 配网络代理",
                    )}
                  >
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={t("@{0} 连不上模型服务，打开网络代理设置", {
                        0: invocation.agentName,
                      })}
                      onClick={open}
                    >
                      {t("可能需要配置代理")}
                    </Button>
                  </Tooltip>
                );
              })()}
              {onDismiss &&
                canDismissInvocation(invocation) &&
                (invocation.blockReason !== "guest_approval" || isOwner) && (
                  <Tooltip content={t("标为已处理，不再算作需要处理；记录仍保留")}>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={t("忽略 @{0} 的这次调用", { 0: invocation.agentName })}
                      onClick={() => onDismiss(invocation)}
                    >
                      {t("忽略")}
                    </Button>
                  </Tooltip>
                )}
              {onSteer &&
                canSteerInvocation(
                  invocation,
                  allInvocations?.values() ?? invocations,
                  participants.find((participant) => participant.id === invocation.agentId)
                    ?.provider,
                ) && (
                  <Tooltip content={t("不排队，让它在当前这一轮里接着处理这条")}>
                    <Button
                      size="sm"
                      aria-label={t("用这条引导 @{0} 正在执行的任务", { 0: invocation.agentName })}
                      onClick={() => onSteer(invocation)}
                    >
                      {t("引导")}
                    </Button>
                  </Tooltip>
                )}
              {onPreempt &&
                isOwner &&
                invocation.status === "queued" &&
                invocation.requesterType === "human" &&
                !invocation.resolution &&
                hasRunningTask(invocation, allInvocations?.values() ?? invocations) && (
                  <Tooltip
                    content={t("先停下正在执行的任务（它会变成已停止或结果未知），停下后先做这条")}
                  >
                    <Button
                      size="sm"
                      variant="ghost"
                      tone="danger"
                      aria-label={t("停下 @{0} 当前的任务，改做这条", { 0: invocation.agentName })}
                      onClick={() => onPreempt(invocation)}
                    >
                      {t("停下当前，改做这条")}
                    </Button>
                  </Tooltip>
                )}
              {canCancelInvocation(invocation) &&
                (() => {
                  const all = allInvocations?.values() ?? invocations;
                  const siblings = turnSiblings(invocation, all);
                  if (siblings.length === 0) {
                    return (
                      <Button
                        size="sm"
                        variant="ghost"
                        tone="danger"
                        aria-label={t("停止 @{0}", { 0: invocation.agentName })}
                        onClick={() => onCancel(invocation)}
                      >
                        {t("停止")}
                      </Button>
                    );
                  }
                  // 几条合在一轮里处理：停的是整轮。访客停不了有别人消息的这一轮，按钮点不了并说清楚
                  const blocked =
                    !isOwner &&
                    selfName !== undefined &&
                    !guestCanStopTurn(
                      invocation,
                      allInvocations?.values() ?? invocations,
                      selfName,
                    );
                  return (
                    <Tooltip
                      content={
                        blocked
                          ? t("@{0} 这一轮还在一起处理别人发起的消息，访客没法停下这一轮", {
                              0: invocation.agentName,
                            })
                          : t("这一轮一起处理了 {0} 条消息，停止会把它们一起停下", {
                              0: siblings.length + 1,
                            })
                      }
                    >
                      <Button
                        size="sm"
                        variant="ghost"
                        tone="danger"
                        aria-label={t("停止 @{0} 这一轮的 {1} 条消息", {
                          0: invocation.agentName,
                          1: siblings.length + 1,
                        })}
                        // 不用 disabled：禁用的按钮收不到悬停，说明就看不到了
                        aria-disabled={blocked || undefined}
                        onClick={() => {
                          if (!blocked) onCancel(invocation);
                        }}
                      >
                        {t("停止这一轮")}
                      </Button>
                    </Tooltip>
                  );
                })()}
              {consequence && (
                <span id={consequenceId} className="invocation-consequence">
                  {consequence}
                </span>
              )}
            </div>
          );
        })}
      </div>
      {selected && (
        <InvocationDetails
          invocation={selected}
          steps={traces?.get(selected.id)}
          label={invocationStatusLabel(
            selected,
            participants.some((p) => p.id === selected.agentId && p.status !== "offline"),
          )}
          agentOnline={participants.some(
            (p) => p.id === selected.agentId && p.status !== "offline",
          )}
          connectionState={connectionState}
          delegation={delegationLines(selected, allInvocations?.values() ?? invocations)}
          others={[...(allInvocations?.values() ?? invocations)]}
          onClose={() => setSelectedId(undefined)}
          {...(onOpenTerminal?.(selected) ? { onOpenTerminal: onOpenTerminal(selected)! } : {})}
          {...(onViewChanges
            ? {
                onViewChanges: () => {
                  setSelectedId(undefined);
                  onViewChanges(selected);
                },
              }
            : {})}
          {...(selected.replyMessageId && canJumpTo(selected.replyMessageId)
            ? {
                onJump: () => {
                  setSelectedId(undefined);
                  onJump(selected.replyMessageId!, selected);
                },
              }
            : {})}
        />
      )}
    </>
  );
}
