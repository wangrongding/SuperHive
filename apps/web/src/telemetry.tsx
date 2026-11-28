/**
 * 匿名使用统计在网页里的三处：
 * - 设置 → 这台电脑：开关、查看要发送的数据、重置安装 ID（TelemetrySettingsGroup）；
 * - 右下角一列的首次告知（TelemetryNotice）：只给这台电脑上的本机房主，弹出就算看过，以后不再弹；
 * - 网页自己报的几件事（产物、代码面板第一次打开，桌面端更新结果，界面语言）：Server 在记录时
 *   （/api/meta 的 telemetry）才交给自己的 Server，由它按白名单校验、统一上报，网页从不直接往外发。
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type {
  TelemetryBlocker,
  TelemetryClientRequest,
  TelemetryStatus,
} from "@superhive/protocol";
import { Button, buttonClass } from "./button";
import { DocsLink, docsHref } from "./docs-link";
import { localized, t } from "./i18n";
import type { LocalAgentsState } from "./local-agents";
import { SettingsSwitch } from "./settings-switch";
import { UpdateCard, UpdateCornerPortal } from "./update-card";
import "./styles/telemetry.css";

/* ---------- 网页报的事件 ---------- */

type Reporter = { base: string; token: string };
let reporter: Reporter | undefined;
/** 这个页面里报过的功能：第一次用到才报，Server 那边再按整台电脑去重 */
const reportedFeatures = new Set<string>();

/** Server 在记录、页面是房主时设上；否则清掉，什么都不报 */
export function configureTelemetryReporter(next: Reporter | undefined): void {
  reporter = next;
}

function post(body: TelemetryClientRequest): void {
  if (!reporter) return;
  void fetch(`${reporter.base}/api/telemetry/events`, {
    method: "POST",
    keepalive: true,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${reporter.token}` },
    body: JSON.stringify(body),
  }).catch(() => undefined);
}

export function reportTelemetryFeature(feature: "artifacts_panel" | "code_panel"): void {
  if (!reporter || reportedFeatures.has(feature)) return;
  reportedFeatures.add(feature);
  post({ events: [{ event: "feature_first_used", props: { feature } }] });
}

/** 桌面端安装包失败的原因（update-install.ts 的 InstallFailure）→ 统计里的类别 */
const DESKTOP_FAILURES = new Set([
  "no_package",
  "not_installed",
  "translocated",
  "read_only",
  "not_writable",
  "network",
  "checksum",
  "bad_package",
] as const);
type DesktopFailure = typeof DESKTOP_FAILURES extends Set<infer T> ? T : never;

export function reportDesktopUpdate(outcome: "success" | "failure", reason?: string): void {
  const normalized = reason?.replace(/-/g, "_");
  const category: DesktopFailure | "unknown" = DESKTOP_FAILURES.has(normalized as DesktopFailure)
    ? (normalized as DesktopFailure)
    : "unknown";
  post({
    events: [
      {
        event: "update_result",
        props: { kind: "desktop", outcome, ...(outcome === "failure" ? { reason: category } : {}) },
      },
    ],
  });
}

/** 本机房主网页的界面语言（公共字段 locale） */
export function reportTelemetryLocale(locale: "zh-CN" | "en"): void {
  post({ locale, events: [] });
}

/** 测试之间清空 */
export function resetTelemetryReporter(): void {
  reporter = undefined;
  reportedFeatures.clear();
}

/* ---------- 设置 → 这台电脑 ---------- */

const blockerText: Record<TelemetryBlocker, string> = localized(() => ({
  env: t("设置了环境变量 SUPERHIVE_TELEMETRY=0，一律不记。"),
  do_not_track: t("设置了环境变量 DO_NOT_TRACK，一律不记。"),
  ci: t("在 CI 环境里运行，一律不记。"),
  sandbox: t("在沙箱预览里运行，一律不记。"),
  test: t("在测试环境里运行，一律不记。"),
}));

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export function TelemetrySettingsGroup({ local }: { local: LocalAgentsState }) {
  const [status, setStatus] = useState<TelemetryStatus>();
  const [preview, setPreview] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const { enabled, telemetry } = local;
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    telemetry().then(
      (value) => alive && setStatus(value),
      // 旧版 Server 没有这个接口：整块不显示
      () => alive && setStatus(undefined),
    );
    return () => {
      alive = false;
    };
  }, [enabled, telemetry]);
  if (!enabled || !status) return null;

  const owner = local.mode === "local";
  const run = (action: () => Promise<TelemetryStatus>, refreshPreview: boolean) => {
    setError(undefined);
    setBusy(true);
    action()
      .then(
        async (next) => {
          setStatus(next);
          // 关掉以后没东西可看：收起；开着时刷新已经展开的内容
          if (!next.active) setPreview(undefined);
          else if (refreshPreview && preview !== undefined) await showPreview();
        },
        (reason: unknown) => setError(errorMessage(reason)),
      )
      .finally(() => setBusy(false));
  };
  const showPreview = async () => {
    try {
      const payload = await local.telemetryPreview();
      // 发给统计服务的原始请求体（一个数组）；一条都没有时显示「没有要发送的数据」
      const empty = !payload || (Array.isArray(payload) && payload.length === 0);
      setPreview(empty ? "" : JSON.stringify(payload, null, 2));
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  return (
    <div className="settings-group divided telemetry-settings">
      <SettingsSwitch
        checked={status.enabled && !status.blocker}
        disabled={!owner || Boolean(status.blocker) || busy}
        label={t("匿名使用统计")}
        description={t(
          "每天最多上报一次版本、系统、用过哪些功能这类匿名数据，不收消息、路径、名字和 key",
        )}
        onChange={(checked) => run(() => local.updateTelemetry(checked), true)}
      />
      {status.blocker && <p className="settings-note">{blockerText[status.blocker]}</p>}
      {!status.blocker && !owner && (
        <p className="settings-note">{t("只能在运行 Hive Server 的那台电脑上改。")}</p>
      )}
      {status.active && !status.endpoint && (
        <p className="settings-note">
          {t("源码运行默认不上报：数据只记在这台电脑上，不会发出去。")}
        </p>
      )}
      <div className="telemetry-actions">
        {status.active && (
          <Button
            size="sm"
            aria-expanded={preview !== undefined}
            onClick={() => (preview === undefined ? void showPreview() : setPreview(undefined))}
          >
            {preview === undefined
              ? t("查看要发送的数据（{0} 条）", { 0: status.queued })
              : t("收起")}
          </Button>
        )}
        {owner && status.active && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => run(local.resetTelemetryId, true)}
          >
            {t("重置安装 ID")}
          </Button>
        )}
        <DocsLink to="telemetry">{t("收什么、不收什么")}</DocsLink>
      </div>
      {status.active &&
        preview !== undefined &&
        (preview ? (
          <pre className="telemetry-preview" aria-label={t("要发送的数据")}>
            {preview}
          </pre>
        ) : (
          <p className="settings-note">{t("没有要发送的数据。")}</p>
        ))}
      {error && <p className="settings-note error">{error}</p>}
    </div>
  );
}

/* ---------- 首次告知 ---------- */

/** 页面打开后等多久再查（不和页面启动、别的提醒抢） */
export const NOTICE_DELAY_MS = 5_000;

export function TelemetryNotice({
  local,
  paused = false,
  delayMs = NOTICE_DELAY_MS,
}: {
  local: Pick<LocalAgentsState, "mode" | "telemetry" | "telemetryNoticeShown" | "updateTelemetry">;
  /** 设置弹窗开着：先藏起来，关上后接着显示 */
  paused?: boolean;
  delayMs?: number;
}) {
  const [phase, setPhase] = useState<"hidden" | "open" | "disabled">("hidden");
  const [status, setStatus] = useState<TelemetryStatus>();
  const [error, setError] = useState<string>();
  const checked = useRef(false);
  const { mode, telemetry, telemetryNoticeShown } = local;

  useEffect(() => {
    if (mode !== "local" || checked.current) return;
    let alive = true;
    const timer = window.setTimeout(() => {
      checked.current = true;
      telemetry().then(
        (value) => {
          if (!alive || !value.noticePending) return;
          setStatus(value);
          setPhase("open");
          // 弹出来就算看过：没理它、刷新页面也不再弹
          void telemetryNoticeShown().catch(() => undefined);
        },
        () => undefined,
      );
    }, delayMs);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [mode, telemetry, telemetryNoticeShown, delayMs]);

  useEffect(() => {
    if (phase !== "disabled") return;
    const timer = window.setTimeout(() => setPhase("hidden"), 4_000);
    return () => window.clearTimeout(timer);
  }, [phase]);

  if (phase === "hidden" || paused) return null;
  const close = () => setPhase("hidden");
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    close();
  };

  return (
    <UpdateCornerPortal>
      <div className="telemetry-notice" onKeyDown={onKeyDown}>
        {phase === "disabled" ? (
          <UpdateCard title={t("已关闭匿名使用统计")} tone="ok" onClose={close}>
            <p className="update-card-text">{t("想再打开，到「设置 → 这台电脑」里打开。")}</p>
          </UpdateCard>
        ) : (
          <UpdateCard title={t("匿名使用统计")} onClose={close}>
            <p className="update-card-text">
              {t(
                "为了知道每天有多少人在用、哪些功能有人用、更新有没有出问题，SuperHive 每天最多上报一次版本、系统、用过哪些功能这类匿名数据，不收消息、路径、名字和 key。",
              )}
            </p>
            {status && !status.endpoint && (
              <p className="update-card-text">{t("源码运行默认不上报，数据只留在这台电脑上。")}</p>
            )}
            {error && <p className="update-card-text error">{error}</p>}
            <div className="update-card-actions">
              <a
                className={buttonClass({ variant: "ghost", size: "sm" })}
                href={docsHref("telemetry")}
                target="_blank"
                rel="noreferrer"
              >
                {t("了解详情")}
              </a>
              <Button
                size="sm"
                onClick={() => {
                  setError(undefined);
                  local.updateTelemetry(false).then(
                    () => setPhase("disabled"),
                    (reason: unknown) => setError(errorMessage(reason)),
                  );
                }}
              >
                {t("关闭统计")}
              </Button>
            </div>
          </UpdateCard>
        )}
      </div>
    </UpdateCornerPortal>
  );
}
