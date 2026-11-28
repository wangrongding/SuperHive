import {
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type {
  ChatMessage,
  Invocation,
  Participant,
  RoomSummary,
  WorkspaceOverview,
} from "@superhive/protocol";
import { BranchGlyph, WorktreeSwitcher } from "./worktree-switcher";
import { WorkspaceGlyph } from "./workspace-panel";
import { BUDGET_EXTEND_TURNS, currentPausedInvocations } from "./invocations";
import type { LocalAgentsState } from "./local-agents";
import type { DockedPreview } from "./room-side-state";
import { t } from "./i18n";
import {
  storedMembersCollapsedKey,
  storedRoomsCollapsedKey,
  type MobilePanel,
  type SettingsTab,
} from "./app-storage";
import { animateLayout } from "./ui-utils";
import { Icon } from "./app-icons";
import { keepAwakeSummary } from "./host-settings";
import type { ShareSelection } from "./share-bar";
import { ContextMenu, type ContextMenuItem, type ContextMenuState } from "./context-menu";
import { Tooltip } from "./tooltip";
import { Button, IconButton } from "./button";

/** 对话区顶栏：房间名、在线人数、工作区与分支（房主可点开任务目录下拉），以及新话题、产物、代码、分享等入口 */
export function ChatHeader({
  roomsCollapsed,
  setRoomsCollapsed,
  mobilePanel,
  openMobilePanel,
  currentRoomName,
  online,
  messages,
  currentRoomWorkspace,
  currentRoom,
  isOwner,
  local,
  loadRoomWorktrees,
  loadWorkspaceDetail,
  openWorkspaceSource,
  openWorktrees,
  setSettingsTab,
  setSettingsOpen,
  startNewTopic,
  artifactsButtonRef,
  artifactsOpen,
  setArtifactsOpen,
  artifactCount,
  canViewWorkspace,
  workspaceButtonRef,
  workspaceOpen,
  setWorkspaceOpen,
  workspaceChangeCount,
  share,
  previewDocked,
  membersCollapsed,
  setMembersCollapsed,
  setDockedPreview,
  terminal,
}: {
  roomsCollapsed: boolean;
  setRoomsCollapsed: Dispatch<SetStateAction<boolean>>;
  mobilePanel: MobilePanel | undefined;
  openMobilePanel: (panel: MobilePanel, trigger: HTMLButtonElement) => void;
  currentRoomName: string;
  online: Participant[];
  messages: ChatMessage[];
  currentRoomWorkspace: string | undefined;
  currentRoom: RoomSummary | undefined;
  isOwner: boolean;
  local: LocalAgentsState;
  loadRoomWorktrees: () => ReturnType<LocalAgentsState["worktrees"]>;
  loadWorkspaceDetail: () => Promise<WorkspaceOverview>;
  openWorkspaceSource: (source: string) => void;
  /** 打开「任务目录」面板；trigger 是关掉面板后焦点要回去的按钮 */
  openWorktrees: (trigger: HTMLButtonElement) => void;
  setSettingsTab: Dispatch<SetStateAction<SettingsTab>>;
  setSettingsOpen: Dispatch<SetStateAction<boolean>>;
  startNewTopic: () => void;
  artifactsButtonRef: RefObject<HTMLButtonElement | null>;
  artifactsOpen: boolean;
  setArtifactsOpen: Dispatch<SetStateAction<boolean>>;
  artifactCount: number | undefined;
  canViewWorkspace: boolean;
  workspaceButtonRef: RefObject<HTMLButtonElement | null>;
  workspaceOpen: boolean;
  setWorkspaceOpen: Dispatch<SetStateAction<boolean>>;
  workspaceChangeCount: number;
  share: ShareSelection;
  previewDocked: boolean;
  membersCollapsed: boolean;
  setMembersCollapsed: Dispatch<SetStateAction<boolean>>;
  setDockedPreview: Dispatch<SetStateAction<DockedPreview | undefined>>;
  /** 内置终端开关：只有在桌面端里才传，浏览器里没有这个按钮 */
  terminal?: { open: boolean; toggle: () => void };
}) {
  const { shareMode, setShareMode, exitShareMode } = share;
  const [moreMenu, setMoreMenu] = useState<ContextMenuState>();
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  // 菜单开着时按「更多」：菜单先因为点了外面自己关掉，这次点击不能再把它打开
  const moreWasOpen = useRef(false);
  const roomsLabel = roomsCollapsed ? t("显示房间列表") : t("隐藏房间列表");
  const rightPanelLabel = previewDocked
    ? t("收起右侧栏")
    : membersCollapsed
      ? t("显示成员与白板")
      : t("隐藏成员与白板");
  const newTopicDisabled = messages.length === 0 || messages.at(-1)?.kind === "topic";
  const shareLabel = shareMode ? t("退出分享模式") : t("分享对话");
  const toggleShare = () => (shareMode ? exitShareMode() : setShareMode(true));
  const toggleWorkspace = () => {
    setArtifactsOpen(false);
    setWorkspaceOpen((current) => !current);
  };
  const headerRef = useRef<HTMLElement>(null);
  /** 「更多」菜单里的项：和顶栏上带 data-overflow 的按钮一一对应，打开时只列出被收起来的那几个 */
  const overflowItems: Record<string, ContextMenuItem> = {
    "new-topic": { label: t("新话题"), disabled: newTopicDisabled, onSelect: startNewTopic },
    workspace: {
      label: t("代码"),
      hint: workspaceChangeCount > 0 ? String(workspaceChangeCount) : undefined,
      onSelect: toggleWorkspace,
    },
    share: { label: shareLabel, onSelect: toggleShare },
    ...(terminal ? { terminal: { label: t("终端"), onSelect: terminal.toggle } } : {}),
  };
  const workspaceName = currentRoomWorkspace?.split("/").filter(Boolean).at(-1);
  return (
    // 顶栏按自己的宽度（容器查询）逐级收起：先藏人数和消息数，再把按钮文字收成图标，
    // 最后把新话题、分享收进「更多」菜单。左右侧栏开合时顶栏宽度变了也跟着变，见 shell.css
    <header ref={headerRef} className="chat-header">
      <Tooltip content={roomsLabel}>
        <button
          type="button"
          className="header-button rooms-toggle"
          aria-label={roomsLabel}
          aria-pressed={!roomsCollapsed}
          onClick={() =>
            animateLayout(() =>
              setRoomsCollapsed((current) => {
                localStorage.setItem(storedRoomsCollapsedKey, String(!current));
                return !current;
              }),
            )
          }
        >
          <Icon name="panel-left" size={17} />
        </button>
      </Tooltip>
      <button
        type="button"
        className="header-button mobile-only"
        aria-label={t("打开房间列表")}
        aria-expanded={mobilePanel === "rooms"}
        onClick={(event) => openMobilePanel("rooms", event.currentTarget)}
      >
        <Icon name="hash" size={17} />
      </button>
      <div className="chat-title">
        <h1>{currentRoomName}</h1>
        <span className="chat-title-meta">
          <span className="chat-title-counts">
            {online.length} {t("位在线 ·")} {messages.length} {t("条消息")}
          </span>
          {currentRoomWorkspace && (
            <span className="chat-title-workspace">
              <span className="chat-title-sep" aria-hidden="true">
                ·
              </span>
              <Tooltip content={t("房间工作区：{0}", { 0: currentRoomWorkspace })}>
                <span className="chat-title-workspace-name">{workspaceName}</span>
              </Tooltip>
              {currentRoom?.branch &&
                (isOwner && local.enabled ? (
                  <WorktreeSwitcher
                    branch={currentRoom.branch}
                    loadWorktrees={loadRoomWorktrees}
                    loadOverview={loadWorkspaceDetail}
                    onOpenSource={openWorkspaceSource}
                    onManage={openWorktrees}
                  />
                ) : (
                  <Tooltip content={t("当前分支")}>
                    <span className="chat-title-branch">
                      <BranchGlyph />
                      <span className="chat-title-branch-name">{currentRoom.branch}</span>
                    </span>
                  </Tooltip>
                ))}
            </span>
          )}
          {local.keepAwake &&
            (local.keepAwake.status === "active" || local.keepAwake.status === "failed") && (
              <Tooltip content={keepAwakeSummary(local.keepAwake)}>
                <button
                  type="button"
                  className={`keep-awake-badge ${local.keepAwake.status}`}
                  aria-label={keepAwakeSummary(local.keepAwake)}
                  onClick={() => {
                    setSettingsTab("computer");
                    setSettingsOpen(true);
                  }}
                >
                  {local.keepAwake.status === "active" ? t("☾ 保持在线") : t("! 保持在线未生效")}
                </button>
              </Tooltip>
            )}
        </span>
      </div>
      <div className="chat-header-actions">
        <Tooltip
          content={t("开启新话题：房间里的 Agent 会丢弃之前的会话，从新会话开始；历史消息保留")}
        >
          <button
            type="button"
            className="header-button new-topic"
            data-overflow="new-topic"
            aria-label={t("新话题")}
            disabled={newTopicDisabled}
            onClick={startNewTopic}
          >
            <Icon name="plus" size={16} />
            <span className="header-button-label">{t("新话题")}</span>
          </button>
        </Tooltip>
        <Tooltip content={t("产物：房间里的图片和文件")}>
          <button
            ref={artifactsButtonRef}
            type="button"
            className={`header-button artifacts-toggle ${artifactsOpen ? "active" : ""}`}
            aria-label={
              artifactCount
                ? t("产物：{0} 个图片和文件", { 0: artifactCount })
                : t("产物：房间里的图片和文件")
            }
            aria-pressed={artifactsOpen}
            onClick={() => {
              setWorkspaceOpen(false);
              setArtifactsOpen((current) => !current);
            }}
          >
            <Icon name="files" size={16} />
            <span className="header-button-label">{t("产物")}</span>
            {artifactCount ? (
              <span className="header-count" aria-hidden="true">
                {artifactCount > 99 ? "99+" : artifactCount}
              </span>
            ) : null}
          </button>
        </Tooltip>
        {canViewWorkspace && (
          <Tooltip content={t("工作区文件与改动（只读）")}>
            <button
              ref={workspaceButtonRef}
              type="button"
              className={`header-button workspace-toggle ${workspaceOpen ? "active" : ""}`}
              data-overflow="workspace"
              aria-pressed={workspaceOpen}
              aria-label={
                workspaceChangeCount
                  ? t("工作区文件与改动（{0} 个文件有未提交改动）", { 0: workspaceChangeCount })
                  : t("工作区文件与改动")
              }
              onClick={toggleWorkspace}
            >
              <WorkspaceGlyph />
              <span className="header-button-label">{t("代码")}</span>
              {workspaceChangeCount > 0 && (
                <span className="header-count workspace-toggle-count" aria-hidden="true">
                  {workspaceChangeCount > 999 ? "999+" : workspaceChangeCount}
                </span>
              )}
            </button>
          </Tooltip>
        )}
        {terminal && (
          <Tooltip content={t("终端（Ctrl+`）：在当前房间的工作区目录打开")}>
            <button
              type="button"
              className={`header-button terminal-toggle ${terminal.open ? "active" : ""}`}
              data-overflow="terminal"
              aria-label={t("终端")}
              aria-pressed={terminal.open}
              onClick={terminal.toggle}
            >
              <Icon name="terminal" size={16} />
              <span className="header-button-label">{t("终端")}</span>
            </button>
          </Tooltip>
        )}
        <Tooltip content={shareLabel}>
          <button
            type="button"
            className={`header-button share-fab ${shareMode ? "active" : ""}`}
            data-overflow="share"
            aria-label={shareLabel}
            aria-pressed={shareMode}
            onClick={toggleShare}
          >
            <Icon name="share" size={16} />
            <span className="header-button-label">{shareMode ? t("取消") : t("分享")}</span>
          </button>
        </Tooltip>
        <Tooltip content={moreMenu ? undefined : t("更多操作")}>
          <button
            ref={moreButtonRef}
            type="button"
            className={`header-button header-more${shareMode ? " active" : ""}`}
            aria-label={t("更多操作")}
            aria-haspopup="menu"
            aria-expanded={Boolean(moreMenu)}
            onPointerDown={() => {
              moreWasOpen.current = Boolean(moreMenu);
            }}
            onClick={(event) => {
              if (moreWasOpen.current || moreMenu) {
                moreWasOpen.current = false;
                setMoreMenu(undefined);
                return;
              }
              const buttons = [
                ...(headerRef.current?.querySelectorAll<HTMLElement>("[data-overflow]") ?? []),
              ];
              const collapsed = buttons.filter((el) => getComputedStyle(el).display === "none");
              const rect = event.currentTarget.getBoundingClientRect();
              setMoreMenu({
                align: "end",
                x: rect.right,
                y: rect.bottom + 4,
                // 收起哪几个由样式按顶栏宽度决定；万一一个都没收（样式没加载），就全列出来
                items: (collapsed.length ? collapsed : buttons).map(
                  (el) => overflowItems[el.dataset.overflow!]!,
                ),
              });
            }}
          >
            <Icon name="more" size={17} />
          </button>
        </Tooltip>
        <Tooltip content={t("打开成员列表")}>
          <button
            type="button"
            className="header-button members-drawer-toggle"
            aria-label={t("打开成员列表")}
            aria-expanded={mobilePanel === "members"}
            onClick={(event) => openMobilePanel("members", event.currentTarget)}
          >
            <Icon name="users" size={17} />
          </button>
        </Tooltip>
        <Tooltip content={rightPanelLabel}>
          <button
            type="button"
            className="header-button desktop-only"
            aria-label={rightPanelLabel}
            aria-pressed={previewDocked || !membersCollapsed}
            onClick={() =>
              animateLayout(() => {
                // 停靠着预览时右侧栏一定是开着的：这里就是收起它，连预览一起关
                if (previewDocked) {
                  setDockedPreview(undefined);
                  localStorage.setItem(storedMembersCollapsedKey, "true");
                  setMembersCollapsed(true);
                  return;
                }
                setMembersCollapsed((current) => {
                  localStorage.setItem(storedMembersCollapsedKey, String(!current));
                  return !current;
                });
              })
            }
          >
            <Icon name="panel-right" size={17} />
          </button>
        </Tooltip>
      </div>
      {moreMenu && (
        <ContextMenu
          menu={moreMenu}
          onClose={() => {
            setMoreMenu(undefined);
            // 键盘关掉菜单（Esc、选了一项）焦点回到「更多」；点别处关的由那次点击决定焦点
            if (!document.activeElement || document.activeElement === document.body) {
              moreButtonRef.current?.focus();
            }
          }}
        />
      )}
    </header>
  );
}

/** 顶栏下方的提示条：可清理的 worktree、错误、Agent 连续对话暂停、开启浏览器通知 */
export function ChatNotices({
  error,
  setError,
  showNotificationPrompt,
  invocations,
  messages,
  worktreeNotices,
  setWorktreeNotices,
  isOwner,
  local,
  currentRoomId,
  setGotoNotice,
  extendAgentBudget,
  dismissNotificationPrompt,
  ensureNotificationPermission,
}: {
  error: string | undefined;
  setError: Dispatch<SetStateAction<string | undefined>>;
  showNotificationPrompt: boolean;
  invocations: ReadonlyMap<string, Invocation>;
  messages: ChatMessage[];
  worktreeNotices: Map<string, { batchId: string; count: number }>;
  setWorktreeNotices: Dispatch<SetStateAction<Map<string, { batchId: string; count: number }>>>;
  isOwner: boolean;
  local: LocalAgentsState;
  currentRoomId: string;
  setGotoNotice: Dispatch<SetStateAction<string | undefined>>;
  extendAgentBudget: () => void;
  dismissNotificationPrompt: () => void;
  ensureNotificationPermission: () => Promise<boolean>;
}) {
  const pausedInvocations = useMemo(
    () => currentPausedInvocations(invocations.values(), messages),
    [invocations, messages],
  );
  const pausedAgentNames = useMemo(
    () => [...new Set(pausedInvocations.map((invocation) => `@${invocation.agentName}`))],
    [pausedInvocations],
  );
  return (
    <>
      {(error ||
        showNotificationPrompt ||
        pausedInvocations.length > 0 ||
        worktreeNotices.has(currentRoomId)) && (
        <div className="chat-notices">
          {isOwner && local.enabled && worktreeNotices.has(currentRoomId) && (
            <div className="notification-prompt worktree-batch" role="status">
              <span>
                {t("{0} 个任务目录已合入，可清理。", {
                  0: worktreeNotices.get(currentRoomId)!.count,
                })}
              </span>
              <Button
                variant="primary"
                disabled={!local.canManage}
                onClick={async () => {
                  const notice = worktreeNotices.get(currentRoomId)!;
                  try {
                    await local.cleanWorktreeBatch(currentRoomId, notice.batchId);
                    setWorktreeNotices((current) => {
                      const next = new Map(current);
                      next.delete(currentRoomId);
                      return next;
                    });
                    setGotoNotice(t("已提交批量清理请求，完成后通知。"));
                  } catch (reason) {
                    setError(reason instanceof Error ? reason.message : String(reason));
                  }
                }}
              >
                {t("清理这批目录")}
              </Button>
            </div>
          )}
          {error && (
            <div className="error-banner" role="alert">
              <span>{error}</span>
              <IconButton label={t("关闭错误提示")} onClick={() => setError(undefined)}>
                <Icon name="close" size={16} />
              </IconButton>
            </div>
          )}
          {pausedInvocations.length > 0 && (
            <div
              className="notification-prompt budget-prompt"
              role="status"
              aria-label={t("Agent 连续对话已暂停")}
            >
              <Icon name="shield" size={18} />
              <p>
                <strong>{t("Agent 连续对话已暂停，等待你确认")}</strong>
                {pausedAgentNames.slice(0, 3).join(t("、"))}
                {pausedAgentNames.length > 3 ? t(" 等") : ""} {t("的调用触及了防循环限制。")}
              </p>
              <div className="notification-prompt-actions">
                <Button variant="primary" onClick={extendAgentBudget}>
                  {t("继续 {0} 轮", { 0: BUDGET_EXTEND_TURNS })}
                </Button>
              </div>
            </div>
          )}
          {showNotificationPrompt && (
            <div className="notification-prompt" role="status" aria-label={t("开启浏览器通知")}>
              <Icon name="bell" size={18} />
              <p>
                <strong>{t("开启浏览器通知")}</strong>
                {t("页面不在前台时，有人 @ 你会收到系统提醒。")}
              </p>
              <div className="notification-prompt-actions">
                <Button onClick={dismissNotificationPrompt}>{t("暂不")}</Button>
                <Button variant="primary" onClick={() => void ensureNotificationPermission()}>
                  {t("开启")}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
