import { randomUUID } from "node:crypto";
import { defaultCommandRunner, type CommandRunner } from "./command-runner.js";
import { copilotHiveMcpConfig, type HiveMcpConnection } from "./hive-mcp-config.js";
import type { AgentAccessMode, AgentReply, AgentReplyInput, AgentResponder } from "./responder.js";

type CopilotEvent = {
  type?: string;
  data?: {
    sessionId?: string;
    content?: string;
  };
};

function parseJsonLines(output: string): CopilotEvent[] {
  const events: CopilotEvent[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as CopilotEvent);
    } catch {
      // JSON mode can still include a diagnostic line; ignore it.
    }
  }
  return events;
}

export class CopilotResponder implements AgentResponder {
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
    const sessionId = input.threadId ?? randomUUID();
    const access = this.options.access ?? "read-only";
    const args = [
      "--prompt",
      `${input.instructions}\n\n---\n\n${input.prompt}`,
      "--output-format",
      "json",
      "--stream",
      "off",
      "--mode",
      access === "read-only" ? "plan" : "interactive",
      "--additional-mcp-config",
      copilotHiveMcpConfig(this.options.hive),
      "--allow-tool=hive",
      "--no-custom-instructions",
      "--no-ask-user",
      // --resume 只能恢复已存在的 session；首次会话需用 --session-id 创建新 session。
      input.threadId ? `--resume=${sessionId}` : `--session-id=${sessionId}`,
    ];
    if (access === "read-only") {
      args.push(
        "--disable-builtin-mcps",
        "--deny-tool=write",
        "--deny-tool=shell",
        "--no-remote",
        "--disallow-temp-dir",
      );
    } else if (access === "workspace") {
      args.push(
        "--disable-builtin-mcps",
        "--allow-tool=write",
        "--allow-tool=shell",
        "--no-remote",
        "--disallow-temp-dir",
      );
    } else {
      args.push("--allow-all");
    }
    if (this.options.model) args.push("--model", this.options.model);

    let result;
    try {
      result = await (this.options.runner ?? defaultCommandRunner)(this.options.command, args, {
        cwd: this.options.cwd,
      });
    } catch (error) {
      throw new Error(
        `GitHub Copilot 执行失败：${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    const events = parseJsonLines(result.stdout);
    const text = events
      .filter((event) => event.type === "assistant.message" && event.data?.content?.trim())
      .at(-1)?.data?.content;
    const reportedSessionId = events.find((event) => event.type === "session.start")?.data
      ?.sessionId;
    if (!text?.trim()) {
      throw new Error(
        `GitHub Copilot 没有返回可发送的文本：${result.stderr.trim() || result.stdout.trim().slice(-300)}`,
      );
    }
    return { text, threadId: reportedSessionId ?? sessionId };
  }
}
