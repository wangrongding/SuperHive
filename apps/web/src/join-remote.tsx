/**
 * 加入别人的房间：
 * - 侧栏「加入别人的房间」按钮、桌面端菜单、superhive:// 链接都会打开同一个对话框；
 * - 粘贴邀请链接：客户端里在单独的窗口打开对方的房间（浏览器里开新标签页）；
 * - 粘贴接入命令或 superhive://agent-join：选一个本机 Agent，由本机 Hive 在后台把它带进去；
 * - 桌面端侧栏列出打开过的别人的服务器，点一下切过去。
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { LocalAgent } from "@superhive/protocol";
import { t } from "./i18n";
import { Button, IconButton } from "./button";
import { Icon } from "./app-icons";
import { Select, type SelectOption } from "./select";
import { Tooltip } from "./tooltip";
import { agentProviderLabel } from "./agent-setup";
import { copyTextToClipboard } from "./clipboard";
import { desktopBridge, type DesktopJoinRequest, type DesktopRemoteServer } from "./desktop-bridge";
import { parseJoinInput, type JoinTarget } from "./join-link";
import { LocalApiError, type LocalAgentsState } from "./local-agents";

type AgentTarget = Extract<JoinTarget, { kind: "agent" }>;
type DialogState = { kind: "paste"; initial?: string } | { kind: "agent"; target: AgentTarget };

/* ---------- 对话框开关：侧栏按钮和桌面端事件都从这里打开 ---------- */
const listeners = new Set<(state: DialogState) => void>();
export function openJoinDialog(initial?: string): void {
  for (const listener of listeners) listener({ kind: "paste", ...(initial ? { initial } : {}) });
}

function fromDesktop(request: DesktopJoinRequest): DialogState | undefined {
  if (request.kind === "room") return { kind: "paste" };
  const target = parseJoinInput(
    `superhive://agent-join?${new URLSearchParams({
      server: request.server,
      ...(request.roomId ? { room: request.roomId } : {}),
      name: request.name,
      token: request.token,
    }).toString()}`,
  );
  return target?.kind === "agent" ? { kind: "agent", target } : undefined;
}

/** 挂在页面上一次：监听打开请求，渲染对话框 */
export function JoinRemoteHost({
  local,
  openLocalSettings,
}: {
  local: LocalAgentsState;
  /** 带 Agent 加入成功后，跳到设置里的「带到别处的 Agent」 */
  openLocalSettings?: () => void;
}) {
  const [state, setState] = useState<DialogState>();
  useEffect(() => {
    listeners.add(setState);
    const remote = desktopBridge()?.remote;
    const off = remote?.onJoinRequest((request) => {
      const next = fromDesktop(request);
      if (next) setState(next);
    });
    return () => {
      listeners.delete(setState);
      off?.();
    };
  }, []);
  if (!state) return null;
  const close = () => setState(undefined);
  return state.kind === "agent" ? (
    <AgentJoinDialog
      target={state.target}
      local={local}
      onClose={close}
      onBack={() => setState({ kind: "paste" })}
      {...(openLocalSettings ? { openLocalSettings } : {})}
    />
  ) : (
    <PasteDialog
      initial={state.initial ?? ""}
      onClose={close}
      onAgent={(target) => setState({ kind: "agent", target })}
    />
  );
}

function DialogFrame({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const titleId = useId();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="room-dialog-layer">
      <button
        className="room-dialog-scrim"
        type="button"
        aria-label={t("关闭")}
        onClick={onClose}
      />
      <div
        className="room-dialog invite-dialog join-remote-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="room-dialog-header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <IconButton className="dialog-close" label={t("关闭")} onClick={onClose}>
            <Icon name="close" />
          </IconButton>
        </header>
        {children}
      </div>
    </div>
  );
}

function PasteDialog({
  initial,
  onClose,
  onAgent,
}: {
  initial: string;
  onClose: () => void;
  onAgent: (target: AgentTarget) => void;
}) {
  const [text, setText] = useState(initial);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const remote = desktopBridge()?.remote;
  const target = parseJoinInput(text);
  useEffect(() => inputRef.current?.focus(), []);

  const submit = async () => {
    if (!target) {
      setError(t("没认出来。请粘贴对方发来的邀请链接，或者「带入我的 Agent」生成的接入命令。"));
      return;
    }
    if (target.kind === "agent") {
      onAgent(target);
      return;
    }
    setBusy(true);
    try {
      if (remote) {
        if (!(await remote.open(target.url))) throw new Error(t("这个地址打不开。"));
      } else {
        window.open(target.url, "_blank", "noopener,noreferrer");
      }
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogFrame
      title={t("加入别人的房间")}
      subtitle={t("粘贴对方发来的邀请链接，或者对方房间里「带入我的 Agent」生成的接入命令。")}
      onClose={onClose}
    >
      <form
        className="room-dialog-body"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="room-field">
          <span>{t("邀请链接或接入命令")}</span>
          <textarea
            ref={inputRef}
            rows={3}
            value={text}
            spellCheck={false}
            placeholder="http://192.168.1.8:8787/#room?invite=hvi_…"
            onChange={(event) => {
              setText(event.target.value);
              setError(undefined);
            }}
          />
          <small>
            {target?.kind === "agent"
              ? t("这是带 Agent 加入的命令：下一步选一个本机 Agent，由这台电脑在后台把它带进去。")
              : target?.kind === "room"
                ? remote
                  ? t("会在单独的窗口里打开 {0} 的房间，和本机的房间分开。", {
                      0: new URL(target.origin).host,
                    })
                  : t("会在新标签页里打开 {0} 的房间。", { 0: new URL(target.origin).host })
                : t("链接在对方的「邀请成员」里生成；没有邀请的话，对方的服务器会要求登录。")}
          </small>
        </label>
        {error && (
          <p className="room-dialog-error" role="alert">
            {error}
          </p>
        )}
        <footer className="room-dialog-footer dialog-actions">
          <Button onClick={onClose}>{t("取消")}</Button>
          <Button type="submit" variant="primary" disabled={busy || !text.trim()}>
            {target?.kind === "agent" ? t("下一步") : t("加入")}
          </Button>
        </footer>
      </form>
    </DialogFrame>
  );
}

/** 不沿用本机 Agent，直接用某个运行时（只读） */
const RUNTIME_PREFIX = "runtime:";

function AgentJoinDialog({
  target,
  local,
  onClose,
  onBack,
  openLocalSettings,
}: {
  target: AgentTarget;
  local: LocalAgentsState;
  onClose: () => void;
  onBack: () => void;
  openLocalSettings?: () => void;
}) {
  const host = new URL(target.server).host;
  const options = useMemo<SelectOption[]>(() => {
    const agents: SelectOption[] = local.agents.map((agent: LocalAgent) => ({
      value: agent.id,
      label: agent.name,
      description: t("沿用它的运行时、模型、工作目录和权限 · {0}", {
        0: agentProviderLabel(agent.provider),
      }),
      group: t("沿用本机 Agent 的设置"),
    }));
    const runtimes: SelectOption[] = (local.providers ?? [])
      .filter((provider) => provider.installed)
      .map((provider) => ({
        value: `${RUNTIME_PREFIX}${provider.provider}`,
        label: agentProviderLabel(provider.provider),
        description: t("只读权限，不改这台电脑上的文件"),
        group: t("直接用运行时"),
      }));
    return [...agents, ...runtimes];
  }, [local.agents, local.providers]);
  const [choice, setChoice] = useState("");
  const selected = choice || options[0]?.value || "";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [fallback, setFallback] = useState(false);
  const [done, setDone] = useState(false);
  const [copied, setCopied] = useState(false);
  const { refreshAgents, refreshProviders, enabled } = local;
  useEffect(() => {
    if (!enabled) return;
    void refreshAgents().catch(() => undefined);
    void refreshProviders().catch(() => undefined);
  }, [enabled, refreshAgents, refreshProviders]);

  const command = `npx --yes superhive@latest join --server ${target.server}${
    target.roomId ? ` --room ${target.roomId}` : ""
  } --name ${target.name} --token ${target.token}`;

  const submit = useCallback(async () => {
    if (!selected) return;
    setBusy(true);
    setError(undefined);
    try {
      await local.joinRemote({
        server: target.server,
        ...(target.roomId ? { roomId: target.roomId } : {}),
        name: target.name,
        token: target.token,
        ...(selected.startsWith(RUNTIME_PREFIX)
          ? { runtime: selected.slice(RUNTIME_PREFIX.length) }
          : { agentId: selected }),
      });
      setDone(true);
    } catch (reason) {
      if (reason instanceof LocalApiError && reason.status === 404) setFallback(true);
      else if (reason instanceof LocalApiError && reason.code === "REMOTE_JOIN_RUNNING")
        setError(t("{0} 已经在 {1} 里了。", { 0: target.name, 1: host }));
      else setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }, [local, selected, target, host]);

  const canManage = local.enabled === true && local.canManage;
  return (
    <DialogFrame
      title={t("带 Agent 加入别人的房间")}
      subtitle={t("对方：{0}{1}", {
        0: host,
        1: target.roomId ? ` · #${target.roomId}` : t(" · 所有房间"),
      })}
      onClose={onClose}
    >
      <form
        className="room-dialog-body"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {done ? (
          <div className="invite-created" role="status">
            <strong>{t("{0} 正在后台加入 {1}。", { 0: target.name, 1: host })}</strong>
            <span>
              {t(
                "关掉这个窗口也不会掉线。要查看、让它离线或退出房间，到 设置 →「这台电脑」→「带到别处的 Agent」。",
              )}
            </span>
          </div>
        ) : (
          <>
            <div className="room-field">
              <span>{t("在对方房间里的名字")}</span>
              <strong className="join-remote-name">{target.name}</strong>
              <small>{t("名字由对方的邀请决定，这里改不了。")}</small>
            </div>
            <label className="room-field">
              <span>{t("用哪个本机 Agent")}</span>
              {options.length ? (
                <Select
                  value={selected}
                  options={options}
                  onChange={setChoice}
                  aria-label={t("用哪个本机 Agent")}
                  menuMinWidth={320}
                />
              ) : local.enabled === false || local.providers === undefined ? null : (
                <small>
                  {t("这台电脑上还没有可用的 Agent 或运行时，先在「接入 Agent」里装一个。")}
                </small>
              )}
            </label>
            {!canManage && local.enabled !== undefined && (
              <p className="room-dialog-error" role="alert">
                {local.reason ?? t("只有在 Hive 所在的电脑上才能带本机 Agent 加入。")}
              </p>
            )}
          </>
        )}
        {error && (
          <p className="room-dialog-error" role="alert">
            {error}
          </p>
        )}
        {fallback && (
          <div className="invite-created" role="status">
            <strong>{t("本机 Hive 版本较旧，不能在后台加入。可以在终端里运行：")}</strong>
            <code>{command}</code>
            <Button
              size="sm"
              className="invite-created-copy"
              onClick={() =>
                void copyTextToClipboard(command).then(
                  () => setCopied(true),
                  () => setCopied(false),
                )
              }
            >
              {copied ? t("已复制") : t("复制命令")}
            </Button>
          </div>
        )}
        <footer className="room-dialog-footer dialog-actions">
          {done ? (
            <>
              {openLocalSettings && (
                <Button
                  onClick={() => {
                    onClose();
                    openLocalSettings();
                  }}
                >
                  {t("查看带到别处的 Agent")}
                </Button>
              )}
              <Button variant="primary" onClick={onClose}>
                {t("完成")}
              </Button>
            </>
          ) : (
            <>
              <Button onClick={onBack}>{t("返回")}</Button>
              <Button
                type="submit"
                variant="primary"
                disabled={busy || !selected || !canManage || fallback}
              >
                {busy ? t("正在加入…") : t("加入")}
              </Button>
            </>
          )}
        </footer>
      </form>
    </DialogFrame>
  );
}

/** 桌面端侧栏：打开过的别人的服务器，点一下切过去；悬停出现「忘掉」 */
export function RemoteServerList() {
  const remote = desktopBridge()?.remote;
  const [servers, setServers] = useState<DesktopRemoteServer[]>([]);
  const [confirm, setConfirm] = useState<string>();
  useEffect(() => {
    if (!remote) return;
    let alive = true;
    void remote.list().then(
      (list) => alive && setServers(list),
      () => undefined,
    );
    const off = remote.onChange((list) => setServers(list));
    return () => {
      alive = false;
      off();
    };
  }, [remote]);
  if (!remote || servers.length === 0) return null;
  return (
    <div className="remote-servers" role="group" aria-label={t("别人的服务器")}>
      <div className="remote-servers-title">{t("别人的服务器")}</div>
      {servers.map((server) => (
        <div key={server.origin} className="remote-server">
          <Tooltip content={t("在单独的窗口里打开 {0}", { 0: server.url })}>
            <button
              type="button"
              className="remote-server-open"
              onClick={() => void remote.open(server.url)}
            >
              <Icon name="external" size={14} />
              <span className="remote-server-host">{server.host}</span>
              {server.open && (
                <span className="remote-server-open-dot" aria-label={t("窗口已打开")} />
              )}
            </button>
          </Tooltip>
          {confirm === server.origin ? (
            <span className="remote-server-confirm">
              <Button size="sm" onClick={() => setConfirm(undefined)}>
                {t("取消")}
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={() => {
                  setConfirm(undefined);
                  void remote.remove(server.origin);
                }}
              >
                {t("忘掉")}
              </Button>
            </span>
          ) : (
            <IconButton
              className="remote-server-remove"
              label={t("忘掉 {0}（关掉窗口，清掉在那里的访客身份）", { 0: server.host })}
              onClick={() => setConfirm(server.origin)}
            >
              <Icon name="close" size={13} />
            </IconButton>
          )}
        </div>
      ))}
    </div>
  );
}
