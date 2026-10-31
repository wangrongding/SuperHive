import { CodexAppServerResponder } from "./codex-app-server-client.js";
import { CodexMcpResponder } from "./codex-client.js";
import type { HiveMcpConnection } from "./hive-mcp-config.js";
import type { AgentAccessMode, AgentReply, AgentReplyInput, AgentResponder } from "./responder.js";

export type CodexTransport = "auto" | "app-server" | "mcp";

/**
 * 默认使用 codex app-server（持久线程，支持 steer / interrupt / 进度）；
 * auto 是 app-server 的兼容别名；旧 MCP 只允许显式选择，不能因超时静默降级。
 */
export class CodexResponder implements AgentResponder {
  private current: AgentResponder;

  constructor(
    private readonly options: {
      command: string;
      cwd: string;
      hive: HiveMcpConnection;
      access?: AgentAccessMode;
      model?: string;
      transport?: CodexTransport;
      log?: (message: string) => void;
      settingsFile?: string;
    },
    dependencies: { appServer?: AgentResponder; mcp?: () => AgentResponder } = {},
  ) {
    this.createMcp =
      dependencies.mcp ??
      (() =>
        new CodexMcpResponder({
          command: options.command,
          cwd: options.cwd,
          hive: options.hive,
          ...(options.access ? { access: options.access } : {}),
        }));
    this.current =
      options.transport === "mcp"
        ? this.createMcp()
        : (dependencies.appServer ??
          new CodexAppServerResponder({
            command: options.command,
            cwd: options.cwd,
            hive: options.hive,
            ...(options.access ? { access: options.access } : {}),
            ...(options.model ? { model: options.model } : {}),
            ...(options.log ? { log: options.log } : {}),
            ...(options.settingsFile ? { settingsFile: options.settingsFile } : {}),
          }));
  }

  private readonly createMcp: () => AgentResponder;

  async reply(input: AgentReplyInput): Promise<AgentReply> {
    return this.current.reply(input);
  }

  steer(prompt: string): Promise<boolean> {
    return this.current.steer ? this.current.steer(prompt) : Promise.resolve(false);
  }

  async close(): Promise<void> {
    await this.current.close?.();
  }
}
