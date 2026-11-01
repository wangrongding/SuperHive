import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  codexMcpDisableOverrides,
  discoverClaudeMcpServers,
  discoverCodexMcpServers,
  readAgentSettings,
} from "./mcp-servers.js";

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), "hive-mcp-test-"));
}

describe("discoverClaudeMcpServers", () => {
  it("merges user, approved project and local servers with local > project > user", () => {
    const home = scratch();
    const project = path.join(home, "repo");
    const cwd = path.join(project, "packages", "app");
    mkdirSync(cwd, { recursive: true });
    writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          big: { command: "big-mcp" },
          shared: { command: "user-shared" },
          hive: { type: "http", url: "http://elsewhere/mcp" },
        },
        projects: {
          [project]: {
            enabledMcpjsonServers: ["approved", "shared"],
            mcpServers: { private: { type: "http", url: "http://localhost:9/mcp" } },
          },
        },
      }),
    );
    writeFileSync(
      path.join(project, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          approved: { type: "sse", url: "http://localhost:8/sse" },
          unapproved: { command: "nope" },
          shared: { command: "project-shared" },
        },
      }),
    );

    const servers = discoverClaudeMcpServers({ cwd, home, configDir: home });

    expect(servers.map((server) => [server.name, server.scope, server.transport])).toEqual([
      ["approved", "project", "sse"],
      ["big", "user", "stdio"],
      ["private", "local", "http"],
      ["shared", "project", "stdio"],
    ]);
    expect(servers.find((server) => server.name === "shared")?.config).toEqual({
      command: "project-shared",
    });
  });

  it("returns nothing when Claude has no config", () => {
    const home = scratch();
    expect(discoverClaudeMcpServers({ cwd: home, home, configDir: home })).toEqual([]);
  });
});

describe("Codex MCP", () => {
  it("lists [mcp_servers.名称] sections but not their sub-tables", () => {
    const codexHome = scratch();
    writeFileSync(
      path.join(codexHome, "config.toml"),
      [
        'model = "x"',
        "[mcp_servers]",
        "[mcp_servers.chrome-devtools]",
        'command = "chrome-devtools-mcp"',
        "[mcp_servers.chrome-devtools.env]",
        'A = "1"',
        '[mcp_servers."with.dot"]',
        'url = "http://localhost/mcp"',
        "[mcp_servers.hive]",
        'url = "http://hive/mcp"',
      ].join("\n"),
    );
    expect(
      discoverCodexMcpServers({ codexHome }).map((server) => [server.name, server.transport]),
    ).toEqual([
      ["chrome-devtools", "stdio"],
      ["with.dot", "http"],
    ]);
  });

  it("turns the disabled list into -c overrides and never disables hive", () => {
    const configured = new Set(["chrome-devtools", "with.dot", "hive"]);
    expect(
      codexMcpDisableOverrides(["chrome-devtools", "with.dot", "hive", "removed"], configured),
    ).toEqual([
      "mcp_servers.chrome-devtools.enabled=false",
      'mcp_servers."with.dot".enabled=false',
    ]);
  });
});

describe("readAgentSettings", () => {
  it("treats a missing or broken file as everything enabled", () => {
    const dir = scratch();
    expect(readAgentSettings(undefined)).toEqual({ mcpDisabled: [] });
    expect(readAgentSettings(path.join(dir, "missing.json"))).toEqual({ mcpDisabled: [] });
    writeFileSync(path.join(dir, "broken.json"), "{");
    expect(readAgentSettings(path.join(dir, "broken.json"))).toEqual({ mcpDisabled: [] });
  });

  it("returns a sorted, de-duplicated list so the derived config stays byte-identical", () => {
    const file = path.join(scratch(), "settings.json");
    writeFileSync(file, JSON.stringify({ mcpDisabled: ["rea", "figma", "rea", 3] }));
    expect(readAgentSettings(file)).toEqual({ mcpDisabled: ["figma", "rea"] });
  });
});
