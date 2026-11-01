// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalAgent } from "@superhive/protocol";
import { LocalLaunch, type LocalAgentsState } from "./local-agents";

describe("LocalLaunch MCP selection", () => {
  afterEach(cleanup);

  it("lets the owner switch MCP servers off before launching", async () => {
    const create = vi.fn(async () => ({ id: "a1" }) as LocalAgent);
    const mcpCandidates = vi.fn(async () => ({
      supported: true,
      baselineTokens: 40_000,
      servers: [
        {
          name: "rea",
          scope: "user" as const,
          transport: "stdio" as const,
          enabled: true,
          configurable: true,
          measurement: { ok: true as const, tools: 207, tokens: 350_000 },
        },
      ],
    }));
    const local = {
      enabled: true,
      providers: [{ provider: "claude", command: "claude", installed: true, version: "1" }],
      agents: [],
      create,
      mcpCandidates,
      directories: vi.fn(),
    } as unknown as LocalAgentsState;
    render(
      <LocalLaunch
        local={local}
        provider="claude"
        access="read-only"
        defaultName="rd-claude"
        providerLabel="Claude Code"
      >
        <span />
      </LocalLaunch>,
    );

    fireEvent.click(screen.getByText("本机 MCP：全部加载（可选择）"));
    const box = await screen.findByRole("checkbox", { name: /rea/ });
    fireEvent.click(box);
    expect(screen.getByText("本机 MCP：已关闭 1 个")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "在本机启动" }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        provider: "claude",
        name: "rd-claude",
        access: "read-only",
        mcpDisabled: ["rea"],
      }),
    );
    expect(mcpCandidates).toHaveBeenCalledWith("claude", undefined);
  });
});
