// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import type {
  LocalAgent,
  LocalAgentMcpResponse,
  LocalAgentModelsResponse,
} from "@superhive/protocol";
import { AgentSettingsDialog, McpChecklist, formatTokens } from "./agent-settings-dialog";
import { setLocalePreference, t, type Locale } from "./i18n";

const agent = {
  id: "00000000-0000-4000-8000-0000000000e1",
  provider: "claude",
  name: "rd-claude",
  access: "full",
  cwd: "/repo",
  model: null,
  effort: null,
  compactWindow: null,
  cacheTtl: null,
  status: "running",
  pid: 1,
  startedAt: null,
  lastExitCode: null,
  lastError: null,
  restarts: 0,
  createdAt: new Date().toISOString(),
  mcpDisabled: [],
  autoSteer: false,
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

const modelList: LocalAgentModelsResponse = {
  source: "runtime",
  models: [{ id: "gpt-a", label: "GPT A", isDefault: true }, { id: "gpt-b" }],
  efforts: [],
};

describe("AgentSettingsDialog", () => {
  afterEach(() => {
    cleanup();
    setLocalePreference("zh-CN");
  });

  it.each<Locale>(["zh-CN", "en"])(
    "keeps grouped fields and header controls labelled and keyboard usable in %s",
    async (locale) => {
      setLocalePreference(locale);
      const user = userEvent.setup();
      const updateSettings = vi.fn(async (_id: string, settings: Partial<LocalAgent>) => ({
        ...agent,
        ...settings,
      }));
      render(
        <AgentSettingsDialog
          agent={agent}
          local={{
            mcpServers: async () => listed,
            updateSettings,
            act: async () => undefined,
            canManage: true,
            logs: async () => [],
            remove: async () => undefined,
            models: async () => ({ ...modelList, efforts: ["low", "high"] }),
          }}
          onClose={() => undefined}
        />,
      );
      const dialog = screen.getByRole("dialog", {
        name: t("{0} 的设置", { 0: agent.name }),
      });
      const header = dialog.querySelector("header")!;
      expect(within(header).getByText(new RegExp(t("运行中")))).toBeTruthy();
      for (const name of [t("重启"), t("立即重启"), t("停止"), t("日志")]) {
        expect(within(header).getByRole("button", { name })).toBeTruthy();
      }

      const model = await screen.findByRole("combobox", { name: t("模型") });
      const effort = await screen.findByRole("combobox", { name: t("思考强度") });
      expect(model.closest(".agent-settings-fields")).toBe(
        effort.closest(".agent-settings-fields"),
      );
      const window = screen.getByRole("combobox", { name: t("自动压缩") });
      const cache = screen.getByRole("combobox", { name: t("缓存时长") });
      expect(window.closest(".agent-settings-fields")).toBe(
        cache.closest(".agent-settings-fields"),
      );

      effort.focus();
      await user.keyboard("{Enter}{End}{Enter}");
      await waitFor(() =>
        expect(updateSettings).toHaveBeenCalledWith(agent.id, { effort: "high" }),
      );
      const steer = screen.getByRole("checkbox", { name: new RegExp(t("人发的消息自动引导")) });
      steer.focus();
      await user.keyboard(" ");
      await waitFor(() =>
        expect(updateSettings).toHaveBeenCalledWith(agent.id, { autoSteer: true }),
      );
      const mcp = await screen.findByRole("checkbox", { name: /chrome-devtools/ });
      expect(mcp.closest("label")?.textContent).toContain(t("全局"));
      expect(mcp.closest("label")?.textContent).toContain("token");
      mcp.focus();
      await user.keyboard(" ");
      await waitFor(() =>
        expect(updateSettings).toHaveBeenCalledWith(agent.id, {
          mcpDisabled: ["chrome-devtools"],
        }),
      );
    },
  );

  it("preserves the shared MCP checklist's full description and labels outside the dialog", () => {
    const onToggle = vi.fn();
    render(
      <McpChecklist
        data={listed}
        failed={false}
        disabled={new Set()}
        measuring={false}
        busy={false}
        onToggle={onToggle}
      />,
    );
    const checkbox = screen.getByRole("checkbox", { name: /rea/ });
    expect(checkbox.closest("label")?.textContent).toContain(
      "全局 · stdio · 207 个工具 · 约 35 万 token",
    );
    fireEvent.click(checkbox);
    expect(onToggle).toHaveBeenCalledWith("rea");
    expect(screen.getByRole("checkbox", { name: /figma.*插件提供，不能在这里开关/ })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /figma/ }).closest("label")?.textContent).toContain(
      "插件 · http · 插件提供，不能在这里开关",
    );
  });

  it("lists MCP sizes, estimates the start cost and saves an unchecked server right away", async () => {
    const mcpServers = vi.fn(async () => listed);
    const updateSettings = vi.fn(async (_id: string, settings: { mcpDisabled: string[] }) => ({
      ...agent,
      mcpDisabled: settings.mcpDisabled,
    }));
    const act = vi.fn(async () => undefined);
    render(
      <AgentSettingsDialog
        agent={agent}
        local={{
          mcpServers,
          updateSettings,
          act,
          canManage: true,
          logs: async () => [],
          remove: async () => undefined,
          models: async () => modelList,
        }}
        onClose={() => undefined}
      />,
    );

    expect(await screen.findByText("207 个工具 · 约 35 万 token")).toBeTruthy();
    // figma 来自插件，不能在这里开关；估算只能在它也有大小时给出
    expect((screen.getByRole("checkbox", { name: /figma/ }) as HTMLInputElement).disabled).toBe(
      true,
    );
    expect(screen.queryByText(/每个新会话开局约/)).toBeNull();

    // 整个弹窗不再有「保存」按钮：勾了就存
    expect(screen.queryByRole("button", { name: /保存/ })).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: /rea/ }));
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith(agent.id, { mcpDisabled: ["rea"] }),
    );
    expect(act).not.toHaveBeenCalled();
    expect(await screen.findByText(/^已保存。从下一次回复开始生效/)).toBeTruthy();
  });

  it("only lists MCP on an owner device without management access: no measuring, no changes", async () => {
    const mcpServers = vi.fn(async () => ({ ...listed, servers: listed.servers.slice(0, 2) }));
    render(
      <AgentSettingsDialog
        agent={agent}
        local={{
          mcpServers,
          updateSettings: async (_id, settings) => ({ ...agent, ...settings }),
          act: async () => undefined,
          canManage: false,
          logs: async () => [],
          remove: async () => undefined,
          models: async () => modelList,
        }}
        onClose={() => undefined}
      />,
    );
    expect(await screen.findByText("这台设备只能查看。要修改，先申请管理权。")).toBeTruthy();
    // 测量会在 Server 所在电脑上起进程，没获批不发
    expect(mcpServers).toHaveBeenCalledTimes(1);
    expect(mcpServers).toHaveBeenCalledWith(agent.id, false);
    for (const box of screen.getAllByRole("checkbox")) {
      expect((box as HTMLInputElement).disabled).toBe(true);
    }
    for (const box of screen.getAllByRole("combobox")) {
      expect((box as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("saves but leaves the restart to the person when the running process predates the settings file", async () => {
    const act = vi.fn(async () => undefined);
    render(
      <AgentSettingsDialog
        agent={{ ...agent, settingsPendingRestart: true }}
        local={{
          mcpServers: async () => ({ ...listed, servers: listed.servers.slice(0, 2) }),
          updateSettings: async (_id, settings) => ({ ...agent, ...settings }),
          act,
          canManage: true,
          logs: async () => [],
          remove: async () => undefined,
          models: async () => modelList,
        }}
        onClose={() => undefined}
      />,
    );
    expect(await screen.findByText(/每个新会话开局约 40 万 token/)).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /rea/ }));
    expect(screen.getByText(/每个新会话开局约 5.2 万 token/)).toBeTruthy();
    // 重启会打断正在执行的任务：只存，提示人点「重启」
    expect(await screen.findByText("已保存。点上面的「重启」后生效。")).toBeTruthy();
    expect(act).not.toHaveBeenCalled();
  });

  it("picks the model from the runtime's list, accepts a typed one and goes back to the default", async () => {
    const models = vi.fn(async () => modelList);
    const updateSettings = vi.fn(async (_id: string, settings: { model?: string | null }) => ({
      ...agent,
      model: settings.model ?? null,
    }));
    render(
      <AgentSettingsDialog
        agent={agent}
        local={{
          mcpServers: async () => listed,
          updateSettings,
          act: async () => undefined,
          canManage: true,
          logs: async () => [],
          remove: async () => undefined,
          models,
        }}
        onClose={() => undefined}
      />,
    );
    const picker = await screen.findByRole("combobox", { name: "模型" });
    await waitFor(() => expect(picker.textContent).toContain("运行时默认"));

    fireEvent.click(picker);
    // 运行时默认那一项写明现在实际是哪个模型
    expect(screen.getByRole("option", { name: /运行时默认.*现在是 GPT A/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: /^gpt-b/ }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith(agent.id, { model: "gpt-b" }));
    expect(await screen.findByText(/^已保存。从下一次回复开始生效/)).toBeTruthy();

    // 手填：打字时不存，按回车才存；离开输入框时同样的值不再发一次
    fireEvent.click(screen.getByRole("combobox", { name: "模型" }));
    fireEvent.click(screen.getByRole("option", { name: /^手动输入/ }));
    const typed = screen.getByRole("textbox", { name: "模型名" });
    fireEvent.change(typed, { target: { value: " my/custom-model " } });
    expect(updateSettings).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(typed, { key: "Enter" });
    await waitFor(() =>
      expect(updateSettings).toHaveBeenLastCalledWith(agent.id, { model: "my/custom-model" }),
    );
    await waitFor(() => expect((typed as HTMLInputElement).value).toBe("my/custom-model"));
    fireEvent.blur(typed);
    await screen.findByText(/^已保存。/);
    expect(updateSettings).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("combobox", { name: "模型" }));
    fireEvent.click(screen.getByRole("option", { name: /^运行时默认/ }));
    await waitFor(() => expect(updateSettings).toHaveBeenLastCalledWith(agent.id, { model: null }));

    // 刷新：让 Server 重新拉一次
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(models).toHaveBeenLastCalledWith(agent.id, true));
  });

  it("picks a reasoning effort that follows the chosen model and saves it with the model", async () => {
    const codexModels: LocalAgentModelsResponse = {
      source: "runtime",
      models: [
        { id: "gpt-a", isDefault: true, efforts: ["low", "high"], defaultEffort: "high" },
        { id: "gpt-b", efforts: ["xhigh"], defaultEffort: "xhigh" },
      ],
      efforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
    };
    const updateSettings = vi.fn(
      async (_id: string, settings: { model?: string | null; effort?: string | null }) => {
        current = { ...current, ...settings };
        return current;
      },
    );
    let current: LocalAgent = { ...agent, provider: "codex" };
    render(
      <AgentSettingsDialog
        agent={{ ...agent, provider: "codex" }}
        local={{
          mcpServers: async () => listed,
          updateSettings,
          act: async () => undefined,
          canManage: true,
          logs: async () => [],
          remove: async () => undefined,
          models: async () => codexModels,
        }}
        onClose={() => undefined}
      />,
    );
    const effort = await screen.findByRole("combobox", { name: "思考强度" });
    expect(effort.textContent).toContain("跟随 CLI 配置");
    fireEvent.click(effort);
    // 运行时默认模型 gpt-a 只有 low、high 两档，并写明默认档
    expect(
      screen.getByRole("option", { name: /跟随 CLI 配置.*这个模型默认是 高 · high/ }),
    ).toBeTruthy();
    expect(screen.queryByRole("option", { name: /xhigh/ })).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: /^低 · low/ }));
    // 只发改了的那一项：审计只记「思考强度」这一笔
    await waitFor(() =>
      expect(updateSettings).toHaveBeenLastCalledWith(agent.id, { effort: "low" }),
    );

    // 换到 gpt-b：low 它不支持，仍列出并提示
    fireEvent.click(screen.getByRole("combobox", { name: "模型" }));
    fireEvent.click(screen.getByRole("option", { name: /^gpt-b/ }));
    await waitFor(() =>
      expect(updateSettings).toHaveBeenLastCalledWith(agent.id, { model: "gpt-b" }),
    );
    expect(screen.getByText(/当前模型不支持 low/)).toBeTruthy();
    fireEvent.click(screen.getByRole("combobox", { name: "思考强度" }));
    fireEvent.click(screen.getByRole("option", { name: /^很高 · xhigh/ }));
    expect(screen.queryByText(/当前模型不支持/)).toBeNull();
    await waitFor(() =>
      expect(updateSettings).toHaveBeenLastCalledWith(agent.id, { effort: "xhigh" }),
    );
  });

  it("hides the reasoning effort for runtimes that cannot switch it", async () => {
    render(
      <AgentSettingsDialog
        agent={{ ...agent, provider: "opencode" }}
        local={{
          mcpServers: async () => listed,
          updateSettings: async () => agent,
          act: async () => undefined,
          canManage: true,
          logs: async () => [],
          remove: async () => undefined,
          models: async () => modelList,
        }}
        onClose={() => undefined}
      />,
    );
    await screen.findByRole("combobox", { name: "模型" });
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "模型" }).textContent).toContain("运行时默认"),
    );
    expect(screen.queryByRole("combobox", { name: "思考强度" })).toBeNull();
  });

  it("shows the model the last turn in this room actually used, even on the runtime default", async () => {
    render(
      <AgentSettingsDialog
        agent={agent}
        lastModel={{ id: "claude-opus-5-5", effort: "high", at: "2026-11-26T00:00:00.000Z" }}
        local={{
          mcpServers: async () => listed,
          updateSettings: async () => agent,
          act: async () => undefined,
          canManage: true,
          logs: async () => [],
          remove: async () => undefined,
          models: async () => modelList,
        }}
        onClose={() => undefined}
      />,
    );
    const note = await screen.findByText(/这个房间上一轮实际用的是/);
    expect(note.textContent).toContain("Opus 5.5（claude-opus-5-5）");
    expect(note.textContent).toContain("思考强度");
  });

  it("sets Claude's auto-compact threshold and cache duration, defaulting to 400k", async () => {
    let current: LocalAgent = agent;
    const updateSettings = vi.fn(
      async (
        _id: string,
        settings: { compactWindow?: number | "auto" | null; cacheTtl?: "5m" | "1h" | null },
      ) => {
        current = { ...current, ...settings };
        return current;
      },
    );
    render(
      <AgentSettingsDialog
        agent={agent}
        local={{
          mcpServers: async () => listed,
          updateSettings,
          act: async () => undefined,
          canManage: true,
          logs: async () => [],
          remove: async () => undefined,
          models: async () => modelList,
        }}
        onClose={() => undefined}
      />,
    );
    const compact = await screen.findByRole("combobox", { name: "自动压缩" });
    // 没设过：显示默认 40 万；缓存时长跟随 Claude Code
    expect(compact.textContent).toContain("40 万 token（默认）");
    const ttl = screen.getByRole("combobox", { name: "缓存时长" });
    expect(ttl.textContent).toContain("跟随 Claude Code（默认）");
    // 不是主 Agent：不提示按 1 小时
    expect(screen.queryByRole("note")).toBeNull();

    fireEvent.click(ttl);
    fireEvent.click(screen.getByRole("option", { name: /^1 小时/ }));
    // 选 1 小时：注明写缓存更贵，并且立即保存
    expect(screen.getByRole("note").textContent).toContain("1.25 倍变成 2 倍");
    await waitFor(() =>
      expect(updateSettings).toHaveBeenLastCalledWith(agent.id, { cacheTtl: "1h" }),
    );
    fireEvent.click(compact);
    fireEvent.click(screen.getByRole("option", { name: /^自定义/ }));
    // 选「自定义…」先不存，等填好数字
    expect(updateSettings).toHaveBeenCalledTimes(1);
    const custom = screen.getByRole("spinbutton", { name: "自定义压缩阈值（token）" });
    fireEvent.change(custom, { target: { value: "50000" } });
    fireEvent.blur(custom);
    expect(screen.getByText(/填 100,000～2,000,000 之间的整数/)).toBeTruthy();
    expect(updateSettings).toHaveBeenCalledTimes(1);
    fireEvent.change(custom, { target: { value: "300000" } });
    fireEvent.keyDown(custom, { key: "Enter" });
    await waitFor(() =>
      expect(updateSettings).toHaveBeenLastCalledWith(agent.id, { compactWindow: 300_000 }),
    );
    expect(await screen.findByText(/^已保存。从下一次回复开始生效/)).toBeTruthy();
    // 存好了还留在自定义框里
    expect(screen.getByRole("spinbutton", { name: "自定义压缩阈值（token）" })).toBeTruthy();

    // 改回默认档：存成「没设过」
    fireEvent.click(screen.getByRole("combobox", { name: "自动压缩" }));
    fireEvent.click(screen.getByRole("option", { name: /40 万 token（默认）/ }));
    await waitFor(() =>
      expect(updateSettings).toHaveBeenLastCalledWith(agent.id, { compactWindow: null }),
    );
    expect(updateSettings).toHaveBeenCalledTimes(3);
  });

  it("tells that the room's lead agent caches for 1 hour when following Claude Code", async () => {
    render(
      <AgentSettingsDialog
        agent={agent}
        lead
        local={{
          mcpServers: async () => listed,
          updateSettings: async () => agent,
          act: async () => undefined,
          canManage: true,
          logs: async () => [],
          remove: async () => undefined,
          models: async () => modelList,
        }}
        onClose={() => undefined}
      />,
    );
    const ttl = await screen.findByRole("combobox", { name: "缓存时长" });
    expect(screen.getByRole("note").textContent).toContain("本房间的主 Agent");
    fireEvent.click(ttl);
    expect(screen.getByRole("option", { name: /跟随 Claude Code/ }).textContent).toContain(
      "主 Agent 默认 1 小时",
    );
    // 人手动选了 5 分钟：以人选的为准，不再提示
    fireEvent.click(screen.getByRole("option", { name: /^5 分钟/ }));
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("only shows the context settings for Claude", async () => {
    render(
      <AgentSettingsDialog
        agent={{ ...agent, provider: "codex" }}
        local={{
          mcpServers: async () => listed,
          updateSettings: async () => agent,
          act: async () => undefined,
          canManage: true,
          logs: async () => [],
          remove: async () => undefined,
          models: async () => modelList,
        }}
        onClose={() => undefined}
      />,
    );
    await screen.findByRole("combobox", { name: "模型" });
    expect(screen.queryByRole("combobox", { name: "自动压缩" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "缓存时长" })).toBeNull();
  });

  it("shows why the model list could not be fetched and still allows typing one", async () => {
    render(
      <AgentSettingsDialog
        agent={{ ...agent, model: "legacy-model" }}
        local={{
          mcpServers: async () => listed,
          updateSettings: async () => agent,
          act: async () => undefined,
          canManage: true,
          logs: async () => [],
          remove: async () => undefined,
          models: async () => ({
            source: "preset",
            models: [],
            efforts: [],
            error: "spawn codex ENOENT",
          }),
        }}
        onClose={() => undefined}
      />,
    );
    expect(await screen.findByText(/没能从运行时拉到模型列表（spawn codex ENOENT）/)).toBeTruthy();
    // 设置里的模型不在列表里：直接显示在手填框里
    expect((screen.getByRole("textbox", { name: "模型名" }) as HTMLInputElement).value).toBe(
      "legacy-model",
    );
  });

  it("rolls a failed save back to the saved value and says why", async () => {
    const updateSettings = vi.fn(async () => {
      throw new Error("设置文件写不进去");
    });
    render(
      <AgentSettingsDialog
        agent={agent}
        local={{
          mcpServers: async () => listed,
          updateSettings,
          act: async () => undefined,
          canManage: true,
          logs: async () => [],
          remove: async () => undefined,
          models: async () => modelList,
        }}
        onClose={() => undefined}
      />,
    );
    const steer = screen.getByRole("checkbox", { name: /人发的消息自动引导/ }) as HTMLInputElement;
    fireEvent.click(steer);
    expect(steer.checked).toBe(true);
    expect(await screen.findByText("保存失败：设置文件写不进去。已恢复原来的设置。")).toBeTruthy();
    expect(steer.checked).toBe(false);

    const picker = await screen.findByRole("combobox", { name: "模型" });
    await waitFor(() => expect(picker.textContent).toContain("运行时默认"));
    fireEvent.click(picker);
    fireEvent.click(screen.getByRole("option", { name: /^gpt-b/ }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "模型" }).textContent).toContain("运行时默认"),
    );
  });

  it("sends one save at a time and only the latest of quick changes", async () => {
    const calls: Array<{ settings: { mcpDisabled?: string[] }; resolve: () => void }> = [];
    let current: LocalAgent = agent;
    const updateSettings = vi.fn(
      (_id: string, settings: { mcpDisabled?: string[] }) =>
        new Promise<LocalAgent>((resolve) => {
          calls.push({
            settings,
            resolve: () => {
              current = { ...current, ...settings };
              resolve(current);
            },
          });
        }),
    );
    render(
      <AgentSettingsDialog
        agent={agent}
        local={{
          mcpServers: async () => listed,
          updateSettings,
          act: async () => undefined,
          canManage: true,
          logs: async () => [],
          remove: async () => undefined,
          models: async () => modelList,
        }}
        onClose={() => undefined}
      />,
    );
    const rea = await screen.findByRole("checkbox", { name: /rea/ });
    const chrome = screen.getByRole("checkbox", { name: /chrome-devtools/ });
    fireEvent.click(rea);
    expect(await screen.findByText("保存中…")).toBeTruthy();
    // 第一个还没回来：后面几下只记最新的一次
    fireEvent.click(chrome);
    fireEvent.click(rea);
    expect(updateSettings).toHaveBeenCalledTimes(1);
    calls[0]!.resolve();
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(2));
    expect(calls[1]!.settings).toEqual({ mcpDisabled: ["chrome-devtools"] });
    calls[1]!.resolve();
    expect(await screen.findByText(/^已保存。/)).toBeTruthy();
    expect(updateSettings).toHaveBeenCalledTimes(2);
    expect((rea as HTMLInputElement).checked).toBe(true);
    expect((chrome as HTMLInputElement).checked).toBe(false);
  });

  it("formats token counts", () => {
    expect(formatTokens(800)).toBe("800");
    expect(formatTokens(12_000)).toBe("1.2 万");
    expect(formatTokens(350_000)).toBe("35 万");
  });

  it("restarts or stops the agent right from its settings, and starts it again once stopped", async () => {
    const act = vi.fn(async () => undefined);
    const props = {
      mcpServers: vi.fn(async () => listed),
      updateSettings: vi.fn(async () => agent),
      act,
      canManage: true,
      logs: vi.fn(async () => ["[hive] 已加入 #build"]),
      remove: vi.fn(async () => undefined),
      models: vi.fn(async () => modelList),
    };
    const { rerender } = render(
      <AgentSettingsDialog agent={agent} local={props} onClose={() => undefined} />,
    );
    expect(screen.getByText("运行中 · 版本未上报 · 空闲")).toBeTruthy();
    // 「重启」等它空闲；「立即重启」要先确认
    expect(screen.getByRole("button", { name: "立即重启" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重启" }));
    await waitFor(() => expect(act).toHaveBeenCalledWith(agent.id, "restart"));
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    await waitFor(() => expect(act).toHaveBeenCalledWith(agent.id, "stop"));

    rerender(
      <AgentSettingsDialog
        agent={{ ...agent, status: "stopped" }}
        local={props}
        onClose={() => undefined}
      />,
    );
    expect(screen.queryByRole("button", { name: "重启" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "启动" }));
    await waitFor(() => expect(act).toHaveBeenCalledWith(agent.id, "start"));

    // 日志和删除也在这里（不再单独放一块本机 Agent 列表）
    fireEvent.click(screen.getByRole("button", { name: "日志" }));
    expect(await screen.findByText(/已加入 #build/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    const confirm = screen.getByRole("alert");
    fireEvent.click(within(confirm).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(props.remove).toHaveBeenCalledWith(agent.id));
  });
});
