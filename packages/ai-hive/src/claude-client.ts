import { defaultCommandRunner, type CommandRunner } from "./command-runner.js";
import { claudeHiveMcpConfig, type HiveMcpConnection } from "./hive-mcp-config.js";
import type { AgentReply, AgentReplyInput, AgentResponder } from "./responder.js";

type ClaudeJsonResult = {
  is_error?: boolean;
  result?: string;
  session_id?: string;
  subtype?: string;
};

export class ClaudeCodeResponder implements AgentResponder {
  constructor(
    private readonly options: {
      command: string;
      cwd: string;
      hive: HiveMcpConnection;
      model?: string;
      runner?: CommandRunner;
    },
  ) {}

  async reply(input: AgentReplyInput): Promise<AgentReply> {
    const args = [
      "--print",
      "--output-format",
      "json",
      "--input-format",
      "text",
      "--permission-mode",
      "plan",
      "--append-system-prompt",
      input.instructions,
      "--mcp-config",
      claudeHiveMcpConfig(this.options.hive),
      "--allowedTools",
      "mcp__hive__hive_room_read,mcp__hive__hive_members_list,mcp__hive__hive_message_send",
    ];
    if (this.options.model) args.push("--model", this.options.model);
    if (input.threadId) args.push("--resume", input.threadId);

    let result;
    try {
      result = await (this.options.runner ?? defaultCommandRunner)(this.options.command, args, {
        cwd: this.options.cwd,
        input: input.prompt,
      });
    } catch (error) {
      throw new Error(
        `Claude Code 执行失败：${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    let payload: ClaudeJsonResult;
    try {
      payload = JSON.parse(result.stdout.trim()) as ClaudeJsonResult;
    } catch (error) {
      throw new Error(
        `Claude Code 返回了无法解析的 JSON：${result.stdout.trim().slice(0, 300) || result.stderr.trim()}`,
        { cause: error },
      );
    }
    if (payload.is_error || !payload.result?.trim()) {
      throw new Error(`Claude Code 没有返回可发送的文本（${payload.subtype ?? "unknown"}）。`);
    }
    return {
      text: payload.result,
      ...(payload.session_id ? { threadId: payload.session_id } : {}),
    };
  }
}
