// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig, RuntimeProfiles } from "@superhive/protocol";
import type { RuntimeProfilesResult } from "./local-agents";
import { ProfilesSection, type RuntimeProfilesApi } from "./runtime-profiles";

afterEach(cleanup);

const profiles = (overrides: Partial<RuntimeProfiles> = {}): RuntimeProfiles => ({
  provider: "claude",
  profiles: [
    {
      id: "p1",
      name: "Kimi",
      baseUrl: "https://api.••••.com/…",
      apiKey: "sk-k••••ijkl",
      active: true,
      source: "hive",
      updatedAt: "2026-11-27T00:00:00.000Z",
    },
    {
      id: "p2",
      name: "opus-gw",
      baseUrl: "https://gw.e••••.com",
      apiKey: "sk-g••••6789",
      active: false,
      source: "cc-switch",
      updatedAt: "2026-11-27T00:00:00.000Z",
    },
  ],
  official: { active: false, login: "no", loginCommand: "claude auth login", leftover: [] },
  unsaved: false,
  ccSwitch: {
    current: "claude-opus-5",
    currentProfile: "opus-gw",
    providers: [
      {
        id: "c1",
        name: "fable-5",
        baseUrl: "https://fa.••••.com",
        apiKey: "sk-f••••0000",
        current: false,
        imported: false,
      },
      {
        id: "c2",
        name: "opus-gw",
        baseUrl: "https://gw.e••••.com",
        apiKey: "sk-g••••6789",
        current: true,
        imported: true,
      },
    ],
  },
  ...overrides,
});

const result = (next: RuntimeProfiles, extra: Partial<RuntimeProfilesResult> = {}) =>
  ({
    config: {} as RuntimeConfig,
    agents: [],
    profiles: next,
    ...extra,
  }) satisfies RuntimeProfilesResult;

function api(initial = profiles()) {
  return {
    runtimeProfiles: vi.fn(async () => result(initial)),
    createRuntimeProfile: vi.fn(async () => result(initial)),
    updateRuntimeProfile: vi.fn(async () => result(initial)),
    deleteRuntimeProfile: vi.fn(async () => result(initial)),
    switchRuntimeProfile: vi.fn(async () =>
      result(
        profiles({
          official: {
            active: true,
            login: "no",
            loginCommand: "claude auth login",
            leftover: ["env.ANTHROPIC_MODEL = glm-5"],
          },
          profiles: initial.profiles.map((item) => ({ ...item, active: false })),
        }),
        { saved: "gw.example.com" },
      ),
    ),
    importCcSwitchProviders: vi.fn(async () => result(initial, { imported: 1 })),
    openRuntimeLogin: vi.fn(async () => undefined),
  } satisfies RuntimeProfilesApi;
}

function renderSection(client = api()) {
  const onSaved = vi.fn();
  render(
    <ProfilesSection
      api={client}
      provider="claude"
      label="Claude Code"
      file="~/.claude/settings.json"
      onSaved={onSaved}
    />,
  );
  return { client, onSaved };
}

const confirm = (name: string) =>
  act(async () => {
    fireEvent.click(
      screen.getByRole("dialog", { name }).querySelector<HTMLButtonElement>("button:last-child")!,
    );
  });

describe("ProfilesSection", () => {
  it("lists the official subscription and saved profiles with masked keys only", async () => {
    renderSection();
    await screen.findByText("Kimi");
    expect(screen.getByText("官方订阅")).toBeTruthy();
    expect(screen.getByText("未登录")).toBeTruthy();
    expect(screen.getByText("当前")).toBeTruthy();
    expect(screen.getByText("来自 cc-switch")).toBeTruthy();
    expect(document.body.textContent).toContain("sk-k••••ijkl");
    // cc-switch 也在管：提示当前供应商不同步
    expect(screen.getByRole("note").textContent).toContain("claude-opus-5");
  });

  it("switches after confirming and reports the auto-saved original config", async () => {
    const { client, onSaved } = renderSection();
    await screen.findByText("Kimi");
    const [officialSwitch] = screen.getAllByRole("button", { name: "切换" });
    fireEvent.click(officialSwitch!);
    expect(client.switchRuntimeProfile).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "确认切换到 官方订阅" });
    // 没登录：确认提示里写明去终端登录
    expect(dialog.textContent).toContain("claude auth login");
    expect(dialog.textContent).toContain("~/.claude/settings.json");
    await confirm("确认切换到 官方订阅");
    expect(client.switchRuntimeProfile).toHaveBeenCalledWith("claude", { official: true });
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toContain("gw.example.com");
    expect(document.body.textContent).toContain("env.ANTHROPIC_MODEL = glm-5");
  });

  it("opens the login command in a terminal instead of signing in", async () => {
    const { client } = renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "在终端登录" }));
    await waitFor(() => expect(client.openRuntimeLogin).toHaveBeenCalledWith("claude"));
    expect((await screen.findByRole("status")).textContent).toContain("已打开终端");
  });

  it("adds a profile only with a valid URL and key", async () => {
    const { client } = renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "添加" }));
    const save = screen.getByRole("button", { name: "保存" });
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "GLM" } });
    fireEvent.change(screen.getByLabelText("接口地址（base URL）"), {
      target: { value: "not a url" },
    });
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-glm-1234567890" } });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("接口地址（base URL）"), {
      target: { value: "https://open.example.cn/anthropic" },
    });
    await act(async () => {
      fireEvent.click(save);
    });
    expect(client.createRuntimeProfile).toHaveBeenCalledWith("claude", {
      name: "GLM",
      baseUrl: "https://open.example.cn/anthropic",
      apiKey: "sk-glm-1234567890",
    });
  });

  it("edits a name without resending the key, and imports from cc-switch", async () => {
    const { client } = renderSection();
    await screen.findByText("Kimi");
    // 每行只有「切换」一个按钮，编辑、删除收在「⋯」里
    expect(screen.queryByRole("button", { name: "编辑" })).toBeNull();
    expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Kimi 的更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "编辑" }));
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "Kimi K3" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存" }));
    });
    expect(client.updateRuntimeProfile).toHaveBeenCalledWith("claude", "p1", { name: "Kimi K3" });

    // 只列还没导入的
    fireEvent.click(screen.getByRole("button", { name: "从 cc-switch 导入（1）" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "导入 1 套" }));
    });
    expect(client.importCcSwitchProviders).toHaveBeenCalledWith("claude", ["c1"]);
  });

  it("deletes from the ⋯ menu only after confirming, and the menu closes with Esc", async () => {
    const { client } = renderSection();
    const more = await screen.findByRole("button", { name: "opus-gw 的更多操作" });
    fireEvent.click(more);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(more);
    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
    expect(client.deleteRuntimeProfile).not.toHaveBeenCalled();
    await confirm("确认删除 opus-gw");
    expect(client.deleteRuntimeProfile).toHaveBeenCalledWith("claude", "p2");
  });

  it("disables switching and explains why when the config can't be switched", async () => {
    renderSection(
      api(profiles({ note: "cc-switch 正在用本机代理接管这个运行时", ccSwitch: null })),
    );
    await screen.findByText("Kimi");
    expect(document.body.textContent).toContain("代理接管");
    for (const button of screen.getAllByRole("button", { name: "切换" })) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });
});
