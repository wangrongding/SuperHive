import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import type {
  McpCatalog,
  McpCatalogCategory,
  McpCatalogEntry,
  RuntimeCredentialProvider,
  RuntimeInstallPlan,
  RuntimeInstallResult,
  RuntimeOverview,
} from "@superhive/protocol";
import { Button, IconButton } from "./button";
import { getLocale, t } from "./i18n";
import { LocalApiError, type LocalAgentsState } from "./local-agents";
import { RUNTIME_LABELS } from "./runtime-credentials";

/**
 * 「MCP 与技能」里的「发现 / 安装」：应用商店式卡片，点「安装」从右边滑出一个抽屉，一屏装完。
 *
 * - 抽屉只问必须的：要密钥的给一个输入框和「去哪拿这个密钥」；其它都默认好（装进所有支持且本机有的 CLI）。
 * - 后台照旧走服务端的「先预览、再按同一份计划写」：点「安装」时先 preview 再 apply，用户看不到计划这一步；
 *   计划在中间失效（配置文件刚好被改了）就自动重新预览一次。
 * - 会执行的命令、连的网址、要改的文件、要重启的 Agent 都收在默认折叠的「详细信息」里。
 * - 装好后可以一键重启用到这些 CLI 的 Agent：逐个调用现有的重启接口，正在干活的跳过并说明。
 * - 填的密钥只在这个抽屉的内存里，装完或关掉就清掉。
 */

export type RuntimeStoreApi = Pick<
  LocalAgentsState,
  | "runtimeOverview"
  | "runtimeInstallCatalog"
  | "previewRuntimeInstall"
  | "applyRuntimeInstall"
  | "agents"
  | "refreshAgents"
  | "act"
>;

type Provider = RuntimeOverview["providers"][number];

const errorMessage = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);

const local = (text: { zh: string; en: string }) => (getLocale() === "en" ? text.en : text.zh);

const CATEGORIES: Array<{ id: McpCatalogCategory | "all"; label: string }> = [
  { id: "all", label: "全部" },
  { id: "browser", label: "浏览器" },
  { id: "code", label: "代码与 Git" },
  { id: "docs", label: "文档与搜索" },
  { id: "design", label: "设计" },
  { id: "other", label: "其它" },
];

/** 卡片图标：品牌名的首字母放在按名字挑出颜色的方块里，不引入外部图片 */
function initials(title: string) {
  const words = title.split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0]![0]! + words[1]![0]! : title[0]!).toUpperCase();
}
/** 十个分得开的色相，按 id 散列挑一个 */
const HUES = [212, 262, 330, 8, 28, 45, 145, 172, 190, 290];
function hue(id: string) {
  let value = 0;
  for (const char of id) value = (value * 31 + char.charCodeAt(0)) >>> 0;
  return HUES[value % HUES.length]!;
}

export function StoreIcon({ entry, large }: { entry: McpCatalogEntry; large?: boolean }) {
  return (
    <span
      className={`runtime-store-icon${large ? " large" : ""}`}
      style={{ "--store-hue": hue(entry.id) } as CSSProperties}
      aria-hidden="true"
    >
      {initials(entry.title)}
    </span>
  );
}

const needsKey = (entry: McpCatalogEntry) =>
  entry.params.some((param) => param.kind === "secret" && param.required);

/** 卡片上的标签：免费 / 需要密钥，再加条目自己的（例如「需要 Figma 桌面版」） */
function tags(entry: McpCatalogEntry) {
  const list = [needsKey(entry) ? t("需要密钥") : t("免费")];
  if (entry.badge) list.push(local(entry.badge));
  return list;
}

/** 这个 MCP 已经在哪些 CLI 里（按名字对） */
function installedIn(entry: McpCatalogEntry, overview: RuntimeOverview) {
  return new Set(
    overview.mcp.find((row) => row.name === entry.name)?.entries.map((item) => item.provider) ?? [],
  );
}

/** 每个 CLI 能不能装；不能时给一句人话原因 */
export function targetState(
  entry: McpCatalogEntry,
  info: Provider,
  overview: RuntimeOverview,
): { ok: true } | { ok: false; reason: string; installed?: boolean } {
  const where = RUNTIME_LABELS[info.provider];
  if (!info.mcpSupported || !entry.runtimes.includes(info.provider)) {
    return { ok: false, reason: t("{0} 用不了这个", { 0: where }) };
  }
  if (installedIn(entry, overview).has(info.provider)) {
    return { ok: false, reason: t("{0} 里已经装好了", { 0: where }), installed: true };
  }
  return { ok: true };
}

export function McpStore({ api }: { api: RuntimeStoreApi }) {
  const [catalog, setCatalog] = useState<McpCatalog>();
  const [overview, setOverview] = useState<RuntimeOverview>();
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<McpCatalogCategory | "all">("all");
  const [open, setOpen] = useState<McpCatalogEntry>();
  const { runtimeInstallCatalog, runtimeOverview } = api;

  useEffect(() => {
    Promise.all([runtimeInstallCatalog(), runtimeOverview()]).then(
      ([nextCatalog, nextOverview]) => {
        setCatalog(nextCatalog);
        setOverview(nextOverview);
      },
      (reason: unknown) => setError(errorMessage(reason)),
    );
  }, [runtimeInstallCatalog, runtimeOverview]);

  const shown = useMemo(() => {
    if (!catalog) return [];
    const needle = query.trim().toLowerCase();
    return catalog.entries.filter((entry) => {
      if (category !== "all" && (entry.category ?? "other") !== category) return false;
      if (!needle) return true;
      return [
        entry.title,
        entry.publisher,
        local(entry.tagline ?? entry.description),
        local(entry.description),
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [catalog, category, query]);

  if (!catalog || !overview) {
    return error ? (
      <p className="settings-note error" role="alert">
        {error}
      </p>
    ) : (
      <p className="settings-note">{t("正在读取…")}</p>
    );
  }

  return (
    <div className="runtime-store">
      <div className="runtime-store-bar">
        <input
          type="search"
          className="runtime-store-search"
          aria-label={t("搜索")}
          placeholder={t("搜索，例如：浏览器、GitHub、文档")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="runtime-store-categories" role="group" aria-label={t("分类")}>
          {CATEGORIES.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={category === item.id}
              onClick={() => setCategory(item.id)}
            >
              {t(item.label)}
            </button>
          ))}
        </div>
      </div>
      {shown.length === 0 ? (
        <p className="runtime-store-empty">{t("没有找到，换个词试试。")}</p>
      ) : (
        <ul className="runtime-store-grid" aria-label={t("可以安装的 MCP")}>
          {shown.map((entry) => {
            const have = installedIn(entry, overview);
            const more = overview.providers.some((info) => targetState(entry, info, overview).ok);
            return (
              <li key={entry.id} className="runtime-store-card">
                <div className="runtime-store-card-head">
                  <StoreIcon entry={entry} />
                  <div>
                    <h4>{entry.title}</h4>
                    <small>{entry.publisher}</small>
                  </div>
                </div>
                <p>{local(entry.tagline ?? entry.description)}</p>
                <div className="runtime-store-tags">
                  {tags(entry).map((tag) => (
                    <span key={tag}>{tag}</span>
                  ))}
                </div>
                <div className="runtime-store-card-foot">
                  {have.size > 0 ? (
                    <span className="runtime-store-installed">
                      {t("已安装到 {0} 个 CLI", { 0: have.size })}
                    </span>
                  ) : (
                    <span />
                  )}
                  {more ? (
                    <Button
                      size="sm"
                      variant={have.size > 0 ? "secondary" : "primary"}
                      aria-label={t("安装 {0}", { 0: entry.title })}
                      onClick={() => setOpen(entry)}
                    >
                      {have.size > 0 ? t("装到更多 CLI") : t("安装")}
                    </Button>
                  ) : (
                    have.size === 0 && (
                      <span className="runtime-store-installed">
                        {t("这台电脑上的 CLI 都用不了")}
                      </span>
                    )
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <p className="runtime-store-foot">
        {t(
          "这些都是常用、可靠的 MCP，版本跟着 Hive 一起更新。装好后和手动添加的一样，可以在「已安装」里开关。",
        )}
      </p>
      {open && (
        <InstallDrawer
          key={open.id}
          api={api}
          entry={open}
          overview={overview}
          onInstalled={setOverview}
          onClose={() => setOpen(undefined)}
        />
      )}
    </div>
  );
}

type RestartLine = { name: string; text: string; tone: "ok" | "skip" | "error" };

export function InstallDrawer({
  api,
  entry,
  overview,
  onInstalled,
  onClose,
}: {
  api: RuntimeStoreApi;
  entry: McpCatalogEntry;
  overview: RuntimeOverview;
  onInstalled: (overview: RuntimeOverview) => void;
  onClose: () => void;
}) {
  const [params, setParams] = useState<Record<string, string>>({});
  // 只按打开时的状态算：装完以后 overview 变了，抽屉里的勾选不要跟着变
  const [states] = useState(() =>
    overview.providers.map((info) => ({ info, state: targetState(entry, info, overview) })),
  );
  const available = states.filter((item) => item.state.ok).map((item) => item.info.provider);
  const hidden = states.filter((item) => !item.state.ok);
  const [targets, setTargets] = useState<RuntimeCredentialProvider[]>(available);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<{ result: RuntimeInstallResult; plan: RuntimeInstallPlan }>();
  const [restarts, setRestarts] = useState<RestartLine[]>();
  const [restarting, setRestarting] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  // 重启前刷新过的 Agent 列表要从最新一次渲染里读
  const apiRef = useRef(api);
  apiRef.current = api;

  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>("input, button.btn-primary")?.focus();
  }, []);

  const missing = entry.params.some((param) => param.required && !params[param.id]?.trim());
  const hasSecret = entry.params.some(
    (param) => param.kind === "secret" && params[param.id]?.trim(),
  );
  const canInstall = !busy && !missing && targets.length > 0;

  const install = async () => {
    setBusy(true);
    setError(undefined);
    const request = {
      recipeId: entry.id,
      name: entry.name,
      params: Object.fromEntries(
        Object.entries(params)
          .map(([key, value]) => [key, value.trim()] as const)
          .filter(([, value]) => value),
      ),
      targets,
    };
    try {
      let plan = await api.previewRuntimeInstall(request);
      let result: RuntimeInstallResult;
      try {
        result = await api.applyRuntimeInstall({ ...request, planId: plan.id });
      } catch (reason) {
        // 预览和写入之间配置文件刚好被改了：重新预览一次再写，用户不用管
        if (!(reason instanceof LocalApiError && reason.status === 409)) throw reason;
        plan = await api.previewRuntimeInstall(request);
        result = await api.applyRuntimeInstall({ ...request, planId: plan.id });
      }
      setDone({ result, plan });
      onInstalled(result.overview);
      // 写完就清掉内存里的密钥
      setParams({});
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const okProviders = new Set(
    done?.result.results.filter((item) => item.ok).map((item) => item.provider) ?? [],
  );
  const failed = done?.result.results.filter((item) => !item.ok) ?? [];
  const agentsToRestart = done
    ? [
        ...new Map(
          done.plan.targets
            .filter((target) => okProviders.has(target.provider))
            .flatMap((target) => target.agents)
            .map((agent) => [agent.id, agent]),
        ).values(),
      ]
    : [];
  const runningToRestart = agentsToRestart.filter(
    (agent) => agent.status === "running" || agent.status === "starting",
  );

  const restartAll = async () => {
    setRestarting(true);
    // 拿不到最新状态就按手上的；重启接口本身也是等它忙完才重启，不会打断正在做的事
    await api.refreshAgents().catch(() => undefined);
    const lines: RestartLine[] = [];
    for (const agent of runningToRestart) {
      const current = apiRef.current.agents.find((item) => item.id === agent.id);
      if (current?.busy) {
        lines.push({
          name: agent.name,
          tone: "skip",
          text: t("正在干活，先跳过了。等它忙完再点一次，或到它的设置里重启。"),
        });
        continue;
      }
      try {
        await api.act(agent.id, "restart");
        lines.push({ name: agent.name, tone: "ok", text: t("正在重启") });
      } catch (reason) {
        lines.push({
          name: agent.name,
          tone: "error",
          text: t("没能重启：{0}", { 0: errorMessage(reason) }),
        });
      }
    }
    setRestarts(lines);
    setRestarting(false);
  };

  const close = () => {
    setParams({});
    onClose();
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Esc 先收起抽屉，不关整个面板
    if (event.key === "Escape" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };

  return (
    <div className="runtime-drawer-layer">
      <button
        type="button"
        className="runtime-drawer-scrim"
        aria-label={t("关闭")}
        onClick={close}
      />
      <div
        ref={panelRef}
        className="runtime-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={t("安装 {0}", { 0: entry.title })}
        onKeyDown={handleKeyDown}
      >
        <header className="runtime-drawer-head">
          <StoreIcon entry={entry} large />
          <div>
            <h3>{entry.title}</h3>
            <small>{entry.publisher}</small>
          </div>
          <IconButton className="runtime-drawer-close" label={t("关闭")} onClick={close}>
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </IconButton>
        </header>
        <div className="runtime-drawer-body">
          <p className="runtime-drawer-desc">{local(entry.description)}</p>
          {done ? (
            <InstallDone
              result={done.result}
              failed={failed}
              agents={runningToRestart.map((agent) => agent.name)}
              restarts={restarts}
              restarting={restarting}
              onRestart={() => void restartAll()}
            />
          ) : (
            <form
              id={`install-${entry.id}`}
              className="runtime-drawer-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (canInstall) void install();
              }}
            >
              {entry.requires && <p className="runtime-drawer-requires">{local(entry.requires)}</p>}
              <section>
                <h4>{t("需要填的")}</h4>
                {entry.params.length === 0 ? (
                  <p className="runtime-drawer-nothing">{t("不用填任何东西。")}</p>
                ) : (
                  entry.params.map((param) => (
                    <ParamField
                      key={param.id}
                      param={param}
                      value={params[param.id] ?? ""}
                      onChange={(value) =>
                        setParams((current) => ({ ...current, [param.id]: value }))
                      }
                    />
                  ))
                )}
              </section>
              <section>
                <h4>{t("装到哪些 CLI")}</h4>
                {available.length === 0 ? (
                  <p className="runtime-drawer-nothing">{t("这台电脑上没有能装它的 CLI。")}</p>
                ) : (
                  <div
                    className="runtime-drawer-targets"
                    role="group"
                    aria-label={t("装到哪些 CLI")}
                  >
                    {available.map((provider) => (
                      <button
                        key={provider}
                        type="button"
                        role="switch"
                        aria-checked={targets.includes(provider)}
                        onClick={() =>
                          setTargets((current) =>
                            current.includes(provider)
                              ? current.filter((item) => item !== provider)
                              : [...current, provider],
                          )
                        }
                      >
                        {RUNTIME_LABELS[provider]}
                      </button>
                    ))}
                  </div>
                )}
                {hidden.length > 0 && (
                  <details className="runtime-drawer-why">
                    <summary>
                      {t("为什么没有 {0}", {
                        0: hidden.map((item) => RUNTIME_LABELS[item.info.provider]).join("、"),
                      })}
                    </summary>
                    <ul>
                      {hidden.map((item) => (
                        <li key={item.info.provider}>{!item.state.ok && item.state.reason}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </section>
              <Details entry={entry} targets={targets} agents={api.agents} />
            </form>
          )}
          {error && (
            <p className="runtime-drawer-error" role="alert">
              {t("没装上：{0}", { 0: error })}
            </p>
          )}
        </div>
        <footer className="runtime-drawer-foot">
          {done ? (
            <Button variant="primary" onClick={close}>
              {t("完成")}
            </Button>
          ) : (
            <>
              {hasSecret && (
                <p className="runtime-drawer-note">
                  {t("密钥会按各 CLI 自己的方式存进它们的配置文件，Hive 不会另外保存。")}
                </p>
              )}
              <Button
                variant="primary"
                type="submit"
                form={`install-${entry.id}`}
                disabled={!canInstall}
                loading={busy}
              >
                {t("安装")}
              </Button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

function ParamField({
  param,
  value,
  onChange,
}: {
  param: McpCatalogEntry["params"][number];
  value: string;
  onChange: (value: string) => void;
}) {
  const label = local(param.label);
  return (
    <label className="runtime-drawer-field">
      <span>
        {label}
        {param.required && <em aria-hidden="true"> *</em>}
      </span>
      {param.kind === "paths" ? (
        <textarea
          rows={3}
          value={value}
          spellCheck={false}
          placeholder={param.placeholder}
          required={param.required}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          type={param.kind === "secret" ? "password" : "text"}
          value={value}
          spellCheck={false}
          autoComplete={param.kind === "secret" ? "new-password" : "off"}
          placeholder={param.placeholder}
          required={param.required}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {param.help && <small>{local(param.help)}</small>}
      {param.getUrl && (
        <a href={param.getUrl} target="_blank" rel="noreferrer noopener">
          {t("去哪拿这个密钥 ↗")}
        </a>
      )}
    </label>
  );
}

/** 默认折叠：以后会运行的命令或连接的网址、会改哪些 CLI 的配置、哪些 Agent 要重启 */
function Details({
  entry,
  targets,
  agents,
}: {
  entry: McpCatalogEntry;
  targets: RuntimeCredentialProvider[];
  agents: LocalAgentsState["agents"];
}) {
  // 停着的 Agent 下次启动自然会用上，不算要重启的
  const names = agents
    .filter(
      (agent) =>
        (targets as string[]).includes(agent.provider) &&
        (agent.status === "running" || agent.status === "starting"),
    )
    .map((agent) => agent.name);
  return (
    <details className="runtime-drawer-details">
      <summary>{t("详细信息")}</summary>
      <dl>
        {entry.command ? (
          <>
            <dt>{t("以后 CLI 用它时会运行")}</dt>
            <dd>
              <code>{[entry.command, ...(entry.args ?? [])].join(" ")}</code>
              <small>{t("现在不会运行任何东西；第一次用时会自动下载这个版本。")}</small>
            </dd>
          </>
        ) : (
          <>
            <dt>{t("会连接的网址")}</dt>
            <dd>
              <code>{entry.url}</code>
            </dd>
          </>
        )}
        <dt>{t("会改的设置")}</dt>
        <dd>
          {targets.length
            ? t("在 {0} 的配置文件里各加一项，原文件先备份；同名的不会覆盖。", {
                0: targets.map((provider) => RUNTIME_LABELS[provider]).join("、"),
              })
            : t("还没选 CLI")}
        </dd>
        <dt>{t("要重启才会用上的 Agent")}</dt>
        <dd>{names.length ? names.join("、") : t("没有")}</dd>
        <dt>{t("说明")}</dt>
        <dd>
          <a href={entry.docs} target="_blank" rel="noreferrer noopener">
            {t("{0} 的官方说明 ↗", { 0: entry.publisher })}
          </a>
        </dd>
      </dl>
    </details>
  );
}

function InstallDone({
  result,
  failed,
  agents,
  restarts,
  restarting,
  onRestart,
}: {
  result: RuntimeInstallResult;
  failed: RuntimeInstallResult["results"];
  agents: string[];
  restarts: RestartLine[] | undefined;
  restarting: boolean;
  onRestart: () => void;
}) {
  const ok = result.results.filter((item) => item.ok);
  return (
    <div className="runtime-drawer-done" role="status">
      {ok.length > 0 && (
        <div className="runtime-drawer-success">
          <strong>
            {t("已装好：{0}", { 0: ok.map((item) => RUNTIME_LABELS[item.provider]).join("、") })}
          </strong>
          <p>
            {agents.length
              ? t("重启这些 Agent 后生效：{0}", { 0: agents.join("、") })
              : t("以后新启动的 Agent 和终端里新开的 CLI 会自动用上。")}
          </p>
          {agents.length > 0 && !restarts && (
            <Button variant="primary" loading={restarting} onClick={onRestart}>
              {t("现在重启它们")}
            </Button>
          )}
          {restarts && (
            <ul className="runtime-drawer-restarts">
              {restarts.map((line) => (
                <li key={line.name} className={line.tone}>
                  <strong>{line.name}</strong> {line.text}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {failed.map((item) => (
        <div key={item.provider} className="runtime-drawer-failed">
          <strong>{t("{0} 没装上", { 0: RUNTIME_LABELS[item.provider] })}</strong>
          <p>{item.error ?? t("原因不明")}</p>
          <p>
            {item.file
              ? t("看看这个文件能不能改：{0}，改好后再点一次安装。", { 0: item.file })
              : t("稍后再点一次安装试试；还不行就到「已安装」里手动添加。")}
          </p>
        </div>
      ))}
    </div>
  );
}
