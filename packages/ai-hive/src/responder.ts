import type { AgentUsage, RuntimeEvent } from "./hive-protocol.js";

export type AgentProvider =
  "codex" | "claude" | "copilot" | "openclaw" | "opencode" | "omp" | "echo";
export type AgentAccessMode = "read-only" | "workspace" | "full";

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
   * 是否需要重新注入完整规则。只能把规则拼进用户消息的 Provider（Copilot、OpenClaw、ACP）
   * 据此避免每轮都把同一份长规则写进会话历史；新会话总是需要。
   */
  refreshInstructions?: boolean;
};

export type AgentReply = {
  text: string;
  threadId?: string;
  /** 本轮 Runtime 返回的真实用量；不支持的 Provider 不填 */
  usage?: AgentUsage;
  /** Runtime 自报的会话累计费用（Claude Code 的 total_cost_usd）；Bridge 求差得到本轮费用 */
  sessionCostUsd?: number;
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

/** Known failure that must be surfaced once, not automatically re-executed. */
export class AgentNonRetryableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentNonRetryableError";
  }
}

export class AgentExecutionUncertainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentExecutionUncertainError";
  }
}

export function isCancelled(error: unknown, signal?: AbortSignal): boolean {
  return error instanceof AgentCancelledError || Boolean(signal?.aborted);
}

export class EchoResponder implements AgentResponder {
  constructor(private readonly agentName: string) {}

  async reply(input: AgentReplyInput): Promise<AgentReply> {
    const block = input.prompt.match(/<trigger_message>\s*([\s\S]*?)\s*<\/trigger_message>/)?.[1];
    const triggers = [...(block ?? "").matchAll(/^#\d+ (?:id=\S+ )?\[[^\]]+\] (.*)$/gm)].map(
      (match) => match[1],
    );
    // 回显时去掉 @，避免测试 Agent 把原消息里的提及再转发一遍、触发其他 Agent
    const echoed = triggers.join(" / ").replace(/@(?=[\p{L}\p{N}_.-])/gu, "");
    return { text: `Echo from ${this.agentName}: ${echoed || "收到"}` };
  }
}
