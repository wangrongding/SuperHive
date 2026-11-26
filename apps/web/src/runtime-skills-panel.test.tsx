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
    { provider: "openclaw", mcpSupported: false, mcpCanToggle: false },
  ],
  mcp: [{ name: "docs", entries: [{ provider: "claude", enabled: true, transport: "stdio" }] }],
  skills: [
    {
      name: "pdf",
      entries: [
        { provider: "claude", id: "user/pdf", enabled: true, source: "user", canSync: true },
        { provider: "codex", id: "user/pdf", enabled: false, source: "user", canSync: true },
      ],
    },
  ],
};

describe("RuntimeOverviewBlock", () => {
  it("shows where each MCP and skill is installed, jumps to the CLI, and syncs after confirming", async () => {
    const synced: RuntimeOverview = {
      ...overview,
      mcp: [
        {
          name: "docs",
          entries: [
            { provider: "claude", enabled: true, transport: "stdio" },
            { provider: "codex", enabled: true, transport: "stdio" },
          ],
        },
      ],
    };
    const client = {
      runtimeOverview: vi.fn(async () => overview),
      syncRuntimeMcp: vi.fn(async () => synced),
      syncRuntimeSkill: vi.fn(async () => overview),
    };
    const onJump = vi.fn();
    render(<RuntimeOverviewBlock api={client} onJump={onJump} />);
    await screen.findByText("docs");
    // OpenClaw 不支持 MCP：MCP 表里没有这一列
    const table = screen.getByRole("table");
    expect(within(table).queryByText("OpenClaw")).toBeNull();
    expect(within(table).getByLabelText("Codex 里没有")).toBeTruthy();

    fireEvent.click(within(table).getByRole("button", { name: /docs：已启用，去 Claude Code/ }));
    expect(onJump).toHaveBeenCalledWith("claude", "mcp");

    fireEvent.click(screen.getByText("同步到…"));
    const dialog = screen.getByRole("dialog", { name: "把 docs 同步到其它 CLI" });
    expect(dialog.textContent).toContain("包括环境变量的值");
    expect(within(dialog).getByLabelText("Codex")).toHaveProperty("checked", true);
    await act(async () => {
      fireEvent.click(dialog.querySelector<HTMLButtonElement>("button:last-child")!);
    });
    expect(client.syncRuntimeMcp).toHaveBeenCalledWith("claude", "docs", ["codex"]);
    expect(screen.queryByText("同步到…")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "技能（1）" }));
    const skillsTable = screen.getByRole("table");
    expect(within(skillsTable).getByText("OpenClaw")).toBeTruthy();
    fireEvent.click(within(skillsTable).getByRole("button", { name: /pdf：已停用，去 Codex/ }));
    expect(onJump).toHaveBeenLastCalledWith("codex", "skills");
  });
});
