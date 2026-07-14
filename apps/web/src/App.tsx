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
import { resolveServerBase } from "./server-url";

const storedUsernameKey = "ai-hive.username";
type SelectableAgentProvider = "codex" | "claude" | "copilot" | "openclaw";
type MobilePanel = "members" | "connect";
type IconName =
  "arrow-right" | "close" | "copy" | "external" | "logout" | "plug" | "send" | "shield" | "users";

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    "arrow-right": <path d="M5 12h14m-5-5 5 5-5 5" />,
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
): string {
  const agentName = agentNameFor(ownerUsername, provider);
  return meta.agentCommand
    .replace(" join ", ` join --provider ${provider} `)
    .replace("--name my-agent", `--name ${agentName}`)
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
  const [draft, setDraft] = useState("");
  const [mentionContext, setMentionContext] = useState<MentionContext>();
  const [activeMentionIndex, setActiveMentionIndex] = useState(0);
  const [connectionState, setConnectionState] = useState<"connecting" | "online" | "offline">(
    "connecting",
  );
  const [error, setError] = useState<string>();
  const [copiedProvider, setCopiedProvider] = useState<SelectableAgentProvider>();
  const [agentProvider, setAgentProvider] = useState<SelectableAgentProvider>("codex");
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>();
  const socketRef = useRef<WebSocket | undefined>(undefined);
  const reconnectTimerRef = useRef<number | undefined>(undefined);
  const retryRef = useRef(0);
  const latestSeqRef = useRef(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const membersCloseRef = useRef<HTMLButtonElement>(null);
  const connectCloseRef = useRef<HTMLButtonElement>(null);
  const lastPanelTriggerRef = useRef<HTMLButtonElement>(null);
  const base = useMemo(serverBase, []);
  const mentionSuggestions = useMemo(
    () =>
      mentionContext ? filterMentionParticipants(participants, mentionContext.query, username) : [],
    [mentionContext, participants, username],
  );
  const selectedAgentCommand = useMemo(() => {
    if (!meta) return "加载中…";
    return agentCommandFor(meta, agentProvider, username);
  }, [agentProvider, meta, username]);

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
      if (mobilePanel === "connect") connectCloseRef.current?.focus();
    });
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMobilePanel();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [closeMobilePanel, mobilePanel]);

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
        } else if (event.type === "presence.changed") {
          setParticipants((current) => {
            const byId = new Map(current.map((participant) => [participant.id, participant]));
            byId.set(event.participant.id, event.participant);
            return [...byId.values()];
          });
        } else if (event.type === "error") {
          if (event.code === "USERNAME_TAKEN") {
            setError(
              `用户名 ${username} 仍处于在线状态，正在等待旧连接释放并自动重连；如果这是另一个会话，请点击右上角“退出”后更换用户名。`,
            );
            socket.close();
          } else {
            setError(event.message);
          }
        }
      });
      socket.addEventListener("close", () => {
        if (cancelled) return;
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
    await navigator.clipboard.writeText(agentCommandFor(meta, provider, username));
    setCopiedProvider(provider);
    window.setTimeout(
      () => setCopiedProvider((current) => (current === provider ? undefined : current)),
      1500,
    );
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
            <div className="chat-heading-copy">
              <span className="context-pulse" aria-hidden="true" />
              <p>人类与 Agent 正沿着同一条上下文工作</p>
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
              <button
                type="button"
                aria-label="打开 Agent 接入面板"
                aria-expanded={mobilePanel === "connect"}
                onClick={(event) => openMobilePanel("connect", event.currentTarget)}
              >
                <Icon name="plug" />
                <span>接入</span>
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
                updateMentionContext(event.target.value, event.target.selectionStart);
              }}
              onSelect={(event) =>
                updateMentionContext(event.currentTarget.value, event.currentTarget.selectionStart)
              }
              onKeyDown={(event) => {
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
                if (event.key === "Enter" && !event.shiftKey) {
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
                <kbd>Enter</kbd> 发送 · <kbd>Shift Enter</kbd> 换行
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

        <aside
          className={`connect-panel panel ${mobilePanel === "connect" ? "mobile-open" : ""}`}
          aria-label="Agent 接入"
        >
          <div className="panel-heading">
            <span className="panel-title">
              <Icon name="plug" size={16} />
              接入 Agent
            </span>
            <span className="panel-meta">CLI / MCP</span>
            <button
              ref={connectCloseRef}
              className="panel-close"
              type="button"
              aria-label="关闭 Agent 接入面板"
              onClick={() => closeMobilePanel()}
            >
              <Icon name="close" />
            </button>
          </div>
          <div className="connect-content">
            <p>选择 Agent Runtime，复制命令并在对应 CLI 所在的电脑上执行。</p>
            <p className="field-label">SERVER</p>
            <code className="server-url">{meta?.httpUrl ?? base}</code>
            <p className="field-label">JOIN TOKEN</p>
            <code className="token">{meta?.joinToken ?? "加载中…"}</code>
            <p className="field-label">HIVE MCP</p>
            <code className="mcp-url">{meta?.mcpUrl ?? `${base}/mcp`}</code>
            <p className="field-label">AGENT RUNTIME</p>
            <div className="provider-selector" role="group" aria-label="Agent runtime">
              {(["codex", "claude", "copilot", "openclaw"] as const).map((provider) => (
                <button
                  type="button"
                  className={agentProvider === provider ? "active" : ""}
                  aria-pressed={agentProvider === provider}
                  aria-label={`复制 ${agentProviderLabel(provider)} Agent 命令`}
                  onClick={() => void copyCommand(provider)}
                  key={provider}
                >
                  <span>{agentProviderLabel(provider)}</span>
                  <small aria-live="polite">
                    {copiedProvider === provider ? "已复制到剪贴板" : "点按复制命令"}
                  </small>
                </button>
              ))}
            </div>
            <p className="field-label">AGENT COMMAND</p>
            <div className="command">
              <code>{selectedAgentCommand}</code>
              <button type="button" onClick={() => void copyCommand()}>
                <Icon name="copy" size={15} />
                <span>{copiedProvider === agentProvider ? "已复制" : "复制"}</span>
              </button>
            </div>
            <div className="steps">
              <div>
                <b>01</b>
                <span>
                  <strong>准备 Runtime</strong>
                  <small>安装 Node.js 22+，并登录所选 Agent CLI</small>
                </span>
              </div>
              <div>
                <b>02</b>
                <span>
                  <strong>选择身份</strong>
                  <small>默认使用 当前用户名-provider，可按需修改 --name</small>
                </span>
              </div>
              <div>
                <b>03</b>
                <span>
                  <strong>明确提及</strong>
                  <small>Agent 仅响应 @它 的消息</small>
                </span>
              </div>
              <div>
                <b>04</b>
                <span>
                  <strong>停止与恢复</strong>
                  <small>按 Ctrl+C 离线；再次运行命令即可恢复</small>
                </span>
              </div>
            </div>
            <a className="agent-doc" href={`${base}/agent.md`} target="_blank" rel="noreferrer">
              查看 Agent 行为与安全规则 <Icon name="external" size={15} />
            </a>
          </div>
          <div className="safety-note">
            <Icon name="shield" size={18} />
            <p>
              <strong>清晰的权限边界</strong>Server 只转发消息，不能远程执行 Agent 所在机器的命令。
            </p>
          </div>
        </aside>
      </section>
    </main>
  );
}
