import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { AgentCliJob } from "@superhive/protocol";
import { t } from "./i18n";
import type { AgentCliWithAgents, LocalAgentsState } from "./local-agents";
import { CommandSteps, JOB_POLL_MS, JobStatus, TOOL_NAMES, cliPlan, pending } from "./agent-clis";
import { Button } from "./button";
import { Icon } from "./app-icons";
import { Tooltip } from "./tooltip";
import "./styles/status-runtimes.css";

/**
 * 状态栏的「Agent 运行时」：这台电脑上装了的各 Agent CLI 有没有新版，点开在小弹层里直接升级。
 * 数据和设置里「Agent 运行时」同一个接口（服务端有检测缓存）；不另起定时轮询：
 * 页面加载、设置弹窗关上、弹层打开时各取一次，只有升级任务在跑时按设置页同样的节奏查进度。
 */

export type StatusAgentClisApi = Pick<
  LocalAgentsState,
  "agentClis" | "upgradeAgentCli" | "agentCliJob" | "act"
>;

const errorMessage = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);

/** 装了的里面有新版的（没装的不算） */
export function upgradableClis(tools: readonly AgentCliWithAgents[] | undefined) {
  return (tools ?? []).filter((tool) => tool.status !== "notInstalled" && tool.updateAvailable);
}

export type StatusAgentClis = {
  tools: AgentCliWithAgents[] | undefined;
  job: AgentCliJob | null;
  /** 刚点了确认、还在等服务端核对命令的那个 CLI */
  starting: string | undefined;
  error: string | undefined;
  reload: () => void;
  upgrade: (info: AgentCliWithAgents, command: string) => Promise<void>;
};

/** paused：设置弹窗开着时不取（设置页自己在取、在跑），关上后重新取一次接上 */
export function useStatusAgentClis(
  api: StatusAgentClisApi | undefined,
  paused: boolean,
): StatusAgentClis {
  const [tools, setTools] = useState<AgentCliWithAgents[]>();
  const [job, setJob] = useState<AgentCliJob | null>(null);
  const [starting, setStarting] = useState<string>();
  const [error, setError] = useState<string>();
  const agentClis = api?.agentClis;
  const agentCliJob = api?.agentCliJob;
  const upgradeAgentCli = api?.upgradeAgentCli;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(() => {
    if (!agentClis) return;
    agentClis(false).then(
      (result) => {
        if (!alive.current) return;
        setTools(result.tools);
        setError(undefined);
        // 打开页面时有任务在跑：接着显示进度；已经结束的旧结果不再翻出来
        const next = result.job;
        if (next && pending(next))
          setJob((current) => (current && pending(current) ? current : next));
      },
      (reason: unknown) => alive.current && setError(errorMessage(reason)),
    );
  }, [agentClis]);

  useEffect(() => {
    if (!paused) load();
  }, [paused, load]);

  // 任务进行中：查进度；结束后重新检测一次（服务端已作废检测缓存）
  const jobId = job && pending(job) ? job.id : undefined;
  useEffect(() => {
    if (!jobId || !agentCliJob || paused) return;
    let stopped = false;
    const timer = window.setInterval(() => {
      agentCliJob(jobId).then(
        (next) => {
          if (stopped) return;
          setJob(next);
          if (!pending(next)) load();
        },
        (reason: unknown) => !stopped && setError(errorMessage(reason)),
      );
    }, JOB_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [jobId, agentCliJob, load, paused]);

  const upgrade = useCallback(
    async (info: AgentCliWithAgents, command: string) => {
      if (!upgradeAgentCli) return;
      setStarting(info.tool);
      try {
        const next = await upgradeAgentCli(info.tool, command);
        if (alive.current) setJob(next);
      } finally {
        if (alive.current) setStarting(undefined);
      }
    },
    [upgradeAgentCli],
  );

  return { tools, job, starting, error, reload: load, upgrade };
}

/** 状态栏按钮上显示什么 */
export function statusAgentClisLabel(state: Pick<StatusAgentClis, "tools" | "job" | "starting">): {
  label: string;
  tooltip: string;
  tone: "update" | "busy" | undefined;
} {
  const installed = (state.tools ?? []).filter((tool) => tool.status !== "notInstalled");
  const running = state.job && pending(state.job) ? state.job : undefined;
  const busyTool = running?.tool ?? state.starting;
  if (busyTool) {
    const name =
      state.tools?.find((tool) => tool.tool === busyTool)?.name ??
      TOOL_NAMES[busyTool as keyof typeof TOOL_NAMES] ??
      busyTool;
    const label =
      running?.action === "install"
        ? t("正在安装 {0}…", { 0: name })
        : t("正在升级 {0}…", { 0: name });
    return { label, tooltip: t("Agent 运行时：{0}", { 0: label }), tone: "busy" };
  }
  const upgradable = upgradableClis(state.tools);
  if (upgradable.length) {
    return {
      label: t("{0} 个 CLI 可升级", { 0: upgradable.length }),
      tooltip: t("Agent 运行时：{0} 个 CLI 有新版", { 0: upgradable.length }),
      tone: "update",
    };
  }
  return {
    label: t("CLI {0}", { 0: installed.length }),
    tooltip: t("Agent 运行时：{0} 个 CLI 都是最新", { 0: installed.length }),
    tone: undefined,
  };
}

/** 弹层内容：已安装的各 CLI（名字 · 版本 → 最新版），有新版的一行一个「升级」 */
export function StatusAgentClisPopover({
  state,
  api,
  openSettings,
}: {
  state: StatusAgentClis;
  api: StatusAgentClisApi;
  openSettings: () => void;
}) {
  const { tools, job, starting, error, reload } = state;
  // 弹层打开时取一次（服务端有缓存，不会每次都重新检测）
  useEffect(() => {
    reload();
  }, [reload]);
  const [confirming, setConfirming] = useState<string>();
  const installed = (tools ?? []).filter((tool) => tool.status !== "notInstalled");
  const missing = (tools ?? []).filter((tool) => tool.status === "notInstalled");
  const busyTool = (job && pending(job) ? job.tool : undefined) ?? starting;
  const busyName = busyTool
    ? (tools?.find((tool) => tool.tool === busyTool)?.name ?? busyTool)
    : undefined;
  // 有新版的排前面
  const sorted = [...installed].sort(
    (a, b) => Number(b.updateAvailable) - Number(a.updateAvailable),
  );

  return (
    <>
      <section className="status-popover-section status-runtimes">
        {!tools && !error && <p className="status-popover-note">{t("正在检测…")}</p>}
        {tools && !installed.length && (
          <p className="status-popover-note">{t("这台电脑还没装 Agent CLI。")}</p>
        )}
        {sorted.length > 0 && (
          <ul className="status-runtimes-list">
            {sorted.map((info) => (
              <CliRow
                key={info.tool}
                info={info}
                api={api}
                job={job?.tool === info.tool ? job : undefined}
                starting={starting === info.tool}
                busyName={busyTool && busyTool !== info.tool ? busyName : undefined}
                confirming={confirming === info.tool}
                setConfirming={(open) => setConfirming(open ? info.tool : undefined)}
                upgrade={(command) => state.upgrade(info, command)}
              />
            ))}
          </ul>
        )}
        {missing.length > 0 && (
          <p className="status-popover-note status-runtimes-missing">
            {t("未安装：{0}", { 0: missing.map((tool) => tool.name).join(t("、")) })}
          </p>
        )}
        {error && (
          <p className="status-popover-note error" role="alert">
            {error}
          </p>
        )}
      </section>
      <button type="button" className="status-popover-link" onClick={openSettings}>
        {t("运行时设置")}
        <Icon name="arrow-right" size={12} />
      </button>
    </>
  );
}

function CliRow({
  info,
  api,
  job,
  starting,
  busyName,
  confirming,
  setConfirming,
  upgrade,
}: {
  info: AgentCliWithAgents;
  api: StatusAgentClisApi;
  job: AgentCliJob | undefined;
  starting: boolean;
  /** 别的 CLI 正在装或升级：这一行的按钮停用 */
  busyName: string | undefined;
  confirming: boolean;
  setConfirming: (open: boolean) => void;
  upgrade: (command: string) => Promise<void>;
}) {
  const { action, command, offered, reinstall } = cliPlan(info);
  // 弹层里只给装了的 CLI 升级、重新安装；没装的去设置里装
  const canUpgrade = action === "upgrade" && offered && Boolean(command);
  const mine = starting || Boolean(job && pending(job));
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const rowRef = useRef<HTMLLIElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirming) confirmRef.current?.focus({ preventScroll: true });
  }, [confirming]);

  const cancel = () => {
    setConfirming(false);
    window.requestAnimationFrame(() => buttonRef.current?.focus({ preventScroll: true }));
  };
  const confirm = async () => {
    if (!command) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await upgrade(command);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSubmitting(false);
      setConfirming(false);
      // 按钮换成了进度：焦点留在这一行，↑↓ 和 Esc 还能用
      window.requestAnimationFrame(() => rowRef.current?.focus({ preventScroll: true }));
    }
  };
  // Esc 先收起确认，不顺带关掉整个弹层
  const onConfirmKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    cancel();
  };

  const version =
    info.status === "broken" ? (
      <span className="status-runtimes-broken">{t("装了但跑不起来")}</span>
    ) : (
      <>
        <span className="mono">{info.version ?? t("版本未知")}</span>
        {info.updateAvailable && info.latest ? (
          <>
            <span className="status-runtimes-arrow" aria-label={t("可升级到")}>
              →
            </span>
            <span className="mono status-runtimes-latest">{info.latest}</span>
          </>
        ) : (
          <span className="status-runtimes-muted">
            {info.latest === null ? t("查不到最新版") : t("已是最新")}
          </span>
        )}
      </>
    );

  return (
    <li
      ref={rowRef}
      className="status-runtimes-row"
      aria-label={info.name}
      aria-busy={mine}
      tabIndex={-1}
    >
      <div className="status-runtimes-head">
        <span className="status-runtimes-name">{info.name}</span>
        <span className="status-runtimes-version">{version}</span>
        {!mine && canUpgrade && !confirming && (
          <Tooltip content={busyName ? t("正在升级 {0}，完成后再试", { 0: busyName }) : undefined}>
            <Button
              ref={buttonRef}
              size="sm"
              disabled={Boolean(busyName) || submitting}
              aria-label={
                reinstall ? t("重新安装 {0}", { 0: info.name }) : t("升级 {0}", { 0: info.name })
              }
              onClick={() => setConfirming(true)}
            >
              {reinstall ? t("重新安装") : t("升级")}
            </Button>
          </Tooltip>
        )}
      </div>
      {info.nodeGap && (
        <p className="status-popover-note warning">
          {t("新版需要 Node {0}，这台电脑用的是 Node {1}。", {
            0: info.nodeGap.required,
            1: info.nodeGap.current,
          })}
        </p>
      )}
      {info.updateAvailable && info.plan?.kind === "manual" && (
        <p className="status-popover-note">{info.plan.reason}</p>
      )}
      {confirming && command && (
        <div
          className="status-runtimes-confirm"
          role="group"
          aria-label={
            reinstall
              ? t("确认重新安装 {0}", { 0: info.name })
              : t("确认升级 {0}", { 0: info.name })
          }
          onKeyDown={onConfirmKey}
        >
          <CommandSteps action="upgrade" name={info.name} command={command} />
          <span>
            {reinstall
              ? t("正在用 {0} 的 Agent 不会自动重启，装好后再手动重启。", { 0: info.name })
              : t("正在用 {0} 的 Agent 不会自动重启，升级完再手动重启。", { 0: info.name })}
          </span>
          <div className="status-runtimes-actions">
            <Button size="sm" onClick={cancel} disabled={submitting}>
              {t("取消")}
            </Button>
            <Button
              ref={confirmRef}
              size="sm"
              variant="primary"
              disabled={submitting}
              onClick={() => void confirm()}
            >
              {reinstall ? t("重新安装") : t("升级")}
            </Button>
          </div>
        </div>
      )}
      {starting && !job && (
        <div className="agent-cli-job" role="status">
          <span>{t("正在核对命令…")}</span>
        </div>
      )}
      {job && <JobStatus api={api} info={info} job={job} />}
      {error && (
        <p className="status-popover-note error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}
