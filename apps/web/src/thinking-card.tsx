import {
  memo,
  useDeferredValue,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import type { Invocation, TraceStep } from "@superhive/protocol";
import { t } from "./i18n";
import { needsDecision } from "./attention";
import {
  TraceTimeline,
  currentTraceStep,
  formatDuration,
  isLiveInvocation,
  traceSummary,
  useTraceClock,
} from "./live-trace";
import "./styles/thinking-card.css";
import { Tooltip } from "./tooltip";
import { Button } from "./button";

// 和消息正文共用同一个 Markdown 渲染器（独立 chunk，App 启动时已在预加载）；没加载好之前先按纯文本显示
type MarkdownComponent = (typeof import("./message-markdown"))["MessageMarkdown"];
let loadedMarkdown: MarkdownComponent | undefined;
const markdownReady = import("./message-markdown").then((module) => {
  loadedMarkdown = module.MessageMarkdown;
  return module.MessageMarkdown;
});
/** Markdown 渲染器加载好时完成；之后渲染的卡片直接按 Markdown 显示（测试里先等它，免得赶上首次加载） */
export const narrativeMarkdownReady: Promise<unknown> = markdownReady;

function useMarkdown(): MarkdownComponent | undefined {
  const [component, setComponent] = useState(() => loadedMarkdown);
  useLayoutEffect(() => {
    if (component) return;
    let cancelled = false;
    void markdownReady.then((loaded) => {
      if (!cancelled) setComponent(() => loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [component]);
  return component;
}

/**
 * 一段思考或中途的话，按 Markdown 渲染（链接不可点、图片不加载、不渲染 HTML）。
 * 流式更新时用 useDeferredValue 让渲染让位给输入和滚动；没变的段落因 memo 不会重渲染。
 * 没闭合的 ``` 这类中间状态 remark 会按到结尾的代码块显示，不会乱。
 */
const NarrativeMarkdown = memo(function NarrativeMarkdown({ text }: { text: string }) {
  const Markdown = useMarkdown();
  const deferred = useDeferredValue(text);
  return (
    <div className="message-body thinking-card-md">
      {Markdown ? <Markdown content={deferred} inert /> : <p>{deferred}</p>}
    </div>
  );
});

/**
 * 对话流里的「思考中」卡片：Agent 干活时出现在回复将来出现的位置，像一条正在写的回复。
 * 以人话为主：中途说的话、拿得到的思考摘要；命令和文件操作收成一行，点开才是完整时间线。
 * 回复出来后收成回复上方的一行（TraceRecap），过程只在内存里，刷新后没有。
 */

/** 给人看的那部分：中途说的话、有正文的思考 */
export function narrativeSteps(steps: readonly TraceStep[]): TraceStep[] {
  return steps.filter(
    (step) => (step.kind === "text" || step.kind === "thinking") && Boolean(step.text?.trim()),
  );
}

/** 卡片该不该出现：执行中（含停止中），或者这一轮还没结束的等人回答 */
/**
 * 一个 Agent 在房间里同一时间只跑一轮：它把排队的几条消息合在一轮里做时，每条消息各有一条调用、
 * 执行过程也一样，合成一张卡片，标出这一轮在处理哪几条，而不是摆出几张一模一样的卡片。
 * 等人回答的（这一轮已停下）各自单独一张。
 */
export function groupLiveCards(
  invocations: readonly Invocation[],
): Array<{ invocation: Invocation; batch: Invocation[] }> {
  const groups: Array<{ invocation: Invocation; batch: Invocation[] }> = [];
  const byAgent = new Map<string, { invocation: Invocation; batch: Invocation[] }>();
  for (const invocation of invocations) {
    if (!isLiveInvocation(invocation)) {
      groups.push({ invocation, batch: [invocation] });
      continue;
    }
    const group = byAgent.get(invocation.agentId);
    if (group) group.batch.push(invocation);
    else {
      const created = { invocation, batch: [invocation] };
      byAgent.set(invocation.agentId, created);
      groups.push(created);
    }
  }
  return groups;
}

export function showsLiveCard(invocation: Invocation): boolean {
  return (
    isLiveInvocation(invocation) ||
    (invocation.status === "waiting_human" && !invocation.finishedAt)
  );
}

function NarrativeLine({ step }: { step: TraceStep }) {
  return (
    <div
      className={`thinking-card-line ${step.kind}`}
      {...(step.kind === "thinking" ? { "aria-label": t("思考") } : {})}
    >
      <NarrativeMarkdown text={step.text ?? ""} />
    </div>
  );
}

/** 叙述区：新内容到达时跟到底部；用户往上翻了就不再跟，给一个「↓ 最新」回到底部 */
function FollowScroll({
  className,
  live,
  version,
  children,
}: {
  className: string;
  live: boolean;
  /** 内容变了就跟一次 */
  version: unknown;
  children: ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const [behind, setBehind] = useState(false);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && followRef.current) element.scrollTop = element.scrollHeight;
  }, [version]);
  return (
    <div className="thinking-card-narrative-wrap">
      <div
        ref={scrollRef}
        className={className}
        aria-live="off"
        onScroll={(event) => {
          const element = event.currentTarget;
          const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 16;
          followRef.current = atBottom;
          setBehind(!atBottom);
        }}
      >
        {children}
      </div>
      {live && behind && (
        <Button
          size="sm"
          className="thinking-card-latest"
          onClick={() => {
            const element = scrollRef.current;
            if (!element) return;
            followRef.current = true;
            setBehind(false);
            element.scrollTop = element.scrollHeight;
          }}
        >
          {t("↓ 最新")}
        </Button>
      )}
    </div>
  );
}

/** 卡片主体：叙述 + 收起的执行步骤；结束后的回顾用 */
function CardBody({
  invocation,
  steps,
  now,
}: {
  invocation: Invocation;
  steps: readonly TraceStep[];
  now: number;
}) {
  const live = isLiveInvocation(invocation);
  const narrative = narrativeSteps(steps);
  const tools = steps.filter((step) => step.kind !== "text");
  const toolSummary = traceSummary(tools, now);
  return (
    <>
      {narrative.length > 0 && (
        <FollowScroll className="thinking-card-narrative expanded" live={live} version={narrative}>
          {narrative.map((step) => (
            <NarrativeLine key={step.id} step={step} />
          ))}
        </FollowScroll>
      )}
      {tools.length > 0 && (
        <details className="thinking-card-steps">
          <summary>{toolSummary || t("执行步骤 {0} 个", { 0: tools.length })}</summary>
          <div className="thinking-card-timeline">
            <TraceTimeline steps={tools} now={now} live={live} />
          </div>
        </details>
      )}
    </>
  );
}

/**
 * 完整时间线：说的话和执行步骤按发生顺序排在一起（连续的几步命令、文件操作照常合成一组）。
 * 没有正文的思考（只有耗时）归到步骤里。
 */
function FullTimeline({
  steps,
  now,
  live,
}: {
  steps: readonly TraceStep[];
  now: number;
  live: boolean;
}) {
  const narrative = new Set(narrativeSteps(steps));
  const runs: Array<{ key: string; narrative?: TraceStep; tools?: TraceStep[] }> = [];
  for (const step of steps) {
    if (narrative.has(step)) {
      runs.push({ key: step.id, narrative: step });
      continue;
    }
    if (step.kind === "text") continue;
    const last = runs.at(-1);
    if (last?.tools) last.tools.push(step);
    else runs.push({ key: `tools-${step.id}`, tools: [step] });
  }
  return (
    <FollowScroll className="thinking-card-narrative full" live={live} version={steps}>
      {runs.map((run) =>
        run.narrative ? (
          <NarrativeLine key={run.key} step={run.narrative} />
        ) : (
          <div key={run.key} className="thinking-card-timeline-run">
            <TraceTimeline steps={run.tools!} now={now} live={live} />
          </div>
        ),
      )}
    </FollowScroll>
  );
}

/**
 * 卡片显示多少：
 * - line：只留一行状态（谁、在干什么、多久）
 * - recent：再加最近两段话和一行步骤汇总
 * - full：完整时间线
 */
export type CardDetail = "line" | "recent" | "full";

const detailOptions = (): Array<{ id: CardDetail; label: string; title: string }> => [
  { id: "line", label: t("一行"), title: t("只看一行状态") },
  { id: "recent", label: t("最近"), title: t("看最近两段话") },
  { id: "full", label: t("全部"), title: t("看完整时间线") },
];

/** 等人处理的卡片：等你回答（这一轮停下在等人）、等你决定（中途中断，等人点继续或忽略） */
export function cardAttention(invocation: Invocation): "question" | "decide" | undefined {
  if (invocation.status === "waiting_human" && !invocation.finishedAt) return "question";
  if (needsDecision(invocation)) return "decide";
  return undefined;
}

/** 对话流底部的卡片：执行中的，加上等你回答、等你决定的 */
export function showsCard(invocation: Invocation): boolean {
  return showsLiveCard(invocation) || cardAttention(invocation) !== undefined;
}

/** 卡片排序：等你处理的置顶（等你回答在前），其余按开始时间 */
export function sortCards(invocations: readonly Invocation[]): Invocation[] {
  const rank = (invocation: Invocation) => {
    const attention = cardAttention(invocation);
    return attention === "question" ? 0 : attention === "decide" ? 1 : 2;
  };
  return [...invocations].sort(
    (a, b) =>
      rank(a) - rank(b) || (a.startedAt ?? a.createdAt).localeCompare(b.startedAt ?? b.createdAt),
  );
}

function stateLabel(invocation: Invocation, steps: readonly TraceStep[]): string {
  const attention = cardAttention(invocation);
  if (attention === "question") return t("等你回答");
  if (attention === "decide") return t("等你决定");
  if (invocation.status === "cancelling") return t("停止中");
  // 最近一步是还没结束的思考才叫「思考中」，在跑命令、改文件时是「执行中」
  const last = steps.filter((step) => step.kind !== "text").at(-1);
  return last?.kind === "thinking" && !last.endedAt ? t("思考中") : t("执行中");
}

/** 执行中（以及等你处理）的卡片 */
export function ThinkingCard({
  invocation,
  steps,
  avatar,
  traceAllowed = true,
  defaultCollapsed = false,
  batchSeqs = [],
  trigger,
  onJumpToTrigger,
  question,
  onJumpToQuestion,
  onAvatarContextMenu,
  onContextMenu,
  onStop,
  flashed = false,
}: {
  /** 刚从原消息的状态条跳过来、或从这里跳到原消息：短暂高亮，便于两头对上 */
  flashed?: boolean;
  /**
   * 「停止」：只停这一轮，和触发消息下面的「停止」是同一个操作。
   * 没权限停的人（访客停别人发起的）不传，按钮就不出现
   */
  onStop?: () => void;
  /** 右击头像：和成员列表同一套菜单 */
  onAvatarContextMenu?: (event: ReactMouseEvent<HTMLElement>) => void;
  /** 右击卡片其它地方：跳回原消息、@ 它、停止这一轮 */
  onContextMenu?: (event: ReactMouseEvent<HTMLElement>) => void;
  /** 这一轮合在一起处理的几条消息的序号（两条以上才显示） */
  batchSeqs?: number[];
  /** 触发这一轮的那条消息：卡片上写明在处理哪个问题，点了跳过去 */
  trigger?: { seq: number; preview: string };
  onJumpToTrigger?: () => void;
  /**
   * 等你回答时 Agent 发的那条提问：卡片上给一个「看提问 #N」入口，点了跳过去。
   * seq 不知道（旧数据、提问没载入）时按钮只写「看提问」，照样能跳
   */
  question?: { seq?: number; preview?: string };
  onJumpToQuestion?: () => void;
  invocation: Invocation;
  steps: readonly TraceStep[] | undefined;
  avatar: ReactNode;
  /** 当前用户能不能看执行过程（房主，或邀请时开了「看执行过程」的访客） */
  traceAllowed?: boolean;
  /** 同时有多张卡片时，较早的默认只留一行，只展开最新的；用户手动选过以后以用户为准 */
  defaultCollapsed?: boolean;
}) {
  const [userDetail, setUserDetail] = useState<CardDetail>();
  const attention = cardAttention(invocation);
  const live = isLiveInvocation(invocation);
  // 等你处理时，提问消息、失败卡片、提醒、侧栏都已经标出来了，卡片默认只留一行
  const detail = userDetail ?? (defaultCollapsed || attention ? "line" : "recent");
  const now = useTraceClock(invocation);
  const list = steps ?? [];
  const current = currentTraceStep(list);
  const elapsed = formatDuration(now - Date.parse(invocation.startedAt ?? invocation.createdAt));
  const observable = list.length > 0;
  // 看不到过程：访客没获准，或者这种 Runtime 只报心跳——只显示在做、做了多久，不编造过程。
  // 能看、只是第一步还没到（刚开工那一两秒）时叫「启动中」，不能误报成看不到
  const unobservable =
    !observable && (!traceAllowed || invocation.runtime?.observability === "heartbeat");
  const narrative = narrativeSteps(list);
  const tools = list.filter((step) => step.kind !== "text");
  const toolSummary = traceSummary(tools, now);
  const currentText =
    attention === "decide"
      ? (invocation.detail ?? invocation.progress ?? t("中途中断，等你决定是否继续"))
      : observable
        ? current
        : unobservable
          ? t("看不到具体步骤")
          : live
            ? t("启动中")
            : undefined;
  return (
    <article
      className={`thinking-card ${detail}${attention ? ` attention ${attention}` : ""}${flashed ? " jump-flash" : ""}`}
      data-invocation-id={invocation.id}
      onContextMenu={onContextMenu}
      aria-label={
        attention === "question"
          ? t("{0} 在等你回答", { 0: invocation.agentName })
          : attention === "decide"
            ? t("{0} 的任务等你决定", { 0: invocation.agentName })
            : t("{0} 正在处理", { 0: invocation.agentName })
      }
      title={unobservable ? t("这种 Agent 不上报执行过程，或你没有查看执行过程的权限") : undefined}
    >
      <span className="avatar agent" aria-hidden="true" onContextMenu={onAvatarContextMenu}>
        {avatar}
      </span>
      <div className="thinking-card-content">
        <header>
          <strong
            className="message-sender"
            tabIndex={onAvatarContextMenu ? 0 : undefined}
            aria-haspopup={onAvatarContextMenu ? "menu" : undefined}
            onContextMenu={onAvatarContextMenu}
          >
            {invocation.agentName}
          </strong>
          {batchSeqs.length > 1 ? (
            <span className="thinking-card-batch" title={t("这几条消息在同一轮里一起处理")}>
              {t("一起处理 {0}", { 0: batchSeqs.map((seq) => `#${seq}`).join("、") })}
            </span>
          ) : null}
          <span className={`thinking-card-state ${attention ?? invocation.status}`}>
            <span className="thinking-card-dot" aria-hidden="true" />
            {stateLabel(invocation, list)}
          </span>
          {detail === "line" && trigger && (
            // 只留一行时，在处理哪条消息缩成一个序号，点了照样跳过去
            <Tooltip content={t("回应 #{0}：{1}", { 0: trigger.seq, 1: trigger.preview })}>
              <button
                type="button"
                className="thinking-card-trigger-chip"
                aria-label={t("跳到原消息 #{0}：{1}", { 0: trigger.seq, 1: trigger.preview })}
                disabled={!onJumpToTrigger}
                onClick={onJumpToTrigger}
              >
                #{trigger.seq}
              </button>
            </Tooltip>
          )}
          <span className="thinking-card-current" title={currentText}>
            {currentText}
          </span>
          {/* 等人处理时不再计时：这一轮已经停下 */}
          {live && <span className="thinking-card-elapsed">{elapsed}</span>}
          {live && onStop && (
            // 停止中时按钮还在但点不了，停完卡片照常收起
            <Tooltip content={t("只停这一轮，不停 Agent")}>
              <Button
                size="sm"
                aria-label={t("停止 @{0} 这一轮", { 0: invocation.agentName })}
                disabled={invocation.status === "cancelling"}
                onClick={onStop}
              >
                {invocation.status === "cancelling" ? t("停止中…") : t("停止")}
              </Button>
            </Tooltip>
          )}
          {attention === "question" && onJumpToQuestion && (
            <Tooltip
              content={
                question?.preview ? t("提问：{0}", { 0: question.preview }) : t("跳到 Agent 的提问")
              }
            >
              <Button
                size="sm"
                variant="primary"
                className="thinking-card-question"
                aria-label={
                  question?.seq
                    ? t("跳到 {0} 的提问 #{1}", { 0: invocation.agentName, 1: question.seq })
                    : t("跳到 {0} 的提问", { 0: invocation.agentName })
                }
                onClick={onJumpToQuestion}
              >
                {question?.seq ? t("看提问 #{0}", { 0: question.seq }) : t("看提问")}
              </Button>
            </Tooltip>
          )}
          {attention === "decide" && onJumpToTrigger && (
            <Button size="sm" variant="primary" onClick={onJumpToTrigger}>
              {t("去处理")}
            </Button>
          )}
          {observable && (
            <span className="thinking-card-detail" role="group" aria-label={t("显示多少")}>
              {detailOptions().map((option) => (
                <Tooltip key={option.id} content={option.title}>
                  <button
                    type="button"
                    aria-pressed={detail === option.id}
                    onClick={() => setUserDetail(option.id)}
                  >
                    {option.label}
                  </button>
                </Tooltip>
              ))}
            </span>
          )}
        </header>
        {detail !== "line" && trigger && (
          // 在处理哪个问题：引用触发消息的开头，点了跳到那条消息
          <Tooltip content={onJumpToTrigger ? t("跳到 #{0}", { 0: trigger.seq }) : undefined}>
            <button
              type="button"
              className="thinking-card-trigger"
              disabled={!onJumpToTrigger}
              onClick={onJumpToTrigger}
            >
              <span className="thinking-card-trigger-seq">
                {t("回应 #{0}", { 0: trigger.seq })}
              </span>
              <span className="thinking-card-trigger-text">{trigger.preview}</span>
            </button>
          </Tooltip>
        )}
        {detail === "recent" && observable && (
          <>
            {narrative.length > 0 && (
              <FollowScroll
                className="thinking-card-narrative"
                live={live}
                version={narrative.slice(-2)}
              >
                {narrative.slice(-2).map((step) => (
                  <NarrativeLine key={step.id} step={step} />
                ))}
              </FollowScroll>
            )}
            {(tools.length > 0 || narrative.length > 2) && (
              // 步骤只留一行汇总，点了看完整时间线
              <button
                type="button"
                className="thinking-card-expand"
                onClick={() => setUserDetail("full")}
              >
                {[
                  narrative.length > 2
                    ? t("前面还有 {0} 段话", { 0: narrative.length - 2 })
                    : undefined,
                  toolSummary ||
                    (tools.length ? t("执行步骤 {0} 个", { 0: tools.length }) : undefined),
                  t("看完整时间线"),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </button>
            )}
          </>
        )}
        {detail === "full" && observable && <FullTimeline steps={list} now={now} live={live} />}
      </div>
    </article>
  );
}

/** 结束后：收成回复上方（或没回复时触发消息下方）的一行，点开回看这一轮的过程 */
const outcomeLabels: Partial<Record<Invocation["status"], () => string>> = {
  failed: () => t("失败"),
  cancelled: () => t("已停止"),
  timed_out: () => t("结果未知"),
};

/** 最后一段中途的话往往就是最终回复本身：回顾里去掉，免得和下面的回复重复一遍 */
export function withoutFinalReply(steps: readonly TraceStep[], replyText?: string): TraceStep[] {
  const reply = replyText?.trim();
  if (!reply) return [...steps];
  const lastText = [...steps].reverse().find((step) => step.kind === "text" && step.text?.trim());
  const text = lastText?.text?.trim();
  if (!lastText || !text || !(reply === text || reply.startsWith(text) || text.startsWith(reply))) {
    return [...steps];
  }
  return steps.filter((step) => step !== lastText);
}

export function TraceRecap({
  invocation,
  steps: allSteps,
  replyText,
  open: controlledOpen,
  onOpenChange,
}: {
  invocation: Invocation;
  steps: readonly TraceStep[];
  /** 这一轮的回复正文：用来去掉和回复重复的最后一段 */
  replyText?: string;
  /** 由外面控制展开（回复的右键「看这一轮过程」）；不传时自己管 */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const steps = withoutFinalReply(allSteps, replyText);
  const lastWords = narrativeSteps(steps).at(-1);
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = (next: boolean) => {
    setLocalOpen(next);
    onOpenChange?.(next);
  };
  const now = useTraceClock(invocation);
  const start = Date.parse(invocation.startedAt ?? invocation.createdAt);
  const end = Date.parse(invocation.finishedAt ?? invocation.updatedAt);
  const total = Number.isFinite(start) && Number.isFinite(end) ? end - start : 0;
  const outcome = needsDecision(invocation) ? t("等你决定") : outcomeLabels[invocation.status]?.();
  const summary = [
    outcome,
    traceSummary(steps, now),
    total > 0 ? t("用时 {0}", { 0: formatDuration(total) }) : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className={`trace-recap${open ? " open" : ""}`} data-invocation-id={invocation.id}>
      <button
        type="button"
        className="trace-recap-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="trace-recap-caret" aria-hidden="true">
          ▸
        </span>
        {t("{0} 的过程", { 0: invocation.agentName })}
        {summary && <span className="trace-recap-summary">· {summary}</span>}
      </button>
      {open ? (
        <div className="trace-recap-body">
          <CardBody invocation={invocation} steps={steps} now={now} />
        </div>
      ) : (
        lastWords && (
          // 收起时露出这一轮最后那段话的开头几行，点一下展开看完整过程
          <button
            type="button"
            className="trace-recap-preview"
            aria-label={t("展开 {0} 的过程", { 0: invocation.agentName })}
            onClick={() => setOpen(true)}
          >
            <NarrativeLine step={lastWords} />
          </button>
        )
      )}
    </div>
  );
}
