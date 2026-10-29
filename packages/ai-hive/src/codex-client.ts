import { codexStartupFailure } from "./codex-errors.js";
import {
  AgentCancelledError,
  AgentExecutionUncertainError,
  AgentNonRetryableError,
} from "./responder.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { codexHiveMcpOverrides, type HiveMcpConnection } from "./hive-mcp-config.js";
import type { AgentAccessMode, AgentReply, AgentReplyInput, AgentResponder } from "./responder.js";

type ToolDescription = {
  name: string;
  inputSchema?: { properties?: Record<string, unknown> };
};

type ToolCaller = {
  callTool(request: { name: string; arguments?: Record<string, unknown> }): Promise<any>;
};

type CodexMcpResponderDependencies = {
  client?: ToolCaller;
  tools?: ToolDescription[];
  log?: (message: string) => void;
};

function codexAccess(access: AgentAccessMode = "read-only") {
  if (access === "workspace") {
    return { sandbox: "workspace-write", approvalPolicy: "never" } as const;
  }
  if (access === "full") {
    return { sandbox: "danger-full-access", approvalPolicy: "never" } as const;
  }
  return { sandbox: "read-only", approvalPolicy: "untrusted" } as const;
}

function textFromResult(result: any): string {
  const content = Array.isArray(result?.content) ? result.content : [];
  return content
    .filter((item: any) => item?.type === "text" && typeof item.text === "string")
    .map((item: any) => item.text)
    .join("\n")
    .trim();
}

function parseToolResult(result: any, previousThreadId?: string): AgentReply {
  const rawText = textFromResult(result);
  const structured = result?.structuredContent as Record<string, unknown> | undefined;
  let threadId =
    (typeof structured?.threadId === "string" ? structured.threadId : undefined) ??
    previousThreadId;
  let text =
    (typeof structured?.content === "string" ? structured.content : undefined) ??
    (typeof structured?.text === "string" ? structured.text : undefined) ??
    rawText;

  if (rawText.startsWith("{") || rawText.startsWith("[")) {
    try {
      const parsed = JSON.parse(rawText) as Record<string, unknown>;
      threadId = (typeof parsed.threadId === "string" ? parsed.threadId : undefined) ?? threadId;
      text =
        (typeof parsed.content === "string" ? parsed.content : undefined) ??
        (typeof parsed.text === "string" ? parsed.text : undefined) ??
        text;
    } catch {
      // Some Codex versions return plain text; keep it unchanged.
    }
  }
  const threadMatch = rawText.match(/thread(?:Id|_id)["':\s]+([0-9a-z-]{10,})/i);
  threadId ??= threadMatch?.[1];
  if (!text) throw new Error("Codex 没有返回可发送的文本。");
  return { text, ...(threadId ? { threadId } : {}) };
}

export function isMissingCodexThread(error: unknown): boolean {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    messages.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return /session not found for (?:thread|conversation)[_ ]?id|thread not found|no rollout found for thread/i.test(
    messages.join("\n"),
  );
}

export class CodexMcpResponder implements AgentResponder {
  private client: ToolCaller | undefined;
  private executionUncertain = false;
  private transport: StdioClientTransport | undefined;
  private tools: Map<string, ToolDescription>;
  private readonly log: (message: string) => void;

  constructor(
    private readonly options: {
      command: string;
      cwd: string;
      hive: HiveMcpConnection;
      access?: AgentAccessMode;
    },
    dependencies: CodexMcpResponderDependencies = {},
  ) {
    this.client = dependencies.client;
    this.tools = new Map((dependencies.tools ?? []).map((tool) => [tool.name, tool]));
    this.log = dependencies.log ?? console.warn;
  }

  async reply(input: AgentReplyInput): Promise<AgentReply> {
    if (input.signal?.aborted) throw new AgentCancelledError();
    if (this.executionUncertain)
      throw new AgentNonRetryableError(
        "上次 Codex MCP 执行结果未知，会话已锁定；请先核对执行状态。",
      );
    await this.ensureConnected();
    if (input.signal?.aborted) throw new AgentCancelledError();
    const client = this.client!;
    if (input.threadId) {
      try {
        const result = await this.callTool(
          client,
          {
            name: "codex-reply",
            arguments: { threadId: input.threadId, prompt: input.prompt },
          },
          input.signal,
        );
        if (result?.isError) {
          throw new Error(textFromResult(result) || "Codex 无法继续现有会话。");
        }
        return parseToolResult(result, input.threadId);
      } catch (error) {
        if (!isMissingCodexThread(error)) throw this.uncertain();
        this.log(`[hive] Codex 旧会话 ${input.threadId} 已失效，自动创建新会话继续处理。`);
      }
    }

    try {
      return await this.startThread(client, input);
    } catch (error) {
      if (error instanceof AgentNonRetryableError) throw error;
      throw this.uncertain();
    }
  }

  private callTool(
    client: ToolCaller,
    request: { name: string; arguments?: Record<string, unknown> },
    signal?: AbortSignal,
  ): Promise<any> {
    if (signal?.aborted) return Promise.reject(new AgentCancelledError());
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(this.uncertain());
      signal?.addEventListener("abort", onAbort, { once: true });
      // A legacy tool call cannot prove cancellation; stop waiting, never claim it stopped.
      Promise.resolve()
        .then(() => {
          if (signal?.aborted) throw this.uncertain();
          return client.callTool(request);
        })
        .then(resolve, reject)
        .finally(() => signal?.removeEventListener("abort", onAbort));
    });
  }

  private uncertain(): AgentExecutionUncertainError {
    this.executionUncertain = true;
    return new AgentExecutionUncertainError(
      "Codex MCP 执行请求已发送但结果不可确认；禁止自动重放。",
    );
  }

  private async startThread(client: ToolCaller, input: AgentReplyInput): Promise<AgentReply> {
    const tool = this.tools.get("codex");
    if (!tool)
      throw new AgentNonRetryableError(
        "当前 codex mcp-server 没有暴露 codex 工具；未发送执行请求。",
      );
    const properties = tool.inputSchema?.properties ?? {};
    const access = codexAccess(this.options.access);
    const arguments_: Record<string, unknown> = { prompt: input.prompt };
    if ("cwd" in properties) arguments_.cwd = this.options.cwd;
    if ("sandbox" in properties) arguments_.sandbox = access.sandbox;
    if ("approval-policy" in properties) {
      arguments_["approval-policy"] = access.approvalPolicy;
    }
    if ("developer-instructions" in properties) {
      arguments_["developer-instructions"] = input.instructions;
    } else if ("base-instructions" in properties) {
      arguments_["base-instructions"] = input.instructions;
    } else {
      arguments_.prompt = `${input.instructions}\n\n---\n\n${input.prompt}`;
    }
    const result = await this.callTool(
      client,
      { name: "codex", arguments: arguments_ },
      input.signal,
    );
    if (result?.isError) throw this.uncertain();
    return parseToolResult(result);
  }

  async close(): Promise<void> {
    await this.transport?.close();
    this.client = undefined;
    this.transport = undefined;
  }

  private async ensureConnected(): Promise<void> {
    if (this.client) return;
    const access = codexAccess(this.options.access);
    const transport = new StdioClientTransport({
      command: this.options.command,
      args: [
        "mcp-server",
        "-c",
        `sandbox_mode="${access.sandbox}"`,
        "-c",
        `approval_policy="${access.approvalPolicy}"`,
        ...codexHiveMcpOverrides(this.options.hive).flatMap((override) => ["-c", override]),
      ],
      stderr: "pipe",
    });
    const client = new Client({ name: "ai-hive-agent", version: "0.1.1" });
    let stderr = "";
    try {
      const connecting = client.connect(transport);
      transport.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-4000);
      });
      await connecting;
      const listed = await client.listTools();
      this.tools = new Map(
        listed.tools.map((tool) => [tool.name, tool as unknown as ToolDescription]),
      );
      if (!this.tools.has("codex") || !this.tools.has("codex-reply")) {
        throw new Error(
          `Codex MCP 工具不兼容；实际工具为：${listed.tools.map((tool) => tool.name).join(", ")}`,
        );
      }
      this.transport = transport;
      this.client = client as unknown as ToolCaller;
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw codexStartupFailure("mcp-server initialize/tools/list", error, stderr);
    }
  }
}
