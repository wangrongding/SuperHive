import type { MetaResponse, RemovedLocalAgent } from "@superhive/protocol";
import { t } from "./i18n";
import { Icon } from "./app-icons";
import { DocsLink } from "./docs-link";
import {
  agentSetupSteps,
  agentProviderLabel,
  agentAccessOptions,
  selectableAgentProviders,
  agentProviderDescriptions,
  AgentSetupStep,
  type AgentAccessMode,
} from "./agent-setup";
import { agentNameFor, type SelectableAgentProvider } from "./agent-name";
import { moveRadioSelection } from "./ui-utils";
import { providerInfo, LocalLaunch, type LocalAgentsState } from "./local-agents";
import { ProviderLogo } from "./provider-logos";
import { hasRuntimeConfig } from "./runtime-credentials";
import { HostManageNotice, LanShareNote } from "./host-settings";
import type { RefObject, Dispatch, SetStateAction } from "react";
import { Tooltip } from "./tooltip";
import { Button, IconButton } from "./button";
import { AccessSelector } from "./access-selector";

/** 接入 Agent 弹窗：选 Agent、设置权限、复制命令 */
export function AgentSetupDialog({
  agentAccess,
  agentConnected,
  agentDialogCloseRef,
  agentDialogRef,
  agentProvider,
  agentProviderChosen,
  agentStep,
  agentStepHeadingRef,
  base,
  chooseAgentAccess,
  closeAgentDialog,
  commandCopied,
  copyCommand,
  copyError,
  goToAgentStep,
  local,
  meta,
  openRuntimeSettings,
  selectedAgentCommand,
  setAgentConnected,
  setAgentProvider,
  setAgentProviderChosen,
  takenAgentNames,
  username,
  lanBlocked,
  rejoin,
}: {
  rejoin?: RemovedLocalAgent & { participantId: string };
  agentAccess: AgentAccessMode;
  agentConnected: boolean;
  agentDialogCloseRef: RefObject<HTMLButtonElement | null>;
  agentDialogRef: RefObject<HTMLDivElement | null>;
  agentProvider: SelectableAgentProvider;
  agentProviderChosen: boolean;
  agentStep: AgentSetupStep;
  agentStepHeadingRef: RefObject<HTMLHeadingElement | null>;
  base: string;
  chooseAgentAccess: (access: AgentAccessMode) => void;
  closeAgentDialog: () => void;
  commandCopied: boolean;
  copyCommand: () => Promise<void>;
  copyError: string | undefined;
  goToAgentStep: (step: AgentSetupStep) => void;
  local: LocalAgentsState;
  meta: MetaResponse | undefined;
  openRuntimeSettings: (provider: SelectableAgentProvider | undefined) => void;
  selectedAgentCommand: string;
  setAgentConnected: Dispatch<SetStateAction<boolean>>;
  setAgentProvider: Dispatch<SetStateAction<SelectableAgentProvider>>;
  setAgentProviderChosen: Dispatch<SetStateAction<boolean>>;
  takenAgentNames: Set<string>;
  username: string;
  /** 桌面端关着局域网：命令里的地址是 127.0.0.1，只能在这台电脑上跑，提示去打开 */
  lanBlocked?: { openSettings: () => void } | undefined;
}) {
  return (
    <div className="agent-dialog-layer">
      <button
        className="agent-dialog-scrim"
        type="button"
        aria-label={t("关闭 Agent 接入弹窗")}
        onClick={closeAgentDialog}
      />
      <div
        ref={agentDialogRef}
        className="agent-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-dialog-title"
        aria-describedby="agent-dialog-description"
      >
        <header className="agent-dialog-header">
          <div>
            <h2 id="agent-dialog-title">
              {rejoin ? t("重新接入 {0}", { 0: rejoin.name }) : t("把 Agent 接入 Hive")}
            </h2>
            <p id="agent-dialog-description">
              {rejoin
                ? t("重新确认运行时、权限和工作目录，然后用原名字接入。")
                : local.enabled
                  ? local.mode === "device"
                    ? t(
                        "三步完成：选择 Agent、设置权限，然后一键在 {0} 上启动（也可以复制命令）。",
                        {
                          0: local.hostLabel ?? t("Server 所在电脑"),
                        },
                      )
                    : t(
                        "三步完成：选择 Agent、设置本机权限，然后一键在本机启动（也可以复制命令）。",
                      )
                  : t("三步完成：选择 Agent、设置本机权限，然后把命令复制到终端运行。")}
            </p>
          </div>
          <IconButton
            ref={agentDialogCloseRef}
            className="dialog-close"
            label={t("关闭")}
            onClick={closeAgentDialog}
          >
            <Icon name="close" />
          </IconButton>
        </header>
        {rejoin && (
          <p className="agent-rejoin-note">
            {t("使用原名称重新接入，保留成员身份、历史消息和白板署名。请重新确认权限和工作目录。")}
          </p>
        )}

        <ol className="agent-steps" aria-label={t("接入步骤")}>
          {agentSetupSteps.map(({ step, label: baseLabel }) => {
            const label = step === 3 && local.enabled ? t("启动 Agent") : baseLabel;
            const state = step === agentStep ? "current" : step < agentStep ? "done" : "upcoming";
            return (
              <li
                key={step}
                className={state}
                aria-current={state === "current" ? "step" : undefined}
              >
                {state === "done" ? (
                  <button
                    type="button"
                    className="agent-step-back"
                    aria-label={t("返回第 {0} 步：{1}", { 0: step, 1: label })}
                    onClick={() => goToAgentStep(step)}
                  >
                    <span className="agent-step-index" aria-hidden="true">
                      <Icon name="check" size={12} />
                    </span>
                    <span>{label}</span>
                  </button>
                ) : (
                  <span>
                    <span className="agent-step-index" aria-hidden="true">
                      {step}
                    </span>
                    <span>{label}</span>
                  </span>
                )}
              </li>
            );
          })}
        </ol>

        <div className="agent-dialog-body">
          <div className="agent-step-heading">
            <h3 id="agent-step-title" ref={agentStepHeadingRef} tabIndex={-1}>
              {agentStep === 1
                ? t("选择要接入的 Agent")
                : agentStep === 2
                  ? t("允许 {0} 在本机做什么？", { 0: agentProviderLabel(agentProvider) })
                  : local.enabled
                    ? local.mode === "device"
                      ? t("在 {0} 上启动", { 0: local.hostLabel ?? t("Server 所在电脑") })
                      : t("在本机启动")
                    : t("复制命令，到终端运行")}
            </h3>
            {agentStep === 1 && (
              <p>
                {t(
                  "接入的是各家的命令行工具（CLI），要先在这台电脑装好对应 CLI 并登录；Codex、Claude 等的桌面 App 和网页版接不进来。选好后点「下一步」。",
                )}{" "}
                <DocsLink to="agentSetup">{t("接入指南")}</DocsLink>
              </p>
            )}
            {agentStep === 2 && (
              <p>
                {t("权限只在 Agent 所在电脑生效，Hive Server 始终只转发消息。默认完全访问。")}{" "}
                <DocsLink to="permissions">{t("权限说明")}</DocsLink>
              </p>
            )}
            {agentStep === 3 && (
              <p>
                {t("将以")}{" "}
                <code>
                  {rejoin?.name ?? agentNameFor(username, agentProvider, takenAgentNames)}
                </code>{" "}
                {rejoin && <span>({agentProviderLabel(agentProvider)}) </span>}
                {t("身份加入 · 权限：")}
                <strong className={`agent-access-label ${agentAccess}`}>
                  {agentAccessOptions.find((option) => option.id === agentAccess)?.label}
                </strong>
              </p>
            )}
          </div>

          {agentStep === 1 && (
            <div
              className="provider-selector"
              role="radiogroup"
              aria-labelledby="agent-step-title"
              onKeyDown={(event) =>
                moveRadioSelection(
                  event,
                  selectableAgentProviders.indexOf(agentProvider),
                  (index) => {
                    setAgentProvider(selectableAgentProviders[index]!);
                    setAgentProviderChosen(true);
                  },
                )
              }
            >
              {selectableAgentProviders.map((provider) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={agentProviderChosen && agentProvider === provider}
                  tabIndex={
                    agentProvider === provider ||
                    (!agentProviderChosen && provider === selectableAgentProviders[0])
                      ? 0
                      : -1
                  }
                  className={[
                    agentProviderChosen && agentProvider === provider ? "active" : "",
                    providerInfo(local, provider)?.installed === false ? "unavailable" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  // 只选中，不自动跳步：选好后由人点「下一步」，可以先比较、改主意
                  onClick={() => {
                    setAgentProvider(provider);
                    setAgentProviderChosen(true);
                  }}
                  key={provider}
                >
                  <span className="provider-monogram" aria-hidden="true">
                    <ProviderLogo provider={provider} />
                  </span>
                  <span className="provider-copy">
                    <strong>{agentProviderLabel(provider)}</strong>
                    <small>
                      {(() => {
                        const info = providerInfo(local, provider);
                        if (!info) return agentProviderDescriptions[provider];
                        return info.installed
                          ? `${agentProviderDescriptions[provider]}${info.version ? ` · ${info.version}` : ""}`
                          : t("本机未安装");
                      })()}
                    </small>
                  </span>
                  <span className="provider-check" aria-hidden="true">
                    <Icon name="check" size={15} />
                  </span>
                </button>
              ))}
            </div>
          )}
          {agentStep === 1 && agentProviderChosen && agentProvider === "agy" && (
            <p className="openclaw-access-note">
              {t(
                "agy 要先登录：在这台电脑的终端运行一次 agy，用 Google 账号登录。不想用 Google 账号的，可以在 ~/.gemini/.env 里配置 GEMINI_API_KEY（自建接口再加 GOOGLE_GEMINI_BASE_URL），Hive 会改用 API key。没登录时它会在房间里说明原因，不会卡住。",
              )}
            </p>
          )}
          {agentStep === 1 && agentProviderChosen && agentProvider === "gemini" && (
            <p className="openclaw-access-note">
              {t(
                "Gemini CLI 用 ~/.gemini/.env 里的 GEMINI_API_KEY（自建接口再加 GOOGLE_GEMINI_BASE_URL），Hive 启动它时会自动带上；也可以先在终端运行一次 gemini 完成登录。",
              )}
            </p>
          )}
          {agentStep === 1 && local.mode === "local" && (
            <Button
              variant="link"
              className="agent-runtime-link"
              onClick={() => openRuntimeSettings(agentProviderChosen ? agentProvider : undefined)}
            >
              {agentProviderChosen
                ? providerInfo(local, agentProvider)?.installed === false
                  ? t("去安装 {0} →", { 0: agentProviderLabel(agentProvider) })
                  : hasRuntimeConfig(agentProvider)
                    ? t("升级或调整 {0} 的配置（接口地址、密钥、模型等）→", {
                        0: agentProviderLabel(agentProvider),
                      })
                    : t("升级 {0} →", { 0: agentProviderLabel(agentProvider) })
                : t("安装、升级 Agent 或调整它们的配置 →")}
            </Button>
          )}

          {agentStep === 2 && (
            <>
              <div>
                <AccessSelector
                  value={agentAccess}
                  onChange={chooseAgentAccess}
                  provider={agentProvider}
                  hostPlatform={local.hostPlatform}
                  labelledBy="agent-step-title"
                />
              </div>
              {agentProvider === "openclaw" && (
                <p className="openclaw-access-note">
                  {t(
                    "OpenClaw 的实际权限还需在其 Agent / Gateway 中设置；Hive 不会自动改写全局策略。",
                  )}
                </p>
              )}
              {agentProvider === "omp" && agentAccess === "workspace" && (
                <p className="openclaw-access-note">
                  {t(
                    "omp 不会把文件写入限制在当前目录内；需要目录隔离时请选择 OpenCode、Codex 或 Claude Code。",
                  )}
                </p>
              )}
            </>
          )}

          {agentStep === 3 &&
            (() => {
              // 复制命令这一整段：本机模式下折叠为"或复制命令"，否则直接展示
              const commandSection = (
                <>
                  {lanBlocked && (
                    <LanShareNote
                      message={t(
                        "局域网访问已关闭，别的电脑连不上，下面的命令只能在这台电脑上运行。",
                      )}
                      onOpen={lanBlocked.openSettings}
                    />
                  )}
                  <div className="command">
                    <div className="command-heading">
                      <span className="terminal-dots" aria-hidden="true">
                        <i />
                        <i />
                        <i />
                      </span>
                      <small>{t("终端")}</small>
                    </div>
                    <code>{selectedAgentCommand}</code>
                    <Button
                      variant="primary"
                      size="sm"
                      className="command-copy"
                      disabled={!meta}
                      onClick={() => void copyCommand()}
                    >
                      <Icon name={commandCopied ? "check" : "copy"} size={16} />
                      <span>{commandCopied ? t("已复制到剪贴板") : t("复制命令")}</span>
                    </Button>
                  </div>
                  {copyError && (
                    <p className="command-copy-error" role="alert">
                      {copyError}
                    </p>
                  )}
                  {meta?.agentCommand && !meta.agentCommand.startsWith("npx") && (
                    <p className="command-dev-note">
                      {t(
                        "开发模式命令：请在 superhive 仓库根目录的终端运行，使用的是当前仓库代码， 而非已发布的 npm 包。",
                      )}
                    </p>
                  )}
                  <ol className="agent-next-steps" aria-label={t("接入后的操作")}>
                    <li>
                      {t(
                        "在 {0} 所在电脑的终端运行这条命令，Agent 会加入所有房间并保持每个房间的独立上下文。",
                        { 0: agentProviderLabel(agentProvider) },
                      )}
                    </li>
                    <li>
                      {t("在消息中输入")}{" "}
                      <code>@{agentNameFor(username, agentProvider, takenAgentNames)}</code>{" "}
                      {t("即可让它响应；没被 @ 时它只会旁听。")}
                    </li>
                    <li>
                      {t("终端按")} <kbd>Ctrl + C</kbd>{" "}
                      {t("即可让它离线。只想加入单个房间可在命令后追加")}{" "}
                      <code>{t("--room 房间ID")}</code>
                      {t("。")}
                    </li>
                  </ol>
                </>
              );
              return local.enabled ? (
                <>
                  <HostManageNotice local={local} compact />
                  <LocalLaunch
                    local={local}
                    provider={agentProvider}
                    access={agentAccess}
                    defaultName={
                      rejoin?.name ?? agentNameFor(username, agentProvider, takenAgentNames)
                    }
                    rejoin={rejoin}
                    takenNames={takenAgentNames}
                    providerLabel={agentProviderLabel(agentProvider)}
                    onLaunched={() => setAgentConnected(true)}
                  >
                    {rejoin ? null : commandSection}
                  </LocalLaunch>
                </>
              ) : (
                commandSection
              );
            })()}
        </div>

        <footer className="agent-dialog-footer">
          {agentStep === 3 && (
            <div className="agent-dialog-links">
              <details className="connection-details">
                <summary>{t("查看连接信息")}</summary>
                <dl>
                  <div>
                    <dt>{t("服务地址")}</dt>
                    <dd>
                      <code>{meta?.httpUrl ?? base}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Hive MCP</dt>
                    <dd>
                      <code>{meta?.mcpUrl ?? `${base}/mcp`}</code>
                    </dd>
                  </div>
                </dl>
              </details>
              <a className="agent-doc" href={`${base}/agent.md`} target="_blank" rel="noreferrer">
                {t("行为与安全规则")} <Icon name="external" size={15} />
              </a>
            </div>
          )}
          <div className="agent-dialog-nav dialog-actions">
            {agentStep > 1 && (
              <Button onClick={() => goToAgentStep((agentStep - 1) as AgentSetupStep)}>
                {t("上一步")}
              </Button>
            )}
            {agentStep < 3 ? (
              <Tooltip
                content={agentStep === 1 && !agentProviderChosen ? t("先选一个 Agent") : undefined}
              >
                <Button
                  variant="primary"
                  disabled={agentStep === 1 && !agentProviderChosen}
                  onClick={() => goToAgentStep((agentStep + 1) as AgentSetupStep)}
                >
                  <span>{t("下一步")}</span>
                  <Icon name="arrow-right" size={16} />
                </Button>
              </Tooltip>
            ) : (
              agentConnected && (
                <Button variant="primary" onClick={closeAgentDialog}>
                  {t("完成")}
                </Button>
              )
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
