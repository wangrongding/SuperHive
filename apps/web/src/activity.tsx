import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  ChatMessage,
  Invocation,
  Participant,
  RoomSummary,
  UsageSummary,
} from "@superhive/protocol";
import { attentionKind } from "./attention";
import { delegationSummary, invocationStatusLabel } from "./invocations";
import { formatRelativeTime } from "./whiteboard";
import { AppDialog } from "./app-dialog";
import { localized, t } from "./i18n";
import { UsageSection } from "./usage";
import { Tooltip } from "./tooltip";
import { Button } from "./button";

export type ActivityView = "search" | "mentions" | "tasks";

/**
 * 需要人处理的调用：失败、被拦截、结果未知、等人回答。
 * 人点了「忽略」或服务端判定已被后续处理取代（resolution）的不再算。
 */
export function needsAttention(invocation: Invocation): boolean {
  return attentionKind(invocation) !== undefined;
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
 * 成员状态分两部分：有事的 Agent（等你回答、需要处理、工作中，或手上还有没结束的调用）逐个列出；
 * 空闲、离线又没事的只计数，收成一行，点开才列。Agent 多的房间不会把任务列表挤到下面。
 */
export function splitRuntimeRows(rows: readonly AgentRuntimeRow[]) {
  const active: AgentRuntimeRow[] = [];
  const idle: AgentRuntimeRow[] = [];
  const offline: AgentRuntimeRow[] = [];
  for (const row of rows) {
    if (row.current || (row.state !== "idle" && row.state !== "offline")) active.push(row);
    else if (row.state === "idle") idle.push(row);
    else offline.push(row);
  }
  return { active, idle, offline };
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

/** 表格分隔行：| --- | :-: |，至少两列或带竖线 */
const TABLE_DIVIDER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$|^\s*\|\s*:?-+:?\s*\|?\s*$/;

/** 常见 HTML 标签；只认这些标签名，正文里的 Array<string> 这类尖括号不受影响 */
const HTML_TAG =
  /<\/?(?:a|abbr|b|big|blockquote|br|center|code|dd|del|details|div|dl|dt|em|font|h[1-6]|hr|i|img|ins|kbd|li|mark|ol|p|picture|pre|q|s|small|source|span|strike|strong|sub|summary|sup|table|tbody|td|tfoot|th|thead|tr|u|ul|video)(?:\s[^<>]*)?\/?>/gi;

/** 表格行：去掉两端竖线，单元格之间用「·」隔开；转义的 \| 是单元格里的字面竖线 */
function tableRow(line: string): string {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, "|"))
    .filter(Boolean)
    .join(" · ");
}

/** 有分隔行的才算表格，表头、数据行换成单元格文字，分隔行整行去掉 */
function flattenTables(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inTable = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!inTable && line.includes("|") && TABLE_DIVIDER.test(lines[index + 1] ?? "")) {
      inTable = true;
      out.push(tableRow(line));
      index += 1;
      continue;
    }
    if (inTable && line.includes("|") && line.trim()) {
      out.push(tableRow(line));
      continue;
    }
    inTable = false;
    out.push(line);
  }
  return out.join("\n");
}

/**
 * 列表预览只保留文字：代码块换成「[代码]」，去掉强调、删除线、行内代码、链接与图片语法、
 * HTML 标签、标题、引用、列表与任务列表标记、分割线，表格单元格用「·」隔开。
 * 行内代码先换成占位符，里面的 ** _ | 这些字面字符不受后面的替换影响。
 */
export function plainPreview(content: string): string {
  const codes: string[] = [];
  const text = content
    .replace(
      /^[ \t]*(`{3,}|~{3,})[^\n]*(?:\n[\s\S]*?)?(?:\n[ \t]*\1[`~]*[ \t]*(?=\n|$)|(?![\s\S]))/gm,
      t(" [代码] "),
    )
    .replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, _ticks: string, code: string) => {
      codes.push(code.trim());
      return `\uE000${codes.length - 1}\uE000`;
    })
    .replace(/<!--[\s\S]*?-->/g, " ");
  return flattenTables(text)
    .replace(/<(https?:\/\/[^>\s]+)>/g, "$1")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(HTML_TAG, "")
    .replace(/^[ \t]*\[[^\]\n]+\]:[ \t]*\S.*$/gm, "")
    .replace(/!\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")
    .replace(/\[([^\]\n]+)\](?:\([^)\n]*\)|\[[^\]\n]*\])/g, "$1")
    .replace(/^[ \t]*(?:(?:[-*_][ \t]*){3,}|=+[ \t]*)$/gm, "")
    .replace(/^[ \t]*(?:>[ \t]?)+/gm, "")
    .replace(/^[ \t]*#{1,6}(?:[ \t]+|$)/gm, "")
    .replace(/[ \t]+#+[ \t]*$/gm, "")
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, "")
    .replace(/\*\*(?=\S)([^\n]*?\S)\*\*|__(?=\S)([^\n]*?\S)__/g, "$1$2")
    .replace(/~~(?=\S)([^\n]*?\S)~~/g, "$1")
    .replace(/(^|[^\w*\\])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, "$1$2")
    .replace(/(^|[^\w\\])_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1$2")
    .replace(/\\([\\`*_{}[\]()#+\-.!|>~<])/g, "$1")
    .replace(/\uE000(\d+)\uE000/g, (_, index: string) => codes[Number(index)] ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function preview(content: string, length = 120): string {
  const flat = plainPreview(content);
  return flat.length > length ? `${flat.slice(0, length)}…` : flat;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 搜索结果的摘要：从命中位置前留一小段上下文截起，保证关键词落在两行预览里。
 * 去 Markdown 后找不到（命中在代码块等被替换的部分）就退回只压缩空白的原文；
 * 仍找不到（关键词被标记拆开）按普通预览处理。
 */
export function searchSnippet(content: string, query: string, length = 160, context = 24): string {
  const needle = query.trim();
  if (!needle) return preview(content, length);
  const pattern = new RegExp(escapeRegExp(needle), "iu");
  let flat = plainPreview(content);
  let index = flat.search(pattern);
  if (index < 0) {
    flat = content.replace(/\s+/g, " ").trim();
    index = flat.search(pattern);
  }
  if (index < 0) return preview(content, length);
  // 命中已在开头一段里就从头显示，不加前省略号
  const start = index <= context ? 0 : index - context;
  const end = Math.min(flat.length, start + length);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end).trim()}${end < flat.length ? "…" : ""}`;
}

/** 把命中的关键词包成 <mark>，大小写不敏感，同一段里命中几处标几处 */
function Highlight({ text, query }: { text: string; query: string }) {
  const needle = query.trim();
  if (!needle) return <>{text}</>;
  const parts = text.split(new RegExp(`(${escapeRegExp(needle)})`, "giu"));
  // split 带捕获组时，奇数位就是命中的部分
  return <>{parts.map((part, index) => (index % 2 ? <mark key={index}>{part}</mark> : part))}</>;
}

type ResultItem = {
  key: string;
  message: ChatMessage;
  invocation?: Invocation;
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
  onActivate: (message: ChatMessage, invocation?: Invocation) => void;
  onHover: (index: number) => void;
  now: number;
}) {
  return (
    <ul className="activity-results" role="listbox" aria-label={t("结果")}>
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
              onClick={() => onActivate(item.message, item.invocation)}
            >
              <span className="activity-result-meta">
                {item.badge}
                <strong>{item.message.senderName}</strong>
                <span className="activity-room"># {roomName(item.message.roomId)}</span>
                <time dateTime={item.message.createdAt}>
                  {formatRelativeTime(item.message.createdAt, now)}
                </time>
                {item.unread && <span className="activity-unread" aria-label={t("未读")} />}
              </span>
              <span className="activity-result-text">
                <Highlight
                  text={
                    query
                      ? searchSnippet(item.message.content, query)
                      : preview(item.message.content, 160)
                  }
                  query={query}
                />
              </span>
              {item.detail && <span className="activity-result-detail">{item.detail}</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

const runtimeStateLabels: Record<AgentRuntimeState, string> = localized(() => ({
  waiting: t("等你回答"),
  attention: t("需要处理"),
  working: t("工作中"),
  idle: t("空闲"),
  offline: t("离线"),
}));

/** 当前房间 Agent 一览：谁在干嘛、谁卡住了，点击跳到它正在处理的消息 */
function AgentRuntimeList({
  rows,
  messageFor,
  onOpen,
}: {
  rows: AgentRuntimeRow[];
  messageFor: (invocation: Invocation) => ChatMessage | undefined;
  onOpen: (message: ChatMessage, invocation?: Invocation) => void;
}) {
  const [showQuiet, setShowQuiet] = useState(false);
  const { active, idle, offline } = splitRuntimeRows(rows);
  const quiet = [...idle, ...offline];
  const quietSummary =
    idle.length && offline.length
      ? t("{0} 个空闲、{1} 个离线", { 0: idle.length, 1: offline.length })
      : idle.length
        ? t("{0} 个空闲", { 0: idle.length })
        : t("{0} 个离线", { 0: offline.length });

  const renderRow = (row: AgentRuntimeRow) => {
    const message = row.current ? messageFor(row.current) : undefined;
    const counts = [
      row.attention ? t("{0} 个需处理", { 0: row.attention }) : undefined,
      row.inFlight ? t("{0} 个进行中", { 0: row.inFlight }) : undefined,
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
        <span className="agent-runtime-head">
          <span className={`agent-runtime-dot ${row.state}`} aria-hidden="true" />
          <strong>@{row.participant.username}</strong>
          <span className={`agent-runtime-state ${row.state}`}>
            {runtimeStateLabels[row.state]}
          </span>
          {counts && <span className="agent-runtime-counts">{counts}</span>}
        </span>
        {current && <span className="agent-runtime-current">{current}</span>}
      </>
    );
    return (
      <li key={row.participant.id}>
        {message ? (
          <button
            type="button"
            className="agent-runtime-row"
            aria-label={t("@{0} {1}，跳到当前任务", {
              0: row.participant.username,
              1: runtimeStateLabels[row.state],
            })}
            onClick={() => onOpen(message, row.current)}
          >
            {content}
          </button>
        ) : (
          <div className="agent-runtime-row">{content}</div>
        )}
      </li>
    );
  };

  return (
    <section className="agent-runtime" aria-label={t("成员状态")}>
      <h3 className="activity-section-label">
        {t("成员状态 · 当前房间")}
        <span className="agent-runtime-total">{rows.length}</span>
      </h3>
      {active.length > 0 ? (
        <ul className="agent-runtime-list">{active.map(renderRow)}</ul>
      ) : (
        <p className="agent-runtime-none">{t("没有 Agent 在忙")}</p>
      )}
      {quiet.length > 0 && (
        <>
          <button
            type="button"
            className="agent-runtime-more"
            aria-expanded={showQuiet}
            onClick={() => setShowQuiet((open) => !open)}
          >
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
              <path d="m6 4 4 4-4 4" />
            </svg>
            {active.length > 0 ? t("另有 {0}", { 0: quietSummary }) : quietSummary}
          </button>
          {showQuiet && <ul className="agent-runtime-list quiet">{quiet.map(renderRow)}</ul>}
        </>
      )}
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
  onOpenTask,
  onMarkMentionsRead,
  onDismiss,
  usageRoomId,
  loadUsage,
  onStartTopic,
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
  onOpenTask?: (invocation: Invocation) => void;
  onMarkMentionsRead: () => void;
  /** 把不再需要处理的失败、被拦、结果未知一次性标为已处理 */
  onDismiss?: (invocations: Invocation[]) => void;
  /** 当前房间：任务面板底部显示它的用量统计 */
  usageRoomId?: string;
  loadUsage?: (roomId: string, days: number, alertTokens: number) => Promise<UsageSummary>;
  onStartTopic?: () => void;
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

  // 切换视图时把焦点放回来；不滚动内容区（人可能正往下翻着看）
  useEffect(() => {
    setActiveIndex(0);
    if (view === "search") inputRef.current?.focus({ preventScroll: true });
    else panelRef.current?.focus({ preventScroll: true });
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
        invocation,
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

  // 有调用结束（带回用量）时刷新用量统计
  const usageRefreshKey = useMemo(
    () =>
      invocations
        .filter((invocation) => invocation.usage)
        .map((invocation) => invocation.updatedAt)
        .sort()
        .at(-1) ?? "",
    [invocations],
  );

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

  const activate = (message: ChatMessage, invocation?: Invocation) => {
    if (invocation?.status === "waiting_human" && onOpenTask) onOpenTask(invocation);
    else onOpenMessage(message);
    onClose();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (items.length === 0 || event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % items.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + items.length) % items.length);
    } else if (event.key === "Enter" && items[activeIndex]) {
      event.preventDefault();
      activate(items[activeIndex].message, items[activeIndex].invocation);
    }
  };

  const title =
    view === "search" ? t("搜索消息") : view === "mentions" ? t("提及我") : t("Agent 任务");

  const listProps = {
    roomName,
    activeIndex,
    onActivate: activate,
    onHover: setActiveIndex,
    now,
  };

  return (
    <AppDialog
      size={view === "search" ? "sm" : view === "mentions" ? "md" : "xl"}
      placement={view === "search" ? "top" : "center"}
      className={`activity-dialog ${view}`}
      title={title}
      header={
        view === "search" ? (
          <input
            ref={inputRef}
            type="search"
            value={query}
            placeholder={t("搜索所有房间的消息…")}
            aria-label={t("搜索消息")}
            aria-controls="activity-results"
            aria-activedescendant={items.length ? `activity-option-${activeIndex}` : undefined}
            onChange={(event) => setQuery(event.target.value)}
          />
        ) : undefined
      }
      tools={
        <>
          {view === "mentions" && (
            <div className="activity-filter" role="group" aria-label={t("筛选提及")}>
              <button
                type="button"
                aria-pressed={mentionFilter === "unread"}
                onClick={() => {
                  setMentionFilter("unread");
                  setActiveIndex(0);
                }}
              >
                {t("未读{0}", { 0: unreadMentions > 0 ? ` ${unreadMentions}` : "" })}
              </button>
              <button
                type="button"
                aria-pressed={mentionFilter === "all"}
                onClick={() => {
                  setMentionFilter("all");
                  setActiveIndex(0);
                }}
              >
                {t("全部")}
              </button>
            </div>
          )}
          {view === "mentions" && unreadMentions > 0 && (
            <Button size="sm" onClick={onMarkMentionsRead}>
              {t("全部标为已读")}
            </Button>
          )}
        </>
      }
      bodyId="activity-results"
      dialogRef={panelRef}
      {...(view === "search" ? { initialFocus: inputRef } : {})}
      onKeyDown={onKeyDown}
      onClose={onClose}
    >
      {view === "search" &&
        (searchState.status === "idle" ? (
          <p className="activity-empty">{t("输入关键词，按 ↑↓ 选择、Enter 跳到原文。")}</p>
        ) : searchState.status === "error" ? (
          <p className="activity-empty">{t("搜索失败，请稍后重试。")}</p>
        ) : searchState.status === "done" && items.length === 0 ? (
          <p className="activity-empty">
            {t("没有找到包含“{0}”的消息。", { 0: searchState.query })}
          </p>
        ) : (
          <ResultList items={items} query={searchState.query} {...listProps} />
        ))}

      {view === "mentions" &&
        (items.length === 0 ? (
          <p className="activity-empty">
            {mentionFilter === "unread" && mentions.length > 0
              ? t("提及都已读完。")
              : t("还没有人在任何房间 @ 你。")}
          </p>
        ) : (
          <ResultList items={items} {...listProps} />
        ))}

      {view === "tasks" && (
        <div className="activity-tasks">
          <div className="activity-tasks-layout">
            <div className="activity-tasks-main">
              {items.length === 0 ? (
                <p className="activity-empty">{t("当前没有进行中或需要处理的 Agent 调用。")}</p>
              ) : (
                <>
                  {taskItems.waiting.length > 0 && (
                    <section aria-label={t("等你回答")}>
                      <h3 className="activity-section-label">
                        {t("等你回答 · {0}", { 0: taskItems.waiting.length })}
                      </h3>
                      <ResultList items={taskItems.waiting} {...listProps} />
                    </section>
                  )}
                  {taskItems.attention.length > 0 && (
                    <section aria-label={t("需要处理")}>
                      <h3 className="activity-section-label">
                        {t("需要处理 ·")} {taskItems.attention.length}
                        {onDismiss && (
                          <Tooltip
                            content={t(
                              "把这些失败、被拦、结果未知的调用都标为已处理，记录仍可在消息下查看",
                            )}
                          >
                            <Button
                              variant="ghost"
                              size="sm"
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
                              {t("全部忽略")}
                            </Button>
                          </Tooltip>
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
                    <section aria-label={t("进行中")}>
                      <h3 className="activity-section-label">
                        {t("进行中 · {0}", { 0: taskItems.inFlight.length })}
                      </h3>
                      <ResultList
                        items={taskItems.inFlight}
                        {...listProps}
                        offset={taskItems.waiting.length + taskItems.attention.length}
                      />
                    </section>
                  )}
                </>
              )}
              {usageRoomId && loadUsage && (
                <UsageSection
                  roomId={usageRoomId}
                  load={loadUsage}
                  refreshKey={usageRefreshKey}
                  participants={participants}
                  {...(onStartTopic ? { onStartTopic } : {})}
                />
              )}
            </div>
            {agentRows.length > 0 && (
              <aside className="activity-tasks-side">
                <AgentRuntimeList
                  rows={agentRows}
                  messageFor={(invocation) => invocationMessages.get(invocation.messageId)}
                  onOpen={activate}
                />
              </aside>
            )}
          </div>
        </div>
      )}
    </AppDialog>
  );
}
