// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  McpCatalog,
  RuntimeInstallPlan,
  RuntimeInstallResult,
  RuntimeOverview,
} from "@superhive/protocol";
import { InstallMcp } from "./runtime-install";

afterEach(cleanup);

const TOKEN = "ghp_web_secret";

const overview: RuntimeOverview = {
  providers: [
    { provider: "claude", mcpSupported: true, mcpCanToggle: false },
    { provider: "codex", mcpSupported: true, mcpCanToggle: true },
    {
      provider: "openclaw",
      mcpSupported: false,
      mcpCanToggle: false,
      mcpNote: "OpenClaw 还不支持在配置文件里管理 MCP",
    },
  ],
  mcp: [{ name: "context7", entries: [{ provider: "codex", enabled: true, transport: "http" }] }],
  skills: [],
};

const catalog: McpCatalog = {
  version: "test",
  entries: [
    {
      id: "github",
      name: "github",
      title: "GitHub",
      publisher: "GitHub",
      description: { zh: "GitHub 官方远程 MCP", en: "GitHub remote MCP" },
      docs: "https://github.com/github/github-mcp-server",
      transport: "http",
      url: "https://api.githubcopilot.com/mcp/",
      headers: { Authorization: "Bearer {token}" },
      params: [
        {
          id: "token",
          label: { zh: "个人访问令牌（PAT）", en: "PAT" },
          kind: "secret",
          required: true,
        },
      ],
      runtimes: ["claude", "codex", "opencode", "omp", "copilot"],
    },
    {
      id: "context7",
      name: "context7",
      title: "Context7",
      publisher: "Upstash",
      description: { zh: "查文档", en: "Docs" },
      docs: "https://github.com/upstash/context7",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@upstash/context7-mcp@4.8.0"],
      params: [],
      runtimes: ["claude", "codex"],
    },
  ],
};

const plan: RuntimeInstallPlan = {
  id: "plan-1",
  expiresAt: Date.now() + 600_000,
  recipeId: "github",
  catalogVersion: "test",
  name: "github",
  transport: "http",
  url: "https://api.githubcopilot.com/mcp/",
  env: [],
  headers: [{ key: "Authorization", value: "Bearer ••••••", secret: true }],
  targets: [
    { provider: "claude", file: "~/.claude.json", agents: [] },
    {
      provider: "codex",
      file: "~/.codex/config.toml",
      agents: [{ id: "a1", name: "rd-codex", status: "running" }],
    },
  ],
};

function api() {
  return {
    runtimeInstallCatalog: vi.fn(async () => catalog),
    previewRuntimeInstall: vi.fn(async () => plan),
    applyRuntimeInstall: vi.fn(async (): Promise<RuntimeInstallResult> => ({
      results: [
        { provider: "claude", ok: true, file: "~/.claude.json" },
        { provider: "codex", ok: false, file: "~/.codex/config.toml", error: "磁盘满了" },
      ],
      overview,
    })),
  };
}

describe("InstallMcp", () => {
  it("walks through pick, parameters, frozen plan and per-CLI results", async () => {
    const client = api();
    const onInstalled = vi.fn();
    render(
      <InstallMcp api={client} overview={overview} onClose={vi.fn()} onInstalled={onInstalled} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /GitHub/ }));

    // 选之前先看到要连的地址和请求头名
    expect(screen.getByText("https://api.githubcopilot.com/mcp/")).toBeTruthy();
    expect(screen.getByText("请求头：Authorization")).toBeTruthy();
    // 不支持 MCP 的 CLI 标灰并写原因
    const openclaw = screen.getByRole("checkbox", { name: /OpenClaw/ }) as HTMLInputElement;
    expect(openclaw.disabled).toBe(true);
    expect(screen.getAllByText("OpenClaw 还不支持在配置文件里管理 MCP").length).toBeGreaterThan(0);

    const preview = screen.getByRole("button", { name: "预览安装计划" }) as HTMLButtonElement;
    expect(preview.disabled).toBe(true);
    const secret = screen.getByLabelText(/个人访问令牌/) as HTMLInputElement;
    expect(secret.type).toBe("password");
    fireEvent.change(secret, { target: { value: TOKEN } });
    await act(async () => {
      fireEvent.click(preview);
    });
    expect(client.previewRuntimeInstall).toHaveBeenCalledWith({
      recipeId: "github",
      name: "github",
      params: { token: TOKEN },
      targets: ["claude", "codex"],
    });

    // 计划：打码的值、要改的文件、要重启的 Agent
    expect(screen.getByText("Bearer ••••••")).toBeTruthy();
    expect(screen.getByText("~/.codex/config.toml")).toBeTruthy();
    expect(screen.getByText("rd-codex")).toBeTruthy();
    expect(document.body.innerHTML).not.toContain(TOKEN);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "确认安装" }));
    });
    expect(client.applyRuntimeInstall).toHaveBeenCalledWith({
      recipeId: "github",
      name: "github",
      params: { token: TOKEN },
      targets: ["claude", "codex"],
      planId: "plan-1",
    });
    expect(onInstalled).toHaveBeenCalledWith(overview);
    const results = screen.getByRole("list");
    expect(within(results).getByText(/已写配置，未验证连接/)).toBeTruthy();
    expect(within(results).getByText(/没有写入。磁盘满了/)).toBeTruthy();
    // Codex 没写成，不提示重启它
    expect(
      screen.getByText("Hive 没有重启 Agent；终端里新开的 CLI 会话会加载新的 MCP。"),
    ).toBeTruthy();
  });

  it("greys out CLIs that already have the name or that the recipe doesn't support", async () => {
    const client = api();
    render(<InstallMcp api={client} overview={overview} onClose={vi.fn()} onInstalled={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Context7/ }));
    expect(screen.getByText("npx")).toBeTruthy();
    expect(screen.getByText("@upstash/context7-mcp@4.8.0")).toBeTruthy();
    const codex = screen.getByRole("checkbox", { name: /Codex/ }) as HTMLInputElement;
    expect(codex.disabled).toBe(true);
    expect(screen.getAllByText("Codex 里已经有叫 context7 的 MCP，不覆盖").length).toBeGreaterThan(
      0,
    );
    // 换个名字就能装进 Codex
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "context7-b" } });
    expect((screen.getByRole("checkbox", { name: /Codex/ }) as HTMLInputElement).disabled).toBe(
      false,
    );
  });

  it("goes back to the form when the plan is stale", async () => {
    const client = api();
    client.applyRuntimeInstall.mockRejectedValueOnce(new Error("安装计划已过期"));
    render(<InstallMcp api={client} overview={overview} onClose={vi.fn()} onInstalled={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /GitHub/ }));
    fireEvent.change(screen.getByLabelText(/个人访问令牌/), { target: { value: TOKEN } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "预览安装计划" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "确认安装" }));
    });
    expect(screen.getByRole("alert").textContent).toContain("安装计划已过期");
    expect(screen.getByRole("button", { name: "预览安装计划" })).toBeTruthy();
  });
});
