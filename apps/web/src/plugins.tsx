import { useCallback, useEffect, useRef, useState } from "react";
import { confirmAction } from "./confirm-dialog";
import type {
  LocalPlugin,
  PluginContext,
  PluginMcpProvider,
  PluginPermission,
  PluginSummary,
} from "@superhive/protocol";
import { agentProviderLabel } from "./agent-setup";
import { Button } from "./button";
import { DocsLink } from "./docs-link";
import { localized, t } from "./i18n";
import { createPluginHost, type PluginHostApi } from "./plugin-host";
import "./styles/plugins.css";

/**
 * 插件（docs/research/plugin-system.md 第一阶段）在网页上的三处：
 * - 右侧栏「插件」标签页：已批准插件的面板，跑在无同源的 sandbox iframe 里，只能经 postMessage 网关调宿主；
 * - 输入框的 /命令：交给声明它的面板处理，结果只填进输入框；
 * - 设置 ·「插件」：本机房主列出、批准、撤销，逐个确认 MCP 写进哪些运行时。
 */

/** 权限说明：设置页和面板头部共用，房主批准前看得懂每条意味着什么 */
export const pluginPermissionText: Record<PluginPermission, { label: string; detail: string }> =
  localized(() => ({
    "room:read": {
      label: t("读取当前房间的消息"),
      detail: t("面板打开期间，读你在这个房间能看到的最近 50 条消息。"),
    },
    "members:read": {
      label: t("读取房间成员"),
      detail: t("成员的名字、是人还是 Agent、是否在线。"),
    },
    "composer:write": {
      label: t("往输入框里填文字"),
      detail: t("只填进输入框，发不发由你决定；插件不能替你发消息。"),
    },
  }));

export type PluginPanelKey = `${string}/${string}`;
export const pluginPanelKey = (pluginId: string, panelId: string): PluginPanelKey =>
  `${pluginId}/${panelId}`;

/** 当前房间能用的插件；旧版 Server、关掉插件时没有这个接口，当作没有插件 */
export function useRoomPlugins({
  base,
  authToken,
  roomId,
  version,
}: {
  base: string;
  authToken: string | undefined;
  roomId: string;
  /** 收到 plugins.changed 时加一，重新取 */
  version: number;
}): PluginSummary[] {
  const [plugins, setPlugins] = useState<PluginSummary[]>([]);
  useEffect(() => {
    if (!authToken) {
      setPlugins([]);
      return;
    }
    let cancelled = false;
    fetch(`${base}/api/rooms/${encodeURIComponent(roomId)}/plugins`, {
      headers: { Authorization: `Bearer ${authToken}` },
    })
      .then(async (response) => {
        if (!response.ok) return [];
        return ((await response.json()) as { plugins?: PluginSummary[] }).plugins ?? [];
      })
      .catch(() => [] as PluginSummary[])
      .then((next) => {
        if (!cancelled) setPlugins(next);
      });
    return () => {
      cancelled = true;
    };
  }, [base, authToken, roomId, version]);
  return plugins;
}

/** 斜杠命令交给面板：nonce 让同一条命令连着输两次也会再送一次 */
export type PluginCommandDispatch = {
  key: PluginPanelKey;
  name: string;
  args: string;
  nonce: number;
};

/** 右侧栏「插件」标签页的内容：多个面板时上面一排切换，下面是当前面板 */
export function PluginSidePanel({
  plugins,
  active,
  setActive,
  command,
  base,
  authToken,
  roomId,
  context,
  api,
}: {
  plugins: PluginSummary[];
  active: PluginPanelKey | undefined;
  setActive: (key: PluginPanelKey) => void;
  command: PluginCommandDispatch | undefined;
  base: string;
  authToken: string | undefined;
  roomId: string;
  context: PluginContext;
  api: Omit<PluginHostApi, "context">;
}) {
  const panels = plugins.flatMap((plugin) =>
    plugin.panels.map((panel) => ({ plugin, panel, key: pluginPanelKey(plugin.id, panel.id) })),
  );
  const current = panels.find((item) => item.key === active) ?? panels[0];
  if (!current)
    return (
      <div className="plugin-side-empty">
        <p>{t("插件已被撤销或停用。")}</p>
      </div>
    );
  return (
    <div className="plugin-side">
      {panels.length > 1 && (
        <div className="plugin-side-switch" role="group" aria-label={t("插件面板")}>
          {panels.map((item) => (
            <button
              key={item.key}
              type="button"
              aria-pressed={item.key === current.key}
              onClick={() => setActive(item.key)}
            >
              {item.panel.title}
            </button>
          ))}
        </div>
      )}
      <div className="plugin-side-meta">
        <strong>{current.plugin.name}</strong>
        <small>
          {current.plugin.permissions.length
            ? current.plugin.permissions
                .map((permission) => pluginPermissionText[permission].label)
                .join(" · ")
            : t("没有申请任何权限")}
        </small>
      </div>
      <PluginFrame
        key={`${current.key}@${current.plugin.version}:${current.plugin.permissions.join(",")}`}
        plugin={current.plugin}
        panelId={current.panel.id}
        title={current.panel.title}
        command={command?.key === current.key ? command : undefined}
        base={base}
        authToken={authToken}
        roomId={roomId}
        context={context}
        api={api}
      />
    </div>
  );
}

function PluginFrame({
  plugin,
  panelId,
  title,
  command,
  base,
  authToken,
  roomId,
  context,
  api,
}: {
  plugin: PluginSummary;
  panelId: string;
  title: string;
  command: PluginCommandDispatch | undefined;
  base: string;
  authToken: string | undefined;
  roomId: string;
  context: PluginContext;
  api: Omit<PluginHostApi, "context">;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState<string>();
  const hostRef = useRef<ReturnType<typeof createPluginHost>>(undefined);
  const loadedRef = useRef(false);
  const deliveredRef = useRef<number>(undefined);
  const commandRef = useRef(command);
  commandRef.current = command;
  // 网关每次请求都现取最新的数据和上下文，不用随渲染重建
  const apiRef = useRef(api);
  apiRef.current = api;
  const contextRef = useRef(context);
  contextRef.current = context;

  // iframe 带不了 Authorization 头：先凭登录换一个限时地址，面板和它的脚本、样式都从这个前缀取
  useEffect(() => {
    if (!authToken) return;
    let cancelled = false;
    setUrl(undefined);
    setError(undefined);
    fetch(
      `${base}/api/rooms/${encodeURIComponent(roomId)}/plugins/${encodeURIComponent(plugin.id)}/panels/${encodeURIComponent(panelId)}/frame`,
      { method: "POST", headers: { Authorization: `Bearer ${authToken}` } },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error(t("插件面板打不开（{0}）", { 0: response.status }));
        return ((await response.json()) as { url: string }).url;
      })
      .then(
        (next) => !cancelled && setUrl(`${base}${next}`),
        (reason: unknown) =>
          !cancelled && setError(reason instanceof Error ? reason.message : String(reason)),
      );
    return () => {
      cancelled = true;
    };
  }, [base, authToken, roomId, plugin.id, panelId]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || !url) return;
    loadedRef.current = false;
    const host = createPluginHost({
      frame,
      plugin,
      api: {
        context: () => contextRef.current,
        messages: (limit) => apiRef.current.messages(limit),
        members: () => apiRef.current.members(),
        insertIntoComposer: (text) => apiRef.current.insertIntoComposer(text),
      },
    });
    hostRef.current = host;
    return () => {
      host.dispose();
      hostRef.current = undefined;
    };
    // plugin 换了权限或版本时外层 key 会变，整个 iframe 重建
  }, [url]);

  const deliver = useCallback(() => {
    const next = commandRef.current;
    if (!next || !loadedRef.current || deliveredRef.current === next.nonce) return;
    deliveredRef.current = next.nonce;
    hostRef.current?.dispatchCommand(next.name, next.args);
  }, []);
  useEffect(deliver, [command, deliver]);

  // 主题、语言变了告诉面板
  const contextKey = `${context.roomId}|${context.locale}|${context.theme}|${context.viewer}`;
  useEffect(() => {
    if (loadedRef.current) hostRef.current?.dispatchContext(contextRef.current);
  }, [contextKey]);

  if (error)
    return (
      <p className="plugin-side-error" role="alert">
        {error}
      </p>
    );
  if (!url) return <div className="plugin-side-loading" aria-busy="true" />;
  return (
    <iframe
      ref={frameRef}
      className="plugin-frame"
      title={t("插件面板：{0}", { 0: title })}
      src={url}
      // 和响应头里的 CSP sandbox 双保险：不给 allow-same-origin，面板是不透明源
      sandbox="allow-scripts allow-forms"
      referrerPolicy="no-referrer"
      allow=""
      onLoad={() => {
        loadedRef.current = true;
        hostRef.current?.dispatchContext(contextRef.current);
        deliver();
      }}
    />
  );
}

/* ---------------- 设置 · 插件 ---------------- */

export type LocalPluginsApi = {
  plugins(): Promise<{ dir: string; mcpProviders: PluginMcpProvider[]; plugins: LocalPlugin[] }>;
  grantPlugin(id: string): Promise<LocalPlugin>;
  revokePlugin(id: string): Promise<void>;
  setPluginMcp(id: string, name: string, providers: PluginMcpProvider[]): Promise<LocalPlugin>;
};

const stateText: Record<LocalPlugin["state"], string> = localized(() => ({
  enabled: t("已启用"),
  "needs-approval": t("待批准"),
  invalid: t("不能加载"),
}));

/** 设置 · 插件：只给页面开在 Server 所在电脑上的本机房主（接口也只认本机） */
export function PluginsSettingsPanel({ api }: { api: LocalPluginsApi }) {
  const [data, setData] = useState<Awaited<ReturnType<LocalPluginsApi["plugins"]>>>();
  const [loadError, setLoadError] = useState<string>();
  const [acting, setActing] = useState<string>();
  const [message, setMessage] = useState<{ error: boolean; text: string }>();

  const refresh = useCallback(
    () =>
      api.plugins().then(
        (next) => {
          setData(next);
          setLoadError(undefined);
        },
        (reason: unknown) =>
          setLoadError(
            (reason as { status?: number }).status === 404
              ? t("这台 Server 没有开放插件（旧版本，或设置了 HIVE_PLUGINS=0）。")
              : reason instanceof Error
                ? reason.message
                : String(reason),
          ),
      ),
    [api],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = (id: string, action: () => Promise<string | undefined>) => {
    setActing(id);
    setMessage(undefined);
    action()
      .then((text) => text && setMessage({ error: false, text }))
      .catch((reason: unknown) =>
        setMessage({
          error: true,
          text: reason instanceof Error ? reason.message : String(reason),
        }),
      )
      .finally(() => {
        setActing(undefined);
        void refresh();
      });
  };

  return (
    <section id="settings-panel-plugins" role="tabpanel" aria-label={t("插件")}>
      <div className="settings-panel-heading">
        <h3>{t("插件")}</h3>
        <p>
          {t(
            "插件可以在右侧栏加一个面板、在输入框加 / 命令、给本机 Agent 加 MCP 工具。默认什么权限都没有，你批准后才生效，随时可以撤销。",
          )}{" "}
          <DocsLink to="plugins">{t("插件开发")}</DocsLink>
        </p>
      </div>
      {loadError && <p className="settings-note error">{loadError}</p>}
      {data && (
        <p className="settings-note">
          {t("插件目录：{0}。把插件文件夹放进去，回到这里刷新就能看到。", { 0: data.dir })}{" "}
          <Button size="sm" variant="link" onClick={() => void refresh()}>
            {t("刷新")}
          </Button>
        </p>
      )}
      {data && data.plugins.length === 0 && (
        <p className="settings-note plugin-empty">
          {t("还没有插件。示例插件在仓库的 examples/plugins/dice，复制到插件目录试试。")}
        </p>
      )}
      {data && data.plugins.length > 0 && (
        <ul className="plugin-list" aria-label={t("插件")}>
          {data.plugins.map((plugin) => (
            <PluginRow
              key={plugin.id}
              plugin={plugin}
              providers={data.mcpProviders}
              busy={acting === plugin.id}
              onGrant={() =>
                run(plugin.id, async () => {
                  await api.grantPlugin(plugin.id);
                  return t("已批准 {0}。", { 0: plugin.name ?? plugin.id });
                })
              }
              onRevoke={async () => {
                const confirmed = await confirmAction({
                  title: t("撤销 {0}？", { 0: plugin.name ?? plugin.id }),
                  message: t("打开着的面板会关掉，/ 命令失效，它写进运行时的 MCP 也会删掉。"),
                  confirmLabel: t("撤销"),
                  danger: true,
                });
                if (!confirmed) return;
                run(plugin.id, async () => {
                  await api.revokePlugin(plugin.id);
                  return t("已撤销 {0}。", { 0: plugin.name ?? plugin.id });
                });
              }}
              onSetMcp={(name, providers) =>
                run(plugin.id, async () => {
                  await api.setPluginMcp(plugin.id, name, providers);
                  return providers.length
                    ? t("已把 {0} 写进 {1} 的 MCP 配置，Agent 下一轮会话起生效。", {
                        0: name,
                        1: providers.map(agentProviderLabel).join("、"),
                      })
                    : t("已从所有运行时移除 {0}。", { 0: name });
                })
              }
            />
          ))}
        </ul>
      )}
      {message && (
        <p className={`settings-note${message.error ? " error" : ""}`} role="status">
          {message.text}
        </p>
      )}
    </section>
  );
}

function PluginRow({
  plugin,
  providers,
  busy,
  onGrant,
  onRevoke,
  onSetMcp,
}: {
  plugin: LocalPlugin;
  providers: PluginMcpProvider[];
  busy: boolean;
  onGrant: () => void;
  onRevoke: () => void;
  onSetMcp: (name: string, providers: PluginMcpProvider[]) => void;
}) {
  const added = plugin.grant
    ? plugin.requested.filter((permission) => !plugin.grant!.permissions.includes(permission))
    : [];
  const headingId = `plugin-${plugin.id}`;
  return (
    <li className={`plugin-row ${plugin.state}`} aria-labelledby={headingId}>
      <div className="plugin-row-head">
        <span className="plugin-row-title">
          <strong id={headingId}>{plugin.name ?? plugin.id}</strong>
          {plugin.version && <small>v{plugin.version}</small>}
          {plugin.author && <small>{plugin.author}</small>}
        </span>
        <span className={`plugin-state ${plugin.state}`}>{stateText[plugin.state]}</span>
      </div>
      {plugin.description && <p className="plugin-row-desc">{plugin.description}</p>}
      {plugin.state === "invalid" ? (
        <p className="settings-note error">{plugin.problem}</p>
      ) : (
        <>
          <dl className="plugin-facts">
            <dt>{t("申请的权限")}</dt>
            <dd>
              {plugin.requested.length === 0 ? (
                t("不申请任何权限")
              ) : (
                <ul className="plugin-permissions">
                  {plugin.requested.map((permission) => (
                    <li key={permission} className={added.includes(permission) ? "added" : ""}>
                      <strong>{pluginPermissionText[permission].label}</strong>
                      {added.includes(permission) && (
                        <span className="plugin-added">{t("新增")}</span>
                      )}
                      <small>{pluginPermissionText[permission].detail}</small>
                    </li>
                  ))}
                </ul>
              )}
            </dd>
            {(plugin.panels?.length ?? 0) + (plugin.commands?.length ?? 0) > 0 && (
              <>
                <dt>{t("提供")}</dt>
                <dd>
                  {[
                    ...(plugin.panels ?? []).map((panel) =>
                      t("侧栏面板「{0}」", { 0: panel.title }),
                    ),
                    ...(plugin.commands ?? []).map((command) => `/${command.name}`),
                  ].join(" · ")}
                </dd>
              </>
            )}
            <dt>{t("谁能看到")}</dt>
            <dd>{plugin.guests ? t("你和凭邀请进来的访客") : t("只有你（访客看不到）")}</dd>
          </dl>
          {plugin.state === "needs-approval" && added.length > 0 && (
            <p className="settings-note warning">
              {t("新版本多申请了权限，重新批准前整个插件停用。")}
            </p>
          )}
          <div className="plugin-row-actions">
            {plugin.state === "needs-approval" && (
              <Button size="sm" variant="primary" disabled={busy} onClick={onGrant}>
                {plugin.grant ? t("重新批准") : t("批准")}
              </Button>
            )}
            {plugin.grant && (
              <Button size="sm" tone="danger" disabled={busy} onClick={onRevoke}>
                {t("撤销")}
              </Button>
            )}
          </div>
          {plugin.mcpServers.length > 0 && (
            <div className="plugin-mcp">
              <h5>{t("给本机 Agent 的 MCP 工具")}</h5>
              <p className="settings-note">
                {t(
                  "MCP 会作为本机程序运行，权限和 Agent 一样大。逐个确认要写进哪些运行时的配置；撤销插件时一并删掉。",
                )}
              </p>
              {plugin.mcpServers.map((server) => (
                <PluginMcpRow
                  key={server.name}
                  server={server}
                  providers={providers}
                  disabled={busy || plugin.state !== "enabled"}
                  onSave={(next) => onSetMcp(server.name, next)}
                />
              ))}
              {plugin.state !== "enabled" && (
                <p className="settings-note">{t("先批准插件，再确认 MCP。")}</p>
              )}
            </div>
          )}
        </>
      )}
    </li>
  );
}

function PluginMcpRow({
  server,
  providers,
  disabled,
  onSave,
}: {
  server: LocalPlugin["mcpServers"][number];
  providers: PluginMcpProvider[];
  disabled: boolean;
  onSave: (providers: PluginMcpProvider[]) => void;
}) {
  const [selected, setSelected] = useState<PluginMcpProvider[]>(server.providers);
  useEffect(() => setSelected(server.providers), [server.providers]);
  const dirty =
    server.state === "changed" ||
    selected.length !== server.providers.length ||
    selected.some((provider) => !server.providers.includes(provider));
  return (
    <fieldset className="plugin-mcp-row" disabled={disabled}>
      <legend>
        <code>{server.name}</code>
        <span className={`plugin-state ${server.state}`}>
          {server.state === "confirmed"
            ? t("已确认")
            : server.state === "changed"
              ? t("清单改了命令，要重新确认")
              : t("未确认")}
        </span>
      </legend>
      <p className="plugin-row-desc">{server.description}</p>
      <code className="plugin-mcp-command">{[server.command, ...server.args].join(" ")}</code>
      {providers.length === 0 ? (
        <p className="settings-note">{t("这台 Server 没有管理本机运行时配置，不能写入 MCP。")}</p>
      ) : (
        <div className="plugin-mcp-providers">
          {providers.map((provider) => (
            <label key={provider}>
              <input
                type="checkbox"
                checked={selected.includes(provider)}
                onChange={(event) =>
                  setSelected((current) =>
                    event.target.checked
                      ? [...current, provider]
                      : current.filter((item) => item !== provider),
                  )
                }
              />
              {agentProviderLabel(provider)}
            </label>
          ))}
          <Button size="sm" disabled={!dirty} onClick={() => onSave(selected)}>
            {selected.length ? t("确认写入") : t("全部移除")}
          </Button>
        </div>
      )}
    </fieldset>
  );
}
