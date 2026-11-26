import type { AgentUsage, RuntimeEvent, TraceStep } from "./hive-protocol.js";
import {
  classifyText,
  isUpstreamKind,
  type FailureKind,
  type UpstreamFailureKind,
} from "./failure.js";

export type AgentProvider =
  "codex" | "claude" | "copilot" | "openclaw" | "opencode" | "omp" | "gemini" | "agy" | "echo";
export type AgentAccessMode = "read-only" | "workspace" | "full";

/** 执行中的权限申请：给人看的一行摘要和补充说明 */
export type ApprovalRequest = {
  /** 申请的工具或动作，例如 Bash、commandExecution、fileChange */
  tool: string;
  summary: string;
  detail?: string;
};

export type AgentReplyInput = {
  instructions: string;
  prompt: string;
  threadId?: string;
  /** 人在 Web UI 点击"停止"时触发；Responder 应尽快中断并以 AgentCancelledError 结束 */
  signal?: AbortSignal;
  /** 运行中的可读进度（正在执行的命令、调用的工具等），由 Bridge 节流后上报 */
  onProgress?: (progress: string) => void;
  /** Sanitized structured events; heartbeat is emitted separately by Bridge. */
  onRuntimeEvent?: (event: RuntimeEvent) => void;
  /**
   * 执行过程的一步（中途说的话、思考、工具调用），给房主实时看；同一个 id 再报即更新。
   * 可以带原始内容，Bridge 统一脱敏、截断、合批后上报。
   */
  onTrace?: (step: TraceStep) => void;
  /** 一拿到这一轮用的 Provider 会话 ID 就告诉 Bridge（不用等回合结束），人可以在终端里接着它 */
  onSession?: (sessionId: string) => void;
  /**
   * 运行时启动时告诉 Bridge Hive 工具（hive MCP）连上了没有。连不上时 Agent 少了全部 hive_* 工具
   * （读附件、白板、委派……），Bridge 据此在成员状态里标出来。看不到启动信息的运行时不调用。
   */
  onHiveTools?: (status: "connected" | "unavailable", detail?: string) => void;
  /**
   * 本轮结束时（成功、失败、停止都会）交出已观测到的用量，Bridge 据此在失败路径上也能记账。
   * 不支持用量的 Provider 不调用。
   */
  onUsage?: (usage: AgentUsage) => void;
  /**
   * Runtime 执行中要申请权限（跑命令、改工作区外的文件、MCP 确认）时调用：交给人批，
   * resolve(true) 才放行。人拒绝、超时、这一轮被停止都 resolve(false)。没有它就一律按拒绝处理。
   */
  requestApproval?: (request: ApprovalRequest) => Promise<boolean>;
  /**
   * 是否需要重新注入完整规则。只能把规则拼进用户消息的 Provider（Copilot、OpenClaw、ACP）
   * 据此避免每轮都把同一份长规则写进会话历史；新会话总是需要。
   */
  refreshInstructions?: boolean;
  /**
   * 这一轮用的模型（Agent 设置里的「模型」，或人点「换个模型重试」选的）。
   * 不给就用启动时的模型。各运行时能做到的程度不同：Codex、Claude Code、Copilot、OpenClaw 每轮生效，
   * opencode、omp、agy 通过 ACP 的 session/set_config_option、Gemini CLI 通过 session/set_model 切换当前会话的模型。
   */
  model?: string;
  /**
   * 这一轮的思考强度（Agent 设置里的「思考强度」，或「换个模型重试」时选的）。不给就不传，沿用 CLI 自己的配置。
   * Claude Code 每轮 --effort，Copilot 每轮 --reasoning-effort，Codex 用 turn/start 的 effort，
   * ACP 运行时（omp 等）切会话 configOptions 里 category 为 thought_level 的选项；其余运行时忽略。
   */
  effort?: string;
  /**
   * Claude Code 的自动压缩阈值（token 数）：经 --settings 的 autoCompactWindow 传入；不给就不传，由 Claude Code 自己定。
   * 其余运行时忽略。
   */
  compactWindow?: number;
  /** Claude Code 的缓存时长：经 --settings 的 promptCacheTtl 传入；不给就由 Claude Code 自动选。其余运行时忽略 */
  cacheTtl?: "5m" | "1h";
  /** 运行时这一轮自动压缩了上下文（Claude Code 的 compact_boundary） */
  onCompacted?: (compaction: {
    preTokens: number;
    postTokens?: number;
    durationMs?: number;
  }) => void;
  /** 运行时这一轮没法用指定的思考强度（当前模型不支持这一档）时调用，options 是它能用的档位 */
  onEffortIgnored?: (effort: string, options: string[]) => void;
};

export type AgentReply = {
  text: string;
  threadId?: string;
  /** 本轮 Runtime 返回的真实用量；不支持的 Provider 不填 */
  usage?: AgentUsage;
  /** Runtime 自报的会话累计费用（Claude Code 的 total_cost_usd）；Bridge 求差得到本轮费用 */
  sessionCostUsd?: number;
  /**
   * 这一轮里 Runtime 压缩过上下文（Claude Code 的 compact_boundary、Codex 的 contextCompaction）：
   * 之前发过的成员列表、白板快照可能只剩概括，Bridge 下一轮改发全量
   */
  compacted?: boolean;
};

export interface AgentResponder {
  reply(input: AgentReplyInput): Promise<AgentReply>;
  /**
   * 把新到达的消息注入正在运行的回合（Codex turn/steer）。
   * 返回 false 表示当前没有可注入的回合，调用方应改为排队。
   */
  steer?(prompt: string): Promise<boolean>;
  close?(): Promise<void>;
}

export class AgentCancelledError extends Error {
  constructor(message = "已按请求停止。") {
    super(message);
    this.name = "AgentCancelledError";
  }
}

/**
 * 失败分三类（网页按 Bridge 上报的文案键归类，见 @superhive/protocol 的 failureClass）：
 * - transient（AgentTransientError）：还没把执行请求发出去，暂时忙或连不上；Bridge 自动退避重试，用完次数才交给人
 * - uncertain（AgentExecutionUncertainError）：执行请求已发出、可能做过一部分；不自动重放，交人核对后「继续」
 * - unsafe（AgentNonRetryableError）：判定不能做或不能接着做；直接拒绝，写明原因
 */
export type FailureClass = "transient" | "uncertain" | "unsafe";

/** unsafe：已知不能做（身份不符、会话锁定、运行时不支持……），只报一次，不自动重跑 */
export class AgentNonRetryableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentNonRetryableError";
  }
}

/** transient：这一轮还没开始执行，等一会儿可能就好；抛出前必须确认没有发出过执行请求 */
export class AgentTransientError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentTransientError";
  }
}

/** 失败说明的开头：网页据此把「重试」按钮显示为「继续」（与 @superhive/protocol 保持一致） */
export const UPSTREAM_FAILURE_PREFIX = "上游模型服务出错";

/**
 * 上游模型服务出错导致这一轮中途结束：Runtime 进程已正常退出、原因明确，不会有残留的执行。
 * threadId 是这一轮所在的会话，接着它继续就能看到已经做过的步骤。
 * kind 是失败原因（见 failure.ts）：Bridge 按它决定自动重试哪几档、要人做什么；省略时按原文判断。
 */
export class AgentUpstreamError extends Error {
  readonly kind: UpstreamFailureKind;
  constructor(
    readonly reason: string,
    readonly threadId?: string,
    kind?: UpstreamFailureKind,
  ) {
    super(`${UPSTREAM_FAILURE_PREFIX}：${reason}`);
    this.name = "AgentUpstreamError";
    const guessed = classifyText(reason);
    this.kind = kind ?? (isUpstreamKind(guessed) ? guessed : "provider_error");
  }
}

/**
 * 会话本身坏了，续不下去：Codex 解不开旧会话里加密的推理内容（换过网关、key、组织后常见）、
 * 找不到之前的 response / thread、恢复会话的文件损坏。换个新会话就好，跟任务本身无关。
 * executed：这一轮在出错前是否已经开始执行工具（执行过就不能自动重跑，交给人决定）。
 */
export class AgentSessionInvalidError extends Error {
  constructor(
    readonly reason: string,
    readonly executed = false,
  ) {
    super(`会话已失效：${reason}`);
    this.name = "AgentSessionInvalidError";
  }
}

/**
 * 运行时把分好类的失败（见 failure.ts）转成 Bridge 认的错误：会话失效开新会话，上游出错按分类等待或交给人。
 * 说不清的返回 undefined，由运行时照原来的方式报（多半是结果未知）。executed：出错前是否已经执行过工具。
 */
export function classifiedFailure(
  kind: FailureKind,
  reason: string,
  threadId: string | undefined,
  executed: boolean,
): AgentUpstreamError | AgentSessionInvalidError | undefined {
  if (kind === "session_invalid") return new AgentSessionInvalidError(reason, executed);
  if (isUpstreamKind(kind)) return new AgentUpstreamError(reason, threadId, kind);
  return undefined;
}

/**
 * uncertain：执行请求已发出，结果不确定。settled 表示运行时已给出可信终态（回合报告失败、被中断），
 * 会话本身没坏，人点「继续」可以接着用；没有终态（连接断了、停止未确认）的要锁住会话等人核对。
 */
export class AgentExecutionUncertainError extends Error {
  readonly settled: boolean;
  constructor(message: string, options?: ErrorOptions & { settled?: boolean }) {
    super(message, options);
    this.name = "AgentExecutionUncertainError";
    this.settled = options?.settled ?? false;
  }
}

/** 这个错误属于哪一类；取消、上游出错、会话失效等另有专门处理的返回 undefined */
export function failureClassOf(error: unknown): FailureClass | undefined {
  if (error instanceof AgentTransientError) return "transient";
  if (error instanceof AgentExecutionUncertainError) return "uncertain";
  if (error instanceof AgentNonRetryableError) return "unsafe";
  return undefined;
}

export function isCancelled(error: unknown, signal?: AbortSignal): boolean {
  return error instanceof AgentCancelledError || Boolean(signal?.aborted);
}

/**
 * 测试用：HIVE_ECHO_DELAY_MS 让回显先等这么久，模拟一轮要跑一阵的任务（冒烟测试在这期间重启 Server）。
 * 等待中每秒报一次进度；人点停止时按停止结束。
 */
async function echoDelay(input: AgentReplyInput): Promise<void> {
  const total = Number.parseInt(process.env.HIVE_ECHO_DELAY_MS ?? "", 10);
  if (!Number.isInteger(total) || total <= 0) return;
  const started = Date.now();
  while (Date.now() - started < total) {
    if (input.signal?.aborted) throw new AgentCancelledError();
    input.onProgress?.(`echo 等待中 ${Math.round((Date.now() - started) / 1000)}s`);
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(1_000, total - (Date.now() - started))),
    );
  }
}

export class EchoResponder implements AgentResponder {
  constructor(private readonly agentName: string) {}

  async reply(input: AgentReplyInput): Promise<AgentReply> {
    await echoDelay(input);
    const block = input.prompt.match(/<trigger_message>\s*([\s\S]*?)\s*<\/trigger_message>/)?.[1];
    const triggers = [...(block ?? "").matchAll(/^#\d+ (?:id=\S+ )?\[[^\]]+\] (.*)$/gm)].map(
      (match) => match[1],
    );
    // 回显时去掉 @，避免测试 Agent 把原消息里的提及再转发一遍、触发其他 Agent
    const echoed = triggers.join(" / ").replace(/@(?=[\p{L}\p{N}_.-])/gu, "");
    return { text: `Echo from ${this.agentName}: ${echoed || "收到"}` };
  }
}
