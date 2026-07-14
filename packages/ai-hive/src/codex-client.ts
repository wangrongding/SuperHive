import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { codexHiveMcpOverrides, type HiveMcpConnection } from "./hive-mcp-config.js";
import type { AgentReply, AgentReplyInput, AgentResponder } from "./responder.js";

type ToolDescription = {
  name: string;
  inputSchema?: { properties?: Record<string, unknown> };
};

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

export class CodexMcpResponder implements AgentResponder {
  private client: Client | undefined;
  private transport: StdioClientTransport | undefined;
  private tools = new Map<string, ToolDescription>();

  constructor(
    private readonly options: { command: string; cwd: string; hive: HiveMcpConnection },
  ) {}

  async reply(input: AgentReplyInput): Promise<AgentReply> {
    await this.ensureConnected();
    const client = this.client!;
    if (input.threadId) {
      const result = await client.callTool({
        name: "codex-reply",
        arguments: { threadId: input.threadId, prompt: input.prompt },
      });
      return parseToolResult(result, input.threadId);
    }

    const tool = this.tools.get("codex");
    if (!tool) throw new Error("当前 codex mcp-server 没有暴露 codex 工具。");
    const properties = tool.inputSchema?.properties ?? {};
    const arguments_: Record<string, unknown> = { prompt: input.prompt };
    if ("cwd" in properties) arguments_.cwd = this.options.cwd;
    if ("sandbox" in properties) arguments_.sandbox = "read-only";
    if ("approval-policy" in properties) arguments_["approval-policy"] = "untrusted";
    if ("developer-instructions" in properties) {
      arguments_["developer-instructions"] = input.instructions;
    } else if ("base-instructions" in properties) {
      arguments_["base-instructions"] = input.instructions;
    } else {
      arguments_.prompt = `${input.instructions}\n\n---\n\n${input.prompt}`;
    }
    const result = await client.callTool({ name: "codex", arguments: arguments_ });
    return parseToolResult(result);
  }

  async close(): Promise<void> {
    await this.transport?.close();
    this.client = undefined;
    this.transport = undefined;
  }

  private async ensureConnected(): Promise<void> {
    if (this.client) return;
    const transport = new StdioClientTransport({
      command: this.options.command,
      args: [
        "mcp-server",
        "-c",
        'sandbox_mode="read-only"',
        "-c",
        'approval_policy="untrusted"',
        ...codexHiveMcpOverrides(this.options.hive).flatMap((override) => ["-c", override]),
      ],
      stderr: "inherit",
    });
    const client = new Client({ name: "ai-hive-agent", version: "0.1.0" });
    try {
      await client.connect(transport);
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
      this.client = client;
    } catch (error) {
      await transport.close().catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          `找不到 Codex 命令 “${this.options.command}”。请先安装 Codex CLI 并完成登录。`,
        );
      }
      throw error;
    }
  }
}
