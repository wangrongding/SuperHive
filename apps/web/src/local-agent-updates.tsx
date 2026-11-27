import { useEffect, useRef, useState } from "react";
import { formatAgentVersion, type LocalAgent, type Participant } from "@superhive/protocol";
import { ConfirmPopover } from "./confirm-popover";
import { t } from "./i18n";
import { MemberBadge } from "./member-badge";
import type { LocalAgentsState } from "./local-agents";
import { SettingsSwitch } from "./settings-switch";
import "./styles/local-agent-updates.css";
import { Tooltip } from "./tooltip";
import { Button } from "./button";

const POLL_MS = 5_000;

/** 成员名旁的「旧版本」标记：这个 Agent 跑的代码比当前的旧，重启后才用上新代码 */
export function OutdatedBadge({ participant }: { participant: Participant }) {
  if (!participant.outdated) return null;
  const running = participant.version
    ? t("运行的是 {0}", { 0: formatAgentVersion(participant.version) })
    : t("没有上报版本（更新前启动的）");
  return (
    <MemberBadge level="warning" hint={t("{0}，比当前代码旧；重启后才用上新代码", { 0: running })}>
      {t("旧版本")}
    </MemberBadge>
  );
}

/** 立即重启：会打断正在做的任务，先在按钮上方确认 */
export function RestartNowButton({
  agent,
  local,
  disabled,
  onError,
}: {
  agent: LocalAgent;
  local: Pick<LocalAgentsState, "act">;
  disabled?: boolean;
  onError: (message: string | undefined) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const close = () => {
    setConfirming(false);
    anchorRef.current?.focus();
  };
  return (
    <>
      <Button
        ref={anchorRef}
        size="sm"
        // 正忙时才用警示色：这时立即重启会打断任务
        {...(agent.busy ? { tone: "danger" as const } : {})}
        disabled={disabled || busy}
        aria-expanded={confirming}
        onClick={() => setConfirming((current) => !current)}
      >
        {busy ? t("重启中…") : t("立即重启")}
      </Button>
      {confirming && (
        <ConfirmPopover
          anchorRef={anchorRef}
          ariaLabel={t("确认立即重启 {0}", { 0: agent.name })}
          title={t("立即重启 {0}？", { 0: agent.name })}
          message={
            agent.busy
              ? t("它手上还有任务：正在执行的会被中断，结果要你核对；排队的重启后接着做。")
              : t("它现在空闲，重启只需几秒。")
          }
          confirmLabel={t("立即重启")}
          cancelLabel={t("取消")}
          danger={agent.busy}
          busy={busy}
          onCancel={close}
          onConfirm={() => {
            setBusy(true);
            onError(undefined);
            local
              .act(agent.id, "restart", { now: true })
              .catch((reason: unknown) =>
                onError(reason instanceof Error ? reason.message : String(reason)),
              )
              .finally(() => {
                setBusy(false);
                close();
              });
          }}
        />
      )}
    </>
  );
}

/** 一个本机 Agent 的版本与忙闲：「旧版本」「忙」「空闲后重启」 */
export function agentUpdateNotes(agent: LocalAgent): string[] {
  const live = agent.status === "running" || agent.status === "starting";
  if (!live) return [];
  return [
    agent.version ? formatAgentVersion(agent.version) : t("版本未上报"),
    agent.busy ? t("正在执行任务") : t("空闲"),
  ];
}

/** 跑着的 Agent 才有「旧版本」可言：停止的下次启动就用上新代码 */
function isLive(agent: LocalAgent): boolean {
  return agent.status === "running" || agent.status === "starting";
}

/** 开着自动重启、已安排了空闲后重启，但落后超过这么久还没重启上（一直在忙）：提示人处理 */
export const STUCK_OUTDATED_MS = 30 * 60_000;

/**
 * 需要人管的旧版本 Agent（只看在跑的；停止的下次启动就用上新代码）：
 * - 自动重启关着：在跑旧版本的都算；
 * - 开着：自动重启不会管的（这个版本已经自动重启过一次仍是旧的等），或者落后很久了还在忙、一直没能重启的。
 */
export function outdatedNeedingAttention(
  agents: readonly LocalAgent[],
  autoUpdate: boolean,
  now = Date.now(),
): LocalAgent[] {
  return agents.filter((agent) => {
    if (!agent.outdated || !isLive(agent)) return false;
    if (!autoUpdate || !agent.restartWhenIdle) return true;
    return agent.busy === true && waitedMs(agent, now) >= STUCK_OUTDATED_MS;
  });
}

function waitedMs(agent: LocalAgent, now: number): number {
  const since = agent.outdatedSince ? Date.parse(agent.outdatedSince) : NaN;
  return Number.isFinite(since) ? now - since : 0;
}

/**
 * 设置 · 这台电脑 · 本机 Agent 的旧版本：平时（开着自动重启、旧版本的都安排好了空闲后重启）整块不显示，
 * 只在需要人管时出一行提示，下面列出这些 Agent，每个一行一个按钮。
 * 合入或升级后，跑着的 Agent 进程仍是旧代码；自动重启开关在「这台电脑」底部的「高级」里。
 * 全部 Agent 在成员面板里管理，这里只放一个跳过去的链接，不重复列。
 */
export function LocalAgentUpdatesGroup({
  local,
  onShowAgents,
}: {
  local: LocalAgentsState;
  /** 「查看全部 Agent」：关掉设置、打开成员面板 */
  onShowAgents?: () => void;
}) {
  const [error, setError] = useState<string>();
  const [acting, setActing] = useState<ReadonlySet<string>>(() => new Set());
  const { enabled, refreshAgents } = local;
  useEffect(() => {
    if (!enabled) return;
    void refreshAgents().catch(() => undefined);
    const timer = window.setInterval(() => void refreshAgents().catch(() => undefined), POLL_MS);
    return () => window.clearInterval(timer);
  }, [enabled, refreshAgents]);
  if (!enabled || local.autoUpdate === undefined) return null;
  const now = Date.now();
  const outdated = outdatedNeedingAttention(local.agents, local.autoUpdate, now);
  if (outdated.length === 0 && !error) return null;
  // 空闲、还没安排重启的：可以一键重启，不会打断任何事
  const idle = outdated.filter((agent) => !agent.busy && !agent.restartWhenIdle);
  const restartWhenIdle = (agents: LocalAgent[]) => {
    const ids = agents.map((agent) => agent.id);
    setActing((current) => new Set([...current, ...ids]));
    setError(undefined);
    void Promise.all(
      agents.map((agent) =>
        local
          .act(agent.id, "restart")
          .catch((reason: unknown) =>
            setError(reason instanceof Error ? reason.message : String(reason)),
          ),
      ),
    ).finally(() =>
      setActing((current) => new Set([...current].filter((id) => !ids.includes(id)))),
    );
  };
  const stateOf = (agent: LocalAgent) => {
    if (agent.restartWhenIdle) {
      const minutes = Math.floor(waitedMs(agent, now) / 60_000);
      return minutes >= STUCK_OUTDATED_MS / 60_000
        ? t("空闲后重启，已等 {0} 分钟", { 0: minutes })
        : t("空闲后重启");
    }
    return agent.busy ? t("正在执行任务") : t("空闲");
  };
  return (
    <div className="settings-group agent-updates-notice">
      {outdated.length > 0 && (
        <div className="agent-updates-status">
          <p className="settings-note" role="status">
            {local.autoUpdate
              ? t("{0} 个 Agent 在跑旧版本，一直没能自动重启", { 0: outdated.length })
              : t("自动重启已关，{0} 个 Agent 在跑旧版本，重启后才用上新代码", {
                  0: outdated.length,
                })}
          </p>
          {onShowAgents && (
            <Button size="sm" variant="link" onClick={onShowAgents}>
              {t("查看全部 Agent")}
            </Button>
          )}
        </div>
      )}
      {outdated.length > 0 && (
        <ul className="agent-updates outdated" aria-label={t("在跑旧版本的 Agent")}>
          {outdated.map((agent) => (
            <li key={agent.id} className={`local-agent ${agent.status}`}>
              <span className="local-agent-dot" aria-hidden="true" />
              <strong className="agent-update-name">{agent.name}</strong>
              <small className="agent-update-state">
                {[
                  stateOf(agent),
                  agent.version ? formatAgentVersion(agent.version) : t("版本未上报"),
                ].join(" · ")}
              </small>
              <span className="agent-update-actions">
                {agent.busy && !agent.restartWhenIdle ? (
                  <Tooltip content={t("等手上的任务都做完再重启，不打断正在做的事")}>
                    <Button
                      size="sm"
                      disabled={!local.canManage || acting.has(agent.id)}
                      onClick={() => restartWhenIdle([agent])}
                    >
                      {t("空闲后重启")}
                    </Button>
                  </Tooltip>
                ) : agent.busy ? (
                  <RestartNowButton
                    agent={agent}
                    local={local}
                    disabled={!local.canManage}
                    onError={setError}
                  />
                ) : (
                  <Button
                    size="sm"
                    disabled={!local.canManage || acting.has(agent.id) || agent.restartWhenIdle}
                    onClick={() => restartWhenIdle([agent])}
                  >
                    {acting.has(agent.id) ? t("重启中…") : t("重启")}
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {idle.length > 1 && (
        <Button
          size="sm"
          className="agent-updates-bulk"
          disabled={!local.canManage || idle.some((agent) => acting.has(agent.id))}
          onClick={() => restartWhenIdle(idle)}
        >
          {t("重启全部空闲的（{0} 个）", { 0: idle.length })}
        </Button>
      )}
      {error && <p className="settings-note error">{error}</p>}
    </div>
  );
}

/**
 * 设置 · 这台电脑 · 底部折叠的「高级」：代码更新后自动重启开关（默认开，一般只有经常合代码的开发者想关）。
 * 旧版 Server 不支持自动重启时整块不显示。
 */
export function LocalAgentAdvancedSettings({ local }: { local: LocalAgentsState }) {
  const [error, setError] = useState<string>();
  if (!local.enabled || local.autoUpdate === undefined) return null;
  return (
    <details className="settings-group divided settings-advanced">
      <summary>{t("高级")}</summary>
      <SettingsSwitch
        checked={local.autoUpdate}
        disabled={!local.canManage}
        label={t("代码更新后自动重启")}
        description={t(
          "合入或升级后，落后的 Agent 等手上的任务都做完再自动重启一次，不打断正在做的事；同一个版本只自动重启一次，两次至少隔 10 分钟",
        )}
        onChange={(checked) => {
          setError(undefined);
          local
            .setAutoUpdate(checked)
            .catch((reason: unknown) =>
              setError(reason instanceof Error ? reason.message : String(reason)),
            );
        }}
      />
      <p className="settings-note">
        {local.currentVersion
          ? t("当前代码：{0}", { 0: formatAgentVersion(local.currentVersion) })
          : t("判断不出当前代码的版本，不会自动重启。")}
      </p>
      {error && <p className="settings-note error">{error}</p>}
    </details>
  );
}
