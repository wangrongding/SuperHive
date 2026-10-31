import type { CommandRunner } from "./command-runner.js";
import { streamCommandRunner } from "./stream-command-runner.js";
import { ClaudeStream } from "./claude-stream.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { claudeHiveMcpConfig, type HiveMcpConnection } from "./hive-mcp-config.js";
import { enabledClaudeMcpServers, readAgentSettings, type AgentSettings } from "./mcp-servers.js";
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
      /**
       * 本机 Hive Server 写入的 Agent 设置文件。给定时只加载勾选的 MCP（--strict-mcp-config），
       * 每一轮重新读取，改动下一轮生效；不给时沿用 Claude Code 自己的全部 MCP 配置。
       */
      settingsFile?: string;
      /** 测试注入：按 cwd 和设置列出要加载的 MCP（不含 hive） */
      mcpServers?: (
        cwd: string,
        settings: AgentSettings,
      ) => Record<string, Record<string, unknown>>;
    },
  ) {}

  /**
   * 写出本轮的 MCP 配置文件。用文件而不是命令行参数：本机 MCP 配置里常有密钥，
   * 命令行参数会被同机其他用户通过 ps 看到。
   */
  private writeMcpConfig(): { file: string; cleanup: () => void } {
    const settings = readAgentSettings(this.options.settingsFile);
    const servers = (this.options.mcpServers ?? enabledClaudeMcpServers)(
      this.options.cwd,
      settings,
    );
    const hive = (
      JSON.parse(claudeHiveMcpConfig(this.options.hive)) as {
        mcpServers: Record<string, unknown>;
      }
    ).mcpServers;
    const dir = mkdtempSync(path.join(tmpdir(), "hive-claude-mcp-"));
    const file = path.join(dir, "mcp.json");
    // 名称有序且内容不变时文件逐字节相同，工具定义的前缀缓存不会因此失效
    writeFileSync(file, JSON.stringify({ mcpServers: { ...servers, ...hive } }), { mode: 0o600 });
    return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

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
    const mcp = this.options.settingsFile !== undefined ? this.writeMcpConfig() : undefined;
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
      mcp ? mcp.file : claudeHiveMcpConfig(this.options.hive),
      ...(mcp ? ["--strict-mcp-config"] : []),
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
    } finally {
      mcp?.cleanup();
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
    const sessionCostUsd = stream.sessionCostUsd();
    return {
      text: payload.result,
      ...(payload.session_id ? { threadId: payload.session_id } : {}),
      ...(usage ? { usage } : {}),
      ...(sessionCostUsd !== undefined ? { sessionCostUsd } : {}),
    };
  }
}
