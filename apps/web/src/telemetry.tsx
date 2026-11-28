/**
 * 匿名使用统计在网页里的三处：
 * - 设置 → 这台电脑：开关、查看要发送的数据、重置安装 ID（TelemetrySettingsGroup）；
 * - 右下角一列的首次告知（TelemetryNotice）：只给这台电脑上的本机房主，发完第一条消息或页面开了一会儿才出，
 *   弹出就算看过，以后不再弹；
 * - 网页自己报的几件事（产物、代码面板第一次打开，桌面端更新结果，界面语言）：Server 在记录时
 *   （/api/meta 的 telemetry）才交给自己的 Server，由它按白名单校验、统一上报，网页从不直接往外发。
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type {
  TelemetryBlocker,
  TelemetryClientRequest,
  TelemetryStatus,
} from "@superhive/protocol";
import { Icon } from "./app-icons";
import { Button } from "./button";
import { DocsLink } from "./docs-link";
import { localized, t } from "./i18n";
import type { LocalAgentsState } from "./local-agents";
import { SettingsSwitch } from "./settings-switch";
import { UpdateCornerPortal } from "./update-card";
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
    <div className="settings-group divided telemetry-settings" id="settings-telemetry">
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

/** 一直没发消息时，页面打开多久后再出 */
export const NOTICE_IDLE_DELAY_MS = 60_000;
/** 发完第一条消息后等一会儿再出：先让人看到自己的消息上屏 */
export const NOTICE_AFTER_SEND_MS = 2_000;
/** 到点时被挡着（弹窗开着、页面在后台）：隔多久再看一次 */
const NOTICE_RETRY_MS = 2_000;

/** 有弹窗挡着（引导、设置、接入 Agent……）或页面在后台：弹出来没人看见却算看过，先不出 */
function noticeBlocked(): boolean {
  return (
    document.visibilityState === "hidden" ||
    document.querySelector('[aria-modal="true"], dialog[open]') !== null
  );
}

/**
 * 只告知、不引导关：一句话说清收什么、不收别的，「知道了」为主，旁边小字「去设置里关闭」「了解详情」。
 * 不一打开就弹：等发完第一条消息，或页面开了一会儿；弹出就算看过，以后不再弹。
 */
export function TelemetryNotice({
  local,
  paused = false,
  sent = false,
  delayMs = NOTICE_IDLE_DELAY_MS,
  afterSendMs = NOTICE_AFTER_SEND_MS,
  onOpenSettings,
}: {
  local: Pick<LocalAgentsState, "mode" | "telemetry" | "telemetryNoticeShown">;
  /** 设置弹窗开着：先藏起来，关上后接着显示 */
  paused?: boolean;
  /** 这个页面里已经发出过消息 */
  sent?: boolean;
  delayMs?: number;
  afterSendMs?: number;
  /** 「去设置里关闭」：打开设置「这台电脑」，定位到统计开关 */
  onOpenSettings?: () => void;
}) {
  const [due, setDue] = useState(false);
  const [status, setStatus] = useState<TelemetryStatus>();
  const checked = useRef(false);
  const mounted = useRef(true);
  const { mode, telemetry, telemetryNoticeShown } = local;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // 到点：发完第一条消息，或者页面开了一会儿，先到哪个算哪个
  useEffect(() => {
    if (mode !== "local" || due) return;
    const timer = window.setTimeout(() => setDue(true), sent ? afterSendMs : delayMs);
    return () => window.clearTimeout(timer);
  }, [mode, due, sent, delayMs, afterSendMs]);

  // 到点后等没东西挡着再问 Server 要不要弹；只问一次
  useEffect(() => {
    if (!due || paused || checked.current) return;
    let timer = 0;
    const stop = () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", attempt);
    };
    const attempt = () => {
      if (checked.current || noticeBlocked()) return;
      checked.current = true;
      stop();
      telemetry().then(
        (value) => {
          if (!mounted.current || !value.noticePending) return;
          setStatus(value);
          // 弹出来就算看过：没理它、刷新页面也不再弹
          void telemetryNoticeShown().catch(() => undefined);
        },
        () => undefined,
      );
    };
    timer = window.setInterval(attempt, NOTICE_RETRY_MS);
    document.addEventListener("visibilitychange", attempt);
    attempt();
    return stop;
  }, [due, paused, telemetry, telemetryNoticeShown]);

  if (!status || paused) return null;
  const close = () => setStatus(undefined);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    close();
  };
  const title = t("帮我们把 SuperHive 做得更好");

  return (
    <UpdateCornerPortal>
      <section className="update-card telemetry-notice" aria-label={title} onKeyDown={onKeyDown}>
        <span className="update-notice-icon" aria-hidden="true">
          <Icon name="info" size={14} />
        </span>
        <div className="telemetry-notice-body">
          <strong className="telemetry-notice-title">{title}</strong>
          <p className="update-card-text">
            {status.endpoint
              ? t("匿名统计每天有多少人在用、用的什么版本和系统，不会收集任何其它与此无关的信息。")
              : t("从源码运行时不上报，统计只记在这台电脑上。")}
          </p>
          <div className="telemetry-notice-actions">
            <span className="telemetry-notice-links">
              {onOpenSettings && (
                // 和「了解详情」一样的灰色小字：只是给个入口，不抢「知道了」
                <button
                  type="button"
                  className="docs-link telemetry-notice-settings"
                  onClick={() => {
                    close();
                    onOpenSettings();
                  }}
                >
                  {t("去设置里关闭")}
                </button>
              )}
              <DocsLink to="telemetry">{t("了解详情")}</DocsLink>
            </span>
            <Button size="sm" onClick={close}>
              {t("知道了")}
            </Button>
          </div>
        </div>
      </section>
    </UpdateCornerPortal>
  );
}
