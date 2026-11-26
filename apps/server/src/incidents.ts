import { homedir } from "node:os";
import path from "node:path";
import {
  zhText,
  type ClientErrorReport,
  type FailureKind,
  type IncidentOrigin,
  type IncidentSample,
  type IncidentSource,
  type Invocation,
  type ServerText,
  type WireServerText,
  isViteDevNoise,
} from "@superhive/protocol";

/**
 * 失败归类：先判断是谁的问题，再按指纹合并。
 * 归类只看 Bridge 和 Server 自己写的结构化文案键、错误类型和调用栈，不看消息正文。
 */

/** 一次失败归类后的结果，交给 IncidentStore.record 合并计数 */
export type IncidentOccurrence = {
  origin: IncidentOrigin;
  source: IncidentSource;
  fingerprint: string;
  title: string;
  sample: IncidentSample;
  /** 同一次出现只记一次（断线重发、重复上报）；省略时每次都记 */
  ref?: string;
};

/**
 * 调用失败的说明键 → 是谁的问题。不在表里的（旧版 Bridge 只给中文、或新加的键）一律算 unknown，
 * 只记下来给人看，不会被自动派修。
 */
const INVOCATION_ORIGINS: Readonly<Record<string, IncidentOrigin>> = {
  // 模型服务、网络、凭证、Agent 自己的 CLI：Bridge 已经重试过，我们改代码也修不好
  "bridge.upstreamFailed": "external",
  "bridge.upstreamExhausted": "external",
  "bridge.modelFailed": "external",
  "bridge.sessionInvalid": "external",
  "bridge.sessionRetried": "external",
  "bridge.transientFailed": "external",
  "bridge.offline": "external",
  "bridge.crashedMidTurn": "external",
  "bridge.crashedAfterResume": "external",
  "bridge.crashedRuntimeAlive": "external",
  "bridge.crashedIrreversible": "external",
  "bridge.unsafe": "external",
  // Bridge 与 Server 对不上账、状态卡住：是我们协调逻辑的问题
  "bridge.reconnectedGone": "internal",
  "bridge.alreadyEnded": "internal",
  "bridge.cancelNotPersisted": "internal",
  "bridge.steerUnconfirmed": "internal",
  "bridge.steerCancelRace": "internal",
  "bridge.steerEndRace": "internal",
  "bridge.worktreeBusy": "internal",
  "bridge.worktreeCheckBeforeContinue": "internal",
  "invocation.stale": "internal",
  "invocation.unacknowledged": "internal",
  "invocation.stopUnconfirmed": "internal",
};

/** 不算故障：按设计就是这样（人停止、撤回、超出补拉范围等） */
const NOT_INCIDENTS = new Set([
  "bridge.beyondCatchUp",
  "bridge.cancelledBeforeRun",
  "bridge.stoppedWhileWaiting",
  "bridge.crashResumeStopped",
  "bridge.queuedRemoved",
  "bridge.worktreeCleaned",
  "invocation.recalledStopUnconfirmed",
  "invocation.recalledStopped",
  // Server 主动停止、重启、删除本机 Agent 或自己停下时结束了 Agent 进程：人或流程有意为之，原因写明、可重试
  "invocation.interruptedAgentStopped",
  "invocation.interruptedAgentRestarted",
  "invocation.interruptedAgentRemoved",
  "invocation.interruptedServerStopped",
]);

export function invocationOrigin(key: string | undefined): IncidentOrigin | undefined {
  if (key && NOT_INCIDENTS.has(key)) return undefined;
  return (key && INVOCATION_ORIGINS[key]) || "unknown";
}

/**
 * Bridge 报了失败原因（见 protocol 的 failureKindSchema）时按原因归属：模型服务、网络、额度、凭证这些
 * 我们改代码修不好；请求被拒（400 说不出原因）可能是运行时或我们拼的请求有问题，记下来给人看，不自动派修。
 */
function failureOrigin(failure: FailureKind): IncidentOrigin | undefined {
  if (failure === "unknown") return undefined;
  return failure === "invalid_request" ? "unknown" : "external";
}

/** 结果未知、已停下这两个键原因五花八门，只有原因是 Bridge 没能向 Server 核对任务目录时才能认定是我们的问题 */
const WORKSPACE_CHECK_KEYS = new Set(["bridge.uncertain", "bridge.unsafe"]);

/** Bridge 核对任务目录失败时写进原因的固定文案（task-workspace.ts、bridge.ts） */
const WORKSPACE_CHECK_FAILURE =
  /没能复核任务目录|Cannot verify managed task workspace|Cannot safely select the task workspace|Online local agent required/;

function workspaceCheckFailed(invocation: Invocation, detail: string | undefined): boolean {
  const key = invocation.detailText?.key;
  if (!key || !WORKSPACE_CHECK_KEYS.has(key)) return false;
  const reason = invocation.detailText?.params?.reason;
  return WORKSPACE_CHECK_FAILURE.test(typeof reason === "string" ? reason : (detail ?? ""));
}

/**
 * 一轮失败或结果未知 → 一次出现；不是失败、或按设计如此的返回 undefined。
 * 指纹按说明键 + 失败原因 + 运行时：同一种卡住在 Claude 和 Codex 上往往是两处代码；
 * 同是上游出错，限流和额度用完也分开记，不混成一张。
 */
export function classifyInvocation(
  invocation: Invocation,
  context: { provider?: string | undefined; codeVersion?: string | undefined },
): IncidentOccurrence | undefined {
  if (invocation.status !== "failed" && invocation.status !== "timed_out") return undefined;
  // 人收起、被取代的不算；撤回并停止的也不算
  if (invocation.resolution) return undefined;
  const key = invocation.detailText?.key;
  let origin = invocationOrigin(key);
  if (!origin) return undefined;
  origin = (invocation.failure && failureOrigin(invocation.failure)) || origin;
  const detail = invocation.detailText
    ? zhText(invocation.detailText as ServerText)
    : invocation.detail;
  // 任务目录没核对上（含 Server 重启、Bridge 还没重连时的 401）：单独一张、算我们的问题，
  // 不和模型断流、CLI 崩溃这类同键的外部原因混在一起
  const workspaceCheck = workspaceCheckFailed(invocation, detail);
  if (workspaceCheck) origin = "internal";
  const provider = context.provider ?? "agent";
  return {
    origin,
    source: "invocation",
    fingerprint: `invocation:${key ?? `status:${invocation.status}`}${workspaceCheck ? ":workspace-check" : ""}${invocation.failure ? `:${invocation.failure}` : ""}:${provider}`,
    title: `${provider} · ${oneLine(firstClause(normalizeMessage(detail ?? invocation.status)), 160)}${invocation.failure ? `（${invocation.failure}）` : ""}`,
    ref: `invocation:${invocation.id}:${invocation.attempts}:${invocation.status}:${key ?? ""}`,
    sample: compact({
      at: invocation.finishedAt ?? invocation.updatedAt,
      roomId: invocation.roomId,
      invocationId: invocation.id,
      messageId: invocation.messageId,
      agentName: invocation.agentName,
      provider: context.provider,
      detail: detail ? redact(detail).slice(0, 1000) : undefined,
      detailText: invocation.detailText
        ? redactText(invocation.detailText as WireServerText)
        : undefined,
      codeVersion: context.codeVersion,
    }),
  };
}

/** Server 自己抛的异常（HTTP 5xx、WebSocket 事件处理出错、未捕获的拒绝） */
export function classifyServerError(
  error: unknown,
  context: { route?: string; roomId?: string; codeVersion?: string | undefined },
): IncidentOccurrence {
  const { name, message, stack } = errorParts(error);
  const frames = stackFrames(stack);
  return {
    origin: "internal",
    source: "server",
    fingerprint: `server:${name}:${frames.slice(0, 3).join("|") || normalizeMessage(message)}`,
    title: oneLine(`${name}: ${normalizeMessage(message)}`, 200),
    sample: compact({
      at: new Date().toISOString(),
      route: context.route,
      roomId: context.roomId,
      detail: redact(message).slice(0, 1000),
      stack: stack ? redact(stack).split("\n").slice(0, 12).join("\n").slice(0, 4000) : undefined,
      codeVersion: context.codeVersion,
    }),
  };
}

/**
 * Agent 发来的事件没通过协议校验：通常是 Bridge 和 Server 版本对不上，或某一边改了格式。
 * 只按事件类型和出错字段归类，不记事件内容。
 */
export function classifyProtocolError(
  eventType: string | undefined,
  issues: ReadonlyArray<{ code: string; path: ReadonlyArray<string | number> }>,
  context: {
    roomId?: string | undefined;
    agentName?: string | undefined;
    provider?: string | undefined;
    codeVersion?: string | undefined;
  },
): IncidentOccurrence {
  const fields = [
    ...new Set(
      issues.map(
        (issue) =>
          `${issue.path.map((part) => (typeof part === "number" ? "[]" : part)).join(".")}:${issue.code}`,
      ),
    ),
  ]
    .sort()
    .slice(0, 5);
  const type = eventType?.slice(0, 60) ?? "?";
  return {
    origin: "internal",
    source: "protocol",
    fingerprint: `protocol:${type}:${fields.join(",")}`,
    title: oneLine(`${type} · ${fields.join(", ") || "invalid"}`, 200),
    sample: compact({
      at: new Date().toISOString(),
      route: type,
      roomId: context.roomId,
      agentName: context.agentName,
      provider: context.provider,
      detail: fields.join(", "),
      codeVersion: context.codeVersion,
    }),
  };
}

/**
 * 网页上报的报错：打包后的文件名带内容哈希，去掉后同一处代码在不同版本里指纹不变。
 * Vite 开发服务器热更新、依赖重新预构建造成的报错（见 isViteDevNoise）刷新即好，不算故障，返回 undefined
 */
export function classifyClientError(
  report: ClientErrorReport,
  context: { roomId?: string | undefined; codeVersion?: string | undefined },
): IncidentOccurrence | undefined {
  if (isViteDevNoise(report.stack)) return undefined;
  const name =
    report.name?.trim() || (report.kind === "unhandledrejection" ? "Rejection" : "Error");
  const message = normalizeMessage(report.message);
  const frames = stackFrames(report.stack);
  return {
    origin: "internal",
    source: "web",
    fingerprint: `web:${report.kind}:${name}:${frames[0] ?? message}`,
    title: oneLine(`${name}: ${message}`, 200),
    sample: compact({
      at: new Date().toISOString(),
      roomId: context.roomId,
      detail: redact(report.message).slice(0, 1000),
      stack: report.stack
        ? redact(report.stack).split("\n").slice(0, 12).join("\n").slice(0, 4000)
        : undefined,
      url: report.url ? pageUrl(report.url) : undefined,
      userAgent: report.userAgent?.slice(0, 300),
      codeVersion: context.codeVersion,
    }),
  };
}

function errorParts(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      name: error.name || "Error",
      message: error.message || String(error),
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return { name: "NonError", message: String(error) };
}

/**
 * 调用栈的前几帧，去掉行列号、node_modules 和 Node 内部帧，路径只留仓库内的相对部分：
 * 同一处代码改了几行、或换了台电脑跑，指纹不变。
 */
export function stackFrames(stack: string | undefined): string[] {
  if (!stack) return [];
  const frames: string[] = [];
  for (const raw of stack.split("\n").slice(1)) {
    const line = raw.trim();
    // V8：at fn (file:line:col) 或 at file:line:col；Firefox/Safari：fn@file:line:col
    const v8 = /^at (?:async )?(?:(.+?) \()?(.+?)(?::\d+)?(?::\d+)?\)?$/.exec(line);
    const gecko = /^(.*?)@(.+?)(?::\d+)?(?::\d+)?$/.exec(line);
    const match = v8 ?? gecko;
    if (!match) continue;
    const fn = (match[1] ?? "").trim() || "<anonymous>";
    const file = match[2] ?? "";
    if (/node_modules|^node:|^internal\/|^native$|<anonymous>$/.test(file)) continue;
    frames.push(`${fn}@${sourceFile(file)}`);
    if (frames.length >= 5) break;
  }
  return frames;
}

/** 文件路径只留仓库内的部分（apps/…、packages/…），打包文件去掉内容哈希和查询串 */
function sourceFile(file: string): string {
  const clean = file.replace(/^file:\/\//, "").replace(/[?#].*$/, "");
  const inRepo = /(?:^|[\\/])((?:apps|packages)[\\/].+)$/.exec(clean);
  const base = inRepo ? inRepo[1]!.replaceAll("\\", "/") : path.posix.basename(clean);
  return base.replace(/-[A-Za-z0-9_]{6,}(\.m?js)$/, "$1");
}

/** 报错里会变的部分换成占位：同一种错误不会因为 ID、数字、路径不同被拆成很多条 */
export function normalizeMessage(message: string): string {
  return redact(message)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replace(/\b[0-9a-f]{12,}\b/gi, "<hex>")
    .replace(/(?:~|\/[\w.-]+)(?:\/[\w.@+-]+){1,}/g, "<path>")
    .replace(/[A-Za-z]:\\[^\s"'`]+/g, "<path>")
    .replace(/\d+(?:\.\d+)?/g, "<n>")
    .trim();
}

/** 这台 Server 自己的令牌（入房令牌、房主令牌）：按原值精确替换 */
const knownSecrets = new Set<string>();

/** 登记一个要从故障单里抹掉的原值（太短的不登记，免得误伤普通文字） */
export function registerIncidentSecret(value: string | undefined): void {
  if (value && value.length >= 8) knownSecrets.add(value);
}

const SECRET = "<secret>";
/** 按顺序替换：先认出认证头和已知格式的密钥，再按键名兜底 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // Authorization: Bearer xxx / Basic xxx
  [/\b(Bearer|Basic)\s+(?!<secret>)[A-Za-z0-9._~+/=-]{6,}/gi, `$1 ${SECRET}`],
  // 常见的 API key 前缀
  [
    /\b(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[abposr]-[A-Za-z0-9-]{8,})/g,
    SECRET,
  ],
  // JWT
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, SECRET],
  // URL 里的用户名密码
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, `$1${SECRET}@`],
  // 查询参数：token、key、secret、password、auth、signature……
  [
    /([?&#;][\w.-]*?(?:token|key|secret|password|passwd|auth|signature|sig)[\w.-]*=)[^&#\s"'`]+/gi,
    `$1${SECRET}`,
  ],
  // 键值写法："token": "…"、x-hive-owner: …、password=…
  [
    /((?:["']?)[\w-]*(?:token|secret|password|passwd|api[_-]?key|apikey|authorization|x-hive-owner|cookie)[\w-]*["']?\s*[:=]\s*["']?)(?!<secret>)[^\s"',;}&]+/gi,
    `$1${SECRET}`,
  ],
];

/**
 * 去掉本机用户目录和凭证：现场会存进故障单、贴进派修消息（房间里可能有访客、连着 IM），
 * 不能把令牌、密钥带出去。
 */
export function redact(text: string): string {
  let result = text;
  for (const secret of knownSecrets) result = result.replaceAll(secret, SECRET);
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  const home = homedir();
  return home && home.length > 1 ? result.replaceAll(home, "~") : result;
}

/** 结构化说明里的参数也可能带原始报错：逐个字符串脱敏 */
function redactText(text: WireServerText): WireServerText {
  if (!text.params) return text;
  return {
    key: text.key,
    params: Object.fromEntries(
      Object.entries(text.params).map(([name, value]) => [
        name,
        typeof value === "string"
          ? redact(value)
          : typeof value === "number"
            ? value
            : redactText(value),
      ]),
    ),
  };
}

function pageUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`.slice(0, 500);
  } catch {
    return url.replace(/[?#].*$/, "").slice(0, 500);
  }
}

/** 调用说明往往是一整段（原因 + 怎么处理）：标题只取第一句 */
function firstClause(text: string): string {
  const clause = text.split(/[。；：:;]/)[0]?.trim();
  return clause || text;
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && item !== ""),
  ) as T;
}
