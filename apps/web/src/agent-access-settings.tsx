import { useEffect, useState } from "react";
import type { LocalAgent } from "@superhive/protocol";
import { t } from "./i18n";
import { AccessSelector } from "./access-selector";
import type { AgentAccessMode } from "./agent-setup";
import { Button } from "./button";
import { DirectoryPicker, type LocalAgentsState } from "./local-agents";

/**
 * Agent 设置里的「权限」：三档和接入时一样。权限是 Agent 进程的启动参数，所以不像模型那样选了就存，
 * 改完点「保存并重启」：它空闲就马上按新权限重启，正在执行任务就等这一轮结束再换。
 */
export function AgentAccessSettings({
  agent,
  local,
  roomWorkspace,
}: {
  agent: LocalAgent;
  local: Pick<LocalAgentsState, "updateSettings" | "canManage"> &
    Partial<Pick<LocalAgentsState, "directories" | "hostPlatform">>;
  /** 当前房间的工作区：从只读改成可写的档位时，没有原目录就先填它 */
  roomWorkspace?: string | undefined;
}) {
  const [access, setAccess] = useState<AgentAccessMode>(agent.access);
  const [cwd, setCwd] = useState(agent.cwd ?? "");
  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const writable = access !== "read-only";
  const live = agent.status !== "stopped" && agent.status !== "crashed";
  const dirty =
    access !== agent.access || (writable && cwd.trim() !== "" && cwd.trim() !== (agent.cwd ?? ""));

  // 没有工作目录时预填：房间工作区，没有就用启动 Hive 的目录；人可以再改
  const { directories } = local;
  useEffect(() => {
    if (!writable) return;
    if (roomWorkspace) {
      setCwd((current) => current || roomWorkspace);
      return;
    }
    if (!directories) return;
    let cancelled = false;
    directories().then(
      (listing) => !cancelled && setCwd((current) => current || listing.defaults.launch),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [writable, roomWorkspace, directories]);

  function choose(next: AgentAccessMode) {
    setAccess(next);
    setError(undefined);
    setSaved(false);
  }

  function reset() {
    setAccess(agent.access);
    setCwd(agent.cwd ?? "");
    setPicking(false);
    setError(undefined);
  }

  async function save() {
    setSaving(true);
    setError(undefined);
    try {
      const updated = await local.updateSettings(agent.id, {
        access,
        ...(writable ? { cwd: cwd.trim() } : {}),
      });
      setAccess(updated.access);
      setCwd(updated.cwd ?? "");
      setPicking(false);
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  const status = agent.accessPendingRestart
    ? agent.busy
      ? t("新权限在这一轮结束后生效：它手上还有任务，做完就按新权限重启。")
      : t("正在按新权限重启…")
    : saved
      ? live
        ? t("已按新权限重启。")
        : t("已保存，下次启动时按新权限运行。")
      : t("改了要重启这个 Agent 才生效：它空闲时马上重启，正在执行任务就等这一轮结束。");

  return (
    <section className="agent-access" aria-labelledby="agent-access-title">
      <h3 id="agent-access-title">{t("权限")}</h3>
      <AccessSelector
        className="compact"
        value={access}
        onChange={choose}
        provider={agent.provider}
        hostPlatform={local.hostPlatform}
        labelledBy="agent-access-title"
        disabled={!local.canManage || saving}
      />
      {writable && (
        <div className="local-launch-cwd">
          <label>
            <span>{t("工作目录")}</span>
            <div className="local-launch-cwd-row">
              <input
                value={cwd}
                onChange={(event) => {
                  setCwd(event.target.value);
                  setSaved(false);
                }}
                placeholder={t("默认使用启动 Hive 的目录，也可输入 ~/project")}
                aria-label={t("工作目录")}
                disabled={!local.canManage || saving}
              />
              {directories && (
                <Button
                  aria-expanded={picking}
                  disabled={!local.canManage || saving}
                  onClick={() => setPicking((current) => !current)}
                >
                  {t("选择…")}
                </Button>
              )}
            </div>
          </label>
          {picking && directories && (
            <DirectoryPicker
              load={directories}
              value={cwd}
              onPick={(picked) => {
                setCwd(picked);
                setPicking(false);
              }}
              onClose={() => setPicking(false)}
            />
          )}
        </div>
      )}
      {agent.provider === "omp" && access === "workspace" && (
        <p className="openclaw-access-note">
          {t(
            "omp 不会把文件写入限制在当前目录内；需要目录隔离时请选择 OpenCode、Codex 或 Claude Code。",
          )}
        </p>
      )}
      <div className="agent-access-footer">
        <small className="agent-save-status" role="status" aria-live="polite">
          {status}
        </small>
        {dirty && local.canManage && (
          <div className="agent-access-actions">
            <Button size="sm" disabled={saving} onClick={reset}>
              {t("取消")}
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={saving || (writable && !cwd.trim())}
              onClick={() => void save()}
            >
              {saving ? t("保存中…") : live ? t("保存并重启") : t("保存")}
            </Button>
          </div>
        )}
      </div>
      {error && (
        <p className="room-dialog-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
