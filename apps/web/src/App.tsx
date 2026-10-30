import {
  Fragment,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import type {
  ChatMessage,
  Invocation,
  MessagesResponse,
  MetaResponse,
  Participant,
  QuestionAnswer,
  RoomSummary,
  RoomsResponse,
  ServerEvent,
  WhiteboardEntry,
} from "@ai-hive/protocol";
import {
  applyMention,
  draftMentions,
  filterMentionParticipants,
  findMentionContext,
  splitDraftMentions,
  type MentionContext,
} from "./mention-autocomplete";
import { createClientMessageId } from "./client-id";
import {
  InvocationChips,
  groupInvocationsByMessage,
  BUDGET_EXTEND_TURNS,
  currentPausedInvocations,
  upsertInvocation,
  waitingInvocationForQuestion,
} from "./invocations";
import { WhiteboardPanel, upsertWhiteboardEntry } from "./whiteboard";
import { ActivityPanel, isInFlight, needsAttention, type ActivityView } from "./activity";
import { LocalAgentList, LocalLaunch, providerInfo, useLocalAgents } from "./local-agents";
import { createFrameClock, easeInOutCubic, easeOutQuint } from "./easing";
import { ShadowContent } from "./shadow-content";
import {
  CollapsibleMessage,
  MAX_MESSAGE_LENGTH,
  MESSAGE_LENGTH_WARNING_RATIO,
} from "./collapsible-message";
import { buildShareMarkdown, downloadFile, formatShareTimestamp, shareFilename } from "./share";

// Markdown 渲染器（react-markdown + highlight.js）体积较大，拆成独立 chunk 且在应用启动时
// 立即预加载：不阻塞首屏解析，又通常能赶在 WebSocket 快照到达前就绪，避免消息先以纯文本闪现
const messageMarkdownModule = import("./message-markdown");
type MessageMarkdownComponent = (typeof import("./message-markdown"))["MessageMarkdown"];
// 模块下载完成后同步渲染：React.lazy 第一次使用时总会挂起一轮（即使模块早已就绪），
// 先显示纯文本占位再换成 Markdown，会让消息列表在刷新时多一次重排和高度跳变
let loadedMessageMarkdown: MessageMarkdownComponent | undefined;
void messageMarkdownModule.then((module) => {
  loadedMessageMarkdown = module.MessageMarkdown;
});
const LazyMessageMarkdown = lazy(() =>
  messageMarkdownModule.then((module) => ({ default: module.MessageMarkdown })),
);
function MessageMarkdown({ content }: { content: string }) {
  // 每个实例挂载时选定一次，避免模块就绪后组件类型改变导致整条消息重新挂载
  const [Component] = useState<MessageMarkdownComponent | typeof LazyMessageMarkdown>(
    () => loadedMessageMarkdown ?? LazyMessageMarkdown,
  );
  return <Component content={content} />;
}

/** 自绘滚动动画单帧最多推进的时间：约两帧，主线程卡顿时动画放慢而不是跳跃 */
const MAX_FRAME_STEP_MS = 32;
import { copyTextToClipboard } from "./clipboard";
import { QuestionOptions } from "./question-options";
import { ProviderLogo, providerLogoName } from "./provider-logos";
import { resolveServerBase, resolveWebSocketUrl } from "./server-url";

const storedUsernameKey = "ai-hive.username";
const storedRoomKey = "ai-hive.room";
const storedSendShortcutKey = "ai-hive.send-shortcut";
const storedAutoSaveDraftKey = "ai-hive.auto-save-draft";
const storedTimeFormatKey = "ai-hive.time-format";
const storedMessageNotificationsKey = "ai-hive.notify-messages";
const storedNotificationPromptDismissedKey = "ai-hive.notify-prompt-dismissed";
const storedNotificationSoundKey = "ai-hive.notification-sound";
const storedPresenceNotificationsKey = "ai-hive.notify-agent-presence";
const storedThemeKey = "ai-hive.theme";
const storedDensityKey = "ai-hive.density";
const storedMessageSizeKey = "ai-hive.message-size";
const storedMembersCollapsedKey = "ai-hive.members-collapsed";
const storedReduceMotionKey = "ai-hive.reduce-motion";
type SelectableAgentProvider = "codex" | "claude" | "copilot" | "openclaw" | "opencode" | "omp";
type AgentAccessMode = "read-only" | "workspace" | "full";
type AgentSetupStep = 1 | 2 | 3;
type MessageNotificationMode = "off" | "mentions" | "all";
type SendShortcut = "modifier-enter" | "enter";
type SettingsTab = "chat" | "notifications" | "appearance";
type TimeFormat = "system" | "24h" | "12h";
type ThemePreference = "system" | "dark" | "light";
type InterfaceDensity = "comfortable" | "compact";
type MessageSize = "small" | "standard" | "large";
type BrowserNotificationPermission = NotificationPermission | "unsupported";
type MobilePanel = "members" | "rooms";
type SidePanelTab = "members" | "whiteboard";
type IconName =
  | "arrow-down"
  | "arrow-right"
  | "arrow-up"
  | "at"
  | "activity"
  | "bell"
  | "board"
  | "check"
  | "close"
  | "copy"
  | "external"
  | "hash"
  | "logout"
  | "more"
  | "panel-right"
  | "plug"
  | "plus"
  | "send"
  | "search"
  | "settings"
  | "share"
  | "shield"
  | "undo"
  | "user-plus"
  | "users";

const selectableAgentProviders = [
  "codex",
  "claude",
  "copilot",
  "opencode",
  "omp",
  "openclaw",
] as const;

const agentProviderDescriptions: Record<SelectableAgentProvider, string> = {
  codex: "OpenAI 编程 Agent",
  claude: "Anthropic CLI",
  copilot: "GitHub 编程助手",
  openclaw: "本地自主 Agent",
  opencode: "开源终端 Agent，模型自选",
  omp: "oh-my-pi 终端 Agent",
};

const agentAccessOptions: Array<{
  id: AgentAccessMode;
  label: string;
  description: string;
}> = [
  { id: "read-only", label: "只读", description: "推荐。只读取与规划，不写入工作区。" },
  { id: "workspace", label: "工作区", description: "可在当前终端目录内读写文件、运行命令。" },
  { id: "full", label: "完全访问", description: "不设 Hive 沙箱，可执行当前系统用户的所有操作。" },
];

const messageNotificationModes = ["off", "mentions", "all"] as const;

const messageNotificationOptions: Array<{
  id: MessageNotificationMode;
  label: string;
  description: string;
}> = [
  { id: "off", label: "关闭通知", description: "不弹系统通知，提示音不受影响" },
  { id: "mentions", label: "@ 我时通知", description: "只有消息里提到我才提醒" },
  { id: "all", label: "当前房间任意消息", description: "所在房间的每条新消息都提醒" },
];

const agentSetupSteps: Array<{ step: AgentSetupStep; label: string }> = [
  { step: 1, label: "选择 Agent" },
  { step: 2, label: "设置权限" },
  { step: 3, label: "复制命令" },
];

/** "继续"按钮一次追加的 Agent 互相对话轮数 */

const settingsTabs: Array<{ id: SettingsTab; label: string; description: string }> = [
  { id: "chat", label: "聊天与输入", description: "发送、草稿与时间" },
  { id: "notifications", label: "通知", description: "提及、声音与状态" },
  { id: "appearance", label: "外观", description: "主题、密度与字号" },
];

function storedSendShortcut(): SendShortcut {
  return localStorage.getItem(storedSendShortcutKey) === "enter" ? "enter" : "modifier-enter";
}

function storedBoolean(key: string, fallback: boolean): boolean {
  const value = localStorage.getItem(key);
  return value === null ? fallback : value === "true";
}

function storedChoice<T extends string>(key: string, choices: readonly T[], fallback: T): T {
  const value = localStorage.getItem(key);
  return choices.includes(value as T) ? (value as T) : fallback;
}

function storedMessageNotificationMode(): MessageNotificationMode {
  return storedChoice(storedMessageNotificationsKey, messageNotificationModes, "mentions");
}

function draftStorageKey(username: string, roomId: string): string {
  return `ai-hive.draft.${username.toLocaleLowerCase()}.${roomId}`;
}

function readSeqStorageKey(roomId: string): string {
  return `ai-hive.read-seq.${roomId}`;
}

const roomIdPattern = /^[A-Za-z0-9_-]{1,64}$/;

function roomIdFromHash(): string | undefined {
  const value = window.location.hash.replace(/^#/, "");
  return roomIdPattern.test(value) ? value : undefined;
}

function initialRoomId(): string {
  const value = roomIdFromHash() ?? localStorage.getItem(storedRoomKey);
  return value && roomIdPattern.test(value) ? value : "general";
}

function sortRooms(rooms: RoomSummary[]): RoomSummary[] {
  return [...rooms].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}

function browserNotificationPermission(): BrowserNotificationPermission {
  return "Notification" in window ? Notification.permission : "unsupported";
}

function showBrowserNotification(title: string, body: string): void {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    new Notification(title, { body, tag: "ai-hive" });
  } catch {
    // Notification support can be restricted by browser or embedding context.
  }
}

// AudioContext 是稀缺资源（Chrome 有并发上限），全局复用一个而不是每次提示音都新建
let sharedToneContext: AudioContext | undefined;

function playNotificationTone(): void {
  const AudioContextConstructor =
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).AudioContext ??
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextConstructor) return;
  try {
    sharedToneContext ??= new AudioContextConstructor();
    const context = sharedToneContext;
    if (context.state === "suspended") void context.resume().catch(() => undefined);
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = 620;
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.08, context.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.16);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.17);
    oscillator.addEventListener("ended", () => {
      oscillator.disconnect();
      gain.disconnect();
    });
  } catch {
    // Audio playback can be blocked until the page receives a user gesture.
  }
}

function platformModifierLabel(): string {
  return /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent) ? "Cmd" : "Ctrl";
}

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    "arrow-down": <path d="M12 5v14m-5-5 5 5 5-5" />,
    "arrow-right": <path d="M5 12h14m-5-5 5 5-5 5" />,
    "arrow-up": <path d="M12 19V5m-6 6 6-6 6 6" />,
    at: (
      <>
        <circle cx="12" cy="12" r="3.6" />
        <path d="M15.6 12v1.4a2.6 2.6 0 0 0 5.2 0V12a8.8 8.8 0 1 0-3.4 7" />
      </>
    ),
    activity: <path d="M3 12h4l2.5-6 5 12 2.5-6H21" />,
    search: (
      <>
        <circle cx="11" cy="11" r="6.5" />
        <path d="m20 20-4.4-4.4" />
      </>
    ),
    board: (
      <>
        <rect x="5" y="4" width="14" height="17" rx="2" />
        <path d="M9 3h6v3H9zM9 11h6M9 15h4" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    copy: (
      <>
        <rect x="8" y="8" width="11" height="11" rx="2" />
        <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
      </>
    ),
    external: (
      <path d="M14 5h5v5m0-5-8 8M19 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
    ),
    bell: <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2H4.5L6 16Zm4 4a2 2 0 0 0 4 0" />,
    undo: <path d="M9 14 4 9l5-5M4 9h9.5a6.5 6.5 0 0 1 0 13H11" />,
    hash: <path d="M9 4 7 20M17 4l-2 16M4 9h17M3 15h17" />,
    logout: <path d="M10 5H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4m5-4 3-3-3-3m3 3H9" />,
    more: <path d="M6 12h.01M12 12h.01M18 12h.01" strokeWidth="2.6" />,
    "panel-right": (
      <>
        <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
        <path d="M14.5 4.5v15" />
      </>
    ),
    plug: <path d="M8 3v4m8-4v4M6 7h12v2a6 6 0 0 1-6 6v0a6 6 0 0 1-6-6V7Zm6 8v6" />,
    plus: <path d="M12 5v14M5 12h14" />,
    send: <path d="m21 3-7.4 18-3.7-7.9L2 9.4 21 3Zm-11.1 10.1L14 9" />,
    share: <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v13" />,
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.08A1.7 1.7 0 0 0 8.96 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3v-4h.08A1.7 1.7 0 0 0 4.6 8.96a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06a1.7 1.7 0 0 0 1.88.34A1.7 1.7 0 0 0 10 3.08V3h4v.08a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06a1.7 1.7 0 0 0-.34 1.88A1.7 1.7 0 0 0 20.92 10H21v4h-.08A1.7 1.7 0 0 0 19.4 15Z" />
      </>
    ),
    shield: <path d="M12 3 5 6v5c0 4.6 2.9 8 7 10 4.1-2 7-5.4 7-10V6l-7-3Zm-3 9 2 2 4-4" />,
    "user-plus": (
      <>
        <circle cx="10" cy="8" r="3.5" />
        <path d="M3.5 20a6.5 6.5 0 0 1 13 0M19 8v6m3-3h-6" />
      </>
    ),
    users: (
      <>
        <circle cx="9" cy="8" r="3" />
        <path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 5.5a3 3 0 0 1 0 5.8M16.5 14a5 5 0 0 1 4 5" />
      </>
    ),
  };

  return (
    <svg
      className="icon"
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
      {paths[name]}
    </svg>
  );
}

const themeOptions: Array<{ value: ThemePreference; label: string }> = [
  { value: "dark", label: "深色" },
  { value: "system", label: "自动" },
  { value: "light", label: "浅色" },
];

function ThemeGlyph({ theme }: { theme: ThemePreference }) {
  if (theme === "dark") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M20.3 14.6A7.7 7.7 0 0 1 9.4 3.7 8.4 8.4 0 1 0 20.3 14.6Z" />
      </svg>
    );
  }
  if (theme === "system") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M20.5 12a8.5 8.5 0 1 1-2.1-5.6M18.7 3.8v3.4h-3.4M12 7.2V12l3 1.8" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="3.8" />
      <path d="M12 2.8v2.1M12 19.1v2.1M4.1 4.1l1.5 1.5M18.4 18.4l1.5 1.5M2.8 12h2.1M19.1 12h2.1M4.1 19.9l1.5-1.5M18.4 5.6l1.5-1.5" />
    </svg>
  );
}

function ThemeSwitcher({
  value,
  onChange,
}: {
  value: ThemePreference;
  onChange: (value: ThemePreference) => void;
}) {
  const currentLabel = themeOptions.find((option) => option.value === value)?.label ?? "自动";
  return (
    <div
      className={`theme-switcher ${value}`}
      role="radiogroup"
      aria-label="颜色主题"
      title={`当前：${currentLabel}`}
    >
      <span className="theme-switcher-indicator" aria-hidden="true" />
      {themeOptions.map((option) => (
        <button
          type="button"
          role="radio"
          aria-checked={value === option.value}
          aria-label={option.label}
          title={option.label}
          className={value === option.value ? "active" : ""}
          onClick={() => onChange(option.value)}
          key={option.value}
        >
          <ThemeGlyph theme={option.value} />
        </button>
      ))}
    </div>
  );
}

function HiveLogo({ compact = false }: { compact?: boolean }) {
  return (
    <span className={`hive-logo ${compact ? "compact" : ""}`} aria-hidden="true">
      <svg viewBox="0 0 48 48" width="40" height="40" fill="none">
        <path d="m24 3 18 10.5v21L24 45 6 34.5v-21L24 3Z" />
        <path d="m24 12 10 6v12l-10 6-10-6V18l10-6Z" />
        <circle cx="24" cy="24" r="2.75" />
      </svg>
    </span>
  );
}

function participantStatusLabel(status: Participant["status"]): string {
  if (status === "online") return "在线";
  if (status === "busy") return "正在处理";
  return "离线";
}

function agentProviderLabel(provider?: string): string {
  if (provider === "codex") return "Codex";
  if (provider === "claude") return "Claude Code";
  if (provider === "copilot") return "GitHub Copilot";
  if (provider === "openclaw") return "OpenClaw";
  if (provider === "opencode") return "OpenCode";
  if (provider === "omp") return "omp";
  if (provider === "echo") return "Echo";
  return provider || "Agent";
}

function agentNameFor(ownerUsername: string, provider: SelectableAgentProvider): string {
  const suffixes: Record<SelectableAgentProvider, string> = {
    codex: "-codex",
    claude: "-claude",
    copilot: "-copilot",
    openclaw: "-openclaw",
    opencode: "-opencode",
    omp: "-omp",
  };
  const suffix = suffixes[provider];
  return `${ownerUsername.slice(0, 32 - suffix.length)}${suffix}`;
}

function agentCommandFor(
  meta: MetaResponse,
  provider: SelectableAgentProvider,
  ownerUsername: string,
  access: AgentAccessMode,
): string {
  const agentName = agentNameFor(ownerUsername, provider);
  return meta.agentCommand
    .replace(" join ", ` join --provider ${provider} `)
    .replace("--room general ", "")
    .replace("--name my-agent", `--name ${agentName}`)
    .concat(` --access ${access}${access === "read-only" ? "" : " --cwd ."}`)
    .concat(provider === "openclaw" ? " --openclaw-configure-mcp" : "");
}

function moveRadioSelection(
  event: ReactKeyboardEvent<HTMLElement>,
  checkedIndex: number,
  select: (index: number) => void,
): void {
  const delta =
    event.key === "ArrowDown" || event.key === "ArrowRight"
      ? 1
      : event.key === "ArrowUp" || event.key === "ArrowLeft"
        ? -1
        : 0;
  if (!delta) return;
  event.preventDefault();
  const radios = event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]');
  const next = (checkedIndex + delta + radios.length) % radios.length;
  select(next);
  radios[next]?.focus();
}

function serverBase(): string {
  return resolveServerBase({
    configured: import.meta.env.VITE_HIVE_SERVER as string | undefined,
    development: import.meta.env.DEV,
    protocol: window.location.protocol,
    hostname: window.location.hostname,
    origin: window.location.origin,
  });
}

function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

const messageGroupWindowMs = 5 * 60_000;

type TimelineEntry = { message: ChatMessage; newDay: boolean; grouped: boolean };

function buildTimeline(messages: ChatMessage[]): TimelineEntry[] {
  return messages.map((message, index) => {
    const previous = messages[index - 1];
    const newDay =
      !previous ||
      new Date(previous.createdAt).toDateString() !== new Date(message.createdAt).toDateString();
    const grouped =
      !newDay &&
      previous !== undefined &&
      previous.senderId === message.senderId &&
      new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime() <
        messageGroupWindowMs;
    return { message, newDay, grouped };
  });
}

function dateDividerLabel(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "今天";
  if (date.toDateString() === yesterday.toDateString()) return "昨天";
  return date.toLocaleDateString([], { year: "numeric", month: "long", day: "numeric" });
}

function avatarHue(name: string): number {
  let hash = 0;
  for (const char of name.toLocaleLowerCase()) {
    hash = (hash * 31 + char.charCodeAt(0)) % 360;
  }
  return hash;
}

/** 头像内容：Agent 显示厂商标识（未知厂商回退为 "AI"），人类显示名字首字母 */
function AvatarGlyph({ type, name, provider }: { type: string; name: string; provider?: string }) {
  if (type !== "agent") return <>{name.slice(0, 1).toUpperCase()}</>;
  const logo = providerLogoName(provider);
  return logo ? <ProviderLogo provider={logo} /> : <>AI</>;
}

function avatarHueStyle(name: string): CSSProperties {
  return { "--avatar-hue": avatarHue(name) } as CSSProperties;
}

function resizeComposer(textarea: HTMLTextAreaElement): void {
  textarea.style.height = "0px";
  const nextHeight = Math.min(176, Math.max(54, textarea.scrollHeight));
  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY = textarea.scrollHeight > 176 ? "auto" : "hidden";
}

function SettingsSwitch({
  checked,
  disabled = false,
  label,
  description,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  description: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      className="settings-switch-row"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      <i className="switch-control" aria-hidden="true">
        <b />
      </i>
    </button>
  );
}

function LoginDialog({ onJoin }: { onJoin: (username: string) => void }) {
  const [username, setUsername] = useState(localStorage.getItem(storedUsernameKey) ?? "");
  return (
    <div className="login-shell">
      <main className="login-card">
        <section className="login-intro">
          <div className="login-brand">
            <HiveLogo />
            <strong>AI Hive</strong>
          </div>
          <div className="login-thesis">
            <h1>
              让人类与 Agent，
              <span>沿着同一条思路工作。</span>
            </h1>
            <p>把消息、协作者与本地 Agent 放进一个实时工作区，所有人都看见同一份上下文。</p>
          </div>
          <div className="signal-map" aria-hidden="true">
            <span className="signal-node human">RD</span>
            <span className="signal-node agent">AI</span>
            <span className="signal-node agent secondary">AI</span>
            <p>3 位协作者 · 同一条实时对话</p>
          </div>
        </section>

        <section className="login-form-panel">
          <div className="login-form-heading">
            <h2>进入 AI Hive</h2>
            <p className="login-copy">选择一个在当前房间中可识别的名字。</p>
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const clean = username.trim();
              if (clean) onJoin(clean);
            }}
          >
            <label htmlFor="username">你的用户名</label>
            <input
              id="username"
              name="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              maxLength={32}
              pattern="[A-Za-z0-9_.\-\u4e00-\u9fff]+"
              placeholder="例如 rongding…"
              autoComplete="username"
              spellCheck={false}
            />
            <button type="submit">
              <span>进入聊天室</span>
              <Icon name="arrow-right" />
            </button>
          </form>
          <p className="fine-print">支持中英文、数字、点、下划线与连字符。</p>
          <div className="login-trust">
            <Icon name="shield" size={16} />
            <span>仅在局域网内共享，Agent 权限留在本机。</span>
          </div>
        </section>
      </main>
    </div>
  );
}

export function App() {
  const [meta, setMeta] = useState<MetaResponse>();
  const [username, setUsername] = useState(() => localStorage.getItem(storedUsernameKey) ?? "");
  const [currentRoomId, setCurrentRoomId] = useState(initialRoomId);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [readSeqs, setReadSeqs] = useState<Record<string, number>>({});
  const [showArchivedRooms, setShowArchivedRooms] = useState(false);
  const [participants, setParticipants] = useState<Participant[]>([]);
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
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // 收到房间快照之前为 false：区分"还在加载"和"房间真的是空的"，避免欢迎页闪现
  const [messagesLoaded, setMessagesLoaded] = useState(false);
  const [invocations, setInvocations] = useState<ReadonlyMap<string, Invocation>>(new Map());
  const [whiteboard, setWhiteboard] = useState<ReadonlyMap<string, WhiteboardEntry>>(new Map());
  const [sidePanelTab, setSidePanelTab] = useState<SidePanelTab>("members");
  const [highlightedMessageId, setHighlightedMessageId] = useState<string>();
  const [pendingJumpId, setPendingJumpId] = useState<string>();
  // 跨房间入口：搜索、提及我、Agent 任务
  const [activityView, setActivityView] = useState<ActivityView>();
  const [mentionMessages, setMentionMessages] = useState<ChatMessage[]>([]);
  // 正在回答的 Agent 提问；发送时作为 replyToMessageId
  const [answering, setAnswering] = useState<ChatMessage>();
  // 已点选提交、等服务端确认的提问 ID → 幂等键（重发沿用同一个键，只续接一次）
  const [pendingAnswers, setPendingAnswers] = useState<ReadonlyMap<string, string>>(new Map());
  const [activeInvocations, setActiveInvocations] = useState<ReadonlyMap<string, Invocation>>(
    new Map(),
  );
  const [invocationMessages, setInvocationMessages] = useState<ReadonlyMap<string, ChatMessage>>(
    new Map(),
  );
  // 切换房间后待定位的消息（在新房间快照到达后再滚动过去）
  const [crossRoomJumpId, setCrossRoomJumpId] = useState<string>();
  const [onlineInvocationIds, setOnlineInvocationIds] = useState<ReadonlySet<string>>(new Set());
  const activityTriggerRef = useRef<HTMLElement | null>(null);
  const globalEventsRef = useRef<{
    onInvocation: (invocation: Invocation) => void;
    onRoomActivity: () => void;
    onSnapshot: () => void;
  }>({
    onInvocation: () => undefined,
    onRoomActivity: () => undefined,
    onSnapshot: () => undefined,
  });
  const [draft, setDraft] = useState(() => {
    const storedUsername = localStorage.getItem(storedUsernameKey) ?? "";
    return storedUsername && storedBoolean(storedAutoSaveDraftKey, true)
      ? (localStorage.getItem(draftStorageKey(storedUsername, initialRoomId())) ?? "")
      : "";
  });
  const [mentionContext, setMentionContext] = useState<MentionContext>();
  const [activeMentionIndex, setActiveMentionIndex] = useState(0);
  const [connectionState, setConnectionState] = useState<"connecting" | "online" | "offline">(
    "connecting",
  );
  const [error, setError] = useState<string>();
  const [commandCopied, setCommandCopied] = useState(false);
  const [copyError, setCopyError] = useState<string>();
  const [agentProvider, setAgentProvider] = useState<SelectableAgentProvider>("codex");
  const [agentAccess, setAgentAccess] = useState<AgentAccessMode>("read-only");
  const [agentStep, setAgentStep] = useState<AgentSetupStep>(1);
  const [fullAccessConfirmationOpen, setFullAccessConfirmationOpen] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>();
  const [agentDialogOpen, setAgentDialogOpen] = useState(false);
  const [roomDialog, setRoomDialog] = useState<
    { mode: "create" } | { mode: "manage"; room: RoomSummary }
  >();
  const [roomDialogId, setRoomDialogId] = useState("");
  const [roomDialogName, setRoomDialogName] = useState("");
  const [roomDialogError, setRoomDialogError] = useState<string>();
  const [roomDialogBusy, setRoomDialogBusy] = useState(false);
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [inviteCopied, setInviteCopied] = useState(false);
  const userMenuHoverTimer = useRef<number | undefined>(undefined);
  const [pendingNewMessages, setPendingNewMessages] = useState(0);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const [shadowHost, setShadowHost] = useState<HTMLDivElement | null>(null);
  const [scrollContentElement, setScrollContentElement] = useState<HTMLDivElement | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string>();
  const [recallCandidateId, setRecallCandidateId] = useState<string>();
  const [shareMode, setShareMode] = useState(false);
  const [selectedMessageIds, setSelectedMessageIds] = useState<ReadonlySet<string>>(new Set());
  const [shareBusy, setShareBusy] = useState(false);
  const [shareFeedback, setShareFeedback] = useState<string>();
  const shareCardRef = useRef<HTMLDivElement>(null);
  const selectedMessages = useMemo(
    () => messages.filter((message) => selectedMessageIds.has(message.id) && !message.deletedAt),
    [messages, selectedMessageIds],
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("chat");
  const [sendShortcut, setSendShortcut] = useState<SendShortcut>(storedSendShortcut);
  const [autoSaveDraft, setAutoSaveDraft] = useState(() =>
    storedBoolean(storedAutoSaveDraftKey, true),
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
  const [membersCollapsed, setMembersCollapsed] = useState(() =>
    storedBoolean(storedMembersCollapsedKey, false),
  );
  const [messageSize, setMessageSize] = useState<MessageSize>(() =>
    storedChoice(storedMessageSizeKey, ["small", "standard", "large"], "standard"),
  );
  const [reduceMotion, setReduceMotion] = useState(() =>
    storedBoolean(storedReduceMotionKey, false),
  );
  const socketRef = useRef<WebSocket | undefined>(undefined);
  const reconnectTimerRef = useRef<number | undefined>(undefined);
  const retryRef = useRef(0);
  const latestSeqRef = useRef(0);
  const composingRef = useRef(false);
  const draftContextRef = useRef(`${username}:${initialRoomId()}`);
  const participantStatusRef = useRef(new Map<string, Participant["status"]>());
  const notificationPreferencesRef = useRef({
    messageNotifications,
    notificationSound,
    presenceNotifications,
  });
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messageScrollContentRef = useRef<HTMLDivElement>(null);
  const bottomAnimationRef = useRef(0);
  const detachAnimationCancelRef = useRef<(() => void) | undefined>(undefined);
  const messageListRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const messageCountRef = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const membersCloseRef = useRef<HTMLButtonElement>(null);
  const roomsCloseRef = useRef<HTMLButtonElement>(null);
  const agentDialogRef = useRef<HTMLDivElement>(null);
  const agentDialogCloseRef = useRef<HTMLButtonElement>(null);
  const agentDialogTriggerRef = useRef<HTMLButtonElement>(null);
  const agentStepHeadingRef = useRef<HTMLHeadingElement>(null);
  const roomDialogRef = useRef<HTMLDivElement>(null);
  const roomDialogCloseRef = useRef<HTMLButtonElement>(null);
  const roomDialogTriggerRef = useRef<HTMLButtonElement>(null);
  const settingsDialogRef = useRef<HTMLDivElement>(null);
  const settingsCloseRef = useRef<HTMLButtonElement>(null);
  const settingsTriggerRef = useRef<HTMLButtonElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const lastPanelTriggerRef = useRef<HTMLButtonElement>(null);
  const base = useMemo(serverBase, []);
  // Hive Server 就在这台电脑上时，可以直接在网页上拉起 Agent
  const local = useLocalAgents(base, agentDialogOpen);
  const localAgentNames = useMemo(
    () => new Set(local.agents.map((agent) => agent.name.toLocaleLowerCase())),
    [local.agents],
  );
  const modifierKeyLabel = useMemo(platformModifierLabel, []);
  const mentionSuggestions = useMemo(
    () =>
      mentionContext ? filterMentionParticipants(participants, mentionContext.query, username) : [],
    [mentionContext, participants, username],
  );
  const selectedAgentCommand = useMemo(() => {
    if (!meta) return "加载中…";
    return agentCommandFor(meta, agentProvider, username, agentAccess);
  }, [agentAccess, agentProvider, meta, username]);
  const showNotificationPrompt =
    messageNotifications !== "off" &&
    notificationPermission === "default" &&
    !notificationPromptDismissed;
  const currentRoom = useMemo(
    () => rooms.find((room) => room.id === currentRoomId),
    [currentRoomId, rooms],
  );
  const currentRoomName = currentRoom?.name ?? currentRoomId;
  const visibleRooms = useMemo(
    () => rooms.filter((room) => showArchivedRooms || !room.archivedAt),
    [rooms, showArchivedRooms],
  );
  const activeRoomCount = useMemo(() => rooms.filter((room) => !room.archivedAt).length, [rooms]);
  // 渲染窗口：只挂载最近的一段消息，重房间切换时的同步提交成本与内存尖峰被限定为常量；
  // 更早的消息按需点击展开（数据仍全量在 messages 中，仅渲染被窗口化）
  const [visibleLimit, setVisibleLimit] = useState(25);
  // 默认只显示当前话题（最近一条话题分隔之后）；更早的话题折叠，按需展开。
  // 展开状态绑定到分隔消息本身：开启新话题或切换房间后自动重新折叠
  const [expandedTopicId, setExpandedTopicId] = useState<string>();
  const currentTopic = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]!.kind === "topic") return { index, id: messages[index]!.id };
    }
    return undefined;
  }, [messages]);
  const earlierTopicCount =
    currentTopic && expandedTopicId !== currentTopic.id ? currentTopic.index : 0;
  const topicMessages = useMemo(
    () => (earlierTopicCount > 0 ? messages.slice(earlierTopicCount) : messages),
    [messages, earlierTopicCount],
  );
  const hiddenCount = Math.max(0, topicMessages.length - visibleLimit);
  const timeline = useMemo(
    () => buildTimeline(hiddenCount > 0 ? topicMessages.slice(-visibleLimit) : topicMessages),
    [topicMessages, visibleLimit, hiddenCount],
  );
  const invocationsByMessage = useMemo(() => groupInvocationsByMessage(invocations), [invocations]);
  // 点选提交的答案按提问归档，用来在提问上高亮所选；先到的一条生效
  const choiceAnswers = useMemo(() => {
    const answers = new Map<string, QuestionAnswer>();
    for (const message of messages) {
      if (message.answer && !message.deletedAt && !answers.has(message.answer.questionMessageId)) {
        answers.set(message.answer.questionMessageId, message.answer);
      }
    }
    return answers;
  }, [messages]);
  const pausedInvocations = useMemo(
    () => currentPausedInvocations(invocations.values(), messages),
    [invocations, messages],
  );
  const whiteboardBlockedCount = useMemo(
    () => [...whiteboard.values()].filter((entry) => entry.slot === "blocked").length,
    [whiteboard],
  );
  const pausedAgentNames = useMemo(
    () => [...new Set(pausedInvocations.map((invocation) => `@${invocation.agentName}`))],
    [pausedInvocations],
  );
  const loadedMessageIds = useMemo(
    () => new Set(messages.filter((message) => !message.deletedAt).map((message) => message.id)),
    [messages],
  );
  const formatMessageTime = useCallback(
    (iso: string) =>
      new Date(iso).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        ...(timeFormat === "system" ? {} : { hour12: timeFormat === "12h" }),
      }),
    [timeFormat],
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
    const contextKey = `${username}:${currentRoomId}`;
    if (draftContextRef.current !== contextKey) {
      draftContextRef.current = contextKey;
      setDraft(
        username && autoSaveDraft
          ? (localStorage.getItem(draftStorageKey(username, currentRoomId)) ?? "")
          : "",
      );
      setMentionContext(undefined);
    }
  }, [autoSaveDraft, currentRoomId, username]);

  useEffect(() => {
    if (!username || !autoSaveDraft || draftContextRef.current !== `${username}:${currentRoomId}`) {
      return;
    }
    const key = draftStorageKey(username, currentRoomId);
    if (draft) localStorage.setItem(key, draft);
    else localStorage.removeItem(key);
  }, [autoSaveDraft, currentRoomId, draft, username]);

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
    root.dataset.messageSize = messageSize;
    root.dataset.reduceMotion = String(reduceMotion);
  }, [interfaceDensity, messageSize, reduceMotion]);

  useEffect(() => {
    fetch(`${base}/api/meta`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`Server returned ${response.status}`);
        return (await response.json()) as MetaResponse;
      })
      .then(setMeta)
      .catch((reason: unknown) => {
        setConnectionState("offline");
        setError(
          `无法连接 Hive Server。请确认服务已启动并检查网络：${reason instanceof Error ? reason.message : String(reason)}`,
        );
      });
  }, [base]);

  // 自绘滚动动画：每帧重读底部目标位置，消息异步变高（Markdown 渲染、content-visibility
  // 惰性布局）也能追踪并精确落底；原生 scrollIntoView({behavior:"smooth"}) 的目标在调用
  // 瞬间就固定了，内容随后变高会导致停在半路
  const scrollToBottom = useCallback((animated: boolean) => {
    cancelAnimationFrame(bottomAnimationRef.current);
    bottomAnimationRef.current = 0;
    detachAnimationCancelRef.current?.();
    setShowJumpToBottom(false);
    const list = messageListRef.current;
    if (!list || typeof list.scrollTo !== "function") return;
    nearBottomRef.current = true;
    const reduceMotion = document.documentElement.dataset.reduceMotion === "true";
    if (!animated || reduceMotion) {
      list.scrollTo({ top: list.scrollHeight, behavior: "instant" });
      return;
    }
    const startY = list.scrollTop;
    const initialDistance = Math.abs(list.scrollHeight - list.clientHeight - startY);
    if (initialDistance < 2) return;
    // 时长随距离自适应：短距离（一条新消息）从容一些，长距离（刷新进入）也不至于拖沓；
    // 长距离用慢起步的 ease-in-out——起步柔和可避开首屏渲染高峰，也不会高速冲进未布局区域
    const duration = Math.min(1100, Math.max(550, 260 + initialDistance * 0.45));
    const easing = initialDistance > list.clientHeight * 1.5 ? easeInOutCubic : easeOutQuint;
    // 进度按实际播放过的帧时间累计而不是墙钟：主线程被长任务卡住后，恢复的第一帧不会把
    // 落下的进度一次补上（实测曾冻住 528ms 后一帧跳 1800px），只会让动画放慢
    const clock = createFrameClock(MAX_FRAME_STEP_MS);
    // 用户主动滚动（滚轮/触摸板/触屏）时动画立即让位：既是正确的交互，也避免动画与用户
    // 输入每帧互抢 scrollTop 引发布局风暴（实测该冲突可导致渲染进程崩溃）
    const detach = () => {
      detachAnimationCancelRef.current = undefined;
      list.removeEventListener("wheel", stopForUserInput);
      list.removeEventListener("touchstart", stopForUserInput);
    };
    const stopForUserInput = () => {
      cancelAnimationFrame(bottomAnimationRef.current);
      bottomAnimationRef.current = 0;
      detach();
      nearBottomRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
    };
    detachAnimationCancelRef.current = detach;
    list.addEventListener("wheel", stopForUserInput, { passive: true });
    list.addEventListener("touchstart", stopForUserInput, { passive: true });
    const step = (now: number) => {
      const target = list.scrollHeight - list.clientHeight;
      const progress = Math.min(1, clock(now) / duration);
      const eased = easing(progress);
      list.scrollTo({ top: startY + (target - startY) * eased, behavior: "instant" });
      if (progress < 1) {
        bottomAnimationRef.current = requestAnimationFrame(step);
      } else {
        bottomAnimationRef.current = 0;
        detach();
      }
    };
    bottomAnimationRef.current = requestAnimationFrame(step);
  }, []);

  useLayoutEffect(() => {
    const previousCount = messageCountRef.current;
    messageCountRef.current = messages.length;
    const last = messages.at(-1);
    if (!last) return;
    const own = last.senderName.toLocaleLowerCase() === username.toLocaleLowerCase();
    if (nearBottomRef.current || own) {
      setPendingNewMessages(0);
      // 首屏（刷新、切换房间）：在首帧绘制前直接定位到底部，和 Slack / ChatGPT 打开会话一样，
      // 不从顶部播动画——那段动画正好落在启动渲染高峰里，任何长任务都会让它冻住再跳。
      // 随后 Markdown 替换占位导致的高度变化由下方 ResizeObserver 继续贴底
      scrollToBottom(previousCount !== 0);
    } else if (messages.length > previousCount) {
      setPendingNewMessages((current) => current + (messages.length - previousCount));
    }
    return undefined;
  }, [messages, username, scrollToBottom]);

  const handleMessageListScroll = useCallback(() => {
    // 动画进行中的 scroll 事件是程序驱动的，不代表用户离开了底部
    if (bottomAnimationRef.current) return;
    const list = messageListRef.current;
    if (!list) return;
    const distance = list.scrollHeight - list.scrollTop - list.clientHeight;
    const nearBottom = distance < 120;
    nearBottomRef.current = nearBottom;
    if (nearBottom) setPendingNewMessages(0);
    setShowJumpToBottom(distance > 320);
  }, []);

  const jumpToLatest = useCallback(() => {
    setPendingNewMessages(0);
    scrollToBottom(true);
  }, [scrollToBottom]);

  // 消息内容异步变高（懒加载的 Markdown 渲染、图片等）时，若用户本就在底部附近则保持贴底。
  // 内容节点在 shadow root 中经 portal 挂载，比首次 commit 晚一拍，因此用 state 驱动附着时机
  useEffect(() => {
    const list = messageListRef.current;
    if (!list || !scrollContentElement || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (bottomAnimationRef.current || !nearBottomRef.current) return;
      const distance = list.scrollHeight - list.scrollTop - list.clientHeight;
      if (distance > 1) {
        list.scrollTo({ top: list.scrollHeight, behavior: "instant" });
      }
    });
    observer.observe(scrollContentElement);
    return () => observer.disconnect();
  }, [scrollContentElement]);

  useLayoutEffect(() => {
    if (textareaRef.current) resizeComposer(textareaRef.current);
    if (textareaRef.current && highlightRef.current) {
      highlightRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  }, [draft, username]);

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

  useEffect(() => {
    if (!mobilePanel) return;
    window.requestAnimationFrame(() => {
      if (mobilePanel === "members") membersCloseRef.current?.focus();
      if (mobilePanel === "rooms") roomsCloseRef.current?.focus();
    });
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMobilePanel();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [closeMobilePanel, mobilePanel]);

  const closeAgentDialog = useCallback(() => {
    setAgentDialogOpen(false);
    setFullAccessConfirmationOpen(false);
    window.requestAnimationFrame(() => agentDialogTriggerRef.current?.focus());
  }, []);

  const openAgentDialog = useCallback((trigger: HTMLButtonElement) => {
    agentDialogTriggerRef.current = trigger;
    setAgentStep(1);
    // 完全访问不跨次保留：每次打开都要重新明确选择最高权限
    setAgentAccess((current) => (current === "full" ? "read-only" : current));
    setCommandCopied(false);
    setCopyError(undefined);
    setAgentDialogOpen(true);
  }, []);

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
    window.requestAnimationFrame(() => settingsTriggerRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!userMenuOpen) return;
    const closeOnOutside = (event: MouseEvent) => {
      if (!userMenuRef.current?.contains(event.target as Node)) setUserMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setUserMenuOpen(false);
        settingsTriggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", closeOnOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [userMenuOpen]);

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

  const markRoomRead = useCallback((roomId: string) => {
    const seq = latestSeqRef.current;
    if (seq <= 0) return;
    const stored = Number(localStorage.getItem(readSeqStorageKey(roomId)) ?? "0");
    if (seq > stored) localStorage.setItem(readSeqStorageKey(roomId), String(seq));
    setReadSeqs((current) =>
      (current[roomId] ?? 0) >= seq ? current : { ...current, [roomId]: seq },
    );
  }, []);

  const upsertRoom = useCallback((room: RoomSummary) => {
    setRooms((current) =>
      sortRooms([...current.filter((existing) => existing.id !== room.id), room]),
    );
  }, []);

  const switchRoom = useCallback(
    (roomId: string) => {
      if (roomId === currentRoomId) return;
      markRoomRead(currentRoomId);
      setMessages([]);
      setMessagesLoaded(false);
      setInvocations(new Map());
      setWhiteboard(new Map());
      setHighlightedMessageId(undefined);
      setPendingJumpId(undefined);
      setParticipants([]);
      participantStatusRef.current = new Map();
      latestSeqRef.current = 0;
      retryRef.current = 0;
      messageCountRef.current = 0;
      nearBottomRef.current = true;
      setPendingNewMessages(0);
      setError(undefined);
      setMentionContext(undefined);
      setVisibleLimit(25);
      setShowJumpToBottom(false);
      setCurrentRoomId(roomId);
      closeMobilePanel(false);
    },
    [closeMobilePanel, currentRoomId, markRoomRead],
  );

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

  const refreshRooms = useCallback(async () => {
    if (!meta) return;
    const response = await fetch(`${base}/api/rooms?includeArchived=true`, {
      headers: { Authorization: `Bearer ${meta.joinToken}` },
    });
    if (!response.ok) throw new Error(`房间列表拉取失败 (${response.status})`);
    const payload = (await response.json()) as RoomsResponse;
    setRooms(sortRooms(payload.rooms));
    setReadSeqs((current) => {
      const next = { ...current };
      for (const room of payload.rooms) {
        if (next[room.id] === undefined) {
          next[room.id] = Number(localStorage.getItem(readSeqStorageKey(room.id)) ?? "0");
        }
      }
      return next;
    });
  }, [base, meta]);

  useEffect(() => {
    if (!meta || !username) return;
    void refreshRooms().catch((reason: unknown) =>
      setError(reason instanceof Error ? reason.message : String(reason)),
    );
  }, [meta, refreshRooms, username]);

  useEffect(() => {
    if (messages.length > 0) markRoomRead(currentRoomId);
  }, [currentRoomId, markRoomRead, messages]);

  const catchUp = useCallback(
    async (afterSeq: number) => {
      if (!meta || afterSeq <= 0) return;
      const response = await fetch(
        `${base}/api/rooms/${encodeURIComponent(currentRoomId)}/messages?afterSeq=${afterSeq}`,
        { headers: { Authorization: `Bearer ${meta.joinToken}` } },
      );
      if (!response.ok) throw new Error(`增量消息拉取失败 (${response.status})`);
      const payload = (await response.json()) as MessagesResponse;
      setMessages((current) => mergeMessages(current, payload.messages));
      latestSeqRef.current = Math.max(latestSeqRef.current, payload.latestSeq);
    },
    [base, currentRoomId, meta],
  );

  useEffect(() => {
    if (!meta || !username) return;
    let cancelled = false;
    let reconnectAllowed = true;

    const connect = () => {
      if (cancelled) return;
      setConnectionState("connecting");
      const socket = new WebSocket(
        resolveWebSocketUrl({
          serverBase: base,
          development: import.meta.env.DEV,
          advertisedUrl: meta.wsUrl,
        }),
      );
      socketRef.current = socket;
      socket.addEventListener("open", () => {
        socket.send(
          JSON.stringify({
            type: "participant.join",
            username,
            participantType: "human",
            roomId: currentRoomId,
            token: meta.joinToken,
          }),
        );
      });
      socket.addEventListener("message", (rawEvent) => {
        const event = JSON.parse(String(rawEvent.data)) as ServerEvent;
        if (event.type === "room.snapshot") {
          const beforeReconnect = latestSeqRef.current;
          participantStatusRef.current = new Map(
            event.participants.map((participant) => [participant.id, participant.status]),
          );
          setParticipants(event.participants);
          setMessages((current) => mergeMessages(current, event.messages));
          setMessagesLoaded(true);
          // 快照里的调用与白板是服务端当前全集，直接替换（重连期间的变化也一并对齐）
          setInvocations(
            new Map((event.invocations ?? []).map((invocation) => [invocation.id, invocation])),
          );
          setWhiteboard(new Map((event.whiteboard ?? []).map((entry) => [entry.id, entry])));
          latestSeqRef.current = Math.max(latestSeqRef.current, event.latestSeq);
          retryRef.current = 0;
          setConnectionState("online");
          setError(undefined);
          void refreshRooms().catch(() => undefined);
          globalEventsRef.current.onSnapshot();
          if (beforeReconnect > 0)
            void catchUp(beforeReconnect).catch((reason: unknown) => setError(String(reason)));
        } else if (event.type === "room.cleared") {
          if (event.message.roomId !== currentRoomId) return;
          // 房主清空了房间：本地的消息和调用记录一并丢弃，只留清空后的话题分隔
          setMessages([event.message]);
          setInvocations(new Map());
          setPendingNewMessages(0);
          setRecallCandidateId(undefined);
          latestSeqRef.current = Math.max(latestSeqRef.current, event.message.seq);
        } else if (event.type === "message.deleted") {
          if (event.message.roomId !== currentRoomId) return;
          setMessages((current) => mergeMessages(current, [event.message]));
          setRecallCandidateId((current) => (current === event.message.id ? undefined : current));
        } else if (event.type === "message.created") {
          if (event.message.roomId !== currentRoomId) return;
          setMessages((current) => mergeMessages(current, [event.message]));
          latestSeqRef.current = Math.max(latestSeqRef.current, event.message.seq);
          socket.send(JSON.stringify({ type: "message.ack", seq: event.message.seq }));
          if (event.message.senderName.toLocaleLowerCase() !== username.toLocaleLowerCase()) {
            const preferences = notificationPreferencesRef.current;
            if (preferences.notificationSound) playNotificationTone();
            const mentioned = event.message.mentions.some(
              (mention) => mention.toLocaleLowerCase() === username.toLocaleLowerCase(),
            );
            const shouldNotify =
              preferences.messageNotifications === "all" ||
              (preferences.messageNotifications === "mentions" && mentioned);
            if (shouldNotify && document.visibilityState !== "visible") {
              showBrowserNotification(
                mentioned
                  ? `${event.message.senderName} 在 AI Hive 提到了你`
                  : `${event.message.senderName} · # ${event.message.roomId}`,
                event.message.content.slice(0, 180),
              );
            }
          }
        } else if (event.type === "invocation.updated") {
          globalEventsRef.current.onInvocation(event.invocation);
          if (event.invocation.roomId !== currentRoomId) return;
          setInvocations((current) => upsertInvocation(current, event.invocation));
        } else if (event.type === "whiteboard.updated") {
          if (event.entry.roomId !== currentRoomId) return;
          setWhiteboard((current) => upsertWhiteboardEntry(current, event.entry));
        } else if (event.type === "whiteboard.removed") {
          if (event.roomId !== currentRoomId) return;
          setWhiteboard((current) => {
            if (!current.has(event.entryId)) return current;
            const next = new Map(current);
            next.delete(event.entryId);
            return next;
          });
        } else if (event.type === "presence.changed") {
          const previousStatus = participantStatusRef.current.get(event.participant.id);
          participantStatusRef.current.set(event.participant.id, event.participant.status);
          setParticipants((current) => {
            const byId = new Map(current.map((participant) => [participant.id, participant]));
            byId.set(event.participant.id, event.participant);
            return [...byId.values()];
          });
          if (
            notificationPreferencesRef.current.presenceNotifications &&
            document.visibilityState !== "visible" &&
            event.participant.type === "agent" &&
            event.participant.username.toLocaleLowerCase() !== username.toLocaleLowerCase() &&
            (event.participant.status === "offline" ||
              (event.participant.status === "online" && previousStatus === "offline"))
          ) {
            showBrowserNotification(
              `${event.participant.username} ${event.participant.status === "online" ? "已上线" : "已离线"}`,
              `#${event.participant.roomId} · ${agentProviderLabel(event.participant.provider)}`,
            );
          }
        } else if (event.type === "rooms.changed") {
          upsertRoom(event.room);
          if (event.room.id === currentRoomId && event.room.archivedAt) {
            setError(`房间 # ${event.room.name} 已被归档，已切换回默认房间。`);
            switchRoom("general");
          }
        } else if (event.type === "room.activity") {
          globalEventsRef.current.onRoomActivity();
          setRooms((current) =>
            current.map((room) =>
              room.id === event.roomId
                ? { ...room, latestSeq: event.latestSeq, onlineCount: event.onlineCount }
                : room,
            ),
          );
        } else if (event.type === "error") {
          if (event.code === "USERNAME_TAKEN") {
            reconnectAllowed = false;
            setConnectionState("offline");
            setError(
              `用户名 ${username} 已被同名 Agent 或其他身份占用，请点击右上角“退出”后更换用户名。`,
            );
            socket.close();
          } else if (event.code === "ROOM_ARCHIVED") {
            reconnectAllowed = false;
            setError(`房间 # ${currentRoomId} 已归档，无法加入，已切换回默认房间。`);
            socket.close();
            switchRoom("general");
          } else if (event.code === "FORBIDDEN") {
            setError("只能撤回自己发送的消息。");
          } else if (event.code === "MESSAGE_NOT_FOUND" || event.code === "DELETE_FAILED") {
            setError("撤回失败：消息不存在或已被处理。");
          } else if (event.code === "INVOCATION_NOT_RETRYABLE") {
            setError("这次调用当前无法重试：它可能已在进行中，或触发消息已被撤回。");
          } else if (event.code === "INVOCATION_NOT_FOUND") {
            setError("找不到这次调用，它可能属于其他房间或已被清理。");
          } else if (
            event.code === "INVALID_ANSWER" ||
            event.code === "QUESTION_CLOSED" ||
            event.code === "QUESTION_NOT_FOUND" ||
            event.code === "ANSWER_FAILED"
          ) {
            // 点选没被接受：放开选项让人重选，选择与输入保留在表单里
            setPendingAnswers(new Map());
            setError(event.message);
          } else {
            setError(event.message);
          }
        }
      });
      socket.addEventListener("close", () => {
        if (cancelled || !reconnectAllowed) return;
        setConnectionState("offline");
        const wait = Math.min(10_000, 500 * 2 ** retryRef.current++);
        reconnectTimerRef.current = window.setTimeout(connect, wait);
      });
      socket.addEventListener("error", () => socket.close());
    };

    connect();
    const heartbeat = window.setInterval(() => {
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({ type: "presence.heartbeat" }));
      }
    }, 15_000);

    return () => {
      cancelled = true;
      window.clearInterval(heartbeat);
      window.clearTimeout(reconnectTimerRef.current);
      socketRef.current?.close();
    };
  }, [base, catchUp, currentRoomId, meta, refreshRooms, switchRoom, upsertRoom, username]);

  // 点击已完成的调用跳到 Agent 回复：等目标消息挂载（可能需要先扩大渲染窗口）后再滚动并短暂高亮
  useEffect(() => {
    if (!pendingJumpId) return;
    const list = messageListRef.current;
    const root = list?.shadowRoot ?? list;
    const target = root?.querySelector<HTMLElement>(`[data-message-id="${pendingJumpId}"]`);
    if (!target) return;
    setPendingJumpId(undefined);
    cancelAnimationFrame(bottomAnimationRef.current);
    bottomAnimationRef.current = 0;
    detachAnimationCancelRef.current?.();
    nearBottomRef.current = false;
    const reduce =
      document.documentElement.dataset.reduceMotion === "true" ||
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
    setHighlightedMessageId(pendingJumpId);
    const timer = window.setTimeout(
      () => setHighlightedMessageId((current) => (current === pendingJumpId ? undefined : current)),
      2200,
    );
    return () => window.clearTimeout(timer);
  }, [pendingJumpId, timeline]);

  const authorizedJson = useCallback(
    async <T,>(path: string): Promise<T> => {
      if (!meta) throw new Error("尚未连接 Hive Server。");
      const response = await fetch(`${base}${path}`, {
        headers: { Authorization: `Bearer ${meta.joinToken}` },
      });
      if (!response.ok) throw new Error(`请求失败 (${response.status})`);
      return (await response.json()) as T;
    },
    [base, meta],
  );

  const refreshMentions = useCallback(async () => {
    if (!username) return;
    const payload = await authorizedJson<{ messages: ChatMessage[] }>(
      `/api/mentions?username=${encodeURIComponent(username)}`,
    );
    setMentionMessages(payload.messages);
  }, [authorizedJson, username]);

  const refreshTasks = useCallback(async () => {
    const payload = await authorizedJson<{
      invocations: Invocation[];
      messages: ChatMessage[];
      onlineInvocationIds?: string[];
    }>("/api/invocations");
    setOnlineInvocationIds(new Set(payload.onlineInvocationIds ?? []));
    setActiveInvocations(
      new Map(payload.invocations.map((invocation) => [invocation.id, invocation])),
    );
    setInvocationMessages(new Map(payload.messages.map((message) => [message.id, message])));
  }, [authorizedJson]);

  const searchMessages = useCallback(
    async (query: string) =>
      (
        await authorizedJson<{ messages: ChatMessage[] }>(
          `/api/search?q=${encodeURIComponent(query)}`,
        )
      ).messages,
    [authorizedJson],
  );

  // 跨房间数据随全局事件更新：调用状态直接合并，新的提及合并拉取（同一秒内多次活动只查一次）
  useEffect(() => {
    let mentionTimer: number | undefined;
    let taskTimer: number | undefined;
    const debounced = (timer: number | undefined, run: () => Promise<void>, delay: number) => {
      window.clearTimeout(timer);
      return window.setTimeout(() => void run().catch(() => undefined), delay);
    };
    globalEventsRef.current = {
      onInvocation: (invocation) => {
        setActiveInvocations((current) => {
          const next = new Map(current);
          if (isInFlight(invocation) || needsAttention(invocation))
            next.set(invocation.id, invocation);
          else next.delete(invocation.id);
          return next;
        });
        taskTimer = debounced(taskTimer, refreshTasks, 1_000);
      },
      onRoomActivity: () => {
        mentionTimer = debounced(mentionTimer, refreshMentions, 800);
      },
      onSnapshot: () => {
        void refreshMentions().catch(() => undefined);
        void refreshTasks().catch(() => undefined);
      },
    };
    return () => {
      window.clearTimeout(mentionTimer);
      window.clearTimeout(taskTimer);
    };
  }, [refreshMentions, refreshTasks]);

  const unreadMentionCount = useMemo(
    () =>
      mentionMessages.filter(
        (message) =>
          message.roomId !== currentRoomId && message.seq > (readSeqs[message.roomId] ?? 0),
      ).length,
    [currentRoomId, mentionMessages, readSeqs],
  );
  const taskCounts = useMemo(() => {
    let attention = 0;
    let inFlight = 0;
    for (const invocation of activeInvocations.values()) {
      if (needsAttention(invocation)) attention += 1;
      else if (isInFlight(invocation)) inFlight += 1;
    }
    return { attention, inFlight };
  }, [activeInvocations]);

  function openActivity(view: ActivityView, trigger?: HTMLElement | null) {
    activityTriggerRef.current = trigger ?? null;
    closeMobilePanel(false);
    setActivityView(view);
    if (view === "mentions") void refreshMentions().catch(() => undefined);
    if (view === "tasks") void refreshTasks().catch(() => undefined);
  }

  function closeActivity() {
    setActivityView(undefined);
    activityTriggerRef.current?.focus();
  }

  function markMentionsRead() {
    setReadSeqs((current) => {
      const next = { ...current };
      for (const message of mentionMessages) {
        if (message.seq > (next[message.roomId] ?? 0)) {
          next[message.roomId] = message.seq;
          localStorage.setItem(readSeqStorageKey(message.roomId), String(message.seq));
        }
      }
      return next;
    });
  }

  function openMessage(message: ChatMessage) {
    if (message.roomId === currentRoomId) {
      jumpToMessage(message.id);
      return;
    }
    setCrossRoomJumpId(message.id);
    switchRoom(message.roomId);
  }

  // 切到目标房间并拿到快照后再定位；不在最近加载的记录里时给出提示
  useEffect(() => {
    if (!crossRoomJumpId || messages.length === 0) return;
    setCrossRoomJumpId(undefined);
    if (messages.some((message) => message.id === crossRoomJumpId)) {
      jumpToMessage(crossRoomJumpId);
    } else {
      setError("这条消息较早，不在最近加载的记录里。");
    }
  }, [crossRoomJumpId, messages]);

  // ⌘K / Ctrl+K 打开搜索
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setActivityView((current) => (current === "search" ? undefined : "search"));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (!username) {
    return (
      <LoginDialog
        onJoin={(nextUsername) => {
          localStorage.setItem(storedUsernameKey, nextUsername);
          setUsername(nextUsername);
          if (messageNotifications !== "off") void ensureNotificationPermission();
        }}
      />
    );
  }

  const online = participants.filter((participant) => participant.status !== "offline");
  const offline = participants.filter((participant) => participant.status === "offline");

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

  async function updatePresenceNotifications(next: boolean) {
    const enabled = next && (await ensureNotificationPermission());
    setPresenceNotifications(enabled);
    localStorage.setItem(storedPresenceNotificationsKey, String(enabled));
  }

  const draftTooLong = draft.trim().length > MAX_MESSAGE_LENGTH;

  function sendMessage() {
    const content = draft.trim();
    const socket = socketRef.current;
    if (!content || content.length > MAX_MESSAGE_LENGTH) return;
    if (socket?.readyState !== WebSocket.OPEN) return;
    // 回答提问时带上回复关系：服务端据此把答案交回提问的 Agent，不必再 @ 它
    const replyTo = answering && answering.roomId === currentRoomId ? answering.id : undefined;
    socket.send(
      JSON.stringify({
        type: "message.send",
        clientMessageId: createClientMessageId(),
        content,
        ...(replyTo ? { replyToMessageId: replyTo } : {}),
      }),
    );
    setDraft("");
    setMentionContext(undefined);
    setAnswering(undefined);
  }

  function submitChoice(question: ChatMessage, selected: string[], other?: string) {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN || pendingAnswers.has(question.id)) return;
    const clientMessageId = createClientMessageId();
    setPendingAnswers((current) => new Map(current).set(question.id, clientMessageId));
    socket.send(
      JSON.stringify({
        type: "question.answer",
        clientMessageId,
        questionMessageId: question.id,
        selected,
        ...(other ? { other } : {}),
      }),
    );
  }

  function answerQuestion(question: ChatMessage) {
    setAnswering(question);
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function updateMentionContext(value: string, cursor: number | null) {
    const nextContext = findMentionContext(value, cursor ?? value.length);
    setMentionContext(nextContext);
    setActiveMentionIndex(0);
  }

  function chooseMention(participant: Participant) {
    if (!mentionContext) return;
    const next = applyMention(draft, mentionContext, participant.username);
    setDraft(next.value);
    setMentionContext(undefined);
    setActiveMentionIndex(0);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(next.cursor, next.cursor);
    });
  }

  function appendMention(usernameToMention: string) {
    // 已经 @ 过就不再重复追加，只把焦点放回输入框
    if (draftMentions(draft, usernameToMention)) {
      setMentionContext(undefined);
      window.requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }
    const separator = draft && !draft.endsWith(" ") ? " " : "";
    const nextValue = `${draft}${separator}@${usernameToMention} `;
    setDraft(nextValue);
    setMentionContext(undefined);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextValue.length, nextValue.length);
    });
  }

  async function copyMessageContent(message: ChatMessage) {
    try {
      await copyTextToClipboard(message.content);
      setCopiedMessageId(message.id);
      window.setTimeout(
        () => setCopiedMessageId((current) => (current === message.id ? undefined : current)),
        1500,
      );
    } catch {
      setError("浏览器未允许自动复制，请选中消息文本后手动复制。");
    }
  }

  async function copySeqReference(message: ChatMessage) {
    const key = `seq:${message.id}`;
    try {
      await copyTextToClipboard(`#${message.seq}`);
      setCopiedMessageId(key);
      window.setTimeout(
        () => setCopiedMessageId((current) => (current === key ? undefined : current)),
        1500,
      );
    } catch {
      setError("浏览器未允许自动复制，请手动输入序号。");
    }
  }

  function recallMessage(messageId: string) {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) {
      setError("当前未连接到 Hive Server，无法撤回。");
      return;
    }
    socket.send(JSON.stringify({ type: "message.delete", messageId }));
    setRecallCandidateId(undefined);
  }

  function sendClientEvent(payload: Record<string, unknown>, failure: string): void {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) {
      setError(`当前未连接到 Hive Server，${failure}`);
      return;
    }
    socket.send(JSON.stringify(payload));
  }

  function retryInvocation(invocation: Invocation) {
    sendClientEvent({ type: "invocation.retry", invocationId: invocation.id }, "无法重试。");
  }

  function cancelInvocation(invocation: Invocation) {
    sendClientEvent({ type: "invocation.cancel", invocationId: invocation.id }, "无法停止。");
  }

  function extendAgentBudget() {
    sendClientEvent({ type: "budget.extend", turns: BUDGET_EXTEND_TURNS }, "无法继续 Agent 对话。");
  }

  function removeWhiteboardEntry(entry: WhiteboardEntry) {
    sendClientEvent({ type: "whiteboard.remove", entryId: entry.id }, "无法移除白板条目。");
  }

  function jumpToMessage(messageId: string) {
    const index = messages.findIndex((message) => message.id === messageId);
    if (index < 0) return;
    if (currentTopic && index < currentTopic.index) setExpandedTopicId(currentTopic.id);
    const needed = messages.length - index;
    if (needed > visibleLimit) setVisibleLimit(needed + 10);
    setPendingJumpId(messageId);
  }

  function toggleMessageSelected(messageId: string) {
    setSelectedMessageIds((previous) => {
      const next = new Set(previous);
      if (next.has(messageId)) {
        next.delete(messageId);
      } else {
        next.add(messageId);
      }
      return next;
    });
  }

  function toggleSelectAllMessages() {
    setSelectedMessageIds((previous) =>
      previous.size === messages.length
        ? new Set()
        : new Set(messages.map((message) => message.id)),
    );
  }

  function exitShareMode() {
    setShareMode(false);
    setSelectedMessageIds(new Set());
    setShareFeedback(undefined);
  }

  async function copyShareMarkdown() {
    try {
      await copyTextToClipboard(buildShareMarkdown(selectedMessages, currentRoomName));
      setShareFeedback("Markdown 已复制到剪贴板");
    } catch {
      setShareFeedback("复制失败：剪贴板不可用");
    }
  }

  function downloadShareMarkdown() {
    downloadFile(
      shareFilename(currentRoomId, "md"),
      new Blob([buildShareMarkdown(selectedMessages, currentRoomName)], {
        type: "text/markdown;charset=utf-8",
      }),
    );
    setShareFeedback("已下载 Markdown 文件");
  }

  async function exportShareImage() {
    const node = shareCardRef.current;
    if (!node) return;
    setShareBusy(true);
    setShareFeedback(undefined);
    try {
      const { toPng } = await import("html-to-image");
      const dataUrl = await toPng(node, { pixelRatio: 2 });
      const anchor = document.createElement("a");
      anchor.href = dataUrl;
      anchor.download = shareFilename(currentRoomId, "png");
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setShareFeedback("图片已导出");
    } catch {
      setShareFeedback("图片导出失败，请重试。");
    } finally {
      setShareBusy(false);
    }
  }

  /**
   * 邀请链接直接指向当前房间的 Web UI：生产环境由 Hive Server 托管页面，用对外地址；
   * 开发环境页面由 Vite 提供，沿用当前页面地址。
   */
  function inviteLink(): string {
    const origin =
      import.meta.env.DEV || !meta?.httpUrl
        ? `${window.location.origin}${window.location.pathname}`
        : meta.httpUrl;
    return `${origin.replace(/\/$/, "")}/#${currentRoomId}`;
  }

  async function copyInviteLink() {
    const link = inviteLink();
    try {
      await copyTextToClipboard(link);
      setInviteCopied(true);
      window.setTimeout(() => setInviteCopied(false), 2000);
    } catch {
      setError(`浏览器未允许自动复制，请手动发送邀请链接：${link}`);
    }
  }

  async function copyCommand() {
    if (!meta) return;
    setCopyError(undefined);
    try {
      await copyTextToClipboard(selectedAgentCommand);
      setCommandCopied(true);
      window.setTimeout(() => setCommandCopied(false), 1500);
    } catch {
      setCommandCopied(false);
      setCopyError("浏览器未允许自动复制，请选中上方命令后手动复制。");
    }
  }

  async function roomRequest(path: string, method: string, body: unknown): Promise<RoomSummary> {
    if (!meta) throw new Error("尚未连接 Hive Server。");
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${meta.joinToken}`,
      },
      body: JSON.stringify(body),
    });
    if (response.status === 409) throw new Error("房间 ID 已存在，请换一个。");
    if (!response.ok) throw new Error(`房间操作失败 (${response.status})`);
    const payload = (await response.json()) as { room: RoomSummary };
    return payload.room;
  }

  async function submitCreateRoom() {
    const id = roomDialogId.trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      setRoomDialogError("房间 ID 只能包含字母、数字、下划线和连字符。");
      return;
    }
    setRoomDialogBusy(true);
    setRoomDialogError(undefined);
    try {
      const room = await roomRequest("/api/rooms", "POST", {
        id,
        name: roomDialogName.trim() || id,
        createdBy: username,
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

  async function submitRenameRoom(room: RoomSummary) {
    const name = roomDialogName.trim();
    if (!name) {
      setRoomDialogError("显示名称不能为空。");
      return;
    }
    setRoomDialogBusy(true);
    setRoomDialogError(undefined);
    try {
      const updated = await roomRequest(`/api/rooms/${encodeURIComponent(room.id)}`, "PATCH", {
        name,
      });
      upsertRoom(updated);
      closeRoomDialog();
    } catch (reason) {
      setRoomDialogError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRoomDialogBusy(false);
    }
  }

  function startNewTopic() {
    sendClientEvent({ type: "topic.start" }, "无法开启新话题。");
  }

  async function clearRoom(room: RoomSummary) {
    setRoomDialogBusy(true);
    setRoomDialogError(undefined);
    try {
      await local.clearRoom(room.id, username);
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

  return (
    <main className="app-shell">
      <a className="skip-link" href="#main-content">
        跳到消息区
      </a>

      {mobilePanel && (
        <button
          className="panel-scrim"
          type="button"
          aria-label="关闭侧栏"
          onClick={() => closeMobilePanel()}
        />
      )}

      <section className={`workspace ${membersCollapsed ? "members-collapsed" : ""}`}>
        <aside
          className={`rooms-panel panel ${mobilePanel === "rooms" ? "mobile-open" : ""}`}
          aria-label="房间列表"
        >
          <div className="sidebar-header">
            <div className="brand">
              <HiveLogo compact />
              <strong>AI Hive</strong>
            </div>
            <div
              className={`connection ${connectionState}`}
              role="status"
              aria-live="polite"
              title={
                connectionState === "online"
                  ? "Hive 已在线"
                  : connectionState === "connecting"
                    ? "正在连接"
                    : "连接已中断"
              }
            >
              <span aria-hidden="true" />
              <span className="connection-label">
                {connectionState === "online"
                  ? "Hive 已在线"
                  : connectionState === "connecting"
                    ? "正在连接"
                    : "连接已中断"}
              </span>
            </div>
            <button
              ref={roomsCloseRef}
              className="panel-close"
              type="button"
              aria-label="关闭房间列表"
              onClick={() => closeMobilePanel()}
            >
              <Icon name="close" />
            </button>
          </div>
          <nav className="sidebar-actions" aria-label="快捷操作">
            <button
              className="sidebar-action room-create"
              type="button"
              aria-label="新建房间"
              aria-haspopup="dialog"
              onClick={(event) => openRoomDialog({ mode: "create" }, event.currentTarget)}
            >
              <Icon name="plus" size={16} />
              <span>新建房间</span>
            </button>
            <button
              type="button"
              className={`sidebar-action ${activityView === "search" ? "active" : ""}`}
              aria-label="搜索消息"
              aria-haspopup="dialog"
              onClick={(event) => openActivity("search", event.currentTarget)}
            >
              <Icon name="search" size={16} />
              <span>搜索</span>
              <kbd className="sidebar-shortcut" aria-hidden="true">
                {modifierKeyLabel === "Cmd" ? "⌘K" : "Ctrl K"}
              </kbd>
            </button>
            <button
              type="button"
              className={`sidebar-action ${activityView === "mentions" ? "active" : ""}`}
              aria-label={
                unreadMentionCount > 0 ? `提及我，${unreadMentionCount} 条未读` : "提及我"
              }
              aria-haspopup="dialog"
              onClick={(event) => openActivity("mentions", event.currentTarget)}
            >
              <Icon name="at" size={16} />
              <span>提及我</span>
              {unreadMentionCount > 0 && (
                <span className="sidebar-badge accent" aria-hidden="true">
                  {unreadMentionCount > 99 ? "99+" : unreadMentionCount}
                </span>
              )}
            </button>
            <button
              type="button"
              className={`sidebar-action ${activityView === "tasks" ? "active" : ""}`}
              aria-label={`Agent 任务${taskCounts.inFlight ? `，${taskCounts.inFlight} 个进行中` : ""}${taskCounts.attention ? `，${taskCounts.attention} 个需要处理` : ""}`}
              aria-haspopup="dialog"
              onClick={(event) => openActivity("tasks", event.currentTarget)}
            >
              <Icon name="activity" size={16} />
              <span>Agent 任务</span>
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
          </nav>
          <div className="sidebar-section-label">
            <span>房间</span>
            <span className="panel-meta">{activeRoomCount}</span>
          </div>
          <div className="room-list">
            {visibleRooms.map((room) => (
              <div
                key={room.id}
                className={`room-item ${room.id === currentRoomId ? "active" : ""} ${room.archivedAt ? "archived" : ""}`}
              >
                <button
                  type="button"
                  className="room-item-main"
                  aria-current={room.id === currentRoomId}
                  onClick={() => switchRoom(room.id)}
                >
                  <span className="room-item-name"># {room.name}</span>
                  <span className="room-item-meta">
                    {room.archivedAt ? "已归档" : `${room.onlineCount} 在线`}
                  </span>
                  {room.id !== currentRoomId &&
                    !room.archivedAt &&
                    room.latestSeq > (readSeqs[room.id] ?? 0) && (
                      <span className="room-unread" aria-label={`# ${room.name} 有未读消息`} />
                    )}
                </button>
                <button
                  type="button"
                  className="room-item-manage"
                  aria-label={`管理房间 ${room.name}`}
                  aria-haspopup="dialog"
                  onClick={(event) => openRoomDialog({ mode: "manage", room }, event.currentTarget)}
                >
                  <Icon name="settings" size={14} />
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="room-archived-toggle"
            onClick={() => setShowArchivedRooms((current) => !current)}
          >
            {showArchivedRooms ? "隐藏已归档房间" : "显示已归档房间"}
          </button>
          <div
            className="sidebar-user"
            ref={userMenuRef}
            onMouseEnter={() => {
              // 鼠标设备悬停头像即展开菜单；触屏仍通过点击切换
              if (!window.matchMedia?.("(hover: hover)").matches) return;
              window.clearTimeout(userMenuHoverTimer.current);
              setUserMenuOpen(true);
            }}
            onMouseLeave={() => {
              if (!window.matchMedia?.("(hover: hover)").matches) return;
              window.clearTimeout(userMenuHoverTimer.current);
              userMenuHoverTimer.current = window.setTimeout(() => setUserMenuOpen(false), 180);
            }}
          >
            {userMenuOpen && (
              <div className="user-menu" role="menu" aria-label="用户菜单">
                <div className="user-menu-theme">
                  <span>主题</span>
                  <ThemeSwitcher
                    value={themePreference}
                    onChange={(value) => {
                      setThemePreference(value);
                      localStorage.setItem(storedThemeKey, value);
                    }}
                  />
                </div>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setUserMenuOpen(false);
                    setMobilePanel(undefined);
                    setSettingsOpen(true);
                  }}
                >
                  <Icon name="settings" size={15} />
                  <span>设置</span>
                </button>
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
                  <span>退出</span>
                </button>
              </div>
            )}
            <button
              ref={settingsTriggerRef}
              type="button"
              className="sidebar-user-chip"
              aria-label="用户菜单"
              aria-haspopup="menu"
              aria-expanded={userMenuOpen}
              onClick={() => setUserMenuOpen((current) => !current)}
            >
              <span className="identity-avatar" style={avatarHueStyle(username)} aria-hidden="true">
                {username.slice(0, 1).toUpperCase()}
              </span>
              <span className="identity-copy">
                <strong>{username}</strong>
                <small>当前身份</small>
              </span>
              <Icon name="more" size={16} />
            </button>
          </div>
        </aside>

        <section className="chat-panel panel" id="main-content" tabIndex={-1}>
          <header className="chat-header">
            <button
              type="button"
              className="header-button mobile-only"
              aria-label="打开房间列表"
              aria-expanded={mobilePanel === "rooms"}
              onClick={(event) => openMobilePanel("rooms", event.currentTarget)}
            >
              <Icon name="hash" size={17} />
            </button>
            <div className="chat-title">
              <h1>{currentRoomName}</h1>
              <span>
                {online.length} 位在线 · {messages.length} 条消息
              </span>
            </div>
            <div className="chat-header-actions">
              <button
                type="button"
                className="header-button new-topic"
                disabled={messages.length === 0 || messages.at(-1)?.kind === "topic"}
                title="开启新话题：房间里的 Agent 会丢弃之前的会话，从新会话开始；历史消息保留"
                onClick={startNewTopic}
              >
                <Icon name="plus" size={16} />
                <span>新话题</span>
              </button>
              <button
                type="button"
                className={`header-button share-fab ${shareMode ? "active" : ""}`}
                aria-label={shareMode ? "退出分享模式" : "分享对话"}
                aria-pressed={shareMode}
                onClick={() => (shareMode ? exitShareMode() : setShareMode(true))}
              >
                <Icon name="share" size={16} />
                <span>{shareMode ? "取消" : "分享"}</span>
              </button>
              <button
                type="button"
                className="header-button members-drawer-toggle"
                aria-label="打开成员列表"
                aria-expanded={mobilePanel === "members"}
                onClick={(event) => openMobilePanel("members", event.currentTarget)}
              >
                <Icon name="users" size={17} />
              </button>
              <button
                type="button"
                className="header-button desktop-only"
                aria-label={membersCollapsed ? "显示成员与白板" : "隐藏成员与白板"}
                aria-pressed={!membersCollapsed}
                title={membersCollapsed ? "显示成员与白板" : "隐藏成员与白板"}
                onClick={() =>
                  setMembersCollapsed((current) => {
                    localStorage.setItem(storedMembersCollapsedKey, String(!current));
                    return !current;
                  })
                }
              >
                <Icon name="panel-right" size={17} />
              </button>
            </div>
          </header>
          {(error || showNotificationPrompt || pausedInvocations.length > 0) && (
            <div className="chat-notices">
              {error && (
                <div className="error-banner" role="alert">
                  <span>{error}</span>
                  <button
                    type="button"
                    aria-label="关闭错误提示"
                    onClick={() => setError(undefined)}
                  >
                    <Icon name="close" size={16} />
                  </button>
                </div>
              )}
              {pausedInvocations.length > 0 && (
                <div
                  className="notification-prompt budget-prompt"
                  role="status"
                  aria-label="Agent 连续对话已暂停"
                >
                  <Icon name="shield" size={18} />
                  <p>
                    <strong>Agent 连续对话已暂停，等待你确认</strong>
                    {pausedAgentNames.slice(0, 3).join("、")}
                    {pausedAgentNames.length > 3 ? " 等" : ""} 的调用触及了轮数上限。
                  </p>
                  <div className="notification-prompt-actions">
                    <button type="button" className="primary" onClick={extendAgentBudget}>
                      继续 {BUDGET_EXTEND_TURNS} 轮
                    </button>
                  </div>
                </div>
              )}
              {showNotificationPrompt && (
                <div className="notification-prompt" role="status" aria-label="开启浏览器通知">
                  <Icon name="bell" size={18} />
                  <p>
                    <strong>开启浏览器通知</strong>
                    页面不在前台时，有人 @ 你会收到系统提醒。
                  </p>
                  <div className="notification-prompt-actions">
                    <button type="button" onClick={dismissNotificationPrompt}>
                      暂不
                    </button>
                    <button
                      type="button"
                      className="primary"
                      onClick={() => void ensureNotificationPermission()}
                    >
                      开启
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          <div
            ref={(element) => {
              messageListRef.current = element;
              setShadowHost((current) => (current === element ? current : element));
            }}
            className="message-list"
            role="log"
            aria-label="聊天室消息"
            aria-live="polite"
            onScroll={handleMessageListScroll}
          >
            <ShadowContent host={shadowHost}>
              <div className="message-shadow-inner">
                {messagesLoaded && messages.length === 0 && (
                  <div className="empty-state">
                    <HiveLogo />
                    <h2>今天在 #{currentRoomName} 协作什么？</h2>
                    <p>
                      发出第一条消息，或输入 <code>@agent-name</code> 邀请一个 Agent 参与。
                    </p>
                    <button type="button" onClick={() => textareaRef.current?.focus()}>
                      开始一条消息
                      <Icon name="arrow-right" size={16} />
                    </button>
                  </div>
                )}
                <div
                  className="message-scroll-content"
                  ref={(element) => {
                    messageScrollContentRef.current = element;
                    setScrollContentElement((current) => (current === element ? current : element));
                  }}
                >
                  {hiddenCount > 0 ? (
                    <button
                      type="button"
                      className="load-earlier"
                      onClick={() => setVisibleLimit((current) => current + 100)}
                    >
                      显示更早的 {Math.min(hiddenCount, 100)} 条消息（共隐藏 {hiddenCount} 条）
                    </button>
                  ) : (
                    earlierTopicCount > 0 &&
                    currentTopic && (
                      <button
                        type="button"
                        className="load-earlier"
                        onClick={() => setExpandedTopicId(currentTopic.id)}
                      >
                        显示更早的话题（{earlierTopicCount} 条消息）
                      </button>
                    )
                  )}
                  {timeline.map(({ message, newDay, grouped }) => (
                    <Fragment key={message.id}>
                      {newDay && (
                        <div className="date-divider" role="separator">
                          <span>{dateDividerLabel(message.createdAt)}</span>
                        </div>
                      )}
                      {message.kind === "topic" ? (
                        <div
                          className="topic-divider"
                          role="separator"
                          data-message-id={message.id}
                        >
                          <span>
                            {message.content} · {formatMessageTime(message.createdAt)}
                          </span>
                          <small>之前的消息不再作为 Agent 的上下文</small>
                        </div>
                      ) : (
                        <article
                          className={`message ${message.senderType} ${
                            message.senderType === "human" &&
                            message.senderName.toLocaleLowerCase() === username.toLocaleLowerCase()
                              ? "own"
                              : ""
                          } ${grouped ? "grouped" : ""} ${
                            shareMode && !message.deletedAt ? "selectable" : ""
                          } ${selectedMessageIds.has(message.id) ? "selected" : ""} ${
                            message.deletedAt ? "deleted" : ""
                          } ${highlightedMessageId === message.id ? "highlighted" : ""} ${
                            message.kind === "question" ? "question" : ""
                          }`}
                          data-message-id={message.id}
                          style={
                            message.senderType === "human"
                              ? avatarHueStyle(message.senderName)
                              : undefined
                          }
                          onClick={
                            shareMode && !message.deletedAt
                              ? () => toggleMessageSelected(message.id)
                              : undefined
                          }
                        >
                          {grouped ? (
                            <span className="hover-time" aria-hidden="true">
                              {formatMessageTime(message.createdAt)}
                            </span>
                          ) : (
                            <span className={`avatar ${message.senderType}`} aria-hidden="true">
                              <AvatarGlyph
                                type={message.senderType}
                                name={message.senderName}
                                provider={agentProviderByName.get(
                                  message.senderName.toLocaleLowerCase(),
                                )}
                              />
                            </span>
                          )}
                          <div className="message-content">
                            {!grouped && (
                              <header>
                                <strong>{message.senderName}</strong>
                                {message.senderType === "agent" && <b>Agent</b>}
                                <time dateTime={message.createdAt}>
                                  {formatMessageTime(message.createdAt)}
                                </time>
                                <button
                                  type="button"
                                  className="message-seq"
                                  title="复制序号引用（可用于在聊天中引用这条消息）"
                                  aria-label={`复制消息序号 #${message.seq}`}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    void copySeqReference(message);
                                  }}
                                >
                                  {copiedMessageId === `seq:${message.id}`
                                    ? "已复制"
                                    : `#${message.seq}`}
                                </button>
                              </header>
                            )}
                            {message.deletedAt ? (
                              <p className="message-recalled">
                                {message.senderName.toLocaleLowerCase() ===
                                username.toLocaleLowerCase()
                                  ? "你撤回了一条消息"
                                  : `${message.senderName} 撤回了一条消息`}
                              </p>
                            ) : (
                              <div className="message-body">
                                <CollapsibleMessage
                                  content={message.content}
                                  forceExpanded={shareMode}
                                >
                                  <Suspense
                                    fallback={
                                      <p className="message-body-fallback">{message.content}</p>
                                    }
                                  >
                                    <MessageMarkdown content={message.content} />
                                  </Suspense>
                                </CollapsibleMessage>
                              </div>
                            )}
                            {message.question && !message.deletedAt && (
                              <QuestionOptions
                                spec={message.question}
                                waiting={Boolean(
                                  waitingInvocationForQuestion(message, invocations.values()),
                                )}
                                pending={
                                  pendingAnswers.has(message.id) && !choiceAnswers.has(message.id)
                                }
                                {...(choiceAnswers.get(message.id)
                                  ? { answer: choiceAnswers.get(message.id)! }
                                  : {})}
                                onSubmit={(selected, other) =>
                                  submitChoice(message, selected, other)
                                }
                              />
                            )}
                            {!shareMode &&
                              !message.question &&
                              waitingInvocationForQuestion(message, invocations.values()) && (
                                <button
                                  type="button"
                                  className="question-answer"
                                  aria-label={`回答 ${message.senderName} 的提问`}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    answerQuestion(message);
                                  }}
                                >
                                  {answering?.id === message.id ? "正在回答…" : "回答"}
                                </button>
                              )}
                            {invocationsByMessage.has(message.id) && (
                              <InvocationChips
                                connectionState={connectionState}
                                invocations={invocationsByMessage.get(message.id) ?? []}
                                allInvocations={invocations}
                                participants={participants}
                                canJumpTo={(messageId) => loadedMessageIds.has(messageId)}
                                onJump={jumpToMessage}
                                onRetry={retryInvocation}
                                onCancel={cancelInvocation}
                                onExtend={extendAgentBudget}
                              />
                            )}
                          </div>
                          {message.deletedAt ? null : shareMode ? (
                            <span
                              className={`select-indicator ${
                                selectedMessageIds.has(message.id) ? "on" : ""
                              }`}
                              role="checkbox"
                              aria-checked={selectedMessageIds.has(message.id)}
                              aria-label={`选择 ${message.senderName} 的消息`}
                            >
                              {selectedMessageIds.has(message.id) && (
                                <Icon name="check" size={12} />
                              )}
                            </span>
                          ) : (
                            <div className="message-actions">
                              {grouped && (
                                <button
                                  type="button"
                                  className="message-action seq"
                                  title="复制序号引用"
                                  aria-label={`复制消息序号 #${message.seq}`}
                                  onClick={() => void copySeqReference(message)}
                                >
                                  {copiedMessageId === `seq:${message.id}`
                                    ? "✓"
                                    : `#${message.seq}`}
                                </button>
                              )}
                              <button
                                type="button"
                                className="message-action"
                                aria-label="复制消息原文"
                                title="复制消息"
                                onClick={() => void copyMessageContent(message)}
                              >
                                <Icon
                                  name={copiedMessageId === message.id ? "check" : "copy"}
                                  size={13}
                                />
                              </button>
                              {message.senderName.toLocaleLowerCase() !==
                              username.toLocaleLowerCase() ? (
                                <button
                                  type="button"
                                  className="message-action"
                                  aria-label={`在输入框中提及 ${message.senderName}`}
                                  title={`@${message.senderName}`}
                                  onClick={() => appendMention(message.senderName)}
                                >
                                  @
                                </button>
                              ) : recallCandidateId === message.id ? (
                                <span
                                  className="message-recall-confirm"
                                  role="group"
                                  aria-label="确认撤回"
                                >
                                  <span>撤回这条消息？</span>
                                  <button
                                    type="button"
                                    onClick={() => setRecallCandidateId(undefined)}
                                  >
                                    取消
                                  </button>
                                  <button
                                    type="button"
                                    className="danger"
                                    onClick={() => recallMessage(message.id)}
                                  >
                                    撤回
                                  </button>
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  className="message-action danger"
                                  aria-label="撤回这条消息"
                                  title="撤回"
                                  onClick={() => setRecallCandidateId(message.id)}
                                >
                                  <Icon name="undo" size={13} />
                                </button>
                              )}
                            </div>
                          )}
                        </article>
                      )}
                    </Fragment>
                  ))}
                  {participants.some((participant) => participant.status === "busy") && (
                    <div className="typing" role="status" aria-live="polite">
                      <span aria-hidden="true" />
                      <span aria-hidden="true" />
                      <span aria-hidden="true" />{" "}
                      {participants
                        .filter((participant) => participant.status === "busy")
                        .map((participant) => participant.username)
                        .join(", ")}{" "}
                      正在思考
                    </div>
                  )}
                  <div ref={messagesEndRef} />
                </div>
              </div>
            </ShadowContent>
          </div>
          {shareMode && (
            <div className="share-bar" role="toolbar" aria-label="分享选中的消息">
              <span className="share-count" role="status">
                已选 {selectedMessages.length} 条
              </span>
              <button type="button" onClick={toggleSelectAllMessages}>
                {messages.length > 0 && selectedMessageIds.size === messages.length
                  ? "清空"
                  : "全选"}
              </button>
              <button
                type="button"
                disabled={selectedMessages.length === 0 || shareBusy}
                onClick={() => void copyShareMarkdown()}
              >
                复制 Markdown
              </button>
              <button
                type="button"
                disabled={selectedMessages.length === 0 || shareBusy}
                onClick={downloadShareMarkdown}
              >
                下载 .md
              </button>
              <button
                type="button"
                disabled={selectedMessages.length === 0 || shareBusy}
                onClick={() => void exportShareImage()}
              >
                {shareBusy ? "导出中…" : "导出图片"}
              </button>
              {shareFeedback && (
                <span className="share-feedback" role="status">
                  {shareFeedback}
                </span>
              )}
              <button type="button" className="share-exit" onClick={exitShareMode}>
                退出
              </button>
            </div>
          )}
          {shareMode && selectedMessages.length > 0 && (
            <div className="share-card-stage" aria-hidden="true">
              <div ref={shareCardRef} className="share-card">
                <header className="share-card-header">
                  <strong># {currentRoomName}</strong>
                  <span>AI HIVE · 对话分享</span>
                </header>
                {selectedMessages.map((message) => (
                  <div
                    key={message.id}
                    className={`share-card-message ${message.senderType}`}
                    style={
                      message.senderType === "human"
                        ? avatarHueStyle(message.senderName)
                        : undefined
                    }
                  >
                    <span className={`share-card-avatar ${message.senderType}`}>
                      <AvatarGlyph
                        type={message.senderType}
                        name={message.senderName}
                        provider={agentProviderByName.get(message.senderName.toLocaleLowerCase())}
                      />
                    </span>
                    <div className="share-card-body">
                      <header>
                        <strong>{message.senderName}</strong>
                        {message.senderType === "agent" && <b>Agent</b>}
                        <time dateTime={message.createdAt}>
                          {formatShareTimestamp(message.createdAt)}
                        </time>
                        <span className="share-card-seq">#{message.seq}</span>
                      </header>
                      <div className="message-body">
                        <Suspense
                          fallback={<p className="message-body-fallback">{message.content}</p>}
                        >
                          <MessageMarkdown content={message.content} />
                        </Suspense>
                      </div>
                    </div>
                  </div>
                ))}
                <footer className="share-card-footer">
                  <span>导出于 {formatShareTimestamp(new Date().toISOString())}</span>
                  <span>AI Hive</span>
                </footer>
              </div>
            </div>
          )}
          <div className="composer">
            {showJumpToBottom && !mentionContext && (
              <button
                type="button"
                className="jump-to-bottom"
                aria-label="滚动到底部"
                title="回到最新消息"
                onClick={jumpToLatest}
              >
                <Icon name="arrow-down" size={16} />
              </button>
            )}
            {pendingNewMessages > 0 && !mentionContext && (
              <button type="button" className="jump-pill" onClick={jumpToLatest}>
                ↓ {pendingNewMessages} 条新消息
              </button>
            )}
            {mentionContext && (
              <div className="mention-menu" id="mention-suggestions" role="listbox">
                <div className="mention-menu-heading">
                  <span>提及成员</span>
                  <small>{mentionSuggestions.length} 个匹配</small>
                </div>
                {mentionSuggestions.length > 0 ? (
                  <div className="mention-options">
                    {mentionSuggestions.map((participant, index) => (
                      <button
                        type="button"
                        role="option"
                        aria-selected={index === activeMentionIndex}
                        id={`mention-option-${participant.id}`}
                        className={`mention-option ${index === activeMentionIndex ? "active" : ""}`}
                        key={participant.id}
                        onMouseEnter={() => setActiveMentionIndex(index)}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => chooseMention(participant)}
                      >
                        <span
                          className={`mention-avatar ${participant.type}`}
                          style={
                            participant.type === "human"
                              ? avatarHueStyle(participant.username)
                              : undefined
                          }
                          aria-hidden="true"
                        >
                          <AvatarGlyph
                            type={participant.type}
                            name={participant.username}
                            provider={participant.provider}
                          />
                        </span>
                        <span className="mention-member-copy">
                          <strong>@{participant.username}</strong>
                          <small>
                            {participant.type === "agent" ? "Agent" : "用户"} ·{" "}
                            {participantStatusLabel(participant.status)}
                          </small>
                        </span>
                        <span
                          className={`status-dot ${participant.status}`}
                          aria-label={participantStatusLabel(participant.status)}
                        />
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="mention-empty">没有找到匹配的成员</div>
                )}
                <div className="mention-menu-footer">
                  <span>
                    <kbd>↑↓</kbd> 选择
                  </span>
                  <span>
                    <kbd>Enter</kbd> 或 <kbd>Tab</kbd> 补全
                  </span>
                  <span>
                    <kbd>Esc</kbd> 关闭
                  </span>
                </div>
              </div>
            )}
            {answering && answering.roomId === currentRoomId && (
              <div className="composer-answering" role="status">
                <strong>回答 @{answering.senderName} 的提问</strong>
                <span>{answering.content.replace(/\s+/g, " ")}</span>
                <button
                  type="button"
                  aria-label="取消回答"
                  title="取消回答，改为普通消息"
                  onClick={() => setAnswering(undefined)}
                >
                  ×
                </button>
              </div>
            )}
            <div className="composer-box">
              <div className="composer-input">
                <div className="composer-highlight" ref={highlightRef} aria-hidden="true">
                  {splitDraftMentions(draft).map((segment, index) =>
                    segment.mention ? <mark key={index}>{segment.text}</mark> : segment.text,
                  )}
                  {/* 末尾换行需要占位，否则高亮层比输入框少一行 */}
                  {"\u200b"}
                </div>
                <textarea
                  ref={textareaRef}
                  rows={1}
                  value={draft}
                  onScroll={(event) => {
                    if (highlightRef.current) {
                      highlightRef.current.scrollTop = event.currentTarget.scrollTop;
                    }
                  }}
                  onChange={(event) => {
                    setDraft(event.target.value);
                    if (!composingRef.current) {
                      updateMentionContext(event.target.value, event.target.selectionStart);
                    }
                  }}
                  onCompositionStart={() => {
                    composingRef.current = true;
                  }}
                  onCompositionEnd={(event) => {
                    composingRef.current = false;
                    updateMentionContext(
                      event.currentTarget.value,
                      event.currentTarget.selectionStart,
                    );
                  }}
                  onSelect={(event) => {
                    if (!composingRef.current) {
                      updateMentionContext(
                        event.currentTarget.value,
                        event.currentTarget.selectionStart,
                      );
                    }
                  }}
                  onKeyDown={(event) => {
                    if (
                      composingRef.current ||
                      event.nativeEvent.isComposing ||
                      event.nativeEvent.keyCode === 229
                    ) {
                      return;
                    }
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      (event.metaKey || event.ctrlKey)
                    ) {
                      event.preventDefault();
                      sendMessage();
                      return;
                    }
                    if (mentionContext && event.key === "ArrowDown") {
                      event.preventDefault();
                      setActiveMentionIndex((index) =>
                        mentionSuggestions.length ? (index + 1) % mentionSuggestions.length : 0,
                      );
                      return;
                    }
                    if (mentionContext && event.key === "ArrowUp") {
                      event.preventDefault();
                      setActiveMentionIndex((index) =>
                        mentionSuggestions.length
                          ? (index - 1 + mentionSuggestions.length) % mentionSuggestions.length
                          : 0,
                      );
                      return;
                    }
                    if (mentionContext && event.key === "Escape") {
                      event.preventDefault();
                      setMentionContext(undefined);
                      return;
                    }
                    if (
                      mentionContext &&
                      mentionSuggestions[activeMentionIndex] &&
                      (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey))
                    ) {
                      event.preventDefault();
                      chooseMention(mentionSuggestions[activeMentionIndex]);
                      return;
                    }
                    if (sendShortcut === "enter" && event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      sendMessage();
                    }
                  }}
                  placeholder="发送消息，输入 @ 选择成员…"
                  aria-label="消息"
                  aria-autocomplete="list"
                  aria-controls={mentionContext ? "mention-suggestions" : undefined}
                  aria-expanded={Boolean(mentionContext)}
                  aria-activedescendant={
                    mentionContext && mentionSuggestions[activeMentionIndex]
                      ? `mention-option-${mentionSuggestions[activeMentionIndex].id}`
                      : undefined
                  }
                />
              </div>
              <div className="composer-footer">
                <span>
                  {sendShortcut === "modifier-enter" ? (
                    <>
                      <kbd>{modifierKeyLabel} + Enter</kbd> 发送 · <kbd>Enter</kbd> 换行
                    </>
                  ) : (
                    <>
                      <kbd>Enter</kbd> 发送 · <kbd>Shift + Enter</kbd> 换行
                    </>
                  )}
                </span>
                <div className="composer-actions">
                  {draftTooLong ? (
                    <span className="char-count danger" role="alert">
                      超出 {(draft.trim().length - MAX_MESSAGE_LENGTH).toLocaleString()}{" "}
                      字，无法发送
                    </span>
                  ) : (
                    draft.length > MAX_MESSAGE_LENGTH * MESSAGE_LENGTH_WARNING_RATIO && (
                      <span className="char-count">
                        {draft.length.toLocaleString()}/{MAX_MESSAGE_LENGTH.toLocaleString()}
                      </span>
                    )
                  )}
                  <button
                    type="button"
                    className="composer-send"
                    onClick={sendMessage}
                    disabled={!draft.trim() || draftTooLong || connectionState !== "online"}
                    title="发送"
                  >
                    <span className="sr-only">发送</span>
                    <Icon name="arrow-up" size={18} />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>

        <aside
          className={`members-panel panel ${mobilePanel === "members" ? "mobile-open" : ""}`}
          aria-label="成员列表"
        >
          <div className="panel-heading side-panel-heading">
            <div
              className="side-tabs"
              role="tablist"
              aria-label="侧栏视图"
              onKeyDown={(event) => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                const next: SidePanelTab =
                  event.key === "Home"
                    ? "members"
                    : event.key === "End"
                      ? "whiteboard"
                      : sidePanelTab === "members"
                        ? "whiteboard"
                        : "members";
                setSidePanelTab(next);
                event.currentTarget.querySelector<HTMLButtonElement>(`#side-tab-${next}`)?.focus();
              }}
            >
              <button
                type="button"
                role="tab"
                id="side-tab-members"
                aria-selected={sidePanelTab === "members"}
                aria-controls="side-panel-members"
                tabIndex={sidePanelTab === "members" ? 0 : -1}
                className={sidePanelTab === "members" ? "active" : ""}
                onClick={() => setSidePanelTab("members")}
              >
                <Icon name="users" size={15} />
                成员
                <span className="side-tab-count" aria-label={`${online.length} 位在线`}>
                  {online.length}
                </span>
              </button>
              <button
                type="button"
                role="tab"
                id="side-tab-whiteboard"
                aria-selected={sidePanelTab === "whiteboard"}
                aria-controls="side-panel-whiteboard"
                tabIndex={sidePanelTab === "whiteboard" ? 0 : -1}
                className={sidePanelTab === "whiteboard" ? "active" : ""}
                onClick={() => setSidePanelTab("whiteboard")}
              >
                <Icon name="board" size={15} />
                白板
                {whiteboard.size > 0 && (
                  <span
                    className={`side-tab-count ${whiteboardBlockedCount > 0 ? "warning" : ""}`}
                    aria-label={
                      whiteboardBlockedCount > 0
                        ? `${whiteboard.size} 条，其中 ${whiteboardBlockedCount} 条阻塞`
                        : `${whiteboard.size} 条`
                    }
                  >
                    {whiteboard.size}
                  </span>
                )}
              </button>
            </div>
            <button
              ref={membersCloseRef}
              className="panel-close"
              type="button"
              aria-label="关闭成员列表"
              onClick={() => closeMobilePanel()}
            >
              <Icon name="close" />
            </button>
          </div>
          {sidePanelTab === "whiteboard" ? (
            <div
              className="whiteboard-scroll"
              role="tabpanel"
              id="side-panel-whiteboard"
              aria-labelledby="side-tab-whiteboard"
              tabIndex={0}
            >
              <WhiteboardPanel entries={whiteboard} onRemove={removeWhiteboardEntry} />
            </div>
          ) : (
            <>
              <div
                className="member-list"
                role="tabpanel"
                id="side-panel-members"
                aria-labelledby="side-tab-members"
              >
                {online.map((participant) => (
                  <button
                    type="button"
                    key={participant.id}
                    className="member"
                    onClick={() => {
                      closeMobilePanel(false);
                      appendMention(participant.username);
                    }}
                  >
                    <span
                      className={`avatar ${participant.type}`}
                      style={
                        participant.type === "human"
                          ? avatarHueStyle(participant.username)
                          : undefined
                      }
                      aria-hidden="true"
                    >
                      <AvatarGlyph
                        type={participant.type}
                        name={participant.username}
                        provider={participant.provider}
                      />
                    </span>
                    <span className="member-copy">
                      <strong>
                        {participant.username}
                        {participant.type === "agent" &&
                          localAgentNames.has(participant.username.toLocaleLowerCase()) && (
                            <span className="member-local-badge" title="由本机 Hive Server 启动">
                              本机
                            </span>
                          )}
                      </strong>
                      <small>
                        {participant.type === "agent"
                          ? `${agentProviderLabel(participant.provider)} · ${participant.persona || "通用协作 Agent"}`
                          : "Human"}
                      </small>
                    </span>
                    <span
                      className={`status-dot ${participant.status}`}
                      title={participantStatusLabel(participant.status)}
                      aria-label={participantStatusLabel(participant.status)}
                    />
                  </button>
                ))}
                {offline.length > 0 && <p className="offline-label">离线 · {offline.length}</p>}
                {offline.map((participant) => (
                  <div key={participant.id} className="member muted">
                    <span
                      className={`avatar ${participant.type}`}
                      style={
                        participant.type === "human"
                          ? avatarHueStyle(participant.username)
                          : undefined
                      }
                      aria-hidden="true"
                    >
                      <AvatarGlyph
                        type={participant.type}
                        name={participant.username}
                        provider={participant.provider}
                      />
                    </span>
                    <span className="member-copy">
                      <strong>{participant.username}</strong>
                      <small>
                        {participant.type === "agent"
                          ? `${agentProviderLabel(participant.provider)} · 离线`
                          : "Human · 离线"}
                      </small>
                    </span>
                    <span className="status-dot offline" aria-label="离线" />
                  </div>
                ))}
              </div>
              <div className="member-invite" role="group" aria-label="添加成员">
                <button
                  type="button"
                  className="member-invite-action"
                  onClick={() => void copyInviteLink()}
                >
                  <Icon name={inviteCopied ? "check" : "user-plus"} size={16} />
                  <span>
                    <strong>{inviteCopied ? "已复制邀请链接" : "邀请成员"}</strong>
                    <small>复制本房间链接，发给同事即可加入</small>
                  </span>
                </button>
                <button
                  type="button"
                  className="member-invite-action sidebar-agent-entry"
                  aria-label="接入 Agent"
                  aria-haspopup="dialog"
                  aria-expanded={agentDialogOpen}
                  onClick={(event) => openAgentDialog(event.currentTarget)}
                >
                  <Icon name="plug" size={16} />
                  <span>
                    <strong>接入 Agent</strong>
                    <small>选择运行时并复制接入命令</small>
                  </span>
                </button>
              </div>
            </>
          )}
        </aside>
      </section>

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
          onMarkMentionsRead={markMentionsRead}
          onClose={closeActivity}
        />
      )}

      {agentDialogOpen && (
        <div className="agent-dialog-layer">
          <button
            className="agent-dialog-scrim"
            type="button"
            aria-label="关闭 Agent 接入弹窗"
            onClick={closeAgentDialog}
          />
          <div
            ref={agentDialogRef}
            className="agent-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="agent-dialog-title"
            aria-describedby="agent-dialog-description"
          >
            <header className="agent-dialog-header">
              <div>
                <h2 id="agent-dialog-title">把 Agent 接入 Hive</h2>
                <p id="agent-dialog-description">
                  {local.enabled
                    ? "三步完成：选择 Agent、设置本机权限，然后一键在本机启动（也可以复制命令）。"
                    : "三步完成：选择 Agent、设置本机权限，然后把命令复制到终端运行。"}
                </p>
              </div>
              <button
                ref={agentDialogCloseRef}
                className="agent-dialog-close"
                type="button"
                aria-label="关闭"
                onClick={closeAgentDialog}
              >
                <Icon name="close" />
              </button>
            </header>

            <ol className="agent-steps" aria-label="接入步骤">
              {agentSetupSteps.map(({ step, label: baseLabel }) => {
                const label = step === 3 && local.enabled ? "启动 Agent" : baseLabel;
                const state =
                  step === agentStep ? "current" : step < agentStep ? "done" : "upcoming";
                return (
                  <li
                    key={step}
                    className={state}
                    aria-current={state === "current" ? "step" : undefined}
                  >
                    {state === "done" ? (
                      <button
                        type="button"
                        aria-label={`返回第 ${step} 步：${label}`}
                        onClick={() => goToAgentStep(step)}
                      >
                        <span className="agent-step-index" aria-hidden="true">
                          <Icon name="check" size={12} />
                        </span>
                        <span>{label}</span>
                      </button>
                    ) : (
                      <span>
                        <span className="agent-step-index" aria-hidden="true">
                          {step}
                        </span>
                        <span>{label}</span>
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>

            <div className="agent-dialog-body">
              <div className="agent-step-heading">
                <h3 id="agent-step-title" ref={agentStepHeadingRef} tabIndex={-1}>
                  {agentStep === 1
                    ? "选择要接入的 Agent"
                    : agentStep === 2
                      ? `允许 ${agentProviderLabel(agentProvider)} 在本机做什么？`
                      : local.enabled
                        ? "在本机启动"
                        : "复制命令，到终端运行"}
                </h3>
                {agentStep === 1 && <p>接入命令会根据所选 Agent 的运行环境自动调整。</p>}
                {agentStep === 2 && (
                  <p>权限只在 Agent 所在电脑生效，Hive Server 始终只转发消息。默认只读。</p>
                )}
                {agentStep === 3 && (
                  <p>
                    将以 <code>{agentNameFor(username, agentProvider)}</code> 身份加入 · 权限：
                    <strong className={`agent-access-label ${agentAccess}`}>
                      {agentAccessOptions.find((option) => option.id === agentAccess)?.label}
                    </strong>
                  </p>
                )}
              </div>

              {agentStep === 1 && <LocalAgentList local={local} />}

              {agentStep === 1 && (
                <div
                  className="provider-selector"
                  role="radiogroup"
                  aria-labelledby="agent-step-title"
                  onKeyDown={(event) =>
                    moveRadioSelection(
                      event,
                      selectableAgentProviders.indexOf(agentProvider),
                      (index) => setAgentProvider(selectableAgentProviders[index]!),
                    )
                  }
                >
                  {selectableAgentProviders.map((provider) => (
                    <button
                      type="button"
                      role="radio"
                      aria-checked={agentProvider === provider}
                      tabIndex={agentProvider === provider ? 0 : -1}
                      className={[
                        agentProvider === provider ? "active" : "",
                        providerInfo(local, provider)?.installed === false ? "unavailable" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      onClick={() => setAgentProvider(provider)}
                      key={provider}
                    >
                      <span className="provider-monogram" aria-hidden="true">
                        <ProviderLogo provider={provider} />
                      </span>
                      <span className="provider-copy">
                        <strong>{agentProviderLabel(provider)}</strong>
                        <small>
                          {(() => {
                            const info = providerInfo(local, provider);
                            if (!info) return agentProviderDescriptions[provider];
                            return info.installed
                              ? `${agentProviderDescriptions[provider]}${info.version ? ` · ${info.version}` : ""}`
                              : "本机未安装";
                          })()}
                        </small>
                      </span>
                      <span className="provider-check" aria-hidden="true">
                        <Icon name="check" size={15} />
                      </span>
                    </button>
                  ))}
                </div>
              )}

              {agentStep === 2 && (
                <>
                  <div
                    className="access-selector"
                    role="radiogroup"
                    aria-labelledby="agent-step-title"
                    onKeyDown={(event) =>
                      moveRadioSelection(
                        event,
                        agentAccessOptions.findIndex((option) => option.id === agentAccess),
                        (index) => chooseAgentAccess(agentAccessOptions[index]!.id),
                      )
                    }
                  >
                    {agentAccessOptions.map((option) => (
                      <button
                        type="button"
                        role="radio"
                        aria-checked={agentAccess === option.id}
                        aria-expanded={
                          option.id === "full" ? fullAccessConfirmationOpen : undefined
                        }
                        tabIndex={agentAccess === option.id ? 0 : -1}
                        className={`${option.id} ${agentAccess === option.id ? "active" : ""}`}
                        onClick={() => chooseAgentAccess(option.id)}
                        key={option.id}
                      >
                        <span className="access-indicator" aria-hidden="true">
                          <i />
                        </span>
                        <strong>{option.label}</strong>
                        <small>{option.description}</small>
                      </button>
                    ))}
                  </div>
                  {agentProvider === "openclaw" && (
                    <p className="openclaw-access-note">
                      OpenClaw 的实际权限还需在其 Agent / Gateway 中设置；Hive
                      不会自动改写全局策略。
                    </p>
                  )}
                  {agentProvider === "omp" && agentAccess === "workspace" && (
                    <p className="openclaw-access-note">
                      omp 不会把文件写入限制在当前目录内；需要目录隔离时请选择 OpenCode、Codex 或
                      Claude Code。
                    </p>
                  )}
                  {fullAccessConfirmationOpen && agentAccess !== "full" && (
                    <div className="full-access-confirmation" role="alert">
                      <div>
                        <strong>确认移除本机安全边界？</strong>
                        <p>
                          {agentProviderLabel(agentProvider)}{" "}
                          将可以执行当前系统用户有权进行的操作；房间消息可能触发文件、命令或网络操作。
                        </p>
                      </div>
                      <div className="full-access-actions">
                        <button type="button" onClick={() => setFullAccessConfirmationOpen(false)}>
                          取消
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setAgentAccess("full");
                            setFullAccessConfirmationOpen(false);
                          }}
                        >
                          我了解风险，开启完全访问
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}

              {agentStep === 3 &&
                (() => {
                  // 复制命令这一整段：本机模式下折叠为"或复制命令"，否则直接展示
                  const commandSection = (
                    <>
                      <div className="command">
                        <div className="command-heading">
                          <span className="terminal-dots" aria-hidden="true">
                            <i />
                            <i />
                            <i />
                          </span>
                          <small>终端</small>
                        </div>
                        <code>{selectedAgentCommand}</code>
                        <button type="button" disabled={!meta} onClick={() => void copyCommand()}>
                          <Icon name={commandCopied ? "check" : "copy"} size={16} />
                          <span>{commandCopied ? "已复制到剪贴板" : "复制命令"}</span>
                        </button>
                      </div>
                      {copyError && (
                        <p className="command-copy-error" role="alert">
                          {copyError}
                        </p>
                      )}
                      {meta && !meta.agentCommand.startsWith("npx") && (
                        <p className="command-dev-note">
                          开发模式命令：请在 ai-hive 仓库根目录的终端运行，使用的是当前仓库代码，
                          而非已发布的 npm 包。
                        </p>
                      )}
                      <ol className="agent-next-steps" aria-label="接入后的操作">
                        <li>
                          在 {agentProviderLabel(agentProvider)} 所在电脑的终端运行这条命令，Agent
                          会加入所有房间并保持每个房间的独立上下文。
                        </li>
                        <li>
                          在消息中输入 <code>@{agentNameFor(username, agentProvider)}</code>{" "}
                          即可让它响应；没被 @ 时它只会旁听。
                        </li>
                        <li>
                          终端按 <kbd>Ctrl + C</kbd> 即可让它离线。只想加入单个房间可在命令后追加{" "}
                          <code>--room 房间ID</code>。
                        </li>
                      </ol>
                    </>
                  );
                  return local.enabled ? (
                    <LocalLaunch
                      local={local}
                      provider={agentProvider}
                      access={agentAccess}
                      defaultName={agentNameFor(username, agentProvider)}
                      providerLabel={agentProviderLabel(agentProvider)}
                    >
                      {commandSection}
                    </LocalLaunch>
                  ) : (
                    commandSection
                  );
                })()}
            </div>

            <footer className="agent-dialog-footer">
              {agentStep === 3 && (
                <div className="agent-dialog-links">
                  <details className="connection-details">
                    <summary>查看连接信息</summary>
                    <dl>
                      <div>
                        <dt>服务地址</dt>
                        <dd>
                          <code>{meta?.httpUrl ?? base}</code>
                        </dd>
                      </div>
                      <div>
                        <dt>Hive MCP</dt>
                        <dd>
                          <code>{meta?.mcpUrl ?? `${base}/mcp`}</code>
                        </dd>
                      </div>
                    </dl>
                  </details>
                  <a
                    className="agent-doc"
                    href={`${base}/agent.md`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    行为与安全规则 <Icon name="external" size={15} />
                  </a>
                </div>
              )}
              <div className="agent-dialog-nav">
                {agentStep > 1 && (
                  <button
                    type="button"
                    onClick={() => goToAgentStep((agentStep - 1) as AgentSetupStep)}
                  >
                    上一步
                  </button>
                )}
                {agentStep < 3 ? (
                  <button
                    type="button"
                    className="primary"
                    onClick={() => goToAgentStep((agentStep + 1) as AgentSetupStep)}
                  >
                    <span>下一步</span>
                    <Icon name="arrow-right" size={16} />
                  </button>
                ) : (
                  <button type="button" onClick={closeAgentDialog}>
                    完成
                  </button>
                )}
              </div>
            </footer>
          </div>
        </div>
      )}

      {settingsOpen && (
        <div className="settings-dialog-layer">
          <button
            className="settings-dialog-scrim"
            type="button"
            aria-label="关闭设置"
            onClick={closeSettings}
          />
          <div
            ref={settingsDialogRef}
            className="settings-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-dialog-title"
          >
            <header className="settings-dialog-header">
              <div>
                <h2 id="settings-dialog-title">偏好设置</h2>
              </div>
              <button
                ref={settingsCloseRef}
                type="button"
                aria-label="关闭设置"
                onClick={closeSettings}
              >
                <Icon name="close" />
              </button>
            </header>
            <div className="settings-dialog-layout">
              <nav className="settings-tabs" aria-label="设置分类" role="tablist">
                {settingsTabs.map((tab, index) => (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={settingsTab === tab.id}
                    aria-controls={`settings-panel-${tab.id}`}
                    tabIndex={settingsTab === tab.id ? 0 : -1}
                    className={settingsTab === tab.id ? "active" : ""}
                    onClick={() => setSettingsTab(tab.id)}
                    onKeyDown={(event) => {
                      if (
                        !["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(event.key)
                      ) {
                        return;
                      }
                      event.preventDefault();
                      const direction =
                        event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1;
                      const nextIndex =
                        (index + direction + settingsTabs.length) % settingsTabs.length;
                      setSettingsTab(settingsTabs[nextIndex]!.id);
                      window.requestAnimationFrame(() => {
                        const tabs =
                          settingsDialogRef.current?.querySelectorAll<HTMLButtonElement>(
                            '[role="tab"]',
                          );
                        tabs?.[nextIndex]?.focus();
                      });
                    }}
                    key={tab.id}
                  >
                    <strong>{tab.label}</strong>
                    <small>{tab.description}</small>
                  </button>
                ))}
              </nav>

              <div className="settings-dialog-content">
                {settingsTab === "chat" && (
                  <section id="settings-panel-chat" role="tabpanel" aria-label="聊天与输入">
                    <div className="settings-panel-heading">
                      <h3>聊天与输入</h3>
                      <p>控制消息如何编辑、发送和显示。</p>
                    </div>

                    <div className="settings-group">
                      <div className="settings-section-heading">
                        <div>
                          <h4>发送消息</h4>
                          <p>选择在输入框中发送消息的快捷键。</p>
                        </div>
                      </div>
                      <div className="shortcut-selector" role="radiogroup" aria-label="发送快捷键">
                        <button
                          type="button"
                          role="radio"
                          aria-checked={sendShortcut === "modifier-enter"}
                          className={sendShortcut === "modifier-enter" ? "active" : ""}
                          onClick={() => {
                            setSendShortcut("modifier-enter");
                            localStorage.setItem(storedSendShortcutKey, "modifier-enter");
                          }}
                        >
                          <span>
                            <strong>组合键发送</strong>
                            <small>推荐，Enter 可以安心换行</small>
                          </span>
                          <kbd>{modifierKeyLabel} + Enter</kbd>
                          <i aria-hidden="true">
                            <Icon name="check" size={14} />
                          </i>
                        </button>
                        <button
                          type="button"
                          role="radio"
                          aria-checked={sendShortcut === "enter"}
                          className={sendShortcut === "enter" ? "active" : ""}
                          onClick={() => {
                            setSendShortcut("enter");
                            localStorage.setItem(storedSendShortcutKey, "enter");
                          }}
                        >
                          <span>
                            <strong>Enter 发送</strong>
                            <small>使用 Shift + Enter 换行</small>
                          </span>
                          <kbd>Enter</kbd>
                          <i aria-hidden="true">
                            <Icon name="check" size={14} />
                          </i>
                        </button>
                      </div>
                    </div>

                    <div className="settings-group divided">
                      <SettingsSwitch
                        checked={autoSaveDraft}
                        label="自动保存草稿"
                        description="刷新或重新打开页面后恢复未发送内容"
                        onChange={(checked) => {
                          setAutoSaveDraft(checked);
                          localStorage.setItem(storedAutoSaveDraftKey, String(checked));
                          if (!checked && username) {
                            localStorage.removeItem(draftStorageKey(username, currentRoomId));
                          } else if (checked && username && draft) {
                            localStorage.setItem(draftStorageKey(username, currentRoomId), draft);
                          }
                        }}
                      />
                      <div className="settings-inline-row">
                        <span>
                          <strong>时间格式</strong>
                          <small>消息时间戳的显示方式</small>
                        </span>
                        <div className="compact-choice" role="radiogroup" aria-label="时间格式">
                          {(["system", "24h", "12h"] as const).map((value) => (
                            <button
                              type="button"
                              role="radio"
                              aria-checked={timeFormat === value}
                              className={timeFormat === value ? "active" : ""}
                              onClick={() => {
                                setTimeFormat(value);
                                localStorage.setItem(storedTimeFormatKey, value);
                              }}
                              key={value}
                            >
                              {value === "system"
                                ? "系统"
                                : value === "24h"
                                  ? "24 小时"
                                  : "12 小时"}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  </section>
                )}

                {settingsTab === "notifications" && (
                  <section id="settings-panel-notifications" role="tabpanel" aria-label="通知">
                    <div className="settings-panel-heading">
                      <h3>通知</h3>
                      <p>只在你需要关注时发出清晰信号。</p>
                    </div>
                    {notificationPermission !== "granted" &&
                      notificationPermission !== "default" && (
                        <div className="notification-permission-note" role="status">
                          <Icon name="shield" size={16} />
                          <span>
                            {notificationPermission === "unsupported"
                              ? "当前浏览器不支持系统通知。"
                              : "系统通知已被浏览器阻止，请在站点权限中重新允许。"}
                          </span>
                        </div>
                      )}
                    {notificationPermission === "default" && messageNotifications !== "off" && (
                      <div className="notification-permission-note" role="status">
                        <Icon name="bell" size={16} />
                        <span>浏览器尚未授权通知，当前选项要等授权后才会生效。</span>
                        <button type="button" onClick={() => void ensureNotificationPermission()}>
                          立即授权
                        </button>
                      </div>
                    )}
                    <div className="settings-group">
                      <div className="settings-section-heading">
                        <div>
                          <h4>消息通知</h4>
                          <p>页面不在前台时，通过系统通知提醒我。</p>
                        </div>
                      </div>
                      <div
                        className="shortcut-selector notification-modes"
                        role="radiogroup"
                        aria-label="消息通知"
                      >
                        {messageNotificationOptions.map((option) => (
                          <button
                            type="button"
                            role="radio"
                            aria-checked={messageNotifications === option.id}
                            disabled={
                              notificationPermission === "unsupported" && option.id !== "off"
                            }
                            className={messageNotifications === option.id ? "active" : ""}
                            onClick={() => void updateMessageNotifications(option.id)}
                            key={option.id}
                          >
                            <span>
                              <strong>{option.label}</strong>
                              <small>{option.description}</small>
                            </span>
                            <i aria-hidden="true">
                              <Icon name="check" size={14} />
                            </i>
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="settings-group divided settings-switch-list">
                      <SettingsSwitch
                        checked={notificationSound}
                        label="新消息提示音"
                        description="收到其他成员的新消息时播放轻提示音"
                        onChange={(checked) => {
                          setNotificationSound(checked);
                          localStorage.setItem(storedNotificationSoundKey, String(checked));
                          if (checked) playNotificationTone();
                        }}
                      />
                      <SettingsSwitch
                        checked={presenceNotifications}
                        disabled={notificationPermission === "unsupported"}
                        label="Agent 上下线"
                        description="页面不在前台时，提醒 Agent 离线或重新上线"
                        onChange={(checked) => void updatePresenceNotifications(checked)}
                      />
                    </div>
                    <p className="settings-local-note">
                      浏览器通知只在页面不处于前台时显示；提示音设置独立生效。
                    </p>
                  </section>
                )}

                {settingsTab === "appearance" && (
                  <section id="settings-panel-appearance" role="tabpanel" aria-label="外观">
                    <div className="settings-panel-heading">
                      <h3>外观</h3>
                      <p>调整界面气氛与信息密度，不影响其他成员。</p>
                    </div>

                    <div className="settings-group">
                      <div className="settings-section-heading">
                        <div>
                          <h4>界面主题</h4>
                          <p>系统主题变化时可以自动跟随。</p>
                        </div>
                      </div>
                      <div className="visual-choice-grid" role="radiogroup" aria-label="界面主题">
                        {(["system", "dark", "light"] as const).map((value) => (
                          <button
                            type="button"
                            role="radio"
                            aria-checked={themePreference === value}
                            className={`${value} ${themePreference === value ? "active" : ""}`}
                            onClick={() => {
                              setThemePreference(value);
                              localStorage.setItem(storedThemeKey, value);
                            }}
                            key={value}
                          >
                            <i aria-hidden="true">
                              <span />
                            </i>
                            <strong>
                              {value === "system" ? "跟随系统" : value === "dark" ? "深色" : "浅色"}
                            </strong>
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="settings-group divided settings-switch-list">
                      <div className="settings-inline-row">
                        <span>
                          <strong>界面密度</strong>
                          <small>控制成员和消息之间的留白</small>
                        </span>
                        <div className="compact-choice" role="radiogroup" aria-label="界面密度">
                          {(["comfortable", "compact"] as const).map((value) => (
                            <button
                              type="button"
                              role="radio"
                              aria-checked={interfaceDensity === value}
                              className={interfaceDensity === value ? "active" : ""}
                              onClick={() => {
                                setInterfaceDensity(value);
                                localStorage.setItem(storedDensityKey, value);
                              }}
                              key={value}
                            >
                              {value === "comfortable" ? "舒适" : "紧凑"}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="settings-inline-row">
                        <span>
                          <strong>消息字号</strong>
                          <small>只调整消息正文和输入文字</small>
                        </span>
                        <div className="compact-choice" role="radiogroup" aria-label="消息字号">
                          {(["small", "standard", "large"] as const).map((value) => (
                            <button
                              type="button"
                              role="radio"
                              aria-checked={messageSize === value}
                              className={messageSize === value ? "active" : ""}
                              onClick={() => {
                                setMessageSize(value);
                                localStorage.setItem(storedMessageSizeKey, value);
                              }}
                              key={value}
                            >
                              {value === "small" ? "小" : value === "standard" ? "标准" : "大"}
                            </button>
                          ))}
                        </div>
                      </div>
                      <SettingsSwitch
                        checked={reduceMotion}
                        label="减少动态效果"
                        description="关闭浮层、状态和界面的过渡动画"
                        onChange={(checked) => {
                          setReduceMotion(checked);
                          localStorage.setItem(storedReduceMotionKey, String(checked));
                        }}
                      />
                    </div>
                  </section>
                )}

                <p className="settings-local-note settings-persistence-note">
                  所有偏好即时生效，并且只保存在当前浏览器中。
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {roomDialog && (
        <div className="room-dialog-layer">
          <button
            className="room-dialog-scrim"
            type="button"
            aria-label="关闭房间弹窗"
            onClick={closeRoomDialog}
          />
          <div
            ref={roomDialogRef}
            className="room-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="room-dialog-title"
          >
            <header className="room-dialog-header">
              <div>
                <h2 id="room-dialog-title">
                  {roomDialog.mode === "create" ? "新建房间" : `房间设置 · # ${roomDialog.room.id}`}
                </h2>
              </div>
              <button
                ref={roomDialogCloseRef}
                type="button"
                aria-label="关闭"
                onClick={closeRoomDialog}
              >
                <Icon name="close" />
              </button>
            </header>
            <form
              className="room-dialog-body"
              onSubmit={(event) => {
                event.preventDefault();
                if (roomDialog.mode === "create") void submitCreateRoom();
                else void submitRenameRoom(roomDialog.room);
              }}
            >
              {roomDialog.mode === "create" && (
                <label className="room-field">
                  <span>房间 ID</span>
                  <input
                    value={roomDialogId}
                    onChange={(event) => setRoomDialogId(event.target.value)}
                    maxLength={64}
                    placeholder="例如 frontend"
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <small>仅字母、数字、下划线与连字符；创建后不可修改，Agent 用它加入。</small>
                </label>
              )}
              <label className="room-field">
                <span>显示名称{roomDialog.mode === "create" ? "（可选）" : ""}</span>
                <input
                  value={roomDialogName}
                  onChange={(event) => setRoomDialogName(event.target.value)}
                  maxLength={64}
                  placeholder={roomDialog.mode === "create" ? "默认与房间 ID 相同" : ""}
                />
                <small>仅影响界面展示，可随时修改。</small>
              </label>
              {roomDialogError && (
                <p className="room-dialog-error" role="alert">
                  {roomDialogError}
                </p>
              )}
              {roomDialog.mode === "manage" &&
                archiveConfirmOpen &&
                !roomDialog.room.archivedAt && (
                  <div className="room-archive-confirmation" role="alert">
                    <div>
                      <strong>确认归档该房间？</strong>
                      <p>归档后成员无法再加入，历史消息保留；随时可以恢复。</p>
                    </div>
                    <div className="room-archive-actions">
                      <button type="button" onClick={() => setArchiveConfirmOpen(false)}>
                        取消
                      </button>
                      <button
                        type="button"
                        disabled={roomDialogBusy}
                        onClick={() => void setRoomArchived(roomDialog.room, true)}
                      >
                        确认归档
                      </button>
                    </div>
                  </div>
                )}
              {roomDialog.mode === "manage" && clearConfirmOpen && (
                <div className="room-archive-confirmation" role="alert">
                  <div>
                    <strong>确认清空 # {roomDialog.room.name}？</strong>
                    <p>
                      将删除这个房间的全部消息和 Agent
                      调用记录，所有成员都会看到房间被清空，无法恢复。白板保留；房间里的 Agent
                      会从新会话开始。
                    </p>
                  </div>
                  <div className="room-archive-actions">
                    <button type="button" onClick={() => setClearConfirmOpen(false)}>
                      取消
                    </button>
                    <button
                      type="button"
                      disabled={roomDialogBusy}
                      onClick={() => void clearRoom(roomDialog.room)}
                    >
                      确认清空
                    </button>
                  </div>
                </div>
              )}
              <footer className="room-dialog-footer">
                {roomDialog.mode === "manage" && local.enabled && !roomDialog.room.archivedAt && (
                  <button
                    type="button"
                    className="room-archive"
                    disabled={roomDialogBusy}
                    title="仅本机房主可用"
                    onClick={() => {
                      setArchiveConfirmOpen(false);
                      setClearConfirmOpen(true);
                    }}
                  >
                    清空房间
                  </button>
                )}
                {roomDialog.mode === "manage" &&
                  (roomDialog.room.archivedAt ? (
                    <button
                      type="button"
                      className="room-restore"
                      disabled={roomDialogBusy}
                      onClick={() => void setRoomArchived(roomDialog.room, false)}
                    >
                      恢复房间
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="room-archive"
                      disabled={roomDialogBusy || roomDialog.room.id === "general"}
                      title={roomDialog.room.id === "general" ? "默认房间不能归档" : undefined}
                      onClick={() => {
                        setClearConfirmOpen(false);
                        setArchiveConfirmOpen(true);
                      }}
                    >
                      归档房间
                    </button>
                  ))}
                <button type="submit" disabled={roomDialogBusy}>
                  {roomDialog.mode === "create" ? "创建房间" : "保存"}
                </button>
              </footer>
            </form>
          </div>
        </div>
      )}
    </main>
  );
}
