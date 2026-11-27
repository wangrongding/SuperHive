import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentCliAction,
  AgentCliInstallation,
  AgentCliJob,
  AgentCliSource,
  AgentCliTool,
} from "@superhive/protocol";
import { ConfirmPopover } from "./confirm-popover";
import { t } from "./i18n";
import type { AgentCliWithAgents, LocalAgentsState } from "./local-agents";
import {
  RuntimeConfigPanel,
  type RuntimeConfigApi,
  type RuntimeConfigSection,
} from "./runtime-config-panel";
import { hasRuntimeConfig } from "./runtime-credentials";
import "./styles/agent-clis.css";
import { Tooltip } from "./tooltip";
import { Button } from "./button";

/**
 * 这台电脑装了哪些 Agent CLI（只在 Server 所在电脑上的本机房主页面显示）：版本、安装位置与来源、
 * 有没有新版；没装的可以一键全局安装，装了的可以一键升级。执行前把要在这台电脑上跑的命令原样给人确认，
 * 全局一次只跑一个：点了确认这一行立刻进入进行中，其它按钮停用并说明原因；进度只显示最近一行，
 * 失败显示输出末几行，结束后自动重新检测。刷新页面时先取当前任务，接着显示进度。
 */

export type AgentClisApi = Pick<
  LocalAgentsState,
  | "agentClis"
  | "agentCliCurrent"
  | "upgradeAgentCli"
  | "installAgentCli"
  | "agentCliJob"
  | "act"
  | "runtimeCredentials"
> &
  RuntimeConfigApi;

export const JOB_POLL_MS = 1_000;

const SOURCE_LABELS: Record<AgentCliSource, string> = {
  nvm: "nvm",
  fnm: "fnm",
  mise: "mise",
  volta: "Volta",
  homebrew: "Homebrew",
  bun: "bun",
  pnpm: "pnpm",
  npm: "npm",
  native: "官方安装器",
  unknown: "来源不明",
};

/** 检测结果还没回来时（例如刷新后先恢复了进行中的任务）显示用的名字 */
const TOOL_NAMES: Record<AgentCliTool, string> = {
  claude: "Claude Code",
  codex: "Codex",
  copilot: "GitHub Copilot CLI",
  opencode: "OpenCode",
  omp: "Oh My Pi",
  openclaw: "OpenClaw",
  gemini: "Gemini CLI",
  agy: "Antigravity CLI",
};

const sourceLabel = (source: AgentCliSource) =>
  source === "native" || source === "unknown" ? t(SOURCE_LABELS[source]) : SOURCE_LABELS[source];

const errorMessage = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);

/** 任务还没结束：在跑，或者成功了但还没重新探测到版本 */
const pending = (job: AgentCliJob) =>
  job.state === "running" || (job.state === "succeeded" && job.versionAfter === undefined);

/** 正在进行的是哪个工具的什么操作：已经拿到任务，或者刚点了确认、还在等服务端核对命令 */
type Activity = { tool: string; name: string; action: AgentCliAction };

export function AgentClisGroup({
  api,
  focusTool,
  focusSection,
  focusKey,
}: {
  api: AgentClisApi;
  /** 从接入 Agent 弹窗跳过来时要看的那个 CLI：检测结果出来后滚过去并短暂突出 */
  focusTool?: AgentCliTool | undefined;
  /** 从总览跳过来：展开配置时直接打开这一组 */
  focusSection?: RuntimeConfigSection | undefined;
  /** 每跳一次换一个值，同一个 CLI 再点也会重新滚过去 */
  focusKey?: number | undefined;
}) {
  const [tools, setTools] = useState<AgentCliWithAgents[]>();
  const [job, setJob] = useState<AgentCliJob | null>(null);
  const [starting, setStarting] = useState<Activity>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const { agentClis, agentCliCurrent, agentCliJob, runtimeCredentials } = api;
  // 没装的 CLI 只要有配置文件也给「配置」按钮
  const [configured, setConfigured] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    void Promise.resolve()
      .then(runtimeCredentials)
      .then(
        (runtimes) =>
          setConfigured(
            new Set(runtimes.filter((runtime) => runtime.configured).map((r) => r.provider)),
          ),
        () => undefined,
      );
  }, [runtimeCredentials]);

  const adopt = useCallback((next: AgentCliJob | null) => {
    // 打开页面时有任务在跑：接着显示进度；已经结束的旧结果不再翻出来
    if (next && pending(next)) setJob((current) => current ?? next);
  }, []);

  const load = useCallback(
    async (refresh: boolean) => {
      setLoading(true);
      setError(undefined);
      try {
        const result = await agentClis(refresh);
        setTools(result.tools);
        adopt(result.job);
      } catch (reason) {
        setError(errorMessage(reason));
      } finally {
        setLoading(false);
      }
    },
    [agentClis, adopt],
  );

  useEffect(() => {
    // 当前任务先取：整份检测要几秒，进度不用等它
    // 取不到不影响检测：老服务端没有这个接口时等整份检测带回任务
    void Promise.resolve()
      .then(agentCliCurrent)
      .then(adopt, () => undefined);
    void load(false);
  }, [agentCliCurrent, adopt, load]);

  const hasTools = Boolean(tools);
  useEffect(() => {
    if (!focusTool || !hasTools) return;
    const card = document.getElementById(`agent-cli-${focusTool}`);
    if (!card) return;
    card.scrollIntoView?.({ block: "center", behavior: "smooth" });
    card.classList.add("focused");
    card.focus({ preventScroll: true });
    const timer = window.setTimeout(() => card.classList.remove("focused"), 2_000);
    return () => window.clearTimeout(timer);
  }, [focusTool, hasTools, focusKey]);

  // 任务进行中：轮询进度；结束后重新检测一次（服务端已作废检测缓存）
  const jobId = job && pending(job) ? job.id : undefined;
  useEffect(() => {
    if (!jobId) return;
    let stopped = false;
    const timer = window.setInterval(() => {
      agentCliJob(jobId).then(
        (next) => {
          if (stopped) return;
          setJob(next);
          if (!pending(next)) void load(false);
        },
        (reason: unknown) => !stopped && setError(errorMessage(reason)),
      );
    }, JOB_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [jobId, agentCliJob, load]);

  const running = job && job.state === "running" ? job : undefined;
  const activity: Activity | undefined =
    starting ??
    (running
      ? {
          tool: running.tool,
          name: tools?.find((tool) => tool.tool === running.tool)?.name ?? TOOL_NAMES[running.tool],
          action: running.action,
        }
      : undefined);

  const start = async (info: AgentCliWithAgents, action: AgentCliAction, command: string) => {
    setStarting({ tool: info.tool, name: info.name, action });
    try {
      const next =
        action === "install"
          ? await api.installAgentCli(info.tool, command)
          : await api.upgradeAgentCli(info.tool, command);
      setJob(next);
    } finally {
      setStarting(undefined);
    }
  };

  return (
    <div className="settings-group">
      <div className="settings-section-heading agent-clis-heading">
        <div>
          <h4>{t("已安装的 Agent CLI")}</h4>
          <p>
            {t(
              "检测这台电脑上装了哪些 Agent CLI、版本和安装位置（按登录终端的 PATH 查找）。安装和升级会在这台电脑上执行包管理器命令，执行前先给你确认，一次只跑一个。",
            )}
          </p>
        </div>
        <Button size="sm" disabled={loading || Boolean(activity)} onClick={() => void load(true)}>
          {loading ? t("正在检测…") : t("重新检测")}
        </Button>
      </div>
      {activity && (
        <p className="settings-note" role="status">
          {activity.action === "install"
            ? t("正在安装 {0}，完成后才能操作其它 CLI。", { 0: activity.name })
            : t("正在升级 {0}，完成后才能操作其它 CLI。", { 0: activity.name })}
        </p>
      )}
      {!tools && loading && <p className="settings-note">{t("正在检测…")}</p>}
      {tools?.map((tool) => (
        <AgentCliCard
          key={tool.tool}
          api={api}
          info={tool}
          job={job?.tool === tool.tool ? job : undefined}
          activity={activity}
          configurable={
            hasRuntimeConfig(tool.tool) &&
            (tool.status !== "notInstalled" || configured.has(tool.tool))
          }
          focused={focusTool === tool.tool}
          focusKey={focusKey}
          focusSection={focusTool === tool.tool ? focusSection : undefined}
          onStart={(action, command) => start(tool, action, command)}
        />
      ))}
      {error && <p className="settings-note error">{error}</p>}
    </div>
  );
}

function AgentCliCard({
  api,
  info,
  job,
  activity,
  configurable,
  focused,
  focusKey,
  focusSection,
  onStart,
}: {
  api: AgentClisApi;
  info: AgentCliWithAgents;
  job: AgentCliJob | undefined;
  activity: Activity | undefined;
  configurable: boolean;
  /** 从接入 Agent 弹窗跳过来看这个 CLI：能配置就直接展开配置面板 */
  focused: boolean;
  focusKey?: number | undefined;
  focusSection?: RuntimeConfigSection | undefined;
  onStart: (action: AgentCliAction, command: string) => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  useEffect(() => {
    if (focused && configurable) setConfigOpen(true);
  }, [focused, configurable, focusKey]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const primary = info.installations.find((install) => install.pathDefault);
  const action: AgentCliAction = info.status === "notInstalled" ? "install" : "upgrade";
  const command = info.plan?.kind === "anchored" ? info.plan.command : undefined;
  const offered =
    Boolean(command) &&
    !info.nodeGap &&
    (action === "install" ||
      info.updateAvailable ||
      info.latest === null ||
      // 装了但跑不起来（比如网络慢、平台程序包没下载下来）：允许用同一条命令重新装一遍
      info.status === "broken");
  const mine = activity?.tool === info.tool;
  const other = activity && !mine ? activity : undefined;

  const confirm = async () => {
    if (!command) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await onStart(action, command);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSubmitting(false);
      setConfirming(false);
      buttonRef.current?.focus();
    }
  };

  /** 装了但跑不起来：走升级流程（锚定到原处重装），文案按重新安装说 */
  const reinstall = action === "upgrade" && info.status === "broken";
  const label = mine
    ? action === "install"
      ? t("正在安装…")
      : reinstall
        ? t("正在重新安装…")
        : t("正在升级…")
    : action === "install"
      ? t("安装")
      : reinstall
        ? t("重新安装")
        : info.updateAvailable && info.latest
          ? t("升级到 {0}", { 0: info.latest })
          : t("尝试升级");

  return (
    <section
      id={`agent-cli-${info.tool}`}
      className="agent-cli"
      aria-label={info.name}
      aria-busy={mine}
      tabIndex={-1}
    >
      <div className="agent-cli-head">
        <div className="agent-cli-title">
          <h5>{info.name}</h5>
          <StatusLine info={info} />
        </div>
        <div className="agent-cli-buttons">
          {configurable && (
            <Button
              size="sm"
              aria-expanded={configOpen}
              onClick={() => setConfigOpen((open) => !open)}
            >
              {configOpen ? t("收起配置") : t("配置")}
            </Button>
          )}
          {(offered || mine) && (
            <Tooltip
              content={
                other
                  ? other.action === "install"
                    ? t("正在安装 {0}，完成后再试", { 0: other.name })
                    : t("正在升级 {0}，完成后再试", { 0: other.name })
                  : undefined
              }
            >
              <Button
                ref={buttonRef}
                size="sm"
                aria-expanded={confirming}
                disabled={Boolean(activity) || submitting}
                onClick={() => setConfirming(true)}
              >
                {mine && <span className="agent-cli-spinner" aria-hidden />}
                {label}
              </Button>
            </Tooltip>
          )}
        </div>
      </div>
      {primary && (
        <small className="agent-cli-path">
          <code>{primary.path}</code>
          <span className="agent-cli-source">{sourceLabel(primary.source)}</span>
        </small>
      )}
      {primary && !primary.runnable && primary.error && (
        <pre className="agent-cli-output">{primary.error}</pre>
      )}
      {info.conflict && <Installations installations={info.installations} />}
      {info.nodeGap && (
        <p className="settings-note warning">
          {t("新版需要 Node {0}，这台电脑用的是 Node {1}。先升级 Node 再来。", {
            0: info.nodeGap.required,
            1: info.nodeGap.current,
          })}
        </p>
      )}
      {info.plan?.kind === "manual" && (
        <p className="settings-note">
          {info.plan.reason}
          {info.plan.url && (
            <>
              {" "}
              <a href={info.plan.url} target="_blank" rel="noreferrer">
                {t("安装说明")}
              </a>
            </>
          )}
        </p>
      )}
      {action === "install" && info.binNotOnPath && (
        <p className="settings-note warning">
          {t("装好的命令会放在 {0}，这个目录不在登录终端的 PATH 里，装完要把它加进 PATH。", {
            0: info.binNotOnPath,
          })}
        </p>
      )}
      {mine && !job && (
        <div className="agent-cli-job" role="status">
          <span className="agent-cli-spinner" aria-hidden />
          <span>{t("正在核对命令…")}</span>
        </div>
      )}
      {job && <JobStatus api={api} info={info} job={job} />}
      {confirming && command && (
        <ConfirmPopover
          ariaLabel={
            action === "install"
              ? t("确认安装 {0}", { 0: info.name })
              : reinstall
                ? t("确认重新安装 {0}", { 0: info.name })
                : t("确认升级 {0}", { 0: info.name })
          }
          title={
            action === "install"
              ? t("在这台电脑上安装 {0}", { 0: info.name })
              : reinstall
                ? t("在这台电脑上重新安装 {0}", { 0: info.name })
                : t("在这台电脑上执行升级命令")
          }
          message={
            <>
              <CommandSteps action={action} name={info.name} command={command} />
              {action === "upgrade" && (
                <span>
                  {reinstall
                    ? t("正在用 {0} 的 Agent 不会自动重启，装好后再手动重启。", { 0: info.name })
                    : t("正在用 {0} 的 Agent 不会自动重启，升级完再手动重启。", { 0: info.name })}
                </span>
              )}
            </>
          }
          confirmLabel={action === "install" ? t("安装") : reinstall ? t("重新安装") : t("升级")}
          cancelLabel={t("取消")}
          anchorRef={buttonRef}
          busy={submitting}
          onConfirm={() => void confirm()}
          onCancel={() => {
            setConfirming(false);
            buttonRef.current?.focus();
          }}
        />
      )}
      {configOpen && hasRuntimeConfig(info.tool) && (
        <RuntimeConfigPanel
          api={api}
          provider={info.tool}
          {...(focusSection ? { initialSection: focusSection } : {})}
        />
      )}
      {error && <p className="settings-note error">{error}</p>}
    </section>
  );
}

/**
 * 确认气泡里的命令：用 `||` 串起来的回退链拆成「先试 / 失败再用」几步，每步等宽、自动换行、
 * 太长可以滚动；上面一句话说明回退的含义。展示用，执行的仍是整条原样命令。
 */
function CommandSteps({
  action,
  name,
  command,
}: {
  action: AgentCliAction;
  name: string;
  command: string;
}) {
  const steps = command.split(" || ");
  const script = steps[0]!.includes("curl -fsSL https://");
  const hint =
    steps.length > 1
      ? action === "install"
        ? t("先用官方安装脚本安装，失败了再自动改用 npm。")
        : t("先用 {0} 自带的升级命令，失败了再自动改用下一种方式。", { 0: name })
      : script
        ? t("会先把官方安装脚本下载到临时文件，再运行它。")
        : undefined;
  return (
    <>
      {hint && <span className="agent-cli-hint">{hint}</span>}
      <span>{t("将在这台电脑上运行：")}</span>
      {steps.length > 1 ? (
        <ol className="agent-cli-steps">
          {steps.map((step, index) => (
            <li key={index}>
              <span>{index === 0 ? t("先试") : t("失败再用")}</span>
              <code className="agent-cli-command">{step}</code>
            </li>
          ))}
        </ol>
      ) : (
        <code className="agent-cli-command">{command}</code>
      )}
    </>
  );
}

function StatusLine({ info }: { info: AgentCliWithAgents }) {
  if (info.status === "notInstalled") {
    return <span className="agent-cli-status muted">{t("未安装")}</span>;
  }
  const latest =
    info.latest === null
      ? t("查不到最新版")
      : info.updateAvailable && info.version
        ? t("有新版 {0}", { 0: info.latest })
        : info.updateAvailable
          ? t("最新版 {0}", { 0: info.latest })
          : t("已是最新");
  return (
    <span className={`agent-cli-status${info.status === "broken" ? " broken" : ""}`}>
      {info.status === "broken" ? t("装了但跑不起来") : (info.version ?? t("版本未知"))}
      <span className={info.updateAvailable ? "agent-cli-update" : undefined}> · {latest}</span>
    </span>
  );
}

function Installations({ installations }: { installations: AgentCliInstallation[] }) {
  return (
    <details className="agent-cli-installs">
      <summary>
        {t("装了 {0} 处，版本或可用性不一致：命令行和 Agent 用的是标「默认」的那处", {
          0: installations.length,
        })}
      </summary>
      <ul>
        {installations.map((install) => (
          <li key={install.realPath}>
            <code>{install.path}</code>
            <span>
              {install.runnable ? (install.version ?? t("版本未知")) : t("跑不起来")}
              {" · "}
              {sourceLabel(install.source)}
              {install.pathDefault ? ` · ${t("默认")}` : ""}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function JobStatus({
  api,
  info,
  job,
}: {
  api: AgentClisApi;
  info: AgentCliWithAgents;
  job: AgentCliJob;
}) {
  const [restarting, setRestarting] = useState(false);
  const [restartResult, setRestartResult] = useState<string>();
  const live = info.agents.filter((agent) => agent.status !== "stopped");

  if (pending(job)) {
    return (
      <div className="agent-cli-job" role="status">
        <span className="agent-cli-spinner" aria-hidden />
        <span>
          {job.action === "install"
            ? t("正在安装…")
            : // 升级前查不到版本（装了但跑不起来）就是重新安装；老 Server 不带这个字段，按升级说
              job.versionBefore === null
              ? t("正在重新安装…")
              : t("正在升级…")}
        </span>
        {job.progress && <code className="agent-cli-progress">{job.progress}</code>}
      </div>
    );
  }

  if (job.state === "failed") {
    return (
      <div className="agent-cli-job failed" role="alert">
        <p>
          {job.action === "install"
            ? t("安装失败：{0}", { 0: job.reason ?? "" })
            : t("升级失败：{0}", { 0: job.reason ?? "" })}
        </p>
        {job.error && <pre className="agent-cli-output">{job.error}</pre>}
      </div>
    );
  }

  const restart = async () => {
    setRestarting(true);
    setRestartResult(undefined);
    const failed: string[] = [];
    for (const agent of live) {
      try {
        await api.act(agent.id, "restart");
      } catch {
        failed.push(agent.name);
      }
    }
    setRestarting(false);
    setRestartResult(
      failed.length
        ? t("这些 Agent 没能重启：{0}", { 0: failed.join(t("、")) })
        : t("已重启 {0} 个 Agent", { 0: live.length }),
    );
  };

  if (job.action === "install") {
    return (
      <div className="agent-cli-job done" role="status">
        <p>
          {job.versionAfter
            ? t("已安装 {0} {1}。", { 0: info.name, 1: job.versionAfter })
            : t(
                "安装命令执行成功，但登录终端的 PATH 里还找不到 {0}。把它的目录加进 PATH 后重新检测。",
                {
                  0: info.name,
                },
              )}
        </p>
      </div>
    );
  }

  // 服务端按重新检测的版本定成败：版本没变的已经报成失败，这里只会是真的升上去了
  return (
    <div className="agent-cli-job done" role="status">
      <p>
        {job.versionBefore
          ? t("已升级到 {0}。", { 0: job.versionAfter ?? "" })
          : // 原来那一处跑不起来（查不到版本）时走的是重新安装
            t("已重新安装 {0} {1}。", { 0: info.name, 1: job.versionAfter ?? "" })}{" "}
        {info.agents.length
          ? t("用 {0} 的 Agent 重启后才用上新版：{1}", {
              0: info.name,
              1: info.agents.map((agent) => agent.name).join(t("、")),
            })
          : t("这台电脑上还没有用 {0} 的 Agent。", { 0: info.name })}
      </p>
      {live.length > 0 && (
        <Button
          size="sm"
          className="agent-cli-restart"
          disabled={restarting}
          onClick={() => void restart()}
        >
          {restarting ? t("正在重启…") : t("重启这 {0} 个 Agent", { 0: live.length })}
        </Button>
      )}
      {restartResult && <p className="settings-note">{restartResult}</p>}
    </div>
  );
}
