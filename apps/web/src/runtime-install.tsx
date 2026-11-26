import { useEffect, useMemo, useState } from "react";
import type {
  McpCatalog,
  McpCatalogEntry,
  RuntimeCredentialProvider,
  RuntimeInstallPlan,
  RuntimeInstallResult,
  RuntimeOverview,
} from "@superhive/protocol";
import { Button } from "./button";
import { getLocale, t } from "./i18n";
import type { LocalAgentsState } from "./local-agents";
import { RUNTIME_LABELS } from "./runtime-credentials";

/**
 * MCP 快速安装向导：从精选清单选一个 → 看它将来会执行的命令或连接的地址、填参数（密钥用私密输入框）、
 * 选写进哪些 CLI → 预览服务端冻结的计划（改哪些文件、哪些 Agent 要重启）→ 确认后按同一份计划写，
 * 分 CLI 报结果。参数和密钥只留在这个组件的内存里，关掉就没了；不重启 Agent，也不试连接。
 */

export type RuntimeInstallApi = Pick<
  LocalAgentsState,
  "runtimeInstallCatalog" | "previewRuntimeInstall" | "applyRuntimeInstall"
>;

type Provider = RuntimeOverview["providers"][number];
type Step = "pick" | "form" | "plan" | "done";

const errorMessage = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);

const local = (text: { zh: string; en: string }) => (getLocale() === "en" ? text.en : text.zh);

const NAME = /^[A-Za-z0-9_.-]{1,64}$/;

/** 这个 CLI 能不能装；不能时给原因（灰掉的勾选框悬停看） */
export function targetBlock(
  entry: McpCatalogEntry,
  info: Provider,
  name: string,
  overview: RuntimeOverview,
): string | undefined {
  const where = RUNTIME_LABELS[info.provider];
  if (!info.mcpSupported) return info.mcpNote ?? t("{0} 不支持全局 MCP", { 0: where });
  if (!entry.runtimes.includes(info.provider)) {
    return t("{0} 不能装进 {1}", { 0: entry.title, 1: where });
  }
  const taken = overview.mcp
    .find((row) => row.name === name)
    ?.entries.some((item) => item.provider === info.provider);
  if (taken) return t("{0} 里已经有叫 {1} 的 MCP，不覆盖", { 0: where, 1: name });
  return undefined;
}

export function InstallMcp({
  api,
  overview,
  onClose,
  onInstalled,
}: {
  api: RuntimeInstallApi;
  overview: RuntimeOverview;
  onClose: () => void;
  onInstalled: (overview: RuntimeOverview) => void;
}) {
  const [catalog, setCatalog] = useState<McpCatalog>();
  const [step, setStep] = useState<Step>("pick");
  const [entry, setEntry] = useState<McpCatalogEntry>();
  const [name, setName] = useState("");
  const [params, setParams] = useState<Record<string, string>>({});
  const [targets, setTargets] = useState<RuntimeCredentialProvider[]>([]);
  const [plan, setPlan] = useState<RuntimeInstallPlan>();
  const [result, setResult] = useState<RuntimeInstallResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [now, setNow] = useState(() => Date.now());
  const { runtimeInstallCatalog } = api;

  useEffect(() => {
    runtimeInstallCatalog().then(setCatalog, (reason: unknown) => setError(errorMessage(reason)));
  }, [runtimeInstallCatalog]);

  // 计划页上倒计时到期就不让确认
  useEffect(() => {
    if (step !== "plan") return;
    const timer = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(timer);
  }, [step]);

  const installedIn = useMemo(
    () => new Map(overview.mcp.map((row) => [row.name, row.entries.length])),
    [overview.mcp],
  );

  const choose = (next: McpCatalogEntry) => {
    setEntry(next);
    setName(next.name);
    setParams({});
    setTargets(
      overview.providers
        .filter((info) => !targetBlock(next, info, next.name, overview))
        .map((info) => info.provider),
    );
    setError(undefined);
    setStep("form");
  };

  const request = () => ({ recipeId: entry!.id, name: name.trim(), params, targets });

  const preview = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setPlan(await api.previewRuntimeInstall(request()));
      setNow(Date.now());
      setStep("plan");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!plan) return;
    setBusy(true);
    setError(undefined);
    try {
      const next = await api.applyRuntimeInstall({ ...request(), planId: plan.id });
      setResult(next);
      onInstalled(next.overview);
      // 写完就清掉内存里的密钥
      setParams({});
      setStep("done");
    } catch (reason) {
      // 计划过期或文件变了：回到上一步重新预览
      setError(errorMessage(reason));
      setPlan(undefined);
      setStep("form");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="runtime-install" aria-label={t("从精选清单安装 MCP")}>
      <div className="runtime-install-head">
        <strong>
          {step === "pick" ? t("从精选清单安装 MCP") : (entry?.title ?? t("从精选清单安装 MCP"))}
        </strong>
        <Button size="sm" variant="ghost" onClick={onClose}>
          {step === "done" ? t("完成") : t("取消")}
        </Button>
      </div>
      {step === "pick" &&
        (catalog ? (
          <>
            <p className="settings-note">
              {t(
                "清单随 Hive 版本发布，每项固定版本，只记怎么装、不存密钥。装完和手动添加的一样，以各 CLI 的配置文件为准。",
              )}
            </p>
            <ul className="runtime-install-list">
              {catalog.entries.map((item) => {
                const count = installedIn.get(item.name) ?? 0;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      className="runtime-install-card"
                      onClick={() => choose(item)}
                    >
                      <span className="runtime-install-title">
                        {item.title}
                        <small>{item.publisher}</small>
                      </span>
                      <span className="runtime-install-desc">{local(item.description)}</span>
                      <span className="runtime-install-tags">
                        <span>{item.transport === "stdio" ? t("本机命令") : t("远程地址")}</span>
                        {item.params.some((param) => param.kind === "secret" && param.required) && (
                          <span>{t("需要密钥")}</span>
                        )}
                        {count > 0 && <span>{t("已在 {0} 个 CLI 里", { 0: count })}</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        ) : (
          !error && <p className="settings-note">{t("正在读取…")}</p>
        ))}
      {step === "form" && entry && (
        <InstallForm
          entry={entry}
          overview={overview}
          name={name}
          params={params}
          targets={targets}
          busy={busy}
          onName={setName}
          onParams={setParams}
          onTargets={setTargets}
          onBack={() => {
            setError(undefined);
            setStep("pick");
          }}
          onPreview={() => void preview()}
        />
      )}
      {step === "plan" && plan && (
        <PlanView
          plan={plan}
          expired={now >= plan.expiresAt}
          busy={busy}
          onBack={() => setStep("form")}
          onConfirm={() => void apply()}
        />
      )}
      {step === "done" && result && plan && <ResultView result={result} plan={plan} />}
      {error && (
        <p className="settings-note error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function InstallForm({
  entry,
  overview,
  name,
  params,
  targets,
  busy,
  onName,
  onParams,
  onTargets,
  onBack,
  onPreview,
}: {
  entry: McpCatalogEntry;
  overview: RuntimeOverview;
  name: string;
  params: Record<string, string>;
  targets: RuntimeCredentialProvider[];
  busy: boolean;
  onName: (name: string) => void;
  onParams: (params: Record<string, string>) => void;
  onTargets: (targets: RuntimeCredentialProvider[]) => void;
  onBack: () => void;
  onPreview: () => void;
}) {
  const trimmed = name.trim();
  const blocks = new Map(
    overview.providers.map((info) => [info.provider, targetBlock(entry, info, trimmed, overview)]),
  );
  const chosen = targets.filter((provider) => !blocks.get(provider));
  const missing = entry.params.some((param) => param.required && !params[param.id]?.trim());
  const valid = NAME.test(trimmed) && chosen.length > 0 && !missing;
  return (
    <form
      className="runtime-install-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) onPreview();
      }}
    >
      <p className="runtime-install-meta">
        {local(entry.description)}{" "}
        <a href={entry.docs} target="_blank" rel="noreferrer noopener">
          {t("{0} 的文档", { 0: entry.publisher })}
        </a>
      </p>
      {entry.requires && <p className="settings-note warning">{local(entry.requires)}</p>}
      <Launch entry={entry} />
      <label>
        <span>{t("名称")}</span>
        <input
          value={name}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => onName(event.target.value)}
        />
      </label>
      {entry.params.map((param) => {
        const value = params[param.id] ?? "";
        const set = (next: string) => onParams({ ...params, [param.id]: next });
        const label = local(param.label);
        return (
          <label key={param.id}>
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
                onChange={(event) => set(event.target.value)}
              />
            ) : (
              <input
                type={param.kind === "secret" ? "password" : "text"}
                value={value}
                spellCheck={false}
                autoComplete={param.kind === "secret" ? "new-password" : "off"}
                placeholder={param.placeholder}
                required={param.required}
                onChange={(event) => set(event.target.value)}
              />
            )}
            {param.help && <small>{local(param.help)}</small>}
          </label>
        );
      })}
      <fieldset className="runtime-overview-targets">
        <legend>{t("写进这些 CLI")}</legend>
        {overview.providers.map((info) => {
          const reason = blocks.get(info.provider);
          return (
            <label key={info.provider} title={reason} className={reason ? "disabled" : undefined}>
              <input
                type="checkbox"
                checked={!reason && targets.includes(info.provider)}
                disabled={Boolean(reason)}
                onChange={(event) =>
                  onTargets(
                    event.target.checked
                      ? [...targets, info.provider]
                      : targets.filter((item) => item !== info.provider),
                  )
                }
              />
              {RUNTIME_LABELS[info.provider]}
              {reason && <span className="sr-only">{reason}</span>}
            </label>
          );
        })}
      </fieldset>
      {[...blocks.values()].some(Boolean) && (
        <ul className="runtime-install-blocked">
          {overview.providers.flatMap((info) => {
            const reason = blocks.get(info.provider);
            return reason ? [<li key={info.provider}>{reason}</li>] : [];
          })}
        </ul>
      )}
      <div className="runtime-install-actions">
        <Button size="sm" onClick={onBack} disabled={busy}>
          {t("返回")}
        </Button>
        <Button size="sm" variant="primary" type="submit" disabled={busy || !valid}>
          {t("预览安装计划")}
        </Button>
      </div>
    </form>
  );
}

/** 选好之前先看：本机命令逐项 argv，远程看地址和请求头名（值要等填完、在计划里打码显示） */
function Launch({ entry }: { entry: McpCatalogEntry }) {
  if (entry.transport === "stdio") {
    return (
      <div className="runtime-install-launch">
        <span>{t("CLI 启动它时会执行（参数逐项）")}</span>
        <ol>
          {[entry.command!, ...(entry.args ?? [])].map((arg, index) => (
            <li key={index}>
              <code>{arg}</code>
            </li>
          ))}
        </ol>
        {entry.env && <small>{t("环境变量：{0}", { 0: Object.keys(entry.env).join(", ") })}</small>}
      </div>
    );
  }
  return (
    <div className="runtime-install-launch">
      <span>{t("连接的远程地址")}</span>
      <code>{entry.url}</code>
      {entry.headers && (
        <small>{t("请求头：{0}", { 0: Object.keys(entry.headers).join(", ") })}</small>
      )}
    </div>
  );
}

function PlanView({
  plan,
  expired,
  busy,
  onBack,
  onConfirm,
}: {
  plan: RuntimeInstallPlan;
  expired: boolean;
  busy: boolean;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const agents = plan.targets.flatMap((target) => target.agents.map((agent) => agent.name));
  const values = [
    ...plan.env.map((item) => ({ ...item, label: t("环境变量") })),
    ...plan.headers.map((item) => ({ ...item, label: t("请求头") })),
  ];
  return (
    <div className="runtime-install-plan">
      <p className="settings-note">
        {t("这是确认后会执行的同一份计划。预览之后参数、目标或配置文件变了，就要重新预览。")}
      </p>
      <dl>
        <dt>{t("名称")}</dt>
        <dd>
          <code>{plan.name}</code>
        </dd>
        {plan.command ? (
          <>
            <dt>{t("CLI 启动它时会执行（参数逐项）")}</dt>
            <dd>
              <ol>
                {[plan.command, ...(plan.args ?? [])].map((arg, index) => (
                  <li key={index}>
                    <code>{arg}</code>
                  </li>
                ))}
              </ol>
            </dd>
          </>
        ) : (
          <>
            <dt>{t("连接的远程地址")}</dt>
            <dd>
              <code>{plan.url}</code>
            </dd>
          </>
        )}
        {values.length > 0 && (
          <>
            <dt>{t("环境变量和请求头")}</dt>
            <dd>
              <ul>
                {values.map((item) => (
                  <li key={`${item.label}:${item.key}`}>
                    {item.label} <code>{item.key}</code> = <code>{item.value}</code>
                  </li>
                ))}
              </ul>
            </dd>
          </>
        )}
        <dt>{t("会改的配置文件")}</dt>
        <dd>
          <ul>
            {plan.targets.map((target) => (
              <li key={target.provider}>
                {RUNTIME_LABELS[target.provider]} <code>{target.file}</code>
                {t("（新增一项，原文件先备份）")}
              </li>
            ))}
          </ul>
        </dd>
        <dt>{t("要重启才会加载的 Agent")}</dt>
        <dd>{agents.length ? agents.join(", ") : t("没有")}</dd>
      </dl>
      {values.some((item) => item.secret) && (
        <p className="settings-note warning">
          {t("密钥会按各 CLI 的格式明文写进上面的配置文件，不会出现在 Hive 的日志、审计和聊天里。")}
        </p>
      )}
      {plan.command && (
        <p className="settings-note warning">
          {t(
            "现在不会执行任何命令。以后 CLI 启动这个 MCP 时会运行上面的命令，第一次会从 npm / PyPI 下载对应版本的包。",
          )}
        </p>
      )}
      {expired && (
        <p className="settings-note error" role="alert">
          {t("计划已过期，请返回重新预览。")}
        </p>
      )}
      <div className="runtime-install-actions">
        <Button size="sm" onClick={onBack} disabled={busy}>
          {t("返回修改")}
        </Button>
        <Button size="sm" variant="primary" onClick={onConfirm} disabled={busy || expired}>
          {t("确认安装")}
        </Button>
      </div>
    </div>
  );
}

function ResultView({ result, plan }: { result: RuntimeInstallResult; plan: RuntimeInstallPlan }) {
  const ok = new Set(result.results.filter((item) => item.ok).map((item) => item.provider));
  const agents = plan.targets
    .filter((target) => ok.has(target.provider))
    .flatMap((target) => target.agents.map((agent) => agent.name));
  return (
    <div className="runtime-install-result">
      <ul>
        {result.results.map((item) => (
          <li key={item.provider} className={item.ok ? "ok" : "error"}>
            <strong>{RUNTIME_LABELS[item.provider]}</strong>
            {item.ok
              ? t("：已写配置，未验证连接")
              : t("：没有写入。{0}", { 0: item.error ?? t("未知错误") })}
          </li>
        ))}
      </ul>
      <p className="settings-note">
        {agents.length
          ? t("Hive 没有重启 Agent。{0} 要重启后才会加载新的 MCP。", { 0: agents.join(", ") })
          : t("Hive 没有重启 Agent；终端里新开的 CLI 会话会加载新的 MCP。")}
      </p>
    </div>
  );
}
