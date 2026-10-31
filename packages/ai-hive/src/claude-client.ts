import type { CommandRunner } from "./command-runner.js";
import { streamCommandRunner } from "./stream-command-runner.js";
import { ClaudeStream } from "./claude-stream.js";
import { claudeHiveMcpConfig, type HiveMcpConnection } from "./hive-mcp-config.js";
import {
  AgentCancelledError,
  AgentExecutionUncertainError,
  type AgentAccessMode,
  type AgentReply,
  type AgentReplyInput,
  type AgentResponder,
} from "./responder.js";

export class ClaudeCodeResponder implements AgentResponder {
  constructor(
    private readonly options: {
      command: string;
      cwd: string;
      hive: HiveMcpConnection;
      access?: AgentAccessMode;
      model?: string;
      runner?: CommandRunner;
    },
  ) {}

  async reply(input: AgentReplyInput): Promise<AgentReply> {
    const access = this.options.access ?? "read-only";
    const hiveTools = [
      "hive_room_read",
      "hive_members_list",
      "hive_message_send",
      "hive_invoke",
      "hive_wait",
      "hive_ask_human",
      "hive_board_read",
      "hive_board_update",
      "hive_attachment_read",
    ]
      .map((tool) => `mcp__hive__${tool}`)
      .join(",");
    const args = [
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--input-format",
      "text",
      "--permission-mode",
      access === "read-only" ? "plan" : access === "workspace" ? "auto" : "bypassPermissions",
      "--append-system-prompt",
      input.instructions,
      "--mcp-config",
      claudeHiveMcpConfig(this.options.hive),
      "--allowedTools",
      access === "workspace" ? `Read,Glob,Grep,Edit,Write,Bash,${hiveTools}` : hiveTools,
    ];
    if (access === "workspace") {
      args.push(
        "--settings",
        JSON.stringify({
          sandbox: {
            enabled: true,
            failIfUnavailable: true,
            allowUnsandboxedCommands: false,
          },
        }),
      );
    }
    if (access === "full") {
      args.push(
        "--dangerously-skip-permissions",
        "--settings",
        JSON.stringify({ sandbox: { enabled: false } }),
      );
    }
    if (this.options.model) args.push("--model", this.options.model);
    if (input.threadId) args.push("--resume", input.threadId);

    const stream = new ClaudeStream((event) => input.onRuntimeEvent?.(event));
    input.onRuntimeEvent?.({ kind: "capabilities", observability: "partial" });
    input.onRuntimeEvent?.({ kind: "activity", phase: "starting" });
    let result;
    try {
      result = await (this.options.runner ?? streamCommandRunner)(this.options.command, args, {
        cwd: this.options.cwd,
        input: input.prompt,
        onStdout: (chunk) => stream.push(chunk),
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (error) {
      if (error instanceof AgentCancelledError) {
        throw new AgentExecutionUncertainError(
          "已请求终止 Claude 主进程，但工具子进程是否停止尚未确认。",
        );
      }
      // An interrupted/invalid stream may follow tool side effects. Never blindly replay it.
      throw new AgentExecutionUncertainError(
        "Claude Code 执行中断，结果未知；请先核对已执行操作。",
      );
    }
    // Injectable legacy runners can return a complete result rather than streaming it.
    if (result.stdout) stream.push(result.stdout);
    const payload = stream.finish();
    if (!payload)
      throw new AgentExecutionUncertainError(
        "Claude Code 返回了无法解析的最终结果，执行结果未知。",
      );
    if (payload.is_error || !payload.result?.trim()) {
      throw new AgentExecutionUncertainError("Claude Code 没有返回可发送的文本，执行结果未知。");
    }
    const usage = stream.usage();
    return {
      text: payload.result,
      ...(payload.session_id ? { threadId: payload.session_id } : {}),
      ...(usage ? { usage } : {}),
    };
  }
}
