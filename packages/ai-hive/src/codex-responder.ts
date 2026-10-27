import { CodexAppServerResponder, isAppServerUnsupported } from "./codex-app-server-client.js";
import { CodexMcpResponder } from "./codex-client.js";
import type { HiveMcpConnection } from "./hive-mcp-config.js";
import type { AgentAccessMode, AgentReply, AgentReplyInput, AgentResponder } from "./responder.js";

export type CodexTransport = "auto" | "app-server" | "mcp";

/**
 * 默认使用 codex app-server（持久线程，支持 steer / interrupt / 进度）；
 * 本机 codex 过旧不支持 app-server 时自动回退到 codex mcp-server，并在本进程内不再尝试。
 */
export class CodexResponder implements AgentResponder {
  private current: AgentResponder;
  private fellBack = false;

  constructor(
    private readonly options: {
      command: string;
      cwd: string;
      hive: HiveMcpConnection;
      access?: AgentAccessMode;
      model?: string;
      transport?: CodexTransport;
      log?: (message: string) => void;
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
          }));
    if (options.transport === "mcp") this.fellBack = true;
  }

  private readonly createMcp: () => AgentResponder;

  async reply(input: AgentReplyInput): Promise<AgentReply> {
    try {
      return await this.current.reply(input);
    } catch (error) {
      if (
        this.fellBack ||
        this.options.transport === "app-server" ||
        !isAppServerUnsupported(error)
      ) {
        throw error;
      }
      (this.options.log ?? console.warn)(
        "[hive] 当前 Codex CLI 不支持 app-server，回退到 codex mcp-server（无法插入消息、停止和显示进度；建议升级 Codex CLI）。",
      );
      await this.current.close?.().catch(() => undefined);
      this.current = this.createMcp();
      this.fellBack = true;
      return this.current.reply(input);
    }
  }

  steer(prompt: string): Promise<boolean> {
    return this.current.steer ? this.current.steer(prompt) : Promise.resolve(false);
  }

  async close(): Promise<void> {
    await this.current.close?.();
  }
}
