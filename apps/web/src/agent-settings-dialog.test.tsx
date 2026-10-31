// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalAgent, LocalAgentMcpResponse } from "@ai-hive/protocol";
import { AgentSettingsDialog, formatTokens } from "./agent-settings-dialog";

const agent = {
  id: "00000000-0000-4000-8000-0000000000e1",
  provider: "claude",
  name: "rd-claude",
  access: "full",
  cwd: "/repo",
  model: null,
  status: "running",
  pid: 1,
  startedAt: null,
  lastExitCode: null,
  lastError: null,
  restarts: 0,
  createdAt: new Date().toISOString(),
  mcpDisabled: [],
} as LocalAgent;

const listed: LocalAgentMcpResponse = {
  supported: true,
  baselineTokens: 40_000,
  servers: [
    {
      name: "chrome-devtools",
      scope: "user",
      transport: "stdio",
      enabled: true,
      configurable: true,
      measurement: { ok: true, tools: 32, tokens: 12_000 },
    },
    {
      name: "rea",
      scope: "user",
      transport: "stdio",
      enabled: true,
      configurable: true,
      measurement: { ok: true, tools: 207, tokens: 350_000 },
    },
    { name: "figma", scope: "plugin", transport: "http", enabled: true, configurable: false },
  ],
};

describe("AgentSettingsDialog", () => {
  afterEach(cleanup);

  it("lists MCP sizes, estimates the start cost and saves the unchecked servers", async () => {
    const mcpServers = vi.fn(async () => listed);
    const updateSettings = vi.fn(async (_id: string, settings: { mcpDisabled: string[] }) => ({
      ...agent,
      mcpDisabled: settings.mcpDisabled,
    }));
    const act = vi.fn(async () => undefined);
    render(
      <AgentSettingsDialog
        agent={agent}
        local={{ mcpServers, updateSettings, act }}
        onClose={() => undefined}
      />,
    );

    expect(await screen.findByText("207 个工具 · 约 35 万 token")).toBeTruthy();
    // figma 来自插件，不能在这里开关；估算只能在它也有大小时给出
    expect((screen.getByRole("checkbox", { name: /figma/ }) as HTMLInputElement).disabled).toBe(
      true,
    );
    expect(screen.queryByText(/每个新会话开局约/)).toBeNull();

    fireEvent.click(screen.getByRole("checkbox", { name: /rea/ }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith(agent.id, { mcpDisabled: ["rea"] }),
    );
    expect(act).not.toHaveBeenCalled();
    expect(await screen.findByText("已保存。")).toBeTruthy();
  });

  it("asks for a restart when the running process predates the settings file", async () => {
    const act = vi.fn(async () => undefined);
    render(
      <AgentSettingsDialog
        agent={{ ...agent, settingsPendingRestart: true }}
        local={{
          mcpServers: async () => ({ ...listed, servers: listed.servers.slice(0, 2) }),
          updateSettings: async (_id, settings) => ({ ...agent, ...settings }),
          act,
        }}
        onClose={() => undefined}
      />,
    );
    expect(await screen.findByText(/每个新会话开局约 40 万 token/)).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /rea/ }));
    expect(screen.getByText(/每个新会话开局约 5.2 万 token/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "保存并重启" }));
    await waitFor(() => expect(act).toHaveBeenCalledWith(agent.id, "restart"));
  });

  it("formats token counts", () => {
    expect(formatTokens(800)).toBe("800");
    expect(formatTokens(12_000)).toBe("1.2 万");
    expect(formatTokens(350_000)).toBe("35 万");
  });
});
