import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type {
  ImConnection,
  MetaResponse,
  NetworkProxyMode,
  NetworkProxyState,
  Participant,
} from "@superhive/protocol";
import { LOCALE_OPTIONS, setLocalePreference, t, type LocalePreference } from "./i18n";
import { Icon, ThemeGlyph } from "./app-icons";
import {
  messageNotificationOptions,
  storedDensityKey,
  storedSendShortcutKey,
  storedThemeKey,
  type InterfaceDensity,
  type MessageNotificationMode,
  type SendShortcut,
  type SettingsTab,
  type ThemePreference,
} from "./app-storage";
import { DesktopUpdateEntry } from "./desktop-update";
import { NpmUpdateEntry } from "./npm-update";
import { KeyCombo } from "./key-combo";
import { keepAwakeStatusText } from "./host-settings";
import { listAllImConnections, IM_CHANNEL_LABELS } from "./im-api";
import { effectiveCompactWindow, memberContextHint } from "./member-context";
import { modelDisplayName } from "./agent-models";
import { SettingsSwitch } from "./settings-switch";
import { Tooltip } from "./tooltip";
import type { LocalAgentsState } from "./local-agents";
import "./styles/status-bar.css";

/* ---------- 纯函数：每一项显示什么（单独测） ---------- */

export type ConnectionState = "connecting" | "online" | "offline";

/** 房间里 Agent 的在线和忙碌数；离线的不算 */
export function agentCounts(participants: readonly Participant[]): {
  online: number;
  busy: number;
  total: number;
} {
  const agents = participants.filter((participant) => participant.type === "agent");
  return {
    total: agents.length,
    online: agents.filter((agent) => agent.status !== "offline").length,
    busy: agents.filter((agent) => agent.status === "busy").length,
  };
}

/** 上下文用到自动压缩阈值的百分比；不知道阈值时 undefined */
export function contextPercent(participant: Participant | undefined): number | undefined {
  const context = participant?.context;
  if (!context) return undefined;
  const window = effectiveCompactWindow(context);
  if (!window) return undefined;
  return Math.min(100, Math.round((context.contextTokens / window) * 100));
}

/** IM 连接汇总：要人处理的优先，其次在连、已连上；没有连接返回 undefined */
export function imSummary(
  connections: readonly ImConnection[] | undefined,
): { tone: "ok" | "pending" | "warning"; label: string } | undefined {
  if (!connections) return undefined;
  if (!connections.length) return { tone: "pending", label: t("IM 未连接") };
  const needsAction = connections.filter(
    (connection) => connection.status === "error" || connection.attention,
  );
  if (needsAction.length)
    return { tone: "warning", label: t("IM 需要处理 {0}", { 0: needsAction.length }) };
  if (connections.some((connection) => connection.status === "connecting"))
    return { tone: "pending", label: t("IM 连接中") };
  const connected = connections.filter((connection) => connection.status === "connected");
  if (!connected.length) return { tone: "pending", label: t("IM 已暂停") };
  const channels = [...new Set(connected.map((connection) => connection.channel))];
  return {
    tone: "ok",
    label: channels.map((channel) => IM_CHANNEL_LABELS[channel]).join(t("、")),
  };
}

export function connectionLabel(state: ConnectionState): string {
  return state === "online" ? t("已连接") : state === "connecting" ? t("连接中…") : t("已断开");
}

function proxyModeLabel(mode: NetworkProxyMode): string {
  return mode === "system" ? t("跟随系统") : mode === "manual" ? t("手动") : t("不用代理");
}

function themeLabel(theme: ThemePreference): string {
  return theme === "system" ? t("跟随系统") : theme === "dark" ? t("深色") : t("浅色");
}

function notificationShortLabel(mode: MessageNotificationMode): string {
  return mode === "off" ? t("通知关") : mode === "mentions" ? t("@ 我时通知") : t("全部通知");
}

/* ---------- 弹出菜单 ---------- */

const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * 状态栏的一项：一个低调的小按钮；有 popover 时点开在它上方弹一个小面板，
 * Esc / 点外面关掉并把焦点还给按钮，↑↓ 在面板里的可操作项之间移动
 */
function StatusItem({
  label,
  tooltip,
  icon,
  tone,
  className,
  onClick,
  popover,
  align = "start",
}: {
  label: ReactNode;
  /** 按钮的读屏名和悬停说明 */
  tooltip: string;
  icon?: ReactNode;
  tone?: "ok" | "pending" | "warning" | "danger" | undefined;
  className?: string;
  onClick?: () => void;
  popover?: (close: () => void) => ReactNode;
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ left?: number; right?: number; bottom: number }>();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) window.requestAnimationFrame(() => buttonRef.current?.focus());
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      const bottom = window.innerHeight - rect.top + 6;
      setAnchor(
        align === "end"
          ? { right: Math.max(8, window.innerWidth - rect.right), bottom }
          : { left: Math.max(8, rect.left), bottom },
      );
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [open, align]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (panelRef.current?.contains(target) || buttonRef.current?.contains(target)))
        return;
      close(false);
    };
    document.addEventListener("pointerdown", onPointer, true);
    return () => document.removeEventListener("pointerdown", onPointer, true);
  }, [open, close]);

  // 打开后焦点落在选中的那项（没有就第一项）
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const target =
      panel?.querySelector<HTMLElement>('[aria-checked="true"]') ??
      panel?.querySelector<HTMLElement>(FOCUSABLE);
    (target ?? panel)?.focus({ preventScroll: true });
  }, [open]);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const list = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    if (!list.length) return;
    event.preventDefault();
    const index = list.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? list.length - 1
          : event.key === "ArrowDown"
            ? (index + 1) % list.length
            : (index - 1 + list.length) % list.length;
    list[next]?.focus();
  };

  return (
    <>
      <Tooltip content={open ? undefined : tooltip}>
        <button
          ref={buttonRef}
          type="button"
          className={`status-item${tone ? ` ${tone}` : ""}${open ? " active" : ""}${className ? ` ${className}` : ""}`}
          aria-label={tooltip}
          {...(popover ? { "aria-haspopup": "dialog" as const, "aria-expanded": open } : {})}
          onClick={() => {
            if (popover) {
              if (open) close();
              else setOpen(true);
            } else onClick?.();
          }}
        >
          {icon}
          <span className="status-item-label">{label}</span>
        </button>
      </Tooltip>
      {open &&
        popover &&
        createPortal(
          <div
            ref={panelRef}
            className="status-popover"
            role="dialog"
            aria-labelledby={titleId}
            tabIndex={-1}
            style={{
              bottom: anchor?.bottom ?? 0,
              ...(anchor?.right !== undefined ? { right: anchor.right } : { left: anchor?.left }),
              visibility: anchor ? "visible" : "hidden",
            }}
            onKeyDown={onKeyDown}
          >
            <h2 id={titleId} className="status-popover-title">
              {tooltip}
            </h2>
            {popover(() => close())}
          </div>,
          document.body,
        )}
    </>
  );
}

/** 弹出菜单里的一组单选 */
function ChoiceGroup<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string; hint?: string; extra?: ReactNode }>;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="status-choice" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          type="button"
          role="radio"
          aria-checked={value === option.value}
          className={value === option.value ? "active" : ""}
          disabled={disabled}
          key={option.value}
          onClick={() => onChange(option.value)}
        >
          <span className="status-choice-check" aria-hidden="true">
            {value === option.value && <Icon name="check" size={13} />}
          </span>
          <span className="status-choice-text">
            <span>{option.label}</span>
            {option.hint && <small>{option.hint}</small>}
          </span>
          {option.extra}
        </button>
      ))}
    </div>
  );
}

function PopoverSection({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="status-popover-section">
      {title && <h3>{title}</h3>}
      {children}
    </section>
  );
}

function PopoverLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="status-popover-link" onClick={onClick}>
      {children}
      <Icon name="arrow-right" size={12} />
    </button>
  );
}

function Dot({ tone }: { tone: "ok" | "pending" | "warning" | "danger" }) {
  return <span className={`status-dot ${tone}`} aria-hidden="true" />;
}

/* ---------- 状态栏 ---------- */

export type StatusBarProps = {
  connectionState: ConnectionState;
  meta: MetaResponse | undefined;
  participants: readonly Participant[];
  leadAgentName: string | undefined;
  /** 房主才有：在状态栏里直接换主 Agent */
  setLeadAgent?: ((name: string) => void) | undefined;
  isOwner: boolean;
  /** 只给这台电脑上的房主：本机 Agent、代理、熄屏保持在线 */
  local: LocalAgentsState;
  /** 访客没有：查 IM 连接要房主令牌 */
  im?: { base: string; token: string; dialogOpen: boolean; open: () => void } | undefined;
  incidents?: { count: number; open: (trigger: HTMLElement | null) => void } | undefined;
  openAgentTasks: (trigger: HTMLElement | null) => void;
  openSettings: (tab: SettingsTab) => void;
  /** 打开「MCP 与技能」大面板 */
  openRuntimeHub: () => void;
  runtimeHubOpen?: boolean;
  openProxySettings: () => void;
  /** 设置弹窗关上时重新拉一遍代理设置（在设置页里改过也能同步过来） */
  settingsOpen: boolean;
  messageNotifications: MessageNotificationMode;
  updateMessageNotifications: (mode: MessageNotificationMode) => Promise<void>;
  sendShortcut: SendShortcut;
  setSendShortcut: (value: SendShortcut) => void;
  themePreference: ThemePreference;
  setThemePreference: (value: ThemePreference) => void;
  interfaceDensity: InterfaceDensity;
  setInterfaceDensity: (value: InterfaceDensity) => void;
  localePreference: LocalePreference;
  hide: () => void;
};

export function StatusBar(props: StatusBarProps) {
  const {
    connectionState,
    meta,
    participants,
    leadAgentName,
    setLeadAgent,
    local,
    im,
    incidents,
    openAgentTasks,
    openSettings,
    openRuntimeHub,
    runtimeHubOpen,
    openProxySettings,
    settingsOpen,
  } = props;
  const counts = agentCounts(participants);
  const lead = leadAgentName
    ? participants.find(
        (participant) =>
          participant.type === "agent" &&
          participant.username.toLocaleLowerCase() === leadAgentName.toLocaleLowerCase(),
      )
    : undefined;
  const version = meta?.feedback?.version;
  const manageLocal = Boolean(local.enabled && local.canManage);

  // IM 连接：房主才查；打开过 IM 弹窗后再查一次，每分钟兜底刷新
  const [imConnections, setImConnections] = useState<ImConnection[]>();
  const imBase = im?.base;
  const imToken = im?.token;
  const imDialogOpen = im?.dialogOpen;
  useEffect(() => {
    if (!imBase || !imToken || imDialogOpen) return;
    let cancelled = false;
    const load = () =>
      listAllImConnections(imBase, imToken).then(
        (connections) => {
          if (!cancelled) setImConnections(connections);
        },
        () => undefined,
      );
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [imBase, imToken, imDialogOpen]);
  const imState = im ? imSummary(imConnections) : undefined;

  // 网络代理：和设置页共用同一个接口，设置弹窗关上时重新拉
  const [proxy, setProxy] = useState<NetworkProxyState>();
  const [proxyError, setProxyError] = useState<string>();
  const { networkProxy, updateNetworkProxy } = local;
  useEffect(() => {
    if (!manageLocal || settingsOpen) return;
    let cancelled = false;
    networkProxy().then(
      (next) => {
        if (!cancelled) setProxy(next);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [manageLocal, networkProxy, settingsOpen]);
  const chooseProxy = (mode: NetworkProxyMode, close: () => void) => {
    if (!proxy || mode === proxy.mode) return;
    // 手动还没填过地址：去设置页填
    if (mode === "manual" && !proxy.url) {
      close();
      openProxySettings();
      return;
    }
    setProxyError(undefined);
    updateNetworkProxy(mode === "manual" ? { mode, url: proxy.url! } : { mode }).then(
      setProxy,
      (reason: unknown) => setProxyError(reason instanceof Error ? reason.message : String(reason)),
    );
  };

  const keepAwake = manageLocal && local.keepAwake?.supported ? local.keepAwake : undefined;

  // MCP 与技能：只给 Server 所在电脑上的本机房主（和运行时配置同一权限），大面板、设置弹窗关上时重新数一遍
  const runtimeOwner = manageLocal && local.mode === "local";
  const [runtimeCounts, setRuntimeCounts] = useState<{ mcp: number; skills: number }>();
  const { runtimeOverview } = local;
  useEffect(() => {
    if (!runtimeOwner || settingsOpen || runtimeHubOpen || !runtimeOverview) return;
    let cancelled = false;
    runtimeOverview().then(
      (overview) => {
        if (!cancelled) {
          setRuntimeCounts({ mcp: overview.mcp.length, skills: overview.skills.length });
        }
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [runtimeOwner, runtimeOverview, runtimeHubOpen, settingsOpen]);
  const [keepAwakeError, setKeepAwakeError] = useState<string>();

  return (
    <footer className="status-bar" aria-label={t("状态栏")}>
      <div className="status-bar-group start">
        <StatusItem
          className="status-connection"
          tone={
            connectionState === "online"
              ? "ok"
              : connectionState === "connecting"
                ? "pending"
                : "danger"
          }
          icon={
            <Dot
              tone={
                connectionState === "online"
                  ? "ok"
                  : connectionState === "connecting"
                    ? "pending"
                    : "danger"
              }
            />
          }
          label={
            <>
              {meta?.name ?? "Hive"}
              {version && <span className="status-item-meta">{version}</span>}
            </>
          }
          tooltip={t("Hive 连接：{0}", { 0: connectionLabel(connectionState) })}
          popover={() => (
            <PopoverSection>
              <dl className="status-facts">
                <dt>{t("状态")}</dt>
                <dd>
                  <Dot
                    tone={
                      connectionState === "online"
                        ? "ok"
                        : connectionState === "connecting"
                          ? "pending"
                          : "danger"
                    }
                  />
                  {connectionLabel(connectionState)}
                </dd>
                {meta?.httpUrl && (
                  <>
                    <dt>{t("地址")}</dt>
                    <dd className="mono">{meta.httpUrl.replace(/\/$/, "")}</dd>
                  </>
                )}
                {version && (
                  <>
                    <dt>{t("版本")}</dt>
                    <dd className="mono">
                      {version}
                      {meta?.feedback?.commit ? ` · ${meta.feedback.commit.slice(0, 7)}` : ""}
                    </dd>
                  </>
                )}
                {meta?.feedback?.runMode && (
                  <>
                    <dt>{t("运行方式")}</dt>
                    <dd>{meta.feedback.runMode === "npm" ? t("npm 安装") : t("源码运行")}</dd>
                  </>
                )}
              </dl>
              {connectionState === "offline" && (
                <p className="status-popover-note">
                  {t("连不上 Hive Server，会自动重连；一直连不上请检查 Server 是否还在运行。")}
                </p>
              )}
            </PopoverSection>
          )}
        />
        <DesktopUpdateEntry variant="status" />
        {im && <NpmUpdateEntry base={im.base} token={im.token} />}
        {counts.total > 0 && (
          <StatusItem
            className="status-agents"
            icon={<Icon name="users" size={13} />}
            label={
              counts.busy
                ? t("{0} 在线 · {1} 忙", { 0: counts.online, 1: counts.busy })
                : t("{0} 在线", { 0: counts.online })
            }
            tooltip={t("房间里 {0} 个 Agent 在线、{1} 个正在执行任务：点开看 Agent 任务", {
              0: counts.online,
              1: counts.busy,
            })}
            onClick={() => openAgentTasks(document.activeElement as HTMLElement | null)}
          />
        )}
        {lead && (
          <LeadAgentItem lead={lead} agents={agentsOf(participants)} onSwitch={setLeadAgent} />
        )}
        {!lead && setLeadAgent && agentsOf(participants).length > 0 && (
          <StatusItem
            className="status-lead"
            icon={<Icon name="users" size={13} />}
            label={t("设主 Agent")}
            tooltip={t("这个房间还没有主 Agent：没 @ 任何人的消息没人接")}
            popover={(close) => (
              <PopoverSection title={t("选一个主 Agent")}>
                <div className="status-lead-choices">
                  <LeadChoices
                    agents={agentsOf(participants)}
                    onSwitch={(name) => {
                      close();
                      setLeadAgent(name);
                    }}
                  />
                </div>
              </PopoverSection>
            )}
          />
        )}
        {incidents && incidents.count > 0 && (
          <StatusItem
            className="status-incidents"
            tone="warning"
            icon={<Icon name="alert" size={13} />}
            label={t("{0} 个故障", { 0: incidents.count })}
            tooltip={t("{0} 个故障还没处理：点开故障单", { 0: incidents.count })}
            onClick={() => incidents.open(document.activeElement as HTMLElement | null)}
          />
        )}
        {im && imState && (
          <StatusItem
            className="status-im"
            tone={imState.tone === "pending" ? undefined : imState.tone}
            icon={<Dot tone={imState.tone} />}
            label={imState.label}
            tooltip={t("IM 连接：{0}，点开管理", { 0: imState.label })}
            onClick={im.open}
          />
        )}
      </div>

      <div className="status-bar-group end">
        {manageLocal && proxy && (
          <StatusItem
            className="status-proxy"
            align="end"
            icon={<Icon name="plug" size={13} />}
            label={t("代理：{0}", { 0: proxyModeLabel(proxy.mode) })}
            tooltip={t("本机 Agent 的网络代理")}
            popover={(close) => (
              <>
                <PopoverSection>
                  <ChoiceGroup
                    label={t("网络代理")}
                    value={proxy.mode}
                    options={(["system", "manual", "none"] as const).map((mode) => ({
                      value: mode,
                      label: proxyModeLabel(mode),
                      ...(mode === "manual"
                        ? { hint: proxy.url ?? t("还没填地址，点了去设置里填") }
                        : {}),
                    }))}
                    onChange={(mode) => chooseProxy(mode, close)}
                  />
                  {proxy.effective.url && (
                    <p className="status-popover-note mono">
                      {t("现在生效：{0}", { 0: proxy.effective.url })}
                    </p>
                  )}
                  {proxyError && (
                    <p className="status-popover-note error" role="alert">
                      {proxyError}
                    </p>
                  )}
                  <p className="status-popover-note">
                    {t("改完后新启动的 Agent 生效，正在跑的要重启。")}
                  </p>
                </PopoverSection>
                <PopoverLink
                  onClick={() => {
                    close();
                    openProxySettings();
                  }}
                >
                  {t("代理地址和不走代理的地址")}
                </PopoverLink>
              </>
            )}
          />
        )}
        {runtimeOwner && runtimeCounts && (
          <StatusItem
            className="status-runtimes"
            align="end"
            icon={<Icon name="board" size={13} />}
            label={t("MCP {0} · 技能 {1}", { 0: runtimeCounts.mcp, 1: runtimeCounts.skills })}
            tooltip={t("给这台电脑上的各个 CLI 装 MCP、管理技能")}
            onClick={openRuntimeHub}
          />
        )}
        {keepAwake && (
          <StatusItem
            className="status-keep-awake"
            align="end"
            tone={
              keepAwake.status === "active"
                ? "ok"
                : keepAwake.status === "failed"
                  ? "warning"
                  : undefined
            }
            icon={<Icon name="shield" size={13} />}
            label={
              keepAwake.status === "active"
                ? t("保持在线中")
                : keepAwake.status === "disabled"
                  ? t("会睡眠")
                  : keepAwake.status === "failed"
                    ? t("保持在线失败")
                    : t("保持在线待命")
            }
            tooltip={t("熄屏后保持在线：{0}", { 0: keepAwakeStatusText[keepAwake.status] })}
            popover={(close) => (
              <>
                <PopoverSection>
                  <p className="status-popover-note">{keepAwakeStatusText[keepAwake.status]}</p>
                  <div className="status-switches">
                    <SettingsSwitch
                      checked={keepAwake.whenIm}
                      label={t("连着 IM 时保持在线")}
                      onChange={(checked) => {
                        setKeepAwakeError(undefined);
                        local
                          .updateKeepAwake({ whenIm: checked })
                          .catch((reason: unknown) =>
                            setKeepAwakeError(
                              reason instanceof Error ? reason.message : String(reason),
                            ),
                          );
                      }}
                    />
                    <SettingsSwitch
                      checked={keepAwake.whenTasks}
                      label={t("Agent 执行任务时保持在线")}
                      onChange={(checked) => {
                        setKeepAwakeError(undefined);
                        local
                          .updateKeepAwake({ whenTasks: checked })
                          .catch((reason: unknown) =>
                            setKeepAwakeError(
                              reason instanceof Error ? reason.message : String(reason),
                            ),
                          );
                      }}
                    />
                  </div>
                  {keepAwakeError && (
                    <p className="status-popover-note error" role="alert">
                      {keepAwakeError}
                    </p>
                  )}
                </PopoverSection>
                <PopoverLink
                  onClick={() => {
                    close();
                    openSettings("computer");
                  }}
                >
                  {t("用电池时也保持等更多设置")}
                </PopoverLink>
              </>
            )}
          />
        )}
        <StatusItem
          className="status-notifications"
          align="end"
          icon={<Icon name="bell" size={13} />}
          label={notificationShortLabel(props.messageNotifications)}
          tooltip={t("消息通知")}
          popover={(close) => (
            <>
              <PopoverSection>
                <ChoiceGroup
                  label={t("消息通知")}
                  value={props.messageNotifications}
                  options={messageNotificationOptions.map((option) => ({
                    value: option.id,
                    label: option.label,
                    hint: option.description,
                  }))}
                  onChange={(mode) => void props.updateMessageNotifications(mode)}
                />
              </PopoverSection>
              <PopoverLink
                onClick={() => {
                  close();
                  openSettings("notifications");
                }}
              >
                {t("提示音、任务提醒等更多设置")}
              </PopoverLink>
            </>
          )}
        />
        <StatusItem
          className="status-send"
          align="end"
          label={
            <>
              <KeyCombo keys={props.sendShortcut === "enter" ? ["Enter"] : ["Mod", "Enter"]} />
              <span className="status-item-text">{t("发送")}</span>
            </>
          }
          tooltip={t("发送消息的快捷键")}
          popover={() => (
            <PopoverSection>
              <ChoiceGroup
                label={t("发送快捷键")}
                value={props.sendShortcut}
                options={[
                  {
                    value: "modifier-enter",
                    label: t("组合键发送"),
                    hint: t("推荐，Enter 可以安心换行"),
                    extra: <KeyCombo keys={["Mod", "Enter"]} />,
                  },
                  {
                    value: "enter",
                    label: t("Enter 发送"),
                    hint: t("Shift+Enter 换行"),
                    extra: <KeyCombo keys={["Enter"]} />,
                  },
                ]}
                onChange={(value) => {
                  props.setSendShortcut(value);
                  localStorage.setItem(storedSendShortcutKey, value);
                }}
              />
            </PopoverSection>
          )}
        />
        <StatusItem
          className="status-appearance"
          align="end"
          icon={
            <span className="status-theme-glyph">
              <ThemeGlyph theme={props.themePreference} />
            </span>
          }
          label={<span className="status-item-text">{themeLabel(props.themePreference)}</span>}
          tooltip={t("外观：主题、密度和语言")}
          popover={(close) => (
            <>
              <PopoverSection title={t("界面主题")}>
                <ChoiceGroup
                  label={t("界面主题")}
                  value={props.themePreference}
                  options={(["system", "dark", "light"] as const).map((value) => ({
                    value,
                    label: themeLabel(value),
                  }))}
                  onChange={(value) => {
                    props.setThemePreference(value);
                    localStorage.setItem(storedThemeKey, value);
                  }}
                />
              </PopoverSection>
              <PopoverSection title={t("界面密度")}>
                <ChoiceGroup
                  label={t("界面密度")}
                  value={props.interfaceDensity}
                  options={[
                    { value: "comfortable" as const, label: t("舒适") },
                    { value: "compact" as const, label: t("紧凑") },
                  ]}
                  onChange={(value) => {
                    props.setInterfaceDensity(value);
                    localStorage.setItem(storedDensityKey, value);
                  }}
                />
              </PopoverSection>
              <PopoverSection title={t("界面语言")}>
                <ChoiceGroup
                  label={t("界面语言")}
                  value={props.localePreference}
                  options={LOCALE_OPTIONS.map((option) => ({
                    value: option.value,
                    label: option.value === "system" ? t(option.label) : option.label,
                  }))}
                  onChange={setLocalePreference}
                />
              </PopoverSection>
              <PopoverLink
                onClick={() => {
                  close();
                  openSettings("appearance");
                }}
              >
                {t("字号、消息区宽度等更多外观设置")}
              </PopoverLink>
              <button
                type="button"
                className="status-popover-link subtle"
                onClick={() => {
                  close();
                  props.hide();
                }}
              >
                {t("隐藏状态栏")}
                <small>{t("可在「设置 · 外观」里重新打开")}</small>
              </button>
            </>
          )}
        />
      </div>
    </footer>
  );
}

/** 房间里的 Agent：在线的在前，按名字排 */
function agentsOf(participants: readonly Participant[]): Participant[] {
  const rank = (participant: Participant) => (participant.status === "offline" ? 1 : 0);
  return participants
    .filter((participant) => participant.type === "agent")
    .sort((a, b) => rank(a) - rank(b) || a.username.localeCompare(b.username));
}

function LeadChoices({
  agents,
  current,
  onSwitch,
}: {
  agents: readonly Participant[];
  current?: string;
  onSwitch: (name: string) => void;
}) {
  // 一行一个：名字 + 右侧状态点（悬停看文字），列表短一半
  const tone = (participant: Participant) =>
    participant.status === "offline" ? "danger" : participant.status === "busy" ? "pending" : "ok";
  const statusText = (participant: Participant) =>
    participant.status === "offline"
      ? t("离线")
      : participant.status === "busy"
        ? t("忙碌")
        : t("在线");
  return (
    <ChoiceGroup
      label={t("切换主 Agent")}
      value={current ?? ""}
      options={agents.map((agent) => ({
        value: agent.username,
        label: agent.username,
        extra: (
          <span className="status-lead-state" title={statusText(agent)}>
            <Dot tone={tone(agent)} />
            <span className="sr-only">{statusText(agent)}</span>
          </span>
        ),
      }))}
      onChange={(name) => {
        if (name !== current) onSwitch(name);
      }}
    />
  );
}

/** 详情下面先只有一个「切换主 Agent」，点了才展开列表 */
function LeadSwitcher({
  agents,
  current,
  onSwitch,
}: {
  agents: readonly Participant[];
  current: string;
  onSwitch: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return <PopoverLink onClick={() => setOpen(true)}>{t("切换主 Agent")}</PopoverLink>;
  }
  return (
    <PopoverSection title={t("切换主 Agent")}>
      <div className="status-lead-choices">
        <LeadChoices agents={agents} current={current} onSwitch={onSwitch} />
      </div>
    </PopoverSection>
  );
}

/** 主 Agent：名字、模型和上下文用量；点开看详情 */
function LeadAgentItem({
  lead,
  agents,
  onSwitch,
}: {
  lead: Participant;
  agents: readonly Participant[];
  onSwitch?: ((name: string) => void) | undefined;
}) {
  const percent = contextPercent(lead);
  const model = lead.lastModel ? modelDisplayName(lead.lastModel.id) : undefined;
  const tone =
    lead.status === "offline"
      ? "danger"
      : percent !== undefined && percent >= 80
        ? "warning"
        : lead.status === "busy"
          ? "pending"
          : "ok";
  const statusText =
    lead.status === "offline" ? t("离线") : lead.status === "busy" ? t("忙碌") : t("在线");
  return (
    <StatusItem
      className="status-lead"
      icon={<Dot tone={tone} />}
      label={
        <>
          {lead.username}
          {model && <span className="status-item-meta">{model}</span>}
          {percent !== undefined && (
            <span className={`status-item-meta${percent >= 80 ? " warning" : ""}`}>
              {t("上下文 {0}%", { 0: percent })}
            </span>
          )}
        </>
      }
      tooltip={t("主 Agent {0}：{1}", { 0: lead.username, 1: statusText })}
      popover={(close) => (
        <>
          <PopoverSection>
            <dl className="status-facts">
              <dt>{t("状态")}</dt>
              <dd>
                <Dot tone={tone} />
                {statusText}
              </dd>
              {model && (
                <>
                  <dt>{t("模型")}</dt>
                  <dd className="mono">
                    {model}
                    {lead.lastModel?.effort ? ` · ${lead.lastModel.effort}` : ""}
                  </dd>
                </>
              )}
              {percent !== undefined && (
                <>
                  <dt>{t("上下文")}</dt>
                  <dd>
                    <span
                      className={`status-meter${percent >= 80 ? " warning" : ""}`}
                      role="meter"
                      aria-label={t("上下文用量")}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={percent}
                    >
                      <span style={{ width: `${percent}%` }} />
                    </span>
                    {percent}%
                  </dd>
                </>
              )}
            </dl>
            {lead.context && (
              <p className="status-popover-note pre">
                {memberContextHint(lead.context, Date.now())}
              </p>
            )}
          </PopoverSection>
          {onSwitch && agents.length > 1 && (
            <LeadSwitcher
              agents={agents}
              current={lead.username}
              onSwitch={(name) => {
                close();
                onSwitch(name);
              }}
            />
          )}
        </>
      )}
    />
  );
}
