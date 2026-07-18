import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  ChatMessage,
  MessagesResponse,
  MetaResponse,
  Participant,
  ServerEvent,
} from "@ai-hive/protocol";
import {
  applyMention,
  filterMentionParticipants,
  findMentionContext,
  type MentionContext,
} from "./mention-autocomplete";
import { createClientMessageId } from "./client-id";
import { copyTextToClipboard } from "./clipboard";
import { resolveServerBase } from "./server-url";

const storedUsernameKey = "ai-hive.username";
const storedSendShortcutKey = "ai-hive.send-shortcut";
const storedAutoSaveDraftKey = "ai-hive.auto-save-draft";
const storedTimeFormatKey = "ai-hive.time-format";
const storedMentionNotificationsKey = "ai-hive.notify-mentions";
const storedNotificationSoundKey = "ai-hive.notification-sound";
const storedPresenceNotificationsKey = "ai-hive.notify-agent-presence";
const storedThemeKey = "ai-hive.theme";
const storedDensityKey = "ai-hive.density";
const storedMessageSizeKey = "ai-hive.message-size";
const storedReduceMotionKey = "ai-hive.reduce-motion";
type SelectableAgentProvider = "codex" | "claude" | "copilot" | "openclaw";
type AgentAccessMode = "read-only" | "workspace" | "full";
type SendShortcut = "modifier-enter" | "enter";
type SettingsTab = "chat" | "notifications" | "appearance";
type TimeFormat = "system" | "24h" | "12h";
type ThemePreference = "system" | "dark" | "light";
type InterfaceDensity = "comfortable" | "compact";
type MessageSize = "small" | "standard" | "large";
type BrowserNotificationPermission = NotificationPermission | "unsupported";
type MobilePanel = "members";
type IconName =
  | "arrow-right"
  | "check"
  | "close"
  | "copy"
  | "external"
  | "logout"
  | "plug"
  | "send"
  | "settings"
  | "shield"
  | "users";

const selectableAgentProviders = ["codex", "claude", "copilot", "openclaw"] as const;

const agentProviderDescriptions: Record<SelectableAgentProvider, string> = {
  codex: "OpenAI 编程 Agent",
  claude: "Anthropic CLI",
  copilot: "GitHub 编程助手",
  openclaw: "本地自主 Agent",
};

const agentAccessOptions: Array<{
  id: AgentAccessMode;
  label: string;
  shortDescription: string;
}> = [
  { id: "read-only", label: "只读", shortDescription: "不写入工作区" },
  { id: "workspace", label: "工作区", shortDescription: "读写并运行命令" },
  { id: "full", label: "完全访问", shortDescription: "不设 Hive 沙箱" },
];

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

function draftStorageKey(username: string): string {
  return `ai-hive.draft.${username.toLocaleLowerCase()}`;
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

function playNotificationTone(): void {
  const AudioContextConstructor =
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).AudioContext ??
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextConstructor) return;
  try {
    const context = new AudioContextConstructor();
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
    oscillator.addEventListener("ended", () => void context.close());
  } catch {
    // Audio playback can be blocked until the page receives a user gesture.
  }
}

function platformModifierLabel(): string {
  return /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent) ? "Cmd" : "Ctrl";
}

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    "arrow-right": <path d="M5 12h14m-5-5 5 5-5 5" />,
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
    logout: <path d="M10 5H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4m5-4 3-3-3-3m3 3H9" />,
    plug: <path d="M8 3v4m8-4v4M6 7h12v2a6 6 0 0 1-6 6v0a6 6 0 0 1-6-6V7Zm6 8v6" />,
    send: <path d="m21 3-7.4 18-3.7-7.9L2 9.4 21 3Zm-11.1 10.1L14 9" />,
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.08A1.7 1.7 0 0 0 8.96 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3v-4h.08A1.7 1.7 0 0 0 4.6 8.96a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06a1.7 1.7 0 0 0 1.88.34A1.7 1.7 0 0 0 10 3.08V3h4v.08a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06a1.7 1.7 0 0 0-.34 1.88A1.7 1.7 0 0 0 20.92 10H21v4h-.08A1.7 1.7 0 0 0 19.4 15Z" />
      </>
    ),
    shield: <path d="M12 3 5 6v5c0 4.6 2.9 8 7 10 4.1-2 7-5.4 7-10V6l-7-3Zm-3 9 2 2 4-4" />,
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

function HiveLogo({ compact = false }: { compact?: boolean }) {
  return (
    <span className={`hive-logo ${compact ? "compact" : ""}`} aria-hidden="true">
      <svg viewBox="0 0 48 48" fill="none">
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
  if (provider === "echo") return "Echo";
  return provider || "Agent";
}

function agentNameFor(ownerUsername: string, provider: SelectableAgentProvider): string {
  const suffixes: Record<SelectableAgentProvider, string> = {
    codex: "-codex",
    claude: "-claude",
    copilot: "-copilot",
    openclaw: "-openclaw",
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
    .replace("--name my-agent", `--name ${agentName}`)
    .concat(` --access ${access}${access === "read-only" ? "" : " --cwd ."}`)
    .concat(provider === "openclaw" ? " --openclaw-configure-mcp" : "");
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

function resizeComposer(textarea: HTMLTextAreaElement): void {
  textarea.style.height = "0px";
  const nextHeight = Math.min(176, Math.max(54, textarea.scrollHeight));
  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY = textarea.scrollHeight > 176 ? "auto" : "hidden";
}

function HighlightedText({ content }: { content: string }) {
  const parts = content.split(/(@[\p{L}\p{N}_.-]+)/gu);
  return (
    <>
      {parts.map((part, index) =>
        part.startsWith("@") ? (
          <mark key={`${part}-${index}`}>{part}</mark>
        ) : (
          <span key={`${part}-${index}`}>{part}</span>
        ),
      )}
    </>
  );
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
            <div>
              <strong>AI HIVE</strong>
              <span>LOCAL COLLABORATION NETWORK</span>
            </div>
          </div>
          <div className="login-thesis">
            <p className="eyebrow">ONE ROOM · SHARED CONTEXT</p>
            <h1>
              让人类与 Agent，
              <span>沿着同一条思路工作。</span>
            </h1>
            <p>把消息、协作者与本地 Agent 放进一个实时工作区，所有人都看见同一份上下文。</p>
          </div>
          <div className="signal-map" aria-hidden="true">
            <span className="signal-line" />
            <span className="signal-node human">RD</span>
            <span className="signal-node agent">AI</span>
            <span className="signal-node agent secondary">AI</span>
            <p>3 collaborators · one live thread</p>
          </div>
        </section>

        <section className="login-form-panel">
          <div className="login-form-heading">
            <p className="eyebrow">JOIN THE WORKSPACE</p>
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
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState(() => {
    const storedUsername = localStorage.getItem(storedUsernameKey) ?? "";
    return storedUsername && storedBoolean(storedAutoSaveDraftKey, true)
      ? (localStorage.getItem(draftStorageKey(storedUsername)) ?? "")
      : "";
  });
  const [mentionContext, setMentionContext] = useState<MentionContext>();
  const [activeMentionIndex, setActiveMentionIndex] = useState(0);
  const [connectionState, setConnectionState] = useState<"connecting" | "online" | "offline">(
    "connecting",
  );
  const [error, setError] = useState<string>();
  const [copiedProvider, setCopiedProvider] = useState<SelectableAgentProvider>();
  const [copyError, setCopyError] = useState<string>();
  const [agentProvider, setAgentProvider] = useState<SelectableAgentProvider>("codex");
  const [agentAccess, setAgentAccess] = useState<AgentAccessMode>("read-only");
  const [fullAccessConfirmationOpen, setFullAccessConfirmationOpen] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>();
  const [agentDialogOpen, setAgentDialogOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("chat");
  const [sendShortcut, setSendShortcut] = useState<SendShortcut>(storedSendShortcut);
  const [autoSaveDraft, setAutoSaveDraft] = useState(() =>
    storedBoolean(storedAutoSaveDraftKey, true),
  );
  const [timeFormat, setTimeFormat] = useState<TimeFormat>(() =>
    storedChoice(storedTimeFormatKey, ["system", "24h", "12h"], "system"),
  );
  const [mentionNotifications, setMentionNotifications] = useState(() =>
    storedBoolean(storedMentionNotificationsKey, false),
  );
  const [notificationSound, setNotificationSound] = useState(() =>
    storedBoolean(storedNotificationSoundKey, false),
  );
  const [presenceNotifications, setPresenceNotifications] = useState(() =>
    storedBoolean(storedPresenceNotificationsKey, false),
  );
  const [notificationPermission, setNotificationPermission] =
    useState<BrowserNotificationPermission>(browserNotificationPermission);
  const [themePreference, setThemePreference] = useState<ThemePreference>(() =>
    storedChoice(storedThemeKey, ["system", "dark", "light"], "system"),
  );
  const [interfaceDensity, setInterfaceDensity] = useState<InterfaceDensity>(() =>
    storedChoice(storedDensityKey, ["comfortable", "compact"], "comfortable"),
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
  const draftUsernameRef = useRef(username);
  const participantStatusRef = useRef(new Map<string, Participant["status"]>());
  const notificationPreferencesRef = useRef({
    mentionNotifications,
    notificationSound,
    presenceNotifications,
  });
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const membersCloseRef = useRef<HTMLButtonElement>(null);
  const agentDialogRef = useRef<HTMLDivElement>(null);
  const agentDialogCloseRef = useRef<HTMLButtonElement>(null);
  const agentDialogTriggerRef = useRef<HTMLButtonElement>(null);
  const settingsDialogRef = useRef<HTMLDivElement>(null);
  const settingsCloseRef = useRef<HTMLButtonElement>(null);
  const settingsTriggerRef = useRef<HTMLButtonElement>(null);
  const lastPanelTriggerRef = useRef<HTMLButtonElement>(null);
  const base = useMemo(serverBase, []);
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

  useEffect(() => {
    notificationPreferencesRef.current = {
      mentionNotifications,
      notificationSound,
      presenceNotifications,
    };
  }, [mentionNotifications, notificationSound, presenceNotifications]);

  useEffect(() => {
    if (notificationPermission === "granted") return;
    setMentionNotifications(false);
    setPresenceNotifications(false);
    localStorage.setItem(storedMentionNotificationsKey, "false");
    localStorage.setItem(storedPresenceNotificationsKey, "false");
  }, [notificationPermission]);

  useEffect(() => {
    if (draftUsernameRef.current !== username) {
      draftUsernameRef.current = username;
      setDraft(
        username && autoSaveDraft ? (localStorage.getItem(draftStorageKey(username)) ?? "") : "",
      );
      setMentionContext(undefined);
    }
  }, [autoSaveDraft, username]);

  useEffect(() => {
    if (!username || !autoSaveDraft || draftUsernameRef.current !== username) return;
    const key = draftStorageKey(username);
    if (draft) localStorage.setItem(key, draft);
    else localStorage.removeItem(key);
  }, [autoSaveDraft, draft, username]);

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

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useLayoutEffect(() => {
    if (textareaRef.current) resizeComposer(textareaRef.current);
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
    setCopyError(undefined);
    setAgentDialogOpen(true);
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

  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    window.requestAnimationFrame(() => settingsTriggerRef.current?.focus());
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

  const catchUp = useCallback(
    async (afterSeq: number) => {
      if (!meta || afterSeq <= 0) return;
      const response = await fetch(
        `${base}/api/rooms/${encodeURIComponent(meta.roomId)}/messages?afterSeq=${afterSeq}`,
        { headers: { Authorization: `Bearer ${meta.joinToken}` } },
      );
      if (!response.ok) throw new Error(`增量消息拉取失败 (${response.status})`);
      const payload = (await response.json()) as MessagesResponse;
      setMessages((current) => mergeMessages(current, payload.messages));
      latestSeqRef.current = Math.max(latestSeqRef.current, payload.latestSeq);
    },
    [base, meta],
  );

  useEffect(() => {
    if (!meta || !username) return;
    let cancelled = false;
    let reconnectAllowed = true;

    const connect = () => {
      if (cancelled) return;
      setConnectionState("connecting");
      const socket = new WebSocket(meta.wsUrl);
      socketRef.current = socket;
      socket.addEventListener("open", () => {
        socket.send(
          JSON.stringify({
            type: "participant.join",
            username,
            participantType: "human",
            roomId: meta.roomId,
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
          latestSeqRef.current = Math.max(latestSeqRef.current, event.latestSeq);
          retryRef.current = 0;
          setConnectionState("online");
          setError(undefined);
          if (beforeReconnect > 0)
            void catchUp(beforeReconnect).catch((reason: unknown) => setError(String(reason)));
        } else if (event.type === "message.created") {
          setMessages((current) => mergeMessages(current, [event.message]));
          latestSeqRef.current = Math.max(latestSeqRef.current, event.message.seq);
          socket.send(JSON.stringify({ type: "message.ack", seq: event.message.seq }));
          if (event.message.senderName.toLocaleLowerCase() !== username.toLocaleLowerCase()) {
            const preferences = notificationPreferencesRef.current;
            if (preferences.notificationSound) playNotificationTone();
            if (
              preferences.mentionNotifications &&
              document.visibilityState !== "visible" &&
              event.message.mentions.some(
                (mention) => mention.toLocaleLowerCase() === username.toLocaleLowerCase(),
              )
            ) {
              showBrowserNotification(
                `${event.message.senderName} 在 AI Hive 提到了你`,
                event.message.content.slice(0, 180),
              );
            }
          }
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
        } else if (event.type === "error") {
          if (event.code === "USERNAME_TAKEN") {
            reconnectAllowed = false;
            setConnectionState("offline");
            setError(
              `用户名 ${username} 已被同名 Agent 或其他身份占用，请点击右上角“退出”后更换用户名。`,
            );
            socket.close();
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
  }, [catchUp, meta, username]);

  if (!username) {
    return (
      <LoginDialog
        onJoin={(nextUsername) => {
          localStorage.setItem(storedUsernameKey, nextUsername);
          setUsername(nextUsername);
        }}
      />
    );
  }

  const online = participants.filter((participant) => participant.status !== "offline");
  const offline = participants.filter((participant) => participant.status === "offline");

  async function updateBrowserNotificationPreference(
    next: boolean,
    storageKey: string,
    update: (value: boolean) => void,
  ) {
    if (!next) {
      update(false);
      localStorage.setItem(storageKey, "false");
      return;
    }
    if (!("Notification" in window)) {
      setNotificationPermission("unsupported");
      return;
    }
    const permission =
      Notification.permission === "default"
        ? await Notification.requestPermission()
        : Notification.permission;
    setNotificationPermission(permission);
    const enabled = permission === "granted";
    update(enabled);
    localStorage.setItem(storageKey, String(enabled));
  }

  function sendMessage() {
    const content = draft.trim();
    const socket = socketRef.current;
    if (!content || socket?.readyState !== WebSocket.OPEN) return;
    socket.send(
      JSON.stringify({
        type: "message.send",
        clientMessageId: createClientMessageId(),
        content,
      }),
    );
    setDraft("");
    setMentionContext(undefined);
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
    const separator = draft && !draft.endsWith(" ") ? " " : "";
    const nextValue = `${draft}${separator}@${usernameToMention} `;
    setDraft(nextValue);
    setMentionContext(undefined);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextValue.length, nextValue.length);
    });
  }

  async function copyCommand(provider: SelectableAgentProvider = agentProvider) {
    if (!meta) return;
    setAgentProvider(provider);
    setCopyError(undefined);
    try {
      await copyTextToClipboard(agentCommandFor(meta, provider, username, agentAccess));
      setCopiedProvider(provider);
      window.setTimeout(
        () => setCopiedProvider((current) => (current === provider ? undefined : current)),
        1500,
      );
    } catch {
      setCopiedProvider(undefined);
      setCopyError("浏览器未允许自动复制，请选中上方命令后手动复制。");
    }
  }

  return (
    <main className="app-shell">
      <a className="skip-link" href="#main-content">
        跳到消息区
      </a>
      <header className="topbar">
        <div className="brand">
          <HiveLogo compact />
          <div>
            <strong>AI HIVE</strong>
            <small>LOCAL COLLABORATION NETWORK</small>
          </div>
        </div>
        <div className={`connection ${connectionState}`} role="status" aria-live="polite">
          <span aria-hidden="true" />
          {connectionState === "online"
            ? "Hive 已在线"
            : connectionState === "connecting"
              ? "正在连接"
              : "连接已中断"}
        </div>
        <div className="identity">
          <span className="identity-avatar" aria-hidden="true">
            {username.slice(0, 1).toUpperCase()}
          </span>
          <span className="identity-copy">
            <small>当前身份</small>
            <strong>{username}</strong>
          </span>
          <button
            ref={settingsTriggerRef}
            className="settings-trigger"
            type="button"
            aria-label="打开设置"
            aria-haspopup="dialog"
            aria-expanded={settingsOpen}
            title="偏好设置"
            onClick={() => {
              setMobilePanel(undefined);
              setSettingsOpen(true);
            }}
          >
            <Icon name="settings" />
            <span>设置</span>
          </button>
          <button
            type="button"
            aria-label="退出"
            title="退出当前身份"
            onClick={() => {
              localStorage.removeItem(storedUsernameKey);
              setUsername("");
            }}
          >
            <Icon name="logout" />
            <span>退出</span>
          </button>
        </div>
      </header>

      {mobilePanel && (
        <button
          className="panel-scrim"
          type="button"
          aria-label="关闭侧栏"
          onClick={() => closeMobilePanel()}
        />
      )}

      <section className="workspace">
        <aside
          className={`members-panel panel ${mobilePanel === "members" ? "mobile-open" : ""}`}
          aria-label="成员列表"
        >
          <div className="panel-heading">
            <span className="panel-title">
              <Icon name="users" size={16} />
              成员
            </span>
            <span className="panel-meta">{online.length} ONLINE</span>
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
          <div className="member-list">
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
                <span className={`avatar ${participant.type}`} aria-hidden="true">
                  {participant.type === "agent"
                    ? "AI"
                    : participant.username.slice(0, 1).toUpperCase()}
                </span>
                <span className="member-copy">
                  <strong>{participant.username}</strong>
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
                <span className={`avatar ${participant.type}`} aria-hidden="true">
                  {participant.type === "agent"
                    ? "AI"
                    : participant.username.slice(0, 1).toUpperCase()}
                </span>
                <span className="member-copy">
                  <strong>{participant.username}</strong>
                  <small>{agentProviderLabel(participant.provider)} · Offline</small>
                </span>
                <span className="status-dot offline" aria-label="离线" />
              </div>
            ))}
          </div>
          <button
            type="button"
            className="sidebar-agent-entry"
            aria-label="接入 Agent"
            aria-haspopup="dialog"
            aria-expanded={agentDialogOpen}
            onClick={(event) => openAgentDialog(event.currentTarget)}
          >
            <span className="sidebar-agent-entry-mark" aria-hidden="true">
              <Icon name="plug" size={16} />
            </span>
            <span className="sidebar-agent-entry-copy">
              <strong>接入 Agent</strong>
              <small>选择运行时并复制命令</small>
            </span>
            <Icon name="arrow-right" size={14} />
          </button>
          <div className="room-card">
            <small>当前共享线程</small>
            <strong># {meta?.roomId ?? "general"}</strong>
            <span>
              {messages.length} 条消息 · {online.length} 位在线
            </span>
          </div>
        </aside>

        <section className="chat-panel panel" id="main-content" tabIndex={-1}>
          <div className="chat-heading">
            <div>
              <p className="eyebrow">LIVE SHARED CONTEXT</p>
              <h1># {meta?.roomId ?? "general"}</h1>
            </div>
            <div className="chat-actions">
              <button
                type="button"
                aria-label="打开成员列表"
                aria-expanded={mobilePanel === "members"}
                onClick={(event) => openMobilePanel("members", event.currentTarget)}
              >
                <Icon name="users" />
                <span>成员</span>
              </button>
            </div>
          </div>
          {error && (
            <div className="error-banner" role="alert">
              <span>{error}</span>
              <button type="button" aria-label="关闭错误提示" onClick={() => setError(undefined)}>
                <Icon name="close" size={16} />
              </button>
            </div>
          )}
          <div className="message-list" role="log" aria-label="聊天室消息" aria-live="polite">
            {messages.length === 0 && (
              <div className="empty-state">
                <HiveLogo />
                <p className="eyebrow">THREAD READY</p>
                <h2>共享上下文已就绪</h2>
                <p>
                  发出第一条消息，或输入 <code>@agent-name</code> 邀请一个 Agent 参与。
                </p>
                <button type="button" onClick={() => textareaRef.current?.focus()}>
                  开始一条消息
                  <Icon name="arrow-right" size={16} />
                </button>
              </div>
            )}
            {messages.map((message) => (
              <article className={`message ${message.senderType}`} key={message.id}>
                <span className={`avatar ${message.senderType}`} aria-hidden="true">
                  {message.senderType === "agent"
                    ? "AI"
                    : message.senderName.slice(0, 1).toUpperCase()}
                </span>
                <div className="message-content">
                  <header>
                    <strong>{message.senderName}</strong>
                    {message.senderType === "agent" && <b>AGENT</b>}
                    <time dateTime={message.createdAt}>
                      {new Date(message.createdAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                        ...(timeFormat === "system" ? {} : { hour12: timeFormat === "12h" }),
                      })}
                    </time>
                    <span className="seq">#{message.seq}</span>
                  </header>
                  <p>
                    <HighlightedText content={message.content} />
                  </p>
                </div>
              </article>
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
          <div className="composer">
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
                        <span className={`mention-avatar ${participant.type}`} aria-hidden="true">
                          {participant.type === "agent"
                            ? "AI"
                            : participant.username.slice(0, 1).toUpperCase()}
                        </span>
                        <span className="mention-member-copy">
                          <strong>@{participant.username}</strong>
                          <small>
                            {participant.type === "agent" ? "Agent" : "用户"} · {participant.status}
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
            <textarea
              ref={textareaRef}
              rows={1}
              value={draft}
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
                updateMentionContext(event.currentTarget.value, event.currentTarget.selectionStart);
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
                if (event.key === "Enter" && !event.shiftKey && (event.metaKey || event.ctrlKey)) {
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
              maxLength={4000}
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
              <span className="char-count">{draft.length}/4000</span>
              <button
                type="button"
                onClick={sendMessage}
                disabled={!draft.trim() || connectionState !== "online"}
              >
                <span>发送</span>
                <Icon name="send" size={16} />
              </button>
            </div>
          </div>
        </section>
      </section>

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
              <div className="agent-dialog-mark" aria-hidden="true">
                <Icon name="plug" size={22} />
              </div>
              <div>
                <p className="eyebrow">BRING YOUR OWN AGENT</p>
                <h2 id="agent-dialog-title">把 Agent 接入当前房间</h2>
                <p id="agent-dialog-description">
                  选择你正在使用的
                  Agent，复制命令到它所在电脑的终端运行。接入后，它会以独立成员出现在房间里。
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

            <div className="agent-dialog-body">
              <section className="agent-provider-section" aria-labelledby="agent-provider-title">
                <div className="dialog-section-heading">
                  <span>1</span>
                  <div>
                    <h3 id="agent-provider-title">选择 Agent</h3>
                    <p>命令会根据所选运行环境自动调整。</p>
                  </div>
                </div>
                <div className="provider-selector" role="group" aria-label="选择 Agent">
                  {selectableAgentProviders.map((provider) => (
                    <button
                      type="button"
                      className={agentProvider === provider ? "active" : ""}
                      aria-pressed={agentProvider === provider}
                      onClick={() => {
                        setAgentProvider(provider);
                        setCopiedProvider(undefined);
                        setCopyError(undefined);
                      }}
                      key={provider}
                    >
                      <span className="provider-monogram" aria-hidden="true">
                        {agentProviderLabel(provider).slice(0, 2)}
                      </span>
                      <span className="provider-copy">
                        <strong>{agentProviderLabel(provider)}</strong>
                        <small>{agentProviderDescriptions[provider]}</small>
                      </span>
                      <span className="provider-check" aria-hidden="true">
                        <Icon name="check" size={15} />
                      </span>
                    </button>
                  ))}
                </div>
              </section>

              <section className="agent-command-section" aria-labelledby="agent-command-title">
                <div className="dialog-section-heading">
                  <span>2</span>
                  <div>
                    <h3 id="agent-command-title">选择本机权限</h3>
                    <p>权限由 Agent 所在电脑执行，默认保持只读。</p>
                  </div>
                </div>
                <div className="access-selector" role="radiogroup" aria-label="Agent 本机权限">
                  {agentAccessOptions.map((option) => (
                    <button
                      type="button"
                      role="radio"
                      aria-checked={agentAccess === option.id}
                      aria-expanded={option.id === "full" ? fullAccessConfirmationOpen : undefined}
                      className={`${option.id} ${agentAccess === option.id ? "active" : ""}`}
                      onClick={() => {
                        setCopiedProvider(undefined);
                        setCopyError(undefined);
                        if (option.id === "full" && agentAccess !== "full") {
                          setFullAccessConfirmationOpen(true);
                          return;
                        }
                        setFullAccessConfirmationOpen(false);
                        setAgentAccess(option.id);
                      }}
                      key={option.id}
                    >
                      <span className="access-indicator" aria-hidden="true">
                        <i />
                      </span>
                      <strong>{option.label}</strong>
                      <small>{option.shortDescription}</small>
                    </button>
                  ))}
                </div>
                {agentProvider === "openclaw" && (
                  <p className="openclaw-access-note">
                    OpenClaw 的实际权限还需在其 Agent / Gateway 中设置；Hive 不会自动改写全局策略。
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
                          setCopyError(undefined);
                        }}
                      >
                        我了解风险，开启完全访问
                      </button>
                    </div>
                  </div>
                )}
                <div className="dialog-section-heading command-step-heading">
                  <span>3</span>
                  <div>
                    <h3>复制接入命令</h3>
                    <p>在 {agentProviderLabel(agentProvider)} 所在电脑的终端中运行。</p>
                  </div>
                </div>
                <div className="command">
                  <div className="command-heading">
                    <span className="terminal-dots" aria-hidden="true">
                      <i />
                      <i />
                      <i />
                    </span>
                    <small>TERMINAL</small>
                  </div>
                  <code>{selectedAgentCommand}</code>
                  <button type="button" disabled={!meta} onClick={() => void copyCommand()}>
                    <Icon name={copiedProvider === agentProvider ? "check" : "copy"} size={16} />
                    <span>{copiedProvider === agentProvider ? "已复制到剪贴板" : "复制命令"}</span>
                  </button>
                </div>
                {copyError && (
                  <p className="command-copy-error" role="alert">
                    {copyError}
                  </p>
                )}
                <div className="agent-next-steps" aria-label="接入后的操作">
                  <p>
                    <span>权限范围</span>
                    {agentAccess === "read-only" ? (
                      "只读或规划，不写入工作区"
                    ) : agentAccess === "workspace" ? (
                      <>
                        当前终端目录 <code>--cwd .</code>
                      </>
                    ) : (
                      "当前系统用户的全部权限"
                    )}
                  </p>
                  <p>
                    <span>运行后</span>Agent 会以{" "}
                    <code>{agentNameFor(username, agentProvider)}</code> 加入
                  </p>
                  <p>
                    <span>开始协作</span>在消息中输入{" "}
                    <code>@{agentNameFor(username, agentProvider)}</code>
                  </p>
                  <p>
                    <span>随时停止</span>终端按 <kbd>Ctrl + C</kbd> 即可离线
                  </p>
                </div>
              </section>
            </div>

            <footer className="agent-dialog-footer">
              <div className={`safety-note ${agentAccess}`}>
                <Icon name="shield" size={18} />
                <p>
                  <strong>
                    {agentAccess === "read-only"
                      ? "只读模式 · 推荐"
                      : agentAccess === "workspace"
                        ? "工作区权限已开启"
                        : "完全访问 · 高风险"}
                  </strong>
                  {agentAccess === "read-only"
                    ? "Agent 保持只读或规划模式，不获得文件写入权限。"
                    : agentAccess === "workspace"
                      ? "Agent 可在指定工作目录内写文件和运行命令。"
                      : "Agent 可执行当前系统用户有权进行的所有操作。"}
                  {" Hive Server 始终只转发消息。"}
                </p>
              </div>
              <details className="connection-details">
                <summary>查看连接信息</summary>
                <dl>
                  <div>
                    <dt>SERVER</dt>
                    <dd>
                      <code>{meta?.httpUrl ?? base}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>HIVE MCP</dt>
                    <dd>
                      <code>{meta?.mcpUrl ?? `${base}/mcp`}</code>
                    </dd>
                  </div>
                </dl>
              </details>
              <a className="agent-doc" href={`${base}/agent.md`} target="_blank" rel="noreferrer">
                查看行为与安全规则 <Icon name="external" size={15} />
              </a>
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
              <div className="settings-dialog-mark" aria-hidden="true">
                <Icon name="settings" size={20} />
              </div>
              <div>
                <p className="eyebrow">LOCAL PREFERENCES</p>
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
                      <p className="eyebrow">CHAT & COMPOSER</p>
                      <h3>聊天与输入</h3>
                      <p>控制消息如何编辑、发送和显示。</p>
                    </div>

                    <div className="settings-group">
                      <div className="settings-section-heading">
                        <div>
                          <h4>发送消息</h4>
                          <p>选择在输入框中发送消息的快捷键。</p>
                        </div>
                        <span>KEYBOARD</span>
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
                            localStorage.removeItem(draftStorageKey(username));
                          } else if (checked && username && draft) {
                            localStorage.setItem(draftStorageKey(username), draft);
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
                      <p className="eyebrow">SIGNALS & ALERTS</p>
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
                    <div className="settings-group settings-switch-list">
                      <SettingsSwitch
                        checked={mentionNotifications}
                        disabled={notificationPermission === "unsupported"}
                        label="提及我的消息"
                        description="页面不在前台时，通过系统通知提醒我"
                        onChange={(checked) =>
                          void updateBrowserNotificationPreference(
                            checked,
                            storedMentionNotificationsKey,
                            setMentionNotifications,
                          )
                        }
                      />
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
                        onChange={(checked) =>
                          void updateBrowserNotificationPreference(
                            checked,
                            storedPresenceNotificationsKey,
                            setPresenceNotifications,
                          )
                        }
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
                      <p className="eyebrow">DISPLAY & MOTION</p>
                      <h3>外观</h3>
                      <p>调整界面气氛与信息密度，不影响其他成员。</p>
                    </div>

                    <div className="settings-group">
                      <div className="settings-section-heading">
                        <div>
                          <h4>界面主题</h4>
                          <p>系统主题变化时可以自动跟随。</p>
                        </div>
                        <span>THEME</span>
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
    </main>
  );
}
