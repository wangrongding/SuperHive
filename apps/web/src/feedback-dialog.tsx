import { useEffect, useRef, useState } from "react";
import type { AgentCliInfo, Incident, MetaResponse, Participant } from "@superhive/protocol";
import { AppDialog } from "./app-dialog";
import { Button } from "./button";
import { Icon } from "./app-icons";
import { Select } from "./select";
import { DocsLink } from "./docs-link";
import { desktopBridge } from "./desktop-bridge";
import { copyTextToClipboard } from "./clipboard";
import { t } from "./i18n";
import type { LocalAgentsState } from "./local-agents";
import {
  buildContributionTask,
  buildFeedbackReport,
  contributionAgents,
  contributionIssue,
  feedbackBuild,
  feedbackDiagnostics,
  feedbackIssueLink,
  incidentFeedback,
  SUPERHIVE_REPOSITORY,
  type FeedbackFields,
  type FeedbackReport,
} from "./feedback";
import "./styles/feedback.css";

export function FeedbackDialog({
  local,
  meta,
  participants,
  recentIncident,
  prefillIncident = false,
  startContributing = false,
  canContribute,
  onContribute,
  onClose,
}: {
  local: LocalAgentsState;
  meta: MetaResponse | undefined;
  participants: readonly Participant[];
  recentIncident?: Incident;
  prefillIncident?: boolean;
  startContributing?: boolean;
  canContribute: boolean;
  onContribute: (agent: string, task: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const incident = recentIncident ? incidentFeedback(recentIncident) : undefined;
  const [fields, setFields] = useState<FeedbackFields>({
    type: "bug",
    title: prefillIncident ? (incident?.title ?? "") : "",
    description:
      prefillIncident && recentIncident
        ? t("SuperHive 记录了一次 {0} 故障，请协助复现和排查。", { 0: recentIncident.source })
        : "",
    steps: "",
    expected: "",
    actual: "",
  });
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true);
  const [includeIncident, setIncludeIncident] = useState(false);
  const [runtimes, setRuntimes] = useState<AgentCliInfo[]>([]);
  const [runtimeState, setRuntimeState] = useState("loading");
  const [preview, setPreview] = useState<FeedbackReport>();
  const [contributing, setContributing] = useState(startContributing);
  const [agent, setAgent] = useState("");
  const [directory, setDirectory] = useState("");
  const [issue, setIssue] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [sentTask, setSentTask] = useState<string>();
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const lock = useRef(false);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    if (local.enabled && local.mode === "local") {
      void local.refreshAgents().catch(() => undefined);
      local
        .agentClis()
        .then(({ tools }) => {
          if (active) {
            setRuntimes(tools.filter((tool) => tool.status !== "notInstalled"));
            setRuntimeState("ready");
          }
        })
        .catch(() => {
          if (active) setRuntimeState("unavailable");
        });
    } else setRuntimeState("unavailable");
    return () => {
      active = false;
    };
  }, [local.enabled, local.mode, local.agentClis, local.refreshAgents]);

  const diagnostics = feedbackDiagnostics({
    build: meta?.feedback?.version
      ? { version: meta.feedback.version, commit: meta.feedback.commit }
      : feedbackBuild,
    runMode: desktopBridge()
      ? t("客户端")
      : meta?.feedback?.runMode === "source"
        ? t("源码")
        : meta?.feedback?.runMode === "npm"
          ? "npm"
          : t("未知"),
    platform:
      local.mode === "local" ? (local.hostPlatform ?? navigator.platform) : navigator.platform,
    userAgent: navigator.userAgent,
    runtimes,
  });
  const report =
    preview ??
    buildFeedbackReport(
      fields,
      includeDiagnostics ? diagnostics : "",
      includeIncident ? incident?.summary : "",
    );
  const agents = canContribute ? contributionAgents(local.agents, participants) : [];
  const valid = Boolean(report.title && fields.description.trim());
  const task = buildContributionTask(report, directory, issue);
  const update = (key: keyof FeedbackFields, value: string) => {
    setFields((current) => ({ ...current, [key]: value }));
    setError("");
    setNotice("");
  };

  async function copy() {
    try {
      await copyTextToClipboard(report.body);
      setNotice(t("正文已复制。"));
      setError("");
    } catch {
      setError(t("无法复制。请从预览中手动选择正文。"));
    }
  }

  async function openGitHub() {
    if (lock.current) return;
    setError("");
    setNotice("");
    const link = feedbackIssueLink(report);
    if (link.needsClipboard) {
      try {
        await copyTextToClipboard(report.body);
      } catch {
        setError(t("正文太长且无法复制。请先从预览手动复制，再打开 GitHub。"));
        return;
      }
      setNotice(t("正文较长，已复制。点击下方链接，在 GitHub 的描述字段粘贴并确认提交。"));
      return;
    }
    const opened = window.open(link.url, "_blank", "noopener,noreferrer");
    void opened;
    setNotice(t("已请求打开 GitHub；若浏览器拦截，请点下方链接。尚未创建 issue。"));
  }

  async function contribute() {
    if (lock.current || sent || !agents.some((item) => item.name === agent)) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const confirmed = await onContribute(agent, task);
      setSent(true);
      setSentTask(task);
      setNotice(
        confirmed
          ? t("任务已保存到房间，将按队列交给 Agent。尚未 push 或创建 PR。")
          : t("任务已发出但未收到回执。请检查当前房间，不要重复派发；尚未确认 Agent 已收到。"),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("任务发送失败。"));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <AppDialog
      size="lg"
      title={t("反馈与共建")}
      className="feedback-dialog"
      initialFocus={titleRef}
      onClose={onClose}
      footer={
        <>
          {preview ? (
            <Button onClick={() => setPreview(undefined)}>{t("返回编辑")}</Button>
          ) : (
            <Button disabled={!valid} onClick={() => setPreview(report)}>
              {t("预览最终正文")}
            </Button>
          )}
          {preview && (
            <Button onClick={() => void copy()}>
              <Icon name="copy" size={15} />
              <span>{t("复制正文")}</span>
            </Button>
          )}
          {preview && (
            <Button variant="primary" disabled={!valid} onClick={() => void openGitHub()}>
              <Icon name="external" size={15} />
              <span>{t("去 GitHub 确认提交")}</span>
            </Button>
          )}
        </>
      }
    >
      <p className="feedback-intro">
        {t("把问题变成修复，把建议变成新功能。提交前由你检查，最后在自己的 GitHub 账号里确认。")}
      </p>
      <p className="feedback-privacy">
        <Icon name="shield" size={16} />
        {t(
          "不收集 GitHub 凭据，不自动提交；诊断只取版本信息，不读取房间正文或原始日志。自动脱敏不能识别所有秘密，请再次检查。",
        )}
      </p>
      {preview ? (
        <section className="feedback-preview" aria-label={t("最终正文预览")}>
          <h3>{report.title}</h3>
          <pre tabIndex={0}>{report.body}</pre>
          <a href={feedbackIssueLink(report).url} target="_blank" rel="noreferrer">
            {t("打开生成的 GitHub 链接")}
          </a>
          <p className="settings-note">
            {t("GitHub 表单按字段预填；长正文复制后粘贴到描述。你还需要在 GitHub 点击提交。")}
          </p>
        </section>
      ) : (
        <>
          <div className="feedback-type" role="group" aria-label={t("反馈类型")}>
            <Button
              variant={fields.type === "bug" ? "primary" : "secondary"}
              aria-pressed={fields.type === "bug"}
              onClick={() => update("type", "bug")}
            >
              <Icon name="alert" size={16} />
              <span>{t("报告问题")}</span>
            </Button>
            <Button
              variant={fields.type === "feature" ? "primary" : "secondary"}
              aria-pressed={fields.type === "feature"}
              onClick={() => update("type", "feature")}
            >
              <Icon name="plus" size={16} />
              <span>{t("建议功能")}</span>
            </Button>
          </div>
          <label>
            {t("标题")}
            <input
              ref={titleRef}
              required
              value={fields.title}
              maxLength={180}
              onChange={(event) => update("title", event.target.value)}
            />
          </label>
          <label>
            {t("描述")}
            <textarea
              value={fields.description}
              required
              rows={3}
              maxLength={20_000}
              onChange={(event) => update("description", event.target.value)}
              placeholder={t("只描述 SuperHive 的行为，不粘贴房间消息或凭据。")}
            />
          </label>
          {fields.type === "bug" && (
            <>
              <label>
                {t("复现步骤")}
                <textarea
                  value={fields.steps}
                  rows={2}
                  maxLength={10_000}
                  onChange={(event) => update("steps", event.target.value)}
                />
              </label>
              <div className="feedback-result-fields">
                <label>
                  {t("期望结果")}
                  <textarea
                    value={fields.expected}
                    rows={2}
                    maxLength={5_000}
                    onChange={(event) => update("expected", event.target.value)}
                  />
                </label>
                <label>
                  {t("实际结果")}
                  <textarea
                    value={fields.actual}
                    rows={2}
                    maxLength={5_000}
                    onChange={(event) => update("actual", event.target.value)}
                  />
                </label>
              </div>
            </>
          )}
          <section className="feedback-diagnostics" aria-label={t("诊断信息")}>
            <label className="feedback-check">
              <input
                type="checkbox"
                checked={includeDiagnostics}
                onChange={(event) => setIncludeDiagnostics(event.target.checked)}
              />
              {t("附上诊断信息")}
            </label>
            <pre>{diagnostics}</pre>
            <small>
              {runtimeState === "loading"
                ? t("正在读取运行时版本…")
                : runtimeState === "unavailable"
                  ? t("运行时版本不可用；不会为反馈安装或登录任何工具。")
                  : t("仅附上运行时种类和版本，不附安装路径、命令或设置。")}
            </small>
            {incident && (
              <>
                <label className="feedback-check">
                  <input
                    type="checkbox"
                    checked={includeIncident}
                    onChange={(event) => setIncludeIncident(event.target.checked)}
                  />
                  {t("附上最近故障单摘要")}
                </label>
                <pre>{incident.summary}</pre>
                <small>
                  {t("摘要只含来源、状态、次数和代码位置；不含房间、成员、错误原文或派修记录。")}
                </small>
              </>
            )}
          </section>
        </>
      )}
      {notice && (
        <p role="status" className="feedback-notice">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <section className="feedback-contribute">
        <div className="feedback-contribute-heading">
          <h3>{t("一起建设 SuperHive")}</h3>
          <DocsLink to="contributing">{t("反馈与贡献指南")}</DocsLink>
        </div>
        <Button onClick={() => setContributing((current) => !current)} aria-expanded={contributing}>
          <Icon name="terminal" size={16} />
          <span>{t("让我的 Agent 来修")}</span>
        </Button>
        {contributing && (
          <>
            <p className="settings-note">
              {t(
                "也可实现功能建议。任务会以你的身份发到当前共享房间；目标目录会对房间成员可见，请选择专门的贡献目录。",
              )}
            </p>
            {!agents.length && (
              <p>
                {t(
                  "需要本机房主和当前房间里在线、可写的本机 Agent。请先接入 Agent；远程访客不能派本机贡献任务。",
                )}
              </p>
            )}
            <label>
              {t("本机 Agent")}
              <Select
                value={agent}
                options={agents.map((item) => ({ value: item.name, label: item.name }))}
                onChange={setAgent}
                placeholder={t("选择 Agent")}
                aria-label={t("本机 Agent")}
                disabled={sent || busy}
              />
            </label>
            <label>
              {t("贡献目录")}
              <input
                value={directory}
                maxLength={1_000}
                onChange={(event) => setDirectory(event.target.value)}
                placeholder={t("用于克隆或更新 SuperHive 的专用目录")}
                disabled={sent || busy}
              />
            </label>
            <label>
              {t("关联 issue（可选）")}
              <input
                type="url"
                value={issue}
                onChange={(event) => setIssue(event.target.value)}
                placeholder={`${SUPERHIVE_REPOSITORY}/issues/123`}
                disabled={sent || busy}
              />
            </label>
            {issue && !contributionIssue(issue) && (
              <p className="error">{t("请填写 SuperHive 仓库中已提交的 issue 链接。")}</p>
            )}
            <p className="settings-note">
              {t(
                "Agent 会先检查 gh 是否安装、是否登录。push 和创建普通 PR 前必须通过 hive_ask_human 请你确认，不会自动合入。",
              )}
            </p>
            <details>
              <summary>{t("查看将交给 Agent 的任务")}</summary>
              <pre className="feedback-task">{sentTask ?? task}</pre>
            </details>
            <Button
              disabled={
                !valid ||
                !directory.trim() ||
                !agents.some((item) => item.name === agent) ||
                Boolean(issue && !contributionIssue(issue)) ||
                busy ||
                sent
              }
              variant="primary"
              onClick={() => void contribute()}
            >
              {busy ? t("正在发送…") : sent ? t("任务已发送") : t("确认交给 Agent")}
            </Button>
          </>
        )}
      </section>
      <a
        className="feedback-search"
        href={`${SUPERHIVE_REPOSITORY}/issues`}
        target="_blank"
        rel="noreferrer"
      >
        {t("先看看是否已有相同问题或建议")}
      </a>
    </AppDialog>
  );
}
