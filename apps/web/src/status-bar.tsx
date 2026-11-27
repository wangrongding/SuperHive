import {
  Fragment,
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
  AgentContextStatus,
  ImConnection,
  MetaResponse,
  NetworkProxyMode,
  NetworkProxyState,
  Participant,
} from "@superhive/protocol";
import { LOCALE_OPTIONS, setLocalePreference, t, type LocalePreference } from "./i18n";
import { Icon, ThemeGlyph, type IconName } from "./app-icons";
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
import { desktopBridge } from "./desktop-bridge";
import { checkDesktopUpdatesNow, DesktopUpdateEntry } from "./desktop-update";
import { NpmUpdateEntry } from "./npm-update";
import { useUpdateCenter } from "./update-center";
import { KeyCombo } from "./key-combo";
import { keepAwakeStatusText } from "./host-settings";
import { listAllImConnections, IM_CHANNEL_LABELS } from "./im-api";
import { mcpProblems } from "./mcp-health";
import { effectiveCompactWindow, memberContextHint } from "./member-context";
import { formatTokens } from "./usage";
import { modelDisplayName } from "./agent-models";
import { SettingsSwitch } from "./settings-switch";
import { Tooltip } from "./tooltip";
import { Button } from "./button";
import { suggestLead } from "./lead-agent";
import { AvatarGlyph } from "./avatar";
import type { LocalAgentsState } from "./local-agents";
import {
  StatusAgentClisPopover,
  statusAgentClisLabel,
  useStatusAgentClis,
} from "./status-runtimes";
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
export function imSummary(connections: readonly ImConnection[] | undefined):
  | {
      tone: "ok" | "pending" | "warning";
      label: string;
      /** 要人处理的连接，角标数的就是这些 */
      problems?: readonly ImConnection[];
    }
  | undefined {
  if (!connections) return undefined;
  if (!connections.length) return { tone: "pending", label: t("IM 未连接") };
  const needsAction = connections.filter(
    (connection) => connection.status === "error" || connection.attention,
  );
  if (needsAction.length)
    return { tone: "warning", label: t("IM 需要处理"), problems: needsAction };
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
  badge,
}: {
  label: ReactNode;
  /** 出了问题的个数：大于 0 才显示 */
  badge?: number | undefined;
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

  /**
   * 关掉面板。"always"：焦点一定回到按钮（Esc、选了一项、再点按钮）；
   * "if-lost"：点了外面时，只在焦点没被别的东西接走（落回 body）时才还给按钮，
   * 免得抢走刚点中的输入框或另一个状态栏菜单的焦点
   */
  const close = useCallback((restoreFocus: "always" | "if-lost" = "always") => {
    setOpen(false);
    window.requestAnimationFrame(() => {
      const active = document.activeElement;
      if (restoreFocus === "always" || !active || active === document.body)
        buttonRef.current?.focus({ preventScroll: true });
    });
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
      close("if-lost");
    };
    // 焦点不在面板里时（比如点了面板里的空白处）Esc 也要能关
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      close();
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onEscape);
    };
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
          {badge !== undefined && badge > 0 && (
            <span className="status-item-badge" aria-hidden="true">
              {badge > 99 ? "99+" : badge}
            </span>
          )}
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

/** 弹层底部的一行操作；默认带「去别处」的箭头，就地做的事（检查更新）换成对应图标 */
function PopoverLink({
  onClick,
  icon = "arrow-right",
  children,
}: {
  onClick: () => void;
  icon?: IconName;
  children: ReactNode;
}) {
  return (
    <button type="button" className="status-popover-link" onClick={onClick}>
      {children}
      <Icon name={icon} size={12} />
    </button>
  );
}

function Dot({ tone }: { tone: "ok" | "pending" | "warning" | "danger" | "idle" }) {
  return <span className={`status-dot ${tone}`} aria-hidden="true" />;
}

/* ---------- 状态栏 ---------- */

export type StatusBarProps = {
  connectionState: ConnectionState;
  meta: MetaResponse | undefined;
  participants: readonly Participant[];
  leadAgentName: string | undefined;
  /** 主 Agent 是服务端自动设的（第一个加入的、或自动顺延的） */
  leadAuto?: boolean;
  /** 房主才有：在状态栏里直接换主 Agent */
  setLeadAgent?: ((name: string) => void) | undefined;
  isOwner: boolean;
  /** 只给这台电脑上的房主：本机 Agent、代理、熄屏保持在线 */
  local: LocalAgentsState;
  /** 访客没有：查 IM 连接要房主令牌 */
  /** open 带 id 时打开后定位到那个出了问题的连接 */
  im?:
    | { base: string; token: string; dialogOpen: boolean; open: (focusId?: string) => void }
    | undefined;
  incidents?: { count: number; open: (trigger: HTMLElement | null) => void } | undefined;
  openAgentTasks: (trigger: HTMLElement | null) => void;
  openSettings: (tab: SettingsTab) => void;
  /** 打开「MCP 与技能」大面板；带名字时定位到那个出了问题的 MCP */
  openRuntimeHub: (focusMcp?: string) => void;
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
    leadAuto = false,
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
  const [runtimeCounts, setRuntimeCounts] = useState<{
    mcp: number;
    skills: number;
    /** 测过、没通过的 MCP 名字 */
    problems: string[];
  }>();
  const { runtimeOverview } = local;
  useEffect(() => {
    if (!runtimeOwner || settingsOpen || runtimeHubOpen || !runtimeOverview) return;
    let cancelled = false;
    runtimeOverview().then(
      (overview) => {
        if (!cancelled) {
          setRuntimeCounts({
            mcp: overview.mcp.length,
            skills: overview.skills.length,
            problems: mcpProblems(overview).map((row) => row.name),
          });
        }
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [runtimeOwner, runtimeOverview, runtimeHubOpen, settingsOpen]);
  const [keepAwakeError, setKeepAwakeError] = useState<string>();

  // 「检查更新」：桌面端问客户端，网页版（npm）由 NpmUpdateEntry 注册；都没有（访客、老客户端）就不显示
  const desktopUpdates = desktopBridge()?.updates;
  const { npmCheck } = useUpdateCenter();
  const checkUpdates = desktopUpdates?.checkNow
    ? () => void checkDesktopUpdatesNow(desktopUpdates)
    : npmCheck
      ? () => void npmCheck()
      : undefined;
  // Agent 运行时（各 CLI 的版本和升级）：同一权限，和设置里的「Agent 运行时」共用接口
  const agentClis = useStatusAgentClis(runtimeOwner ? local : undefined, settingsOpen);
  const agentClisItem = agentClis.tools ? statusAgentClisLabel(agentClis) : undefined;

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
          popover={(close) => (
            <>
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
              {checkUpdates && (
                <PopoverLink
                  icon="refresh"
                  onClick={() => {
                    close();
                    checkUpdates();
                  }}
                >
                  {t("检查更新")}
                </PopoverLink>
              )}
            </>
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
          <LeadAgentItem
            lead={lead}
            auto={leadAuto}
            agents={agentsOf(participants)}
            onSwitch={setLeadAgent}
          />
        )}
        {!lead && setLeadAgent && agentsOf(participants).length > 0 && (
          <StatusItem
            className="status-lead"
            icon={<Icon name="users" size={13} />}
            label={t("设主 Agent")}
            tooltip={
              leadAgentName
                ? t("主 Agent {0} 已不在这个房间：没 @ 任何人的消息没人接，请重新选择", {
                    0: leadAgentName,
                  })
                : t("这个房间还没有主 Agent：没 @ 任何人的消息没人接")
            }
            popover={(close) => (
              <LeadPicker
                agents={agentsOf(participants)}
                suggested={suggestLead(
                  participants,
                  local.enabled ? local.agents.map((agent) => agent.name) : [],
                )}
                missing={leadAgentName}
                onPick={(name) => {
                  close();
                  setLeadAgent(name);
                }}
              />
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
            badge={imState.problems?.length}
            tooltip={
              imState.problems?.length
                ? t("{0} 个 IM 连接要处理：点开查看", { 0: imState.problems.length })
                : t("IM 连接：{0}，点开管理", { 0: imState.label })
            }
            onClick={() => im.open(imState.problems?.[0]?.id)}
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
        {runtimeOwner && agentClisItem && (
          <StatusItem
            className={`status-runtime-clis${agentClisItem.tone ? ` ${agentClisItem.tone}` : ""}`}
            align="end"
            icon={
              <Icon name={agentClisItem.tone === "update" ? "arrow-up" : "terminal"} size={13} />
            }
            label={agentClisItem.label}
            tooltip={agentClisItem.tooltip}
            popover={(close) => (
              <StatusAgentClisPopover
                state={agentClis}
                api={local}
                openSettings={() => {
                  close();
                  openSettings("runtimes");
                }}
              />
            )}
          />
        )}
        {runtimeOwner && runtimeCounts && (
          <StatusItem
            className="status-runtimes"
            align="end"
            icon={<Icon name="board" size={13} />}
            tone={runtimeCounts.problems.length ? "warning" : undefined}
            label={t("MCP {0} · 技能 {1}", { 0: runtimeCounts.mcp, 1: runtimeCounts.skills })}
            badge={runtimeCounts.problems.length}
            tooltip={
              runtimeCounts.problems.length
                ? t("{0} 个 MCP 用不了：点开查看", { 0: runtimeCounts.problems.length })
                : t("给这台电脑上的各个 CLI 装 MCP、管理技能")
            }
            onClick={() => openRuntimeHub(runtimeCounts.problems[0])}
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

/** 列表里 Agent 的先后：在线空闲的在前，忙的其次，离线的最后 */
function leadRank(participant: Participant): number {
  return participant.status === "offline" ? 2 : participant.status === "busy" ? 1 : 0;
}

/** 房间里的 Agent：在线空闲 → 忙 → 离线，同一档按名字排 */
export function agentsOf(participants: readonly Participant[]): Participant[] {
  return participants
    .filter((participant) => participant.type === "agent")
    .sort((a, b) => leadRank(a) - leadRank(b) || a.username.localeCompare(b.username));
}

/** Agent 多于这个数时，列表顶上加过滤框 */
export const LEAD_FILTER_THRESHOLD = 8;

/** 按名字或运行时过滤（不分大小写）；空白关键字返回原列表 */
export function filterLeadChoices(
  agents: readonly Participant[],
  query: string,
): readonly Participant[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return agents;
  return agents.filter(
    (agent) =>
      agent.username.toLocaleLowerCase().includes(needle) ||
      Boolean(agent.provider?.toLocaleLowerCase().includes(needle)),
  );
}

/** 只滚列表自己，把某一项滚进可见区；不像 scrollIntoView 那样连带滚动弹层 */
function revealInList(list: HTMLElement | null, item: HTMLElement | null | undefined) {
  if (!list || !item) return;
  const top = item.offsetTop;
  const bottom = top + item.offsetHeight;
  if (top < list.scrollTop) list.scrollTop = top;
  else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
}

/**
 * 选主 Agent 的列表：每项是运行时图标 + 名字 + 状态（忙、离线写字，在线只一个绿点）。
 * 离线的变灰、不能选：主 Agent 要接没人 @ 的消息，离线的接不了。
 * Agent 多于 8 个时顶上有过滤框，焦点留在框里，↑↓ 挪高亮、回车选中。
 * 列表自己限高滚动，弹层里上面的信息和开关不跟着滚走
 */
function LeadChoices({
  agents,
  current,
  onSwitch,
}: {
  agents: readonly Participant[];
  current?: string;
  onSwitch: (name: string) => void;
}) {
  const filterable = agents.length > LEAD_FILTER_THRESHOLD;
  const [query, setQuery] = useState("");
  const shown = filterable ? filterLeadChoices(agents, query) : agents;
  const selectable = shown.filter((agent) => agent.status !== "offline");
  const [active, setActive] = useState<string | undefined>(undefined);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const baseId = useId();
  const optionId = (name: string) => `${baseId}-${shown.findIndex((a) => a.username === name)}`;
  // 高亮的那项被过滤掉了，就落到第一个能选的（先当前主 Agent）
  const activeName =
    active && selectable.some((agent) => agent.username === active)
      ? active
      : (selectable.find((agent) => agent.username === current) ?? selectable[0])?.username;

  // 展开后：有过滤框时焦点进框，否则落到当前那项（没有就第一个能选的）；都不连带滚动弹层
  useEffect(() => {
    const list = listRef.current;
    if (filterable) {
      inputRef.current?.focus({ preventScroll: true });
      return;
    }
    const target =
      list?.querySelector<HTMLElement>('[aria-selected="true"]:not([aria-disabled="true"])') ??
      list?.querySelector<HTMLElement>('[role="option"]:not([aria-disabled="true"])');
    target?.focus({ preventScroll: true });
    revealInList(list, target);
    // 只在展开时做一次
  }, []);

  useEffect(() => {
    if (!filterable || !activeName) return;
    revealInList(listRef.current, document.getElementById(optionId(activeName)));
    // optionId 跟着 shown 变，activeName/query 变了才需要重新滚
  }, [filterable, activeName, query]);

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) return;
    // 不交给弹层的 ↑↓ 焦点导航：焦点留在框里，可以接着打字
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Enter") {
      if (activeName) onSwitch(activeName);
      return;
    }
    if (!selectable.length) return;
    const index = selectable.findIndex((agent) => agent.username === activeName);
    const next =
      event.key === "ArrowDown"
        ? (index + 1) % selectable.length
        : (index - 1 + selectable.length) % selectable.length;
    setActive(selectable[next]?.username);
  };

  const statusText = (participant: Participant) =>
    participant.status === "offline"
      ? t("离线")
      : participant.status === "busy"
        ? t("忙碌")
        : t("在线");
  const listId = `${baseId}-list`;
  return (
    <div className="status-lead-picker">
      {filterable && (
        <input
          ref={inputRef}
          className="status-lead-filter"
          type="search"
          role="combobox"
          aria-label={t("过滤 Agent")}
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeName ? optionId(activeName) : undefined}
          placeholder={t("按名字或运行时过滤")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onInputKeyDown}
        />
      )}
      <div
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label={t("切换主 Agent")}
        className="status-lead-choices"
      >
        {shown.map((agent) => {
          const offline = agent.status === "offline";
          const selected = agent.username === current;
          const text = statusText(agent);
          const option = (
            <button
              type="button"
              role="option"
              id={optionId(agent.username)}
              aria-selected={selected}
              aria-label={
                offline
                  ? t("{0}（{1}）：离线，不能设为主 Agent", {
                      0: agent.username,
                      1: agent.provider ?? "Agent",
                    })
                  : t("{0}（{1}）：{2}", {
                      0: agent.username,
                      1: agent.provider ?? "Agent",
                      2: text,
                    })
              }
              // 不用 disabled：鼠标移上去要能看到为什么不能选
              aria-disabled={offline || undefined}
              // 有过滤框时焦点一直在框里，↑↓ 靠高亮，选项本身不进 Tab 顺序
              tabIndex={filterable ? -1 : undefined}
              className={[
                "status-lead-option",
                selected ? "selected" : "",
                filterable && agent.username === activeName ? "active" : "",
                agent.status,
              ]
                .filter(Boolean)
                .join(" ")}
              onMouseEnter={filterable && !offline ? () => setActive(agent.username) : undefined}
              // 点当前那项也要回调：调用方据此关掉面板（是不是同一个由调用方判断）
              onClick={offline ? undefined : () => onSwitch(agent.username)}
            >
              <span className="status-choice-check" aria-hidden="true">
                {selected && <Icon name="check" size={13} />}
              </span>
              <span className="mention-avatar agent status-lead-avatar" aria-hidden="true">
                <AvatarGlyph type="agent" name={agent.username} provider={agent.provider} />
              </span>
              <span className="status-lead-name">{agent.username}</span>
              <span className="status-lead-state" aria-hidden="true">
                {agent.status !== "online" && (
                  <span>{agent.status === "busy" ? t("忙") : text}</span>
                )}
                <Dot
                  tone={
                    agent.status === "offline" ? "idle" : agent.status === "busy" ? "pending" : "ok"
                  }
                />
              </span>
            </button>
          );
          return offline ? (
            <Tooltip key={agent.username} content={t("离线，不会接话，不能设为主 Agent")}>
              {option}
            </Tooltip>
          ) : (
            <Fragment key={agent.username}>{option}</Fragment>
          );
        })}
        {shown.length === 0 && <p className="status-popover-note">{t("没有匹配的 Agent")}</p>}
      </div>
    </div>
  );
}

/** 还没有主 Agent（或手动设的那个已经不在房间）时：先给一个建议人选，下面是完整列表 */
function LeadPicker({
  agents,
  suggested,
  missing,
  onPick,
}: {
  agents: readonly Participant[];
  suggested: Participant | undefined;
  /** 手动设的主 Agent 已经不在房间时它的名字 */
  missing: string | undefined;
  onPick: (name: string) => void;
}) {
  return (
    <>
      {(missing || suggested) && (
        <PopoverSection>
          {missing && (
            <p className="status-popover-note">
              {t("主 Agent {0} 已不在这个房间，请重新选择。", { 0: missing })}
            </p>
          )}
          {suggested && (
            <div className="status-lead-suggest">
              <span>
                {t("建议：{0}", { 0: suggested.username })}
                <small>{t("在线，先加入的本机 Agent 优先")}</small>
              </span>
              <Button size="sm" variant="primary" onClick={() => onPick(suggested.username)}>
                {t("设为主 Agent")}
              </Button>
            </div>
          )}
        </PopoverSection>
      )}
      <PopoverSection title={t("选一个主 Agent")}>
        <LeadChoices agents={agents} onSwitch={onPick} />
      </PopoverSection>
    </>
  );
}

/**
 * 详情下面先只有一个「切换主 Agent」开关，点了展开列表、再点收起。
 * 开关一直留着：以前展开后开关被换成列表，点当前那项又被忽略，列表就收不回去了
 */
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
  const listId = useId();
  return (
    <>
      <button
        type="button"
        className={`status-popover-link status-lead-toggle${open ? " open" : ""}`}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        {t("切换主 Agent")}
        <Icon name="arrow-right" size={12} />
      </button>
      {open && (
        <div id={listId} className="status-lead-switch-list">
          <LeadChoices agents={agents} current={current} onSwitch={onSwitch} />
        </div>
      )}
    </>
  );
}

/** 缓存还剩多久：已过期、不到 5 分钟、充足；不知道有效期返回 undefined */
export function leadCacheState(
  context: Pick<AgentContextStatus, "cacheExpiresAt"> | undefined,
  now: number,
): { tone: "ok" | "warning" | "expired"; minutes: number } | undefined {
  if (!context?.cacheExpiresAt) return undefined;
  const left = Date.parse(context.cacheExpiresAt) - now;
  if (!Number.isFinite(left)) return undefined;
  if (left <= 0) return { tone: "expired", minutes: 0 };
  const minutes = Math.floor(left / 60_000);
  return { tone: minutes < 5 ? "warning" : "ok", minutes };
}

/** 弹层开着时每 30 秒刷新一次「现在」，缓存剩余时间跟着走 */
function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [enabled]);
  return now;
}

/** 主 Agent 弹层里的上下文和缓存：各一行，解释都放进悬停提示 */
function LeadContextFacts({ context }: { context: AgentContextStatus }) {
  const now = useNow(Boolean(context.cacheExpiresAt));
  const window = effectiveCompactWindow(context);
  const percent =
    window !== undefined && window > 0
      ? Math.min(100, Math.round((context.contextTokens / window) * 100))
      : undefined;
  const contextHint = memberContextHint({ ...context, cacheExpiresAt: undefined }, now);
  const cache = leadCacheState(context, now);
  const cacheText = !cache
    ? undefined
    : cache.tone === "expired"
      ? t("已过期")
      : cache.minutes < 1
        ? t("还剩不到 1 分钟")
        : t("还剩 {0} 分钟", { 0: cache.minutes });
  const cacheHint = !cache
    ? undefined
    : cache.tone === "expired"
      ? t("缓存已过期：下一轮要把整段会话重新写进缓存，更慢也更贵。")
      : t("从最后一次模型请求算起；过期后下一轮要整段重写缓存，更慢也更贵。");
  const size =
    window !== undefined
      ? `${formatTokens(context.contextTokens)} / ${formatTokens(window)}`
      : formatTokens(context.contextTokens);
  return (
    <>
      <dt>{t("上下文")}</dt>
      <dd>
        <Tooltip content={contextHint}>
          <span className="status-context-line" tabIndex={0} aria-label={contextHint}>
            {percent !== undefined && (
              <>
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
                <span>{percent}%</span>
                <span aria-hidden="true">·</span>
              </>
            )}
            <span className="mono">{size}</span>
          </span>
        </Tooltip>
      </dd>
      {cache && cacheText && (
        <>
          <dt>{t("缓存")}</dt>
          <dd>
            <Tooltip content={cacheHint}>
              <span
                className={`status-cache-chip ${cache.tone}`}
                tabIndex={0}
                aria-label={`${t("缓存")} ${cacheText}：${cacheHint}`}
              >
                {cacheText}
              </span>
            </Tooltip>
          </dd>
        </>
      )}
    </>
  );
}

/** 主 Agent：名字、模型和上下文用量；点开看详情 */
function LeadAgentItem({
  lead,
  auto,
  agents,
  onSwitch,
}: {
  lead: Participant;
  /** 服务端自动设的：名字后面标「自动」 */
  auto: boolean;
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
          {auto && <span className="status-lead-auto">{t("自动")}</span>}
          {model && <span className="status-item-meta">{model}</span>}
          {percent !== undefined && (
            <span className={`status-item-meta${percent >= 80 ? " warning" : ""}`}>
              {t("上下文 {0}%", { 0: percent })}
            </span>
          )}
        </>
      }
      tooltip={
        auto
          ? t("主 Agent {0}（自动设的）：{1}", { 0: lead.username, 1: statusText })
          : t("主 Agent {0}：{1}", { 0: lead.username, 1: statusText })
      }
      popover={(close) => (
        <>
          <PopoverSection>
            <dl className="status-facts">
              <dt>{t("状态")}</dt>
              <dd>
                <Dot tone={tone} />
                {statusText}
              </dd>
              <dt>{t("设定")}</dt>
              <dd>{auto ? t("自动（第一个加入的 Agent）") : t("房主指定")}</dd>
              {model && (
                <>
                  <dt>{t("模型")}</dt>
                  <dd className="mono">
                    {model}
                    {lead.lastModel?.effort ? ` · ${lead.lastModel.effort}` : ""}
                  </dd>
                </>
              )}
              {lead.context && <LeadContextFacts context={lead.context} />}
            </dl>
          </PopoverSection>
          {onSwitch && agents.length > 1 && (
            <LeadSwitcher
              agents={agents}
              current={lead.username}
              onSwitch={(name) => {
                // 选了哪一项都关掉面板；选的还是当前这个就不用再请求
                close();
                if (name !== lead.username) onSwitch(name);
              }}
            />
          )}
        </>
      )}
    />
  );
}
