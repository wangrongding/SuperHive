import { useCallback, useEffect, useState } from "react";
import type { LocalAgent, LocalAgentMcpResponse, LocalMcpServer } from "@superhive/protocol";
import { localized, t } from "./i18n";
import type { LocalAgentsState } from "./local-agents";

function CloseGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function SettingsGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
      <path
        d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.86a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9c.26.6.85 1 1.51 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const scopeLabels: Record<LocalMcpServer["scope"], string> = localized(() => ({
  user: t("全局"),
  local: t("本项目"),
  project: t("项目 .mcp.json"),
  plugin: t("插件"),
}));

/** 1234 → 1.2k，123456 → 12.3 万（中文）/ 123k（英文） */
export function formatTokens(tokens: number): string {
  if (tokens >= 10_000 && t("万") === "万") {
    return `${(tokens / 10_000).toFixed(tokens >= 100_000 ? 0 : 1)} 万`;
  }
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens >= 100_000 ? 0 : 1)}k`;
  return String(tokens);
}

/** 估算的开局 token：不带 MCP 的基础量 + 启用的各项 */
function estimateStartTokens(
  data: LocalAgentMcpResponse,
  disabled: Set<string>,
): number | undefined {
  if (data.baselineTokens === null) return undefined;
  let total = data.baselineTokens;
  for (const server of data.servers) {
    const on = server.configurable ? !disabled.has(server.name) : server.enabled;
    if (!on) continue;
    if (!server.measurement?.ok) return undefined;
    total += server.measurement.tokens;
  }
  return total;
}

/** 本机 MCP 勾选列表与开局 token 估算；Agent 设置弹窗和接入表单共用 */
export function McpChecklist({
  data,
  failed,
  disabled,
  measuring,
  busy,
  onToggle,
}: {
  data: LocalAgentMcpResponse | undefined;
  failed: boolean;
  disabled: Set<string>;
  measuring: boolean;
  busy: boolean;
  onToggle: (name: string) => void;
}) {
  const estimate = data ? estimateStartTokens(data, disabled) : undefined;
  return (
    <>
      {!data && !failed && <p className="agent-mcp-hint">{t("正在读取 MCP 列表…")}</p>}
      {data && !data.supported && (
        <p className="agent-mcp-hint">{t("这个 Agent 类型暂不支持在 Hive 里开关 MCP。")}</p>
      )}
      {data?.supported && data.servers.length === 0 && (
        <p className="agent-mcp-hint">{t("这台电脑上没有配置额外的 MCP，只加载 hive。")}</p>
      )}
      {data?.supported && data.servers.length > 0 && (
        <ul className="agent-mcp-list" aria-label={t("本机 MCP")}>
          {data.servers.map((server) => {
            const on = server.configurable ? !disabled.has(server.name) : server.enabled;
            const size = server.measurement
              ? server.measurement.ok
                ? t("{0} 个工具 · 约 {1} token", {
                    0: server.measurement.tools,
                    1: formatTokens(server.measurement.tokens),
                  })
                : t("无法估算：{0}", { 0: server.measurement.error })
              : measuring
                ? t("正在估算…")
                : "";
            const heavy = server.measurement?.ok === true && server.measurement.tokens >= 50_000;
            return (
              <li key={server.name} className={on ? "" : "off"}>
                <label>
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={!server.configurable || busy}
                    onChange={() => onToggle(server.name)}
                  />
                  <span className="agent-mcp-copy">
                    <strong>{server.name}</strong>
                    <small>
                      {scopeLabels[server.scope]} · {server.transport}
                      {size ? " · " : ""}
                      {size && <span className={heavy ? "agent-mcp-heavy" : ""}>{size}</span>}
                      {!server.configurable &&
                        ` · ${server.disabledByCli ? t("已在 CLI 配置里关闭") : t("插件提供，不能在这里开关")}`}
                    </small>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}

      {estimate !== undefined && (
        <p className="agent-mcp-estimate">
          {t("按当前勾选，每个新会话开局约 {0} token（估算）。", { 0: formatTokens(estimate) })}
        </p>
      )}
    </>
  );
}

/**
 * 本机 Agent 的设置：勾选它加载哪些本机 MCP。每个 MCP 的工具定义都会在每个会话开局整段发给模型，
 * 体积大的会让每次新会话、每次缓存过期都多花一大笔，所以把大小标出来让房主自己取舍。
 */
export function AgentSettingsDialog({
  agent,
  local,
  onClose,
}: {
  agent: LocalAgent;
  local: Pick<LocalAgentsState, "mcpServers" | "updateSettings" | "act">;
  onClose: () => void;
}) {
  const [data, setData] = useState<LocalAgentMcpResponse | undefined>();
  const [disabled, setDisabled] = useState(() => new Set(agent.mcpDisabled));
  const [measuring, setMeasuring] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [saved, setSaved] = useState<"saved" | "restarted" | undefined>();

  const load = useCallback(
    async (measure: boolean) => {
      if (measure) setMeasuring(true);
      try {
        setData(await local.mcpServers(agent.id, measure));
        setError(undefined);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (measure) setMeasuring(false);
      }
    },
    [agent.id, local],
  );

  useEffect(() => {
    // 先秒出列表，再在后台逐个估算大小
    void load(false).then(() => load(true));
  }, [load]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const changed =
    disabled.size !== agent.mcpDisabled.length ||
    agent.mcpDisabled.some((name) => !disabled.has(name));

  function toggle(name: string) {
    setSaved(undefined);
    setDisabled((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  async function save(restart: boolean) {
    setSaving(true);
    setError(undefined);
    try {
      // 列表里已不存在的旧名字一并清掉，避免越积越多
      const known = new Set(data?.servers.map((server) => server.name) ?? []);
      const next = [...disabled].filter((name) => known.size === 0 || known.has(name));
      const updated = await local.updateSettings(agent.id, { mcpDisabled: next });
      if (restart) await local.act(agent.id, "restart");
      setDisabled(new Set(updated.mcpDisabled));
      setSaved(restart ? "restarted" : "saved");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  const needsRestart = agent.settingsPendingRestart === true;

  return (
    <div className="room-dialog-layer">
      <button
        className="room-dialog-scrim"
        type="button"
        aria-label={t("关闭")}
        onClick={onClose}
      />
      <div
        className="invite-dialog agent-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-settings-title"
      >
        <header className="invite-dialog-header">
          <div>
            <h2 id="agent-settings-title">{t("{0} 的设置", { 0: agent.name })}</h2>
            <p>
              {t(
                "选择这个 Agent 加载哪些本机 MCP。每个 MCP 的工具说明会在每个会话开局整段发给模型，体积大的会明显增加新会话和缓存过期时的费用。hive 始终加载。",
              )}
            </p>
          </div>
          <button type="button" className="invite-close" aria-label={t("关闭")} onClick={onClose}>
            <CloseGlyph />
          </button>
        </header>

        <div className="invite-dialog-body">
          <McpChecklist
            data={data}
            failed={error !== undefined}
            disabled={disabled}
            measuring={measuring}
            busy={saving}
            onToggle={toggle}
          />
          <p className="agent-mcp-hint">
            {needsRestart
              ? t("这个 Agent 是在支持此设置之前启动的，保存后需要重启一次才会生效。")
              : t(
                  "保存后从下一次回复开始生效；会话里已有的上下文会在下一次回复时按新的工具重新缓存一次。",
                )}
          </p>
          {error && (
            <p className="room-dialog-error" role="alert">
              {error}
            </p>
          )}
          {saved && (
            <p className="agent-mcp-saved" role="status">
              {saved === "restarted" ? t("已保存并重启。") : t("已保存。")}
            </p>
          )}
          <button
            type="button"
            className="invite-submit"
            disabled={!changed || saving || !data?.supported}
            onClick={() => void save(needsRestart)}
          >
            {saving ? t("保存中…") : needsRestart ? t("保存并重启") : t("保存")}
          </button>
        </div>
      </div>
    </div>
  );
}
