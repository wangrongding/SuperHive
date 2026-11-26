import { useCallback, useEffect, useRef, useState } from "react";
import type { RuntimeCredentialProvider, RuntimeOverview } from "@superhive/protocol";
import { Button } from "./button";
import { ConfirmPopover } from "./confirm-popover";
import { t } from "./i18n";
import type { LocalAgentsState } from "./local-agents";
import { RUNTIME_LABELS } from "./runtime-credentials";
import type { RuntimeConfigSection } from "./runtime-config-panel";
import "./styles/runtime-overview.css";

/**
 * 「Agent 运行时」顶上的跨运行时总览：同一个 MCP / skill 在这台电脑上哪些 CLI 里装了、是否启用。
 * 点格子跳到那个 CLI 的配置面板去改；某些 CLI 还没有时可以「同步到」它们（MCP 连同环境变量的值、
 * skill 整个目录复制过去，已有同名的不覆盖）。
 */

export type RuntimeOverviewApi = Pick<
  LocalAgentsState,
  "runtimeOverview" | "syncRuntimeSkill" | "syncRuntimeMcp"
>;

type Kind = "mcp" | "skills";

const errorMessage = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);

type Row = {
  name: string;
  entries: Array<{
    provider: RuntimeCredentialProvider;
    enabled: boolean;
    id?: string;
    canSync?: boolean;
  }>;
};

export function RuntimeOverviewBlock({
  api,
  onJump,
}: {
  api: RuntimeOverviewApi;
  onJump: (provider: RuntimeCredentialProvider, section: RuntimeConfigSection) => void;
}) {
  const [overview, setOverview] = useState<RuntimeOverview>();
  const [kind, setKind] = useState<Kind>("mcp");
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string>();
  const { runtimeOverview } = api;
  const load = useCallback(() => {
    setError(undefined);
    runtimeOverview().then(setOverview, (reason: unknown) => setError(errorMessage(reason)));
  }, [runtimeOverview]);
  useEffect(load, [load]);

  if (!overview) {
    return (
      <div className="runtime-overview">
        <h4>{t("MCP 与技能总览")}</h4>
        {error ? (
          <p className="settings-note error">{error}</p>
        ) : (
          <p className="settings-note">{t("正在读取…")}</p>
        )}
      </div>
    );
  }
  const providers =
    kind === "mcp"
      ? overview.providers.filter((item) => item.mcpSupported).map((item) => item.provider)
      : overview.providers.map((item) => item.provider);
  const rows: Row[] = kind === "mcp" ? overview.mcp : overview.skills;
  const query = filter.trim().toLowerCase();
  const shown = query ? rows.filter((row) => row.name.toLowerCase().includes(query)) : rows;

  return (
    <div className="runtime-overview">
      <div className="runtime-overview-head">
        <h4>{t("MCP 与技能总览")}</h4>
        <Button size="sm" onClick={load}>
          {t("刷新")}
        </Button>
      </div>
      <p className="settings-note">
        {t(
          "同一个 MCP 或技能在这台电脑上的哪些 CLI 里有、是否启用。点格子跳到那个 CLI 的配置里改。",
        )}
      </p>
      <div className="runtime-config-tabs" role="tablist" aria-label={t("MCP 与技能总览")}>
        {(["mcp", "skills"] as const).map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={kind === item}
            className={kind === item ? "active" : ""}
            onClick={() => setKind(item)}
          >
            {item === "mcp"
              ? t("MCP（{0}）", { 0: overview.mcp.length })
              : t("技能（{0}）", { 0: overview.skills.length })}
          </button>
        ))}
        {rows.length > 8 && (
          <input
            type="search"
            className="runtime-skills-filter"
            aria-label={t("按名称筛选")}
            placeholder={t("按名称筛选")}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        )}
      </div>
      {providers.length === 0 ? (
        <p className="settings-note">{t("这台电脑上还没有找到可以管理的 CLI 配置目录。")}</p>
      ) : rows.length === 0 ? (
        <p className="settings-note">
          {kind === "mcp" ? t("还没有全局 MCP 服务器。") : t("这些目录里还没有 skill。")}
        </p>
      ) : (
        <div className="runtime-overview-scroll" role="tabpanel">
          <table className="runtime-overview-table">
            <thead>
              <tr>
                <th scope="col">{t("名称")}</th>
                {providers.map((provider) => (
                  <th key={provider} scope="col">
                    {RUNTIME_LABELS[provider]}
                  </th>
                ))}
                <th scope="col">
                  <span className="sr-only">{t("操作")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <OverviewRow
                  key={row.name}
                  api={api}
                  kind={kind}
                  row={row}
                  providers={providers}
                  onJump={onJump}
                  onSynced={setOverview}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {error && <p className="settings-note error">{error}</p>}
    </div>
  );
}

function OverviewRow({
  api,
  kind,
  row,
  providers,
  onJump,
  onSynced,
}: {
  api: RuntimeOverviewApi;
  kind: Kind;
  row: Row;
  providers: RuntimeCredentialProvider[];
  onJump: (provider: RuntimeCredentialProvider, section: RuntimeConfigSection) => void;
  onSynced: (next: RuntimeOverview) => void;
}) {
  const [syncing, setSyncing] = useState(false);
  const [targets, setTargets] = useState<RuntimeCredentialProvider[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const syncRef = useRef<HTMLButtonElement>(null);
  const source = row.entries.find((entry) => (kind === "mcp" ? true : entry.canSync));
  const missing = providers.filter(
    (provider) => !row.entries.some((entry) => entry.provider === provider),
  );
  const section: RuntimeConfigSection = kind === "mcp" ? "mcp" : "skills";
  const sync = async () => {
    if (!source || !targets.length) return;
    setBusy(true);
    setError(undefined);
    try {
      onSynced(
        kind === "mcp"
          ? await api.syncRuntimeMcp(source.provider, row.name, targets)
          : await api.syncRuntimeSkill(source.provider, source.id!, targets),
      );
      setSyncing(false);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <tr>
      <th scope="row">
        <span className="runtime-overview-name">{row.name}</span>
        {error && <small className="error">{error}</small>}
      </th>
      {providers.map((provider) => {
        const entry = row.entries.find((item) => item.provider === provider);
        const where = RUNTIME_LABELS[provider];
        if (!entry) {
          return (
            <td key={provider} className="runtime-overview-cell missing">
              <span aria-label={t("{0} 里没有", { 0: where })}>—</span>
            </td>
          );
        }
        return (
          <td key={provider} className="runtime-overview-cell">
            <button
              type="button"
              className={
                entry.enabled ? "runtime-overview-status on" : "runtime-overview-status off"
              }
              aria-label={t("{0}：{1}，去 {2} 的配置里改", {
                0: row.name,
                1: entry.enabled ? t("已启用") : t("已停用"),
                2: where,
              })}
              onClick={() => onJump(provider, section)}
            >
              {entry.enabled ? t("已启用") : t("已停用")}
            </button>
          </td>
        );
      })}
      <td className="runtime-overview-actions">
        {source && missing.length > 0 && (
          <Button
            ref={syncRef}
            size="sm"
            aria-expanded={syncing}
            onClick={() => {
              setTargets(missing);
              setSyncing(true);
            }}
          >
            {t("同步到…")}
          </Button>
        )}
        {syncing && source && (
          <ConfirmPopover
            ariaLabel={t("把 {0} 同步到其它 CLI", { 0: row.name })}
            title={t("会同时影响终端里的这些 CLI")}
            message={
              <div className="runtime-overview-sync">
                <p>
                  {kind === "mcp"
                    ? t(
                        "从 {0} 复制 {1} 的配置（包括环境变量的值），写进下面勾选的 CLI 的全局配置，原文件先备份。",
                        {
                          0: RUNTIME_LABELS[source.provider],
                          1: row.name,
                        },
                      )
                    : t("把 {0} 里的 {1} 整个目录复制到下面勾选的 CLI 自己的 skills 目录。", {
                        0: RUNTIME_LABELS[source.provider],
                        1: row.name,
                      })}
                </p>
                {missing.map((provider) => (
                  <label key={provider}>
                    <input
                      type="checkbox"
                      checked={targets.includes(provider)}
                      onChange={(event) =>
                        setTargets((current) =>
                          event.target.checked
                            ? [...current, provider]
                            : current.filter((item) => item !== provider),
                        )
                      }
                    />
                    {RUNTIME_LABELS[provider]}
                  </label>
                ))}
              </div>
            }
            confirmLabel={t("同步")}
            cancelLabel={t("取消")}
            busy={busy || targets.length === 0}
            anchorRef={syncRef}
            onConfirm={() => void sync()}
            onCancel={() => setSyncing(false)}
          />
        )}
      </td>
    </tr>
  );
}
