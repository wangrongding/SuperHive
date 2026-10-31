import { InvocationUsage } from "./usage";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Invocation, RuntimeEvent } from "@ai-hive/protocol";
import "./styles/invocation-details.css";
import { getLocale, localized, t } from "./i18n";

const toolLabels = localized(() => ({
  read: t("读取文件"),
  write: t("编辑文件"),
  search: t("搜索"),
  command: t("运行命令"),
  collaboration: t("协作工具"),
  other: t("其他工具"),
}));
export function runtimeEventLabel(event: RuntimeEvent): string {
  switch (event.kind) {
    case "capabilities":
      return event.observability === "heartbeat" ? t("仅心跳观测") : t("已接入结构化事件");
    case "provider_error":
      return t("API 异常{0}{1}", {
        0: event.code ? ` · HTTP ${event.code}` : "",
        1: event.retryAttempt ? t(" · 第 {0} 次重试", { 0: event.retryAttempt }) : "",
      });
    case "recovered":
      return t("收到模型恢复证据");
    case "activity": {
      const tool = event.tool ? ` · ${toolLabels[event.tool]}` : "";
      switch (event.phase) {
        case "starting":
          return t("正在启动 Runtime");
        case "working":
          return t("收到 Runtime 执行事件");
        case "tool_running":
          return t("工具执行中{0}", { 0: tool });
        case "tool_completed":
          return t("工具已返回{0}（不代表任务完成）", { 0: tool });
        default:
          return t("收到模型响应事件");
      }
    }
  }
}

function activeElement(): Element | null {
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  return element;
}

function Clock({ value, now }: { value?: string; now: number }) {
  if (!value || !Number.isFinite(Date.parse(value))) return <span>{t("尚未收到")}</span>;
  const age = Math.max(0, Math.floor((now - Date.parse(value)) / 1000));
  return (
    <span>
      <time dateTime={value} title={new Date(value).toLocaleString()}>
        {new Date(value).toLocaleTimeString(getLocale(), { hour12: false })}
      </time>
      <small>
        {age < 60 ? t("{0} 秒前", { 0: age }) : t("{0} 分钟前", { 0: Math.floor(age / 60) })}
      </small>
    </span>
  );
}

export function InvocationDetails({
  invocation,
  label,
  agentOnline,
  connectionState,
  delegation,
  onClose,
  onJump,
}: {
  invocation: Invocation;
  /** 委派关系：上游是谁派来的，下游派出了哪些子任务 */
  delegation?: { upstream?: string; downstream: string[]; continuation?: string } | undefined;
  label: string;
  agentOnline: boolean;
  connectionState?: "online" | "connecting" | "offline";
  onClose: () => void;
  onJump?: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const [now, setNow] = useState(Date.now);
  const runtime = invocation.runtime;
  const error = runtime?.lastError;
  const inProgress = ["queued", "running", "timed_out", "cancelling"].includes(invocation.status);
  const terminalAt = invocation.finishedAt ?? (!inProgress ? invocation.updatedAt : undefined);
  const elapsed = Math.max(
    0,
    Math.floor(
      ((terminalAt ? Date.parse(terminalAt) : now) -
        Date.parse(invocation.startedAt ?? invocation.createdAt)) /
        1000,
    ),
  );
  const liveLabel =
    connectionState === "online"
      ? t("随事件实时更新")
      : connectionState === "connecting"
        ? t("正在重连 · 显示最近快照")
        : t("连接未确认或已断开 · 显示最近快照");

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    const trigger = activeElement();
    const dialog = ref.current;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    if (dialog?.showModal) dialog.showModal();
    else dialog?.setAttribute("open", "");
    dialog?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      dialog?.close?.();
      document.body.style.overflow = overflow;
      if (trigger instanceof HTMLElement && trigger.isConnected)
        trigger.focus({ preventScroll: true });
    };
  }, []);

  return createPortal(
    <dialog
      ref={ref}
      className="invocation-details"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div className="invocation-details-content">
        <header className="invocation-details-header">
          <div>
            <p className="invocation-details-eyebrow">
              {t("@{0} · 第 {1} 次执行", { 0: invocation.agentName, 1: invocation.attempts })}
            </p>
            <h2 id={titleId}>{t("调用详情")}</h2>
          </div>
          <button
            type="button"
            className="invocation-details-close"
            aria-label={t("关闭调用详情")}
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <div
          className="invocation-details-state"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <strong>{label}</strong>
          <span>{liveLabel}</span>
        </div>
        <p id={descriptionId} className="invocation-details-description">
          {t("只展示已上报的执行事实。连接存活不代表模型正在执行，没有新事件也不等于卡死。")}
        </p>
        {invocation.detail && (
          <p className="invocation-details-description">
            {t("调用说明：{0}", { 0: invocation.detail })}
          </p>
        )}
        {error && (
          <section
            className={`invocation-details-notice ${error.recoveredAt ? "recovered" : "warning"}`}
            aria-label={t("最近 API 异常")}
          >
            <strong>
              {error.recoveredAt ? t("最近异常 · 已收到恢复证据") : t("最近异常 · 尚未确认恢复")}
              {error.code ? ` · HTTP ${error.code}` : ""}
            </strong>
            <p>
              {t("发生于")}{" "}
              <time dateTime={error.at}>
                {new Date(error.at).toLocaleTimeString(getLocale(), { hour12: false })}
              </time>
              {error.retryAttempt
                ? t("，记录到第 {0} 次重试", { 0: error.retryAttempt })
                : t("，未提供重试次数")}
              {t("。")}
            </p>
            {!error.recoveredAt && error.nextRetryAt && inProgress && (
              <p>
                {t("上报的预计重试时间： {0} ；不代表已执行或保证恢复。", {
                  0: new Date(error.nextRetryAt).toLocaleTimeString(getLocale(), { hour12: false }),
                })}
              </p>
            )}
            {!error.recoveredAt && !inProgress && <p>{t("本次调用已结束，不表示仍在重试。")}</p>}
          </section>
        )}
        {invocation.status === "running" &&
          now -
            Date.parse(runtime?.lastProgressAt ?? invocation.startedAt ?? invocation.createdAt) >=
            120_000 && (
            <p className="invocation-details-notice warning">
              {t("超过 2 分钟未收到新的执行进展，状态待核实；不会因此自动停止或重试。")}
            </p>
          )}
        {invocation.usage ? (
          <InvocationUsage usage={invocation.usage} />
        ) : (
          !inProgress && (
            <p className="invocation-details-description">
              {runtime?.usage
                ? t("没有收到这一轮的用量：可能在上报前就中断了。")
                : t("这一轮没有用量记录：这种 Runtime 尚未接入用量采集，或 Agent 还在用旧版本。")}
            </p>
          )
        )}
        {delegation && (
          <section aria-label={t("委派关系")}>
            <h3>{t("委派关系")}</h3>
            <dl className="invocation-details-delegation">
              {delegation.upstream && (
                <div>
                  <dt>{t("来源")}</dt>
                  <dd>{delegation.upstream}</dd>
                </div>
              )}
              {delegation.continuation && (
                <div>
                  <dt>{t("结果回执")}</dt>
                  <dd>{delegation.continuation}</dd>
                </div>
              )}
              {delegation.downstream.length > 0 && (
                <div>
                  <dt>{t("派出的子任务")}</dt>
                  <dd>
                    <ul>
                      {delegation.downstream.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  </dd>
                </div>
              )}
            </dl>
          </section>
        )}
        <section aria-label={t("执行观测")}>
          <h3>
            {t("执行观测")}{" "}
            <span className="invocation-details-capability">
              {runtime?.observability === "full"
                ? t("完整事件能力")
                : runtime?.observability === "partial"
                  ? t("部分事件可见")
                  : t("仅心跳 / 未接入事件")}
            </span>
          </h3>
          <dl className="invocation-details-metrics" aria-live="off">
            <div>
              <dt>{t("Bridge 最近回报")}</dt>
              <dd>
                <Clock value={runtime?.lastHeartbeatAt} now={now} />
              </dd>
            </div>
            <div>
              <dt>{t("最近执行进展")}</dt>
              <dd>
                <Clock value={runtime?.lastProgressAt} now={now} />
              </dd>
            </div>
            <div>
              <dt>{t("最近 Runtime 事件")}</dt>
              <dd>
                <Clock value={runtime?.lastRuntimeEventAt} now={now} />
              </dd>
            </div>
            <div>
              <dt>{inProgress ? t("已等待") : t("本次耗时")}</dt>
              <dd>
                {Number.isFinite(elapsed)
                  ? t("{0} 分 {1} 秒", { 0: Math.floor(elapsed / 60), 1: elapsed % 60 })
                  : t("未知")}
              </dd>
            </div>
          </dl>
          {runtime?.phase && (
            <p className="invocation-details-phase">
              {t("{0}： {1}", {
                0: inProgress ? t("最近阶段") : t("结束前阶段"),
                1: runtimeEventLabel({
                  kind: "activity",
                  phase: runtime.phase,
                  ...(runtime.tool ? { tool: runtime.tool } : {}),
                }),
              })}
            </p>
          )}
          {!agentOnline && (
            <p className="invocation-details-description">
              {t("Agent 当前离线；保留的是最后收到的信息。")}
            </p>
          )}
          {runtime?.observability !== "full" && (
            <p className="invocation-details-description">
              {runtime?.observability === "partial"
                ? t("部分工具和响应事件可见；CLI 未暴露的内部重试或等待无法展示。")
                : t("当前适配器尚未上报结构化执行事件，无法判断它在执行、等待还是重试。")}
            </p>
          )}
        </section>
        <section aria-label={t("最近事件")}>
          <h3>
            {t("最近事件")}{" "}
            <span className="invocation-details-caption">{t("最多 12 条 · 不含心跳")}</span>
          </h3>
          {runtime?.history.length ? (
            <ol className="invocation-details-timeline" aria-live="off">
              {runtime.history.map((event, index) => (
                <li key={`${event.at}-${index}`} data-kind={event.kind}>
                  <time dateTime={event.at}>
                    {new Date(event.at).toLocaleTimeString(getLocale(), { hour12: false })}
                  </time>
                  <span>{runtimeEventLabel(event)}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="invocation-details-empty">
              {t("尚未收到执行事件。这里不会用心跳伪造进度。")}
            </p>
          )}
        </section>
        <details className="invocation-details-metadata">
          <summary>{t("调用标识与数据边界")}</summary>
          <dl>
            <dt>{t("调用 ID")}</dt>
            <dd>{invocation.id}</dd>
            <dt>{t("最后更新")}</dt>
            <dd>{new Date(invocation.updatedAt).toLocaleString()}</dd>
          </dl>
          <p>
            {t(
              "内容对房间成员可见；不展示模型内部思考、原始日志、工具参数、文件正文或凭据。事件为有界摘要，不是完整审计日志。",
            )}
          </p>
        </details>
        {onJump && (
          <footer>
            <button type="button" className="invocation-details-reply" onClick={onJump}>
              {t("查看回复")}
            </button>
          </footer>
        )}
      </div>
    </dialog>,
    document.body,
  );
}
