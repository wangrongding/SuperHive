import { z } from "zod";
import { serverTextSchema } from "./server-text.js";

/**
 * 本机装了哪些 Agent CLI、版本、从哪装的，以及一键升级（只限本机房主）。
 * 检测用登录 shell 的 PATH；升级命令锚定到命令行实际用的那一处安装，认不出来源的不执行。
 */
export const agentCliToolSchema = z.enum([
  "claude",
  "codex",
  "copilot",
  "opencode",
  "omp",
  "openclaw",
  "gemini",
  "agy",
]);

/**
 * 安装来源：node 版本管理器（nvm、fnm、mise、volta）、包管理器（homebrew、bun、pnpm）、
 * npm（自定义前缀的 npm 全局安装）、native（官方安装器）；unknown 表示认不出，不给一键升级。
 */
export const agentCliSourceSchema = z.enum([
  "nvm",
  "fnm",
  "mise",
  "volta",
  "homebrew",
  "bun",
  "pnpm",
  "npm",
  "native",
  "unknown",
]);

export const agentCliInstallationSchema = z.object({
  /** 命令行里看到的入口（未解析符号链接） */
  path: z.string(),
  /** 解析符号链接后的真实文件 */
  realPath: z.string(),
  version: z.string().nullable(),
  /** `--version` 能正常退出 */
  runnable: z.boolean(),
  /** 跑不起来时输出的末几行 */
  error: z.string().optional(),
  source: agentCliSourceSchema,
  /** 登录 shell 里输入命令时用的就是这一处，升级也作用在这一处 */
  pathDefault: z.boolean(),
});

/** 安装或升级计划：anchored 可以执行（command 原样展示给人确认）；manual 不能一键做，reason 说明原因 */
export const agentCliUpdatePlanSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("anchored"), command: z.string() }),
  z.object({
    kind: z.literal("manual"),
    reason: z.string(),
    reasonText: serverTextSchema.optional(),
    /** 官方安装说明 */
    url: z.string().optional(),
    /** 建议人自己在终端里跑的命令（只展示、可复制，服务端不执行）；拿不准的不给 */
    command: z.string().optional(),
  }),
]);

export const agentCliInfoSchema = z.object({
  tool: agentCliToolSchema,
  name: z.string(),
  /** npm 上的包名（查最新版用） */
  package: z.string(),
  /** notInstalled：哪里都没找到；broken：命令行默认那处跑不起来 */
  status: z.enum(["ok", "broken", "notInstalled"]),
  /** 命令行默认那处的版本 */
  version: z.string().nullable(),
  installations: z.array(agentCliInstallationSchema),
  /** 装了不止一处，并且版本不同或有的跑不起来 */
  conflict: z.boolean(),
  /** npm 上的最新版；查不到时为 null */
  latest: z.string().nullable(),
  updateAvailable: z.boolean(),
  /** 新版要求的 Node 本机不满足：不给升级 */
  nodeGap: z.object({ required: z.string(), current: z.string() }).optional(),
  /** 按钮做什么：没装时是安装计划，装了是升级计划 */
  plan: agentCliUpdatePlanSchema.optional(),
  /** 安装用的全局 bin 目录不在登录 shell 的 PATH 里：装完命令行找不到 */
  binNotOnPath: z.string().optional(),
});

export const agentCliJobSchema = z.object({
  id: z.string(),
  tool: agentCliToolSchema,
  action: z.enum(["install", "upgrade"]),
  command: z.string(),
  /** queued：核对通过，等别的 CLI 跑完腾出名额 */
  state: z.enum(["queued", "running", "succeeded", "failed"]),
  /** 最近一行输出（节流、截断） */
  progress: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  /** 失败原因（中文；reasonText 供网页按语言渲染） */
  reason: z.string().optional(),
  reasonText: serverTextSchema.optional(),
  /** 失败时输出的末几行 */
  error: z.string().optional(),
  /** 失败时的完整输出（去掉颜色，最多末尾 16000 字）；和末几行一样时不带 */
  output: z.string().optional(),
  /** 升级前命令行默认那处的版本 */
  versionBefore: z.string().nullable().optional(),
  /** 升级后重新探测到的版本 */
  versionAfter: z.string().nullable().optional(),
});

/** 确认安装或升级：带上页面展示过的命令，服务端重新算一遍，对不上就不执行 */
export const upgradeAgentCliRequestSchema = z.object({ command: z.string().min(1).max(4096) });

export type AgentCliTool = z.infer<typeof agentCliToolSchema>;
export type AgentCliSource = z.infer<typeof agentCliSourceSchema>;
export type AgentCliInstallation = z.infer<typeof agentCliInstallationSchema>;
export type AgentCliUpdatePlan = z.infer<typeof agentCliUpdatePlanSchema>;
export type AgentCliInfo = z.infer<typeof agentCliInfoSchema>;
export type AgentCliJob = z.infer<typeof agentCliJobSchema>;
export type AgentCliAction = AgentCliJob["action"];
export type UpgradeAgentCliRequest = z.infer<typeof upgradeAgentCliRequestSchema>;
