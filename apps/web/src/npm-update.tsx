import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type {
  LocalSessionResponse,
  NpmUpdateBlocker,
  NpmUpdateChoice,
  NpmUpdateInfo,
  NpmUpdateJob,
} from "@superhive/protocol";
import { AppDialog } from "./app-dialog";
import { Icon } from "./app-icons";
import { Button } from "./button";
import { desktopBridge } from "./desktop-bridge";
import { getLocale, t } from "./i18n";
import { noteForLocale } from "./desktop-update";
import "./styles/npm-update.css";

export function npmUpdateReason(blocker: NpmUpdateBlocker | null): string {
  switch (blocker) {
    case "source":
      return t("当前从源码运行，请拉取代码、重新构建并重启开发服务。");
    case "npx":
      return t("当前通过 npx 临时运行，没有可直接替换的全局安装。");
    case "permissions":
      return t("全局安装目录不可写。请先把 npm 全局目录改到自己的目录，不要使用 sudo。");
    case "external":
      return t("当前服务由外部进程管理或在前台运行。更新后请用原来的进程管理器重启。");
    case "desktop":
      return t("请使用桌面客户端自己的应用内更新。");
    case "installer":
      return t("当前不是 npm 全局安装，请在终端使用原来的包管理器更新。");
    default:
      return "";
  }
}

export function npmUpdatePhase(job: NpmUpdateJob): string {
  switch (job.phase) {
    case "installing":
      return t("正在安装新版本…");
    case "waiting":
      return t("等待 Agent 完成任务…");
    case "restarting":
      return t("正在重启并重新连接…");
    case "rolling_back":
      return t("正在恢复旧版本…");
    case "completed":
      return t("已更新到 {0}", { 0: job.target });
    case "failed":
      return t("更新未完成");
  }
}

export function npmUpdateFailure(message: string): string {
  const exit = /Update command failed \(exit (.+)\)/.exec(message);
  if (exit) return t("更新命令失败（退出码 {0}），请查看服务端更新日志。", { 0: exit[1] ?? "" });
  if (message === "Update command timed out")
    return t("更新命令超时，请检查网络和服务端更新日志。");
  if (message.startsWith("Update worker stopped unexpectedly"))
    return t("更新进程意外停止，请先检查服务状态和更新日志，再手动更新。");
  return message;
}

function activeJob(job: NpmUpdateJob | null): boolean {
  return Boolean(job && !["completed", "failed"].includes(job.phase));
}

export function NpmUpdateEntry({ base, token }: { base: string; token: string }) {
  const [info, setInfo] = useState<NpmUpdateInfo>();
  const [job, setJob] = useState<NpmUpdateJob | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [localOwner, setLocalOwner] = useState(false);
  const [choice, setChoice] = useState<NpmUpdateChoice>("wait");
  const [error, setError] = useState<string>();
  const [restoring, setRestoring] = useState(false);
  const storageKey = `superhive.npm-update:${base}`;
  const desktop = Boolean(desktopBridge());

  const ownerHeaders = async () => {
    const response = await fetch(`${base}/api/local/update/session`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    const session = (await response.json()) as LocalSessionResponse;
    if (!session.enabled || session.mode === "device" || !session.ownerToken) return undefined;
    return { "X-Hive-Owner": session.ownerToken, "Content-Type": "application/json" };
  };

  useEffect(() => {
    if (desktop) return;
    let cancelled = false;
    const check = async () => {
      try {
        const response = await fetch(`${base}/api/update`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(25_000),
        });
        if (!response.ok) return;
        const value = (await response.json()) as {
          update: Pick<NpmUpdateInfo, "current" | "latest" | "notes" | "releaseUrl"> | null;
        };
        if (!cancelled && value.update)
          setInfo({
            ...value.update,
            canUpdate: false,
            blocker: null,
            manualCommand: "",
            busyAgents: [],
            canHandover: false,
          });
        const saved = sessionStorage.getItem(storageKey);
        if (!cancelled && saved) {
          const previous = JSON.parse(saved) as NpmUpdateJob;
          if (activeJob(previous) || !value.update || previous.target === value.update.latest) {
            setJob(previous);
            setRestoring(true);
          } else {
            setJob(null);
            sessionStorage.removeItem(storageKey);
          }
        }
      } catch {
        return;
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), 60 * 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [base, token, desktop, storageKey]);

  useEffect(() => {
    if (desktop || (!activeJob(job) && !restoring)) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const headers = await ownerHeaders();
        if (!headers) return;
        const response = await fetch(`${base}/api/local/update/current`, {
          headers,
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) return;
        const value = (await response.json()) as { job: NpmUpdateJob | null };
        if (cancelled) return;
        if (!value.job) {
          setRestoring(false);
          return;
        }
        setLocalOwner(true);
        setJob(value.job);
        setRestoring(false);
        sessionStorage.setItem(storageKey, JSON.stringify(value.job));
        if (
          value.job.phase === "completed" &&
          sessionStorage.getItem(`${storageKey}:reloaded`) !== value.job.id
        ) {
          sessionStorage.setItem(`${storageKey}:reloaded`, value.job.id);
          window.location.reload();
        }
      } catch {
        return;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [base, token, job?.id, job?.phase, restoring, desktop, storageKey]);

  const show = async () => {
    setOpen(true);
    setLoading(true);
    setError(undefined);
    try {
      const headers = await ownerHeaders();
      setLocalOwner(Boolean(headers));
      if (!headers) return;
      const response = await fetch(`${base}/api/local/update`, {
        headers,
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(t("暂时无法检查更新，请稍后重试。"));
      const value = (await response.json()) as { info: NpmUpdateInfo; job: NpmUpdateJob | null };
      setInfo(value.info);
      setJob(
        value.job &&
          (activeJob(value.job) || !value.info.latest || value.job.target === value.info.latest)
          ? value.job
          : null,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  const start = async () => {
    if (!info?.latest) return;
    setLoading(true);
    setError(undefined);
    try {
      const headers = await ownerHeaders();
      if (!headers) throw new Error(t("只有本机房主能更新，请在运行 Hive 的电脑上打开网页。"));
      const response = await fetch(`${base}/api/local/update`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          target: info.latest,
          ...(!info.canHandover && info.busyAgents.length ? { choice } : {}),
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const value = (await response.json()) as {
        job?: NpmUpdateJob;
        info?: NpmUpdateInfo;
        error?: string;
        code?: string;
      };
      if (value.info) setInfo(value.info);
      if (!response.ok) {
        setError(
          value.code === "UPDATE_BUSY" || value.code === "UPDATE_CHANGED"
            ? t("更新条件已变化，请检查后再次确认。")
            : (value.error ?? t("更新未完成")),
        );
        return;
      }
      if (!value.job) throw new Error(t("更新未完成"));
      setJob(value.job);
      sessionStorage.setItem(storageKey, JSON.stringify(value.job));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setRestoring(true);
    } finally {
      setLoading(false);
    }
  };

  if (desktop || (!info?.latest && !job)) return null;
  const busy = activeJob(job);
  const latest = info?.latest ?? job?.target;
  const label =
    busy && job
      ? npmUpdatePhase(job)
      : job?.phase === "completed"
        ? npmUpdatePhase(job)
        : t("有新版本 {0}", { 0: latest ?? "" });
  const close = () => {
    setOpen(false);
    if (job?.phase === "completed") {
      setJob(null);
      sessionStorage.removeItem(storageKey);
    }
  };
  return (
    <>
      <button
        className="status-item npm-update-entry"
        type="button"
        onClick={() => void show()}
        aria-label={label}
      >
        <Icon name={busy ? "clock" : "arrow-up"} size={13} />
        <span>{label}</span>
      </button>
      {open &&
        createPortal(
          <AppDialog
            size="sm"
            title={t("更新 SuperHive")}
            className="npm-update-dialog"
            onClose={close}
            footer={
              <>
                <Button onClick={close}>{busy ? t("继续使用") : t("关闭")}</Button>
                {localOwner && info?.canUpdate && info.latest && job?.phase !== "completed" && (
                  <Button variant="primary" disabled={loading || busy} onClick={() => void start()}>
                    {busy && job ? npmUpdatePhase(job) : t("更新并重启")}
                  </Button>
                )}
              </>
            }
          >
            <div className="npm-update-versions">
              <span>{info?.current ?? job?.previous}</span>
              <Icon name="arrow-right" size={18} />
              <strong>{latest}</strong>
            </div>
            {info?.notes.length ? (
              <ul className="desktop-update-notes">
                {info.notes.map((note, index) => (
                  <li key={index}>{noteForLocale(note, getLocale())}</li>
                ))}
              </ul>
            ) : (
              <p className="desktop-update-hint">
                {t("发布说明摘要暂不可用，可以查看完整发布说明。")}
              </p>
            )}
            {info?.releaseUrl && (
              <a href={info.releaseUrl} target="_blank" rel="noreferrer">
                {t("完整发布说明")}
              </a>
            )}
            <p className="desktop-update-hint">
              {loading
                ? t("正在检查更新…")
                : !localOwner
                  ? t("有新版本，请联系房主。只有本机房主可以更新并重启服务。")
                  : info?.blocker
                    ? npmUpdateReason(info.blocker)
                    : t(
                        "先在后台安装并校验，再替换 Server。页面会自动重连，房间、消息和设置保留。",
                      )}
            </p>
            {localOwner && info?.canUpdate && (
              <p className="npm-update-handover">
                {info.canHandover
                  ? t("本机 Agent 不下线，正在执行的任务继续。")
                  : t("当前服务无法交接 Agent；没有正在执行的任务时可以直接重启。")}
              </p>
            )}
            {localOwner &&
              info?.canUpdate &&
              !info.canHandover &&
              info.busyAgents.length > 0 &&
              !busy && (
                <fieldset className="npm-update-choice">
                  <legend>
                    {t("{0} 正在执行任务，重启将中断它们，请确认：", {
                      0: info.busyAgents.join(t("、")),
                    })}
                  </legend>
                  <label>
                    <input
                      type="radio"
                      name="npm-update-choice"
                      checked={choice === "wait"}
                      onChange={() => setChoice("wait")}
                    />
                    {t("等任务完成后更新（推荐）")}
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="npm-update-choice"
                      checked={choice === "now"}
                      onChange={() => setChoice("now")}
                    />
                    {t("立即更新，中断正在执行的任务")}
                  </label>
                </fieldset>
              )}
            {job && (
              <p role="status" aria-live="polite">
                {npmUpdatePhase(job)}
              </p>
            )}
            {(error || job?.error) && (
              <div role="alert" className="desktop-update-reason">
                {npmUpdateFailure(error ?? job?.error ?? "")}
                <p>
                  {job?.rolledBack
                    ? t("已恢复旧包并重启旧版本。")
                    : t(
                        "如果安装失败，旧 Server 不受影响；若无法重连，请在终端检查 hive 状态和更新日志。",
                      )}
                </p>
              </div>
            )}
            {localOwner && info?.manualCommand && (!info.canUpdate || job?.phase === "failed") && (
              <pre className="npm-update-command">{info.manualCommand}</pre>
            )}
          </AppDialog>,
          document.body,
        )}
    </>
  );
}
