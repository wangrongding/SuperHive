import { useState } from "react";
import type { Invocation } from "@ai-hive/protocol";
import { InvocationChips } from "./invocations";
import { t } from "./i18n";

const ACTIVE: Invocation["status"][] = ["queued", "running", "waiting_human"];
/**
 * 需要人处理的（被拦下、失败、结果未知）和停止中的，只在最近一段时间内挂在底部：
 * 很早以前就卡住的去消息里看，免得常年占着状态栏
 */
const NEEDS_ACTION: Invocation["status"][] = ["blocked", "failed", "timed_out", "cancelling"];
const NEEDS_ACTION_WINDOW_MS = 30 * 60_000;
const COLLAPSED_KEY = "ai-hive.invocation-dock.collapsed";

/** 当前房间里该常驻在输入框上方的调用：进行中的全部，加上最近需要人处理的 */
export function dockInvocations(
  invocations: Iterable<Invocation>,
  roomId: string,
  now: number,
): Invocation[] {
  return [...invocations]
    .filter(
      (invocation) =>
        invocation.roomId === roomId &&
        (ACTIVE.includes(invocation.status) ||
          (NEEDS_ACTION.includes(invocation.status) &&
            !invocation.resolution &&
            now - Date.parse(invocation.updatedAt) < NEEDS_ACTION_WINDOW_MS)),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * 输入框上方常驻的 Agent 状态栏：不必翻回触发消息就能看到谁在干活、谁在等你，
 * 操作（停止、重试、批准、继续）与消息下方的状态完全一致，另可一键定位原消息。
 */
export function InvocationDock({
  invocations,
  ...chipProps
}: {
  invocations: Invocation[];
} & Omit<Parameters<typeof InvocationChips>[0], "invocations">) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === "1");
  if (invocations.length === 0) return null;
  const running = invocations.filter((invocation) => invocation.status === "running").length;
  const waiting = invocations.filter((invocation) => invocation.status === "waiting_human").length;
  const summary = [
    running ? t("{0} 个执行中", { 0: running }) : undefined,
    waiting ? t("{0} 个等你回答", { 0: waiting }) : undefined,
    invocations.length - running - waiting
      ? t("{0} 个其他", { 0: invocations.length - running - waiting })
      : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const toggle = () => {
    setCollapsed((value) => {
      localStorage.setItem(COLLAPSED_KEY, value ? "0" : "1");
      return !value;
    });
  };
  return (
    <section
      className={`invocation-dock${collapsed ? " collapsed" : ""}`}
      aria-label={t("Agent 状态")}
    >
      <button
        type="button"
        className="invocation-dock-head"
        aria-expanded={!collapsed}
        onClick={toggle}
      >
        <span className="invocation-dock-title">{t("Agent 状态")}</span>
        <span className="invocation-dock-summary">{summary}</span>
        <span className="invocation-dock-toggle" aria-hidden="true">
          {collapsed ? t("展开") : t("收起")}
        </span>
      </button>
      {!collapsed && <InvocationChips invocations={invocations} {...chipProps} />}
    </section>
  );
}
