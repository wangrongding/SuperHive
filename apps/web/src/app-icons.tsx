import type { ReactNode } from "react";
import { localized, t } from "./i18n";
import { ThemePreference } from "./app-storage";
import { Tooltip } from "./tooltip";

export type IconName =
  | "alert"
  | "arrow-down"
  | "arrow-right"
  | "arrow-up"
  | "at"
  | "activity"
  | "bell"
  | "board"
  | "check"
  | "clock"
  | "close"
  | "copy"
  | "devices"
  | "download"
  | "external"
  | "files"
  | "hash"
  | "help"
  | "info"
  | "logout"
  | "maximize"
  | "minimize"
  | "message"
  | "minus"
  | "more"
  | "panel-bottom"
  | "panel-left"
  | "panel-right"
  | "plug"
  | "plus"
  | "quote"
  | "refresh"
  | "send"
  | "search"
  | "settings"
  | "share"
  | "shield"
  | "terminal"
  | "undo"
  | "user"
  | "user-plus"
  | "users";

/** git 分支的小图标（房间工作区是仓库时显示当前分支） */
/** 置顶房间名前的小图钉 */
export function PinGlyph() {
  return (
    <svg className="room-item-pin" viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
      <path
        d="M10.3 1.8 14.2 5.7l-1.4.5-2.6 2.6.3 3.2-1.3 1.3-2.6-2.6L3 14.3l-.9.1-.1-.9 3.6-3.6L3 7.3 4.3 6l3.2.3 2.6-2.6.2-1.9Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    alert: <path d="M12 4 2.8 19.5h18.4L12 4Zm0 6v4.5m0 2.6v.1" />,
    "arrow-down": <path d="M12 5v14m-5-5 5 5 5-5" />,
    "arrow-right": <path d="M5 12h14m-5-5 5 5-5 5" />,
    "arrow-up": <path d="M12 19V5m-6 6 6-6 6 6" />,
    at: (
      <>
        <circle cx="12" cy="12" r="3.6" />
        <path d="M15.6 12v1.4a2.6 2.6 0 0 0 5.2 0V12a8.8 8.8 0 1 0-3.4 7" />
      </>
    ),
    activity: <path d="M3 12h4l2.5-6 5 12 2.5-6H21" />,
    maximize: <path d="M15 4h5v5M9 20H4v-5M20 4l-6.5 6.5M4 20l6.5-6.5" />,
    minimize: <path d="M14 10h5.5M14 10V4.5M10 14H4.5M10 14v5.5M14 10l6-6M10 14l-6 6" />,
    search: (
      <>
        <circle cx="11" cy="11" r="6.5" />
        <path d="m20 20-4.4-4.4" />
      </>
    ),
    board: (
      <>
        <rect x="5" y="4" width="14" height="17" rx="2" />
        <path d="M9 3h6v3H9zM9 11h6M9 15h4" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    terminal: (
      <>
        <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
        <path d="m7.5 9.5 3 2.5-3 2.5M12.5 15h4" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 7.5V12l3 2" />
      </>
    ),
    close: <path d="m6 6 12 12M18 6 6 18" />,
    copy: (
      <>
        <rect x="8" y="8" width="11" height="11" rx="2" />
        <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
      </>
    ),
    devices: (
      <>
        <rect x="3" y="5" width="13" height="10" rx="1.5" />
        <path d="M6.5 19h6" />
        <rect x="16" y="9" width="5" height="10" rx="1.2" />
      </>
    ),
    download: <path d="M12 4v11m-4.5-4.5L12 15l4.5-4.5M5 19h14" />,
    external: (
      <path d="M14 5h5v5m0-5-8 8M19 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
    ),
    help: (
      <path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm-2.6-11.6a2.7 2.7 0 0 1 5.2.9c0 1.8-2.6 2.4-2.6 4M12 17v.1" />
    ),
    info: (
      <>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 11v5.5M12 7.8v.1" />
      </>
    ),
    // 收起：一道横线
    minus: <path d="M6 12h12" />,
    // 检查更新：转一圈的箭头
    refresh: <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4" />,
    bell: <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2H4.5L6 16Zm4 4a2 2 0 0 0 4 0" />,
    undo: <path d="M9 14 4 9l5-5M4 9h9.5a6.5 6.5 0 0 1 0 13H11" />,
    // 引用回复：折回去的箭头
    quote: <path d="M10 5 4 11l6 6M4 11h9a7 7 0 0 1 7 7v1" />,
    hash: <path d="M9 4 7 20M17 4l-2 16M4 9h17M3 15h17" />,
    logout: <path d="M10 5H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4m5-4 3-3-3-3m3 3H9" />,
    more: <path d="M6 12h.01M12 12h.01M18 12h.01" strokeWidth="2.6" />,
    "panel-left": (
      <>
        <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
        <path d="M9.5 4.5v15" />
      </>
    ),
    "panel-bottom": (
      <>
        <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
        <path d="M3.5 14.5h17" />
      </>
    ),
    "panel-right": (
      <>
        <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
        <path d="M14.5 4.5v15" />
      </>
    ),
    plug: <path d="M8 3v4m8-4v4M6 7h12v2a6 6 0 0 1-6 6v0a6 6 0 0 1-6-6V7Zm6 8v6" />,
    plus: <path d="M12 5v14M5 12h14" />,
    send: <path d="m21 3-7.4 18-3.7-7.9L2 9.4 21 3Zm-11.1 10.1L14 9" />,
    share: <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v13" />,
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.08A1.7 1.7 0 0 0 8.96 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3v-4h.08A1.7 1.7 0 0 0 4.6 8.96a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06a1.7 1.7 0 0 0 1.88.34A1.7 1.7 0 0 0 10 3.08V3h4v.08a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06a1.7 1.7 0 0 0-.34 1.88A1.7 1.7 0 0 0 20.92 10H21v4h-.08A1.7 1.7 0 0 0 19.4 15Z" />
      </>
    ),
    shield: <path d="M12 3 5 6v5c0 4.6 2.9 8 7 10 4.1-2 7-5.4 7-10V6l-7-3Zm-3 9 2 2 4-4" />,
    files: (
      <>
        <path d="M8 7V5a2 2 0 0 1 2-2h5l4 4v9a2 2 0 0 1-2 2h-2" />
        <path d="M14 3v4h4" />
        <rect x="5" y="9" width="10" height="12" rx="2" />
      </>
    ),
    message: <path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9l-4 3.5V6a1 1 0 0 1 1-1z" />,
    user: (
      <>
        <circle cx="12" cy="8" r="3.5" />
        <path d="M5.5 20a6.5 6.5 0 0 1 13 0" />
      </>
    ),
    "user-plus": (
      <>
        <circle cx="10" cy="8" r="3.5" />
        <path d="M3.5 20a6.5 6.5 0 0 1 13 0M19 8v6m3-3h-6" />
      </>
    ),
    users: (
      <>
        <circle cx="9" cy="8" r="3" />
        <path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 5.5a3 3 0 0 1 0 5.8M16.5 14a5 5 0 0 1 4 5" />
      </>
    ),
  };

  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

export const themeOptions: Array<{ value: ThemePreference; label: string }> = localized(() => [
  { value: "dark", label: t("深色") },
  { value: "system", label: t("自动") },
  { value: "light", label: t("浅色") },
]);

export function ThemeGlyph({ theme }: { theme: ThemePreference }) {
  if (theme === "dark") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M20.3 14.6A7.7 7.7 0 0 1 9.4 3.7 8.4 8.4 0 1 0 20.3 14.6Z" />
      </svg>
    );
  }
  if (theme === "system") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M20.5 12a8.5 8.5 0 1 1-2.1-5.6M18.7 3.8v3.4h-3.4M12 7.2V12l3 1.8" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="3.8" />
      <path d="M12 2.8v2.1M12 19.1v2.1M4.1 4.1l1.5 1.5M18.4 18.4l1.5 1.5M2.8 12h2.1M19.1 12h2.1M4.1 19.9l1.5-1.5M18.4 5.6l1.5-1.5" />
    </svg>
  );
}

export function ThemeSwitcher({
  value,
  onChange,
}: {
  value: ThemePreference;
  onChange: (value: ThemePreference) => void;
}) {
  const currentLabel = themeOptions.find((option) => option.value === value)?.label ?? t("自动");
  return (
    <div
      className={`theme-switcher ${value}`}
      role="radiogroup"
      aria-label={t("颜色主题")}
      title={t("当前：{0}", { 0: currentLabel })}
    >
      <span className="theme-switcher-indicator" aria-hidden="true" />
      {themeOptions.map((option) => (
        <Tooltip key={option.value} content={option.label}>
          <button
            type="button"
            role="radio"
            aria-checked={value === option.value}
            aria-label={option.label}
            className={value === option.value ? "active" : ""}
            onClick={() => onChange(option.value)}
          >
            <ThemeGlyph theme={option.value} />
          </button>
        </Tooltip>
      ))}
    </div>
  );
}

export function HiveLogo({ compact = false }: { compact?: boolean }) {
  return (
    <span className={`hive-logo ${compact ? "compact" : ""}`} aria-hidden="true">
      <svg viewBox="0 0 48 48" width="40" height="40" fill="none">
        <path d="m24 3 18 10.5v21L24 45 6 34.5v-21L24 3Z" />
        <path d="m24 12 10 6v12l-10 6-10-6V18l10-6Z" />
        <circle cx="24" cy="24" r="2.75" />
      </svg>
    </span>
  );
}
