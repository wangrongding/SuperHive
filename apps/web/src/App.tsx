import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { BranchGlyph } from "./worktree-switcher";
import { TerminalDock, useDesktopTerminal } from "./terminal-dock";
import { useSlowOps } from "./slow-ops";
import { incidentsAvailable, useIncidents } from "./incidents-panel";
import { IncidentsDialog, type IncidentsTab } from "./incidents-dialog";
import { FeedbackDialog } from "./feedback-dialog";
import { contributionAgents } from "./feedback";
import { sendContribution } from "./contribution-send";
import { WorktreePanel } from "./worktree-panel";
import { installErrorReporter } from "./error-report";
import { WorkspacePanel, workspaceApi, type WorkspaceFocus } from "./workspace-panel";
import { RefResolver, WorkspaceRefsContext, type RefTarget } from "./workspace-refs";
import type {
  Attachment,
  ChatMessage,
  Invocation,
  Incident,
  LocalAgent,
  MetaResponse,
  Participant,
  RoomSummary,
  WhiteboardEntry,
  WorkspaceOverview,
} from "@superhive/protocol";
import { localizeServerPayload, serverError } from "./server-text";
import { invocationStatusLabel } from "./invocations";
import { buildProgress } from "./progress";
import { SchedulesDialog } from "./schedules";
import { ArtifactsPanel, useArtifactCount } from "./artifacts";
import { moveRoom } from "./room-reorder";
import { ActivityPanel, isInFlight, type ActivityView } from "./activity";
import { buildGoToItems } from "./goto";
import { GoToPalette } from "./goto-palette";
import { matchShortcut, type ShortcutId } from "./shortcuts";
import { ShortcutsHelp } from "./shortcuts-help";
import {
  ContextMenu,
  contextMenuPoint,
  type ContextMenuItem,
  type ContextMenuState,
} from "./context-menu";
import { isPortalBubble } from "./message-selection";
import { AttentionToasts, useAttention, type AttentionDelivery } from "./attention-alerts";
import { attentionLabels, concernsMe, nextAttention } from "./attention";
import { useFaviconBadge } from "./favicon-badge";
import {
  OnboardingGuide,
  finishOnboarding,
  markOnboardingIfNew,
  onboardingPending,
  type OnboardingStep,
} from "./onboarding";
import { useLocalAgents } from "./local-agents";
import type { SelectableAgentProvider } from "./agent-name";
import { agentTasks, nextAgentTaskIndex } from "./agent-tasks";
import { copyTextToClipboard } from "./clipboard";
import type { GuestAccess } from "./access-gate";
import { GuestAgentDialog, InviteDialog } from "./invite-dialog";
import { JoinRemoteHost } from "./join-remote";
import { ImDialog } from "./im-dialog";
import { OwnerDevicesDialog } from "./owner-devices-dialog";
import { AgentSettingsDialog, SettingsGlyph } from "./agent-settings-dialog";
import { RetryModelDialog } from "./model-picker";
import { AttachmentLocalOpenContext, FilePreview } from "./attachments";
import { listImConnections } from "./im-api";
import { resolveShareBase } from "./server-url";
import { getLocale, getLocalePreference, t, useLocale } from "./i18n";
import { usePanelWidths } from "./panel-resizer";
import {
  storedUsernameKey,
  storedRoomKey,
  storedAutoSaveDraftKey,
  storedRichComposerKey,
  storedTimeFormatKey,
  storedMessageNotificationsKey,
  storedNotificationPromptDismissedKey,
  storedNotificationSoundKey,
  storedPresenceNotificationsKey,
  storedThemeKey,
  storedStatusBarKey,
  storedDensityKey,
  storedThreadWidthKey,
  storedMessageSizeKey,
  storedMembersCollapsedKey,
  storedRoomsCollapsedKey,
  storedReduceMotionKey,
  storedAttentionDeliveryKey,
  storedAttentionSoundKey,
  storedAttentionGroupKey,
  MessageNotificationMode,
  SendShortcut,
  SettingsTab,
  TimeFormat,
  ThemePreference,
  InterfaceDensity,
  ThreadWidth,
  MessageSize,
  MobilePanel,
  SidePanelTab,
  settingsTabs,
  storedSendShortcut,
  storedBoolean,
  storedChoice,
  storedMessageNotificationMode,
} from "./app-storage";
import { roomIdFromHash, initialRoomId } from "./rooms";
import { BrowserNotificationPermission, browserNotificationPermission } from "./browser-notify";
import { platformModifierLabel } from "./ui-utils";
import { AgentAccessMode, AgentSetupStep, agentCommandFor } from "./agent-setup";
import { PinGlyph, Icon } from "./app-icons";
import { serverBase } from "./server-base";
import {
  HostApprovalsBanner,
  HostApprovalWaiting,
  lanBlocksSharing,
  revealLanSwitch,
  useDesktopLan,
} from "./host-settings";
import { LoginDialog } from "./login-dialog";
import { RoomDialog } from "./room-dialog";
import { isAutoLead, leadChoiceOf, leadPatchOf } from "./lead-agent";
import { SettingsDialog } from "./settings-dialog";
import { RuntimeHubDialog } from "./runtime-hub";
import { AgentSetupDialog } from "./agent-setup-dialog";
import { SidePanel } from "./side-panel";
import { previewGone, useRoomSide } from "./room-side-state";
import {
  PluginSidePanel,
  pluginPanelKey,
  useRoomPlugins,
  type PluginCommandDispatch,
  type PluginPanelKey,
} from "./plugins";
import { matchPluginCommand } from "./plugin-host";
import { returnFocus } from "./focus-return";
import { RoomSidebar } from "./room-sidebar";
import { useRoomData } from "./use-room-data";
import { useRoomList } from "./use-room-list";
import { useRoomConnection, type GlobalEvents } from "./use-room-connection";
import { useReadState } from "./read-state";
import { useMessageScroll } from "./use-message-scroll";
import { useMessageJump, useMessageWindow } from "./use-message-timeline";
import { useComposer } from "./use-composer";
import { useMessageActions } from "./use-message-actions";
import { TodoPanel } from "./todos";
import { todoApi, todoFromMessage } from "./todo-api";
import { useActivityData } from "./use-activity-data";
import { ChatHeader, ChatNotices } from "./chat-header";
import { MessageList } from "./message-list";
import { ShareBar, useShareSelection } from "./share-bar";
import { Composer } from "./composer";
import { Tooltip } from "./tooltip";
import { useAppLoadingStatus, useAppReady } from "./boot-splash";
import type { LoadingStatus } from "./loading-status";
import { Button } from "./button";
import { StatusBar } from "./status-bar";
import { UpdateCorner } from "./update-corner";

export function App({
  guest,
  ownerToken,
  onAccessLost,
}: {
  /** 凭限时邀请进入的访客：只能在这个房间、以这个名字活动 */
  guest?: GuestAccess;
  /** 远程房主手动填入的共享接入令牌；本机房主不需要 */
  ownerToken?: string;
  onAccessLost?: (reason: "expired" | "revoked") => void;
} = {}) {
  // 语言切换后整棵界面重新渲染，t() 取到新语言
  const locale = useLocale();
  const localePreference = getLocalePreference();
  const [meta, setMeta] = useState<MetaResponse>();
  // 第一次打开（本机还没有昵称）的标成待引导；必须在读昵称之前判断
  const [onboardingWanted, setOnboardingWanted] = useState(() => {
    if (guest) return false;
    markOnboardingIfNew(localStorage, storedUsernameKey);
    return onboardingPending(localStorage);
  });
  const [onboardingOpen, setOnboardingOpen] = useState(true);
  const [imConnected, setImConnected] = useState(false);
  const [username, setUsername] = useState(
    () => guest?.username ?? localStorage.getItem(storedUsernameKey) ?? "",
  );
  const [currentRoomId, setCurrentRoomId] = useState(() => guest?.roomId ?? initialRoomId());
  const currentRoomIdRef = useRef(currentRoomId);
  currentRoomIdRef.current = currentRoomId;
  // 访客用兑换得到的会话令牌；房主用共享 join token（只在 Server 所在电脑或填入令牌时拿得到）
  const authToken = meta?.joinToken ?? guest?.token;
  const isOwner = Boolean(meta?.joinToken);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [imDialogOpen, setImDialogOpen] = useState(false);
  /** 从状态栏角标打开时要定位的 IM 连接 */
  const [imFocus, setImFocus] = useState<string>();
  const [ownerDevicesOpen, setOwnerDevicesOpen] = useState(false);
  const [guestAgentDialogOpen, setGuestAgentDialogOpen] = useState(false);
  const [accessNow, setAccessNow] = useState(() => Date.now());
  useEffect(() => {
    // 成员列表的剩余时间每分钟刷新一次
    const timer = window.setInterval(() => setAccessNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const base = useMemo(serverBase, []);
  const [error, setError] = useState<string>();
  const room = useRoomData({ base, authToken, currentRoomId });
  const readState = useReadState({ base, authToken, meta });
  const {
    participants,
    messages,
    setMessages,
    invocations,
    setInvocations,
    whiteboard,
    whiteboardEpochRef,
    latestSeqRef,
    loadWhiteboardHistory,
    changeWhiteboardArchive,
  } = room;
  const {
    rooms,
    setRooms,
    readSeqs,
    showArchivedRooms,
    setShowArchivedRooms,
    sidebarRooms,
    pinnedRoomIds,
    freezeRoomList,
    thawRoomList,
    savePinnedRooms,
    roomReorder,
    activeRoomCount,
    markRoomRead,
    upsertRoom,
    refreshRooms,
    markRoomReadNow,
  } = useRoomList({
    base,
    authToken,
    meta,
    isOwner,
    username,
    latestSeqRef,
    readState,
    setError,
  });
  // 消息本身不带 provider：按发送者名到成员表里查，离开房间的 Agent 回退为 "AI"
  const agentProviderByName = useMemo(
    () =>
      new Map(
        participants
          .filter((participant) => participant.type === "agent")
          .map((participant) => [participant.username.toLocaleLowerCase(), participant.provider]),
      ),
    [participants],
  );
  /* 右侧栏按房间记住：当前标签页、停靠的文件预览，切回来照旧（见 room-side-state） */
  const roomSide = useRoomSide(username, currentRoomId);
  const setSidePanelTab = roomSide.setTab;
  const setDockedPreview = roomSide.setPreview;
  /** 有新附件或撤回时加一，产物面板和入口角标据此刷新 */
  const [artifactsEpoch, setArtifactsEpoch] = useState(0);
  /* 「产物」大面板：和「代码」一样从头部打开，默认铺满窗口；两个面板同时只开一个 */
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const artifactsButtonRef = useRef<HTMLButtonElement>(null);
  /*
   * 停靠在右侧栏的文件预览：占用成员栏的位置（成员栏收起时也会露出来），对话和输入框照常能用；
   * popped 时临时放大回弹窗。senderId、seq 用来认新版本：同一个人在本房间后来又发了同名文件。
   * 来源消息被撤回、不再带这个附件时当它没了
   */
  const storedDockedPreview = roomSide.preview;
  const dockedPreview =
    storedDockedPreview && !previewGone(storedDockedPreview, messages)
      ? storedDockedPreview
      : undefined;
  useEffect(() => {
    if (storedDockedPreview && !dockedPreview) setDockedPreview(undefined);
  }, [dockedPreview, setDockedPreview, storedDockedPreview]);
  // 跨房间入口：搜索、提及我、Agent 任务
  const [activityView, setActivityView] = useState<ActivityView>();
  const [gotoOpen, setGotoOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // 房间列表、成员列表的右键菜单
  const [contextMenu, setContextMenu] = useState<ContextMenuState>();
  // Agent 之间的委派、回执默认收成一行；点开的记在这里
  const [openMachineIds, setOpenMachineIds] = useState<ReadonlySet<string>>(new Set());
  const closeContextMenu = useCallback(() => setContextMenu(undefined), []);
  const activityTriggerRef = useRef<HTMLElement | null>(null);
  const attentionRef = useRef<ReturnType<typeof useAttention> | undefined>(undefined);
  const slowOpsRef = useRef<ReturnType<typeof useSlowOps> | undefined>(undefined);
  const globalEventsRef = useRef<GlobalEvents>({
    onInvocation: () => undefined,
    onSchedule: () => undefined,
    onRoomActivity: () => undefined,
    onReadState: () => undefined,
    onSnapshot: () => undefined,
  });
  const [connectionState, setConnectionState] = useState<"connecting" | "online" | "offline">(
    "connecting",
  );
  const [commandCopied, setCommandCopied] = useState(false);
  const [copyError, setCopyError] = useState<string>();
  const [agentProvider, setAgentProvider] = useState<SelectableAgentProvider>("codex");
  // 默认工作区档：只读什么都改不了，接进来基本没用；完全访问每次都要明确选
  const [agentAccess, setAgentAccess] = useState<AgentAccessMode>("workspace");
  // 第一步先让人选 Agent，选了才能下一步（不默认替人选一个）
  const [agentProviderChosen, setAgentProviderChosen] = useState(false);
  // 真的启动了或复制了命令才显示「完成」，免得第 3 步点了「完成」却什么也没发生
  const [agentConnected, setAgentConnected] = useState(false);
  const [agentStep, setAgentStep] = useState<AgentSetupStep>(1);
  const [fullAccessConfirmationOpen, setFullAccessConfirmationOpen] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>();
  const [agentDialogOpen, setAgentDialogOpen] = useState(false);
  const [rejoinAgent, setRejoinAgent] = useState<
    import("@superhive/protocol").RemovedLocalAgent & { participantId: string }
  >();
  const [roomDialog, setRoomDialog] = useState<
    { mode: "create" } | { mode: "manage"; room: RoomSummary }
  >();
  const [roomDialogId, setRoomDialogId] = useState("");
  const [roomDialogName, setRoomDialogName] = useState("");
  const [roomDialogWorkspace, setRoomDialogWorkspace] = useState("");
  const [roomDialogLead, setRoomDialogLead] = useState("");
  const [roomDialogGuestFiles, setRoomDialogGuestFiles] = useState(false);
  const [roomWorkspacePicking, setRoomWorkspacePicking] = useState(false);
  const [roomDialogError, setRoomDialogError] = useState<string>();
  const [roomDialogBusy, setRoomDialogBusy] = useState(false);
  const [worktreeNotices, setWorktreeNotices] = useState<
    Map<string, { batchId: string; count: number }>
  >(new Map());
  const worktreeNoticeVersion = useRef(0);
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [clearWhiteboard, setClearWhiteboard] = useState(true);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("chat");
  /** 从接入 Agent 弹窗跳到「Agent 运行时」时要看的 CLI；关掉设置后回到接入弹窗 */
  const [runtimesFocus, setRuntimesFocus] = useState<SelectableAgentProvider>();
  /** 「MCP 与技能」大面板：状态栏入口、设置里的按钮打开 */
  const [runtimeHubOpen, setRuntimeHubOpen] = useState(false);
  /** 从状态栏角标打开时要定位的 MCP */
  const [runtimeHubFocus, setRuntimeHubFocus] = useState<string>();
  const returnToAgentDialogRef = useRef(false);
  const [sendShortcut, setSendShortcut] = useState<SendShortcut>(storedSendShortcut);
  const [autoSaveDraft, setAutoSaveDraft] = useState(() =>
    storedBoolean(storedAutoSaveDraftKey, true),
  );
  /** 输入框边写边渲染 Markdown；关掉就是纯文本输入框 + 预览。单元测试里默认关（jsdom 跑不了编辑器的选区） */
  const [richComposer, setRichComposer] = useState(() =>
    storedBoolean(storedRichComposerKey, import.meta.env.MODE !== "test"),
  );
  const [timeFormat, setTimeFormat] = useState<TimeFormat>(() =>
    storedChoice(storedTimeFormatKey, ["system", "24h", "12h"], "system"),
  );
  const [messageNotifications, setMessageNotifications] = useState<MessageNotificationMode>(
    storedMessageNotificationMode,
  );
  const [notificationSound, setNotificationSound] = useState(() =>
    storedBoolean(storedNotificationSoundKey, false),
  );
  const [presenceNotifications, setPresenceNotifications] = useState(() =>
    storedBoolean(storedPresenceNotificationsKey, false),
  );
  const [attentionDelivery, setAttentionDelivery] = useState<AttentionDelivery>(() =>
    storedChoice(storedAttentionDeliveryKey, ["system", "page", "off"], "system"),
  );
  const [attentionSound, setAttentionSound] = useState(() =>
    storedBoolean(storedAttentionSoundKey, true),
  );
  const [attentionGroup, setAttentionGroup] = useState(() =>
    storedBoolean(storedAttentionGroupKey, true),
  );
  const [notificationPermission, setNotificationPermission] =
    useState<BrowserNotificationPermission>(browserNotificationPermission);
  const [notificationPromptDismissed, setNotificationPromptDismissed] = useState(() =>
    storedBoolean(storedNotificationPromptDismissedKey, false),
  );
  const [themePreference, setThemePreference] = useState<ThemePreference>(() =>
    storedChoice(storedThemeKey, ["system", "dark", "light"], "system"),
  );
  const [interfaceDensity, setInterfaceDensity] = useState<InterfaceDensity>(() =>
    storedChoice(storedDensityKey, ["comfortable", "compact"], "comfortable"),
  );
  const [threadWidth, setThreadWidth] = useState<ThreadWidth>(() =>
    storedChoice(storedThreadWidthKey, ["standard", "wide", "full"], "wide"),
  );
  const [membersCollapsed, setMembersCollapsed] = useState(() =>
    storedBoolean(storedMembersCollapsedKey, false),
  );
  const [roomsCollapsed, setRoomsCollapsed] = useState(() =>
    storedBoolean(storedRoomsCollapsedKey, false),
  );
  const [messageSize, setMessageSize] = useState<MessageSize>(() =>
    storedChoice(storedMessageSizeKey, ["small", "standard", "large"], "standard"),
  );
  const [reduceMotion, setReduceMotion] = useState(() =>
    storedBoolean(storedReduceMotionKey, false),
  );
  const [statusBarVisible, setStatusBarVisibleState] = useState(() =>
    storedBoolean(storedStatusBarKey, true),
  );
  const setStatusBarVisible = useCallback((visible: boolean) => {
    setStatusBarVisibleState(visible);
    localStorage.setItem(storedStatusBarKey, String(visible));
  }, []);
  const notificationPreferencesRef = useRef({
    messageNotifications,
    notificationSound,
    presenceNotifications,
  });
  const membersCloseRef = useRef<HTMLButtonElement>(null);
  const roomsCloseRef = useRef<HTMLButtonElement>(null);
  const agentDialogRef = useRef<HTMLDivElement>(null);
  const agentDialogCloseRef = useRef<HTMLButtonElement>(null);
  const agentDialogTriggerRef = useRef<HTMLButtonElement>(null);
  const agentStepHeadingRef = useRef<HTMLHeadingElement>(null);
  const fullAccessOptionRef = useRef<HTMLButtonElement>(null);
  const roomDialogRef = useRef<HTMLDivElement>(null);
  const roomDialogCloseRef = useRef<HTMLButtonElement>(null);
  const roomDialogTriggerRef = useRef<HTMLButtonElement>(null);
  const settingsDialogRef = useRef<HTMLDivElement>(null);
  const settingsCloseRef = useRef<HTMLButtonElement>(null);
  const settingsTriggerRef = useRef<HTMLButtonElement>(null);
  const userMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const lastPanelTriggerRef = useRef<HTMLButtonElement>(null);
  // Hive Server 就在这台电脑上时，可以直接在网页上拉起 Agent
  const local = useLocalAgents(base, agentDialogOpen, authToken);
  // 最近慢操作：服务端只给这台电脑上的房主页面发（连上时 slow-op.snapshot，之后逐条 slow-op.recorded）
  const slowOpsState = useSlowOps();
  slowOpsRef.current = slowOpsState;
  // 故障单：服务端只给这台电脑上的房主页面推 incidents.changed，每次都换个 version 让详情重新拉
  const [incidentSignal, setIncidentSignal] = useState<{ attention: number; version: number }>();
  const setIncidentAttention = useCallback(
    (attention: number) =>
      setIncidentSignal((current) => ({ attention, version: (current?.version ?? 0) + 1 })),
    [],
  );
  // 左侧「故障」入口：条件和顶栏任务目录下拉一样，只给这台电脑上的房主
  const incidents = useIncidents(local, incidentsAvailable(isOwner, local), incidentSignal);
  /** 派修设置里按房间列出可选的 Agent */
  const loadRoomAgents = useCallback(
    async (roomId: string) => {
      const response = await fetch(`${base}/api/rooms/${encodeURIComponent(roomId)}/participants`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!response.ok) throw new Error(t("无法加载房间成员。"));
      const payload = (await response.json()) as { participants: Participant[] };
      return payload.participants.filter((participant) => participant.type === "agent");
    },
    [authToken, base],
  );
  const [incidentsView, setIncidentsView] = useState<{ tab: IncidentsTab; focusId?: string }>();
  const [feedbackView, setFeedbackView] = useState<{ incident?: Incident; contribute?: boolean }>();
  // 左侧「定时任务」面板：和「Agent 任务」「故障」同一时间只开一个
  const [schedulesOpen, setSchedulesOpen] = useState(false);
  const schedulesTriggerRef = useRef<HTMLElement | null>(null);
  const incidentsTriggerRef = useRef<HTMLElement | null>(null);
  // 房主页面上的报错交给 Server 归档成故障单
  useEffect(() => {
    if (!isOwner || !authToken) return;
    return installErrorReporter({
      base,
      token: authToken,
      roomId: () => currentRoomIdRef.current,
      dev: import.meta.env.DEV,
    });
  }, [base, authToken, isOwner]);
  // 「Agent 运行时」只给页面开在 Server 所在电脑上的本机房主；
  // 「其他设备」和头像菜单「在其他设备登录」一样，本机页面或房主登录过的设备才有
  const visibleSettingsTabs = settingsTabs.filter((tab) =>
    tab.id === "runtimes" || tab.id === "plugins"
      ? local.mode === "local"
      : tab.id === "devices"
        ? local.enabled
        : true,
  );
  useEffect(() => {
    if (!isOwner || !local.enabled) return;
    let cancelled = false;
    const refresh = () => {
      const version = worktreeNoticeVersion.current;
      void local
        .worktrees(currentRoomId)
        .then((inventory) => {
          if (cancelled || version !== worktreeNoticeVersion.current) return;
          setWorktreeNotices((current) => {
            const next = new Map(current);
            if (inventory.cleanupBatch)
              next.set(currentRoomId, {
                batchId: inventory.cleanupBatch.id,
                count: inventory.cleanupBatch.count,
              });
            else next.delete(currentRoomId);
            return next;
          });
        })
        .catch(() => undefined);
    };
    refresh();
    const timer = window.setInterval(refresh, 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [currentRoomId, isOwner, local.enabled, local.worktrees]);
  const localAgentNames = useMemo(
    () => new Set(local.agents.map((agent) => agent.name.toLocaleLowerCase())),
    [local.agents],
  );
  const [settingsAgentId, setSettingsAgentId] = useState<string | undefined>();
  /** 「换个模型重试」正在选模型的那条调用 */
  const [retryModelFor, setRetryModelFor] = useState<Invocation | undefined>();
  const retryModelAgent = retryModelFor ? localAgentFor(retryModelFor.agentName) : undefined;
  const settingsAgent = local.agents.find((agent) => agent.id === settingsAgentId);
  function localAgentFor(name: string) {
    const key = name.toLocaleLowerCase();
    return local.agents.find((agent) => agent.name.toLocaleLowerCase() === key);
  }
  /** 本机 Agent 名字旁的设置入口（悬停成员行时出现）；写成函数而非组件，避免每次渲染重建按钮 */
  function agentSettingsButton(name: string) {
    const agent = localAgentFor(name);
    if (!agent) return null;
    return (
      <span className="guest-actions">
        <Tooltip content={t("设置（重启、停止、MCP 等）")}>
          <button
            type="button"
            className="guest-actions-trigger agent-settings-trigger"
            aria-label={t("{0} 的设置", { 0: agent.name })}
            onClick={(event) => {
              event.stopPropagation();
              setSettingsAgentId(agent.id);
            }}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <SettingsGlyph />
          </button>
        </Tooltip>
      </span>
    );
  }
  const modifierKeyLabel = useMemo(platformModifierLabel, []);
  // 两侧栏可拖宽：默认宽度即最小宽度，记在本机
  const { widths: panelWidths, resize: resizePanel } = usePanelWidths();
  // 接入默认名要避开房间现有成员（含离线）：服务端按房间大小写不敏感查重，撞名直接 409
  const takenAgentNames = useMemo(
    () =>
      new Set([
        ...participants
          .filter(
            (participant) =>
              participant.id !== rejoinAgent?.participantId || participant.status !== "offline",
          )
          .map((participant) => participant.username.toLocaleLowerCase()),
        ...local.agents.map((agent) => agent.name.toLocaleLowerCase()),
      ]),
    [participants, local.agents, rejoinAgent],
  );
  const selectedAgentCommand = useMemo(() => {
    if (!meta) return t("加载中…");
    return agentCommandFor(meta, agentProvider, username, agentAccess, takenAgentNames);
  }, [agentAccess, agentProvider, meta, takenAgentNames, username]);
  const showNotificationPrompt =
    messageNotifications !== "off" &&
    notificationPermission === "default" &&
    !notificationPromptDismissed;
  const currentRoom = useMemo(
    () => rooms.find((room) => room.id === currentRoomId),
    [currentRoomId, rooms],
  );
  const currentRoomName = currentRoom?.name ?? currentRoomId;
  const currentRoomWorkspace = currentRoom?.workspace;
  // 桌面端内置终端；浏览器里是 undefined，不显示入口
  const desktopTerminal = useDesktopTerminal();
  const share = useShareSelection({ messages, currentRoomId, currentRoomName });

  /* 工作区面板（文件与 git 变更，只读）：房主总能打开；访客要房主在房间设置里允许，服务端同样校验 */
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [workspaceCounts, setWorkspaceCounts] = useState<ReadonlyMap<string, number>>(new Map());
  const workspaceButtonRef = useRef<HTMLButtonElement>(null);
  /** 从任务卡片、成员菜单「看改动」打开时要切到的 Agent；nonce 让同一个 Agent 再点一次也生效 */
  const [workspaceFocus, setWorkspaceFocus] = useState<WorkspaceFocus>();
  const canViewWorkspace =
    Boolean(authToken) &&
    (isOwner || Boolean(currentRoom?.workspaceFilesGuests && currentRoomWorkspace));
  const workspaceRequest = useMemo(
    () => workspaceApi(base, currentRoomId, authToken),
    [base, currentRoomId, authToken],
  );
  const recordWorkspaceOverview = useCallback(
    (overview: WorkspaceOverview) =>
      setWorkspaceCounts((current) => {
        const count = overview.changeCount ?? 0;
        if (current.get(currentRoomId) === count) return current;
        return new Map(current).set(currentRoomId, count);
      }),
    [currentRoomId],
  );
  useEffect(() => {
    if (!canViewWorkspace) setWorkspaceOpen(false);
  }, [canViewWorkspace]);
  /** 「看改动」：打开「代码」面板并切到这个 Agent 最近的任务线（没有就看工作区） */
  function openWorkspaceFor(agent: string) {
    setArtifactsOpen(false);
    setWorkspaceFocus({ agent, nonce: Date.now() });
    setWorkspaceOpen(true);
  }
  // 顶栏「⎇ 分支」下拉：列这个仓库的任务目录，点一行在「代码」面板里打开
  const loadRoomWorktrees = useCallback(
    () => local.worktrees(currentRoomId),
    [local.worktrees, currentRoomId],
  );
  const loadWorkspaceDetail = useCallback(
    () => workspaceRequest("", { detail: "1" }) as Promise<WorkspaceOverview>,
    [workspaceRequest],
  );
  // 「任务目录」面板：从「⎇ 分支」下拉底部打开，和「代码」「产物」一样是大面板，同时只开一个
  const [worktreesOpen, setWorktreesOpen] = useState(false);
  const worktreesTriggerRef = useRef<HTMLButtonElement | null>(null);
  const canManageWorktrees = isOwner && local.enabled && Boolean(currentRoomWorkspace);
  const openWorktrees = useCallback((trigger: HTMLButtonElement) => {
    worktreesTriggerRef.current = trigger;
    setArtifactsOpen(false);
    setWorkspaceOpen(false);
    setWorktreesOpen(true);
  }, []);
  useEffect(() => {
    if (workspaceOpen || artifactsOpen) setWorktreesOpen(false);
  }, [workspaceOpen, artifactsOpen]);
  // 换房间、或这个房间不再满足条件（不是本机房主、仓库被去掉）时收起
  useEffect(() => {
    setWorktreesOpen(false);
  }, [currentRoomId, canManageWorktrees]);
  const openWorkspaceSource = useCallback((source: string) => {
    setArtifactsOpen(false);
    setWorkspaceFocus({ source, nonce: Date.now() });
    setWorkspaceOpen(true);
  }, []);
  // 产物和聊天附件「用本机应用打开」「在访达中显示」：只给页面开在 Server 那台电脑上的本机房主
  const { enabled: localEnabled, mode: localMode, openAttachment } = local;
  const openAttachmentLocally = useMemo(
    () =>
      localEnabled && localMode === "local"
        ? (attachment: Attachment, mode: "open" | "reveal") =>
            openAttachment(currentRoomId, attachment.id, mode)
        : undefined,
    [currentRoomId, localEnabled, localMode, openAttachment],
  );

  // 消息、白板里的提交号和任务分支名：能看代码的人才变成链接，点了打开「代码」面板定位过去
  const workspaceRefs = useMemo(
    () =>
      canViewWorkspace && currentRoomWorkspace
        ? {
            resolver: new RefResolver(workspaceRequest),
            open: (target: RefTarget) => {
              setArtifactsOpen(false);
              setWorkspaceFocus(
                target.kind === "commit"
                  ? { source: "workspace", commit: target.hash, nonce: Date.now() }
                  : { source: target.source, nonce: Date.now() },
              );
              setWorkspaceOpen(true);
            },
          }
        : undefined,
    [canViewWorkspace, currentRoomWorkspace, workspaceRequest],
  );
  // 头部入口上的改动数：面板关着时不轮询，只在进房间和有新消息（Agent 多半刚改完）后查一次，最快 10 秒一次
  const workspaceCountFetched = useRef<{ roomId?: string; at: number }>({ at: 0 });
  const currentLatestSeq = currentRoom?.latestSeq;
  useEffect(() => {
    if (!canViewWorkspace || !currentRoomWorkspace || workspaceOpen) return;
    const last = workspaceCountFetched.current;
    const wait =
      last.roomId === currentRoomId ? Math.max(1500, last.at + 10_000 - Date.now()) : 300;
    const timer = window.setTimeout(() => {
      workspaceCountFetched.current = { roomId: currentRoomId, at: Date.now() };
      workspaceRequest("").then(
        (value) => recordWorkspaceOverview(value as WorkspaceOverview),
        () => undefined,
      );
    }, wait);
    return () => window.clearTimeout(timer);
  }, [
    canViewWorkspace,
    currentRoomId,
    currentRoomWorkspace,
    currentLatestSeq,
    recordWorkspaceOverview,
    workspaceOpen,
    workspaceRequest,
  ]);
  const workspaceChangeCount = currentRoomWorkspace ? (workspaceCounts.get(currentRoomId) ?? 0) : 0;
  const isLeadAgent = (participant: Participant) =>
    participant.type === "agent" &&
    currentRoom?.leadAgent?.toLocaleLowerCase() === participant.username.toLocaleLowerCase();
  // 主 Agent 被删掉后服务端不再派给它：输入框不再这么提示
  const currentLeadAgent = participants.find(isLeadAgent)?.username;
  const messageWindow = useMessageWindow({ messages });
  const { visibleLimit, setVisibleLimit, setExpandedTopicId, currentTopic, timeline } =
    messageWindow;
  // 「在做」超过 1 天没更新要标灰：房间整天没动静时也得重算，每 10 分钟走一次
  const [progressNow, setProgressNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setProgressNow(Date.now()), 10 * 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const progressGroups = useMemo(
    () =>
      buildProgress({
        roomId: currentRoomId,
        entries: whiteboard.values(),
        invocations: invocations.values(),
        messages,
        now: progressNow,
      }),
    [currentRoomId, whiteboard, invocations, messages, progressNow],
  );

  useEffect(() => {
    notificationPreferencesRef.current = {
      messageNotifications,
      notificationSound,
      presenceNotifications,
    };
  }, [messageNotifications, notificationSound, presenceNotifications]);

  useEffect(() => {
    if (notificationPermission !== "denied" && notificationPermission !== "unsupported") return;
    setMessageNotifications("off");
    setPresenceNotifications(false);
    localStorage.setItem(storedMessageNotificationsKey, "off");
    localStorage.setItem(storedPresenceNotificationsKey, "false");
  }, [notificationPermission]);

  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      root.dataset.theme =
        themePreference === "system" ? (media?.matches ? "dark" : "light") : themePreference;
    };
    applyTheme();
    media?.addEventListener?.("change", applyTheme);
    return () => media?.removeEventListener?.("change", applyTheme);
  }, [themePreference]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.density = interfaceDensity;
    root.dataset.threadWidth = threadWidth;
    root.dataset.messageSize = messageSize;
    root.dataset.reduceMotion = String(reduceMotion);
  }, [interfaceDensity, messageSize, reduceMotion, threadWidth]);

  // 桌面端换了监听地址（开关「允许局域网设备访问」）后 Server 重启、页面不刷新：
  // 切换完成时重取一次 meta，邀请链接和接入命令跟着换成新地址
  const desktopLan = useDesktopLan();
  const lanSettled =
    desktopLan && !desktopLan.state.restarting ? desktopLan.state.enabled : undefined;
  const lastLanSettled = useRef(lanSettled);
  const [metaEpoch, setMetaEpoch] = useState(0);
  useEffect(() => {
    if (lanSettled === undefined) return;
    if (lastLanSettled.current !== undefined && lastLanSettled.current !== lanSettled) {
      setMetaEpoch((value) => value + 1);
    }
    lastLanSettled.current = lanSettled;
  }, [lanSettled]);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    const timeout = window.setTimeout(() => controller.abort(), 8_000);
    fetch(`${base}/api/meta`, {
      signal: controller.signal,
      ...(ownerToken ? { headers: { Authorization: `Bearer ${ownerToken}` } } : {}),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Server returned ${response.status}`);
        return (await response.json()) as MetaResponse;
      })
      .then((next) => {
        if (!cancelled) setMeta(next);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setConnectionState("offline");
        setError(
          controller.signal.aborted
            ? t("等待 Hive Server 响应超时，请确认服务已启动并检查网络。")
            : t("无法连接 Hive Server。请确认服务已启动并检查网络：{0}", {
                0: reason instanceof Error ? reason.message : String(reason),
              }),
        );
      })
      .finally(() => window.clearTimeout(timeout));
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [base, ownerToken, metaEpoch]);

  const scroll = useMessageScroll({ messages, username, timeline });
  const { setPendingNewMessages, setShowJumpToBottom, nearBottomRef } = scroll;

  // 插件：当前房间能用的面板和 / 命令；批准、撤销后 Server 推 plugins.changed，重新取并卸掉失效的面板
  const [pluginsVersion, setPluginsVersion] = useState(0);
  const onPluginsChanged = useCallback(() => setPluginsVersion((value) => value + 1), []);
  const plugins = useRoomPlugins({
    base,
    authToken,
    roomId: currentRoomId,
    version: pluginsVersion,
  });
  const pluginsRef = useRef(plugins);
  pluginsRef.current = plugins;
  const hasPluginPanels = plugins.some((plugin) => plugin.panels.length > 0);
  const [activePluginPanel, setActivePluginPanel] = useState<PluginPanelKey>();
  const [pluginCommand, setPluginCommand] = useState<PluginCommandDispatch>();
  const pluginCommandNonce = useRef(0);
  // 插件被撤销（或这个房间还没加载出插件）：「插件」标签页跟着消失，先显示成员，记下的选择不动
  const sidePanelTab: SidePanelTab =
    roomSide.tab === "plugins" && !hasPluginPanels ? "members" : roomSide.tab;
  /** 输入框里的 /命令：认出是插件声明的就交给它的面板，不当消息发出去 */
  const interceptPluginCommand = useCallback((content: string) => {
    const match = matchPluginCommand(content, pluginsRef.current);
    if (!match) return false;
    const key = pluginPanelKey(match.plugin.id, match.panel);
    pluginCommandNonce.current += 1;
    setActivePluginPanel(key);
    setPluginCommand({
      key,
      name: match.name,
      args: match.args,
      nonce: pluginCommandNonce.current,
    });
    setSidePanelTab("plugins");
    setMembersCollapsed(false);
    if (window.matchMedia?.("(max-width: 1100px)").matches) setMobilePanel("members");
    return true;
  }, []);

  const composer = useComposer({
    username,
    currentRoomId,
    participants,
    messages,
    invocations,
    autoSaveDraft,
    sendShortcut,
    richComposer,
    currentLeadAgent,
    base,
    authToken,
    socketRef: room.socketRef,
    interceptCommand: interceptPluginCommand,
  });
  const { draft, setMentionContext, setComposerPreview, appendMention } = composer;
  /** 插件的 composer.insert：接在已有草稿后面另起一行，不替人发送 */
  const { setDraft: setComposerDraft, textareaRef: composerTextareaRef } = composer;
  const insertPluginText = useCallback(
    (text: string) => {
      setComposerDraft((current) => (current.trim() ? `${current.trimEnd()}\n${text}` : text));
      window.requestAnimationFrame(() => composerTextareaRef.current?.focus());
    },
    [setComposerDraft, composerTextareaRef],
  );

  const closeMobilePanel = useCallback((restoreFocus = true) => {
    setMobilePanel(undefined);
    if (restoreFocus) {
      window.requestAnimationFrame(() => lastPanelTriggerRef.current?.focus());
    }
  }, []);

  const openMobilePanel = useCallback((panel: MobilePanel, trigger: HTMLButtonElement) => {
    lastPanelTriggerRef.current = trigger;
    setMobilePanel(panel);
  }, []);

  const [gotoNotice, setGotoNotice] = useState<string>();
  const jump = useMessageJump({
    messages,
    messagesLoaded: room.messagesLoaded,
    setMessages,
    meta,
    authToken,
    base,
    currentRoomId,
    currentRoomIdRef,
    currentTopic,
    visibleLimit,
    setVisibleLimit,
    setExpandedTopicId,
    setOpenMachineIds,
    closeMobilePanel,
    setError,
    setGotoNotice,
    scroll,
    timeline,
  });
  const {
    setHighlightedMessageId,
    setPendingJumpId,
    setCrossRoomJumpId,
    setCrossRoomJump,
    jumpToMessage,
    locateProgress,
    locateAttention,
    locateMessage,
  } = jump;
  const locateMessageRef = useRef(locateMessage);
  locateMessageRef.current = locateMessage;
  const locateMessageFromMarkdown = useCallback(
    (target: { messageId: string; messageSeq: number }) => {
      void locateMessageRef.current(target);
    },
    [],
  );

  const dockPreview = useCallback(
    (attachment: Attachment, origin: { senderId: string; seq: number }) => {
      // 窄屏右侧栏是抽屉：停靠着预览时由样式让它一直显示，不走抽屉的开关
      setDockedPreview({ roomId: currentRoomIdRef.current, attachment, ...origin });
    },
    [],
  );
  const closeDockedPreview = useCallback(() => setDockedPreview(undefined), []);
  const previewDocked = Boolean(dockedPreview && !dockedPreview.popped);
  // 停靠的文件出了新版本：同一个人在本房间后来又发了同名文件，取最新那份
  const dockedNewerVersion = useMemo(() => {
    if (!dockedPreview) return undefined;
    let newest: { attachment: Attachment; seq: number } | undefined;
    for (const message of messages) {
      if (
        message.roomId !== dockedPreview.roomId ||
        message.senderId !== dockedPreview.senderId ||
        message.seq <= (newest?.seq ?? dockedPreview.seq) ||
        message.deletedAt
      )
        continue;
      const match = message.attachments?.find(
        (item) => item.name === dockedPreview.attachment.name,
      );
      if (match) newest = { attachment: match, seq: message.seq };
    }
    return newest;
  }, [dockedPreview, messages]);
  const dockedNewerNotice = dockedNewerVersion && (
    <Tooltip content={t("换成最新发的 {0}", { 0: dockedPreview?.attachment.name ?? "" })}>
      <Button
        size="sm"
        className="file-preview-newer"
        onClick={() =>
          setDockedPreview(
            (current) =>
              current && {
                ...current,
                attachment: dockedNewerVersion.attachment,
                seq: dockedNewerVersion.seq,
              },
          )
        }
      >
        {t("有新版本")}
      </Button>
    </Tooltip>
  );

  useEffect(() => {
    if (!mobilePanel) return;
    window.requestAnimationFrame(() => {
      if (mobilePanel === "members") membersCloseRef.current?.focus();
      if (mobilePanel === "rooms") roomsCloseRef.current?.focus();
    });
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // 从抽屉里打开的弹窗盖在上面时，Esc 先交给弹窗关：抽屉这时收起会让弹窗重渲染、
      // 它自己的 Esc 监听在这次按键里被换掉，弹窗就关不上了
      if (
        document.querySelector("dialog[open], [aria-modal='true'], .app-dialog-layer, .sheet-panel")
      )
        return;
      closeMobilePanel();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [closeMobilePanel, mobilePanel]);

  const sharingBlocked = lanBlocksSharing({
    localMode: local.mode,
    lan: desktopLan,
    advertisedUrl: meta?.httpUrl,
  });
  /** 邀请 / 接入弹窗里的「去打开局域网访问」：关掉弹窗，打开设置「设备」页，开关在最上面 */
  const lanBlocked = sharingBlocked
    ? {
        openSettings: () => {
          setInviteDialogOpen(false);
          setAgentDialogOpen(false);
          setFullAccessConfirmationOpen(false);
          setImDialogOpen(false);
          setSettingsTab("devices");
          setSettingsOpen(true);
          revealLanSwitch();
        },
      }
    : undefined;

  const closeAgentDialog = useCallback(() => {
    setAgentDialogOpen(false);
    setFullAccessConfirmationOpen(false);
    window.requestAnimationFrame(() => agentDialogTriggerRef.current?.focus());
  }, []);

  const openAgentDialog = useCallback((trigger: HTMLButtonElement) => {
    setRejoinAgent(undefined);
    agentDialogTriggerRef.current = trigger;
    setAgentStep(1);
    setAgentProviderChosen(false);
    setAgentConnected(false);
    // 完全访问不跨次保留：每次打开都要重新明确选择最高权限
    setAgentAccess((current) => (current === "full" ? "workspace" : current));
    setCommandCopied(false);
    setCopyError(undefined);
    setAgentDialogOpen(true);
  }, []);

  function removedAgentFor(participant: Participant) {
    if (
      !isOwner ||
      local.mode !== "local" ||
      participant.type !== "agent" ||
      participant.status !== "offline" ||
      participant.access ||
      localAgentFor(participant.username)
    )
      return undefined;
    return local.removedAgents?.find(
      (agent) => agent.name.toLocaleLowerCase() === participant.username.toLocaleLowerCase(),
    );
  }

  function openRejoinAgent(participant: Participant, trigger?: HTMLButtonElement) {
    const removed = removedAgentFor(participant);
    if (!removed || !local.canManage) return;
    if (trigger) agentDialogTriggerRef.current = trigger;
    setRejoinAgent({ ...removed, name: participant.username, participantId: participant.id });
    setAgentProvider(removed.provider);
    setAgentProviderChosen(true);
    setAgentAccess(removed.cwd ? "workspace" : "read-only");
    setAgentStep(2);
    setFullAccessConfirmationOpen(false);
    setAgentConnected(false);
    setCommandCopied(false);
    setCopyError(undefined);
    setAgentDialogOpen(true);
  }

  async function hideRemovedMember(participant: Participant) {
    try {
      await local.hideMember(participant.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  function memberRecoveryActions(participant: Participant) {
    if (
      !isOwner ||
      local.mode !== "local" ||
      !local.canManage ||
      participant.type !== "agent" ||
      participant.status !== "offline" ||
      participant.access
    )
      return null;
    const agent = localAgentFor(participant.username);
    const removed = removedAgentFor(participant);
    return agent ? (
      <span className="member-recovery-actions">
        <Button
          size="sm"
          variant="ghost"
          aria-label={t("启动 {0}", { 0: participant.username })}
          disabled={agent.status !== "stopped" && agent.status !== "crashed"}
          onClick={() =>
            void local
              .act(agent.id, "start")
              .catch((reason: unknown) =>
                setError(reason instanceof Error ? reason.message : String(reason)),
              )
          }
        >
          {agent.status === "stopped" || agent.status === "crashed" ? t("启动") : t("正在启动…")}
        </Button>
      </span>
    ) : removed ? (
      <span className="member-recovery-actions">
        <Button
          size="sm"
          variant="ghost"
          aria-label={t("重新接入 {0}", { 0: participant.username })}
          onClick={(event) => openRejoinAgent(participant, event.currentTarget)}
        >
          {t("重新接入")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label={t("从列表隐藏 {0}", { 0: participant.username })}
          onClick={() => void hideRemovedMember(participant)}
        >
          {t("从列表隐藏")}
        </Button>
      </span>
    ) : null;
  }

  const goToAgentStep = useCallback((step: AgentSetupStep) => {
    setAgentStep(step);
    setFullAccessConfirmationOpen(false);
    setCommandCopied(false);
    setCopyError(undefined);
    window.requestAnimationFrame(() => agentStepHeadingRef.current?.focus());
  }, []);

  const chooseAgentAccess = useCallback(
    (access: AgentAccessMode) => {
      if (access === "full" && agentAccess !== "full") {
        setFullAccessConfirmationOpen(true);
        return;
      }
      setFullAccessConfirmationOpen(false);
      setAgentAccess(access);
    },
    [agentAccess],
  );

  const closeFullAccessConfirmation = useCallback(() => {
    setFullAccessConfirmationOpen(false);
    fullAccessOptionRef.current?.focus();
  }, []);

  const confirmFullAccess = useCallback(() => {
    setAgentAccess("full");
    setFullAccessConfirmationOpen(false);
    fullAccessOptionRef.current?.focus();
  }, []);
  useEffect(() => {
    if (!agentDialogOpen) return;
    window.requestAnimationFrame(() => agentDialogCloseRef.current?.focus());

    const handleDialogKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeAgentDialog();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = agentDialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], details, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", handleDialogKeyDown);
    return () => window.removeEventListener("keydown", handleDialogKeyDown);
  }, [agentDialogOpen, closeAgentDialog]);

  const closeRoomDialog = useCallback(() => {
    setRoomDialog(undefined);
    setArchiveConfirmOpen(false);
    setClearConfirmOpen(false);
    window.requestAnimationFrame(() => roomDialogTriggerRef.current?.focus());
  }, []);

  const openRoomDialog = useCallback(
    (
      dialog: { mode: "create" } | { mode: "manage"; room: RoomSummary },
      trigger: HTMLButtonElement,
    ) => {
      roomDialogTriggerRef.current = trigger;
      setRoomDialogError(undefined);
      setArchiveConfirmOpen(false);
      setClearConfirmOpen(false);
      setRoomDialogId(dialog.mode === "manage" ? dialog.room.id : "");
      setRoomDialogName(dialog.mode === "manage" ? dialog.room.name : "");
      setRoomDialogWorkspace(dialog.mode === "manage" ? (dialog.room.workspace ?? "") : "");
      setRoomDialogLead(dialog.mode === "manage" ? leadChoiceOf(dialog.room) : "");
      setRoomDialogGuestFiles(
        dialog.mode === "manage" && Boolean(dialog.room.workspaceFilesGuests),
      );
      setRoomWorkspacePicking(false);
      setRoomDialog(dialog);
    },
    [],
  );

  useEffect(() => {
    if (!roomDialog) return;
    window.requestAnimationFrame(() => roomDialogCloseRef.current?.focus());

    const handleRoomDialogKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRoomDialog();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = roomDialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", handleRoomDialogKeyDown);
    return () => window.removeEventListener("keydown", handleRoomDialogKeyDown);
  }, [closeRoomDialog, roomDialog]);

  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    setRuntimesFocus(undefined);
    if (returnToAgentDialogRef.current) {
      // 从接入弹窗跳过来的：回到接入弹窗原来那一步，刚装好、改好的 Agent 接着接入
      returnToAgentDialogRef.current = false;
      setAgentDialogOpen(true);
      return;
    }
    window.requestAnimationFrame(() => returnFocus(settingsTriggerRef.current));
  }, []);

  /** 接入 Agent 弹窗里的「安装、升级或调整配置」：先收起接入弹窗，打开设置的「Agent 运行时」 */
  const openRuntimeSettings = useCallback((provider: SelectableAgentProvider | undefined) => {
    setAgentDialogOpen(false);
    setFullAccessConfirmationOpen(false);
    returnToAgentDialogRef.current = true;
    setRuntimesFocus(provider);
    setSettingsTab("runtimes");
    setSettingsOpen(true);
  }, []);

  /** 设置里的「打开 MCP 与技能管理」：关掉设置，打开大面板 */
  const openRuntimeHub = useCallback(() => {
    returnToAgentDialogRef.current = false;
    setSettingsOpen(false);
    setRuntimesFocus(undefined);
    setRuntimeHubFocus(undefined);
    setRuntimeHubOpen(true);
  }, []);

  /** 设置里的「查看全部 Agent」：关掉设置，打开成员面板（本机 Agent 在那里管理） */
  const openMembersFromSettings = useCallback(() => {
    returnToAgentDialogRef.current = false;
    setSettingsOpen(false);
    setRuntimesFocus(undefined);
    setSidePanelTab("members");
    setMembersCollapsed(false);
    if (window.matchMedia?.("(max-width: 1100px)").matches) setMobilePanel("members");
  }, []);

  /** 大面板里点 CLI 名字：去设置「Agent 运行时」里那个 CLI 的配置 */
  const jumpFromRuntimeHub = useCallback((provider: SelectableAgentProvider) => {
    setRuntimeHubOpen(false);
    setRuntimesFocus(provider);
    setSettingsTab("runtimes");
    setSettingsOpen(true);
  }, []);

  /** 输入框下的「发送 · 换行」提示：打开设置「聊天与输入」，定位到「发送消息」 */
  const openSendSettings = useCallback(() => {
    setSettingsTab("chat");
    setSettingsOpen(true);
    const focusShortcut = (tries: number) => {
      const target = document.querySelector<HTMLElement>(
        '#settings-send-shortcut [role="radio"][aria-checked="true"]',
      );
      if (target) {
        // 等设置弹窗自己的「打开时聚焦」做完，再把焦点放到当前选中的发送方式上
        window.setTimeout(() => {
          target.scrollIntoView({ block: "center" });
          target.focus({ preventScroll: true });
        }, 30);
      } else if (tries > 0) window.requestAnimationFrame(() => focusShortcut(tries - 1));
    };
    window.requestAnimationFrame(() => focusShortcut(10));
  }, []);

  /** 调用状态里的「可能需要配置代理」：打开设置「这台电脑」，定位到「网络代理」 */
  const openProxySettings = useCallback(() => {
    setSettingsTab("computer");
    setSettingsOpen(true);
    const focusProxy = (tries: number) => {
      const target = document.querySelector<HTMLElement>(
        '#settings-network-proxy [role="radio"][aria-checked="true"]',
      );
      if (target) {
        window.setTimeout(() => {
          target.scrollIntoView({ block: "center" });
          target.focus({ preventScroll: true });
        }, 30);
      } else if (tries > 0) window.requestAnimationFrame(() => focusProxy(tries - 1));
    };
    // 网络代理的设置要先从 Server 读回来才显示，多等几帧
    window.requestAnimationFrame(() => focusProxy(60));
  }, []);

  useEffect(() => {
    if (!settingsOpen) return;
    window.requestAnimationFrame(() => settingsCloseRef.current?.focus());

    const handleSettingsKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeSettings();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = settingsDialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", handleSettingsKeyDown);
    return () => window.removeEventListener("keydown", handleSettingsKeyDown);
  }, [closeSettings, settingsOpen]);

  const switchRoom = useCallback(
    (roomId: string) => {
      if (roomId === currentRoomId) return;
      // 访客只能待在被邀请的房间
      if (guest && roomId !== guest.roomId) return;
      markRoomRead(currentRoomId);
      const cachedScroll = room.activateRoom(roomId, {
        scrollTop: scroll.messageListRef.current?.scrollTop ?? 0,
        nearBottom: nearBottomRef.current,
        visibleLimit,
      });
      scroll.restoreRoomScroll(cachedScroll);
      setHighlightedMessageId(undefined);
      setPendingJumpId(undefined);
      setPendingNewMessages(0);
      setError(undefined);
      setMentionContext(undefined);
      setVisibleLimit(cachedScroll?.visibleLimit ?? 25);
      setShowJumpToBottom(false);
      setCurrentRoomId(roomId);
      closeMobilePanel(false);
    },
    [
      closeMobilePanel,
      currentRoomId,
      markRoomRead,
      room.activateRoom,
      scroll.restoreRoomScroll,
      visibleLimit,
    ],
  );

  // 切回房间：停靠的预览按房间记着，照旧停靠在右侧栏（放大的弹窗收回侧栏，不突然盖住页面）。
  // 窄屏的右侧栏是盖在对话上的抽屉，切回来不自动弹出，和以前一样收起
  useEffect(() => {
    const narrow = window.matchMedia?.("(max-width: 1100px)").matches;
    setDockedPreview((current) =>
      !current || narrow ? undefined : current.popped ? { ...current, popped: false } : current,
    );
  }, [currentRoomId, setDockedPreview]);

  useEffect(() => {
    localStorage.setItem(storedRoomKey, currentRoomId);
    if (roomIdFromHash() === currentRoomId) return;
    window.history.replaceState(window.history.state, "", `#${currentRoomId}`);
  }, [currentRoomId]);

  useEffect(() => {
    const handleHashChange = () => {
      const roomId = roomIdFromHash();
      if (roomId) switchRoom(roomId);
      else window.history.replaceState(window.history.state, "", `#${currentRoomId}`);
    };
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, [currentRoomId, switchRoom]);

  useEffect(() => {
    if (messages.length > 0) markRoomRead(currentRoomId);
  }, [currentRoomId, markRoomRead, messages]);
  // 页面在后台时来的消息不算读过（见 markRoomRead），回到前台正看着这个房间时补记
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") markRoomRead(currentRoomId);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [currentRoomId, markRoomRead]);

  const todosApi = useMemo(
    () => todoApi(base, authToken, currentRoomId, username),
    [base, authToken, currentRoomId, username],
  );
  const recordingTodoRef = useRef(new Set<string>());
  async function recordMessageTodo(message: ChatMessage) {
    if (recordingTodoRef.current.has(message.id)) return;
    recordingTodoRef.current.add(message.id);
    try {
      await todosApi.add(todoFromMessage(message));
      if (currentRoomIdRef.current === message.roomId) {
        setSidePanelTab("whiteboard");
        setMobilePanel("members");
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      recordingTodoRef.current.delete(message.id);
    }
  }

  const actions = useMessageActions({
    socketRef: room.socketRef,
    setError,
    authToken,
    base,
    username,
  });
  const {
    setPendingAnswers,
    setRecallCandidateId,
    retryInvocation,
    dismissInvocations,
    extendAgentBudget,
    removeWhiteboardEntry,
    startNewTopic,
  } = actions;
  useRoomConnection({
    meta,
    username,
    authToken,
    base,
    currentRoomId,
    room,
    refreshRooms,
    switchRoom,
    upsertRoom,
    setRooms,
    onAccessLost,
    setConnectionState,
    setError,
    setArtifactsEpoch,
    setPendingNewMessages,
    setRecallCandidateId,
    setWorktreeNotices,
    worktreeNoticeVersion,
    setPendingAnswers,
    notificationPreferencesRef,
    slowOpsRef,
    setIncidentAttention,
    onPluginsChanged,
    attentionRef,
    globalEventsRef,
  });

  const {
    mentionMessages,
    activeInvocations,
    setActiveInvocations,
    invocationMessages,
    setInvocationMessages,
    onlineInvocationIds,
    loadUsage,
    refreshMentions,
    refreshTasks,
    searchMessages,
    unreadMentionCount,
    taskCounts,
    roomTaskCounts,
    markMentionsRead,
    schedules,
  } = useActivityData({
    base,
    meta,
    authToken,
    username,
    currentRoomId,
    readState,
    attentionRef,
    globalEventsRef,
  });
  // 切换语言：已经收到的消息、任务、定时按新语言重新显示服务端写的文字
  useEffect(() => {
    const relocalize = <T,>(map: ReadonlyMap<string, T>) =>
      new Map([...map].map(([id, value]) => [id, localizeServerPayload(value)]));
    setMessages((current) => localizeServerPayload(current));
    setInvocations(relocalize);
    setActiveInvocations(relocalize);
    schedules.relocalize();
    setInvocationMessages(relocalize);
  }, [locale]);

  function openActivity(view: ActivityView, trigger?: HTMLElement | null) {
    activityTriggerRef.current = trigger ?? null;
    closeMobilePanel(false);
    setIncidentsView(undefined);
    setSchedulesOpen(false);
    setActivityView(view);
    if (view === "mentions") void refreshMentions().catch(() => undefined);
    if (view === "tasks") void refreshTasks().catch(() => undefined);
  }

  function closeActivity() {
    setActivityView(undefined);
    activityTriggerRef.current?.focus();
  }

  function openMessage(message: ChatMessage) {
    openRoomMessage(message.roomId, message.id);
  }

  function openRoomMessage(roomId: string, messageId: string) {
    if (roomId === currentRoomId) {
      jumpToMessage(messageId);
      return;
    }
    setCrossRoomJumpId(messageId, roomId);
    switchRoom(roomId);
  }

  function openSchedules(trigger?: HTMLElement | null) {
    schedulesTriggerRef.current = trigger ?? null;
    closeMobilePanel(false);
    setActivityView(undefined);
    setIncidentsView(undefined);
    setSchedulesOpen(true);
    schedules.markSeen();
    void schedules.refresh().catch(() => undefined);
  }

  function closeSchedules(restoreFocus = true) {
    setSchedulesOpen(false);
    if (restoreFocus) schedulesTriggerRef.current?.focus();
  }

  // 成员列表里点忙碌的 Agent：跳到它在做的事；短时间内再点同一个，循环到下一条
  const agentTasksByName = useMemo(() => {
    // 跨房间的在办调用 + 当前房间实时的（后者更新，同一条以它为准）
    const all = [...activeInvocations.values(), ...invocations.values()];
    const byName = new Map<string, Invocation[]>();
    for (const name of new Set(all.map((invocation) => invocation.agentName.toLocaleLowerCase()))) {
      const tasks = agentTasks(all, name, currentRoomId);
      if (tasks.length) byName.set(name, tasks);
    }
    return byName;
  }, [activeInvocations, invocations, currentRoomId]);
  const lastAgentTaskRef = useRef<{ agent: string; id: string; at: number } | undefined>(undefined);
  function agentTaskSummary(name: string) {
    const tasks = agentTasksByName.get(name.toLocaleLowerCase());
    if (!tasks) return undefined;
    const first = tasks[0]!;
    return {
      count: tasks.length,
      seq: taskMessageSeq(first),
      roomName: first.roomId === currentRoomId ? undefined : roomNameOf(first.roomId),
    };
  }
  function taskMessageSeq(invocation: Invocation) {
    return (
      messages.find((message) => message.id === invocation.messageId)?.seq ??
      invocationMessages.get(invocation.messageId)?.seq
    );
  }
  function openAgentTask(name: string) {
    const key = name.toLocaleLowerCase();
    const tasks = agentTasksByName.get(key);
    if (!tasks) return;
    const last = lastAgentTaskRef.current;
    const index = nextAgentTaskIndex(
      tasks,
      last?.agent === key && Date.now() - last.at < 30_000 ? last.id : undefined,
    );
    const task = tasks[index]!;
    lastAgentTaskRef.current = { agent: key, id: task.id, at: Date.now() };
    if (tasks.length > 1) {
      setGotoNotice(
        t("@{0} 在办的第 {1}/{2} 条", { 0: name, 1: index + 1, 2: tasks.length }) +
          (task.roomId === currentRoomId ? "" : ` · #${roomNameOf(task.roomId)}`),
      );
    }
    const messageSeq = taskMessageSeq(task);
    if (task.status === "waiting_human") {
      locateAttention(task, messageSeq);
      if (task.roomId !== currentRoomId) switchRoom(task.roomId);
      return;
    }
    if (task.roomId !== currentRoomId) {
      setCrossRoomJump(
        messageSeq === undefined
          ? { roomId: task.roomId, messageId: task.messageId }
          : { roomId: task.roomId, messageId: task.messageId, messageSeq },
      );
      switchRoom(task.roomId);
    } else if (
      messageSeq !== undefined &&
      !messages.some((message) => message.id === task.messageId)
    ) {
      void locateMessage({ messageId: task.messageId, messageSeq });
    } else {
      jumpToMessage(task.messageId);
    }
  }

  // 全局快捷键：⌘K 搜索、⌘P 跳转、⌘J 下一个要处理的、? 或 ⌘/ 快捷键帮助（定义见 shortcuts.ts）
  const lastAttentionIdRef = useRef<string | undefined>(undefined);
  function jumpToNextAttention() {
    const items = attentionRef.current?.items ?? [];
    const next = nextAttention(items, lastAttentionIdRef.current);
    if (!next) {
      setGotoNotice(t("现在没有要你处理的任务。"));
      return;
    }
    lastAttentionIdRef.current = next.invocation.id;
    setGotoNotice(
      t("要处理的第 {0}/{1} 条 · @{2} · {3}", {
        0: items.indexOf(next) + 1,
        1: items.length,
        2: next.invocation.agentName,
        3: attentionLabels[next.kind],
      }),
    );
    attentionRef.current?.open(next.invocation);
  }
  useEffect(() => {
    if (!gotoNotice) return;
    const timer = window.setTimeout(() => setGotoNotice(undefined), 2_500);
    return () => window.clearTimeout(timer);
  }, [gotoNotice]);
  const shortcutActionsRef = useRef<Record<ShortcutId, () => void> | undefined>(undefined);
  shortcutActionsRef.current = {
    search: () => {
      setGotoOpen(false);
      setActivityView((current) => (current === "search" ? undefined : "search"));
    },
    goto: () => {
      setActivityView(undefined);
      setGotoOpen((open) => !open);
    },
    "next-attention": () => {
      setGotoOpen(false);
      jumpToNextAttention();
    },
    help: () => setShortcutsOpen((open) => !open),
  };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const id = matchShortcut(event);
      if (!id) return;
      // 单键 ? 不打断别的弹窗（它们自己处理按键）
      if (event.key === "?" && document.querySelector("dialog[open], [aria-modal='true']")) return;
      event.preventDefault();
      shortcutActionsRef.current?.[id]();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const roomNameOf = (roomId: string) => rooms.find((room) => room.id === roomId)?.name ?? roomId;
  const attention = useAttention({
    username,
    isOwner,
    currentRoomId,
    activeInvocations,
    messages,
    preferences: { delivery: attentionDelivery, sound: attentionSound },
    roomName: roomNameOf,
    onOpen: ({ roomId, invocation }) => {
      locateAttention(invocation, taskMessageSeq(invocation));
      if (roomId !== currentRoomId) switchRoom(roomId);
    },
  });
  attentionRef.current = attention;

  // 标签页图标的小圆点和标题前缀：需要你处理 > 有任务在跑（你派的或当前房间的） > 做完未看。
  // 和侧栏标记一样是被动显示，不受「任务提醒」开关影响
  useFaviconBadge({
    attention: attention.items.filter((item) => item.kind !== "unseen").length,
    running: [...activeInvocations.values()].filter(
      (invocation) =>
        isInFlight(invocation) &&
        (invocation.roomId === currentRoomId || concernsMe(invocation, { username, isOwner })),
    ).length,
    unseen: [...attention.unseenByRoom.values()].reduce((sum, count) => sum + count, 0),
  });

  // 首次引导的「连 IM」一步：看这个房间有没有连上飞书或微信
  const showOnboarding = onboardingWanted && isOwner && Boolean(username);
  useEffect(() => {
    if (!showOnboarding || !authToken || imDialogOpen) return;
    let cancelled = false;
    listImConnections(base, authToken, currentRoomId)
      .then((connections) => {
        if (!cancelled) setImConnected(connections.length > 0);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [authToken, base, currentRoomId, imDialogOpen, showOnboarding]);

  const { count: artifactCount, setCounts: setArtifactCounts } = useArtifactCount({
    base,
    token: authToken,
    roomId: currentRoomId,
    epoch: artifactsEpoch,
    // 面板开着时由面板顺带报数，不重复查
    enabled: Boolean(meta) && !artifactsOpen,
  });

  // 首屏：消息快照到了，或者停在填用户名的页面上，就收起启动加载画面
  useAppReady(!username || room.messagesLoaded);
  const loadingStatus: LoadingStatus = {
    phase: !meta ? "connecting" : room.loadingPhase,
    error:
      error ??
      (connectionState === "offline"
        ? t("与 Hive Server 的连接已中断，正在自动重试。")
        : undefined),
    retrying: !error && connectionState === "offline",
  };
  useAppLoadingStatus(loadingStatus);

  if (!username) {
    return (
      <LoginDialog
        reduceMotion={reduceMotion}
        onJoin={(nextUsername) => {
          localStorage.setItem(storedUsernameKey, nextUsername);
          setUsername(nextUsername);
          if (messageNotifications !== "off") void ensureNotificationPermission();
        }}
      />
    );
  }

  const online = participants.filter((participant) => participant.status !== "offline");

  const offline = participants.filter(
    (participant) => participant.status === "offline" && !participant.hidden,
  );

  async function ensureNotificationPermission(): Promise<boolean> {
    if (!("Notification" in window)) {
      setNotificationPermission("unsupported");
      return false;
    }
    const permission =
      Notification.permission === "default"
        ? await Notification.requestPermission()
        : Notification.permission;
    setNotificationPermission(permission);
    return permission === "granted";
  }

  function dismissNotificationPrompt() {
    setNotificationPromptDismissed(true);
    localStorage.setItem(storedNotificationPromptDismissedKey, "true");
  }

  async function updateMessageNotifications(mode: MessageNotificationMode) {
    const next = mode !== "off" && !(await ensureNotificationPermission()) ? "off" : mode;
    setMessageNotifications(next);
    localStorage.setItem(storedMessageNotificationsKey, next);
  }

  async function updateAttentionDelivery(next: AttentionDelivery) {
    // 选系统通知时顺便请求授权；没授权也照样生效，退回页面内提示
    if (next === "system") await ensureNotificationPermission();
    setAttentionDelivery(next);
    localStorage.setItem(storedAttentionDeliveryKey, next);
  }

  function closeOnboarding() {
    finishOnboarding(localStorage);
    setOnboardingWanted(false);
  }

  const onboardingSteps: OnboardingStep[] = [
    {
      id: "agent",
      title: t("接入一个 Agent"),
      description: t(
        "选 Claude Code、Codex CLI 等命令行 Agent，在这台电脑上一键启动，或复制命令到别的电脑运行。",
      ),
      action: t("接入 Agent"),
      done: participants.some((participant) => participant.type === "agent"),
      onAction: (trigger) => {
        setOnboardingOpen(false);
        openAgentDialog(trigger);
      },
    },
    {
      id: "notifications",
      title: t("打开通知"),
      description: t("Agent 等你回答、失败或做完时，切到别的页面也能收到提醒。"),
      action: t("允许通知"),
      done: notificationPermission === "granted",
      ...(notificationPermission === "unsupported" || notificationPermission === "denied"
        ? {
            unavailable:
              notificationPermission === "unsupported"
                ? t("当前浏览器不支持系统通知，页面内照样会提醒。")
                : t("通知被浏览器阻止了，可以在站点权限里重新允许；页面内照样会提醒。"),
          }
        : {}),
      onAction: () => void ensureNotificationPermission(),
    },
    {
      id: "im",
      title: t("连上飞书或微信"),
      description: t("扫码后，在手机上就能给房间发消息、收结果、回答提问。"),
      action: t("连接 IM"),
      done: imConnected,
      onAction: () => {
        setOnboardingOpen(false);
        setImFocus(undefined);
        setImDialogOpen(true);
      },
    },
  ];

  async function updatePresenceNotifications(next: boolean) {
    const enabled = next && (await ensureNotificationPermission());
    setPresenceNotifications(enabled);
    localStorage.setItem(storedPresenceNotificationsKey, String(enabled));
  }

  /**
   * 邀请链接直接指向当前房间的 Web UI：生产环境由 Hive Server 托管页面，用对外地址；
   * 开发环境页面由 Vite 提供，沿用当前页面地址。
   */
  function inviteLink(): string {
    const origin = resolveShareBase({
      development: import.meta.env.DEV,
      location: window.location,
      advertisedUrl: meta?.httpUrl,
    });
    return `${origin}/#${currentRoomId}`;
  }

  async function copyCommand() {
    if (!meta) return;
    setCopyError(undefined);
    try {
      await copyTextToClipboard(selectedAgentCommand);
      setCommandCopied(true);
      setAgentConnected(true);
      window.setTimeout(() => setCommandCopied(false), 1500);
    } catch {
      setCommandCopied(false);
      setCopyError(t("浏览器未允许自动复制，请选中上方命令后手动复制。"));
    }
  }

  async function roomRequest(path: string, method: string, body: unknown): Promise<RoomSummary> {
    if (!meta) throw new Error(t("尚未连接 Hive Server。"));
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify(body),
    });
    if (response.status === 409) throw new Error(t("房间 ID 已存在，请换一个。"));
    if (!response.ok) {
      const failure: unknown = await response.json().catch(() => ({}));
      throw new Error(serverError(failure) ?? t("房间操作失败 ({0})", { 0: response.status }));
    }
    const payload = (await response.json()) as { room: RoomSummary };
    return payload.room;
  }

  async function submitCreateRoom() {
    const id = roomDialogId.trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      setRoomDialogError(t("房间 ID 只能包含字母、数字、下划线和连字符。"));
      return;
    }
    setRoomDialogBusy(true);
    setRoomDialogError(undefined);
    try {
      const room = await roomRequest("/api/rooms", "POST", {
        id,
        name: roomDialogName.trim() || id,
        createdBy: username,
        ...(roomDialogWorkspace.trim() ? { workspace: roomDialogWorkspace.trim() } : {}),
      });
      upsertRoom(room);
      closeRoomDialog();
      switchRoom(room.id);
    } catch (reason) {
      setRoomDialogError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRoomDialogBusy(false);
    }
  }

  /** 能设为主 Agent 的：当前房间里的 Agent（别的房间的成员这里拿不到） */
  function leadCandidates(room: RoomSummary): string[] {
    if (room.id !== currentRoomId) return [];
    return participants
      .filter((participant) => participant.type === "agent")
      .map((participant) => participant.username)
      .sort((a, b) => a.localeCompare(b));
  }

  async function copyForMenu(text: string) {
    try {
      await copyTextToClipboard(text);
    } catch {
      setError(t("浏览器未允许自动复制。"));
    }
  }

  /** 房间右键：打开、复制链接 / ID、标为已读、调整顺序、管理 */
  /** 侧栏里的一个房间：置顶的带图钉、可以拖动排序；其余的按活跃度排，不能拖 */
  function renderRoomItem(room: RoomSummary, index: number, pinned: boolean) {
    const placement = pinned ? roomReorder.itemStyle(room.id, index) : undefined;
    return (
      <div
        key={room.id}
        {...(pinned ? roomReorder.itemProps(room.id) : {})}
        onContextMenu={(event) => openRoomMenu(event, room)}
        style={placement?.style}
        className={`room-item ${pinned ? "pinned" : ""} ${room.id === currentRoomId ? "active" : ""} ${room.archivedAt ? "archived" : ""} ${placement?.dragging ? "dragging" : ""}`}
      >
        {pinned && (
          <span className="room-drag-handle" aria-hidden="true">
            <svg viewBox="0 0 8 14" width="8" height="14">
              <circle cx="2" cy="2" r="1.1" />
              <circle cx="6" cy="2" r="1.1" />
              <circle cx="2" cy="7" r="1.1" />
              <circle cx="6" cy="7" r="1.1" />
              <circle cx="2" cy="12" r="1.1" />
              <circle cx="6" cy="12" r="1.1" />
            </svg>
          </span>
        )}
        <button
          type="button"
          className="room-item-main"
          aria-current={room.id === currentRoomId}
          {...(pinned
            ? {
                "aria-keyshortcuts": "Alt+ArrowUp Alt+ArrowDown",
                title: t("已置顶，拖动可调整顺序（Alt + ↑/↓ 也可以）"),
              }
            : {})}
          onClick={() => switchRoom(room.id)}
        >
          <span className="room-item-label">
            <span className="room-item-name"># {room.name}</span>
            {room.branch && (
              <span
                className="room-item-branch"
                title={t("工作区 {0} 当前分支：{1}", {
                  0: room.workspace ?? "",
                  1: room.branch,
                })}
              >
                <BranchGlyph />
                <span>{room.branch}</span>
              </span>
            )}
          </span>
          {pinned && <PinGlyph />}
          <span className="room-item-meta">
            {room.archivedAt ? t("已归档") : t("{0} 在线", { 0: room.onlineCount })}
          </span>
          {(() => {
            const tasks = roomTaskCounts.get(room.id) ?? { attention: 0, inFlight: 0 };
            const unseenDone = attention.unseenByRoom.get(room.id) ?? 0;
            if (room.archivedAt) return null;
            // 有任务在跑就一直转圈；失败、等人回答的计数或做完未看的 ✓ 排在它旁边，不把转圈挤掉
            return (
              <>
                {tasks.inFlight > 0 && (
                  <span
                    className="room-task running"
                    role="img"
                    title={t("{0} 个任务进行中", { 0: tasks.inFlight })}
                    aria-label={t("# {0}：{1} 个任务进行中", {
                      0: room.name,
                      1: tasks.inFlight,
                    })}
                  >
                    <span className="room-task-spinner" aria-hidden="true" />
                    {tasks.inFlight > 1 && tasks.inFlight}
                  </span>
                )}
                {tasks.attention > 0 ? (
                  <span
                    className="room-task attention"
                    role="img"
                    title={t("{0} 个任务需要处理", { 0: tasks.attention })}
                    aria-label={t("# {0}：{1} 个任务需要处理", {
                      0: room.name,
                      1: tasks.attention,
                    })}
                  >
                    {tasks.attention}
                  </span>
                ) : (
                  unseenDone > 0 && (
                    <span
                      className="room-task done"
                      role="img"
                      title={t("{0} 个任务做完了，你还没看", { 0: unseenDone })}
                      aria-label={t("# {0}：{1} 个任务做完了，还没看", {
                        0: room.name,
                        1: unseenDone,
                      })}
                    >
                      ✓{unseenDone > 1 && unseenDone}
                    </span>
                  )
                )}
              </>
            );
          })()}
          {room.id !== currentRoomId &&
            !room.archivedAt &&
            room.latestSeq > (readSeqs[room.id] ?? 0) && (
              <span className="room-unread" aria-label={t("# {0} 有未读消息", { 0: room.name })} />
            )}
        </button>
        {isOwner && (
          <button
            type="button"
            className="room-item-manage"
            aria-label={t("管理房间 {0}", { 0: room.name })}
            aria-haspopup="dialog"
            onClick={(event) => openRoomDialog({ mode: "manage", room }, event.currentTarget)}
          >
            <Icon name="settings" size={14} />
          </button>
        )}
      </div>
    );
  }

  function openRoomMenu(event: ReactMouseEvent<HTMLElement>, room: RoomSummary) {
    // 预览弹窗等 portal 里的右击会冒泡到这里，那不是在对它右击
    if (isPortalBubble(event)) return;
    event.preventDefault();
    const row = event.currentTarget;
    const index = pinnedRoomIds.indexOf(room.id);
    const move = (to: number) => savePinnedRooms(moveRoom(pinnedRoomIds, room.id, to));
    const origin = resolveShareBase({
      development: import.meta.env.DEV,
      location: window.location,
      advertisedUrl: meta?.httpUrl,
    });
    setContextMenu({
      ...contextMenuPoint(event),
      title: `# ${room.name}`,
      items: [
        {
          label: t("打开"),
          disabled: room.id === currentRoomId,
          onSelect: () => switchRoom(room.id),
        },
        {
          label: t("标为已读"),
          disabled: room.latestSeq <= (readSeqs[room.id] ?? 0) || room.id === currentRoomId,
          onSelect: () => markRoomReadNow(room),
        },
        "separator",
        {
          label: t("复制房间链接"),
          // 局域网关着时链接是 127.0.0.1，只有这台电脑能打开，标出来免得发给别人
          ...(sharingBlocked ? { hint: t("仅本机可打开") } : {}),
          onSelect: () => void copyForMenu(`${origin}/#${room.id}`),
        },
        { label: t("复制房间 ID"), onSelect: () => void copyForMenu(room.id) },
        ...(isOwner
          ? [
              "separator" as const,
              index < 0
                ? {
                    label: t("置顶"),
                    onSelect: () => savePinnedRooms([room.id, ...pinnedRoomIds]),
                  }
                : {
                    label: t("取消置顶"),
                    onSelect: () => savePinnedRooms(pinnedRoomIds.filter((id) => id !== room.id)),
                  },
              // 只有置顶区里能手动排顺序
              ...(index < 0
                ? []
                : [
                    { label: t("移到最前"), disabled: index <= 0, onSelect: () => move(0) },
                    {
                      label: t("上移"),
                      hint: "Alt+↑",
                      disabled: index <= 0,
                      onSelect: () => move(index - 1),
                    },
                    {
                      label: t("下移"),
                      hint: "Alt+↓",
                      disabled: index >= pinnedRoomIds.length - 1,
                      onSelect: () => move(index + 1),
                    },
                  ]),
              "separator" as const,
              {
                label: t("管理房间…"),
                onSelect: () => {
                  const trigger = row.querySelector<HTMLButtonElement>(".room-item-main");
                  if (trigger) openRoomDialog({ mode: "manage", room }, trigger);
                },
              },
            ]
          : []),
      ],
    });
  }

  /**
   * 在终端里接着本机 Agent 在当前房间的会话：本机直接弹出终端；在别的设备上把命令复制下来。
   * 打不开时（正在执行、只限本机）错误里带着命令的，也复制下来方便手动运行。
   */
  async function openAgentTerminal(agent: LocalAgent) {
    try {
      if (local.mode === "device") {
        const command = await local.sessionCommand(agent.id, currentRoomId);
        if (!command) {
          setError(t("{0} 在这个房间还没有可以接着的会话。", { 0: agent.name }));
          return;
        }
        await copyTextToClipboard(command);
        setGotoNotice(t("已复制命令，在 Server 所在电脑的终端里运行：{0}", { 0: command }));
        return;
      }
      try {
        await local.openTerminal(agent.id, currentRoomId);
      } catch (reason) {
        // 正在执行：提醒一次，确认了照样打开
        if ((reason as { code?: string }).code !== "AGENT_BUSY") throw reason;
        if (!window.confirm(t("{0}\n\n仍要打开吗？", { 0: (reason as Error).message }))) return;
        await local.openTerminal(agent.id, currentRoomId, true);
      }
      setGotoNotice(t("已在终端打开 {0} 的会话；用完退出后再在房间里 @ 它。", { 0: agent.name }));
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      const command = (reason as { body?: { command?: unknown } }).body?.command;
      if (typeof command === "string") {
        await copyTextToClipboard(command).catch(() => undefined);
        setError(t("{0}（命令已复制：{1}）", { 0: message, 1: command }));
      } else {
        setError(message);
      }
    }
  }

  async function setLeadAgent(name: string | null) {
    try {
      upsertRoom(
        await roomRequest(`/api/rooms/${encodeURIComponent(currentRoomId)}`, "PATCH", {
          leadAgent: name,
        }),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  /**
   * 成员的右键菜单项：成员列表和对话流里的头像、名字共用这一套。
   * 已经不在这个房间的成员（participant 为空）只给复制名字和 @ 它；@ 一个不在场的名字会交给主 Agent。
   */
  function memberMenuItems(participant: Participant | undefined, name: string): ContextMenuItem[] {
    const self = name.toLocaleLowerCase() === username.toLocaleLowerCase();
    if (!participant) {
      return [
        ...(!self ? [{ label: t("@ {0}", { 0: name }), onSelect: () => appendMention(name) }] : []),
        { label: t("复制名字"), onSelect: () => void copyForMenu(name) },
      ];
    }
    const agent = participant.type === "agent" ? localAgentFor(participant.username) : undefined;
    const lead = isLeadAgent(participant);
    const act = (action: "start" | "stop" | "restart") =>
      void local.act(agent!.id, action).catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
    const live = agent && agent.status !== "stopped" && agent.status !== "crashed";
    const removed = removedAgentFor(participant);
    return [
      ...(!self
        ? [
            {
              label: t("@ {0}", { 0: participant.username }),
              onSelect: () => appendMention(participant.username),
            },
          ]
        : []),
      { label: t("复制名字"), onSelect: () => void copyForMenu(participant.username) },
      ...(removed && local.canManage
        ? [
            { label: t("重新接入"), onSelect: () => openRejoinAgent(participant) },
            { label: t("从列表隐藏"), onSelect: () => void hideRemovedMember(participant) },
          ]
        : []),
      ...(participant.type === "agent"
        ? [
            "separator" as const,
            { label: t("查看 Agent 任务"), onSelect: () => openActivity("tasks") },
            ...(canViewWorkspace && currentRoomWorkspace
              ? [
                  {
                    label: t("看它的改动"),
                    onSelect: () => openWorkspaceFor(participant.username),
                  },
                ]
              : []),
            ...(isOwner
              ? [
                  lead
                    ? { label: t("取消主 Agent"), onSelect: () => void setLeadAgent(null) }
                    : {
                        label: t("设为本房间的主 Agent"),
                        onSelect: () => void setLeadAgent(participant.username),
                      },
                ]
              : []),
            ...(agent
              ? [
                  "separator" as const,
                  { label: t("设置…"), onSelect: () => setSettingsAgentId(agent.id) },
                  {
                    label: local.mode === "device" ? t("复制会话命令") : t("在终端打开会话"),
                    onSelect: () => void openAgentTerminal(agent),
                  },
                  ...(live
                    ? [
                        {
                          // 等手上的任务做完再重启；要立即重启到「设置…」里确认
                          label: agent.restartWhenIdle ? t("已安排空闲后重启") : t("重启"),
                          ...(agent.busy && !agent.restartWhenIdle
                            ? { hint: t("做完任务后") }
                            : {}),
                          disabled: !local.canManage || agent.restartWhenIdle === true,
                          onSelect: () => act("restart"),
                        },
                        {
                          label: t("停止"),
                          danger: true,
                          disabled: !local.canManage,
                          onSelect: () => act("stop"),
                        },
                      ]
                    : [
                        {
                          label: t("启动"),
                          disabled: !local.canManage,
                          onSelect: () => act("start"),
                        },
                      ]),
                ]
              : []),
          ]
        : []),
    ];
  }

  /** 成员右键：@ 它、复制名字；Agent 还能设为主 Agent、看任务、打开设置、重启 / 停止 / 启动 */
  function openMemberMenu(event: ReactMouseEvent<HTMLElement>, participant: Participant) {
    // 预览弹窗等 portal 里的右击会冒泡到这里，那不是在对它右击
    if (isPortalBubble(event)) return;
    event.preventDefault();
    setContextMenu({
      ...contextMenuPoint(event),
      title: participant.username,
      items: memberMenuItems(participant, participant.username),
    });
  }

  /** 对话流里右击头像或名字：和成员列表同一套菜单，按发送者现在在不在房间算 */
  function openSenderMenu(
    event: ReactMouseEvent<HTMLElement>,
    sender: { id?: string; name: string },
  ) {
    // 预览弹窗等 portal 里的右击会冒泡到这里，那不是在对它右击
    if (isPortalBubble(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const participant =
      participants.find((item) => item.id === sender.id) ??
      participants.find(
        (item) => item.username.toLocaleLowerCase() === sender.name.toLocaleLowerCase(),
      );
    setContextMenu({
      ...contextMenuPoint(event),
      title: participant?.username ?? sender.name,
      items: memberMenuItems(participant, participant?.username ?? sender.name),
    });
  }

  async function submitRenameRoom(room: RoomSummary) {
    const name = roomDialogName.trim();
    if (!name) {
      setRoomDialogError(t("显示名称不能为空。"));
      return;
    }
    setRoomDialogBusy(true);
    setRoomDialogError(undefined);
    try {
      const workspace = roomDialogWorkspace.trim();
      const updated = await roomRequest(`/api/rooms/${encodeURIComponent(room.id)}`, "PATCH", {
        name,
        ...(workspace !== (room.workspace ?? "") ? { workspace: workspace || null } : {}),
        ...leadPatchOf(room, roomDialogLead),
        ...(roomDialogGuestFiles !== Boolean(room.workspaceFilesGuests)
          ? { workspaceFilesGuests: roomDialogGuestFiles }
          : {}),
      });
      upsertRoom(updated);
      closeRoomDialog();
    } catch (reason) {
      setRoomDialogError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRoomDialogBusy(false);
    }
  }

  async function clearRoom(room: RoomSummary) {
    setRoomDialogBusy(true);
    setRoomDialogError(undefined);
    try {
      if (clearWhiteboard) {
        const response = await fetch(
          `${base}/api/rooms/${encodeURIComponent(room.id)}/whiteboard`,
          { headers: { Authorization: `Bearer ${authToken}` } },
        );
        if (!response.ok) {
          const failure: unknown = await response.json().catch(() => ({}));
          throw new Error(serverError(failure) ?? t("无法加载白板历史。"));
        }
        const payload = (await response.json()) as { entries: WhiteboardEntry[] };
        await local.clearRoom(room.id, username, {
          whiteboard: "archive",
          entries: payload.entries.map(({ id, updatedAt }) => ({ id, updatedAt })),
        });
      } else {
        await local.clearRoom(room.id, username, { whiteboard: "keep" });
      }
      closeRoomDialog();
    } catch (reason) {
      setRoomDialogError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRoomDialogBusy(false);
    }
  }

  async function setRoomArchived(room: RoomSummary, archived: boolean) {
    setRoomDialogBusy(true);
    setRoomDialogError(undefined);
    try {
      const updated = await roomRequest(`/api/rooms/${encodeURIComponent(room.id)}`, "PATCH", {
        archived,
      });
      upsertRoom(updated);
      closeRoomDialog();
      if (archived && room.id === currentRoomId) switchRoom("general");
    } catch (reason) {
      setRoomDialogError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRoomDialogBusy(false);
    }
  }

  // 外面包一层：消息、白板里的提交号要能拿到「代码」面板的上下文（不改下面的缩进）
  const page = (
    <main className="app-shell">
      <a className="skip-link" href="#main-content">
        {t("跳到消息区")}
      </a>
      <HostApprovalsBanner local={local} />
      <HostApprovalWaiting local={local} />

      {mobilePanel && (
        <button
          className="panel-scrim"
          type="button"
          aria-label={t("关闭侧栏")}
          onClick={() => closeMobilePanel()}
        />
      )}

      <section
        className={`workspace ${membersCollapsed && !previewDocked ? "members-collapsed" : ""} ${roomsCollapsed ? "rooms-collapsed" : ""} ${previewDocked ? "preview-docked" : ""}`}
        style={
          {
            "--sidebar-width": `${panelWidths.rooms}px`,
            // 停靠预览时右侧栏换成预览栏自己的宽度（默认更宽），收起预览恢复成员栏宽度
            "--panel-width": `${previewDocked ? panelWidths.preview : panelWidths.members}px`,
          } as CSSProperties
        }
      >
        <RoomSidebar
          activeRoomCount={activeRoomCount}
          attention={attention}
          attentionGroup={attentionGroup}
          closeMobilePanel={closeMobilePanel}
          connectionState={connectionState}
          freezeRoomList={freezeRoomList}
          incidentAttention={incidents.attentionItems}
          openOwnerDevices={local.enabled ? () => setOwnerDevicesOpen(true) : undefined}
          incidentEntry={
            incidents.enabled
              ? {
                  count: incidents.unhandled,
                  open: (trigger, focusId) => {
                    incidentsTriggerRef.current = trigger ?? null;
                    closeMobilePanel(false);
                    setActivityView(undefined);
                    setSchedulesOpen(false);
                    setIncidentsView({ tab: "incidents", focusId });
                  },
                }
              : undefined
          }
          isOwner={isOwner}
          mobilePanel={mobilePanel}
          modifierKeyLabel={modifierKeyLabel}
          scheduleCounts={schedules.counts}
          openSchedules={openSchedules}
          openActivity={openActivity}
          openRoomDialog={openRoomDialog}
          openFeedback={() => {
            setUserMenuOpen(false);
            closeMobilePanel(false);
            setFeedbackView({});
          }}
          panelWidths={panelWidths}
          renderRoomItem={renderRoomItem}
          resizePanel={resizePanel}
          roomNameOf={roomNameOf}
          roomReorder={roomReorder}
          roomsCloseRef={roomsCloseRef}
          setImDialogOpen={setImDialogOpen}
          setMobilePanel={setMobilePanel}
          setSettingsOpen={setSettingsOpen}
          setShowArchivedRooms={setShowArchivedRooms}
          setThemePreference={setThemePreference}
          setUserMenuOpen={setUserMenuOpen}
          setUsername={setUsername}
          settingsTriggerRef={settingsTriggerRef}
          showArchivedRooms={showArchivedRooms}
          sidebarRooms={sidebarRooms}
          taskCounts={taskCounts}
          thawRoomList={thawRoomList}
          themePreference={themePreference}
          unreadMentionCount={unreadMentionCount}
          userMenuOpen={userMenuOpen}
          userMenuTriggerRef={userMenuTriggerRef}
          username={username}
        />

        <section className="chat-panel panel" id="main-content" tabIndex={-1}>
          <ChatHeader
            roomsCollapsed={roomsCollapsed}
            setRoomsCollapsed={setRoomsCollapsed}
            mobilePanel={mobilePanel}
            openMobilePanel={openMobilePanel}
            currentRoomName={currentRoomName}
            online={online}
            messages={messages}
            currentRoomWorkspace={currentRoomWorkspace}
            currentRoom={currentRoom}
            isOwner={isOwner}
            local={local}
            loadRoomWorktrees={loadRoomWorktrees}
            loadWorkspaceDetail={loadWorkspaceDetail}
            openWorkspaceSource={openWorkspaceSource}
            openWorktrees={openWorktrees}
            setSettingsTab={setSettingsTab}
            setSettingsOpen={setSettingsOpen}
            startNewTopic={startNewTopic}
            artifactsButtonRef={artifactsButtonRef}
            artifactsOpen={artifactsOpen}
            setArtifactsOpen={setArtifactsOpen}
            artifactCount={artifactCount}
            canViewWorkspace={canViewWorkspace}
            workspaceButtonRef={workspaceButtonRef}
            workspaceOpen={workspaceOpen}
            setWorkspaceOpen={setWorkspaceOpen}
            workspaceChangeCount={workspaceChangeCount}
            share={share}
            previewDocked={previewDocked}
            membersCollapsed={membersCollapsed}
            setMembersCollapsed={setMembersCollapsed}
            setDockedPreview={setDockedPreview}
            {...(desktopTerminal
              ? { terminal: { open: desktopTerminal.open, toggle: desktopTerminal.toggle } }
              : {})}
          />
          {/* 桌面端：对话和终端面板放在一起，终端可以在底部、右侧或铺满；浏览器里这两层是 display: contents */}
          <div
            className="chat-body"
            data-terminal={desktopTerminal ? "" : undefined}
            data-terminal-maximized={
              desktopTerminal?.open && desktopTerminal.layout.maximized ? "" : undefined
            }
          >
            <div
              className="chat-main"
              // 终端最大化时对话还在下面排着（滚动位置、草稿都不动），但不能被 Tab 到、也不读给读屏
              inert={desktopTerminal?.open && desktopTerminal.layout.maximized ? true : undefined}
            >
              <ChatNotices
                error={error}
                setError={setError}
                showNotificationPrompt={showNotificationPrompt}
                invocations={invocations}
                messages={messages}
                worktreeNotices={worktreeNotices}
                setWorktreeNotices={setWorktreeNotices}
                isOwner={isOwner}
                local={local}
                currentRoomId={currentRoomId}
                setGotoNotice={setGotoNotice}
                extendAgentBudget={extendAgentBudget}
                dismissNotificationPrompt={dismissNotificationPrompt}
                ensureNotificationPermission={ensureNotificationPermission}
              />
              <MessageList
                scroll={scroll}
                win={messageWindow}
                jump={jump}
                share={share}
                composer={composer}
                actions={actions}
                messages={messages}
                messagesLoaded={room.messagesLoaded}
                initialLoading={!room.hasLoadedRoomRef.current}
                loadingStatus={loadingStatus}
                currentRoomName={currentRoomName}
                currentRoomId={currentRoomId}
                currentRoomWorkspace={currentRoomWorkspace}
                username={username}
                guest={guest}
                isOwner={isOwner}
                base={base}
                authToken={authToken}
                connectionState={connectionState}
                participants={participants}
                invocations={invocations}
                traces={room.traces}
                pendingApprovals={room.pendingApprovals}
                agentProviderByName={agentProviderByName}
                timeFormat={timeFormat}
                openMachineIds={openMachineIds}
                setOpenMachineIds={setOpenMachineIds}
                openSenderMenu={openSenderMenu}
                openContextMenu={setContextMenu}
                locateMessageFromMarkdown={locateMessageFromMarkdown}
                onRecordTodo={
                  isOwner && connectionState === "online" ? recordMessageTodo : undefined
                }
                dockPreview={dockPreview}
                setRetryModelFor={setRetryModelFor}
                localAgentFor={localAgentFor}
                openAgentTerminal={openAgentTerminal}
                {...(local.enabled ? { openProxySettings } : {})}
                canViewWorkspace={canViewWorkspace}
                openWorkspaceFor={openWorkspaceFor}
              />
              <ShareBar
                share={share}
                messages={messages}
                currentRoomName={currentRoomName}
                agentProviderByName={agentProviderByName}
              />
              <Composer
                composer={composer}
                showJumpToBottom={scroll.showJumpToBottom}
                pendingNewMessages={scroll.pendingNewMessages}
                jumpToLatest={scroll.jumpToLatest}
                connectionState={connectionState}
                sendShortcut={sendShortcut}
                richComposer={richComposer}
                currentRoomId={currentRoomId}
                onOpenSendSettings={openSendSettings}
              />
            </div>
            <TerminalDock state={desktopTerminal} cwd={currentRoomWorkspace} />
          </div>
        </section>

        {workspaceOpen && canViewWorkspace && (
          <WorkspacePanel
            api={workspaceRequest}
            roomId={currentRoomId}
            workspaceConfigured={Boolean(currentRoomWorkspace)}
            isOwner={isOwner}
            onOverview={recordWorkspaceOverview}
            focus={workspaceFocus}
            revealFile={
              local.enabled && local.mode === "local"
                ? (source, path) => local.revealWorkspaceFile(currentRoomId, source, path)
                : undefined
            }
            onClose={() => {
              setWorkspaceOpen(false);
              window.requestAnimationFrame(() => workspaceButtonRef.current?.focus());
            }}
            onOpenSettings={() => {
              if (!currentRoom || !workspaceButtonRef.current) return;
              setWorkspaceOpen(false);
              openRoomDialog({ mode: "manage", room: currentRoom }, workspaceButtonRef.current);
            }}
          />
        )}

        {artifactsOpen && (
          <ArtifactsPanel
            base={base}
            token={authToken}
            roomId={currentRoomId}
            epoch={artifactsEpoch}
            onCounts={setArtifactCounts}
            onLocate={(item) => {
              // 先关面板再跳：面板铺满时挡着聊天
              setArtifactsOpen(false);
              void locateMessage(item);
            }}
            onDock={(item) => {
              // 关掉铺满的产物面板，露出对话，文件停在右侧栏
              setArtifactsOpen(false);
              dockPreview(item, { senderId: item.senderId, seq: item.messageSeq });
            }}
            onClose={() => {
              setArtifactsOpen(false);
              window.requestAnimationFrame(() => artifactsButtonRef.current?.focus());
            }}
          />
        )}

        {worktreesOpen && canManageWorktrees && (
          <WorktreePanel
            key={currentRoomId}
            roomId={currentRoomId}
            roomName={currentRoomName}
            api={local}
            onClose={() => {
              setWorktreesOpen(false);
              window.requestAnimationFrame(() => worktreesTriggerRef.current?.focus());
            }}
          />
        )}

        <SidePanel
          todoCount={[...room.todos.values()].filter((todo) => !todo.completed).length}
          todoPanel={
            <TodoPanel
              key={currentRoomId}
              todos={[...room.todos.values()]}
              members={participants}
              canManage={isOwner && connectionState === "online"}
              actions={todosApi}
              onLocate={(todo) => {
                if (todo.sourceMessageId && todo.sourceMessageSeq)
                  locateMessageFromMarkdown({
                    messageId: todo.sourceMessageId,
                    messageSeq: todo.sourceMessageSeq,
                  });
              }}
            />
          }
          roomWorkspace={currentRoom?.workspace}
          accessNow={accessNow}
          agentDialogOpen={agentDialogOpen}
          agentSettingsButton={agentSettingsButton}
          agentTaskSummary={agentTaskSummary}
          appendMention={appendMention}
          authToken={authToken}
          base={base}
          changeWhiteboardArchive={changeWhiteboardArchive}
          closeDockedPreview={closeDockedPreview}
          closeMobilePanel={closeMobilePanel}
          currentRoomId={currentRoomId}
          dockedNewerNotice={dockedNewerNotice}
          dockedPreview={dockedPreview}
          guest={guest}
          isLeadAgent={isLeadAgent}
          isOwner={isOwner}
          loadWhiteboardHistory={loadWhiteboardHistory}
          local={local}
          localAgentNames={localAgentNames}
          isRemovedMember={(participant) => Boolean(removedAgentFor(participant))}
          memberRecoveryActions={memberRecoveryActions}
          locateProgress={locateProgress}
          membersCloseRef={membersCloseRef}
          mobilePanel={mobilePanel}
          offline={offline}
          online={online}
          openAgentDialog={openAgentDialog}
          openAgentTask={openAgentTask}
          openMemberMenu={openMemberMenu}
          panelWidths={panelWidths}
          previewDocked={previewDocked}
          progressGroups={progressGroups}
          removeWhiteboardEntry={removeWhiteboardEntry}
          resizePanel={resizePanel}
          setDockedPreview={setDockedPreview}
          setError={setError}
          setGuestAgentDialogOpen={setGuestAgentDialogOpen}
          setInviteDialogOpen={setInviteDialogOpen}
          setSidePanelTab={setSidePanelTab}
          sidePanelTab={sidePanelTab}
          whiteboard={whiteboard}
          whiteboardEpochRef={whiteboardEpochRef}
          pluginPanel={
            hasPluginPanels ? (
              <PluginSidePanel
                plugins={plugins}
                active={activePluginPanel}
                setActive={setActivePluginPanel}
                command={pluginCommand}
                base={base}
                authToken={authToken}
                roomId={currentRoomId}
                context={{
                  roomId: currentRoomId,
                  locale: getLocale(),
                  theme: document.documentElement.dataset.theme === "light" ? "light" : "dark",
                  viewer: isOwner ? "owner" : "guest",
                }}
                api={{
                  messages: (limit) =>
                    messages
                      .filter((message) => !message.deletedAt)
                      .slice(-limit)
                      .map((message) => ({
                        seq: message.seq,
                        sender: message.senderName,
                        content: message.content,
                        createdAt: message.createdAt,
                      })),
                  members: () =>
                    participants.map((participant) => ({
                      name: participant.username,
                      type: participant.type,
                      online: participant.status !== "offline",
                    })),
                  insertIntoComposer: insertPluginText,
                }}
              />
            ) : undefined
          }
        />
      </section>
      {statusBarVisible && (
        <StatusBar
          connectionState={connectionState}
          meta={meta}
          participants={participants}
          leadAgentName={currentRoom?.leadAgent ?? undefined}
          leadAuto={isAutoLead(currentRoom)}
          setLeadAgent={isOwner ? (name) => void setLeadAgent(name) : undefined}
          isOwner={isOwner}
          local={local}
          im={
            isOwner && authToken && !meta?.sandbox
              ? {
                  base,
                  token: authToken,
                  dialogOpen: imDialogOpen,
                  open: (focusId) => {
                    setImFocus(focusId);
                    setImDialogOpen(true);
                  },
                }
              : undefined
          }
          incidents={
            incidents.enabled
              ? {
                  count: incidents.unhandled,
                  open: (trigger) => {
                    incidentsTriggerRef.current = trigger;
                    setActivityView(undefined);
                    setSchedulesOpen(false);
                    setIncidentsView({ tab: "incidents" });
                  },
                }
              : undefined
          }
          openAgentTasks={(trigger) => openActivity("tasks", trigger)}
          openSettings={(tab) => {
            setSettingsTab(tab);
            setSettingsOpen(true);
          }}
          openRuntimeHub={(focusMcp) => {
            setRuntimeHubFocus(focusMcp);
            setRuntimeHubOpen(true);
          }}
          runtimeHubOpen={runtimeHubOpen}
          openProxySettings={openProxySettings}
          settingsOpen={settingsOpen}
          messageNotifications={messageNotifications}
          updateMessageNotifications={updateMessageNotifications}
          sendShortcut={sendShortcut}
          setSendShortcut={setSendShortcut}
          themePreference={themePreference}
          setThemePreference={setThemePreference}
          interfaceDensity={interfaceDensity}
          setInterfaceDensity={setInterfaceDensity}
          localePreference={localePreference}
          hide={() => setStatusBarVisible(false)}
        />
      )}
      {dockedPreview?.popped && (
        <FilePreview
          key={dockedPreview.attachment.id}
          attachment={dockedPreview.attachment}
          base={base}
          token={authToken}
          onClose={closeDockedPreview}
          onUnavailable={dockedPreview.restored ? closeDockedPreview : undefined}
          onDock={() => setDockedPreview((current) => current && { ...current, popped: false })}
          notice={dockedNewerNotice}
        />
      )}

      {activityView && (
        <ActivityPanel
          view={activityView}
          rooms={rooms}
          mentions={mentionMessages}
          readSeqs={readSeqs}
          invocations={[...activeInvocations.values()]}
          invocationMessages={invocationMessages}
          isAgentOnline={(invocation) =>
            invocation.roomId === currentRoomId
              ? participants.some(
                  (participant) =>
                    participant.username === invocation.agentName &&
                    participant.status !== "offline",
                )
              : onlineInvocationIds.has(invocation.id)
          }
          participants={participants}
          search={searchMessages}
          onOpenMessage={openMessage}
          onOpenTask={attention.open}
          onMarkMentionsRead={markMentionsRead}
          onDismiss={dismissInvocations}
          usageRoomId={currentRoomId}
          loadUsage={loadUsage}
          onStartTopic={() => {
            if (
              window.confirm(
                t(
                  "开启新话题后，房间里的 Agent 都会丢弃之前的会话、从新会话开始；历史消息保留。继续吗？",
                ),
              )
            ) {
              startNewTopic();
              closeActivity();
            }
          }}
          onClose={closeActivity}
        />
      )}

      {schedulesOpen && (
        <SchedulesDialog
          schedules={schedules.schedules}
          invocations={schedules.invocations}
          isAgentOnline={(schedule, invocation) =>
            schedule.roomId === currentRoomId
              ? participants.some(
                  (participant) =>
                    participant.type === "agent" &&
                    participant.username.toLocaleLowerCase() ===
                      schedule.agentName.toLocaleLowerCase() &&
                    participant.status !== "offline",
                )
              : Boolean(invocation && schedules.onlineInvocationIds.has(invocation.id))
          }
          roomName={roomNameOf}
          currentRoomId={currentRoomId}
          onCancel={schedules.cancel}
          onJump={(roomId, messageId) => {
            closeSchedules(false);
            openRoomMessage(roomId, messageId);
          }}
          onOpenRoom={(roomId) => {
            closeSchedules(false);
            switchRoom(roomId);
          }}
          onClose={() => closeSchedules()}
        />
      )}

      {incidentsView && !feedbackView && incidents.enabled && (
        <IncidentsDialog
          tab={incidentsView.tab}
          focusId={incidentsView.focusId}
          incidents={incidents}
          slowOps={slowOpsState}
          rooms={rooms}
          currentRoomId={currentRoomId}
          username={username}
          loadAgents={loadRoomAgents}
          onFeedback={(incident, contribute) => {
            setFeedbackView({ incident, contribute });
          }}
          onTab={(tab) => setIncidentsView({ tab })}
          onClose={() => {
            setIncidentsView(undefined);
            incidentsTriggerRef.current?.focus();
          }}
        />
      )}

      {feedbackView && (
        <FeedbackDialog
          local={local}
          meta={meta}
          participants={participants}
          recentIncident={
            feedbackView.incident ??
            incidents.data?.incidents
              .slice()
              .sort(
                (first, second) => Date.parse(second.lastSeenAt) - Date.parse(first.lastSeenAt),
              )[0]
          }
          startContributing={feedbackView.contribute}
          prefillIncident={Boolean(feedbackView.incident)}
          canContribute={isOwner && local.enabled === true && local.mode === "local"}
          onContribute={(agent, task) => {
            if (
              !isOwner ||
              !local.enabled ||
              local.mode !== "local" ||
              !contributionAgents(local.agents, participants).some((item) => item.name === agent)
            ) {
              return Promise.reject(new Error(t("当前 Agent 不可用于本机贡献任务。")));
            }
            return sendContribution(room.socketRef.current, agent, task);
          }}
          onClose={() => setFeedbackView(undefined)}
        />
      )}

      {gotoOpen && (
        <GoToPalette
          items={buildGoToItems({
            rooms,
            currentRoomId,
            participants,
            invocations: activeInvocations.values(),
            attention: attention.items,
            messages: invocationMessages,
            statusLabel: (invocation) =>
              invocationStatusLabel(
                invocation,
                invocation.roomId === currentRoomId
                  ? participants.some(
                      (participant) =>
                        participant.id === invocation.agentId && participant.status !== "offline",
                    )
                  : onlineInvocationIds.has(invocation.id),
              ),
          })}
          onSelect={(item) => {
            if (item.kind === "room") switchRoom(item.room.id);
            else if (item.kind === "task") attention.open(item.invocation);
            else if (item.task) attention.open(item.task);
            else appendMention(item.participant.username);
          }}
          onNextAttention={jumpToNextAttention}
          onClose={() => setGotoOpen(false)}
        />
      )}
      {shortcutsOpen && <ShortcutsHelp onClose={() => setShortcutsOpen(false)} />}
      {contextMenu && <ContextMenu menu={contextMenu} onClose={closeContextMenu} />}
      {gotoNotice && (
        <div className="goto-toast" role="status">
          {gotoNotice}
        </div>
      )}

      {isOwner && !guest && (
        <JoinRemoteHost
          local={local}
          openLocalSettings={() => {
            setSettingsTab("computer");
            setSettingsOpen(true);
          }}
        />
      )}
      {inviteDialogOpen && isOwner && authToken && (
        <InviteDialog
          base={base}
          adminToken={authToken}
          roomId={currentRoomId}
          linkFor={(token) => `${inviteLink()}?invite=${token}`}
          lanBlocked={lanBlocked}
          onClose={() => setInviteDialogOpen(false)}
        />
      )}
      {retryModelFor && (
        <RetryModelDialog
          key={retryModelFor.id}
          agentName={retryModelFor.agentName}
          currentModel={retryModelAgent?.model}
          load={
            retryModelAgent ? (refresh) => local.models(retryModelAgent.id, refresh) : undefined
          }
          onRetry={(model, effort) => {
            retryInvocation(retryModelFor, model || undefined, effort || undefined);
            setRetryModelFor(undefined);
          }}
          onClose={() => setRetryModelFor(undefined)}
        />
      )}
      {settingsAgent && (
        <AgentSettingsDialog
          key={settingsAgent.id}
          agent={settingsAgent}
          lead={
            currentRoom?.leadAgent?.toLocaleLowerCase() === settingsAgent.name.toLocaleLowerCase()
          }
          lastModel={
            participants.find(
              (participant) =>
                participant.type === "agent" &&
                participant.username.toLocaleLowerCase() === settingsAgent.name.toLocaleLowerCase(),
            )?.lastModel
          }
          local={local}
          onOpenTerminal={() => void openAgentTerminal(settingsAgent)}
          onClose={() => setSettingsAgentId(undefined)}
        />
      )}
      {imDialogOpen && isOwner && authToken && (
        <ImDialog
          base={base}
          adminToken={authToken}
          roomId={currentRoomId}
          ownerName={username}
          {...(imFocus ? { focusId: imFocus } : {})}
          rooms={rooms
            .filter((room) => !room.archivedAt)
            .map((room) => ({ id: room.id, name: room.name }))}
          lanBlocked={lanBlocked}
          onClose={() => setImDialogOpen(false)}
        />
      )}
      {guestAgentDialogOpen && guest && (
        <GuestAgentDialog
          base={base}
          guestToken={guest.token}
          expiresAt={
            participants.find(
              (participant) =>
                participant.username.toLocaleLowerCase() === guest.username.toLocaleLowerCase(),
            )?.access?.expiresAt ?? guest.expiresAt
          }
          onClose={() => setGuestAgentDialogOpen(false)}
        />
      )}

      {agentDialogOpen && (
        <AgentSetupDialog
          rejoin={rejoinAgent}
          agentAccess={agentAccess}
          agentConnected={agentConnected}
          agentDialogCloseRef={agentDialogCloseRef}
          agentDialogRef={agentDialogRef}
          agentProvider={agentProvider}
          agentProviderChosen={agentProviderChosen}
          agentStep={agentStep}
          agentStepHeadingRef={agentStepHeadingRef}
          base={base}
          chooseAgentAccess={chooseAgentAccess}
          closeAgentDialog={closeAgentDialog}
          closeFullAccessConfirmation={closeFullAccessConfirmation}
          commandCopied={commandCopied}
          confirmFullAccess={confirmFullAccess}
          copyCommand={copyCommand}
          copyError={copyError}
          fullAccessConfirmationOpen={fullAccessConfirmationOpen}
          fullAccessOptionRef={fullAccessOptionRef}
          goToAgentStep={goToAgentStep}
          local={local}
          meta={meta}
          openRuntimeSettings={openRuntimeSettings}
          selectedAgentCommand={selectedAgentCommand}
          setAgentConnected={setAgentConnected}
          setAgentProvider={setAgentProvider}
          setAgentProviderChosen={setAgentProviderChosen}
          takenAgentNames={takenAgentNames}
          username={username}
          lanBlocked={lanBlocked}
        />
      )}

      {ownerDevicesOpen && local.enabled && (
        <OwnerDevicesDialog
          local={local}
          onClose={() => {
            setOwnerDevicesOpen(false);
            returnFocus(userMenuTriggerRef.current);
          }}
        />
      )}

      {runtimeHubOpen && local.mode === "local" && (
        <RuntimeHubDialog
          api={local}
          {...(runtimeHubFocus ? { focusMcp: runtimeHubFocus } : {})}
          onJump={jumpFromRuntimeHub}
          onClose={() => setRuntimeHubOpen(false)}
        />
      )}

      {settingsOpen && (
        <SettingsDialog
          attentionDelivery={attentionDelivery}
          attentionGroup={attentionGroup}
          attentionSound={attentionSound}
          autoSaveDraft={autoSaveDraft}
          closeSettings={closeSettings}
          openRuntimeHub={openRuntimeHub}
          openMembers={openMembersFromSettings}
          currentRoomId={currentRoomId}
          draft={draft}
          ensureNotificationPermission={ensureNotificationPermission}
          interfaceDensity={interfaceDensity}
          local={local}
          localePreference={localePreference}
          messageNotifications={messageNotifications}
          messageSize={messageSize}
          notificationPermission={notificationPermission}
          notificationSound={notificationSound}
          presenceNotifications={presenceNotifications}
          reduceMotion={reduceMotion}
          richComposer={richComposer}
          runtimesFocus={runtimesFocus}
          sendShortcut={sendShortcut}
          setAttentionGroup={setAttentionGroup}
          setAttentionSound={setAttentionSound}
          setAutoSaveDraft={setAutoSaveDraft}
          setComposerPreview={setComposerPreview}
          setInterfaceDensity={setInterfaceDensity}
          setMessageSize={setMessageSize}
          setNotificationSound={setNotificationSound}
          setReduceMotion={setReduceMotion}
          statusBarVisible={statusBarVisible}
          setStatusBarVisible={setStatusBarVisible}
          setRichComposer={setRichComposer}
          setSendShortcut={setSendShortcut}
          setSettingsTab={setSettingsTab}
          setThemePreference={setThemePreference}
          setThreadWidth={setThreadWidth}
          setTimeFormat={setTimeFormat}
          settingsCloseRef={settingsCloseRef}
          settingsDialogRef={settingsDialogRef}
          settingsTab={settingsTab}
          themePreference={themePreference}
          threadWidth={threadWidth}
          timeFormat={timeFormat}
          updateAttentionDelivery={updateAttentionDelivery}
          updateMessageNotifications={updateMessageNotifications}
          updatePresenceNotifications={updatePresenceNotifications}
          username={username}
          visibleSettingsTabs={visibleSettingsTabs}
        />
      )}

      {roomDialog && (
        <RoomDialog
          agentProviderByName={agentProviderByName}
          archiveConfirmOpen={archiveConfirmOpen}
          clearConfirmOpen={clearConfirmOpen}
          clearRoom={clearRoom}
          clearWhiteboard={clearWhiteboard}
          closeRoomDialog={closeRoomDialog}
          currentRoomId={currentRoomId}
          isOwner={isOwner}
          leadCandidates={leadCandidates}
          local={local}
          roomDialog={roomDialog}
          roomDialogBusy={roomDialogBusy}
          roomDialogCloseRef={roomDialogCloseRef}
          roomDialogError={roomDialogError}
          roomDialogGuestFiles={roomDialogGuestFiles}
          roomDialogId={roomDialogId}
          roomDialogLead={roomDialogLead}
          roomDialogName={roomDialogName}
          roomDialogRef={roomDialogRef}
          roomDialogWorkspace={roomDialogWorkspace}
          roomWorkspacePicking={roomWorkspacePicking}
          setArchiveConfirmOpen={setArchiveConfirmOpen}
          setClearConfirmOpen={setClearConfirmOpen}
          setClearWhiteboard={setClearWhiteboard}
          setRoomArchived={setRoomArchived}
          setRoomDialogGuestFiles={setRoomDialogGuestFiles}
          setRoomDialogId={setRoomDialogId}
          setRoomDialogLead={setRoomDialogLead}
          setRoomDialogName={setRoomDialogName}
          setRoomDialogWorkspace={setRoomDialogWorkspace}
          setRoomWorkspacePicking={setRoomWorkspacePicking}
          submitCreateRoom={submitCreateRoom}
          submitRenameRoom={submitRenameRoom}
        />
      )}
      {/* 右下角一列：任务提醒在上，更新的提示 / 进度卡片在下 */}
      <div className="corner-dock">
        <AttentionToasts
          toasts={attention.toasts}
          roomName={roomNameOf}
          onOpen={attention.open}
          onDismiss={attention.dismissToast}
          onDismissAll={attention.dismissAllToasts}
        />
        <UpdateCorner />
      </div>
      {showOnboarding && onboardingOpen && (
        <OnboardingGuide steps={onboardingSteps} onClose={closeOnboarding} />
      )}
      {showOnboarding && !onboardingOpen && !agentDialogOpen && !imDialogOpen && (
        <Button className="onboarding-resume" onClick={() => setOnboardingOpen(true)}>
          {t("继续上手引导（{0}/{1}）", {
            0: onboardingSteps.filter((step) => step.done).length,
            1: onboardingSteps.length,
          })}
        </Button>
      )}
    </main>
  );
  return (
    <WorkspaceRefsContext.Provider value={workspaceRefs}>
      <AttachmentLocalOpenContext.Provider value={openAttachmentLocally}>
        {page}
      </AttachmentLocalOpenContext.Provider>
    </WorkspaceRefsContext.Provider>
  );
}
