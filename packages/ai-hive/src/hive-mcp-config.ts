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
