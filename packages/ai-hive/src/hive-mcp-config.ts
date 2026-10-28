import { createHash } from "node:crypto";

export type HiveMcpConnection = {
  serverUrl: string;
  roomId: string;
  username: string;
  token: string;
};

export function hiveMcpUrl(connection: HiveMcpConnection): string {
  return `${connection.serverUrl.replace(/\/$/, "")}/mcp`;
}

export function hiveMcpHeaders(connection: HiveMcpConnection): Record<string, string> {
  return {
    Authorization: `Bearer ${connection.token}`,
    "X-Hive-Room": connection.roomId,
    "X-Hive-Agent-Name": connection.username,
  };
}

export function claudeHiveMcpConfig(connection: HiveMcpConnection): string {
  return JSON.stringify({
    mcpServers: {
      hive: {
        type: "http",
        url: hiveMcpUrl(connection),
        headers: hiveMcpHeaders(connection),
      },
    },
  });
}

export function copilotHiveMcpConfig(connection: HiveMcpConnection): string {
  return JSON.stringify({
    mcpServers: {
      hive: {
        type: "http",
        url: hiveMcpUrl(connection),
        headers: hiveMcpHeaders(connection),
        tools: ["*"],
      },
    },
  });
}

/** ACP `session/new` / `session/load` 里的 mcpServers 条目（HTTP 传输，headers 为名值对数组） */
export type AcpMcpServer = {
  type: "http";
  name: string;
  url: string;
  headers: Array<{ name: string; value: string }>;
};

export function acpHiveMcpServer(connection: HiveMcpConnection): AcpMcpServer {
  return {
    type: "http",
    name: "hive",
    url: hiveMcpUrl(connection),
    headers: Object.entries(hiveMcpHeaders(connection)).map(([name, value]) => ({ name, value })),
  };
}

export function codexHiveMcpOverrides(connection: HiveMcpConnection): string[] {
  const headers = hiveMcpHeaders(connection);
  const headerTable = Object.entries(headers)
    .map(([name, value]) => `${JSON.stringify(name)}=${JSON.stringify(value)}`)
    .join(",");
  return [
    `mcp_servers.hive.url=${JSON.stringify(hiveMcpUrl(connection))}`,
    `mcp_servers.hive.http_headers={${headerTable}}`,
  ];
}

/**
 * Hive 工具只作用于聊天室本身（服务端另有预算与权限限制），预先批准它们，
 * 否则只读档会把 hive_message_send / hive_board_update 的审批请求一并拒绝。
 * 仅用于 app-server 路径：更老的 codex 不认识这个字段。
 */
export const CODEX_HIVE_TOOLS_APPROVAL_OVERRIDE = `mcp_servers.hive.default_tools_approval_mode="approve"`;

export function openClawHiveMcpConfig(connection: HiveMcpConnection): string {
  return JSON.stringify({
    url: hiveMcpUrl(connection),
    transport: "streamable-http",
    headers: hiveMcpHeaders(connection),
  });
}

export function openClawHiveMcpName(connection: HiveMcpConnection): string {
  const key = createHash("sha256")
    .update(`${connection.serverUrl}\0${connection.roomId}\0${connection.username}`)
    .digest("hex")
    .slice(0, 12);
  return `ai-hive-${key}`;
}
