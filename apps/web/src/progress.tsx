import { Fragment, useEffect, useState, type ReactNode } from "react";
import {
  isTaskDirectoryEntry,
  type ChatMessage,
  type Invocation,
  type WhiteboardEntry,
} from "@superhive/protocol";
import {
  attentionKind,
  attentionLabels,
  attentionTarget,
  questionOf,
  type AttentionKind,
} from "./attention";
import { t } from "./i18n";
import { formatRelativeTime } from "./whiteboard";
import { Tooltip } from "./tooltip";
import { Button } from "./button";

/**
 * 「进展」：右侧栏给人看的那一面。白板原文是 Agent 之间的协作记录（提交号、测试数、目录），
 * 这里只挑人关心的三件事，每条一句话：等你处理、在做、最近完成；点一条跳回聊天里对应的那段。
 */

export type ProgressGroup = "attention" | "doing" | "ready" | "done";

/** 跳回聊天的位置：有消息 ID 按 ID 找，只知道序号（摘要里写的 #1234）按序号找 */
export type ProgressTarget = { messageId?: string; messageSeq?: number; invocation?: Invocation };

export type ProgressItem = {
  id: string;
  group: ProgressGroup;
  /** 一句话：Agent 摘要的第一句，或服务端事件拼出的说明 */
  title: string;
  /** 悬停看到的完整原文 */
  detail: string;
  who: string;
  at: string;
  badge?: { label: string; tone: "warning" | "accent" | "success" | "muted" };
  target?: ProgressTarget;
  /** 「在做」里超过 1 天没更新：多半已经没人在做，标灰、排最后、不计数 */
  stale?: boolean;
};

export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/** 「在做」里还算在做的条数（不含超过 1 天没更新的） */
export function activeCount(items: readonly ProgressItem[]): number {
  return items.filter((item) => !item.stale).length;
}

const HEADLINE_MAX = 60;

/**
 * 摘要的第一句：去掉开头的消息引用（#4003）、提交号，截到第一个句号/分号/换行；
 * 旧条目没有按「先一句人话」写，第一句可能很长，超过 60 字截断。
 */
export function progressHeadline(summary: string): string {
  const text = summary
    .trim()
    .replace(/^(?:(?:#\d+|[0-9a-f]{7,40})(?=[\s，,：:、]|[一-鿿])[\s，,：:、]*)+/i, "");
  const sentence = (/^[^。！？!?；;\n]+[！？!?]?/.exec(text)?.[0] ?? text).trim();
  const chars = [...sentence];
  return chars.length > HEADLINE_MAX
    ? `${chars.slice(0, HEADLINE_MAX - 1).join("")}…`
    : sentence || summary.trim();
}

function entryTarget(
  entry: WhiteboardEntry,
  messages: readonly ChatMessage[],
): ProgressTarget | undefined {
  if (entry.messageId) return { messageId: entry.messageId, messageSeq: entry.messageSeq };
  const seq = /#(\d+)/.exec(entry.summary)?.[1];
  if (seq) return { messageSeq: Number(seq) };
  // 旧条目没记来源：退回到作者在这次登记前后发的最后一条消息（只在已载入的消息里找）
  const before = Date.parse(entry.updatedAt) + 60_000;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.deletedAt || message.senderId !== entry.authorId) continue;
    if (Date.parse(message.createdAt) <= before)
      return { messageId: message.id, messageSeq: message.seq };
  }
  return undefined;
}

/** 提问的原话：正文前面有服务端加的「@提问对象 ❓」，结构化正文里取不带它的那段 */
function questionText(question: ChatMessage): string {
  const asked = question.text?.key === "question.ask" ? question.text.params?.question : undefined;
  return typeof asked === "string" ? asked : question.content;
}

const humanKinds: AttentionKind[] = ["question", "approval", "decide"];

function attentionTitle(
  kind: AttentionKind,
  invocation: Invocation,
  question?: ChatMessage,
): string {
  switch (kind) {
    case "question":
      return question
        ? t("{0} 在问：{1}", {
            0: invocation.agentName,
            1: progressHeadline(questionText(question)),
          })
        : t("{0} 在等你回答", { 0: invocation.agentName });
    case "approval":
      return t("{0} 的任务被拦下，等你放行", { 0: invocation.agentName });
    default:
      return t("{0} 中途中断，等你决定继续还是忽略", { 0: invocation.agentName });
  }
}

export function buildProgress({
  roomId,
  entries,
  invocations,
  messages,
  now = Date.now(),
}: {
  roomId: string;
  entries: Iterable<WhiteboardEntry>;
  invocations: Iterable<Invocation>;
  messages: readonly ChatMessage[];
  now?: number;
}): Record<ProgressGroup, ProgressItem[]> {
  const groups: Record<ProgressGroup, ProgressItem[]> = {
    attention: [],
    doing: [],
    ready: [],
    done: [],
  };
  for (const invocation of invocations) {
    if (invocation.roomId !== roomId) continue;
    const kind = attentionKind(invocation);
    if (!kind || !humanKinds.includes(kind)) {
      if (
        !invocation.messageRecalled &&
        ["queued", "running", "cancelling"].includes(invocation.status)
      ) {
        groups.doing.push({
          id: `invocation:${invocation.id}`,
          group: "doing",
          title: t(
            invocation.status === "queued"
              ? "{0} 的任务正在排队"
              : invocation.status === "cancelling"
                ? "{0} 的任务正在停止"
                : "{0} 正在处理",
            { 0: invocation.agentName },
          ),
          detail: invocation.detail ?? "",
          who: invocation.agentName,
          at: invocation.updatedAt,
          target: { messageId: invocation.messageId, invocation },
        });
      }
      continue;
    }
    const question = kind === "question" ? questionOf(invocation, messages) : undefined;
    const target = attentionTarget(invocation, messages, kind);
    // 等你回答：标上提问序号，点了直接跳到那条提问（没载入也按记下的 seq 补拉）
    const questionSeq =
      kind === "question" && target.messageId !== invocation.messageId
        ? target.messageSeq
        : undefined;
    groups.attention.push({
      id: `invocation:${invocation.id}`,
      group: "attention",
      title: attentionTitle(kind, invocation, question),
      detail: question?.content ?? invocation.detail ?? "",
      who: invocation.agentName,
      at: invocation.updatedAt,
      badge: {
        label: questionSeq
          ? t("{0} · 提问 #{1}", { 0: attentionLabels[kind], 1: questionSeq })
          : attentionLabels[kind],
        tone: "warning",
      },
      target,
    });
  }
  for (const entry of entries) {
    if (entry.archivedAt || isTaskDirectoryEntry(entry)) continue;
    const base = {
      id: entry.id,
      title: progressHeadline(entry.summary),
      detail: entry.summary,
      who: entry.authorName,
      at: entry.updatedAt,
      target: entryTarget(entry, messages),
    };
    const stale = now - Date.parse(entry.updatedAt) > STALE_AFTER_MS;
    switch (entry.slot) {
      // 白板阻塞多半卡在外部或别的 Agent，不一定在等人：留在「在做」里标出来，真要人拍板的 Agent 会提问
      case "blocked":
        groups.doing.push({
          ...base,
          group: "doing",
          badge: { label: t("卡住了"), tone: "warning" },
          ...(stale ? { stale } : {}),
        });
        break;
      case "in_progress":
        groups.doing.push({ ...base, group: "doing", ...(stale ? { stale } : {}) });
        break;
      case "ready":
        groups.ready.push({
          ...base,
          group: "ready",
          badge: { label: t("做完待验收"), tone: "success" },
          ...(stale ? { stale } : {}),
        });
        break;
      case "milestone":
        groups.done.push({
          ...base,
          group: "done",
          ...(entry.mergedAt ? { badge: { label: t("已合入"), tone: "muted" as const } } : {}),
        });
        break;
    }
  }
  // 等你处理：等得最久的在前；在做、最近完成：最近有动静的在前，在做里过期的统一排最后
  groups.attention.sort((a, b) => a.at.localeCompare(b.at));
  groups.doing.sort((a, b) => Number(!!a.stale) - Number(!!b.stale) || b.at.localeCompare(a.at));
  groups.ready.sort(
    (first, second) =>
      Number(!!first.stale) - Number(!!second.stale) || second.at.localeCompare(first.at),
  );
  groups.done.sort((a, b) => b.at.localeCompare(a.at));
  return groups;
}

const DONE_PREVIEW = 8;

function ProgressRow({
  item,
  now,
  onLocate,
}: {
  item: ProgressItem;
  now: number;
  onLocate: (target: ProgressTarget) => void;
}) {
  const staleHint = item.stale ? t("超过 1 天没有更新，可能已经没人在做") : "";
  const detail = [item.detail, staleHint].filter(Boolean).join("\n\n");
  const body = (
    <>
      <span className="progress-title">{item.title}</span>
      <span className="progress-meta">
        {item.badge && (
          <span className={`progress-badge ${item.badge.tone}`}>{item.badge.label}</span>
        )}
        <span className="progress-who">{item.who}</span>
        <time dateTime={item.at} title={new Date(item.at).toLocaleString()}>
          {item.stale
            ? t("{0} 天没更新", {
                0: Math.max(1, Math.floor((now - Date.parse(item.at)) / 86_400_000)),
              })
            : formatRelativeTime(item.at, now)}
        </time>
      </span>
    </>
  );
  const target = item.target;
  return (
    <li className={`progress-item ${item.group}`} data-stale={item.stale || undefined}>
      {target ? (
        <Tooltip content={detail ? `${detail}\n\n${t("点击跳到聊天里的这段")}` : undefined}>
          <button type="button" className="progress-row" onClick={() => onLocate(target)}>
            {body}
          </button>
        </Tooltip>
      ) : (
        <div className="progress-row" title={detail || undefined}>
          {body}
        </div>
      )}
    </li>
  );
}

export function ProgressPanel({
  groups,
  onLocate,
  board,
  todos,
}: {
  groups: Record<ProgressGroup, ProgressItem[]>;
  onLocate: (target: ProgressTarget) => void;
  /** 折叠在最下面的 Agent 白板原文 */
  board: ReactNode;
  todos?: ReactNode;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [showAllDone, setShowAllDone] = useState(false);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const sections: Array<{ group: ProgressGroup; label: string; empty: string }> = [
    { group: "attention", label: t("需要你处理"), empty: t("没有要你处理的事") },
    { group: "doing", label: t("进行中"), empty: t("现在没有进行中的工作") },
    { group: "ready", label: t("已就绪"), empty: t("还没有待验收的工作") },
    { group: "done", label: t("里程碑"), empty: t("最近几天没有完成的事") },
  ];
  return (
    <div className="progress">
      {sections.map(({ group, label, empty }) => {
        const items = groups[group];
        const visible = group === "done" && !showAllDone ? items.slice(0, DONE_PREVIEW) : items;
        const count = activeCount(items);
        const headingId = `progress-${group}`;
        return (
          <Fragment key={group}>
            <section
              className={`progress-section ${group}`}
              aria-labelledby={headingId}
              data-empty={items.length === 0 || undefined}
            >
              <h3 id={headingId}>
                <span className="progress-dot" aria-hidden="true" />
                {label}
                {count > 0 && <span className="progress-count">{count}</span>}
              </h3>
              {items.length === 0 ? (
                <p className="progress-empty">{empty}</p>
              ) : (
                <ul>
                  {visible.map((item) => (
                    <ProgressRow key={item.id} item={item} now={now} onLocate={onLocate} />
                  ))}
                </ul>
              )}
              {group === "done" && items.length > DONE_PREVIEW && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="progress-more"
                  onClick={() => setShowAllDone((value) => !value)}
                >
                  {showAllDone ? t("收起") : t("显示全部 {0} 条", { 0: items.length })}
                </Button>
              )}
            </section>
            {group === "attention" && todos}
          </Fragment>
        );
      })}
      <details className="progress-board">
        <summary>
          <span>{t("Agent 白板（原文）")}</span>
          <span className="progress-board-hint">{t("Agent 协作用的原始记录")}</span>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m7 10 5 5 5-5" />
          </svg>
        </summary>
        <div className="progress-board-body">{board}</div>
      </details>
    </div>
  );
}
