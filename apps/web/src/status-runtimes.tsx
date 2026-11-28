import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { AgentCliJob } from "@superhive/protocol";
import { t } from "./i18n";
import type { AgentCliWithAgents, LocalAgentsState } from "./local-agents";
import {
  CommandSteps,
  JobStatus,
  TOOL_NAMES,
  adoptJobs,
  cliPlan,
  jobsOf,
  pending,
  useJobPolling,
} from "./agent-clis";
import { copyTextToClipboard } from "./clipboard";
import { Button } from "./button";
import { Icon } from "./app-icons";
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

/** 有新版、能一键升级的：「全部升级」跑这些 */
export function batchClis(tools: readonly AgentCliWithAgents[] | undefined) {
  return upgradableClis(tools).filter((tool) => {
    const plan = cliPlan(tool);
    return plan.action === "upgrade" && plan.offered && Boolean(plan.command);
  });
}

/** 有新版、但只能手动升级的（认不出来源、Windows、新版要更新的 Node 等） */
export function manualClis(tools: readonly AgentCliWithAgents[] | undefined) {
  const batch = new Set(batchClis(tools).map((tool) => tool.tool));
  return upgradableClis(tools).filter((tool) => !batch.has(tool.tool));
}

export type StatusAgentClis = {
  tools: AgentCliWithAgents[] | undefined;
  /** 每个 CLI 最近一个任务（本页发起的，或打开页面时服务端还没结束的） */
  jobs: Readonly<Record<string, AgentCliJob>>;
  /** 刚点了确认、还在等服务端核对命令的 CLI */
  starting: readonly string[];
  /** 批量升级时没能开始的（命令变了、已是最新等），按 CLI 记原因 */
  startErrors: Readonly<Record<string, string>>;
  error: string | undefined;
  /** 成功取到检测结果的次数：提醒卡片等「延迟后这一次」的结果 */
  loads: number;
  reload: () => void;
  upgrade: (info: AgentCliWithAgents, command: string) => Promise<void>;
  /** 同时开始几个升级（服务端最多同时跑 3 个，多的排队）；没能开始的记进 startErrors，不抛 */
  upgradeMany: (infos: readonly AgentCliWithAgents[]) => Promise<void>;
};

/** 正在装或升级的 CLI（含还在核对命令的） */
export function busyClis(state: Pick<StatusAgentClis, "jobs" | "starting">): string[] {
  const busy = new Set(state.starting);
  for (const job of Object.values(state.jobs)) if (pending(job)) busy.add(job.tool);
  return [...busy];
}

/** paused：设置弹窗开着时不取（设置页自己在取、在跑），关上后重新取一次接上 */
export function useStatusAgentClis(
  api: StatusAgentClisApi | undefined,
  paused: boolean,
): StatusAgentClis {
  const [tools, setTools] = useState<AgentCliWithAgents[]>();
  const [jobs, setJobs] = useState<Record<string, AgentCliJob>>({});
  const [starting, setStarting] = useState<string[]>([]);
  const [startErrors, setStartErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [loads, setLoads] = useState(0);
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
        setLoads((count) => count + 1);
        // 打开页面时有任务在跑：接着显示进度；已经结束的旧结果不再翻出来
        setJobs((current) => adoptJobs(current, jobsOf(result)));
      },
      (reason: unknown) => alive.current && setError(errorMessage(reason)),
    );
  }, [agentClis]);

  useEffect(() => {
    if (!paused) load();
  }, [paused, load]);

  // 任务进行中：查进度；有任务结束就重新检测一次（服务端已作废检测缓存）
  const onPollError = useCallback(
    (reason: unknown) => alive.current && setError(errorMessage(reason)),
    [],
  );
  useJobPolling(jobs, setJobs, agentCliJob, load, onPollError, paused);

  const upgrade = useCallback(
    async (info: AgentCliWithAgents, command: string) => {
      if (!upgradeAgentCli) return;
      setStarting((current) => [...current, info.tool]);
      setStartErrors((current) => {
        const next = { ...current };
        delete next[info.tool];
        return next;
      });
      try {
        const next = await upgradeAgentCli(info.tool, command);
        if (alive.current) setJobs((current) => ({ ...current, [next.tool]: next }));
      } finally {
        if (alive.current) setStarting((current) => current.filter((tool) => tool !== info.tool));
      }
    },
    [upgradeAgentCli],
  );

  const upgradeMany = useCallback(
    async (infos: readonly AgentCliWithAgents[]) => {
      await Promise.all(
        infos.map(async (info) => {
          const { command } = cliPlan(info);
          if (!command) return;
          try {
            await upgrade(info, command);
          } catch (reason) {
            if (alive.current) {
              setStartErrors((current) => ({ ...current, [info.tool]: errorMessage(reason) }));
            }
          }
        }),
      );
    },
    [upgrade],
  );

  return { tools, jobs, starting, startErrors, error, loads, reload: load, upgrade, upgradeMany };
}

/** 状态栏按钮上显示什么 */
export function statusAgentClisLabel(state: Pick<StatusAgentClis, "tools" | "jobs" | "starting">): {
  label: string;
  tooltip: string;
  tone: "update" | "busy" | undefined;
} {
  const installed = (state.tools ?? []).filter((tool) => tool.status !== "notInstalled");
  const busy = busyClis(state);
  if (busy.length) {
    const job = state.jobs[busy[0]!];
    const name =
      state.tools?.find((tool) => tool.tool === busy[0])?.name ??
      TOOL_NAMES[busy[0] as keyof typeof TOOL_NAMES] ??
      busy[0];
    const label =
      busy.length > 1
        ? t("正在升级 {0} 个 CLI…", { 0: busy.length })
        : job && pending(job) && job.action === "install"
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
  const { tools, jobs, starting, startErrors, error, reload } = state;
  // 弹层打开时取一次（服务端有缓存，不会每次都重新检测）
  useEffect(() => {
    reload();
  }, [reload]);
  const [confirming, setConfirming] = useState<string>();
  const [batchOpen, setBatchOpen] = useState(false);
  const installed = (tools ?? []).filter((tool) => tool.status !== "notInstalled");
  const missing = (tools ?? []).filter((tool) => tool.status === "notInstalled");
  const busy = busyClis(state);
  // 还没在跑的、能一键升级的：两个以上才给「全部升级」
  const startable = batchClis(tools).filter((tool) => !busy.includes(tool.tool));
  // 有新版的排前面
  const sorted = [...installed].sort(
    (a, b) => Number(b.updateAvailable) - Number(a.updateAvailable),
  );

  return (
    <>
      <section className="status-popover-section status-runtimes">
        {!tools && !error && <p className="status-popover-note">{t("正在检测…")}</p>}
        {startable.length > 1 && !batchOpen && (
          <div className="status-runtimes-batch">
            <span>{t("{0} 个可以一键升级", { 0: startable.length })}</span>
            <Button
              size="sm"
              onClick={() => {
                setConfirming(undefined);
                setBatchOpen(true);
              }}
            >
              {t("全部升级")}
            </Button>
          </div>
        )}
        {batchOpen && (
          <BatchConfirm
            items={startable}
            onCancel={() => setBatchOpen(false)}
            onConfirm={() => {
              setBatchOpen(false);
              void state.upgradeMany(startable);
            }}
          />
        )}
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
                job={jobs[info.tool]}
                starting={starting.includes(info.tool)}
                startError={startErrors[info.tool]}
                confirming={confirming === info.tool}
                setConfirming={(open) => {
                  setBatchOpen(false);
                  setConfirming(open ? info.tool : undefined);
                }}
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
  startError,
  confirming,
  setConfirming,
  upgrade,
}: {
  info: AgentCliWithAgents;
  api: StatusAgentClisApi;
  job: AgentCliJob | undefined;
  starting: boolean;
  /** 「全部升级」时这一项没能开始的原因 */
  startError: string | undefined;
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
        {!mine && canUpgrade && !confirming && job?.state !== "failed" && (
          <Button
            ref={buttonRef}
            size="sm"
            disabled={submitting}
            aria-label={
              reinstall ? t("重新安装 {0}", { 0: info.name }) : t("升级 {0}", { 0: info.name })
            }
            onClick={() => setConfirming(true)}
          >
            {reinstall ? t("重新安装") : t("升级")}
          </Button>
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
        <>
          <p className="status-popover-note">{info.plan.reason}</p>
          {info.plan.command && <CopyCommand command={info.plan.command} />}
        </>
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
      {starting && !(job && pending(job)) && (
        <div className="agent-cli-job" role="status">
          <span>{t("正在核对命令…")}</span>
        </div>
      )}
      {job && !(starting && !pending(job)) && (
        <JobStatus
          api={api}
          info={info}
          job={job}
          // 失败了单独再试：同一条已经确认过的命令（服务端会重新核对，变了就不执行）
          {...(canUpgrade && command && !starting ? { onRetry: () => upgrade(command) } : {})}
        />
      )}
      {(error ?? startError) && (
        <p className="status-popover-note error" role="alert">
          {error ?? startError}
        </p>
      )}
    </li>
  );
}

/**
 * 「全部升级」的确认：一行一个 CLI 和要跑的命令，太多时框里滚动；Esc 只收起确认。
 * 状态栏弹层和右下角提醒卡片共用。
 */
export function BatchConfirm({
  items,
  onCancel,
  onConfirm,
}: {
  items: readonly AgentCliWithAgents[];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    confirmRef.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div
      className="cli-batch-confirm"
      role="group"
      aria-label={t("确认升级 {0} 个 CLI", { 0: items.length })}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }}
    >
      <span>{t("将在这台电脑上运行：")}</span>
      <ul className="cli-batch-commands">
        {items.map((info) => (
          <li key={info.tool}>
            <span>{info.name}</span>
            <code className="agent-cli-command" title={cliPlan(info).command}>
              {cliPlan(info).command}
            </code>
          </li>
        ))}
      </ul>
      <span className="cli-batch-hint">
        {t("最多同时跑 3 个；正在用这些 CLI 的 Agent 不会自动重启，升完再重启。")}
      </span>
      <div className="status-runtimes-actions">
        <Button size="sm" onClick={onCancel}>
          {t("取消")}
        </Button>
        <Button ref={confirmRef} size="sm" variant="primary" onClick={onConfirm}>
          {t("升级 {0} 个", { 0: items.length })}
        </Button>
      </div>
    </div>
  );
}

/** 只能手动升级时建议的命令：等宽显示，旁边「复制」，复制后短暂显示「已复制」 */
export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_200);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <div className="cli-copy-command">
      <code className="agent-cli-command">{command}</code>
      <Button
        size="sm"
        variant="ghost"
        aria-label={t("复制命令")}
        onClick={() =>
          void copyTextToClipboard(command).then(
            () => {
              setFailed(false);
              setCopied(true);
            },
            () => setFailed(true),
          )
        }
      >
        {copied ? t("已复制") : failed ? t("复制失败") : t("复制")}
      </Button>
    </div>
  );
}
