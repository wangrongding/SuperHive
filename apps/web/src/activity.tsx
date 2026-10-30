import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ChatMessage, Invocation, Participant, RoomSummary } from "@ai-hive/protocol";
import { delegationSummary, invocationStatusLabel } from "./invocations";
import { formatRelativeTime } from "./whiteboard";

export type ActivityView = "search" | "mentions" | "tasks";

/**
 * 需要人处理的调用：失败、被拦截、结果未知、等人回答。
 * 人点了「忽略」或服务端判定已被后续处理取代（resolution）的不再算。
 */
export function needsAttention(invocation: Invocation): boolean {
  if (invocation.status === "waiting_human") return true;
  return (
    !invocation.resolution &&
    (invocation.status === "failed" ||
      invocation.status === "blocked" ||
      invocation.status === "timed_out")
  );
}

export function isInFlight(invocation: Invocation): boolean {
  return (
    invocation.status === "queued" ||
    invocation.status === "running" ||
    invocation.status === "cancelling"
  );
}

export type AgentRuntimeState = "offline" | "idle" | "working" | "attention" | "waiting";

export type AgentRuntimeRow = {
  participant: Participant;
  state: AgentRuntimeState;
  /** 最近一条进行中或需要处理的调用，决定状态行上展示的进度 */
  current?: Invocation;
  inFlight: number;
  attention: number;
};

const runtimeStateOrder: Record<AgentRuntimeState, number> = {
  waiting: 0,
  attention: 1,
  working: 2,
  idle: 3,
  offline: 4,
};

/**
 * 当前房间每个 Agent 一行：等你回答最先，其次需要处理、工作中、空闲、离线。
 * 只统计未结束的调用；离线的 Agent 即使有排队任务也显示离线，上线后会自动收到。
 */
export function agentRuntimeRows(
  participants: readonly Participant[],
  invocations: Iterable<Invocation>,
): AgentRuntimeRow[] {
  const byAgent = new Map<string, Invocation[]>();
  for (const invocation of invocations) {
    if (!needsAttention(invocation) && !isInFlight(invocation)) continue;
    const list = byAgent.get(invocation.agentId);
    if (list) list.push(invocation);
    else byAgent.set(invocation.agentId, [invocation]);
  }
  return participants
    .filter((participant) => participant.type === "agent")
    .map((participant) => {
      const open = (byAgent.get(participant.id) ?? []).sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      );
      const attention = open.filter(needsAttention);
      const inFlight = open.filter(isInFlight);
      const waiting = attention.find((invocation) => invocation.status === "waiting_human");
      const state: AgentRuntimeState = waiting
        ? "waiting"
        : attention.length > 0
          ? "attention"
          : participant.status === "offline"
            ? "offline"
            : inFlight.some((invocation) => invocation.status !== "queued") ||
                participant.status === "busy"
              ? "working"
              : "idle";
      const current = waiting ?? attention[0] ?? inFlight[0];
      return {
        participant,
        state,
        ...(current ? { current } : {}),
        inFlight: inFlight.length,
        attention: attention.length,
      };
    })
    .sort(
      (a, b) =>
        runtimeStateOrder[a.state] - runtimeStateOrder[b.state] ||
        a.participant.username.localeCompare(b.participant.username),
    );
}

/**
 * 按委派关系把调用排成树：子任务紧跟在上游后面并带缩进深度。
 * 上游不在列表里的调用当作根，保持原有顺序；有环时按首次出现截断，不会死循环。
 */
export function orderByDelegation(
  invocations: readonly Invocation[],
): { invocation: Invocation; depth: number }[] {
  const ids = new Set(invocations.map((invocation) => invocation.id));
  const children = new Map<string, Invocation[]>();
  const roots: Invocation[] = [];
  for (const invocation of invocations) {
    const parent = invocation.parentInvocationId;
    if (parent && parent !== invocation.id && ids.has(parent)) {
      const list = children.get(parent);
      if (list) list.push(invocation);
      else children.set(parent, [invocation]);
    } else roots.push(invocation);
  }
  const ordered: { invocation: Invocation; depth: number }[] = [];
  const seen = new Set<string>();
  const visit = (invocation: Invocation, depth: number) => {
    if (seen.has(invocation.id)) return;
    seen.add(invocation.id);
    ordered.push({ invocation, depth });
    for (const child of children.get(invocation.id) ?? []) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  // 互相指向形成的环没有根，按原顺序补上
  for (const invocation of invocations) visit(invocation, 0);
  return ordered;
}

/** 列表预览只保留文字：去掉代码块、强调、行内代码、引用与列表等 Markdown 标记 */
export function plainPreview(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, " [代码] ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, "$1$2")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s{0,3}(?:>|#{1,6}|[-*+]|\d+\.)\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function preview(content: string, length = 120): string {
  const flat = plainPreview(content);
  return flat.length > length ? `${flat.slice(0, length)}…` : flat;
}

/** 把命中的关键词包成 <mark>，大小写不敏感 */
function Highlight({ text, query }: { text: string; query: string }) {
  const needle = query.trim();
  if (!needle) return <>{text}</>;
  const parts: ReactNode[] = [];
  const lower = text.toLocaleLowerCase();
  const target = needle.toLocaleLowerCase();
  let cursor = 0;
  for (let index = lower.indexOf(target); index >= 0; index = lower.indexOf(target, cursor)) {
    if (index > cursor) parts.push(text.slice(cursor, index));
    parts.push(<mark key={index}>{text.slice(index, index + needle.length)}</mark>);
    cursor = index + needle.length;
  }
  parts.push(text.slice(cursor));
  return <>{parts}</>;
}

type ResultItem = {
  key: string;
  message: ChatMessage;
  unread?: boolean;
  badge?: ReactNode;
  detail?: string;
  /** 委派树里的缩进层级 */
  depth?: number;
};

function ResultList({
  items,
  query = "",
  roomName,
  activeIndex,
  onActivate,
  onHover,
  now,
  offset = 0,
}: {
  offset?: number;
  items: ResultItem[];
  query?: string;
  roomName: (roomId: string) => string;
  activeIndex: number;
  onActivate: (message: ChatMessage) => void;
  onHover: (index: number) => void;
  now: number;
}) {
  return (
    <ul className="activity-results" role="listbox" aria-label="结果">
      {items.map((item, localIndex) => {
        const index = offset + localIndex;
        return (
          <li
            key={item.key}
            role="presentation"
            className={item.depth ? "activity-child" : undefined}
            style={
              item.depth
                ? ({
                    paddingLeft: `${Math.min(item.depth, 4) * 18}px`,
                    "--child-indent": `${Math.min(item.depth, 4) * 18 - 12}px`,
                  } as React.CSSProperties)
                : undefined
            }
          >
            <button
              type="button"
              role="option"
              id={`activity-option-${index}`}
              aria-selected={index === activeIndex}
              className={`activity-result ${index === activeIndex ? "active" : ""} ${item.unread ? "unread" : ""}`}
              onMouseEnter={() => onHover(index)}
              onClick={() => onActivate(item.message)}
            >
              <span className="activity-result-meta">
                {item.badge}
                <strong>{item.message.senderName}</strong>
                <span className="activity-room"># {roomName(item.message.roomId)}</span>
                <time dateTime={item.message.createdAt}>
                  {formatRelativeTime(item.message.createdAt, now)}
                </time>
                {item.unread && <span className="activity-unread" aria-label="未读" />}
              </span>
              <span className="activity-result-text">
                <Highlight text={preview(item.message.content, 160)} query={query} />
              </span>
              {item.detail && <span className="activity-result-detail">{item.detail}</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

const runtimeStateLabels: Record<AgentRuntimeState, string> = {
  waiting: "等你回答",
  attention: "需要处理",
  working: "工作中",
  idle: "空闲",
  offline: "离线",
};

/** 当前房间 Agent 一览：谁在干嘛、谁卡住了，点击跳到它正在处理的消息 */
function AgentRuntimeList({
  rows,
  messageFor,
  onOpen,
}: {
  rows: AgentRuntimeRow[];
  messageFor: (invocation: Invocation) => ChatMessage | undefined;
  onOpen: (message: ChatMessage) => void;
}) {
  return (
    <section aria-label="成员状态">
      <h3 className="activity-section-label">成员状态 · 当前房间</h3>
      <ul className="agent-runtime-list">
        {rows.map((row) => {
          const message = row.current ? messageFor(row.current) : undefined;
          const counts = [
            row.attention ? `${row.attention} 个需处理` : undefined,
            row.inFlight ? `${row.inFlight} 个进行中` : undefined,
          ]
            .filter(Boolean)
            .join(" · ");
          const current = row.current
            ? [
                invocationStatusLabel(row.current, row.state !== "offline"),
                row.current.status === "running" ? row.current.progress : row.current.detail,
              ]
                .filter(Boolean)
                .join(" · ")
            : undefined;
          const content = (
            <>
              <span className={`agent-runtime-dot ${row.state}`} aria-hidden="true" />
              <strong>@{row.participant.username}</strong>
              <span className={`agent-runtime-state ${row.state}`}>
                {runtimeStateLabels[row.state]}
              </span>
              {counts && <span className="agent-runtime-counts">{counts}</span>}
              {current && <span className="agent-runtime-current">{current}</span>}
            </>
          );
          return (
            <li key={row.participant.id}>
              {message ? (
                <button
                  type="button"
                  className="agent-runtime-row"
                  aria-label={`@${row.participant.username} ${runtimeStateLabels[row.state]}，跳到当前任务`}
                  onClick={() => onOpen(message)}
                >
                  {content}
                </button>
              ) : (
                <div className="agent-runtime-row">{content}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function ActivityPanel({
  view,
  rooms,
  mentions,
  readSeqs,
  invocations,
  invocationMessages,
  isAgentOnline,
  participants = [],
  search,
  onOpenMessage,
  onMarkMentionsRead,
  onDismiss,
  onClose,
}: {
  view: ActivityView;
  rooms: RoomSummary[];
  mentions: ChatMessage[];
  readSeqs: Record<string, number>;
  invocations: Invocation[];
  invocationMessages: ReadonlyMap<string, ChatMessage>;
  isAgentOnline: (invocation: Invocation) => boolean;
  /** 当前房间成员，用来展示每个 Agent 的运行状态 */
  participants?: readonly Participant[];
  search: (query: string) => Promise<ChatMessage[]>;
  onOpenMessage: (message: ChatMessage) => void;
  onMarkMentionsRead: () => void;
  /** 把不再需要处理的失败、被拦、结果未知一次性标为已处理 */
  onDismiss?: (invocations: Invocation[]) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [searchState, setSearchState] = useState<{
    query: string;
    results: ChatMessage[];
    status: "idle" | "loading" | "done" | "error";
  }>({ query: "", results: [], status: "idle" });
  const [activeIndex, setActiveIndex] = useState(0);
  // 提及默认只看未读：读过的条目会离开列表，像收件箱一样能"清空"
  const [mentionFilter, setMentionFilter] = useState<"unread" | "all">("unread");
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const now = Date.now();
  const roomNames = useMemo(() => new Map(rooms.map((room) => [room.id, room.name])), [rooms]);
  const roomName = (roomId: string) => roomNames.get(roomId) ?? roomId;

  useEffect(() => {
    setActiveIndex(0);
    if (view === "search") inputRef.current?.focus();
    else panelRef.current?.focus();
  }, [view]);

  // 输入停顿 250ms 后再查询，丢弃过期的响应
  useEffect(() => {
    if (view !== "search") return;
    const text = query.trim();
    if (!text) {
      setSearchState({ query: "", results: [], status: "idle" });
      return;
    }
    let cancelled = false;
    setSearchState((current) => ({ ...current, status: "loading" }));
    const timer = window.setTimeout(() => {
      search(text).then(
        (results) => {
          if (cancelled) return;
          setSearchState({ query: text, results, status: "done" });
          setActiveIndex(0);
        },
        () => !cancelled && setSearchState({ query: text, results: [], status: "error" }),
      );
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, search, view]);

  const taskItems = useMemo(() => {
    const sorted = [...invocations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const toItem = ({
      invocation,
      depth,
    }: {
      invocation: Invocation;
      depth: number;
    }): ResultItem | undefined => {
      const message = invocationMessages.get(invocation.messageId);
      if (!message) return undefined;
      const online = isAgentOnline(invocation);
      const delegation = delegationSummary(invocation, invocations);
      const status = invocation.status === "running" ? invocation.progress : invocation.detail;
      const detail = [status, delegation].filter(Boolean).join(" · ");
      return {
        key: invocation.id,
        message,
        badge: (
          <span className={`activity-status ${invocation.status}`}>
            @{invocation.agentName} · {invocationStatusLabel(invocation, online)}
          </span>
        ),
        ...(detail ? { detail } : {}),
        ...(depth ? { depth } : {}),
      };
    };
    const tree = (list: Invocation[]) =>
      orderByDelegation(list).map(toItem).filter(Boolean) as ResultItem[];
    return {
      waiting: tree(sorted.filter((invocation) => invocation.status === "waiting_human")),
      attention: tree(
        sorted.filter(
          (invocation) => needsAttention(invocation) && invocation.status !== "waiting_human",
        ),
      ),
      inFlight: tree(sorted.filter(isInFlight)),
    };
  }, [invocationMessages, invocations, isAgentOnline]);

  const agentRows = useMemo(
    () => (view === "tasks" ? agentRuntimeRows(participants, invocations) : []),
    [invocations, participants, view],
  );

  const isUnread = (message: ChatMessage) => message.seq > (readSeqs[message.roomId] ?? 0);
  const unreadMentions = mentions.filter(isUnread).length;
  const visibleMentions = mentionFilter === "unread" ? mentions.filter(isUnread) : mentions;

  const items: ResultItem[] =
    view === "search"
      ? searchState.results.map((message) => ({ key: message.id, message }))
      : view === "mentions"
        ? visibleMentions.map((message) => ({
            key: message.id,
            message,
            unread: isUnread(message),
          }))
        : [...taskItems.waiting, ...taskItems.attention, ...taskItems.inFlight];

  const activate = (message: ChatMessage) => {
    onOpenMessage(message);
    onClose();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (items.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % items.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + items.length) % items.length);
    } else if (event.key === "Enter" && items[activeIndex]) {
      event.preventDefault();
      activate(items[activeIndex].message);
    }
  };

  const title = view === "search" ? "搜索消息" : view === "mentions" ? "提及我" : "Agent 任务";

  const listProps = {
    roomName,
    activeIndex,
    onActivate: activate,
    onHover: setActiveIndex,
    now,
  };

  return (
    <div className="activity-layer">
      <button type="button" className="activity-scrim" aria-label="关闭" onClick={onClose} />
      <div
        ref={panelRef}
        className={`activity-panel ${view}`}
        role="dialog"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header className="activity-header">
          {view === "search" ? (
            <input
              ref={inputRef}
              type="search"
              value={query}
              placeholder="搜索所有房间的消息…"
              aria-label="搜索消息"
              aria-controls="activity-results"
              aria-activedescendant={items.length ? `activity-option-${activeIndex}` : undefined}
              onChange={(event) => setQuery(event.target.value)}
            />
          ) : (
            <h2>{title}</h2>
          )}
          {view === "mentions" && (
            <div className="activity-filter" role="group" aria-label="筛选提及">
              <button
                type="button"
                aria-pressed={mentionFilter === "unread"}
                onClick={() => {
                  setMentionFilter("unread");
                  setActiveIndex(0);
                }}
              >
                未读{unreadMentions > 0 ? ` ${unreadMentions}` : ""}
              </button>
              <button
                type="button"
                aria-pressed={mentionFilter === "all"}
                onClick={() => {
                  setMentionFilter("all");
                  setActiveIndex(0);
                }}
              >
                全部
              </button>
            </div>
          )}
          {view === "mentions" && unreadMentions > 0 && (
            <button type="button" className="activity-header-action" onClick={onMarkMentionsRead}>
              全部标为已读
            </button>
          )}
          <button type="button" className="activity-close" aria-label="关闭" onClick={onClose}>
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </button>
        </header>

        <div className="activity-body" id="activity-results">
          {view === "search" &&
            (searchState.status === "idle" ? (
              <p className="activity-empty">输入关键词，按 ↑↓ 选择、Enter 跳到原文。</p>
            ) : searchState.status === "error" ? (
              <p className="activity-empty">搜索失败，请稍后重试。</p>
            ) : searchState.status === "done" && items.length === 0 ? (
              <p className="activity-empty">没有找到包含“{searchState.query}”的消息。</p>
            ) : (
              <ResultList items={items} query={searchState.query} {...listProps} />
            ))}

          {view === "mentions" &&
            (items.length === 0 ? (
              <p className="activity-empty">
                {mentionFilter === "unread" && mentions.length > 0
                  ? "提及都已读完。"
                  : "还没有人在任何房间 @ 你。"}
              </p>
            ) : (
              <ResultList items={items} {...listProps} />
            ))}

          {view === "tasks" && agentRows.length > 0 && (
            <AgentRuntimeList
              rows={agentRows}
              messageFor={(invocation) => invocationMessages.get(invocation.messageId)}
              onOpen={activate}
            />
          )}

          {view === "tasks" &&
            (items.length === 0 ? (
              <p className="activity-empty">当前没有进行中或需要处理的 Agent 调用。</p>
            ) : (
              <>
                {taskItems.waiting.length > 0 && (
                  <section aria-label="等你回答">
                    <h3 className="activity-section-label">
                      等你回答 · {taskItems.waiting.length}
                    </h3>
                    <ResultList items={taskItems.waiting} {...listProps} />
                  </section>
                )}
                {taskItems.attention.length > 0 && (
                  <section aria-label="需要处理">
                    <h3 className="activity-section-label">
                      需要处理 · {taskItems.attention.length}
                      {onDismiss && (
                        <button
                          type="button"
                          className="activity-section-action"
                          title="把这些失败、被拦、结果未知的调用都标为已处理，记录仍可在消息下查看"
                          onClick={() =>
                            onDismiss(
                              invocations.filter(
                                (invocation) =>
                                  needsAttention(invocation) &&
                                  invocation.status !== "waiting_human",
                              ),
                            )
                          }
                        >
                          全部忽略
                        </button>
                      )}
                    </h3>
                    <ResultList
                      items={taskItems.attention}
                      {...listProps}
                      offset={taskItems.waiting.length}
                    />
                  </section>
                )}
                {taskItems.inFlight.length > 0 && (
                  <section aria-label="进行中">
                    <h3 className="activity-section-label">进行中 · {taskItems.inFlight.length}</h3>
                    <ResultList
                      items={taskItems.inFlight}
                      {...listProps}
                      offset={taskItems.waiting.length + taskItems.attention.length}
                    />
                  </section>
                )}
              </>
            ))}
        </div>
      </div>
    </div>
  );
}
