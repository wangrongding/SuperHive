import { useEffect, useRef } from "react";
import { HiveLogo } from "./app-icons";
import { t, useLocale } from "./i18n";
import { mountLoadingStatus, type LoadingStatus } from "./loading-status";

export function RoomLoading({ phase, error, retrying }: LoadingStatus) {
  const locale = useLocale();
  const rootRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<ReturnType<typeof mountLoadingStatus> | undefined>(undefined);
  const behindSplash =
    Boolean(document.getElementById("boot-splash")) &&
    !document.documentElement.hasAttribute("data-desktop");
  useEffect(() => {
    controllerRef.current = mountLoadingStatus(rootRef.current!, { phase: "connecting" });
    return () => controllerRef.current?.destroy();
  }, []);
  useEffect(() => {
    controllerRef.current?.update({ phase, error, retrying });
  }, [phase, error, retrying, locale]);
  return (
    <div
      className="room-loading loading-status"
      ref={rootRef}
      inert={behindSplash || undefined}
      aria-hidden={behindSplash || undefined}
    >
      <div aria-hidden="true">
        <HiveLogo compact />
      </div>
      <div className="loading-copy" role="status" aria-live="polite" aria-atomic="true">
        <p className="loading-title" data-loading-title />
        <p className="loading-hint" data-loading-hint />
      </div>
      <p className="loading-help" data-loading-help hidden>
        <a href="">{t("重新加载")}</a>
      </p>
    </div>
  );
}
