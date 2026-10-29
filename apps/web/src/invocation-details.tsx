import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Invocation, RuntimeEvent } from "@ai-hive/protocol";
import "./styles/invocation-details.css";

const toolLabels = {
  read: "读取文件",
  write: "编辑文件",
  search: "搜索",
  command: "运行命令",
  collaboration: "协作工具",
  other: "其他工具",
};
export function runtimeEventLabel(event: RuntimeEvent): string {
  switch (event.kind) {
    case "capabilities":
      return event.observability === "heartbeat" ? "仅心跳观测" : "已接入结构化事件";
    case "provider_error":
      return `API 异常${event.code ? ` · HTTP ${event.code}` : ""}${event.retryAttempt ? ` · 第 ${event.retryAttempt} 次重试` : ""}`;
    case "recovered":
      return "收到模型恢复证据";
    case "activity": {
      const tool = event.tool ? ` · ${toolLabels[event.tool]}` : "";
      switch (event.phase) {
        case "starting":
          return "正在启动 Runtime";
        case "working":
          return "收到 Runtime 执行事件";
        case "tool_running":
          return `工具执行中${tool}`;
        case "tool_completed":
          return `工具已返回${tool}（不代表任务完成）`;
        default:
          return "收到模型响应事件";
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
  if (!value || !Number.isFinite(Date.parse(value))) return <span>尚未收到</span>;
  const age = Math.max(0, Math.floor((now - Date.parse(value)) / 1000));
  return (
    <span>
      <time dateTime={value} title={new Date(value).toLocaleString()}>
        {new Date(value).toLocaleTimeString([], { hour12: false })}
      </time>
      <small>{age < 60 ? `${age} 秒前` : `${Math.floor(age / 60)} 分钟前`}</small>
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
      ? "随事件实时更新"
      : connectionState === "connecting"
        ? "正在重连 · 显示最近快照"
        : "连接未确认或已断开 · 显示最近快照";

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
              @{invocation.agentName} · 第 {invocation.attempts} 次执行
            </p>
            <h2 id={titleId}>调用详情</h2>
          </div>
          <button
            type="button"
            className="invocation-details-close"
            aria-label="关闭调用详情"
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
          只展示已上报的执行事实。连接存活不代表模型正在执行，没有新事件也不等于卡死。
        </p>
        {invocation.detail && (
          <p className="invocation-details-description">调用说明：{invocation.detail}</p>
        )}
        {error && (
          <section
            className={`invocation-details-notice ${error.recoveredAt ? "recovered" : "warning"}`}
            aria-label="最近 API 异常"
          >
            <strong>
              {error.recoveredAt ? "最近异常 · 已收到恢复证据" : "最近异常 · 尚未确认恢复"}
              {error.code ? ` · HTTP ${error.code}` : ""}
            </strong>
            <p>
              发生于{" "}
              <time dateTime={error.at}>
                {new Date(error.at).toLocaleTimeString([], { hour12: false })}
              </time>
              {error.retryAttempt ? `，记录到第 ${error.retryAttempt} 次重试` : "，未提供重试次数"}
              。
            </p>
            {!error.recoveredAt && error.nextRetryAt && inProgress && (
              <p>
                上报的预计重试时间：
                {new Date(error.nextRetryAt).toLocaleTimeString([], { hour12: false })}
                ；不代表已执行或保证恢复。
              </p>
            )}
            {!error.recoveredAt && !inProgress && <p>本次调用已结束，不表示仍在重试。</p>}
          </section>
        )}
        {invocation.status === "running" &&
          now -
            Date.parse(runtime?.lastProgressAt ?? invocation.startedAt ?? invocation.createdAt) >=
            120_000 && (
            <p className="invocation-details-notice warning">
              超过 2 分钟未收到新的执行进展，状态待核实；不会因此自动停止或重试。
            </p>
          )}
        {delegation && (
          <section aria-label="委派关系">
            <h3>委派关系</h3>
            <dl className="invocation-details-delegation">
              {delegation.upstream && (
                <div>
                  <dt>来源</dt>
                  <dd>{delegation.upstream}</dd>
                </div>
              )}
              {delegation.continuation && (
                <div>
                  <dt>结果回执</dt>
                  <dd>{delegation.continuation}</dd>
                </div>
              )}
              {delegation.downstream.length > 0 && (
                <div>
                  <dt>派出的子任务</dt>
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
        <section aria-label="执行观测">
          <h3>
            执行观测{" "}
            <span className="invocation-details-capability">
              {runtime?.observability === "full"
                ? "完整事件能力"
                : runtime?.observability === "partial"
                  ? "部分事件可见"
                  : "仅心跳 / 未接入事件"}
            </span>
          </h3>
          <dl className="invocation-details-metrics" aria-live="off">
            <div>
              <dt>Bridge 最近回报</dt>
              <dd>
                <Clock value={runtime?.lastHeartbeatAt} now={now} />
              </dd>
            </div>
            <div>
              <dt>最近执行进展</dt>
              <dd>
                <Clock value={runtime?.lastProgressAt} now={now} />
              </dd>
            </div>
            <div>
              <dt>最近 Runtime 事件</dt>
              <dd>
                <Clock value={runtime?.lastRuntimeEventAt} now={now} />
              </dd>
            </div>
            <div>
              <dt>{inProgress ? "已等待" : "本次耗时"}</dt>
              <dd>
                {Number.isFinite(elapsed)
                  ? `${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒`
                  : "未知"}
              </dd>
            </div>
          </dl>
          {runtime?.phase && (
            <p className="invocation-details-phase">
              {inProgress ? "最近阶段" : "结束前阶段"}：
              {runtimeEventLabel({
                kind: "activity",
                phase: runtime.phase,
                ...(runtime.tool ? { tool: runtime.tool } : {}),
              })}
            </p>
          )}
          {!agentOnline && (
            <p className="invocation-details-description">
              Agent 当前离线；保留的是最后收到的信息。
            </p>
          )}
          {runtime?.observability !== "full" && (
            <p className="invocation-details-description">
              {runtime?.observability === "partial"
                ? "部分工具和响应事件可见；CLI 未暴露的内部重试或等待无法展示。"
                : "当前适配器尚未上报结构化执行事件，无法判断它在执行、等待还是重试。"}
            </p>
          )}
        </section>
        <section aria-label="最近事件">
          <h3>
            最近事件 <span className="invocation-details-caption">最多 12 条 · 不含心跳</span>
          </h3>
          {runtime?.history.length ? (
            <ol className="invocation-details-timeline" aria-live="off">
              {runtime.history.map((event, index) => (
                <li key={`${event.at}-${index}`} data-kind={event.kind}>
                  <time dateTime={event.at}>
                    {new Date(event.at).toLocaleTimeString([], { hour12: false })}
                  </time>
                  <span>{runtimeEventLabel(event)}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="invocation-details-empty">尚未收到执行事件。这里不会用心跳伪造进度。</p>
          )}
        </section>
        <details className="invocation-details-metadata">
          <summary>调用标识与数据边界</summary>
          <dl>
            <dt>调用 ID</dt>
            <dd>{invocation.id}</dd>
            <dt>最后更新</dt>
            <dd>{new Date(invocation.updatedAt).toLocaleString()}</dd>
          </dl>
          <p>
            内容对房间成员可见；不展示模型内部思考、原始日志、工具参数、文件正文或凭据。事件为有界摘要，不是完整审计日志。
          </p>
        </details>
        {onJump && (
          <footer>
            <button type="button" className="invocation-details-reply" onClick={onJump}>
              查看回复
            </button>
          </footer>
        )}
      </div>
    </dialog>,
    document.body,
  );
}
