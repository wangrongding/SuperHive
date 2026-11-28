import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentLastModel,
  LocalAgent,
  LocalAgentMcpResponse,
  LocalAgentModelsResponse,
  LocalMcpServer,
} from "@superhive/protocol";
import { localized, t } from "./i18n";
import { LogViewer, localAgentStatusLabels, type LocalAgentsState } from "./local-agents";
import { RestartNowButton, agentUpdateNotes } from "./local-agent-updates";
import { ClaudeContextSettings } from "./claude-context-settings";
import { Button, IconButton } from "./button";
import { EffortPicker, ModelPicker, effortLabel } from "./model-picker";
import { modelDisplayName } from "./agent-models";
import { SaveStatus, useAutoSave } from "./auto-save";
import { AgentAccessSettings } from "./agent-access-settings";

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
                    <small className="agent-mcp-details">
                      <span className="agent-mcp-source">
                        {scopeLabels[server.scope]} · {server.transport}
                      </span>
                      <span className="agent-mcp-separator">{size ? " · " : ""}</span>
                      <span className="agent-mcp-size">
                        {size && <span className={heavy ? "agent-mcp-heavy" : ""}>{size}</span>}
                        {!server.configurable &&
                          ` · ${server.disabledByCli ? t("已在 CLI 配置里关闭") : t("插件提供，不能在这里开关")}`}
                      </span>
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
/**
 * 模型下拉下面那行：这个房间上一轮实际用的是哪个模型（选「运行时默认」时也知道到底是哪个）；
 * 还没回复过、又是运行时默认时，写运行时列出的默认模型
 */
function CurrentModelNote({
  lastModel,
  selected,
  models,
}: {
  lastModel: AgentLastModel | undefined;
  selected: string;
  models: LocalAgentModelsResponse | undefined;
}) {
  const named = (id: string) => {
    const name = modelDisplayName(id, models);
    return name === id ? id : `${name}（${id}）`;
  };
  let text: string | undefined;
  if (lastModel) {
    text = lastModel.effort
      ? t("这个房间上一轮实际用的是 {0}，思考强度 {1}", {
          0: named(lastModel.id),
          1: effortLabel(lastModel.effort),
        })
      : t("这个房间上一轮实际用的是 {0}", { 0: named(lastModel.id) });
  } else if (!selected.trim()) {
    const fallback = models?.models.find((entry) => entry.isDefault)?.id;
    if (fallback) text = t("运行时默认用的是 {0}", { 0: named(fallback) });
  }
  return text ? <p className="agent-model-current">{text}</p> : null;
}

export function AgentSettingsDialog({
  agent,
  lead = false,
  lastModel,
  local,
  onClose,
  onOpenTerminal,
  roomWorkspace,
}: {
  agent: LocalAgent;
  /** 当前房间的工作区：把只读改成可写的档位时预填成工作目录 */
  roomWorkspace?: string | undefined;
  /** 它是当前房间的主 Agent：缓存时长跟随 Claude Code 时实际按 1 小时 */
  lead?: boolean;
  /** 它在当前房间最近一轮实际用的模型和思考强度 */
  lastModel?: AgentLastModel | undefined;
  /** 在终端里接着它在当前房间的会话 */
  onOpenTerminal?: () => void;
  local: Pick<
    LocalAgentsState,
    "mcpServers" | "updateSettings" | "act" | "canManage" | "logs" | "remove" | "models"
  > &
    Partial<Pick<LocalAgentsState, "directories" | "hostPlatform">>;
  onClose: () => void;
}) {
  const [data, setData] = useState<LocalAgentMcpResponse | undefined>();
  const [disabled, setDisabled] = useState(() => new Set(agent.mcpDisabled));
  const [measuring, setMeasuring] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [autoSteer, setAutoSteer] = useState(agent.autoSteer);
  const [acting, setActing] = useState<"start" | "stop" | "restart" | "remove">();
  const [models, setModels] = useState<LocalAgentModelsResponse | undefined>();
  const [model, setModel] = useState(agent.model ?? "");
  const [effort, setEffort] = useState(agent.effort ?? "");
  // 服务端已确认的值：改了就存，排队中的保存拿它比较，只发真变了的字段（审计也只记这些）
  const confirmed = useRef({
    model: agent.model ?? null,
    effort: agent.effort ?? null,
    autoSteer: agent.autoSteer,
    mcpDisabled: [...agent.mcpDisabled].sort(),
  });
  const [logsOpen, setLogsOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const live = agent.status !== "stopped" && agent.status !== "crashed";

  /** 启动、停止、重启：和「接入 Agent」里本机 Agent 列表的按钮是同一个操作 */
  async function control(action: "start" | "stop" | "restart" | "remove") {
    setActing(action);
    setError(undefined);
    try {
      if (action === "remove") {
        await local.remove(agent.id);
        onClose();
        return;
      }
      await local.act(agent.id, action);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setActing(undefined);
    }
  }

  const loadModels = useCallback(
    async (refresh: boolean) => {
      if (refresh) setModels(undefined);
      try {
        setModels(await local.models(agent.id, refresh));
      } catch (cause) {
        setModels({
          source: "preset",
          models: [],
          efforts: [],
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    },
    [agent.id, local],
  );

  useEffect(() => {
    void loadModels(false);
  }, [loadModels]);

  // 运行时能切思考强度才显示、才保存（不支持的运行时 Server 也会拒绝）
  const effortSupported = (models?.efforts.length ?? 0) > 0;

  /** 模型和思考强度写进设置文件，下一次回复就按新的跑，不用重启 */
  const modelSave = useAutoSave((ok) => {
    const current = confirmed.current;
    // 成功时只把整理过的模型名（去掉首尾空格）对齐回来；人在那之后又改了的不动
    if (ok) {
      if (model.trim() === (current.model ?? "")) setModel(current.model ?? "");
      return;
    }
    setModel(current.model ?? "");
    setEffort(current.effort ?? "");
  });
  function saveModel(nextModel: string, nextEffort: string) {
    if (!local.canManage) return;
    const withEffort = effortSupported;
    modelSave.save(async () => {
      const current = confirmed.current;
      const patch: { model?: string | null; effort?: string | null } = {};
      const modelValue = nextModel.trim() || null;
      if (modelValue !== current.model) patch.model = modelValue;
      if (withEffort && (nextEffort || null) !== current.effort) patch.effort = nextEffort || null;
      if (Object.keys(patch).length === 0) return false;
      const updated = await local.updateSettings(agent.id, patch);
      confirmed.current = {
        ...confirmed.current,
        model: updated.model ?? null,
        effort: updated.effort ?? null,
      };
    });
  }

  /** 自动引导：服务端在派发时判断，改了立即生效，不用重启 */
  const steerSave = useAutoSave((ok) => {
    if (!ok) setAutoSteer(confirmed.current.autoSteer);
  });
  function toggleAutoSteer(next: boolean) {
    setAutoSteer(next);
    steerSave.save(async () => {
      if (next === confirmed.current.autoSteer) return false;
      const updated = await local.updateSettings(agent.id, { autoSteer: next });
      confirmed.current = { ...confirmed.current, autoSteer: updated.autoSteer };
    });
  }

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
    // 先秒出列表，再在后台逐个估算大小（要起进程，没有管理权的设备只列出来）
    void load(false).then(() => (local.canManage ? load(true) : undefined));
  }, [load, local.canManage]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /** MCP 开关：勾了就存；运行中的进程下一次回复按新的工具开局 */
  const mcpSave = useAutoSave((ok) => {
    if (!ok) setDisabled(new Set(confirmed.current.mcpDisabled));
  });
  function toggle(name: string) {
    const next = new Set(disabled);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setDisabled(next);
    // 列表里已不存在的旧名字一并清掉，避免越积越多
    const known = new Set(data?.servers.map((server) => server.name) ?? []);
    const list = [...next].filter((item) => known.size === 0 || known.has(item)).sort();
    mcpSave.save(async () => {
      const current = confirmed.current.mcpDisabled;
      if (list.length === current.length && list.every((item, index) => item === current[index]))
        return false;
      const updated = await local.updateSettings(agent.id, { mcpDisabled: list });
      confirmed.current = { ...confirmed.current, mcpDisabled: [...updated.mcpDisabled].sort() };
    });
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
            <div className={`agent-run-control local-agent ${agent.status}`}>
              <span className="local-agent-dot" aria-hidden="true" />
              <span className="agent-run-status">
                <strong>
                  {[localAgentStatusLabels[agent.status], ...agentUpdateNotes(agent)].join(" · ")}
                  {agent.outdated && <span className="agent-update-badge">{t("旧版本")}</span>}
                </strong>
              </span>
              <div className="agent-run-actions">
                {live ? (
                  <>
                    {onOpenTerminal && (
                      <Button size="sm" onClick={onOpenTerminal}>
                        {t("在终端打开会话")}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      disabled={
                        acting !== undefined || !local.canManage || agent.restartWhenIdle === true
                      }
                      onClick={() => void control("restart")}
                    >
                      {acting === "restart" ? t("重启中…") : t("重启")}
                    </Button>
                    <RestartNowButton
                      agent={agent}
                      local={local}
                      disabled={acting !== undefined || !local.canManage}
                      onError={setError}
                    />
                    <Button
                      size="sm"
                      disabled={acting !== undefined || !local.canManage}
                      onClick={() => void control("stop")}
                    >
                      {acting === "stop" ? t("下线中…") : t("下线")}
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={acting !== undefined || !local.canManage}
                      onClick={() => void control("start")}
                    >
                      {acting === "start" ? t("启动中…") : t("启动")}
                    </Button>
                    <Button
                      size="sm"
                      tone="danger"
                      disabled={acting !== undefined || !local.canManage}
                      onClick={() => setConfirmRemove(true)}
                    >
                      {t("删除")}
                    </Button>
                  </>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  aria-expanded={logsOpen}
                  onClick={() => setLogsOpen(!logsOpen)}
                >
                  {t("日志")}
                </Button>
              </div>
            </div>
            <p className="agent-run-hint">
              {!live
                ? t("已停止，房间里不会再有人接它的 @。")
                : agent.restartWhenIdle
                  ? t("已安排重启：手上的任务都做完就重启。")
                  : t("「重启」等它手上的任务都做完再重启；「立即重启」会中断正在执行的任务。")}
            </p>
            <p>
              {t(
                "重启、停止这个 Agent，修改它的权限、模型和加载哪些本机 MCP。每个 MCP 的工具说明会在每个会话开局整段发给模型，体积大的会明显增加新会话和缓存过期时的费用。hive 始终加载。",
              )}
            </p>
          </div>
          <IconButton className="dialog-close" label={t("关闭")} onClick={onClose}>
            <CloseGlyph />
          </IconButton>
        </header>

        <div className="invite-dialog-body">
          {agent.status === "crashed" && agent.lastError && (
            <p className="local-agent-error">{agent.lastError}</p>
          )}
          {agent.cwdFallback && (
            <p className="local-agent-notice" role="status">
              {cwdFallbackText(agent.cwdFallback)}
            </p>
          )}
          {confirmRemove && (
            <div className="agent-remove-confirm" role="alert">
              <span>
                {t("删除 {0}？它会退出所有房间，之后要用得重新接入。", { 0: agent.name })}
              </span>
              <Button size="sm" onClick={() => setConfirmRemove(false)}>
                {t("取消")}
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={acting !== undefined}
                onClick={() => void control("remove")}
              >
                {t("删除")}
              </Button>
            </div>
          )}
          {logsOpen && <LogViewer load={local.logs} agentId={agent.id} />}
          <AgentAccessSettings agent={agent} local={local} roomWorkspace={roomWorkspace} />
          <section className="agent-model" aria-labelledby="agent-model-title">
            <h3 id="agent-model-title">{effortSupported ? t("模型与思考强度") : t("模型")}</h3>
            <div className={effortSupported ? "agent-settings-fields" : "agent-settings-field"}>
              <div className="agent-settings-field">
                {effortSupported && <h4>{t("模型")}</h4>}
                <ModelPicker
                  aria-label={t("模型")}
                  data={models}
                  value={model}
                  allowDefault
                  disabled={!local.canManage}
                  onChange={setModel}
                  onCommit={(next) => saveModel(next, effort)}
                  onRefresh={() => void loadModels(true)}
                />
                <CurrentModelNote lastModel={lastModel} selected={model} models={models} />
              </div>
              {effortSupported && (
                <div className="agent-settings-field">
                  <h4>{t("思考强度")}</h4>
                  <EffortPicker
                    data={models}
                    model={model}
                    value={effort}
                    disabled={!local.canManage}
                    onChange={(next) => {
                      setEffort(next);
                      saveModel(model, next);
                    }}
                  />
                </div>
              )}
            </div>
            <SaveStatus
              state={modelSave.state}
              hint={
                agent.settingsPendingRestart
                  ? t("这个 Agent 是在支持此设置之前启动的，改了以后需要重启一次才会生效。")
                  : t(
                      "选了就保存，从下一次回复开始生效，不用重启。失败的任务也可以点「换个模型重试」只换这一次。",
                    )
              }
              savedHint={
                agent.settingsPendingRestart
                  ? t("需要重启一次才会生效。")
                  : t("从下一次回复开始生效，不用重启。")
              }
            />
          </section>
          {agent.provider === "claude" && (
            <ClaudeContextSettings
              agent={agent}
              lead={lead}
              disabled={!local.canManage}
              onSave={(settings) => local.updateSettings(agent.id, settings)}
            />
          )}
          <label className="agent-auto-steer">
            <input
              type="checkbox"
              checked={autoSteer}
              disabled={!local.canManage}
              onChange={(event) => toggleAutoSteer(event.target.checked)}
            />
            <span>
              <span className="agent-auto-steer-title">
                <strong>{t("人发的消息自动引导")}</strong>
                <SaveStatus state={steerSave.state} hint="" savedHint={t("立即生效。")} />
              </span>
              <small>
                {t(
                  "它正在执行任务时，人 @ 它的新消息直接用来引导当前任务，不排队。默认关：先排队，需要时在那条消息上或输入框旁点「引导」。其他 Agent 的消息始终排队。",
                )}
              </small>
            </span>
          </label>
          <McpChecklist
            data={data}
            failed={error !== undefined}
            disabled={disabled}
            measuring={measuring}
            busy={!local.canManage}
            onToggle={toggle}
          />
          {!local.canManage && (
            <p className="agent-mcp-hint">{t("这台设备只能查看。要修改，先申请管理权。")}</p>
          )}
          {data?.supported && (
            <SaveStatus
              state={mcpSave.state}
              hint={
                needsRestart
                  ? t("这个 Agent 是在支持此设置之前启动的，改了以后需要点上面的「重启」才会生效。")
                  : t(
                      "勾了就保存，从下一次回复开始生效；会话里已有的上下文会在下一次回复时按新的工具重新缓存一次。",
                    )
              }
              savedHint={
                needsRestart
                  ? t("点上面的「重启」后生效。")
                  : t("从下一次回复开始生效，已有的上下文会按新的工具重新缓存一次。")
              }
            />
          )}
          {error && (
            <p className="room-dialog-error" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/** 工作目录用不了、退回主目录时给人看的说明 */
export function cwdFallbackText(fallback: NonNullable<LocalAgent["cwdFallback"]>): string {
  return fallback.reason === "installDir"
    ? t("原来的工作目录 {0} 是桌面端的安装目录，升级后会被删掉，已自动改成 {1}。", {
        0: fallback.from,
        1: fallback.to,
      })
    : t("工作目录 {0} 不存在，这次先在 {1} 启动；目录恢复后重启这个 Agent 即回到原目录。", {
        0: fallback.from,
        1: fallback.to,
      });
}
