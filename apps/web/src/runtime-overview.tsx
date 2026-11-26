import { useCallback, useEffect, useRef, useState } from "react";
import type { RuntimeCredentialProvider, RuntimeOverview } from "@superhive/protocol";
import { Button } from "./button";
import { ConfirmPopover } from "./confirm-popover";
import { t } from "./i18n";
import type { LocalAgentsState } from "./local-agents";
import { RUNTIME_LABELS } from "./runtime-credentials";
import {
  emptyDraft,
  mcpInput,
  McpForm,
  type McpDraft,
  type RuntimeConfigSection,
} from "./runtime-config-panel";
import "./styles/runtime-overview.css";

/**
 * MCP 与技能的统一管理（参照 cc-switch）：一份列表，每行一组 CLI 开关，勾上就写进那个 CLI 的全局配置，
 * 取消就停用（CLI 不支持停用时从它的配置里删掉，只剩一份时不让删）。没有另外的存储：每次都从各 CLI
 * 自己的配置文件读，所以在 Hive 外手改的也能看到。新增 MCP 可以一次写进多个 CLI。
 * 写入沿用运行时配置的备份 + 原子替换；只给 Server 所在电脑上的本机房主。
 */

export type RuntimeOverviewApi = Pick<
  LocalAgentsState,
  | "runtimeOverview"
  | "syncRuntimeSkill"
  | "syncRuntimeMcp"
  | "addRuntimeMcp"
  | "toggleRuntimeMcp"
  | "deleteRuntimeMcp"
  | "toggleRuntimeSkill"
>;

export type OverviewKind = "mcp" | "skills";

const errorMessage = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);

type Entry = {
  provider: RuntimeCredentialProvider;
  enabled: boolean;
  id?: string;
  canToggle?: boolean;
  canSync?: boolean;
  note?: string;
};
type Row = { name: string; entries: Entry[] };
type Provider = RuntimeOverview["providers"][number];

/** 点一个格子要做什么；none 表示这个格子不能改，reason 说明为什么 */
type CellAction =
  | { kind: "enable" | "disable" }
  | { kind: "remove"; confirm: true }
  | { kind: "copy"; confirm: true; source: Entry }
  | { kind: "none"; reason: string };

export function cellAction(kindOf: OverviewKind, row: Row, info: Provider): CellAction {
  const where = RUNTIME_LABELS[info.provider];
  const entry = row.entries.find((item) => item.provider === info.provider);
  if (kindOf === "mcp") {
    if (!info.mcpSupported) {
      return { kind: "none", reason: info.mcpNote ?? t("{0} 不支持全局 MCP", { 0: where }) };
    }
    if (!entry) return { kind: "copy", confirm: true, source: row.entries[0]! };
    if (!entry.enabled) return { kind: "enable" };
    if (info.mcpCanToggle) return { kind: "disable" };
    return row.entries.length > 1
      ? { kind: "remove", confirm: true }
      : {
          kind: "none",
          reason: t("{0} 的 MCP 没有停用开关，这是最后一份；要删请到 {0} 的配置里删", {
            0: where,
          }),
        };
  }
  if (entry) {
    if (!entry.canToggle) return { kind: "none", reason: entry.note ?? t("这里不能启停") };
    return { kind: entry.enabled ? "disable" : "enable" };
  }
  const source = row.entries.find((item) => item.canSync);
  return source
    ? { kind: "copy", confirm: true, source }
    : { kind: "none", reason: t("插件、CLI 自带和 Hive 自带的技能不能复制到别的 CLI") };
}

export function RuntimeOverviewBlock({
  api,
  onJump,
  initialKind = "mcp",
}: {
  api: RuntimeOverviewApi;
  /** 点列头跳到那个 CLI 的配置；不给就不显示跳转 */
  onJump?: (provider: RuntimeCredentialProvider, section: RuntimeConfigSection) => void;
  initialKind?: OverviewKind;
}) {
  const [overview, setOverview] = useState<RuntimeOverview>();
  const [kind, setKind] = useState<OverviewKind>(initialKind);
  const [filter, setFilter] = useState("");
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const { runtimeOverview } = api;
  const load = useCallback(() => {
    runtimeOverview().then(setOverview, (reason: unknown) => setError(errorMessage(reason)));
  }, [runtimeOverview]);
  useEffect(load, [load]);

  /** 改完重新读一遍：以各 CLI 配置文件里的实际结果为准 */
  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true);
      setError(undefined);
      try {
        const next = await action();
        if (next && typeof next === "object" && "providers" in next) {
          setOverview(next as RuntimeOverview);
        } else {
          setOverview(await runtimeOverview());
        }
        return true;
      } catch (reason) {
        setError(errorMessage(reason));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [runtimeOverview],
  );

  if (!overview) {
    return (
      <div className="runtime-overview">
        <h4>{t("MCP 与技能")}</h4>
        {error ? (
          <p className="settings-note error">{error}</p>
        ) : (
          <p className="settings-note">{t("正在读取…")}</p>
        )}
      </div>
    );
  }
  const providers = overview.providers;
  const rows: Row[] = kind === "mcp" ? overview.mcp : overview.skills;
  const query = filter.trim().toLowerCase();
  const shown = query ? rows.filter((row) => row.name.toLowerCase().includes(query)) : rows;
  const section: RuntimeConfigSection = kind === "mcp" ? "mcp" : "skills";

  return (
    <div className="runtime-overview">
      <div className="runtime-overview-head">
        <h4>{t("MCP 与技能")}</h4>
        <Button size="sm" disabled={busy} onClick={load}>
          {t("刷新")}
        </Button>
      </div>
      <p className="settings-note">
        {t(
          "一处管理这台电脑上各 CLI 的全局 MCP 和技能。勾上就写进那个 CLI 的全局配置（原文件先备份），取消就停用；终端里的 CLI 也一起变。每次都从各 CLI 的配置文件读，在 Hive 外手改的也会显示。",
        )}
      </p>
      <div className="runtime-config-tabs" role="tablist" aria-label={t("MCP 与技能")}>
        {(["mcp", "skills"] as const).map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={kind === item}
            className={kind === item ? "active" : ""}
            onClick={() => {
              setKind(item);
              setAdding(false);
            }}
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
        {kind === "mcp" && !adding && (
          <Button
            size="sm"
            className="runtime-overview-add"
            disabled={busy || !providers.some((item) => item.mcpSupported)}
            onClick={() => setAdding(true)}
          >
            {t("添加 MCP")}
          </Button>
        )}
      </div>
      {adding && kind === "mcp" && (
        <AddMcp
          providers={providers.filter((item) => item.mcpSupported).map((item) => item.provider)}
          existing={overview.mcp.map((row) => row.name)}
          busy={busy}
          onCancel={() => setAdding(false)}
          onSave={(name, server, targets) =>
            void run(() => api.addRuntimeMcp(name, server, targets)).then(
              (ok) => ok && setAdding(false),
            )
          }
        />
      )}
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
                {providers.map((info) => (
                  <th key={info.provider} scope="col">
                    {onJump ? (
                      <Button
                        size="sm"
                        variant="link"
                        aria-label={t("去 {0} 的配置", { 0: RUNTIME_LABELS[info.provider] })}
                        onClick={() => onJump(info.provider, section)}
                      >
                        {RUNTIME_LABELS[info.provider]}
                      </Button>
                    ) : (
                      RUNTIME_LABELS[info.provider]
                    )}
                  </th>
                ))}
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
                  busy={busy}
                  run={run}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {error && (
        <p className="settings-note error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function OverviewRow({
  api,
  kind,
  row,
  providers,
  busy,
  run,
}: {
  api: RuntimeOverviewApi;
  kind: OverviewKind;
  row: Row;
  providers: Provider[];
  busy: boolean;
  run: (action: () => Promise<unknown>) => Promise<boolean>;
}) {
  const [confirming, setConfirming] = useState<RuntimeCredentialProvider>();
  const refs = useRef(new Map<RuntimeCredentialProvider, HTMLInputElement | null>());

  const apply = (provider: RuntimeCredentialProvider, action: CellAction) => {
    const entry = row.entries.find((item) => item.provider === provider);
    switch (action.kind) {
      case "enable":
      case "disable": {
        const enabled = action.kind === "enable";
        return run(() =>
          kind === "mcp"
            ? api.toggleRuntimeMcp(provider, row.name, enabled)
            : api.toggleRuntimeSkill(provider, entry!.id!, enabled),
        );
      }
      case "remove":
        return run(() => api.deleteRuntimeMcp(provider, row.name));
      case "copy":
        return run(() =>
          kind === "mcp"
            ? api.syncRuntimeMcp(action.source.provider, row.name, [provider])
            : api.syncRuntimeSkill(action.source.provider, action.source.id!, [provider]),
        );
      case "none":
        return Promise.resolve(false);
    }
  };

  const message = (where: string, action: CellAction) => {
    if (action.kind === "remove") {
      return t(
        "{0} 的全局配置没有单独停用的开关，取消就从里面删掉 {1}（原文件先备份），别的 CLI 里的保留。",
        { 0: where, 1: row.name },
      );
    }
    if (action.kind !== "copy") return "";
    const from = RUNTIME_LABELS[action.source.provider];
    return kind === "mcp"
      ? t(
          "从 {0} 复制 {1} 的配置（包括环境变量和请求头的值），写进 {2} 的全局配置，原文件先备份。",
          {
            0: from,
            1: row.name,
            2: where,
          },
        )
      : t("把 {0} 里的 {1} 整个目录复制到 {2} 自己的 skills 目录。", {
          0: from,
          1: row.name,
          2: where,
        });
  };

  return (
    <tr>
      <th scope="row">
        <span className="runtime-overview-name" title={row.name}>
          {row.name}
        </span>
      </th>
      {providers.map((info) => {
        const where = RUNTIME_LABELS[info.provider];
        const entry = row.entries.find((item) => item.provider === info.provider);
        const action = cellAction(kind, row, info);
        const reason = action.kind === "none" ? action.reason : undefined;
        const unsupported = kind === "mcp" && !info.mcpSupported;
        return (
          <td
            key={info.provider}
            className={`runtime-overview-cell${unsupported ? " unsupported" : ""}`}
            title={reason}
          >
            {unsupported ? (
              <span className="runtime-overview-na">{t("不支持")}</span>
            ) : (
              <label
                className="runtime-overview-toggle"
                title={
                  reason ??
                  (entry
                    ? entry.enabled
                      ? t("已启用")
                      : t("已停用，配置还在")
                    : t("还没有，勾上会从别的 CLI 复制过来"))
                }
              >
                <input
                  type="checkbox"
                  ref={(element) => {
                    refs.current.set(info.provider, element);
                  }}
                  checked={Boolean(entry?.enabled)}
                  disabled={busy || action.kind === "none"}
                  aria-label={t("在 {0} 里启用 {1}", { 0: where, 1: row.name })}
                  onChange={() => {
                    if (action.kind === "none") return;
                    if ("confirm" in action) setConfirming(info.provider);
                    else void apply(info.provider, action);
                  }}
                />
              </label>
            )}
            {reason && <span className="sr-only">{reason}</span>}
            {confirming === info.provider && "confirm" in action && (
              <ConfirmPopover
                ariaLabel={
                  action.kind === "remove"
                    ? t("确认从 {0} 删掉 {1}", { 0: where, 1: row.name })
                    : t("确认把 {0} 加到 {1}", { 0: row.name, 1: where })
                }
                title={t("会同时影响终端里的 {0}", { 0: where })}
                message={message(where, action)}
                confirmLabel={action.kind === "remove" ? t("删除") : t("添加")}
                cancelLabel={t("取消")}
                danger={action.kind === "remove"}
                busy={busy}
                anchorRef={{ current: refs.current.get(info.provider) ?? null }}
                onConfirm={() =>
                  void apply(info.provider, action).then(() => setConfirming(undefined))
                }
                onCancel={() => setConfirming(undefined)}
              />
            )}
          </td>
        );
      })}
    </tr>
  );
}

function AddMcp({
  providers,
  existing,
  busy,
  onCancel,
  onSave,
}: {
  providers: RuntimeCredentialProvider[];
  existing: string[];
  busy: boolean;
  onCancel: () => void;
  onSave: (
    name: string,
    server: ReturnType<typeof mcpInput>,
    targets: RuntimeCredentialProvider[],
  ) => void;
}) {
  const [draft, setDraft] = useState<McpDraft>(emptyDraft);
  const [targets, setTargets] = useState<RuntimeCredentialProvider[]>(providers);
  const name = draft.name.trim();
  const taken = existing.includes(name);
  return (
    <div className="runtime-overview-add-form">
      <fieldset className="runtime-overview-targets">
        <legend>{t("写进这些 CLI")}</legend>
        {providers.map((provider) => (
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
      </fieldset>
      {taken && (
        <p className="settings-note error">
          {t("已经有叫 {0} 的 MCP 了，在表格里勾选要加到哪些 CLI。", { 0: name })}
        </p>
      )}
      <McpForm
        draft={draft}
        busy={busy || taken || targets.length === 0}
        onChange={setDraft}
        onCancel={onCancel}
        onSave={() => onSave(name, mcpInput(draft, true), targets)}
      />
      <p className="settings-note">
        {t("会写进勾选的 CLI 的全局配置（原文件先备份），终端里的这些 CLI 也一起变。")}
      </p>
    </div>
  );
}
