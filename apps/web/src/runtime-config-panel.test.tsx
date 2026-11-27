// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig, RuntimeCredentialProvider } from "@superhive/protocol";
import type { RuntimeConfigResult } from "./local-agents";
import { mcpInput, RuntimeConfigPanel } from "./runtime-config-panel";
import { REVEAL_MS } from "./runtime-credentials";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const SECRET = "sk-ant-claude-secret-0123456789";

function config(provider: RuntimeCredentialProvider, overrides: Partial<RuntimeConfig> = {}) {
  const claude = provider === "claude";
  const value: RuntimeConfig = {
    provider,
    credentials: {
      provider,
      files: [claude ? "~/.claude/settings.json" : "~/.codex/config.toml"],
      configured: true,
      effect: claude ? "nextTurn" : "restart",
      baseUrl: {
        set: true,
        masked: "https://gw••••.com",
        editable: true,
        location: "settings.json → env.ANTHROPIC_BASE_URL",
      },
      apiKey: {
        set: true,
        masked: "sk-a••••6789",
        editable: true,
        location: "settings.json → env.ANTHROPIC_AUTH_TOKEN",
      },
    },
    fields: [
      {
        id: "model",
        group: "access",
        kind: "text",
        value: "opus",
        editable: true,
        location: "settings.json → env.ANTHROPIC_MODEL",
      },
      {
        id: claude ? "permissionMode" : "sandbox_mode",
        group: "behavior",
        kind: "select",
        options: claude ? ["default", "plan"] : ["read-only", "workspace-write"],
        value: null,
        editable: true,
        location: "behavior",
        note: "只影响终端里直接运行的 CLI",
      },
    ],
    mcp: {
      supported: true,
      file: claude ? "~/.claude.json" : "~/.codex/config.toml",
      canToggle: !claude,
      servers: [
        {
          name: "docs",
          transport: "stdio",
          command: "npx",
          args: ["docs"],
          envKeys: ["TOKEN"],
          enabled: true,
        },
      ],
    },
    prompt: { id: "prompt", path: "~/.claude/CLAUDE.md", format: "markdown", exists: false },
    rawFiles: [{ id: "settings", path: "~/.claude/settings.json", format: "json", exists: true }],
    ...overrides,
  };
  return value;
}

const result = (
  provider: RuntimeCredentialProvider,
  next?: RuntimeConfig,
): RuntimeConfigResult => ({
  config: next ?? config(provider),
  agents: [{ id: "a1", name: provider === "claude" ? "rd-claude" : "rd-codex", status: "running" }],
});

function api(provider: RuntimeCredentialProvider = "claude") {
  return {
    runtimeConfig: vi.fn(async () => result(provider)),
    updateRuntimeFields: vi.fn(async () => result(provider)),
    putRuntimeMcp: vi.fn(async () => result(provider)),
    deleteRuntimeMcp: vi.fn(async () => result(provider)),
    toggleRuntimeMcp: vi.fn(async () => result(provider)),
    readRuntimeFile: vi.fn(
      async (): Promise<{ content: string; hash: string | null; exists: boolean }> => ({
        content: '{ "env": {} }',
        hash: "h1",
        exists: true,
      }),
    ),
    writeRuntimeFile: vi.fn(async () => ({ ...result(provider), hash: "h2" })),
    revealRuntimeCredential: vi.fn(async () => SECRET),
    updateRuntimeCredentials: vi.fn(async () => ({ ...config(provider).credentials, agents: [] })),
    act: vi.fn(async () => undefined),
    runtimeSkills: vi.fn(() => Promise.reject(new Error("unused"))),
    readRuntimeSkill: vi.fn(() => Promise.reject(new Error("unused"))),
    toggleRuntimeSkill: vi.fn(() => Promise.reject(new Error("unused"))),
    deleteRuntimeSkill: vi.fn(() => Promise.reject(new Error("unused"))),
  };
}

const tab = (name: string) => fireEvent.click(screen.getByRole("tab", { name }));
const confirmIn = (name: string) =>
  act(async () => {
    fireEvent.click(
      screen.getByRole("dialog", { name }).querySelector<HTMLButtonElement>("button:last-child")!,
    );
  });

describe("RuntimeConfigPanel", () => {
  it("shows masked credentials and reveals the full key only after confirming, for 30 seconds", async () => {
    const client = api();
    render(<RuntimeConfigPanel api={client} provider="claude" />);
    await screen.findByText("sk-a••••6789");
    expect(document.body.textContent).not.toContain(SECRET);
    vi.useFakeTimers();
    fireEvent.click(screen.getAllByText("显示")[1]!);
    expect(client.revealRuntimeCredential).not.toHaveBeenCalled();
    await confirmIn("确认显示完整的 API key");
    expect(client.revealRuntimeCredential).toHaveBeenCalledWith("claude", "apiKey");
    expect(document.body.textContent).toContain(SECRET);
    act(() => {
      vi.advanceTimersByTime(REVEAL_MS);
    });
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it("saves changed fields after warning about the terminal CLI; empty means CLI default", async () => {
    const client = api();
    render(<RuntimeConfigPanel api={client} provider="claude" />);
    const model = (await screen.findByDisplayValue("opus")) as HTMLInputElement;
    expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(model, { target: { value: "" } });
    fireEvent.click(screen.getByText("保存"));
    expect(client.updateRuntimeFields).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog").textContent).toContain("会同时影响终端里的 Claude Code");
    await confirmIn("确认保存 Claude Code 的配置");
    expect(client.updateRuntimeFields).toHaveBeenCalledWith("claude", { model: null });
    // Claude 常驻进程发现凭据变了会换新：不用重启，没有重启按钮
    expect(screen.getByRole("status").textContent).toContain("不用重启");
    expect(screen.queryByText(/重启这/)).toBeNull();

    tab("行为");
    expect(screen.getByText("只影响终端里直接运行的 CLI")).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "plan" } });
    fireEvent.click(screen.getByText("保存"));
    await confirmIn("确认保存 Claude Code 的配置");
    expect(client.updateRuntimeFields).toHaveBeenLastCalledWith("claude", {
      permissionMode: "plan",
    });
  });

  it("manages MCP servers: toggle, edit keeping env values, delete with confirmation, and restart resident agents", async () => {
    const client = api("codex");
    render(<RuntimeConfigPanel api={client} provider="codex" />);
    await screen.findByDisplayValue("opus");
    tab("MCP");
    expect(screen.getByText("环境变量：TOKEN")).toBeTruthy();
    fireEvent.click(screen.getByText("停用"));
    await waitFor(() =>
      expect(client.toggleRuntimeMcp).toHaveBeenCalledWith("codex", "docs", false),
    );
    // Codex 常驻：给一键重启
    fireEvent.click(await screen.findByText("重启这 1 个 Agent"));
    await waitFor(() => expect(client.act).toHaveBeenCalledWith("a1", "restart"));

    fireEvent.click(screen.getByText("编辑"));
    fireEvent.change(screen.getByLabelText("命令"), { target: { value: "bunx" } });
    fireEvent.click(within(document.querySelector("form")!).getByText("保存"));
    await waitFor(() =>
      expect(client.putRuntimeMcp).toHaveBeenCalledWith(
        "codex",
        "docs",
        {
          transport: "stdio",
          command: "bunx",
          args: ["docs"],
          env: { TOKEN: null },
          enabled: true,
        },
        "docs",
      ),
    );

    fireEvent.click(screen.getByText("删除"));
    expect(client.deleteRuntimeMcp).not.toHaveBeenCalled();
    await confirmIn("确认删除 MCP docs");
    expect(client.deleteRuntimeMcp).toHaveBeenCalledWith("codex", "docs");
  });

  it("explains when a CLI can't disable a single MCP server", async () => {
    render(<RuntimeConfigPanel api={api()} provider="claude" />);
    await screen.findByDisplayValue("opus");
    tab("MCP");
    expect(screen.queryByText("停用")).toBeNull();
    expect(screen.getByText(/没有单独停用的开关/)).toBeTruthy();
  });

  it("edits the global prompt file and requires confirmation before showing raw config", async () => {
    const client = api();
    client.readRuntimeFile.mockResolvedValueOnce({ content: "", hash: null, exists: false });
    render(<RuntimeConfigPanel api={client} provider="claude" />);
    await screen.findByDisplayValue("opus");
    tab("提示词");
    expect(screen.getByText("~/.claude/CLAUDE.md（还没有，保存后新建）")).toBeTruthy();
    const prompt = await screen.findByLabelText("~/.claude/CLAUDE.md 的内容");
    fireEvent.change(prompt, { target: { value: "# 习惯" } });
    fireEvent.click(screen.getByText("保存"));
    await waitFor(() =>
      expect(client.writeRuntimeFile).toHaveBeenCalledWith("claude", "prompt", "# 习惯", null),
    );

    tab("高级");
    expect(client.readRuntimeFile).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("查看并编辑"));
    expect(client.readRuntimeFile).toHaveBeenCalledTimes(1);
    await confirmIn("确认显示 ~/.claude/settings.json");
    await screen.findByDisplayValue('{ "env": {} }');
    expect(client.readRuntimeFile).toHaveBeenLastCalledWith("claude", "settings");
  });
});

describe("mcpInput", () => {
  it("keeps existing env values when left empty and parses args one per line", () => {
    expect(
      mcpInput(
        {
          name: "x",
          transport: "stdio",
          command: " npx ",
          args: "a\n\n b ",
          url: "",
          env: "TOKEN=\nNEW=1\n",
          existingEnv: ["TOKEN"],
        },
        true,
      ),
    ).toEqual({
      transport: "stdio",
      command: "npx",
      args: ["a", "b"],
      env: { TOKEN: null, NEW: "1" },
      enabled: true,
    });
  });
});
