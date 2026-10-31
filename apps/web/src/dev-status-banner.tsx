import { useEffect, useRef, useState } from "react";
import { DEV_STATUS_PATH, parseDevStatus, shouldReload, type DevStatus } from "./dev-status";
import { localized, t } from "./i18n";

const RELOADED_KEY = "hive-dev-reloaded-generation";
const READY_NOTICE_MS = 4000;
/** 本机开发接口，轮询比 HMR 推送更稳：Vite 重启、页面切后台再回来都不会漏掉状态 */
const POLL_MS = 1000;

const LABELS: Record<DevStatus["state"], string> = localized(() => ({
  pending: t("检测到改动，即将更新…"),
  building: t("正在编译最新改动…"),
  restarting: t("正在重启服务…"),
  ready: t("已运行最新改动"),
  failed: t("更新失败，修正后会自动重试"),
}));

function describeFiles(files: string[] | undefined): string {
  if (!files?.length) return "";
  return files.length === 1 ? files[0]! : t("{0} 等 {1} 个文件", { 0: files[0], 1: files.length });
}

/**
 * 开发模式下显示 dev supervisor 的更新进度；新代次更新成功后整页刷新，让页面和服务端都跑最新代码。
 * 没有 supervisor（状态文件不存在）或生产构建时不渲染任何东西。
 */
export function DevStatusBanner() {
  const [status, setStatus] = useState<DevStatus>();
  const [showReady, setShowReady] = useState(false);
  const baselineRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const apply = (next: DevStatus) => {
      // 首个状态作为本页的基准代次，之后出现更新成功的新代次就刷新
      if (baselineRef.current === undefined) {
        baselineRef.current = next.generation;
        const reloaded = Number(sessionStorage.getItem(RELOADED_KEY));
        if (reloaded === next.generation && next.state === "ready") {
          sessionStorage.removeItem(RELOADED_KEY);
          setShowReady(true);
        }
      } else if (shouldReload(baselineRef.current, next)) {
        sessionStorage.setItem(RELOADED_KEY, String(next.generation));
        window.location.reload();
        return;
      }
      setStatus(next);
    };

    let cancelled = false;
    const poll = () =>
      fetch(DEV_STATUS_PATH, { cache: "no-store" })
        .then((response) => (response.ok ? response.json() : null))
        .then((value: unknown) => {
          const parsed = parseDevStatus(value);
          if (!cancelled && parsed) apply(parsed);
        })
        .catch(() => undefined);
    void poll();
    const timer = window.setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!showReady) return;
    const timer = window.setTimeout(() => setShowReady(false), READY_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [showReady]);

  if (!status) return null;
  if (status.state === "ready" && !showReady) return null;

  const files = describeFiles(status.changedFiles);
  return (
    <div className={`dev-status dev-status-${status.state}`} role="status" aria-live="polite">
      <span className="dev-status-dot" aria-hidden="true" />
      <span className="dev-status-label">{LABELS[status.state]}</span>
      <span className="dev-status-meta">
        {t("代次 {0} {1}", { 0: status.generation, 1: files ? ` · ${files}` : "" })}
      </span>
      {status.state === "failed" && status.error ? (
        <pre className="dev-status-error">{status.error}</pre>
      ) : null}
    </div>
  );
}
