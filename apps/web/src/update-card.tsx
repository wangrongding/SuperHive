/**
 * 右下角「更新」位置里的卡片外框：检查更新的轻提示、下载 / 安装进度卡片都用它，样式一致。
 * 外层位置（和任务提醒共用右下角一列）见 UpdateCorner。
 */
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./app-icons";
import { IconButton } from "./button";
import { t } from "./i18n";
import { dismissUpdateNotice, useUpdateCenter, type UpdateNotice } from "./update-center";
import "./styles/update-corner.css";

/** 进度卡片：标题行右边是「—」收起（进行中）或「×」关闭（已经结束） */
export function UpdateCard({
  title,
  tone,
  onCollapse,
  onClose,
  children,
}: {
  title: string;
  tone?: "danger" | "ok" | "warn";
  onCollapse?: () => void;
  onClose?: () => void;
  children?: ReactNode;
}) {
  return (
    <section className={`update-card${tone ? ` ${tone}` : ""}`} aria-label={title}>
      <div className="update-card-head">
        <strong className="update-card-title">{title}</strong>
        {onCollapse && (
          <IconButton size="sm" label={t("收起到状态栏")} onClick={onCollapse}>
            <Icon name="minus" size={14} />
          </IconButton>
        )}
        {onClose && (
          <IconButton size="sm" label={t("关闭")} onClick={onClose}>
            <Icon name="close" size={14} />
          </IconButton>
        )}
      </div>
      {children}
    </section>
  );
}

/** 进度条：知道百分比时按比例，不知道时来回滑动 */
export function UpdateProgress({ label, value }: { label: string; value?: number | undefined }) {
  return (
    <div
      className="desktop-update-progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      {...(value !== undefined ? { "aria-valuenow": value } : {})}
    >
      <span
        className={value === undefined ? "indeterminate" : undefined}
        style={value !== undefined ? { width: `${value}%` } : undefined}
      />
    </div>
  );
}

const noticeIcons = { ok: "check", info: "info", danger: "alert" } as const;

/** 检查更新的轻提示：一行字，检查中转圈，有结果几秒后自己消失，也可以点 × 关 */
export function UpdateNoticeCard({ notice }: { notice: UpdateNotice }) {
  return (
    <div className={`update-card update-notice ${notice.tone}`} role="status">
      <span className="update-notice-icon" aria-hidden="true">
        {notice.tone === "pending" ? (
          <span className="update-notice-spinner" />
        ) : (
          <Icon name={noticeIcons[notice.tone]} size={14} />
        )}
      </span>
      <span className="update-notice-text">{notice.text}</span>
      <IconButton size="sm" label={t("关闭提示")} onClick={() => dismissUpdateNotice(notice.id)}>
        <Icon name="close" size={14} />
      </IconButton>
    </div>
  );
}

/** 把卡片放进右下角那个位置；位置还没挂上（单测里单独渲染时）就自己摆在右下角 */
export function UpdateCornerPortal({ children }: { children: ReactNode }) {
  const { slot } = useUpdateCenter();
  if (slot) return createPortal(children, slot);
  return createPortal(<div className="update-corner detached">{children}</div>, document.body);
}
