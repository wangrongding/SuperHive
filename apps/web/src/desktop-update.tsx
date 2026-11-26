/**
 * 桌面端「有新版本」提示：侧栏底部一个不打扰的入口，点开看版本号、发布说明摘要。
 * 能在应用里直接更新时给「下载并更新」：后台下载（显示进度）→「重启以更新」，不重启就等下次退出 / 打开时生效；
 * 不能（位置只读、老版本桌面端、Release 没传更新包）或失败时退回「下载」安装包，并说明原因。
 * 只在桌面端出现（浏览器里没有 window.superhiveDesktop.updates）。
 *
 * 网页拿不到任何链接：「下载」「完整发布说明」只告诉桌面端打开哪一个，地址由桌面端从自己的检查结果里取，
 * 并且只会是 github.com 上本仓库 Release 下的地址。
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AppDialog } from "./app-dialog";
import { Icon } from "./app-icons";
import { Button } from "./button";
import {
  desktopBridge,
  type DesktopInstallFailure,
  type DesktopUpdateInfo,
  type DesktopUpdatesApi,
} from "./desktop-bridge";
import { getLocale, t, type Locale } from "./i18n";

/** 发布说明一条里中英文用「 / 」隔开（见 Release 说明的写法），按界面语言取一半；没有分隔就原样 */
export function noteForLocale(note: string, locale: Locale): string {
  const parts = note.split(" / ");
  if (parts.length < 2) return note;
  return (locale === "en" ? parts.slice(1).join(" / ") : parts[0]!).trim() || note;
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  // 和访达、GitHub 一样按 1000 进位
  return `${Math.round(bytes / 1_000_000)} MB`;
}

function formatDate(value: string | undefined, locale: Locale): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(locale === "en" ? "en-US" : "zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** 订阅桌面端的新版检查结果；不在桌面端（或老版本桌面端）时一直是 undefined */
export function useDesktopUpdate(api: DesktopUpdatesApi | undefined = desktopBridge()?.updates): {
  info: DesktopUpdateInfo | undefined;
  api: DesktopUpdatesApi | undefined;
} {
  const [info, setInfo] = useState<DesktopUpdateInfo>();
  useEffect(() => {
    if (!api) return;
    let alive = true;
    const off = api.onChange((next) => {
      if (alive) setInfo(next ?? undefined);
    });
    void api
      .get()
      .then((next) => {
        if (alive) setInfo(next ?? undefined);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      off();
    };
  }, [api]);
  return { info, api };
}

/** 不能直接更新 / 更新失败的原因，给人看的说明 */
export function installReasonText(reason: DesktopInstallFailure): string {
  switch (reason) {
    case "translocated":
      return t(
        "SuperHive 是从「下载」等位置直接打开的，系统把它放在只读的临时位置，没法原地更新。把 SuperHive 拖进「应用程序」再打开，以后就能直接更新。",
      );
    case "read-only":
      return t("SuperHive 在只读的磁盘（比如 dmg）里运行，没法原地更新。先把它拖进「应用程序」。");
    case "not-writable":
      return t("SuperHive 所在的文件夹没有写权限，没法原地更新。");
    case "not-installed":
      return t("这个 SuperHive 不是用安装包装的，没法直接更新。");
    case "no-package":
      return t("这个版本没有提供应用内更新包。");
    case "network":
      return t("下载没成功，可能是网络问题。");
    case "checksum":
      return t("下载的文件校验不通过，已经丢弃。");
    case "bad-package":
      return t("更新包的内容不对，已经丢弃。");
    default:
      return t("更新时出了问题。");
  }
}

function percent(received: number, total: number): number | undefined {
  if (!(total > 0)) return undefined;
  return Math.min(100, Math.floor((received / total) * 100));
}

export function DesktopUpdateEntry({
  api: injected,
  platform = desktopBridge()?.platform,
  variant = "sidebar",
}: {
  api?: DesktopUpdatesApi;
  platform?: string;
  /** sidebar=左栏底部的入口；status=底部状态栏里的一小项 */
  variant?: "sidebar" | "status";
}) {
  const { info, api } = useDesktopUpdate(injected ?? desktopBridge()?.updates);
  const [open, setOpen] = useState(false);
  const [dismissedLocally, setDismissedLocally] = useState<string>();
  if (!api || !info || dismissedLocally === info.version) return null;
  const locale = getLocale();
  const published = formatDate(info.publishedAt, locale);
  const notes = info.notes.map((note) => noteForLocale(note, locale)).filter(Boolean);
  const close = () => setOpen(false);
  // 老版本桌面端没有 install / restart，或者没有 install 状态：照旧只给「下载」
  const install = api.install && api.restart ? info.install : undefined;
  const state = install?.state ?? { phase: "idle" as const };
  const canInstall = Boolean(install?.available) && state.phase === "idle";
  const busy = state.phase === "downloading" || state.phase === "verifying";
  const size = formatSize(canInstall ? install!.size : info.assetSize);
  const progress = state.phase === "downloading" ? percent(state.received, state.total) : undefined;
  const isWindows = platform === "win32";

  const entryLabel =
    state.phase === "ready"
      ? t("重启以更新到 {0}", { 0: info.version })
      : busy
        ? progress !== undefined
          ? t("正在下载新版本 {0}%", { 0: progress })
          : t("正在下载新版本…")
        : t("有新版本 {0}", { 0: info.version });

  // 不能直接更新或失败时的主按钮：下载安装包
  const download = (
    <Button
      variant="primary"
      onClick={() => {
        void api.open("download");
        close();
      }}
    >
      {state.phase === "failed" ? t("下载安装包") : t("下载")}
      {!canInstall && size && <span className="desktop-update-size">{size}</span>}
    </Button>
  );

  let primary;
  if (state.phase === "ready") {
    primary = (
      <Button variant="primary" onClick={() => void api.restart?.()}>
        {t("重启以更新")}
      </Button>
    );
  } else if (busy) {
    primary = (
      <Button variant="primary" disabled>
        {state.phase === "verifying"
          ? t("正在校验…")
          : progress !== undefined
            ? t("下载中 {0}%", { 0: progress })
            : t("下载中…")}
      </Button>
    );
  } else if (canInstall) {
    primary = (
      <Button variant="primary" onClick={() => void api.install?.(info.version)}>
        {t("下载并更新")}
        {size && <span className="desktop-update-size">{size}</span>}
      </Button>
    );
  } else {
    primary = download;
  }

  let hint: string;
  if (state.phase === "ready") {
    hint = isWindows
      ? t("新版本已下载好。现在不重启的话，下次打开 SuperHive 就是新版本。")
      : t("新版本已下载好。现在不重启的话，下次退出 SuperHive 时自动换上新版本。");
  } else if (busy) {
    hint = isWindows
      ? t("正在后台下载，可以关掉这个窗口继续用。下好后重启就是新版本。")
      : t("正在后台下载，可以关掉这个窗口继续用。下好后重启就是新版本，下载的文件会先校验。");
  } else if (canInstall) {
    hint = isWindows
      ? t(
          "在后台下载新版本，下好后重启就是新版本，也可以等下次打开时再换。房间、消息和设置都会保留。",
        )
      : t(
          "在后台下载新版本，下好后重启就是新版本，也可以等下次退出时再换。房间、消息和设置都会保留。",
        );
  } else {
    hint = isWindows
      ? t("下载后直接运行安装包，会关掉正在运行的 SuperHive 并覆盖安装，房间、消息和设置都会保留。")
      : t(
          "下载后打开 dmg，把 SuperHive 拖进「应用程序」替换旧版，再重新打开。房间、消息和设置都会保留。",
        );
  }
  // 为什么只能手动下载：位置不对、开发版这些要说；Release 没传更新包就不打扰了
  const reasonText =
    state.phase === "failed"
      ? t("没能直接更新：{0}当前版本不受影响，可以下载安装包手动更新。", {
          0: installReasonText(state.reason),
        })
      : install && !install.available && install.reason && install.reason !== "no-package"
        ? installReasonText(install.reason)
        : undefined;

  return (
    <>
      <button
        type="button"
        className={
          variant === "status"
            ? "status-item ok desktop-update-status"
            : "sidebar-action desktop-update-entry"
        }
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <span className="desktop-update-dot" aria-hidden="true">
          <Icon name="arrow-up" size={12} />
        </span>
        <span>{entryLabel}</span>
      </button>
      {open &&
        createPortal(
          <AppDialog
            size="sm"
            title={
              state.phase === "ready"
                ? t("新版本 {0} 已下载好", { 0: info.version })
                : t("有新版本 {0}", { 0: info.version })
            }
            className="desktop-update-dialog"
            onClose={close}
            footer={
              <>
                {primary}
                {state.phase === "failed" && install?.available && (
                  <Button onClick={() => void api.install?.(info.version)}>{t("重试")}</Button>
                )}
                {(state.phase === "idle" || state.phase === "failed") && (
                  <Button
                    onClick={() => {
                      setDismissedLocally(info.version);
                      close();
                      void api.dismiss(info.version);
                    }}
                  >
                    {t("忽略这个版本")}
                  </Button>
                )}
                <Button variant="link" onClick={() => void api.open("release")}>
                  {t("完整发布说明")}
                  <Icon name="external" size={13} />
                </Button>
              </>
            }
          >
            <p className="desktop-update-meta">
              {published
                ? t("你现在用的是 {0}，新版发布于 {1}。", { 0: info.currentVersion, 1: published })
                : t("你现在用的是 {0}。", { 0: info.currentVersion })}
            </p>
            {notes.length > 0 && (
              <>
                <h3 className="desktop-update-heading">{t("本版改动")}</h3>
                <ul className="desktop-update-notes">
                  {notes.map((note, index) => (
                    <li key={index}>{note}</li>
                  ))}
                </ul>
              </>
            )}
            {busy && (
              <div
                className="desktop-update-progress"
                role="progressbar"
                aria-label={t("下载进度")}
                aria-valuemin={0}
                aria-valuemax={100}
                {...(progress !== undefined ? { "aria-valuenow": progress } : {})}
              >
                <span
                  className={progress === undefined ? "indeterminate" : undefined}
                  style={progress !== undefined ? { width: `${progress}%` } : undefined}
                />
              </div>
            )}
            {reasonText && (
              <p className="desktop-update-reason" role="status">
                {reasonText}
              </p>
            )}
            <p className="desktop-update-hint">{hint}</p>
          </AppDialog>,
          document.body,
        )}
    </>
  );
}
