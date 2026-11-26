// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeOverview, RuntimeSkill, RuntimeSkills } from "@superhive/protocol";
import type { RuntimeSkillsResult } from "./local-agents";
import { SkillsSection } from "./runtime-skills-panel";
import { RuntimeOverviewBlock } from "./runtime-overview";

afterEach(cleanup);

const skill = (overrides: Partial<RuntimeSkill>): RuntimeSkill => ({
  id: "user/pdf",
  name: "pdf",
  description: "处理 PDF",
  source: "user",
  path: "~/.claude/skills/pdf",
  enabled: true,
  canToggle: true,
  canDelete: true,
  canSync: true,
  sharedWith: [],
  ...overrides,
});

function skills(list: RuntimeSkill[]): RuntimeSkillsResult {
  const value: RuntimeSkills = {
    provider: "claude",
    toggleLocation: "~/.claude/settings.json",
    dirs: [{ path: "~/.claude/skills", exists: true, source: "user" }],
    skills: list,
  };
  return { skills: value, agents: [] };
}

const initial = [
  skill({}),
  skill({
    id: "user/superhive",
    name: "superhive",
    source: "superhive",
    canToggle: false,
    canDelete: false,
    canSync: false,
    note: "Hive 自带的 superhive skill，只能查看",
  }),
  skill({
    id: "agents/lark",
    name: "lark",
    source: "shared",
    path: "~/.agents/skills/lark",
    sharedWith: ["codex", "copilot"],
  }),
];

function api() {
  return {
    runtimeSkills: vi.fn(async () => skills(initial)),
    readRuntimeSkill: vi.fn(async () => ({
      content: "---\nname: pdf\n---\n# 用法",
      path: "~/.claude/skills/pdf/SKILL.md",
    })),
    toggleRuntimeSkill: vi.fn(async () => skills([skill({ enabled: false }), ...initial.slice(1)])),
    deleteRuntimeSkill: vi.fn(async () => ({
      ...skills(initial.slice(0, 2)),
      backup: "~/.agents/.superhive-skill-backups/lark-1",
    })),
  };
}

describe("SkillsSection", () => {
  it("lists skills, keeps superhive read-only, views SKILL.md and toggles", async () => {
    const client = api();
    render(<SkillsSection api={client} provider="claude" />);
    await screen.findByText("pdf");
    expect(screen.getByText(/启停写在 ~\/\.claude\/settings\.json/).textContent).toContain(
      "终端里的 Claude Code 也一起变",
    );
    const superhive = screen.getByText("superhive").closest("li")!;
    expect(within(superhive).getByText("Hive 自带")).toBeTruthy();
    expect(within(superhive).queryByText("停用")).toBeNull();
    expect(within(superhive).queryByText("删除")).toBeNull();

    const pdf = screen.getByText("pdf").closest("li")!;
    fireEvent.click(within(pdf).getByText("查看"));
    expect(await within(pdf).findByText(/# 用法/)).toBeTruthy();
    expect(client.readRuntimeSkill).toHaveBeenCalledWith("claude", "user/pdf");

    fireEvent.click(within(pdf).getByText("停用"));
    await waitFor(() =>
      expect(client.toggleRuntimeSkill).toHaveBeenCalledWith("claude", "user/pdf", false),
    );
    expect(await within(screen.getByText("pdf").closest("li")!).findByText("已停用")).toBeTruthy();
  });

  it("asks before deleting and warns which other CLIs share the folder", async () => {
    const client = api();
    render(<SkillsSection api={client} provider="claude" />);
    const lark = (await screen.findByText("lark")).closest("li")!;
    expect(within(lark).getByText("这个目录 Codex、Copilot CLI 也会读")).toBeTruthy();
    fireEvent.click(within(lark).getByText("删除"));
    expect(client.deleteRuntimeSkill).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "确认删除技能 lark" });
    expect(dialog.textContent).toContain("会同时影响终端里的 Claude Code");
    expect(dialog.textContent).toContain("删掉后它们也用不了");
    await act(async () => {
      fireEvent.click(dialog.querySelector<HTMLButtonElement>("button:last-child")!);
    });
    expect(client.deleteRuntimeSkill).toHaveBeenCalledWith("claude", "agents/lark");
    expect(await screen.findByText(/备份在 ~\/\.agents\/\.superhive-skill-backups/)).toBeTruthy();
    expect(screen.queryByText("lark")).toBeNull();
  });
});

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
  mcp: [
    { name: "context7", entries: [{ provider: "codex", enabled: true, transport: "stdio" }] },
    { name: "docs", entries: [{ provider: "claude", enabled: true, transport: "stdio" }] },
  ],
  skills: [
    {
      name: "figma:figma-use",
      entries: [
        {
          provider: "claude",
          id: "plugin:figma@m/figma-use",
          enabled: true,
          source: "plugin",
          canToggle: false,
          canSync: false,
          note: "跟着插件 figma 一起启停",
        },
      ],
    },
    {
      name: "pdf",
      entries: [
        {
          provider: "claude",
          id: "user/pdf",
          enabled: true,
          source: "user",
          canToggle: true,
          canSync: true,
        },
        {
          provider: "codex",
          id: "user/pdf",
          enabled: false,
          source: "user",
          canToggle: true,
          canSync: true,
        },
      ],
    },
  ],
};

function overviewApi() {
  return {
    runtimeOverview: vi.fn(async () => overview),
    syncRuntimeMcp: vi.fn(async () => overview),
    syncRuntimeSkill: vi.fn(async () => overview),
    addRuntimeMcp: vi.fn(async () => overview),
    toggleRuntimeMcp: vi.fn(() => Promise.resolve(undefined as never)),
    deleteRuntimeMcp: vi.fn(() => Promise.resolve(undefined as never)),
    toggleRuntimeSkill: vi.fn(() => Promise.resolve(undefined as never)),
  };
}

const cell = (name: string) => screen.getByRole("checkbox", { name }) as HTMLInputElement;

describe("RuntimeOverviewBlock", () => {
  it("toggles an MCP per CLI, copies after confirming, greys out what a CLI can't do, and jumps", async () => {
    const client = overviewApi();
    const onJump = vi.fn();
    render(<RuntimeOverviewBlock api={client} onJump={onJump} />);
    await screen.findByText("docs");
    expect(screen.getByText(/勾上就写进那个 CLI 的全局配置/).textContent).toContain(
      "终端里的 CLI 也一起变",
    );

    // OpenClaw 不支持 MCP：格子标灰并说明原因
    const table = screen.getByRole("table");
    expect(within(table).getAllByText("不支持")).toHaveLength(2);
    expect(within(table).getAllByText("OpenClaw 还不支持在配置文件里管理 MCP")).toHaveLength(2);
    // Claude Code 的 MCP 没有停用开关，又是最后一份：不能取消
    expect(cell("在 Claude Code 里启用 docs").disabled).toBe(true);

    // Codex 支持停用：直接取消
    fireEvent.click(cell("在 Codex 里启用 context7"));
    await waitFor(() =>
      expect(client.toggleRuntimeMcp).toHaveBeenCalledWith("codex", "context7", false),
    );
    expect(client.runtimeOverview).toHaveBeenCalledTimes(2);

    // 没有的：确认后从已有的那个 CLI 复制过去
    fireEvent.click(cell("在 Codex 里启用 docs"));
    expect(client.syncRuntimeMcp).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "确认把 docs 加到 Codex" });
    expect(dialog.textContent).toContain("包括环境变量的值");
    expect(dialog.textContent).toContain("会同时影响终端里的 Codex");
    await act(async () => {
      fireEvent.click(dialog.querySelector<HTMLButtonElement>("button:last-child")!);
    });
    expect(client.syncRuntimeMcp).toHaveBeenCalledWith("claude", "docs", ["codex"]);

    fireEvent.click(screen.getByRole("button", { name: "去 Codex 的配置" }));
    expect(onJump).toHaveBeenCalledWith("codex", "mcp");
  });

  it("toggles skills with each CLI's own switch and keeps plugin skills read-only", async () => {
    const client = overviewApi();
    const onJump = vi.fn();
    render(<RuntimeOverviewBlock api={client} onJump={onJump} />);
    await screen.findByText("docs");
    fireEvent.click(screen.getByRole("tab", { name: "技能（2）" }));
    expect(cell("在 Claude Code 里启用 figma:figma-use").disabled).toBe(true);
    // 插件、Hive 自带的不能复制到别的 CLI
    expect(cell("在 Codex 里启用 figma:figma-use").disabled).toBe(true);
    fireEvent.click(cell("在 Codex 里启用 pdf"));
    await waitFor(() =>
      expect(client.toggleRuntimeSkill).toHaveBeenCalledWith("codex", "user/pdf", true),
    );
    fireEvent.click(cell("在 OpenClaw 里启用 pdf"));
    await act(async () => {
      fireEvent.click(
        screen
          .getByRole("dialog", { name: "确认把 pdf 加到 OpenClaw" })
          .querySelector<HTMLButtonElement>("button:last-child")!,
      );
    });
    expect(client.syncRuntimeSkill).toHaveBeenCalledWith("claude", "user/pdf", ["openclaw"]);
    fireEvent.click(screen.getByRole("button", { name: "去 OpenClaw 的配置" }));
    expect(onJump).toHaveBeenCalledWith("openclaw", "skills");
  });

  it("adds a new MCP server to several CLIs at once", async () => {
    const client = overviewApi();
    render(<RuntimeOverviewBlock api={client} />);
    await screen.findByText("docs");
    fireEvent.click(screen.getByText("添加 MCP"));
    // 只列支持 MCP 的 CLI，默认全勾
    expect(screen.queryByRole("checkbox", { name: "OpenClaw" })).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Claude Code" }));
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "search" } });
    fireEvent.change(screen.getByLabelText("命令"), { target: { value: "npx" } });
    fireEvent.change(screen.getByLabelText("参数（一行一个）"), {
      target: { value: "search-mcp" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存" }));
    });
    expect(client.addRuntimeMcp).toHaveBeenCalledWith(
      "search",
      { transport: "stdio", command: "npx", args: ["search-mcp"], env: {}, enabled: true },
      ["codex"],
    );
  });
});
