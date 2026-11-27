import { t } from "./i18n";
import { PanelResizer, type ResizablePanel } from "./panel-resizer";
import { HiveLogo, Icon, ThemeSwitcher } from "./app-icons";
import { AttentionRoomGroup, type useAttention } from "./attention-alerts";
import {
  storedThemeKey,
  storedUsernameKey,
  type MobilePanel,
  type ThemePreference,
} from "./app-storage";
import { avatarHueStyle } from "./avatar";
import { docsHref } from "./docs-link";
import {
  useEffect,
  useRef,
  type RefObject,
  type Dispatch,
  type SetStateAction,
  type ReactNode,
} from "react";
import type { RoomSummary } from "@superhive/protocol";
import type { ActivityView } from "./activity";
import type { IncidentAttentionItem } from "./incidents-panel";
import type { useRoomReorder } from "./room-reorder";
import { Tooltip } from "./tooltip";
import { Button, IconButton } from "./button";
import { DesktopUpdateEntry } from "./desktop-update";
import { desktopBridge } from "./desktop-bridge";
import { returnFocus } from "./focus-return";
import { openJoinDialog, RemoteServerList } from "./join-remote";

/** 浏览器里「下载客户端」指向的地方：GitHub Releases 最新版（有 Windows 安装包和 macOS dmg） */
export const DESKTOP_DOWNLOAD_URL = "https://github.com/wangrongding/SuperHive/releases/latest";

/** 左侧栏：房间列表、需要处理的事项与当前用户 */
export function RoomSidebar({
  activeRoomCount,
  attention,
  attentionGroup,
  closeMobilePanel,
  connectionState,
  freezeRoomList,
  incidentAttention,
  incidentEntry,
  isOwner,
  mobilePanel,
  modifierKeyLabel,
  openActivity,
  openOwnerDevices,
  openRoomDialog,
  openFeedback,
  panelWidths,
  renderRoomItem,
  resizePanel,
  roomNameOf,
  roomReorder,
  roomsCloseRef,
  scheduleCounts,
  openSchedules,
  setImDialogOpen,
  setMobilePanel,
  setSettingsOpen,
  setShowArchivedRooms,
  setThemePreference,
  setUserMenuOpen,
  setUsername,
  settingsTriggerRef,
  showArchivedRooms,
  sidebarRooms,
  taskCounts,
  thawRoomList,
  themePreference,
  unreadMentionCount,
  userMenuOpen,
  userMenuTriggerRef,
  username,
}: {
  activeRoomCount: number;
  attention: ReturnType<typeof useAttention>;
  attentionGroup: boolean;
  closeMobilePanel: (restoreFocus?: boolean) => void;
  connectionState: "connecting" | "online" | "offline";
  freezeRoomList: () => void;
  /** 升级给人的故障单和待批准的规则提议，排在「需要你处理」里任务的后面 */
  incidentAttention: readonly IncidentAttentionItem[];
  /** 左侧「故障」入口：只给这台电脑上的房主；count 是还没人管的故障单和规则提议 */
  incidentEntry:
    { count: number; open: (trigger?: HTMLElement, focusId?: string) => void } | undefined;
  isOwner: boolean;
  mobilePanel: MobilePanel | undefined;
  modifierKeyLabel: string;
  openActivity: (view: ActivityView, trigger?: HTMLElement | null) => void;
  /** 用户菜单「在其他设备登录」：只在这台电脑（或已登录的设备）上给房主 */
  openOwnerDevices?: (() => void) | undefined;
  openFeedback?: (() => void) | undefined;
  openRoomDialog: (
    dialog: { mode: "create" } | { mode: "manage"; room: RoomSummary },
    trigger: HTMLButtonElement,
  ) => void;
  panelWidths: { rooms: number; members: number; preview: number };
  renderRoomItem: (room: RoomSummary, index: number, pinned: boolean) => ReactNode;
  resizePanel: (panel: ResizablePanel, width: number) => void;
  roomNameOf: (roomId: string) => string;
  roomReorder: ReturnType<typeof useRoomReorder>;
  roomsCloseRef: RefObject<HTMLButtonElement | null>;
  /** 左侧「定时任务」入口：pending 是所有房间里待执行的，attention 是上次打开面板后才失败、错过的 */
  scheduleCounts: { pending: number; attention: number };
  openSchedules: (trigger?: HTMLElement | null) => void;
  setImDialogOpen: Dispatch<SetStateAction<boolean>>;
  setMobilePanel: Dispatch<SetStateAction<MobilePanel | undefined>>;
  setSettingsOpen: Dispatch<SetStateAction<boolean>>;
  setShowArchivedRooms: Dispatch<SetStateAction<boolean>>;
  setThemePreference: Dispatch<SetStateAction<ThemePreference>>;
  setUserMenuOpen: Dispatch<SetStateAction<boolean>>;
  setUsername: Dispatch<SetStateAction<string>>;
  settingsTriggerRef: RefObject<HTMLButtonElement | null>;
  showArchivedRooms: boolean;
  sidebarRooms: { pinned: RoomSummary[]; others: RoomSummary[] };
  taskCounts: { attention: number; inFlight: number };
  thawRoomList: (element: HTMLElement) => void;
  themePreference: ThemePreference;
  unreadMentionCount: number;
  userMenuOpen: boolean;
  userMenuTriggerRef: RefObject<HTMLButtonElement | null>;
  username: string;
}) {
  const userMenuRef = useRef<HTMLDivElement>(null);
  // 菜单只靠点击开关：点头像栏切换，点菜单外任何地方、按 Esc 关上
  useEffect(() => {
    if (!userMenuOpen) return;
    const closeOnOutside = (event: MouseEvent) => {
      if (!userMenuRef.current?.contains(event.target as Node)) setUserMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setUserMenuOpen(false);
      returnFocus(userMenuTriggerRef.current);
    };
    document.addEventListener("mousedown", closeOnOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [setUserMenuOpen, userMenuOpen, userMenuTriggerRef]);
  return (
    <aside
      className={`rooms-panel panel ${mobilePanel === "rooms" ? "mobile-open" : ""}`}
      aria-label={t("房间列表")}
    >
      <PanelResizer panel="rooms" width={panelWidths.rooms} onResize={resizePanel} />
      <div className="sidebar-header">
        <div className="brand">
          <HiveLogo compact />
          <strong>SuperHive</strong>
        </div>
        <div
          className={`connection ${connectionState}`}
          role="status"
          aria-live="polite"
          title={
            connectionState === "online"
              ? t("Hive 已在线")
              : connectionState === "connecting"
                ? t("正在连接")
                : t("连接已中断")
          }
        >
          <span aria-hidden="true" />
          <span className="connection-label">
            {connectionState === "online"
              ? t("Hive 已在线")
              : connectionState === "connecting"
                ? t("正在连接")
                : t("连接已中断")}
          </span>
        </div>
        <IconButton
          ref={roomsCloseRef}
          className="panel-close"
          label={t("关闭房间列表")}
          onClick={() => closeMobilePanel()}
        >
          <Icon name="close" />
        </IconButton>
      </div>
      <nav className="sidebar-actions" aria-label={t("快捷操作")}>
        {isOwner && (
          <button
            className="sidebar-action room-create"
            type="button"
            aria-label={t("新建房间")}
            aria-haspopup="dialog"
            onClick={(event) => openRoomDialog({ mode: "create" }, event.currentTarget)}
          >
            <Icon name="plus" size={16} />
            <span>{t("新建房间")}</span>
          </button>
        )}
        {isOwner && (
          <button
            className="sidebar-action"
            type="button"
            aria-label={t("加入别人的房间")}
            aria-haspopup="dialog"
            onClick={() => openJoinDialog()}
          >
            <Icon name="share" size={16} />
            <span>{t("加入别人的房间")}</span>
          </button>
        )}
        <button
          type="button"
          className="sidebar-action"
          aria-label={t("搜索消息")}
          aria-haspopup="dialog"
          onClick={(event) => openActivity("search", event.currentTarget)}
        >
          <Icon name="search" size={16} />
          <span>{t("搜索")}</span>
          <kbd className="sidebar-shortcut" aria-hidden="true">
            {modifierKeyLabel === "Cmd" ? "⌘K" : "Ctrl K"}
          </kbd>
        </button>
        <button
          type="button"
          className="sidebar-action"
          aria-label={
            unreadMentionCount > 0
              ? t("提及我，{0} 条未读", { 0: unreadMentionCount })
              : t("提及我")
          }
          aria-haspopup="dialog"
          onClick={(event) => openActivity("mentions", event.currentTarget)}
        >
          <Icon name="at" size={16} />
          <span>{t("提及我")}</span>
          {unreadMentionCount > 0 && (
            <span className="sidebar-badge accent" aria-hidden="true">
              {unreadMentionCount > 99 ? "99+" : unreadMentionCount}
            </span>
          )}
        </button>
        <button
          type="button"
          className="sidebar-action"
          aria-label={t("Agent 任务{0}{1}", {
            0: taskCounts.inFlight ? t("，{0} 个进行中", { 0: taskCounts.inFlight }) : "",
            1: taskCounts.attention ? t("，{0} 个需要处理", { 0: taskCounts.attention }) : "",
          })}
          aria-haspopup="dialog"
          onClick={(event) => openActivity("tasks", event.currentTarget)}
        >
          <Icon name="activity" size={16} />
          <span>{t("Agent 任务")}</span>
          {taskCounts.inFlight > 0 && (
            <span className="sidebar-badge running" aria-hidden="true">
              {taskCounts.inFlight}
            </span>
          )}
          {taskCounts.attention > 0 && (
            <span className="sidebar-badge warning" aria-hidden="true">
              {taskCounts.attention}
            </span>
          )}
        </button>
        <Tooltip content={t("所有房间的定时任务")}>
          <button
            type="button"
            className="sidebar-action"
            data-entry="schedules"
            aria-label={t("定时任务{0}{1}", {
              0: scheduleCounts.pending ? t("，{0} 个待执行", { 0: scheduleCounts.pending }) : "",
              1: scheduleCounts.attention
                ? t("，{0} 个没有正常完成", { 0: scheduleCounts.attention })
                : "",
            })}
            aria-haspopup="dialog"
            onClick={(event) => openSchedules(event.currentTarget)}
          >
            <Icon name="clock" size={16} />
            <span>{t("定时任务")}</span>
            {scheduleCounts.pending > 0 && (
              <span className="sidebar-badge" aria-hidden="true">
                {scheduleCounts.pending > 99 ? "99+" : scheduleCounts.pending}
              </span>
            )}
            {scheduleCounts.attention > 0 && (
              <span className="sidebar-badge warning" aria-hidden="true">
                {scheduleCounts.attention > 99 ? "99+" : scheduleCounts.attention}
              </span>
            )}
          </button>
        </Tooltip>
        {incidentEntry && (
          <Tooltip content={t("故障单和慢操作")}>
            <button
              type="button"
              className="sidebar-action"
              aria-label={
                incidentEntry.count > 0
                  ? t("故障，{0} 条待处理", { 0: incidentEntry.count })
                  : t("故障")
              }
              aria-haspopup="dialog"
              onClick={(event) => incidentEntry.open(event.currentTarget)}
            >
              <Icon name="alert" size={16} />
              <span>{t("故障")}</span>
              {incidentEntry.count > 0 && (
                <span className="sidebar-badge warning" aria-hidden="true">
                  {incidentEntry.count > 99 ? "99+" : incidentEntry.count}
                </span>
              )}
            </button>
          </Tooltip>
        )}
        {isOwner && (
          <Tooltip content={t("扫码接入飞书或微信，在手机上给房间发消息")}>
            <button
              type="button"
              className="sidebar-action"
              aria-haspopup="dialog"
              onClick={() => setImDialogOpen(true)}
            >
              <Icon name="message" size={16} />
              <span>{t("连接 IM")}</span>
            </button>
          </Tooltip>
        )}
      </nav>
      {attentionGroup && (
        <AttentionRoomGroup
          items={attention.items}
          incidents={incidentAttention}
          roomName={roomNameOf}
          onOpen={attention.open}
          onOpenIncident={(item) => incidentEntry?.open(undefined, item.id)}
        />
      )}
      <div className="sidebar-section-label">
        <span>{t("房间列表")}</span>
        <span className="panel-meta">{activeRoomCount}</span>
      </div>
      {/* 置顶区和其余房间一起滚动：置顶多了也不会把下面挤得只剩一小块 */}
      <div className="room-scroll" ref={roomReorder.scrollRef}>
        {sidebarRooms.pinned.length > 0 && (
          <div
            className={`room-list pinned ${roomReorder.dragging ? "reordering" : ""}`}
            ref={roomReorder.listRef}
            role="group"
            aria-label={t("已置顶")}
          >
            {sidebarRooms.pinned.map((room, index) => renderRoomItem(room, index, true))}
          </div>
        )}
        <div
          className="room-list"
          onPointerEnter={freezeRoomList}
          onPointerLeave={(event) => thawRoomList(event.currentTarget)}
          onFocus={freezeRoomList}
          onBlur={(event) => {
            const list = event.currentTarget;
            // 焦点还在列表里（用 Tab 换到下一个房间）就继续保持
            if (!list.contains(event.relatedTarget as Node | null)) {
              window.setTimeout(() => thawRoomList(list));
            }
          }}
        >
          {sidebarRooms.others.map((room, index) => renderRoomItem(room, index, false))}
        </div>
        <RemoteServerList />
      </div>
      <Button
        size="sm"
        variant="ghost"
        className="room-archived-toggle"
        onClick={() => setShowArchivedRooms((current) => !current)}
      >
        {showArchivedRooms ? t("隐藏已归档房间") : t("显示已归档房间")}
      </Button>
      <DesktopUpdateEntry />
      <div className="sidebar-user" ref={userMenuRef}>
        {userMenuOpen && (
          <div className="user-menu" role="menu" aria-label={t("用户菜单")}>
            <div className="user-menu-theme">
              <span>{t("主题")}</span>
              <ThemeSwitcher
                value={themePreference}
                onChange={(value) => {
                  setThemePreference(value);
                  localStorage.setItem(storedThemeKey, value);
                }}
              />
            </div>
            {openOwnerDevices && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setUserMenuOpen(false);
                  setMobilePanel(undefined);
                  openOwnerDevices();
                }}
              >
                <Icon name="devices" size={15} />
                <span>{t("在其他设备登录")}</span>
              </button>
            )}
            <a
              role="menuitem"
              className="user-menu-docs"
              href={docsHref("home")}
              target="_blank"
              rel="noreferrer"
              onClick={() => {
                setUserMenuOpen(false);
                setMobilePanel(undefined);
              }}
            >
              <Icon name="help" size={15} />
              <span>{t("帮助与文档")}</span>
              <Icon name="external" size={13} />
            </a>
            {/* 桌面客户端里不出：客户端自己有 DesktopUpdateEntry 管更新 */}
            {!desktopBridge() && (
              <a
                role="menuitem"
                className="user-menu-external"
                href={DESKTOP_DOWNLOAD_URL}
                target="_blank"
                rel="noreferrer"
                onClick={() => {
                  setUserMenuOpen(false);
                  setMobilePanel(undefined);
                }}
              >
                <Icon name="download" size={15} />
                <span>{t("下载客户端")}</span>
                <Icon name="external" size={13} />
              </a>
            )}
            {openFeedback && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setUserMenuOpen(false);
                  openFeedback();
                }}
              >
                <Icon name="message" size={15} />
                <span>{t("反馈问题 / 建议功能")}</span>
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              className="user-menu-logout"
              onClick={() => {
                setUserMenuOpen(false);
                localStorage.removeItem(storedUsernameKey);
                setUsername("");
              }}
            >
              <Icon name="logout" size={15} />
              <span>{t("退出")}</span>
            </button>
          </div>
        )}
        <div className="sidebar-identity-row">
          <button
            ref={userMenuTriggerRef}
            type="button"
            className="sidebar-user-chip"
            aria-label={t("用户菜单")}
            aria-haspopup="menu"
            aria-expanded={userMenuOpen}
            onClick={() => setUserMenuOpen((current) => !current)}
          >
            <span className="identity-avatar" style={avatarHueStyle(username)} aria-hidden="true">
              {username.slice(0, 1).toUpperCase()}
            </span>
            <span className="identity-copy">
              <strong>{username}</strong>
              <small>{t("当前身份")}</small>
            </span>
          </button>
          {openFeedback && (
            <IconButton
              className="sidebar-feedback"
              label={t("反馈问题 / 建议功能")}
              aria-haspopup="dialog"
              onClick={openFeedback}
            >
              <Icon name="message" size={18} />
            </IconButton>
          )}
          <IconButton
            ref={settingsTriggerRef}
            className="sidebar-settings"
            label={t("设置")}
            aria-haspopup="dialog"
            onClick={() => {
              setUserMenuOpen(false);
              setMobilePanel(undefined);
              setSettingsOpen(true);
            }}
          >
            <Icon name="settings" size={18} />
          </IconButton>
        </div>
      </div>
    </aside>
  );
}
