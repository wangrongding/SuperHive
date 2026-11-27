/**
 * 右下角「更新」位置：和任务提醒共用右下角一列（在它下面），检查更新的轻提示和下载 / 安装进度卡片
 * 都摆在这里，同一时间只摆一样。桌面端的更新弹窗、进度卡片也在这里挂一份。
 */
import { useCallback } from "react";
import type { DesktopUpdatesApi } from "./desktop-bridge";
import { DesktopUpdateLayer } from "./desktop-update";
import { UpdateNoticeCard } from "./update-card";
import { setUpdateCornerSlot, useUpdateCenter } from "./update-center";

export function UpdateCorner({
  desktopApi,
  platform,
}: {
  /** 单测里注入；默认用桌面端 preload 暴露的 */
  desktopApi?: DesktopUpdatesApi;
  platform?: string;
}) {
  const { notice } = useUpdateCenter();
  const slot = useCallback((node: HTMLDivElement | null) => setUpdateCornerSlot(node), []);
  return (
    <div className="update-corner">
      {notice && <UpdateNoticeCard notice={notice} />}
      {/* 进度卡片 portal 进这里（网页版的在状态栏里算出来，桌面端的在下面的 DesktopUpdateLayer） */}
      <div className="update-corner-slot" ref={slot} />
      <DesktopUpdateLayer api={desktopApi} platform={platform} />
    </div>
  );
}
