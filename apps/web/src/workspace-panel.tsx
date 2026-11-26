import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  lazy,
  Suspense,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type {
  WorkspaceChange,
  WorkspaceChangeGroup,
  WorkspaceChangeStatus,
  WorkspaceChangeSet,
  WorkspaceCommit,
  WorkspaceDiff,
  WorkspaceDiffMode,
  WorkspaceFile,
  WorkspaceOverview,
  WorkspaceSourceInfo,
  WorkspaceSearch,
  WorkspaceStatus,
  WorkspaceTree,
  WorkspaceTreeEntry,
} from "@superhive/protocol";
import { getLocale, t } from "./i18n";
import { SplitResizer, useSplitWidth } from "./split-resizer";
import { formatRelativeTime } from "./whiteboard";
import { isTextOffice, officeKind } from "./office-preview/office-kind";
import { Select } from "./select";
import { SheetPanel } from "./sheet-panel";
import { serverError } from "./server-text";
import {
  DownloadButton,
  MediaCompare,
  MediaView,
  WorkspaceRevealContext,
  changeSides,
  mediaKind,
  type RawUrlApi,
} from "./workspace-media";
import {
  MAX_RENDERED_DIFF_LINES,
  diffBlocks,
  diffStats,
  formatBytes,
  highlightHunks,
  highlightLines,
  isProseFile,
  languageFor,
  parsePatch,
  splitRows,
  type DiffLine,
  type Token,
} from "./workspace-diff";
import { Tooltip } from "./tooltip";
import { Button, IconButton } from "./button";

// .md 默认按文档排版看（和附件预览同一套），能切回带行号的源码
const WorkspaceDoc = lazy(() =>
  import("./doc-markdown").then((module) => ({ default: module.DocMarkdown })),
);
const MARKDOWN_FILE = /\.(md|markdown|mdx)$/i;

/**
 * 房间工作区面板：从聊天头部「代码」打开的宽抽屉，只读。
 * - 变更：git status 分组（或 worktree 相对 base 的全部改动），点文件看 diff（统一 / 左右对照、高亮、折叠未改动）；
 * - 文件：懒加载的目录树（默认遵守 .gitignore）、按文件名搜索、只读预览；
 * - 提交：最近提交，点开看那次提交改了什么。
 * 打开时每隔几秒刷新变更，关上就不再请求。权限由服务端校验，这里只按结果显示。
 */

type Tab = "changes" | "files" | "commits";
type DiffView = "unified" | "split";

const VIEW_KEY = "superhive.workspace-diff-view";
/** 自动换行：正文类文件、代码文件分开记，各自的默认值不同 */
const WRAP_KEY = "superhive.workspace-wrap";
/** 打开时变更列表的刷新间隔 */
const STATUS_REFRESH_MS = 4000;

/** 面板的只读请求；base 是 Server 地址，拼临时链接（图片、音视频）用 */
export type WorkspaceApi = RawUrlApi;

/** 带上令牌的只读请求；失败时抛出服务端给的说明 */
export function workspaceApi(
  base: string,
  roomId: string,
  token: string | undefined,
): WorkspaceApi {
  const request = async (path: string, query: Record<string, string | undefined> = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query))
      if (value !== undefined) params.set(key, value);
    const search = params.toString();
    const response = await fetch(
      `${base}/api/rooms/${encodeURIComponent(roomId)}/workspace${path}${search ? `?${search}` : ""}`,
      { headers: token ? { Authorization: `Bearer ${token}` } : {}, cache: "no-store" },
    );
    const body: unknown = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(serverError(body) ?? t("加载失败（{0}）", { 0: response.status }));
    return body;
  };
  return Object.assign(request, { base });
}

function useAsync<T>(load: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({
    loading: true,
  });
  const version = useRef(0);
  const run = useCallback(async (quiet = false) => {
    const current = ++version.current;
    if (!quiet) setState((previous) => ({ ...previous, loading: true }));
    try {
      const data = await load();
      if (current === version.current) setState({ data, loading: false });
    } catch (reason) {
      if (current === version.current)
        setState((previous) => ({
          ...(quiet ? previous : {}),
          error: reason instanceof Error ? reason.message : String(reason),
          loading: false,
        }));
    }
  }, deps);
  useEffect(() => {
    void run();
  }, [run]);
  return { ...state, reload: run };
}

/** 面板打开、页面在前台时按间隔静默刷新 */
function useInterval(callback: () => void, ms: number, enabled: boolean) {
  const saved = useRef(callback);
  saved.current = callback;
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") saved.current();
    }, ms);
    return () => window.clearInterval(timer);
  }, [ms, enabled]);
}

export function WorkspaceGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m8 7-5 5 5 5M16 7l5 5-5 5M13.5 4l-3 16" />
    </svg>
  );
}

const EMPTY_ICONS: Record<string, ReactNode> = {
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  check: <path d="M20 6 9 17l-5-5" />,
  file: <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5" />,
  diff: (
    <path d="M8 3v12M5 6h6M14 18h6M17 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM7 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" />
  ),
  commit: <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 12h6M15 12h6" />,
};

/** 空状态：图标 + 一句话 + 次要说明（和「产物」面板一致）；compact 用在左栏列表里 */
function EmptyState({
  icon,
  title,
  hint,
  compact = false,
  children,
}: {
  icon: keyof typeof EMPTY_ICONS;
  title: string;
  hint?: string;
  compact?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={`workspace-empty-state ${compact ? "compact" : ""}`}>
      <span className="workspace-empty-icon" aria-hidden="true">
        <svg
          width={compact ? 16 : 20}
          height={compact ? 16 : 20}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {EMPTY_ICONS[icon]}
        </svg>
      </span>
      <p className="workspace-empty-title">{title}</p>
      {hint && <p className="workspace-empty-hint">{hint}</p>}
      {children}
    </div>
  );
}

const SOURCE_KEY = "superhive.workspace-source";

/** 打开面板时要定位到哪：某个 Agent 的任务线、某份代码、某个提交；nonce 变了就再定位一次 */
export type WorkspaceFocus = {
  agent?: string;
  source?: string;
  commit?: string;
  nonce: number;
};

/** 工作区在前；任务线按最近改动排，已合入（或没改过）的、目录不存在的放最后 */
export function sortSources(sources: WorkspaceSourceInfo[]): WorkspaceSourceInfo[] {
  const rank = (item: WorkspaceSourceInfo) =>
    item.kind === "workspace" ? 0 : item.missing ? 3 : item.merged ? 2 : 1;
  return [...sources].sort(
    (a, b) => rank(a) - rank(b) || (b.activeAt ?? "").localeCompare(a.activeAt ?? ""),
  );
}

/**
 * 打开面板时默认看哪份代码：
 * 「看改动」点的那个 Agent 最近的任务线 → 上次手动选的（还在、没合入）→ 工作区有未提交改动就看工作区
 * → 最近有改动、还没合入的任务线 → 工作区。大部分改动在 Agent 各自的任务线上，main 往往是干净的。
 */
export function defaultSource(
  sources: WorkspaceSourceInfo[],
  options: { remembered?: string | undefined; agent?: string | undefined } = {},
): string {
  const live = sources.filter((item) => item.kind === "worktree" && !item.missing);
  const latest = (items: WorkspaceSourceInfo[]) =>
    sortSources(items).find((item) => item.kind === "worktree")?.id;
  if (options.agent) {
    const lower = options.agent.toLocaleLowerCase();
    const mine = live.filter((item) => item.agentName?.toLocaleLowerCase() === lower);
    return latest(mine.filter((item) => !item.merged)) ?? latest(mine) ?? "workspace";
  }
  const remembered = sources.find((item) => item.id === options.remembered);
  if (remembered && !remembered.missing && !remembered.merged) return remembered.id;
  const workspace = sources.find((item) => item.kind === "workspace");
  if (workspace?.changeCount) return "workspace";
  return latest(live.filter((item) => !item.merged && item.activeAt)) ?? "workspace";
}

/** 下拉里每份代码后面的改动情况：未提交几个文件、领先几个提交、多久前改的、已合入 */
function sourceActivity(item: WorkspaceSourceInfo): string[] {
  if (item.missing) return [];
  if (item.merged) return [t("已合入")];
  const parts: string[] = [];
  if (item.changeCount) parts.push(t("{0} 个文件未提交", { 0: item.changeCount }));
  if (item.ahead) parts.push(t("领先 {0} 个提交", { 0: item.ahead }));
  if (item.activeAt) parts.push(formatRelativeTime(item.activeAt, Date.now()));
  return parts;
}

const LIST_WIDTH_KEY = "superhive.workspace-list-width";
const LIST_DEFAULT_WIDTH = 300;
const LIST_MIN_WIDTH = 220;

/** 左栏（改动 / 文件树 / 提交）+ 右侧内容；中间的分隔条拖动调宽，三个视图共用一个宽度 */
function SplitLayout({ narrow, children }: { narrow: boolean; children: ReactNode }) {
  const split = useSplitWidth(LIST_WIDTH_KEY, LIST_DEFAULT_WIDTH, LIST_MIN_WIDTH);
  return (
    <div
      className={`workspace-split ${narrow ? "narrow" : ""}`}
      style={
        narrow ? undefined : ({ "--workspace-list-width": `${split.width}px` } as CSSProperties)
      }
    >
      {children}
      {!narrow && (
        <SplitResizer
          width={split.width}
          min={LIST_MIN_WIDTH}
          onChange={split.set}
          label={t("拖动调整左栏宽度，双击恢复默认")}
        />
      )}
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className={`workspace-chevron ${open ? "open" : ""}`}
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

function FileGlyph({ directory }: { directory?: boolean }) {
  return (
    <svg
      className="workspace-file-glyph"
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
      {directory ? (
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      ) : (
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5" />
      )}
    </svg>
  );
}

const STATUS_LABELS: Record<string, () => string> = {
  M: () => t("修改"),
  A: () => t("新增"),
  D: () => t("删除"),
  R: () => t("重命名"),
  C: () => t("复制"),
  T: () => t("类型变化"),
  U: () => t("冲突"),
  "?": () => t("未跟踪"),
};

function StatusBadge({ status }: { status: string }) {
  const label = STATUS_LABELS[status]?.() ?? status;
  return (
    <span
      className={`workspace-status status-${status === "?" ? "untracked" : status}`}
      title={label}
    >
      {/* 和 VS Code 一样：未跟踪显示 U，冲突显示 !（git 的 U 是冲突，容易混） */}
      <span aria-hidden="true">{status === "?" ? "U" : status === "U" ? "!" : status}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

function Counts({
  additions,
  deletions,
  binary,
}: Pick<WorkspaceChange, "additions" | "deletions" | "binary">) {
  if (binary) return <span className="workspace-counts binary">{t("二进制")}</span>;
  if (additions === undefined && deletions === undefined) return null;
  return (
    <span className="workspace-counts">
      {additions ? <span className="add">+{additions}</span> : null}
      {deletions ? <span className="del">−{deletions}</span> : null}
    </span>
  );
}

const GROUP_ORDER: WorkspaceChangeGroup[] = ["conflict", "staged", "unstaged", "untracked"];
const GROUP_LABELS: Record<WorkspaceChangeGroup, () => string> = {
  conflict: () => t("冲突"),
  staged: () => t("已暂存"),
  unstaged: () => t("未暂存"),
  untracked: () => t("未跟踪"),
};

type SelectedChange = {
  path: string;
  oldPath?: string;
  mode: WorkspaceDiffMode;
  commit?: string;
  /** 新增的图片没有改前、删除的没有改后 */
  status?: WorkspaceChangeStatus;
  /** 用来在内容变了时重新取 diff */
  revision: string;
};

function changeKey(change: { path: string; mode: string; commit?: string }) {
  return `${change.mode}:${change.commit ?? ""}:${change.path}`;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(getLocale(), {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function WorkspacePanel({
  api,
  roomId,
  workspaceConfigured,
  isOwner,
  onClose,
  onOpenSettings,
  onOverview,
  revealFile,
  focus,
}: {
  api: WorkspaceApi;
  roomId: string;
  /** 房间设了工作区：没设时直接给说明，不发请求 */
  workspaceConfigured: boolean;
  isOwner: boolean;
  onClose: () => void;
  /** 打开房间设置（设工作区、允许访客查看） */
  onOpenSettings?: () => void;
  /** 总览刷新后通知外面（头部入口上的改动数） */
  onOverview?: (overview: WorkspaceOverview) => void;
  /** 本机房主：在访达里显示文件（代替下载）；远程设备、访客不传 */
  revealFile?: ((source: string, path: string) => Promise<void>) | undefined;
  /** 「看改动」：切到这个 Agent 最近的任务线；nonce 变了就再切一次 */
  focus?: WorkspaceFocus | undefined;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const [narrow, setNarrow] = useState(false);
  const [tab, setTab] = useState<Tab>("changes");
  // 看哪份代码：没定下来时（刚打开、换房间、选中的被清理了）按 defaultSource 挑一次，之后不随刷新跳动
  const [sourceId, setSourceId] = useState<string>();
  const [refreshTick, setRefreshTick] = useState(0);
  const overview = useAsync(async () => {
    if (!workspaceConfigured) return undefined;
    const next = (await api("", { detail: "1" })) as WorkspaceOverview;
    onOverview?.(next);
    return next;
  }, [api, workspaceConfigured, refreshTick]);
  const sources = useMemo(() => sortSources(overview.data?.sources ?? []), [overview.data]);
  const source = sources.find((item) => item.id === sourceId);
  const pendingFocus = useRef(focus?.agent);
  const pendingSource = useRef(focus?.source);
  const [focusCommit, setFocusCommit] = useState(focus?.commit);
  useEffect(() => {
    if (!overview.data) return;
    if (sourceId !== undefined && overview.data.sources.some((item) => item.id === sourceId))
      return;
    const wanted = pendingSource.current;
    setSourceId(
      wanted && overview.data.sources.some((item) => item.id === wanted)
        ? wanted
        : defaultSource(overview.data.sources, {
            remembered: localStorage.getItem(`${SOURCE_KEY}:${roomId}`) ?? undefined,
            agent: pendingFocus.current,
          }),
    );
    pendingFocus.current = undefined;
    pendingSource.current = undefined;
  }, [overview.data, sourceId, roomId]);
  useEffect(() => {
    setSourceId(undefined);
    setTab(focus?.commit ? "commits" : "changes");
    // 只在换房间时复位；focus 由下面单独处理
  }, [roomId]);
  // 「看改动」、点消息里的提交号 / 分支名：切到对应的那份代码，提交号还要打开「最近提交」里的那一条
  useEffect(() => {
    if (!focus) return;
    pendingFocus.current = focus.agent;
    pendingSource.current = focus.source;
    setSourceId(undefined);
    setFocusCommit(focus.commit);
    setTab(focus.commit ? "commits" : "changes");
  }, [focus]);
  const chooseSource = (id: string) => {
    localStorage.setItem(`${SOURCE_KEY}:${roomId}`, id);
    setSourceId(id);
  };

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) =>
      setNarrow((entry?.contentRect.width ?? 0) < 760),
    );
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "changes", label: t("改动") },
    { id: "files", label: t("文件树") },
    ...(overview.data?.git ? [{ id: "commits" as const, label: t("最近提交") }] : []),
  ];
  const changeCount = source?.id === "workspace" ? overview.data?.changeCount : undefined;
  // 分段控件的滑块：量出选中那一格的位置和宽度，切换时滑过去（和右侧栏标签一样）
  const tabsRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = tabsRef.current;
    const active = element?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!element || !active) return;
    element.style.setProperty("--tab-indicator-x", `${active.offsetLeft}px`);
    element.style.setProperty("--tab-indicator-width", `${active.offsetWidth}px`);
    const frame = window.requestAnimationFrame(() => element.classList.add("indicator-ready"));
    return () => window.cancelAnimationFrame(frame);
  });
  const sourceQuery = source?.id ?? "workspace";

  let body: ReactNode;
  if (!workspaceConfigured || overview.data?.configured === false) {
    body = (
      <EmptyState
        icon="folder"
        title={t("这个房间还没有设工作区。")}
        hint={t("设好工作区后，可以在这里浏览文件、查看 Agent 改了哪些代码。")}
      >
        {isOwner && onOpenSettings && (
          <Button variant="primary" className="workspace-empty-action" onClick={onOpenSettings}>
            {t("去设置工作区")}
          </Button>
        )}
      </EmptyState>
    );
  } else if (overview.error && !overview.data) {
    body = (
      <div className="workspace-empty" role="alert">
        <p>{overview.error}</p>
        <Button onClick={() => void overview.reload()}>{t("重试")}</Button>
      </div>
    );
  } else if (!overview.data || !source) {
    body = <div className="workspace-loading">{t("加载中…")}</div>;
  } else if (tab === "files") {
    body = (
      <FilesView
        key={`${roomId}:${sourceQuery}`}
        api={api}
        source={sourceQuery}
        git={overview.data.git}
        canReveal={overview.data.canReveal}
        narrow={narrow}
        refreshTick={refreshTick}
      />
    );
  } else if (tab === "commits" && overview.data.git) {
    body = (
      <CommitsView
        key={`${roomId}:${sourceQuery}`}
        api={api}
        source={sourceQuery}
        canReveal={overview.data.canReveal}
        narrow={narrow}
        refreshTick={refreshTick}
        initialCommit={focusCommit}
      />
    );
  } else if (!overview.data.git) {
    body = (
      <div className="workspace-empty">
        <p>{t("工作区不是 Git 仓库，没有变更可看。")}</p>
        <Button onClick={() => setTab("files")}>{t("浏览文件")}</Button>
      </div>
    );
  } else {
    body = (
      <ChangesView
        key={`${roomId}:${sourceQuery}`}
        api={api}
        source={sourceQuery}
        base={source?.base}
        defaultMode={source?.kind === "worktree" ? "base" : "local"}
        canReveal={overview.data.canReveal}
        narrow={narrow}
        refreshTick={refreshTick}
        onStatus={(status) => {
          if (sourceQuery === "workspace" && overview.data)
            onOverview?.({
              ...overview.data,
              changeCount: new Set(status.changes.map((item) => item.path)).size,
            });
        }}
      />
    );
  }

  return (
    <WorkspaceRevealContext.Provider value={revealFile}>
      <SheetPanel
        storageKey="superhive.workspace"
        className="workspace-panel"
        panelRef={panelRef}
        icon={<WorkspaceGlyph size={17} />}
        title={t("工作区")}
        subtitle={overview.data?.name}
        closeLabel={t("关闭工作区面板")}
        onClose={onClose}
        actions={
          <IconButton label={t("刷新")} onClick={() => setRefreshTick((value) => value + 1)}>
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" />
            </svg>
          </IconButton>
        }
      >
        {overview.data?.configured && (
          <div className="workspace-toolbar">
            <div
              ref={tabsRef}
              className="workspace-tabs"
              role="tablist"
              aria-label={t("工作区视图")}
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                event.preventDefault();
                const index = tabs.findIndex((item) => item.id === tab);
                const next =
                  tabs[(index + (event.key === "ArrowLeft" ? -1 : 1) + tabs.length) % tabs.length]!;
                setTab(next.id);
                window.requestAnimationFrame(() =>
                  panelRef.current
                    ?.querySelector<HTMLElement>(`#workspace-tab-${next.id}`)
                    ?.focus(),
                );
              }}
            >
              {tabs.map((item) => (
                <button
                  key={item.id}
                  id={`workspace-tab-${item.id}`}
                  type="button"
                  role="tab"
                  aria-selected={tab === item.id}
                  aria-controls="workspace-tabpanel"
                  tabIndex={tab === item.id ? 0 : -1}
                  className={tab === item.id ? "active" : ""}
                  onClick={() => setTab(item.id)}
                >
                  {item.label}
                  {item.id === "changes" && changeCount ? (
                    <span className="workspace-tab-count">{changeCount}</span>
                  ) : null}
                </button>
              ))}
            </div>
            {sources.length > 1 && (
              <Select
                className="workspace-source"
                aria-label={t("查看哪份代码")}
                menuMinWidth={460}
                value={source?.id ?? "workspace"}
                onChange={chooseSource}
                options={sources.map((item) => ({
                  value: item.id,
                  label:
                    item.kind === "workspace"
                      ? t("工作区 · {0}", { 0: item.branch ?? item.label })
                      : item.label,
                  description: [
                    item.kind === "workspace"
                      ? t("房间工作区当前的检出")
                      : item.missing
                        ? t("{0} 的任务线（目录已不存在）", { 0: item.agentName ?? "" })
                        : t("{0} 的任务线，基于 {1}", {
                            0: item.agentName ?? "",
                            1: item.base ?? "",
                          }),
                    ...sourceActivity(item),
                  ].join(" · "),
                  disabled: Boolean(item.missing),
                  group: item.kind === "workspace" ? t("工作区") : t("任务线（worktree）"),
                }))}
              />
            )}
          </div>
        )}
        <div
          className="workspace-body"
          id="workspace-tabpanel"
          role={overview.data?.configured ? "tabpanel" : undefined}
          aria-labelledby={overview.data?.configured ? `workspace-tab-${tab}` : undefined}
        >
          {body}
        </div>
      </SheetPanel>
    </WorkspaceRevealContext.Provider>
  );
}

/* ---------- 变更 ---------- */

function ChangesView({
  api,
  source,
  base,
  defaultMode,
  canReveal,
  narrow,
  refreshTick,
  onStatus,
}: {
  api: WorkspaceApi;
  source: string;
  base: string | undefined;
  defaultMode: "local" | "base";
  canReveal: boolean;
  narrow: boolean;
  refreshTick: number;
  onStatus: (status: WorkspaceStatus) => void;
}) {
  const [mode, setMode] = useState<"local" | "base">(base ? defaultMode : "local");
  const status = useAsync(async () => {
    const next = (await api("/status", { source })) as WorkspaceStatus;
    onStatus(next);
    return next;
  }, [api, source, refreshTick]);
  const compare = useAsync(
    async () =>
      mode === "base" && base
        ? ((await api("/compare", { source, base })) as WorkspaceChangeSet)
        : undefined,
    [api, source, base, mode, refreshTick],
  );
  useInterval(
    () => {
      void status.reload(true);
      if (mode === "base") void compare.reload(true);
    },
    STATUS_REFRESH_MS,
    true,
  );
  const [selected, setSelected] = useState<SelectedChange>();
  const entries: Array<{
    group?: WorkspaceChangeGroup;
    change: WorkspaceChange;
    mode: WorkspaceDiffMode;
  }> = useMemo(() => {
    if (mode === "base")
      return (compare.data?.changes ?? []).map((change) => ({ change, mode: "base" as const }));
    const changes = status.data?.changes ?? [];
    return GROUP_ORDER.flatMap((group) =>
      changes
        .filter((change) => change.group === group)
        .map((change) => ({ group, change, mode: group as WorkspaceDiffMode })),
    );
  }, [mode, compare.data, status.data]);
  // 选中的文件不在列表里了（提交了、撤销了）就取消；内容变了用 revision 重新取 diff
  useEffect(() => {
    if (!selected) return;
    const match = entries.find(
      (entry) => changeKey({ path: entry.change.path, mode: entry.mode }) === changeKey(selected),
    );
    if (!match) {
      if (!status.loading && !compare.loading) setSelected(undefined);
      return;
    }
    const revision = `${match.change.additions ?? ""}/${match.change.deletions ?? ""}/${refreshTick}`;
    if (revision !== selected.revision) setSelected({ ...selected, revision });
  }, [entries, selected, refreshTick, status.loading, compare.loading]);
  useEffect(() => {
    if (narrow || selected || !entries.length) return;
    const first = entries[0]!;
    setSelected({
      path: first.change.path,
      ...(first.change.oldPath ? { oldPath: first.change.oldPath } : {}),
      mode: first.mode,
      status: first.change.status,
      revision: `${first.change.additions ?? ""}/${first.change.deletions ?? ""}/${refreshTick}`,
    });
  }, [entries, narrow, selected, refreshTick]);

  const data = status.data;
  const loading = mode === "base" ? compare.loading && !compare.data : status.loading && !data;
  const error = mode === "base" ? compare.error : status.error;
  const showList = !narrow || !selected;
  const showDetail = !narrow || Boolean(selected);

  return (
    <SplitLayout narrow={narrow}>
      {showList && (
        <div className="workspace-list" aria-label={t("改动的文件")}>
          {data && (
            <div className="workspace-branch">
              <span className="workspace-branch-name" title={t("当前分支")}>
                {data.detached ? t("分离 HEAD · {0}", { 0: data.branch ?? "" }) : data.branch}
              </span>
              {data.upstream && (
                <span className="workspace-muted" title={t("上游分支 {0}", { 0: data.upstream })}>
                  {data.ahead ? `↑${data.ahead}` : ""}
                  {data.behind ? ` ↓${data.behind}` : ""}
                  {!data.ahead && !data.behind ? t("与上游同步") : ""}
                </span>
              )}
            </div>
          )}
          {base && (
            <div className="workspace-segmented" role="radiogroup" aria-label={t("对比范围")}>
              <button
                type="button"
                role="radio"
                aria-checked={mode === "local"}
                className={mode === "local" ? "active" : ""}
                onClick={() => {
                  setMode("local");
                  setSelected(undefined);
                }}
              >
                {t("未提交")}
              </button>
              <Tooltip content={t("从和 {0} 分叉起的全部改动，含未提交的", { 0: base })}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={mode === "base"}
                  className={mode === "base" ? "active" : ""}
                  onClick={() => {
                    setMode("base");
                    setSelected(undefined);
                  }}
                >
                  {t("相对 {0}", { 0: base })}
                </button>
              </Tooltip>
            </div>
          )}
          {mode === "base" && compare.data?.commits && (
            <p className="workspace-muted workspace-list-note">
              {t("{0} 个提交 · {1} 个文件", {
                0: compare.data.commits.length,
                1: compare.data.changes.length,
              })}
            </p>
          )}
          {error && (
            <p className="workspace-error" role="alert">
              {error}
            </p>
          )}
          {loading ? (
            <p className="workspace-muted workspace-list-note">{t("加载中…")}</p>
          ) : !entries.length && !error ? (
            <EmptyState
              compact
              icon="check"
              title={
                mode === "base"
                  ? t("相对 {0} 没有改动。", { 0: base ?? "" })
                  : t("没有未提交的改动。")
              }
              hint={t("Agent 改了文件后，这里几秒内就会列出来。")}
            />
          ) : (
            <ChangeList
              entries={entries}
              selected={selected}
              onSelect={(entry) =>
                setSelected({
                  path: entry.change.path,
                  ...(entry.change.oldPath ? { oldPath: entry.change.oldPath } : {}),
                  mode: entry.mode,
                  status: entry.change.status,
                  revision: `${entry.change.additions ?? ""}/${entry.change.deletions ?? ""}/${refreshTick}`,
                })
              }
            />
          )}
          {(data?.truncated || compare.data?.truncated) && (
            <p className="workspace-muted workspace-list-note">{t("改动太多，只列出了一部分。")}</p>
          )}
        </div>
      )}
      {showDetail && (
        <div className="workspace-detail">
          {selected ? (
            <DiffViewer
              api={api}
              source={source}
              selection={selected}
              base={mode === "base" ? base : undefined}
              canReveal={canReveal}
              onBack={narrow ? () => setSelected(undefined) : undefined}
            />
          ) : (
            <EmptyState
              icon="diff"
              title={t("选择左侧的文件查看改动。")}
              hint={t("可以切换统一视图或左右对照；图片会显示改前改后。")}
            />
          )}
        </div>
      )}
    </SplitLayout>
  );
}

function ChangeList({
  entries,
  selected,
  onSelect,
}: {
  entries: Array<{
    group?: WorkspaceChangeGroup;
    change: WorkspaceChange;
    mode: WorkspaceDiffMode;
    commit?: string;
  }>;
  selected: SelectedChange | undefined;
  onSelect: (entry: { change: WorkspaceChange; mode: WorkspaceDiffMode; commit?: string }) => void;
}) {
  const groups = new Map<string, typeof entries>();
  for (const entry of entries) {
    const key = entry.group ?? "";
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return (
    <>
      {[...groups].map(([group, items]) => (
        <section key={group} className="workspace-group">
          {group && (
            <h3>
              {GROUP_LABELS[group as WorkspaceChangeGroup]()}
              <span className="workspace-muted">{items.length}</span>
            </h3>
          )}
          <ul>
            {items.map((entry) => {
              const key = changeKey({
                path: entry.change.path,
                mode: entry.mode,
                ...(entry.commit ? { commit: entry.commit } : {}),
              });
              const active = selected ? changeKey(selected) === key : false;
              const slash = entry.change.path.lastIndexOf("/");
              return (
                <li key={key}>
                  <Tooltip
                    content={
                      entry.change.oldPath
                        ? `${entry.change.oldPath} → ${entry.change.path}`
                        : entry.change.path
                    }
                  >
                    <button
                      type="button"
                      className={`workspace-change ${active ? "active" : ""}`}
                      aria-current={active ? "true" : undefined}
                      onClick={() => onSelect(entry)}
                    >
                      <StatusBadge status={entry.change.status} />
                      <span className="workspace-change-name">
                        <span>{entry.change.path.slice(slash + 1)}</span>
                        {slash > 0 && (
                          <span className="workspace-muted">
                            {entry.change.path.slice(0, slash)}
                          </span>
                        )}
                      </span>
                      {entry.change.sensitive && (
                        <span className="workspace-lock" title={t("可能含密钥")}>
                          🔒<span className="sr-only">{t("可能含密钥")}</span>
                        </span>
                      )}
                      <Counts {...entry.change} />
                    </button>
                  </Tooltip>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </>
  );
}

/* ---------- diff ---------- */

type WrapPrefs = { prose: boolean; code: boolean };

function readWrapPrefs(): WrapPrefs {
  const stored = (kind: keyof WrapPrefs) => localStorage.getItem(`${WRAP_KEY}.${kind}`);
  // 正文类默认换行，代码默认不换行（和 GitHub、VS Code 一样），用户切过就按记住的来
  return { prose: stored("prose") !== "0", code: stored("code") === "1" };
}

/** 这个文件要不要自动换行；切换后同类文件都按新的选择 */
function useWrap(path: string): [boolean, (wrap: boolean) => void] {
  const kind: keyof WrapPrefs = isProseFile(path) ? "prose" : "code";
  const [prefs, setPrefs] = useState(readWrapPrefs);
  return [
    prefs[kind],
    (next) => {
      localStorage.setItem(`${WRAP_KEY}.${kind}`, next ? "1" : "0");
      setPrefs((current) => ({ ...current, [kind]: next }));
    },
  ];
}

function WrapToggle({
  wrap,
  onChange,
  locked,
}: {
  wrap: boolean;
  onChange: (wrap: boolean) => void;
  /** 左右对照两边各占一半，长行只能在自己那一半里换行 */
  locked?: boolean;
}) {
  const button = (
    <button
      type="button"
      className={`workspace-wrap-toggle ${wrap || locked ? "active" : ""}`}
      aria-pressed={Boolean(wrap || locked)}
      aria-disabled={locked || undefined}
      onClick={() => {
        if (!locked) onChange(!wrap);
      }}
    >
      {t("自动换行")}
    </button>
  );
  return (
    <Tooltip
      content={
        locked
          ? t("左右对照时总是自动换行")
          : wrap
            ? t("长行折到下一行显示；点一下改回横向滚动")
            : t("长行横向滚动；点一下改为折行显示")
      }
    >
      {button}
    </Tooltip>
  );
}

function useDiffView(): [DiffView, (view: DiffView) => void] {
  const [view, setView] = useState<DiffView>(() =>
    localStorage.getItem(VIEW_KEY) === "split" ? "split" : "unified",
  );
  return [
    view,
    (next) => {
      localStorage.setItem(VIEW_KEY, next);
      setView(next);
    },
  ];
}

function DiffViewer({
  api,
  source,
  selection,
  base,
  canReveal,
  onBack,
}: {
  api: WorkspaceApi;
  source: string;
  selection: SelectedChange;
  base?: string | undefined;
  canReveal: boolean;
  onBack?: (() => void) | undefined;
}) {
  const [view, setView] = useDiffView();
  const [wrap, setWrap] = useWrap(selection.path);
  const [reveal, setReveal] = useState(false);
  const [expandAll, setExpandAll] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [tooManyConfirmed, setTooManyConfirmed] = useState(false);
  // 图片、音视频、Office 文档默认看改前改后对照；SVG 还能切回文本 diff，CSV 默认就看文本 diff
  const media = mediaKind(selection.path);
  const textFirst = isTextOffice(officeKind(selection.path));
  const [showText, setShowText] = useState(textFirst);
  const identity = changeKey(selection);
  useEffect(() => {
    setReveal(false);
    setExpanded(new Set());
    setTooManyConfirmed(false);
    setShowText(textFirst);
  }, [identity, textFirst]);
  const sides = changeSides({ ...selection, base });
  const showMedia = Boolean(media) && !showText;
  const diff = useAsync(
    async () =>
      (await api("/diff", {
        source,
        path: selection.path,
        oldPath: selection.oldPath,
        mode: selection.mode,
        commit: selection.commit,
        base,
        full: "1",
        reveal: reveal ? "1" : undefined,
      })) as WorkspaceDiff,
    // revision 变了（文件又改了）就重新取
    [api, source, identity, selection.revision, base, reveal],
  );
  const hunks = useMemo(
    () => (diff.data?.patch !== undefined ? parsePatch(diff.data.patch) : undefined),
    [diff.data],
  );
  const lineCount = hunks?.reduce((sum, hunk) => sum + hunk.lines.length, 0) ?? 0;
  const tooMany = lineCount > MAX_RENDERED_DIFF_LINES && !tooManyConfirmed;
  const language = languageFor(selection.path);
  const tokens = useMemo(
    () => (hunks && !tooMany ? highlightHunks(hunks, language) : new Map<DiffLine, Token[]>()),
    [hunks, language, tooMany],
  );
  const blocks = useMemo(
    () =>
      hunks
        ? diffBlocks(hunks, expandAll ? "all" : expanded, { showHunkHeaders: !diff.data?.full })
        : [],
    [hunks, expandAll, expanded, diff.data?.full],
  );
  const stats = hunks ? diffStats(hunks) : undefined;

  let content: ReactNode;
  if (diff.loading && !diff.data) content = <div className="workspace-loading">{t("加载中…")}</div>;
  else if (diff.error)
    content = (
      <div className="workspace-empty" role="alert">
        <p>{diff.error}</p>
        <Button onClick={() => void diff.reload()}>{t("重试")}</Button>
      </div>
    );
  else if (diff.data?.sensitive && diff.data.patch === undefined)
    content = <SensitiveNotice canReveal={canReveal} onReveal={() => setReveal(true)} />;
  else if (showMedia)
    content = (
      <MediaCompare
        api={api}
        source={source}
        path={selection.path}
        oldPath={selection.oldPath}
        before={sides.before}
        after={sides.after}
        version={selection.revision}
      />
    );
  else if (diff.data?.binary)
    content = (
      <div className="workspace-empty">
        <p className="workspace-muted">{t("二进制文件，不显示内容。")}</p>
        {(sides.after ?? sides.before) && (
          <DownloadButton
            api={api}
            source={source}
            path={sides.after ? selection.path : (selection.oldPath ?? selection.path)}
            ref={sides.after ?? sides.before}
          />
        )}
      </div>
    );
  else if (diff.data?.tooLarge)
    content = (
      <div className="workspace-empty workspace-muted">{t("改动太大，不在这里显示。")}</div>
    );
  else if (!hunks)
    content = <pre className={`workspace-raw ${wrap ? "wrap" : ""}`}>{diff.data?.patch}</pre>;
  else if (!hunks.length)
    content = (
      <div className="workspace-empty workspace-muted">
        {t("没有内容改动（可能只改了权限或是空文件）。")}
      </div>
    );
  else if (tooMany)
    content = (
      <div className="workspace-empty">
        <p className="workspace-muted">
          {t("这个文件改了 {0} 行，一次显示可能会卡。", { 0: lineCount.toLocaleString() })}
        </p>
        <Button onClick={() => setTooManyConfirmed(true)}>{t("仍然显示")}</Button>
      </div>
    );
  else
    content = (
      <div
        className={`workspace-code workspace-diff ${view} ${wrap || view === "split" ? "wrap" : ""}`}
        role="table"
        aria-label={t("{0} 的改动", { 0: selection.path })}
      >
        {blocks.map((block, index) => {
          if (block.type === "hunk")
            return (
              <div key={index} className="diff-hunk" role="row">
                <span role="cell">
                  @@ -{block.oldStart} +{block.newStart} @@ {block.header}
                </span>
              </div>
            );
          if (block.type === "gap")
            return (
              <div key={block.gap.id} className="diff-gap" role="row">
                <span role="cell">
                  <Button
                    size="sm"
                    onClick={() => setExpanded((current) => new Set(current).add(block.gap.id))}
                  >
                    <span className="diff-gap-label">
                      {t("展开 {0} 行未改动", { 0: block.gap.count })}
                    </span>
                  </Button>
                </span>
              </div>
            );
          return view === "split" ? (
            <Fragment key={index}>
              {splitRows(block.lines).map((row, rowIndex) => (
                <div key={rowIndex} className="diff-row split" role="row">
                  <DiffCell line={row.left} side="old" tokens={row.left && tokens.get(row.left)} />
                  <DiffCell
                    line={row.right}
                    side="new"
                    tokens={row.right && tokens.get(row.right)}
                  />
                </div>
              ))}
            </Fragment>
          ) : (
            <Fragment key={index}>
              {block.lines.map((line, lineIndex) => (
                <div key={lineIndex} className={`diff-row ${line.kind}`} role="row">
                  <span className="diff-number" role="cell" aria-hidden="true">
                    {line.oldNumber ?? ""}
                  </span>
                  <span className="diff-number" role="cell" aria-hidden="true">
                    {line.newNumber ?? ""}
                  </span>
                  <span className="diff-text" role="cell">
                    <span className="sr-only">
                      {line.kind === "add" ? t("新增：") : line.kind === "del" ? t("删除：") : ""}
                    </span>
                    <span className="diff-marker" aria-hidden="true">
                      {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
                    </span>
                    <TokenLine tokens={tokens.get(line)} fallback={line.text} />
                    {line.noNewline && (
                      <span className="diff-eof" title={t("文件末尾没有换行")}>
                        ⏎̸
                      </span>
                    )}
                  </span>
                </div>
              ))}
            </Fragment>
          );
        })}
      </div>
    );

  return (
    <div className="workspace-viewer">
      <div className="workspace-viewer-bar">
        {onBack && (
          <Button variant="ghost" size="sm" onClick={onBack}>
            ← {t("返回列表")}
          </Button>
        )}
        <span className="workspace-viewer-path" title={selection.path}>
          {selection.oldPath && selection.oldPath !== selection.path
            ? `${selection.oldPath} → `
            : ""}
          {selection.path}
        </span>
        {stats && <Counts additions={stats.additions} deletions={stats.deletions} />}
        <div className="workspace-viewer-actions">
          {media && diff.data?.patch !== undefined && (
            <button
              type="button"
              aria-pressed={showText}
              className={showText ? "active" : ""}
              onClick={() => setShowText((value) => !value)}
            >
              {!showText
                ? t("看文本 diff")
                : media === "office"
                  ? t("看预览对照")
                  : t("看图片对照")}
            </button>
          )}
          {!showMedia && hunks && hunks.length > 0 && diff.data?.full && (
            <button
              type="button"
              aria-pressed={expandAll}
              className={expandAll ? "active" : ""}
              onClick={() => setExpandAll((value) => !value)}
            >
              {expandAll ? t("折叠未改动") : t("全部展开")}
            </button>
          )}
          {!showMedia &&
            diff.data?.patch !== undefined &&
            !diff.data.binary &&
            !diff.data.tooLarge && (
              <WrapToggle
                wrap={wrap}
                onChange={setWrap}
                locked={Boolean(hunks) && view === "split"}
              />
            )}
          {!showMedia && (
            <div className="workspace-segmented" role="radiogroup" aria-label={t("diff 视图")}>
              <button
                type="button"
                role="radio"
                aria-checked={view === "unified"}
                className={view === "unified" ? "active" : ""}
                onClick={() => setView("unified")}
              >
                {t("统一")}
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={view === "split"}
                className={view === "split" ? "active" : ""}
                onClick={() => setView("split")}
              >
                {t("左右对照")}
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="workspace-viewer-scroll">{content}</div>
    </div>
  );
}

function DiffCell({
  line,
  side,
  tokens,
}: {
  line: DiffLine | undefined;
  side: "old" | "new";
  tokens: Token[] | undefined;
}) {
  if (!line)
    return (
      <>
        <span className="diff-number empty" role="cell" aria-hidden="true" />
        <span className="diff-text empty" role="cell" />
      </>
    );
  const number = side === "old" ? line.oldNumber : line.newNumber;
  return (
    <>
      <span className={`diff-number ${line.kind}`} role="cell" aria-hidden="true">
        {number ?? ""}
      </span>
      <span className={`diff-text ${line.kind}`} role="cell">
        <span className="sr-only">
          {line.kind === "add" ? t("新增：") : line.kind === "del" ? t("删除：") : ""}
        </span>
        <TokenLine tokens={tokens} fallback={line.text} />
      </span>
    </>
  );
}

function TokenLine({ tokens, fallback }: { tokens: Token[] | undefined; fallback: string }) {
  if (!tokens) return <>{fallback}</>;
  return (
    <>
      {tokens.map((token, index) =>
        token.className ? (
          <span key={index} className={token.className}>
            {token.text}
          </span>
        ) : (
          <Fragment key={index}>{token.text}</Fragment>
        ),
      )}
    </>
  );
}

function SensitiveNotice({ canReveal, onReveal }: { canReveal: boolean; onReveal: () => void }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="workspace-empty workspace-sensitive">
      <p>
        <strong>{t("这个文件可能含有密钥，默认不显示内容。")}</strong>
      </p>
      {canReveal ? (
        confirming ? (
          <div className="workspace-confirm" role="alert">
            <p className="workspace-muted">{t("显示后内容会出现在屏幕上，注意周围和屏幕共享。")}</p>
            <div className="dialog-actions center">
              <Button onClick={() => setConfirming(false)}>{t("取消")}</Button>
              <Button variant="primary" onClick={onReveal}>
                {t("确认显示")}
              </Button>
            </div>
          </div>
        ) : (
          <Button onClick={() => setConfirming(true)}>{t("显示内容…")}</Button>
        )
      ) : (
        <p className="workspace-muted">{t("只有房主可以查看。")}</p>
      )}
    </div>
  );
}

/* ---------- 文件 ---------- */

function FilesView({
  api,
  source,
  git,
  canReveal,
  narrow,
  refreshTick,
}: {
  api: WorkspaceApi;
  source: string;
  git: boolean;
  canReveal: boolean;
  narrow: boolean;
  refreshTick: number;
}) {
  const [showIgnored, setShowIgnored] = useState(false);
  const [trees, setTrees] = useState<Map<string, WorkspaceTree | { error: string }>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set([""]));
  const [selected, setSelected] = useState<string>();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WorkspaceSearch>();
  const [searchError, setSearchError] = useState<string>();
  const loading = useRef(new Set<string>());

  const load = useCallback(
    async (directory: string) => {
      if (loading.current.has(directory)) return;
      loading.current.add(directory);
      try {
        const tree = (await api("/tree", {
          source,
          path: directory,
          ignored: showIgnored ? "1" : undefined,
        })) as WorkspaceTree;
        setTrees((current) => new Map(current).set(directory, tree));
      } catch (reason) {
        setTrees((current) =>
          new Map(current).set(directory, {
            error: reason instanceof Error ? reason.message : String(reason),
          }),
        );
      } finally {
        loading.current.delete(directory);
      }
    },
    [api, source, showIgnored],
  );
  // 切换「显示忽略的文件」或刷新：已经展开的目录全部重新取
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  useEffect(() => {
    for (const directory of expandedRef.current) void load(directory);
  }, [load, refreshTick]);

  useEffect(() => {
    const needle = query.trim();
    if (!needle) {
      setResults(undefined);
      setSearchError(undefined);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      api("/search", { source, q: needle }).then(
        (value) => {
          if (!cancelled) {
            setResults(value as WorkspaceSearch);
            setSearchError(undefined);
          }
        },
        (reason: unknown) => {
          if (!cancelled) setSearchError(reason instanceof Error ? reason.message : String(reason));
        },
      );
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [api, source, query]);

  const toggle = (directory: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(directory)) next.delete(directory);
      else {
        next.add(directory);
        if (!trees.has(directory)) void load(directory);
      }
      return next;
    });
  };

  /** 搜索结果里点文件：展开它的上级目录，方便看周围 */
  const reveal = (file: string) => {
    setSelected(file);
    const parts = file.split("/").slice(0, -1);
    const parents = parts.map((_, index) => parts.slice(0, index + 1).join("/"));
    setExpanded((current) => {
      const next = new Set(current);
      for (const parent of parents) {
        next.add(parent);
        if (!trees.has(parent)) void load(parent);
      }
      return next;
    });
  };

  const renderDirectory = (directory: string, depth: number): ReactNode => {
    const tree = trees.get(directory);
    if (!tree)
      return (
        <li
          className="workspace-tree-note workspace-muted"
          style={{ paddingLeft: 12 + depth * 14 }}
        >
          {t("加载中…")}
        </li>
      );
    if ("error" in tree)
      return (
        <li
          className="workspace-tree-note workspace-error"
          style={{ paddingLeft: 12 + depth * 14 }}
          role="alert"
        >
          {tree.error}
        </li>
      );
    if (!tree.entries.length && depth > 0)
      return (
        <li
          className="workspace-tree-note workspace-muted"
          style={{ paddingLeft: 12 + depth * 14 }}
        >
          {t("空目录")}
        </li>
      );
    return (
      <>
        {tree.entries.map((entry) => (
          <TreeRow
            key={entry.path}
            entry={entry}
            depth={depth}
            open={expanded.has(entry.path)}
            selected={selected === entry.path}
            onToggle={() => toggle(entry.path)}
            onOpen={() => setSelected(entry.path)}
          >
            {entry.type === "directory" && !entry.outside && expanded.has(entry.path) && (
              <ul role="group">{renderDirectory(entry.path, depth + 1)}</ul>
            )}
          </TreeRow>
        ))}
        {tree.truncated && (
          <li
            className="workspace-tree-note workspace-muted"
            style={{ paddingLeft: 12 + depth * 14 }}
          >
            {t("条目太多，只列出了一部分，可以用上面的搜索找文件。")}
          </li>
        )}
      </>
    );
  };

  const showList = !narrow || !selected;
  const showDetail = !narrow || Boolean(selected);
  return (
    <SplitLayout narrow={narrow}>
      {showList && (
        <div className="workspace-list workspace-files">
          <div className="workspace-search">
            <input
              type="search"
              value={query}
              placeholder={t("按文件名搜索")}
              aria-label={t("按文件名搜索")}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && query) {
                  event.preventDefault();
                  setQuery("");
                }
              }}
            />
          </div>
          {git && (
            <label className="workspace-check">
              <input
                type="checkbox"
                checked={showIgnored}
                onChange={(event) => setShowIgnored(event.target.checked)}
              />
              {t("显示被 .gitignore 忽略的文件")}
            </label>
          )}
          {query.trim() ? (
            <div className="workspace-search-results" aria-live="polite">
              {searchError ? (
                <p className="workspace-error" role="alert">
                  {searchError}
                </p>
              ) : !results ? (
                <p className="workspace-muted workspace-list-note">{t("搜索中…")}</p>
              ) : !results.paths.length ? (
                <p className="workspace-muted workspace-list-note">{t("没有匹配的文件。")}</p>
              ) : (
                <ul>
                  {results.paths.map((file) => {
                    const slash = file.lastIndexOf("/");
                    return (
                      <li key={file}>
                        <button
                          type="button"
                          className={`workspace-change ${selected === file ? "active" : ""}`}
                          aria-current={selected === file ? "true" : undefined}
                          onClick={() => reveal(file)}
                        >
                          <FileGlyph />
                          <span className="workspace-change-name">
                            <span>{file.slice(slash + 1)}</span>
                            {slash > 0 && (
                              <span className="workspace-muted">{file.slice(0, slash)}</span>
                            )}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                  {results.truncated && (
                    <li className="workspace-muted workspace-list-note">
                      {t("只显示前 {0} 个结果。", { 0: results.paths.length })}
                    </li>
                  )}
                </ul>
              )}
            </div>
          ) : (
            <ul className="workspace-tree" aria-label={t("工作区文件")}>
              {renderDirectory("", 0)}
            </ul>
          )}
        </div>
      )}
      {showDetail && (
        <div className="workspace-detail">
          {selected ? (
            <FilePreview
              key={selected}
              api={api}
              source={source}
              path={selected}
              canReveal={canReveal}
              refreshTick={refreshTick}
              onBack={narrow ? () => setSelected(undefined) : undefined}
            />
          ) : (
            <EmptyState
              icon="file"
              title={t("选择左侧的文件查看内容。")}
              hint={t("只读预览：代码带高亮，图片、音视频和 PDF 直接显示。")}
            />
          )}
        </div>
      )}
    </SplitLayout>
  );
}

function TreeRow({
  entry,
  depth,
  open,
  selected,
  onToggle,
  onOpen,
  children,
}: {
  entry: WorkspaceTreeEntry;
  depth: number;
  open: boolean;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
  children?: ReactNode;
}) {
  const directory = entry.type === "directory";
  const disabled = Boolean(entry.outside) || entry.type === "other";
  const statusClass = entry.status
    ? `status-${entry.status === "?" ? "untracked" : entry.status}`
    : "";
  return (
    <li>
      <Tooltip
        content={
          entry.outside
            ? t("{0} 指向工作区外面或已失效，不能查看", { 0: entry.name })
            : entry.ignored
              ? t("{0}（被 .gitignore 忽略）", { 0: entry.path })
              : entry.path
        }
      >
        <button
          type="button"
          className={`workspace-tree-row ${statusClass} ${selected ? "active" : ""} ${entry.ignored ? "ignored" : ""}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          aria-expanded={directory && !disabled ? open : undefined}
          aria-current={selected ? "true" : undefined}
          disabled={disabled}
          onClick={directory ? onToggle : onOpen}
        >
          {directory ? <Chevron open={open} /> : <span className="workspace-chevron-space" />}
          <FileGlyph directory={directory} />
          <span className="workspace-tree-name">
            {entry.name}
            {entry.symlink && <span className="workspace-muted"> ↗</span>}
          </span>
          {entry.sensitive && (
            <span className="workspace-lock" title={t("可能含密钥")}>
              🔒<span className="sr-only">{t("可能含密钥")}</span>
            </span>
          )}
          {entry.status && <StatusBadge status={entry.status} />}
        </button>
      </Tooltip>
      {children}
    </li>
  );
}

function FilePreview({
  api,
  source,
  path,
  canReveal,
  refreshTick,
  onBack,
}: {
  api: WorkspaceApi;
  source: string;
  path: string;
  canReveal: boolean;
  refreshTick: number;
  onBack?: (() => void) | undefined;
}) {
  const [reveal, setReveal] = useState(false);
  const [wrap, setWrap] = useWrap(path);
  // 图片、音视频、PDF、Office 文档直接预览；SVG、CSV 还能切到源码
  const media = mediaKind(path);
  const hasSource = /\.svg$/i.test(path) || isTextOffice(officeKind(path));
  const [showSource, setShowSource] = useState(false);
  const showMedia = Boolean(media) && !showSource;
  const markdown = MARKDOWN_FILE.test(path);
  const [markdownSource, setMarkdownSource] = useState(false);
  const file = useAsync(
    async () =>
      showMedia
        ? undefined
        : ((await api("/file", {
            source,
            path,
            reveal: reveal ? "1" : undefined,
          })) as WorkspaceFile),
    [api, source, path, reveal, refreshTick, showMedia],
  );
  const lines = useMemo(() => {
    const content = file.data?.content;
    if (content === undefined) return undefined;
    const text = content.endsWith("\n") ? content.slice(0, -1) : content;
    return highlightLines(text, languageFor(path));
  }, [file.data, path]);

  let content: ReactNode;
  if (showMedia)
    content = (
      <div className="workspace-media-single">
        <MediaView api={api} source={source} path={path} version={refreshTick} />
      </div>
    );
  else if (file.loading && !file.data)
    content = <div className="workspace-loading">{t("加载中…")}</div>;
  else if (file.error)
    content = (
      <div className="workspace-empty" role="alert">
        <p>{file.error}</p>
      </div>
    );
  else if (file.data?.sensitive && file.data.content === undefined && !file.data.binary)
    content = <SensitiveNotice canReveal={canReveal} onReveal={() => setReveal(true)} />;
  else if (file.data?.binary)
    content = (
      <div className="workspace-empty">
        <p className="workspace-muted">{t("二进制文件，不能在这里预览。")}</p>
        <DownloadButton api={api} source={source} path={path} />
      </div>
    );
  else if (markdown && !markdownSource && file.data?.content !== undefined)
    content = (
      <>
        {file.data.truncated && (
          <p className="workspace-banner">
            {t("文件较大，只显示前 {0}。", { 0: formatBytes(512 * 1024) })}
          </p>
        )}
        <Suspense fallback={<div className="workspace-loading">{t("加载中…")}</div>}>
          <WorkspaceDoc content={file.data.content} />
        </Suspense>
      </>
    );
  else if (lines)
    content = (
      <>
        {file.data?.truncated && (
          <p className="workspace-banner">
            {t("文件较大，只显示前 {0}。", { 0: formatBytes(512 * 1024) })}
          </p>
        )}
        <div
          className={`workspace-code workspace-source-view ${wrap ? "wrap" : ""}`}
          role="table"
          aria-label={path}
        >
          {lines.map((tokens, index) => (
            <div key={index} className="diff-row context" role="row">
              <span className="diff-number" role="cell" aria-hidden="true">
                {index + 1}
              </span>
              <span className="diff-text" role="cell">
                <TokenLine tokens={tokens} fallback="" />
              </span>
            </div>
          ))}
        </div>
      </>
    );

  return (
    <div className="workspace-viewer">
      <div className="workspace-viewer-bar">
        {onBack && (
          <Button variant="ghost" size="sm" onClick={onBack}>
            ← {t("返回列表")}
          </Button>
        )}
        <span className="workspace-viewer-path" title={path}>
          {path}
        </span>
        {file.data && <span className="workspace-muted">{formatBytes(file.data.size)}</span>}
        {((media && hasSource) || lines) && (
          <div className="workspace-viewer-actions">
            {lines && markdown && (
              <button
                type="button"
                aria-pressed={markdownSource}
                className={markdownSource ? "active" : ""}
                onClick={() => setMarkdownSource((value) => !value)}
              >
                {markdownSource ? t("看渲染") : t("看源码")}
              </button>
            )}
            {lines && !showMedia && (!markdown || markdownSource) && (
              <WrapToggle wrap={wrap} onChange={setWrap} />
            )}
            {media && hasSource && (
              <button
                type="button"
                aria-pressed={showSource}
                className={showSource ? "active" : ""}
                onClick={() => setShowSource((value) => !value)}
              >
                {!showSource ? t("看源码") : media === "office" ? t("看表格") : t("看图片")}
              </button>
            )}
          </div>
        )}
      </div>
      <div
        className={`workspace-viewer-scroll${markdown && !markdownSource && lines ? " doc" : ""}`}
      >
        {content}
      </div>
    </div>
  );
}

/* ---------- 提交 ---------- */

function CommitsView({
  api,
  source,
  canReveal,
  narrow,
  refreshTick,
  initialCommit,
}: {
  api: WorkspaceApi;
  source: string;
  canReveal: boolean;
  narrow: boolean;
  refreshTick: number;
  /** 从消息里的提交号点过来：直接打开这个提交（不在已加载的列表里也行） */
  initialCommit?: string | undefined;
}) {
  const [commits, setCommits] = useState<WorkspaceCommit[]>([]);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [selectedCommit, setSelectedCommit] = useState<string | undefined>(initialCommit);
  useEffect(() => {
    if (initialCommit) setSelectedCommit(initialCommit);
  }, [initialCommit]);
  const [selectedFile, setSelectedFile] = useState<SelectedChange>();
  const loadPage = useCallback(
    async (skip: number) => {
      setLoading(true);
      try {
        const page = (
          (await api("/log", { source, skip: String(skip) })) as { commits: WorkspaceCommit[] }
        ).commits;
        setCommits((current) => (skip ? [...current, ...page] : page));
        setMore(page.length >= 30);
        setError(undefined);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setLoading(false);
      }
    },
    [api, source],
  );
  useEffect(() => {
    void loadPage(0);
  }, [loadPage, refreshTick]);
  const detail = useAsync(
    async () =>
      selectedCommit
        ? ((await api("/commit", { source, commit: selectedCommit })) as WorkspaceChangeSet)
        : undefined,
    [api, source, selectedCommit],
  );
  useEffect(() => setSelectedFile(undefined), [selectedCommit]);

  const showList = !narrow || !selectedCommit;
  const showDetail = !narrow || Boolean(selectedCommit);
  return (
    <SplitLayout narrow={narrow}>
      {showList && (
        <div className="workspace-list">
          {error && (
            <p className="workspace-error" role="alert">
              {error}
            </p>
          )}
          {!commits.length && !loading && !error && (
            <EmptyState compact icon="commit" title={t("还没有提交。")} />
          )}
          <ul className="workspace-commits">
            {commits.map((commit) => (
              <li key={commit.hash}>
                <button
                  type="button"
                  className={`workspace-commit ${selectedCommit === commit.hash ? "active" : ""}`}
                  aria-current={selectedCommit === commit.hash ? "true" : undefined}
                  onClick={() => setSelectedCommit(commit.hash)}
                >
                  <span className="workspace-commit-subject">{commit.subject}</span>
                  <span className="workspace-muted">
                    <code>{commit.shortHash}</code> · {commit.author} · {formatTime(commit.date)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {loading && <p className="workspace-muted workspace-list-note">{t("加载中…")}</p>}
          {more && !loading && (
            <Button
              size="sm"
              className="workspace-more"
              onClick={() => void loadPage(commits.length)}
            >
              {t("加载更多")}
            </Button>
          )}
        </div>
      )}
      {showDetail && (
        <div className="workspace-detail">
          {!selectedCommit ? (
            <EmptyState
              icon="commit"
              title={t("选择一个提交查看改动。")}
              hint={t("能看到提交说明、改了哪些文件和每个文件的 diff。")}
            />
          ) : selectedFile ? (
            <DiffViewer
              api={api}
              source={source}
              selection={selectedFile}
              canReveal={canReveal}
              onBack={() => setSelectedFile(undefined)}
            />
          ) : (
            <div className="workspace-viewer">
              <div className="workspace-viewer-bar">
                {narrow && (
                  <Button variant="ghost" size="sm" onClick={() => setSelectedCommit(undefined)}>
                    ← {t("返回列表")}
                  </Button>
                )}
                <span className="workspace-viewer-path is-title">
                  {detail.data?.commit?.subject ?? selectedCommit.slice(0, 7)}
                </span>
              </div>
              <div className="workspace-viewer-scroll workspace-commit-detail">
                {detail.loading && !detail.data ? (
                  <div className="workspace-loading">{t("加载中…")}</div>
                ) : detail.error ? (
                  <p className="workspace-error" role="alert">
                    {detail.error}
                  </p>
                ) : detail.data ? (
                  <>
                    <p className="workspace-muted">
                      <code>{detail.data.commit?.hash}</code>
                      <br />
                      {detail.data.commit?.author} ·{" "}
                      {detail.data.commit ? formatTime(detail.data.commit.date) : ""}
                    </p>
                    {detail.data.body && (
                      <pre className="workspace-commit-body">{detail.data.body}</pre>
                    )}
                    <ChangeList
                      entries={detail.data.changes.map((change) => ({
                        change,
                        mode: "commit" as const,
                        commit: selectedCommit,
                      }))}
                      selected={selectedFile}
                      onSelect={(entry) =>
                        setSelectedFile({
                          path: entry.change.path,
                          ...(entry.change.oldPath ? { oldPath: entry.change.oldPath } : {}),
                          mode: "commit",
                          commit: selectedCommit,
                          status: entry.change.status,
                          revision: selectedCommit,
                        })
                      }
                    />
                    {detail.data.truncated && (
                      <p className="workspace-muted">{t("改动太多，只列出了一部分。")}</p>
                    )}
                  </>
                ) : null}
              </div>
            </div>
          )}
        </div>
      )}
    </SplitLayout>
  );
}
