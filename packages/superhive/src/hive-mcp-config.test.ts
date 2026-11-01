import { describe, expect, it } from "vitest";
import {
  claudeHiveMcpConfig,
  codexHiveMcpOverrides,
  copilotHiveMcpConfig,
  hiveMcpHeaders,
  hiveMcpUrl,
  openClawHiveMcpConfig,
  openClawHiveMcpName,
} from "./hive-mcp-config.js";

const connection = {
  serverUrl: "https://hive.example.com/",
  roomId: "general",
  username: "小明-codex",
  token: "secret-token",
};

describe("Hive MCP provider configuration", () => {
  it("builds the MCP URL and scoped identity headers", () => {
    expect(hiveMcpUrl(connection)).toBe("https://hive.example.com/mcp");
    expect(hiveMcpHeaders(connection)).toEqual({
      Authorization: "Bearer secret-token",
      "X-Hive-Room": "general",
      "X-Hive-Agent-Name": "小明-codex",
    });
  });

  it("generates provider-native remote MCP configuration", () => {
    expect(JSON.parse(claudeHiveMcpConfig(connection))).toMatchObject({
      mcpServers: { hive: { type: "http", url: "https://hive.example.com/mcp" } },
    });
    expect(JSON.parse(copilotHiveMcpConfig(connection))).toMatchObject({
      mcpServers: { hive: { tools: ["*"] } },
    });
    expect(JSON.parse(openClawHiveMcpConfig(connection))).toMatchObject({
      transport: "streamable-http",
      headers: { "X-Hive-Agent-Name": "小明-codex" },
    });
    expect(codexHiveMcpOverrides(connection).join(" ")).toContain("mcp_servers.hive.http_headers");
    expect(openClawHiveMcpName(connection)).toMatch(/^superhive-[a-f0-9]{12}$/);
  });
});
