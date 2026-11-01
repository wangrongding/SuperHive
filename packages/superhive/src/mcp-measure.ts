import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { DiscoveredMcpServer } from "./mcp-servers.js";

export type McpMeasurement =
  { ok: true; tools: number; tokens: number } | { ok: false; error: string };

/**
 * 工具定义按 JSON 字符数折算 token，系数用实测标定：在 Claude Code 里单独打开某个 MCP，
 * rea（207 个工具、79 万字符）让开局多 35.2 万 token，chrome-devtools（32 个、2.7 万字符）多 1.1 万。
 * 只用于让人判断大小，不作计费依据。
 */
export const CHARS_PER_TOKEN = 2.3;
export const TOKENS_PER_TOOL = 20;

/** 与 Claude Code 一致地展开 ${VAR} 和 ${VAR:-默认值} */
function expand(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === "string") {
    return value.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
      (_, name: string, fallback?: string) => env[name] ?? fallback ?? "",
    );
  }
  if (Array.isArray(value)) return value.map((item) => expand(item, env));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item, env)]));
  }
  return value;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

/** 连上 MCP Server 读一遍工具列表，按工具定义的大小估算它在每个会话开局占多少 token */
export async function measureMcpServer(
  server: DiscoveredMcpServer,
  timeoutMs = 20_000,
): Promise<McpMeasurement> {
  const config = expand(server.config, process.env) as Record<string, unknown>;
  const client = new Client({ name: "superhive-mcp-measure", version: "0.1.0" });
  let transport: Transport;
  if (server.transport === "stdio") {
    if (typeof config.command !== "string") return { ok: false, error: "缺少 command" };
    transport = new StdioClientTransport({
      command: config.command,
      args: Array.isArray(config.args) ? config.args.map(String) : [],
      env: { ...stringRecord(process.env), ...stringRecord(config.env) },
      stderr: "ignore",
      ...(typeof config.cwd === "string" ? { cwd: config.cwd } : {}),
    });
  } else {
    if (typeof config.url !== "string") return { ok: false, error: "缺少 url" };
    const requestInit = { headers: stringRecord(config.headers) };
    transport =
      server.transport === "sse"
        ? new SSEClientTransport(new URL(config.url), { requestInit })
        : (new StreamableHTTPClientTransport(new URL(config.url), {
            requestInit,
          }) as Transport);
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${Math.round(timeoutMs / 1000)} 秒内没有响应`)),
      timeoutMs,
    );
  });
  try {
    const work = (async () => {
      await client.connect(transport);
      let chars = 0;
      let tools = 0;
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : {});
        for (const tool of page.tools) {
          tools++;
          chars += JSON.stringify({
            name: tool.name,
            description: tool.description ?? "",
            input_schema: tool.inputSchema,
          }).length;
        }
        cursor = page.nextCursor;
      } while (cursor);
      const tokens = Math.round(chars / CHARS_PER_TOKEN + tools * TOKENS_PER_TOOL);
      return { ok: true as const, tools, tokens };
    })();
    return await Promise.race([work, timeout]);
  } catch (error) {
    // 需要登录的远程 MCP 在这里读不到工具：如实报告，不猜大小
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => undefined);
  }
}
