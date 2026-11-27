import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport, SseError } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { DiscoveredMcpServer } from "./mcp-servers.js";

/** auth：需要登录；unreachable：连不上；failed：起不来（见 protocol 的 mcpProblemSchema） */
export type McpProblem = "auth" | "unreachable" | "failed";

export type McpMeasurement =
  { ok: true; tools: number; tokens: number } | { ok: false; error: string; problem?: McpProblem };

/** 网络错误码换成一句人话；认不出的照原样带上错误码 */
const NETWORK_REASONS: Record<string, string> = {
  ECONNREFUSED: "连接被拒绝，服务可能没开",
  ENOTFOUND: "找不到这个地址",
  EAI_AGAIN: "域名解析失败，检查网络",
  ECONNRESET: "连接被对方断开",
  ETIMEDOUT: "连接超时",
  EHOSTUNREACH: "网络不通",
  ENETUNREACH: "网络不通",
  CERT_HAS_EXPIRED: "对方证书已过期",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "对方证书校验不过",
  DEPTH_ZERO_SELF_SIGNED_CERT: "对方用的是自签证书",
};

const clip = (text: string, max = 200) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function errorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * 测量失败时分个类，给一句原因。远程的 401/403 是要登录或密钥不对；其它远程错误都算连不上；
 * 本机命令（stdio）的失败都算起不来，原因优先用进程自己最后打印的那行错误
 */
export function classifyMcpError(
  transport: DiscoveredMcpServer["transport"],
  error: unknown,
  stderrTail = "",
): { problem: McpProblem; error: string } {
  const message = error instanceof Error ? error.message : String(error);
  const status =
    error instanceof StreamableHTTPError || error instanceof SseError
      ? (error as { code?: number }).code
      : undefined;
  if (error instanceof UnauthorizedError || status === 401 || status === 403) {
    return {
      problem: "auth",
      error: status ? `服务要求登录或密钥（HTTP ${status}）` : "服务要求登录或密钥",
    };
  }
  const code = errorCode(error);
  if (transport === "stdio") {
    if (code === "ENOENT") return { problem: "failed", error: "找不到要运行的命令" };
    if (code === "EACCES") return { problem: "failed", error: "命令没有执行权限" };
    const last = stderrTail
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1);
    return { problem: "failed", error: clip(last ? `${message}：${last}` : message) };
  }
  if (code && NETWORK_REASONS[code]) {
    return { problem: "unreachable", error: `${NETWORK_REASONS[code]}（${code}）` };
  }
  if (typeof status === "number" && status > 0) {
    return { problem: "unreachable", error: `服务返回了 HTTP ${status}` };
  }
  return { problem: "unreachable", error: clip(code ? `${message}（${code}）` : message) };
}

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
  // 进程自己打印的错误留最后一段，起不来时当原因
  let stderrTail = "";
  if (server.transport === "stdio") {
    if (typeof config.command !== "string" || !config.command) {
      return { ok: false, error: "缺少 command", problem: "failed" };
    }
    const stdio = new StdioClientTransport({
      command: config.command,
      args: Array.isArray(config.args) ? config.args.map(String) : [],
      env: { ...stringRecord(process.env), ...stringRecord(config.env) },
      stderr: "pipe",
      ...(typeof config.cwd === "string" ? { cwd: config.cwd } : {}),
    });
    stdio.stderr?.on("data", (chunk: Buffer | string) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });
    transport = stdio;
  } else {
    if (typeof config.url !== "string" || !config.url) {
      return { ok: false, error: "缺少 url", problem: "unreachable" };
    }
    let url: URL;
    try {
      url = new URL(config.url);
    } catch {
      return { ok: false, error: "地址写得不对", problem: "unreachable" };
    }
    const requestInit = { headers: stringRecord(config.headers) };
    transport =
      server.transport === "sse"
        ? new SSEClientTransport(url, { requestInit })
        : (new StreamableHTTPClientTransport(url, { requestInit }) as Transport);
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
    return { ok: false, ...classifyMcpError(server.transport, error, stderrTail) };
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => undefined);
  }
}
