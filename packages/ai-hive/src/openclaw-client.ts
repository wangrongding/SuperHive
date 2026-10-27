import { randomUUID } from "node:crypto";
import { defaultCommandRunner, type CommandRunner } from "./command-runner.js";
import {
  AgentCancelledError,
  type AgentReply,
  type AgentReplyInput,
  type AgentResponder,
} from "./responder.js";

type OpenClawPayload = { text?: string };
type OpenClawResult = {
  payloads?: OpenClawPayload[];
  result?: { payloads?: OpenClawPayload[] };
  meta?: { agentMeta?: { sessionId?: string } };
};

/** 新会话或需要刷新规则时才把规则拼进消息，避免每轮重复堆积在会话历史里 */
function withInstructions(input: AgentReplyInput): string {
  return !input.threadId || input.refreshInstructions
    ? `${input.instructions}\n\n---\n\n${input.prompt}`
    : input.prompt;
}

export class OpenClawResponder implements AgentResponder {
  constructor(
    private readonly options: {
      command: string;
      cwd: string;
      local: boolean;
      agentId?: string;
      model?: string;
      runner?: CommandRunner;
    },
  ) {}

  async reply(input: AgentReplyInput): Promise<AgentReply> {
    const sessionId = input.threadId ?? randomUUID();
    const args = [
      "agent",
      "--session-id",
      sessionId,
      "--message",
      withInstructions(input),
      "--json",
    ];
    if (this.options.local) args.push("--local");
    if (this.options.agentId) args.push("--agent", this.options.agentId);
    if (this.options.model) args.push("--model", this.options.model);

    let result;
    try {
      result = await (this.options.runner ?? defaultCommandRunner)(this.options.command, args, {
        cwd: this.options.cwd,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (error) {
      if (error instanceof AgentCancelledError) throw error;
      throw new Error(
        `OpenClaw 执行失败：${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    let payload: OpenClawResult;
    try {
      payload = JSON.parse(result.stdout.trim()) as OpenClawResult;
    } catch (error) {
      throw new Error(
        `OpenClaw 返回了无法解析的 JSON：${result.stdout.trim().slice(0, 300) || result.stderr.trim()}`,
        { cause: error },
      );
    }
    const payloads = payload.result?.payloads ?? payload.payloads ?? [];
    const text = payloads
      .map((item) => item.text?.trim())
      .filter((item): item is string => Boolean(item))
      .join("\n\n");
    if (!text) throw new Error("OpenClaw 没有返回可发送的文本。");
    return {
      text,
      threadId: payload.meta?.agentMeta?.sessionId ?? sessionId,
    };
  }
}
