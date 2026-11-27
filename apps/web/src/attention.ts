import {
  failureClass,
  isResumableUnknown,
  type ChatMessage,
  type Invocation,
} from "@superhive/protocol";
import { localized, t } from "./i18n";

/**
 * 「需要你处理」的统一判断：侧栏标记、跨房间提醒、「下一个要我处理的」跳转都用这里，口径一致。
 * - question：Agent 提了问题在等人回答
 * - approval：被拦下等人放行（访客未获批、防循环预算用完）
 * - decide：中途中断（结果未知、上游出错自动继续用完），等人点「继续」或「忽略」
 * - failed：失败
 * - unknown：结果未知（中断、超时，可能做了一半）
 * - unseen：做完了，但发起人还没回去看
 * 人点了「忽略」或服务端判定已被后续处理取代（resolution）的不再算。
 */
export type AttentionKind = "question" | "approval" | "decide" | "failed" | "unknown" | "unseen";

/** 上游模型服务出错中断（Bridge 写的说明以此开头）：重试即接着原会话继续 */
export const UPSTREAM_FAILURE_PREFIX = "上游模型服务出错";

export function isUpstreamInterrupted(invocation: Invocation): boolean {
  return (
    invocation.status === "failed" &&
    // 新版 Bridge 带结构化文案，按键判断；旧版只有中文说明，按前缀判断
    (invocation.detailText
      ? invocation.detailText.key === "bridge.upstreamFailed"
      : Boolean(invocation.detail?.startsWith(UPSTREAM_FAILURE_PREFIX)))
  );
}

/**
 * 中途中断、等人决定的调用：Agent 确认自己已不在跑这一轮的结果未知（见 protocol 的白名单）、
 * 从没确认收到，或上游出错自动继续的次数用完。不当成失败：点「继续」会接着原会话核对现状再往下做。
 * 「继续」还要求 Agent 在线（与服务端 retryInvocation 一致），由显示按钮的地方判断
 */
export function needsDecision(invocation: Invocation): boolean {
  if (invocation.resolution || invocation.messageRecalled) return false;
  return isResumableUnknown(invocation) || isUpstreamInterrupted(invocation);
}

/**
 * 失败卡片「重试 / 继续 / 换个模型重试」按钮下的一句后果说明：点了会不会把做过的事再做一遍。
 * 按 Bridge 上报的失败类别（见 protocol 的 failureClass）给固定说法；只在有这些按钮的状态下返回。
 */
export function retryConsequence(invocation: Invocation): string | undefined {
  if (invocation.resolution) return undefined;
  const decide = needsDecision(invocation);
  if (invocation.status !== "failed" && !decide) return undefined;
  if (invocation.detailText?.key === "bridge.modelFailed")
    return t("还没执行完；用原模型重试还会失败，换个模型重试只对这一次生效");
  switch (failureClass(invocation)) {
    case "transient":
      return decide ? t("还没开始执行，继续安全") : t("还没开始执行，重试安全");
    case "uncertain":
      if (decide) return t("可能已执行过一部分，继续会先核对已做的，不从头重做");
      return invocation.detailText?.key === "bridge.sessionInvalid"
        ? t("已执行过工具，重试会开新会话从头做；先核对已做的再点")
        : t("可能已执行过一部分，重试会重新执行；先核对已做的再点");
    case "unsafe":
      return t("已拒绝，没有往下执行；原因不解决，重试还会被拒");
    default:
      return decide ? undefined : t("原因不明，重试会从头执行这一轮");
  }
}

export type AttentionItem = {
  invocation: Invocation;
  kind: AttentionKind;
  roomId: string;
  messageId: string;
  messageSeq?: number;
  /** 进入这个状态的时间 */
  at: string;
};

/** 越小越该先处理：等人回答最急，完成未看最不急 */
const priority: Record<AttentionKind, number> = {
  question: 0,
  approval: 1,
  decide: 2,
  failed: 3,
  unknown: 4,
  unseen: 5,
};

export const attentionLabels = localized((): Record<AttentionKind, string> => ({
  question: t("等你回答"),
  approval: t("等你放行"),
  decide: t("等你决定"),
  failed: t("失败"),
  unknown: t("结果未知"),
  unseen: t("完成未看"),
}));

/** 仍在进行或需要处理的调用（不含完成未看）属于哪一类；不需要处理时返回 undefined */
export function attentionKind(invocation: Invocation): AttentionKind | undefined {
  if (invocation.messageRecalled) return undefined;
  if (invocation.status === "waiting_human") return "question";
  if (invocation.resolution) return undefined;
  if (needsDecision(invocation)) return "decide";
  switch (invocation.status) {
    case "blocked":
      return "approval";
    case "failed":
      return "failed";
    case "timed_out":
      return "unknown";
    default:
      return undefined;
  }
}

/** 做完了：完成未看只算正常完成的 */
export function isCompleted(invocation: Invocation): boolean {
  return !invocation.messageRecalled && invocation.status === "completed";
}

/**
 * 这条调用的结果是不是该提醒「我」：我发起的（requesterId 优先，旧数据按名字），
 * 或者我是房主、它被拦下在等房主放行。
 */
export function concernsMe(
  invocation: Invocation,
  me: { username: string; participantIds?: ReadonlySet<string>; isOwner?: boolean },
): boolean {
  if (me.isOwner && invocation.status === "blocked") return true;
  if (invocation.requesterType !== "human") return false;
  if (invocation.requesterId && me.participantIds?.size) {
    return me.participantIds.has(invocation.requesterId);
  }
  return invocation.requesterName.toLocaleLowerCase() === me.username.toLocaleLowerCase();
}

/**
 * 状态变化后是否新进入了需要提醒的状态：从别的状态变成等人回答、被拦、失败、未知，
 * 或从进行中变成完成。同一状态的重复推送（进度、心跳）不算，避免反复提醒。
 */
export function attentionTransition(
  previous: Invocation | undefined,
  next: Invocation,
): AttentionKind | undefined {
  const kind = attentionKind(next);
  if (kind) {
    return previous && attentionKind(previous) === kind && previous.attempts === next.attempts
      ? undefined
      : kind;
  }
  if (isCompleted(next) && previous && !isCompleted(previous)) return "unseen";
  return undefined;
}

/**
 * 汇总所有需要处理的事项，按紧急程度排序；同一类里先进入的排前面（等得最久的先处理）。
 * unseen 传入的是「完成但还没看」的调用，由调用方维护（看过即移除）。
 */
export function collectAttention(
  active: Iterable<Invocation>,
  unseen: Iterable<Invocation> = [],
  messages: readonly ChatMessage[] = [],
): AttentionItem[] {
  const items = new Map<string, AttentionItem>();
  for (const invocation of active) {
    const kind = attentionKind(invocation);
    if (kind) items.set(invocation.id, toItem(invocation, kind, messages));
  }
  for (const invocation of unseen) {
    if (!items.has(invocation.id)) items.set(invocation.id, toItem(invocation, "unseen", messages));
  }
  return [...items.values()].sort(
    (a, b) => priority[a.kind] - priority[b.kind] || a.at.localeCompare(b.at),
  );
}

/**
 * 这次等人回答对应的提问。新服务端在调用上记下了提问（questionMessageId）：载入了就用它，
 * 撤回了或没载入返回 undefined（没载入时 attentionTarget 照样按记下的 seq 跳）；
 * 旧数据没有这项，退回在已载入的消息里找同一 Agent 挂在触发消息下的最近一条提问。
 */
export function questionOf(
  invocation: Invocation,
  messages: readonly ChatMessage[],
): ChatMessage | undefined {
  if (invocation.questionMessageId) {
    const recorded = messages.find(
      (message) =>
        message.roomId === invocation.roomId && message.id === invocation.questionMessageId,
    );
    return recorded && !recorded.deletedAt ? recorded : undefined;
  }
  return messages.reduce<ChatMessage | undefined>((latest, message) => {
    if (
      message.roomId !== invocation.roomId ||
      message.kind !== "question" ||
      message.deletedAt ||
      message.senderId !== invocation.agentId ||
      message.parentMessageId !== invocation.messageId
    )
      return latest;
    return !latest || message.seq > latest.seq ? message : latest;
  }, undefined);
}

/**
 * 调用上记下、但还没载入的提问：按 id + seq 直接跳（跳转时补拉）。
 * 已载入却被撤回的不算，退回触发消息。
 */
export function unloadedQuestion(
  invocation: Invocation,
  messages: readonly ChatMessage[],
): { messageId: string; messageSeq: number } | undefined {
  const { questionMessageId, questionSeq } = invocation;
  if (!questionMessageId || !questionSeq) return undefined;
  if (messages.some((message) => message.id === questionMessageId)) return undefined;
  return { messageId: questionMessageId, messageSeq: questionSeq };
}

export type AttentionTarget = {
  invocation: Invocation;
  roomId: string;
  messageId: string;
  messageSeq?: number;
};

export function attentionTarget(
  invocation: Invocation,
  messages: readonly ChatMessage[],
  kind = attentionKind(invocation) ?? (isCompleted(invocation) ? "unseen" : undefined),
): AttentionTarget {
  if (kind === "question") {
    const pending = unloadedQuestion(invocation, messages);
    if (pending) return { invocation, roomId: invocation.roomId, ...pending };
  }
  const question = kind === "question" ? questionOf(invocation, messages) : undefined;
  const messageId =
    question?.id ??
    (kind === "unseen" ? invocation.replyMessageId : undefined) ??
    invocation.messageId;
  const message = messages.find(
    (item) => item.roomId === invocation.roomId && item.id === messageId,
  );
  return {
    invocation,
    roomId: invocation.roomId,
    messageId,
    ...(message ? { messageSeq: message.seq } : {}),
  };
}

function toItem(
  invocation: Invocation,
  kind: AttentionKind,
  messages: readonly ChatMessage[],
): AttentionItem {
  return {
    ...attentionTarget(invocation, messages, kind),
    kind,
    at: invocation.finishedAt ?? invocation.updatedAt,
  };
}

/** 每个房间需要处理的条数和最急的一类：侧栏标记据此显示 */
export function attentionByRoom(
  items: readonly AttentionItem[],
): Map<string, { count: number; top: AttentionKind }> {
  const rooms = new Map<string, { count: number; top: AttentionKind }>();
  for (const item of items) {
    const entry = rooms.get(item.roomId);
    if (!entry) rooms.set(item.roomId, { count: 1, top: item.kind });
    else {
      entry.count += 1;
      if (priority[item.kind] < priority[entry.top]) entry.top = item.kind;
    }
  }
  return rooms;
}

/** 「下一个要我处理的」：在排好序的列表里取 current 之后的一条，到尾回到第一条 */
export function nextAttention(
  items: readonly AttentionItem[],
  currentInvocationId?: string,
): AttentionItem | undefined {
  if (items.length === 0) return undefined;
  const index = currentInvocationId
    ? items.findIndex((item) => item.invocation.id === currentInvocationId)
    : -1;
  return items[(index + 1) % items.length];
}

/** 需要处理的房间排在前面；同一组里保持传入的（手动拖拽的）顺序 */
export function pinAttentionRooms<T extends { id: string }>(
  rooms: readonly T[],
  byRoom: ReadonlyMap<string, unknown>,
): T[] {
  return [
    ...rooms.filter((room) => byRoom.has(room.id)),
    ...rooms.filter((room) => !byRoom.has(room.id)),
  ];
}
