import { useEffect, useState } from "react";
import type { LoadingStatus } from "./loading-status";
import { t } from "./i18n";

export function RoomTimelineLoading({ error, retrying }: Partial<LoadingStatus>) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), 300);
    return () => window.clearTimeout(timer);
  }, []);
  if (error) {
    return (
      <div className="room-timeline-status" role="status">
        <p>{error}</p>
        {!retrying && <a href="">{t("重新加载")}</a>}
      </div>
    );
  }
  if (!visible) return null;
  return (
    <div className="room-timeline-skeleton" role="status" aria-label={t("正在读取房间消息")}>
      <div aria-hidden="true">
        {[0, 1, 2].map((index) => (
          <div className="room-skeleton-message" key={index}>
            <span className="room-skeleton-avatar" />
            <div className="room-skeleton-lines">
              <span />
              <span />
              <span />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
