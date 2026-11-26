import { z } from "zod";
import { serverTextSchema } from "./server-text.js";

/**
 * 故障单：失败先按来源归类，属于我们自己代码的问题按指纹合并计数，到阈值后自动派给 Agent 修。
 * - internal：Server 抛异常、协议校验失败、Bridge 状态卡死、网页报错——要修代码
 * - external：模型服务出错或限流、网络、凭证过期、Agent 自己的 CLI 崩溃——只重试和提示，不派修
 * - unknown：说不清是谁的（旧版 Bridge 没给结构化原因等）——记下来给人看，不自动派修
 */
export const incidentOriginSchema = z.enum(["internal", "external", "unknown"]);
/** invocation=Agent 一轮失败；server=Server 抛异常；protocol=收到的事件没通过校验；web=网页报错 */
export const incidentSourceSchema = z.enum(["invocation", "server", "protocol", "web"]);
/**
 * open=新的或还没到派修阈值；fixing=已派给 Agent 修；fix_submitted=交了修复、等 review 合入；
 * resolved=修复已经在跑的代码里；escalated=修失败到上限或动了受保护的代码，等人处理；ignored=人标为不处理
 */
export const incidentStatusSchema = z.enum([
  "open",
  "fixing",
  "fix_submitted",
  "resolved",
  "escalated",
  "ignored",
]);

/** 一次出现的现场：只记定位要用的，不记消息正文、工具参数和凭证 */
export const incidentSampleSchema = z.object({
  at: z.string().datetime(),
  roomId: z.string().optional(),
  invocationId: z.string().optional(),
  messageId: z.string().optional(),
  agentName: z.string().optional(),
  provider: z.string().optional(),
  /** HTTP 路由模板或 WebSocket 事件类型 */
  route: z.string().optional(),
  /** 报错说明（已去掉本机用户目录） */
  detail: z.string().max(1000).optional(),
  detailText: serverTextSchema.optional(),
  /** 调用栈前若干行（已去掉本机用户目录） */
  stack: z.string().max(4000).optional(),
  /** 出事时在跑的 Server 代码提交 */
  codeVersion: z.string().optional(),
  /** 网页报错：页面地址（不含查询串和 #）与浏览器 */
  url: z.string().max(500).optional(),
  userAgent: z.string().max(300).optional(),
});

export const incidentDispatchSchema = z.object({
  id: z.string(),
  incidentId: z.string(),
  /** 第几次派修 */
  attempt: z.number().int().min(1),
  roomId: z.string(),
  agentName: z.string(),
  invocationId: z.string().optional(),
  messageId: z.string().optional(),
  at: z.string().datetime(),
  /** pending=修着；submitted=交了修复；failed=没修成；superseded=人另行处理了 */
  outcome: z.enum(["pending", "submitted", "failed", "superseded"]),
  reason: z.string().max(1000).optional(),
  commit: z.string().optional(),
  branch: z.string().optional(),
  endedAt: z.string().datetime().optional(),
});

export const incidentSchema = z.object({
  id: z.string(),
  fingerprint: z.string(),
  origin: incidentOriginSchema,
  source: incidentSourceSchema,
  /** 一句话：错误类型 + 归一化后的报错（数字、ID、路径换成占位） */
  title: z.string(),
  status: incidentStatusSchema,
  count: z.number().int().min(0),
  /** 上次修好（或人重新打开）之后又出现的次数；派修阈值按它算 */
  recentCount: z.number().int().min(0),
  firstSeenAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
  /** 最近几次的现场，新的在前 */
  samples: z.array(incidentSampleSchema),
  /** 派修失败了几次（修好后又出现也算一次） */
  failedAttempts: z.number().int().min(0),
  dispatches: z.array(incidentDispatchSchema),
  fixCommit: z.string().optional(),
  fixBranch: z.string().optional(),
  resolvedAt: z.string().datetime().optional(),
  /** 修好后又出现了几次被重新打开 */
  reopenedCount: z.number().int().min(0),
  /** 为什么升级给人、为什么重新打开等 */
  noteText: serverTextSchema.optional(),
  updatedAt: z.string().datetime(),
});

/** 经验库：每次修完记下「什么症状、什么原因、怎么修」，下次派活时附上 */
export const incidentLessonSchema = z.object({
  id: z.string(),
  incidentId: z.string(),
  source: incidentSourceSchema,
  title: z.string(),
  symptom: z.string().max(1000),
  cause: z.string().max(1000),
  fix: z.string().max(1000),
  commit: z.string().optional(),
  agentName: z.string(),
  createdAt: z.string().datetime(),
  /** 修复已经在跑的代码里、之后没再出现过 */
  verified: z.boolean(),
});

/** Agent 提议改协作规则或提示词：房主批准后才加进规则 */
export const ruleProposalSchema = z.object({
  id: z.string(),
  roomId: z.string(),
  agentName: z.string(),
  /** 要加的规则原文 */
  text: z.string().max(1000),
  /** 为什么：哪次出的问题、这条能防住什么 */
  reason: z.string().max(1000),
  status: z.enum(["pending", "approved", "rejected", "retired"]),
  createdAt: z.string().datetime(),
  decidedAt: z.string().datetime().optional(),
  decidedBy: z.string().optional(),
});

export const incidentSettingsSchema = z.object({
  /** 到阈值后自动派修；关掉时只归类、计数 */
  autoDispatch: z.boolean(),
  /** 在哪个房间派活 */
  roomId: z.string().max(64).optional(),
  /** 以谁的名义发出派活消息（这个房间里的人） */
  requester: z.string().max(32).optional(),
  /** 修的 Agent 与 review 的 Agent */
  fixer: z.string().max(32).optional(),
  reviewer: z.string().max(32).optional(),
  /** 同一指纹出现几次派修 */
  threshold: z.number().int().min(1).max(100),
  /** 每天（本地日期）最多自动派修几次 */
  dailyLimit: z.number().int().min(0).max(50),
  /** 同一个问题修失败几次就停下来找人 */
  maxAttempts: z.number().int().min(1).max(10),
});
export const updateIncidentSettingsRequestSchema = incidentSettingsSchema.partial();

export const incidentsResponseSchema = z.object({
  incidents: z.array(incidentSchema),
  lessons: z.array(incidentLessonSchema),
  proposals: z.array(ruleProposalSchema),
  settings: incidentSettingsSchema,
  /** 今天已经自动派修几次 */
  dispatchedToday: z.number().int().min(0),
  /** 自动修复不许改的路径（前缀或文件） */
  protectedPaths: z.array(z.string()),
  /** 在跑的 Server 代码提交 */
  runningCommit: z.string().optional(),
});

export const incidentActionRequestSchema = z.object({
  action: z.enum(["ignore", "reopen", "resolve", "dispatch"]),
});

export const ruleProposalDecisionRequestSchema = z.object({
  decision: z.enum(["approve", "reject", "retire"]),
});

/** 网页把自己的报错交给 Server 归档成故障单 */
export const clientErrorReportSchema = z.object({
  kind: z.enum(["error", "unhandledrejection"]),
  name: z.string().max(100).optional(),
  message: z.string().max(1000),
  stack: z.string().max(8000).optional(),
  url: z.string().max(2000).optional(),
  userAgent: z.string().max(500).optional(),
});

/**
 * 只会出现在 Vite 开发服务器上的报错现场，刷新页面即好、不是代码缺陷：
 * - 调用栈里有带 `?t=` 的源码模块：这个文件刚被热更新替换过（改到一半的代码、热更新后 Hook 顺序对不上）
 * - `node_modules/.vite/deps/` 里的预构建依赖带着不同的 `?v=`：依赖重新预构建了，页面里混着新旧两份 React
 * 生产构建的文件名带内容哈希、没有这些查询串，不受影响。网页（不上报）和 Server（不建故障单）共用。
 */
export function isViteDevNoise(stack: string | undefined): boolean {
  if (!stack) return false;
  if (/\/src\/[^\s?:)]+\.[cm]?[jt]sx?\?t=\d+/.test(stack)) return true;
  const versions = new Set<string>();
  for (const match of stack.matchAll(/\/\.vite\/deps\/[^\s?:)]+\?v=([0-9a-f]+)/gi)) {
    versions.add(match[1]!.toLowerCase());
  }
  return versions.size > 1;
}

export type IncidentOrigin = z.infer<typeof incidentOriginSchema>;
export type IncidentSource = z.infer<typeof incidentSourceSchema>;
export type IncidentStatus = z.infer<typeof incidentStatusSchema>;
export type IncidentSample = z.infer<typeof incidentSampleSchema>;
export type IncidentDispatch = z.infer<typeof incidentDispatchSchema>;
export type Incident = z.infer<typeof incidentSchema>;
export type IncidentLesson = z.infer<typeof incidentLessonSchema>;
export type RuleProposal = z.infer<typeof ruleProposalSchema>;
export type IncidentSettings = z.infer<typeof incidentSettingsSchema>;
export type UpdateIncidentSettingsRequest = z.infer<typeof updateIncidentSettingsRequestSchema>;
export type IncidentsResponse = z.infer<typeof incidentsResponseSchema>;
export type IncidentActionRequest = z.infer<typeof incidentActionRequestSchema>;
export type RuleProposalDecisionRequest = z.infer<typeof ruleProposalDecisionRequestSchema>;
export type ClientErrorReport = z.infer<typeof clientErrorReportSchema>;

export const DEFAULT_INCIDENT_SETTINGS: IncidentSettings = {
  autoDispatch: false,
  threshold: 3,
  dailyLimit: 3,
  maxAttempts: 2,
};
