import { useEffect, useState } from "react";
import type { WhiteboardEntry, WhiteboardSlot } from "@ai-hive/protocol";
import { getLocale, localized, t } from "./i18n";

/** 阻塞最需要人关注，排在最前；里程碑是历史记录，放最后 */
export const whiteboardSlots: Array<{ slot: WhiteboardSlot; label: string }> = localized(() => [
  { slot: "blocked", label: t("阻塞") },
  { slot: "in_progress", label: t("进行中") },
  { slot: "ready", label: t("已就绪") },
  { slot: "milestone", label: t("里程碑") },
]);

export function upsertWhiteboardEntry(
  current: ReadonlyMap<string, WhiteboardEntry>,
  entry: WhiteboardEntry,
): Map<string, WhiteboardEntry> {
  const existing = current.get(entry.id);
  if (existing && existing.updatedAt > entry.updatedAt)
    return current as Map<string, WhiteboardEntry>;
  const next = new Map(current);
  next.set(entry.id, entry);
  return next;
}

export function formatRelativeTime(iso: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (seconds < 45) return t("刚刚");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t("{0} 分钟前", { 0: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("{0} 小时前", { 0: hours });
  const days = Math.round(hours / 24);
  if (days < 30) return t("{0} 天前", { 0: days });
  return new Date(iso).toLocaleDateString(getLocale(), { month: "short", day: "numeric" });
}

function shortCommit(commit: string): string {
  return /^[0-9a-f]{12,}$/i.test(commit) ? commit.slice(0, 7) : commit;
}

export function WhiteboardPanel({
  entries,
  onRemove,
}: {
  entries: ReadonlyMap<string, WhiteboardEntry>;
  onRemove: (entry: WhiteboardEntry) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  if (entries.size === 0) {
    return (
      <div className="whiteboard-empty">
        <strong>{t("白板还是空的")}</strong>
        <p>
          {t("Agent 会通过")} <code>hive_board_update</code>{" "}
          {t("在这里登记进行中的工作、可交接的成果、阻塞与里程碑，方便所有人对齐进度。")}
        </p>
      </div>
    );
  }

  const sorted = [...entries.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return (
    <div className="whiteboard">
      {whiteboardSlots.map(({ slot, label }) => {
        const slotEntries = sorted.filter((entry) => entry.slot === slot);
        if (slotEntries.length === 0) return null;
        const headingId = `whiteboard-slot-${slot}`;
        return (
          <section key={slot} className={`whiteboard-slot ${slot}`} aria-labelledby={headingId}>
            <h3 id={headingId}>
              <span className="whiteboard-slot-dot" aria-hidden="true" />
              {label}
              <span className="whiteboard-slot-count">{slotEntries.length}</span>
            </h3>
            <ul>
              {slotEntries.map((entry) => (
                <li key={entry.id} className="whiteboard-entry">
                  <p className="whiteboard-summary">{entry.summary}</p>
                  {(entry.repo || entry.branch || entry.commit) && (
                    <p className="whiteboard-ref">
                      {entry.repo && <span title={entry.repo}>{entry.repo}</span>}
                      {entry.branch && (
                        <span title={t("分支 {0}", { 0: entry.branch })}>{entry.branch}</span>
                      )}
                      {entry.commit && (
                        <span title={t("提交 {0}", { 0: entry.commit })}>
                          {shortCommit(entry.commit)}
                        </span>
                      )}
                    </p>
                  )}
                  {entry.unblocks.length > 0 && (
                    <p className="whiteboard-unblocks">
                      {t("解除阻塞：{0}", { 0: entry.unblocks.join(t("、")) })}
                    </p>
                  )}
                  <p className="whiteboard-meta">
                    <span>{entry.authorName}</span>
                    <time
                      dateTime={entry.updatedAt}
                      title={new Date(entry.updatedAt).toLocaleString()}
                    >
                      {formatRelativeTime(entry.updatedAt, now)}
                    </time>
                  </p>
                  <button
                    type="button"
                    className="whiteboard-remove"
                    aria-label={t("从白板移除：{0}", { 0: entry.summary })}
                    title={t("从白板移除")}
                    onClick={() => onRemove(entry)}
                  >
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      aria-hidden="true"
                    >
                      <path d="m6 6 12 12M18 6 6 18" />
                    </svg>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
