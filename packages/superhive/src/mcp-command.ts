import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { measureMcpServer, type McpMeasurement } from "./mcp-measure.js";
import { commandFor } from "./windows-command.js";
import {
  type DiscoveredMcpServer,
  discoverClaudeMcpServers,
  discoverCodexMcpServers,
  readAgentSettings,
  type McpServerScope,
  type McpTransport,
} from "./mcp-servers.js";

const usage = `
用法：
  hive mcp list --provider claude|codex [--cwd PATH] [--agent-settings FILE] [--measure] [--json]
  hive mcp check [--timeout 秒] < server.json

list：列出该 Agent CLI 在这台电脑上会加载的 MCP，以及按 Agent 设置文件是否启用。
--measure 会逐个连上 MCP 读取工具列表，估算它在每个会话开局占用的 token（仅 Claude Code）。

check：从标准输入读一个 MCP 的配置（{"transport":"stdio|http|sse","config":{command,args,env,url,headers}}），
连上去读一遍工具列表，输出一行 JSON：{"measurement":{ok,tools,tokens} | {ok:false,error,problem}}。
配置走标准输入，里面的密钥不会出现在命令行和进程列表里。stdio 会真的运行那条命令（第一次可能要下载）。
`;

/** check 默认等多久：第一次运行 npx / uvx 要先下载包，比列表里的测量宽一些 */
const CHECK_TIMEOUT_SECONDS = 60;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

/** 解析 check 的输入；不合格时返回 undefined */
export function parseCheckInput(text: string): DiscoveredMcpServer | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const { transport, config } = parsed as { transport?: unknown; config?: unknown };
  if (transport !== "stdio" && transport !== "http" && transport !== "sse") return undefined;
  if (!config || typeof config !== "object" || Array.isArray(config)) return undefined;
  return {
    name: "check",
    scope: "user",
    transport,
    config: config as Record<string, unknown>,
  };
}

async function checkCommand(timeoutSeconds: number): Promise<void> {
  const server = parseCheckInput(await readStdin());
  if (!server) throw new Error("mcp check 需要从标准输入读一个 {transport, config} JSON。");
  const measurement = await measureMcpServer(server, timeoutSeconds * 1000);
  process.stdout.write(`${JSON.stringify({ measurement })}\n`);
}

export type McpListEntry = {
  name: string;
  scope: McpServerScope | "plugin";
  transport: McpTransport;
  enabled: boolean;
  /** false：由插件提供或已在 CLI 自己的配置里关闭，不能在 Hive 里开关 */
  configurable: boolean;
  /** CLI 自己的配置里就是关闭的 */
  disabledByCli?: boolean;
  measurement?: McpMeasurement;
};

type CodexListedServer = { name?: unknown; enabled?: unknown; transport?: { type?: unknown } };

/** Codex 自己列出的全部 MCP（含插件提供的）；读不到时返回 undefined */
function codexListed(command: string): CodexListedServer[] | undefined {
  const list = commandFor(command, ["mcp", "list", "--json"]);
  const result = spawnSync(list.command, list.args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 20_000,
  });
  if (result.status !== 0) return undefined;
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    return Array.isArray(parsed) ? (parsed as CodexListedServer[]) : undefined;
  } catch {
    return undefined;
  }
}

export async function listMcp(options: {
  provider: "claude" | "codex";
  cwd: string;
  settingsFile?: string | undefined;
  measure?: boolean;
  codexCommand?: string;
}): Promise<McpListEntry[]> {
  const disabled = new Set(readAgentSettings(options.settingsFile).mcpDisabled);
  if (options.provider === "codex") {
    // -c mcp_servers.名称.enabled=false 只对 config.toml 里写的生效；插件提供的改不了
    const configured = new Map(discoverCodexMcpServers().map((server) => [server.name, server]));
    const listed = codexListed(options.codexCommand ?? "codex");
    const entries: McpListEntry[] = (listed ?? [...configured.values()])
      .filter((item) => typeof item.name === "string" && item.name !== "hive")
      .map((item) => {
        const name = item.name as string;
        const disabledByCli = "enabled" in item && item.enabled === false;
        const configurable = configured.has(name) && !disabledByCli;
        const type = "transport" in item ? (item as CodexListedServer).transport?.type : undefined;
        return {
          name,
          scope: configured.has(name) ? "user" : "plugin",
          transport:
            type === "stdio" || type === undefined
              ? (configured.get(name)?.transport ?? "stdio")
              : "http",
          enabled: !disabledByCli && !(configurable && disabled.has(name)),
          configurable,
          ...(disabledByCli ? { disabledByCli } : {}),
        };
      });
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }
  const servers = discoverClaudeMcpServers({ cwd: options.cwd });
  return Promise.all(
    servers.map(async (server) => ({
      name: server.name,
      scope: server.scope,
      transport: server.transport,
      enabled: !disabled.has(server.name),
      configurable: true,
      ...(options.measure ? { measurement: await measureMcpServer(server) } : {}),
    })),
  );
}

export async function mcpCommand(argv: string[]): Promise<void> {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      provider: { type: "string", default: "claude" },
      cwd: { type: "string" },
      "agent-settings": { type: "string" },
      measure: { type: "boolean" },
      codex: { type: "string", default: "codex" },
      json: { type: "boolean" },
      timeout: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (!parsed.values.help && parsed.positionals[0] === "check") {
    const seconds = Number(parsed.values.timeout ?? CHECK_TIMEOUT_SECONDS);
    return checkCommand(
      Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 300) : CHECK_TIMEOUT_SECONDS,
    );
  }
  if (parsed.values.help || parsed.positionals[0] !== "list") {
    console.log(usage);
    return;
  }
  const provider = parsed.values.provider;
  if (provider !== "claude" && provider !== "codex") {
    throw new Error(`mcp list 目前支持 claude 与 codex，收到 “${provider}”。`);
  }
  const entries = await listMcp({
    provider,
    cwd: path.resolve(parsed.values.cwd ?? homedir()),
    settingsFile: parsed.values["agent-settings"],
    measure: parsed.values.measure ?? false,
    codexCommand: parsed.values.codex,
  });
  if (parsed.values.json) {
    process.stdout.write(`${JSON.stringify({ provider, servers: entries })}\n`);
    return;
  }
  if (entries.length === 0) console.log("没有找到本机 MCP 配置。");
  for (const entry of entries) {
    const size = entry.measurement
      ? entry.measurement.ok
        ? `  ${entry.measurement.tools} 个工具，约 ${entry.measurement.tokens} token`
        : `  无法读取：${entry.measurement.error}`
      : "";
    console.log(
      `${entry.enabled ? "[开]" : "[关]"} ${entry.name}（${entry.scope} · ${entry.transport}）${entry.configurable ? "" : "  不能在 Hive 里开关"}${size}`,
    );
  }
}
