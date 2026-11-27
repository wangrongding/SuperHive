import { useEffect } from "react";
import { OwnerDevicesPanel } from "./host-settings";
import { t } from "./i18n";
import { IconButton } from "./button";
import type { LocalAgentsState } from "./local-agents";

/**
 * 左下角用户菜单「在其他设备登录」：扫码登录、已登录的设备、房主接入令牌。
 * 设置里的「其他设备」是同一块内容，两个入口都留着，方便在设置里找。
 */
export function ownerDevicesIntro(local: LocalAgentsState): string {
  return local.mode === "device"
    ? t("这台设备是以房主身份登录的。下面是所有已登录的设备，可以随时退出。")
    : t(
        "手机或另一台电脑扫码（或打开链接）后，直接以房主身份进入，不用填令牌。每台设备单独登录，可以随时退出。飞书卡片上的「在网页查看」也会自动登录。",
      );
}

export function OwnerDevicesDialog({
  local,
  onClose,
}: {
  local: LocalAgentsState;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="room-dialog-layer">
      <button
        className="room-dialog-scrim"
        type="button"
        aria-label={t("关闭")}
        onClick={onClose}
      />
      <div
        className="invite-dialog owner-devices-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="owner-devices-title"
      >
        <header className="invite-dialog-header">
          <div>
            <h2 id="owner-devices-title">{t("在其他设备登录")}</h2>
            <p>{ownerDevicesIntro(local)}</p>
          </div>
          <IconButton className="dialog-close" label={t("关闭")} onClick={onClose}>
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path
                d="m6 6 12 12M18 6 6 18"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </IconButton>
        </header>
        <div className="invite-dialog-body">
          <OwnerDevicesPanel local={local} />
        </div>
      </div>
    </div>
  );
}
