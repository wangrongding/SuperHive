import type { MetaResponse, Participant } from "@superhive/protocol";
import { agentNameFor, type SelectableAgentProvider } from "./agent-name";
import { localized, t } from "./i18n";

export type AgentAccessMode = "read-only" | "workspace" | "full";
export type AgentSetupStep = 1 | 2 | 3;

export const selectableAgentProviders = [
  "codex",
  "claude",
  "copilot",
  "opencode",
  "omp",
  "gemini",
  "agy",
  "openclaw",
] as const;

export const agentProviderDescriptions: Record<SelectableAgentProvider, string> = localized(() => ({
  codex: t("OpenAI Codex 命令行版（CLI），不是桌面 App"),
  claude: t("Anthropic 命令行版（CLI），不是桌面 App"),
  copilot: t("GitHub Copilot 命令行版（CLI）"),
  openclaw: t("本地自主 Agent（命令行）"),
  opencode: t("开源命令行 Agent（CLI），模型自选"),
  omp: t("oh-my-pi 命令行 Agent（CLI）"),
  gemini: t("Google 命令行 Agent（CLI），可用 API key"),
  agy: t("Google Antigravity 命令行版（CLI）"),
}));

export const agentAccessOptions: Array<{
  id: AgentAccessMode;
  label: string;
  description: string;
}> = localized(() => [
  {
    id: "read-only",
    label: t("只读"),
    description: t("只能读代码、出方案，不能改文件、跑命令；适合只想让它看看、给建议。"),
  },
  {
    id: "workspace",
    label: t("工作区"),
    description: t("推荐。可在指定目录内读写文件、运行命令；越界的操作会被拦下或先问你。"),
  },
  {
    id: "full",
    label: t("完全访问"),
    description: t("不设 Hive 沙箱，可执行当前系统用户的所有操作。"),
  },
]);

export const agentSetupSteps: Array<{ step: AgentSetupStep; label: string }> = localized(() => [
  { step: 1, label: t("选择 Agent") },
  { step: 2, label: t("设置权限") },
  { step: 3, label: t("复制命令") },
]);

/** "继续"按钮一次追加的 Agent 互相对话轮数 */

export function participantStatusLabel(status: Participant["status"]): string {
  if (status === "online") return t("在线");
  if (status === "busy") return t("正在处理");
  return t("离线");
}

export function agentProviderLabel(provider?: string): string {
  if (provider === "codex") return "Codex CLI";
  if (provider === "claude") return "Claude Code";
  if (provider === "copilot") return "Copilot CLI";
  if (provider === "openclaw") return "OpenClaw";
  if (provider === "opencode") return "OpenCode";
  if (provider === "omp") return "omp";
  if (provider === "gemini") return "Gemini CLI";
  if (provider === "agy") return "Antigravity";
  if (provider === "echo") return "Echo";
  return provider || "Agent";
}

export function agentCommandFor(
  meta: MetaResponse,
  provider: SelectableAgentProvider,
  ownerUsername: string,
  access: AgentAccessMode,
  takenNames?: ReadonlySet<string>,
): string {
  const agentName = agentNameFor(ownerUsername, provider, takenNames);
  return (meta.agentCommand ?? "")
    .replace(" join ", ` join --provider ${provider} `)
    .replace("--room general ", "")
    .replace("--name my-agent", `--name ${agentName}`)
    .concat(` --access ${access}${access === "read-only" ? "" : " --cwd ."}`)
    .concat(provider === "openclaw" ? " --openclaw-configure-mcp" : "");
}

/**
 * 访客「带入我的 Agent」的命令：服务端给的命令没有运行时；补上 --provider，再加 --background，
 * 关掉终端也在线（Windows 用户常常跑完就把终端关了，Agent 随之离线）。
 */
export function guestAgentCommand(command: string, provider: SelectableAgentProvider): string {
  const withProvider = / --provider /.test(command)
    ? command
    : command.replace(" join ", ` join --provider ${provider} `);
  return withProvider
    .concat(provider === "openclaw" ? " --openclaw-configure-mcp" : "")
    .concat(/ --background\b/.test(withProvider) ? "" : " --background");
}
