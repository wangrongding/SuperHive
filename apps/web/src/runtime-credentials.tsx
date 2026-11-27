import { useEffect, useRef, useState } from "react";
import type {
  RuntimeCredentialEffect,
  RuntimeCredentialField,
  RuntimeCredentialFieldInfo,
  RuntimeCredentialProvider,
  UpdateRuntimeCredentialsRequest,
} from "@superhive/protocol";
import { ConfirmPopover } from "./confirm-popover";
import { t } from "./i18n";
import type { LocalAgentsState, RuntimeCredentialsWithAgents } from "./local-agents";
import { Button } from "./button";

/**
 * 运行时接口地址与密钥的一行（Agent CLI 配置面板的「接入」里用）：
 * 读写的是 CLI 自己的全局配置，同一运行时的 Agent 和终端里的 CLI 一起变。
 * 默认打码；「显示」要就地确认，完整值 30 秒后自动收起；改之前提示会影响终端里的 CLI。
 * 值只在这个组件的状态里，不进聊天、不经过 Agent。
 */

export type RuntimeCredentialsApi = Pick<
  LocalAgentsState,
  "revealRuntimeCredential" | "updateRuntimeCredentials" | "act"
>;

export const REVEAL_MS = 30_000;

export const RUNTIME_LABELS: Record<RuntimeCredentialProvider, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "opencode",
  omp: "omp",
  openclaw: "OpenClaw",
  copilot: "Copilot CLI",
};

/** 网页上能改接口地址、密钥等配置的运行时（Gemini CLI、agy 还没有） */
export function hasRuntimeConfig(tool: string): tool is RuntimeCredentialProvider {
  return Object.hasOwn(RUNTIME_LABELS, tool);
}

const fieldLabel = (field: RuntimeCredentialField) =>
  field === "baseUrl" ? t("接口地址（base URL）") : "API key";

const errorMessage = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);

/** 改完配置后的提示：按运行时说明要不要重启，常驻的给一键重启用这个运行时的本机 Agent */
export function RestartNotice({
  api,
  provider,
  effect,
  agents,
}: {
  api: Pick<RuntimeCredentialsApi, "act">;
  provider: RuntimeCredentialProvider;
  effect: RuntimeCredentialEffect;
  agents: RuntimeCredentialsWithAgents["agents"];
}) {
  const [restarting, setRestarting] = useState(false);
  const [restartResult, setRestartResult] = useState<string>();
  const label = RUNTIME_LABELS[provider];
  const live = agents.filter((agent) => agent.status !== "stopped");

  const restart = async () => {
    setRestarting(true);
    setRestartResult(undefined);
    const failed: string[] = [];
    for (const agent of live) {
      try {
        await api.act(agent.id, "restart");
      } catch {
        failed.push(agent.name);
      }
    }
    setRestarting(false);
    setRestartResult(
      failed.length
        ? t("这些 Agent 没能重启：{0}", { 0: failed.join(t("、")) })
        : t("已重启 {0} 个 Agent", { 0: live.length }),
    );
  };

  return (
    <div className="runtime-credentials-restart" role="status">
      <p>{savedMessage(effect, agents, label)}</p>
      {effect === "restart" && live.length > 0 && (
        <Button
          size="sm"
          className="settings-button"
          disabled={restarting}
          onClick={() => void restart()}
        >
          {restarting ? t("正在重启…") : t("重启这 {0} 个 Agent", { 0: live.length })}
        </Button>
      )}
      {restartResult && <p className="settings-note">{restartResult}</p>}
    </div>
  );
}

/** 保存后怎么生效：按运行时实际的运行方式写 */
function savedMessage(
  effect: RuntimeCredentialEffect,
  agents: RuntimeCredentialsWithAgents["agents"],
  label: string,
): string {
  const names = agents.map((agent) => agent.name).join(t("、"));
  if (effect === "nextTurn") {
    return t("已保存，不用重启：{0} Agent 从下一轮起就用新值，终端里新开的 {0} 也一样。", {
      0: label,
    });
  }
  if (effect === "gateway") {
    return t(
      "已保存。OpenClaw Agent 每一轮都新起进程，但默认经 OpenClaw gateway 执行；没生效的话，在终端运行 openclaw gateway restart 重启 gateway。",
    );
  }
  return agents.length
    ? t("已保存。{0} 的 Agent 是常驻进程，需要重启才生效：{1}", { 0: label, 1: names })
    : t("已保存。这台电脑上还没有用 {0} 的 Agent；终端里新开的 {0} 会直接用新值。", {
        0: label,
      });
}

export function CredentialRow({
  api,
  provider,
  runtimeLabel,
  field,
  info,
  onSaved,
}: {
  api: RuntimeCredentialsApi;
  provider: RuntimeCredentialProvider;
  runtimeLabel: string;
  field: RuntimeCredentialField;
  info: RuntimeCredentialFieldInfo;
  onSaved: (next: RuntimeCredentialsWithAgents) => void;
}) {
  const [revealed, setRevealed] = useState<string>();
  const [confirmReveal, setConfirmReveal] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [confirmSave, setConfirmSave] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const revealRef = useRef<HTMLButtonElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const name = fieldLabel(field);

  // 完整值 30 秒后自动收起
  useEffect(() => {
    if (revealed === undefined) return;
    const timer = window.setTimeout(() => setRevealed(undefined), REVEAL_MS);
    return () => window.clearTimeout(timer);
  }, [revealed]);

  const reveal = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setRevealed((await api.revealRuntimeCredential(provider, field)) ?? "");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
      setConfirmReveal(false);
      revealRef.current?.focus();
    }
  };

  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const input: UpdateRuntimeCredentialsRequest =
        field === "baseUrl" ? { baseUrl: draft.trim() } : { apiKey: draft.trim() };
      const next = await api.updateRuntimeCredentials(provider, input);
      setEditing(false);
      setDraft("");
      setRevealed(undefined);
      onSaved(next);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
      setConfirmSave(false);
    }
  };

  const valid =
    field === "baseUrl"
      ? /^https?:\/\/\S+$/.test(draft.trim())
      : /^[\x21-\x7e]+$/.test(draft.trim());

  return (
    <div className="runtime-credential-row">
      <div className="runtime-credential-value">
        <span>{name}</span>
        <code aria-label={t("{0} 的值", { 0: name })}>
          {revealed !== undefined ? revealed : (info.masked ?? t("未设置"))}
        </code>
        <small>{info.location}</small>
        {info.note && <small className="runtime-credential-note">{info.note}</small>}
        {info.shadowedBy && (
          <small className="runtime-credential-note" role="note">
            {t("被 {0} 覆盖，改这里不生效", { 0: info.shadowedBy })}
          </small>
        )}
      </div>
      <div className="runtime-credential-actions">
        {info.set &&
          (revealed !== undefined ? (
            <Button size="sm" onClick={() => setRevealed(undefined)}>
              {t("隐藏")}
            </Button>
          ) : (
            <Button
              size="sm"
              ref={revealRef}
              aria-expanded={confirmReveal}
              disabled={busy}
              onClick={() => setConfirmReveal(true)}
            >
              {t("显示")}
            </Button>
          ))}
        {info.editable && !editing && (
          <Button
            size="sm"
            onClick={() => {
              setEditing(true);
              setError(undefined);
            }}
          >
            {t("修改")}
          </Button>
        )}
      </div>
      {confirmReveal && (
        <ConfirmPopover
          ariaLabel={t("确认显示完整的 {0}", { 0: name })}
          message={t("完整的 {0} 会显示在这个页面上，30 秒后自动隐藏。确认身边没有别人在看屏幕。", {
            0: name,
          })}
          confirmLabel={t("显示")}
          cancelLabel={t("取消")}
          anchorRef={revealRef}
          busy={busy}
          onConfirm={() => void reveal()}
          onCancel={() => {
            setConfirmReveal(false);
            revealRef.current?.focus();
          }}
        />
      )}
      {editing && (
        <form
          className="runtime-credential-edit"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) setConfirmSave(true);
          }}
        >
          <input
            type={field === "apiKey" ? "password" : "url"}
            aria-label={t("新的 {0}", { 0: name })}
            autoComplete="off"
            spellCheck={false}
            placeholder={field === "baseUrl" ? "https://" : ""}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button
            size="sm"
            onClick={() => {
              setEditing(false);
              setDraft("");
              setConfirmSave(false);
            }}
          >
            {t("取消")}
          </Button>
          <Button
            type="submit"
            size="sm"
            variant="primary"
            ref={saveRef}
            disabled={!valid || busy}
            aria-expanded={confirmSave}
          >
            {t("保存")}
          </Button>
        </form>
      )}
      {confirmSave && (
        <ConfirmPopover
          ariaLabel={t("确认修改 {0}", { 0: name })}
          title={t("会同时影响终端里的 {0}", { 0: runtimeLabel })}
          message={t(
            "将改写 {0}（原文件先备份）。这台电脑上的 {1} Agent 重启后生效，终端里新开的 {1} 也会用新值。",
            { 0: info.location, 1: runtimeLabel },
          )}
          confirmLabel={t("保存")}
          cancelLabel={t("取消")}
          anchorRef={saveRef}
          danger
          busy={busy}
          onConfirm={() => void save()}
          onCancel={() => {
            setConfirmSave(false);
            saveRef.current?.focus();
          }}
        />
      )}
      {error && <p className="settings-note error">{error}</p>}
    </div>
  );
}
