import { useEffect, useState } from "react";
import type { Invocation, Participant } from "@ai-hive/protocol";

/** 被预算拦下但可以由人"续命"的原因；hop_limit 是硬上限，不提供继续操作 */
export function isExtendableBlock(invocation: Invocation): boolean {
  return (
    invocation.status === "blocked" &&
    (invocation.blockReason === "consecutive_limit" || invocation.blockReason === "pair_limit")
  );
}

export function canRetryInvocation(invocation: Invocation): boolean {
  return (
    invocation.status === "failed" ||
    invocation.status === "timed_out" ||
    invocation.status === "cancelled" ||
    (invocation.status === "blocked" && invocation.blockReason !== "hop_limit")
  );
}

export function canCancelInvocation(invocation: Invocation): boolean {
  return (
    invocation.status === "queued" ||
    invocation.status === "running" ||
    invocation.status === "timed_out"
  );
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

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}小时${rest}分` : `${hours}小时`;
}

export function invocationStatusLabel(invocation: Invocation, agentOnline: boolean): string {
  switch (invocation.status) {
    case "queued":
      if (invocation.receivedAt) return "已送达，排队中";
      return agentOnline ? "排队中" : "等待上线";
    case "running":
      return "进行中";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    case "blocked":
      return "已暂停";
    case "timed_out":
      return "结果未知";
    case "cancelled":
      return "已停止";
  }
}

function invocationHint(invocation: Invocation, agentOnline: boolean): string | undefined {
  if (invocation.status === "timed_out") {
    return [invocation.detail, "长时间未收到结果，这不一定是失败，迟到的回复仍可能到达。"]
      .filter(Boolean)
      .join(" · ");
  }
  if (invocation.status === "queued" && !invocation.receivedAt && !agentOnline) {
    return `${invocation.agentName} 当前离线，上线后会自动收到这条消息。`;
  }
  if (invocation.status === "running") return invocation.progress ?? invocation.detail;
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

export function InvocationChips({
  invocations,
  participants,
  canJumpTo,
  onJump,
  onRetry,
  onCancel,
  onExtend,
}: {
  invocations: Invocation[];
  participants: Participant[];
  canJumpTo: (messageId: string) => boolean;
  onJump: (messageId: string) => void;
  onRetry: (invocation: Invocation) => void;
  onCancel: (invocation: Invocation) => void;
  onExtend: () => void;
}) {
  return (
    <div className="invocation-row" role="list" aria-label="Agent 调用状态">
      {invocations.map((invocation) => {
        const agentOnline = participants.some(
          (participant) =>
            participant.id === invocation.agentId && participant.status !== "offline",
        );
        const label = invocationStatusLabel(invocation, agentOnline);
        const rawHint = invocationHint(invocation, agentOnline);
        const hint = rawHint === label ? undefined : rawHint;
        const jumpTarget =
          invocation.status === "completed" &&
          invocation.replyMessageId &&
          canJumpTo(invocation.replyMessageId)
            ? invocation.replyMessageId
            : undefined;
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
            {invocation.status === "running" && invocation.progress && (
              <span className="invocation-progress">{invocation.progress}</span>
            )}
            {(invocation.status === "blocked" ||
              invocation.status === "failed" ||
              // 完成但没有回复消息：Agent 判断无需回复，标出来免得像是漏处理
              (invocation.status === "completed" && !invocation.replyMessageId)) &&
              invocation.detail && <span className="invocation-progress">{invocation.detail}</span>}
            {invocation.status === "running" && (
              <ElapsedTime since={invocation.startedAt ?? invocation.updatedAt} />
            )}
            {invocation.attempts > 1 && (
              <span className="invocation-attempts">第{invocation.attempts}次</span>
            )}
          </>
        );
        const ariaSummary = [
          `@${invocation.agentName}`,
          label,
          invocation.attempts > 1 ? `第${invocation.attempts}次` : undefined,
          hint,
        ]
          .filter(Boolean)
          .join("，");
        return (
          <div
            key={invocation.id}
            role="listitem"
            data-invocation-id={invocation.id}
            className={`invocation-chip ${invocation.status}`}
            title={hint}
            onClick={(event) => event.stopPropagation()}
          >
            {jumpTarget ? (
              <button
                type="button"
                className="invocation-summary"
                aria-label={`${ariaSummary}，跳到回复`}
                onClick={() => onJump(jumpTarget)}
              >
                {summary}
              </button>
            ) : (
              <span className="invocation-summary">
                {summary}
                {hint &&
                  invocation.status !== "running" &&
                  invocation.status !== "blocked" &&
                  invocation.status !== "failed" && (
                    <span className="visually-hidden">，{hint}</span>
                  )}
              </span>
            )}
            {isExtendableBlock(invocation) ? (
              <button
                type="button"
                className="invocation-action primary"
                aria-label={`为 Agent 对话追加 5 轮，恢复 @${invocation.agentName}`}
                onClick={onExtend}
              >
                继续 5 轮
              </button>
            ) : (
              canRetryInvocation(invocation) && (
                <button
                  type="button"
                  className="invocation-action"
                  aria-label={`重试 @${invocation.agentName}`}
                  onClick={() => onRetry(invocation)}
                >
                  重试
                </button>
              )
            )}
            {canCancelInvocation(invocation) && (
              <button
                type="button"
                className="invocation-action subtle"
                aria-label={`停止 @${invocation.agentName}`}
                onClick={() => onCancel(invocation)}
              >
                停止
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
