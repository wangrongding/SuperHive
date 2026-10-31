import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * 本机 Agent 的 MCP 选择：每个 MCP Server 的工具定义都会在每个会话开局整段发给模型，
 * 体积大的（例如几十万 token 的逆向工具集）会让每次新会话、每次缓存过期都多花一大笔。
 * 这里列出 Agent CLI 会加载的 MCP，并按房主在网页上的勾选决定实际加载哪些。
 */

export type McpServerScope = "user" | "local" | "project";
export type McpTransport = "stdio" | "http" | "sse";

export type DiscoveredMcpServer = {
  name: string;
  scope: McpServerScope;
  transport: McpTransport;
  /** 原样传给 Claude Code 的配置；Codex 只用到名称 */
  config: Record<string, unknown>;
};

/** Agent 设置文件：由本机 Hive Server 写入，Agent 每一轮读取，改动下一轮生效 */
export type AgentSettings = { mcpDisabled: string[] };

export function readAgentSettings(file: string | undefined): AgentSettings {
  if (!file) return { mcpDisabled: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { mcpDisabled?: unknown };
    const disabled = Array.isArray(parsed.mcpDisabled)
      ? parsed.mcpDisabled.filter((name): name is string => typeof name === "string")
      : [];
    return { mcpDisabled: [...new Set(disabled)].sort() };
  } catch {
    // 文件还没写或写坏了：按"全部启用"处理，与没有设置时的行为一致
    return { mcpDisabled: [] };
  }
}

function transportOf(config: Record<string, unknown>): McpTransport {
  if (config.type === "http" || config.type === "sse") return config.type;
  if (config.type === undefined && typeof config.url === "string") return "http";
  return "stdio";
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function serversOf(value: unknown): Record<string, Record<string, unknown>> {
  if (!value || typeof value !== "object") return {};
  const result: Record<string, Record<string, unknown>> = {};
  for (const [name, config] of Object.entries(value as Record<string, unknown>)) {
    if (config && typeof config === "object") result[name] = config as Record<string, unknown>;
  }
  return result;
}

/** 从 cwd 往上到根目录，依次返回每一级目录（最近的在前） */
function ancestors(cwd: string): string[] {
  const result: string[] = [];
  let current = path.resolve(cwd);
  for (;;) {
    result.push(current);
    const parent = path.dirname(current);
    if (parent === current) return result;
    current = parent;
  }
}

/**
 * Claude Code 的三处 MCP 来源，同名时 local > project > user：
 * - user：~/.claude.json 顶层 mcpServers
 * - local：~/.claude.json projects[项目目录].mcpServers
 * - project：项目目录下的 .mcp.json，需要用户批准过（enabledMcpjsonServers / enableAllProjectMcpServers）
 * 插件自带的 MCP 不在其中：按勾选加载时（--strict-mcp-config）它们不会被加载。
 */
export function discoverClaudeMcpServers(options: {
  cwd: string;
  home?: string;
  configDir?: string;
}): DiscoveredMcpServer[] {
  const home = options.home ?? homedir();
  const configDir = options.configDir ?? process.env.CLAUDE_CONFIG_DIR;
  const globalConfig = readJson(path.join(configDir ?? home, ".claude.json")) ?? {};
  const projects = (globalConfig.projects ?? {}) as Record<string, Record<string, unknown>>;
  const dirs = ancestors(options.cwd);
  const projectDir = dirs.find((dir) => projects[dir]);
  const project = projectDir ? projects[projectDir] : undefined;

  const found = new Map<string, DiscoveredMcpServer>();
  const add = (scope: McpServerScope, servers: Record<string, Record<string, unknown>>) => {
    for (const [name, config] of Object.entries(servers)) {
      found.set(name, { name, scope, transport: transportOf(config), config });
    }
  };
  add("user", serversOf(globalConfig.mcpServers));

  const enabledAll = project?.enableAllProjectMcpServers === true;
  const approved = new Set(
    Array.isArray(project?.enabledMcpjsonServers)
      ? (project.enabledMcpjsonServers as string[])
      : [],
  );
  const rejected = new Set(
    Array.isArray(project?.disabledMcpjsonServers)
      ? (project.disabledMcpjsonServers as string[])
      : [],
  );
  // 越靠近 cwd 的 .mcp.json 优先：从根往下依次覆盖
  for (const dir of [...dirs].reverse()) {
    const file = path.join(dir, ".mcp.json");
    if (!existsSync(file)) continue;
    const servers = serversOf(readJson(file)?.mcpServers);
    const allowed = Object.fromEntries(
      Object.entries(servers).filter(
        ([name]) => !rejected.has(name) && (enabledAll || approved.has(name)),
      ),
    );
    add("project", allowed);
  }

  add("local", serversOf(project?.mcpServers));
  // 名为 hive 的由 Hive 自己提供，不让本机同名配置覆盖
  found.delete("hive");
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Codex 的 MCP 在 $CODEX_HOME/config.toml（默认 ~/.codex）的 [mcp_servers.名称] 小节里 */
export function discoverCodexMcpServers(
  options: { home?: string; codexHome?: string } = {},
): DiscoveredMcpServer[] {
  const codexHome =
    options.codexHome ?? process.env.CODEX_HOME ?? path.join(options.home ?? homedir(), ".codex");
  let text: string;
  try {
    text = readFileSync(path.join(codexHome, "config.toml"), "utf8");
  } catch {
    return [];
  }
  const found = new Map<string, DiscoveredMcpServer>();
  let current: DiscoveredMcpServer | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      // 只认 [mcp_servers.名称]；[mcp_servers.名称.env] 之类的子表不算新的 Server
      const match = /^\[\s*mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\s*\]$/.exec(line);
      const name = match?.[1] ?? match?.[2];
      current =
        name && name !== "hive"
          ? { name, scope: "user", transport: "stdio", config: {} }
          : undefined;
      if (current) found.set(current.name, current);
      continue;
    }
    if (current && /^url\s*=/.test(line)) current.transport = "http";
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** 名称作为 TOML 键：普通名字直接写，含其他字符时加引号 */
function tomlKey(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
}

/** 按勾选关闭 Codex 的 MCP：-c mcp_servers.名称.enabled=false */
export function codexMcpDisableOverrides(disabled: string[]): string[] {
  return disabled
    .filter((name) => name !== "hive")
    .map((name) => `mcp_servers.${tomlKey(name)}.enabled=false`);
}

/** 按勾选得到 Claude Code 要加载的 MCP（不含 hive，由调用方加上） */
export function enabledClaudeMcpServers(
  cwd: string,
  settings: AgentSettings,
): Record<string, Record<string, unknown>> {
  const disabled = new Set(settings.mcpDisabled);
  return Object.fromEntries(
    discoverClaudeMcpServers({ cwd })
      .filter((server) => !disabled.has(server.name))
      .map((server) => [server.name, server.config]),
  );
}
