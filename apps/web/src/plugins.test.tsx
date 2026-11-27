// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalPlugin, PluginSummary } from "@superhive/protocol";
import {
  PluginSidePanel,
  PluginsSettingsPanel,
  pluginPanelKey,
  type LocalPluginsApi,
} from "./plugins";

const summary: PluginSummary = {
  id: "dice",
  name: "骰子",
  version: "0.1.0",
  description: "",
  permissions: ["members:read", "composer:write"],
  panels: [{ id: "main", title: "骰子", entry: "panel.html" }],
  commands: [{ name: "roll", description: "掷骰子", panel: "main" }],
};

const context = {
  roomId: "general",
  locale: "zh-CN",
  theme: "dark" as const,
  viewer: "owner" as const,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("右侧栏插件面板", () => {
  it("凭登录换限时地址，iframe 无同源沙箱；加载后把 / 命令交给面板", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ url: "/api/plugin-frames/tok/panel.html" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const props = {
      plugins: [summary],
      active: undefined,
      setActive: vi.fn(),
      base: "http://hive.test",
      authToken: "token",
      roomId: "general",
      context,
      api: { messages: vi.fn(() => []), members: vi.fn(() => []), insertIntoComposer: vi.fn() },
    };
    const { container, rerender } = render(<PluginSidePanel {...props} command={undefined} />);
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    expect(fetchMock).toHaveBeenCalledWith(
      "http://hive.test/api/rooms/general/plugins/dice/panels/main/frame",
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: "Bearer token" },
      }),
    );
    const frame = container.querySelector("iframe")!;
    expect(frame.getAttribute("src")).toBe("http://hive.test/api/plugin-frames/tok/panel.html");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    // 权限说明随面板一起显示
    expect(screen.getByText("读取房间成员 · 往输入框里填文字")).toBeTruthy();

    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    const command = { key: pluginPanelKey("dice", "main"), name: "roll", args: "2d6", nonce: 1 };
    // 面板还没加载完：先存着
    rerender(<PluginSidePanel {...props} command={command} />);
    expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ event: "command" }), "*");
    fireEvent.load(frame);
    expect(post).toHaveBeenCalledWith(
      { superhive: 1, kind: "event", event: "command", data: { name: "roll", args: "2d6" } },
      "*",
    );
    // 同一个 nonce 不重复送；再输一次（新 nonce）照送
    post.mockClear();
    rerender(<PluginSidePanel {...props} command={{ ...command }} />);
    expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ event: "command" }), "*");
    rerender(<PluginSidePanel {...props} command={{ ...command, nonce: 2 }} />);
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ event: "command" }), "*");
  });

  it("面板地址取不到时说明原因", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 404 })),
    );
    render(
      <PluginSidePanel
        plugins={[summary]}
        active={undefined}
        setActive={vi.fn()}
        command={undefined}
        base=""
        authToken="token"
        roomId="general"
        context={context}
        api={{ messages: () => [], members: () => [], insertIntoComposer: vi.fn() }}
      />,
    );
    expect((await screen.findByRole("alert")).textContent).toContain("404");
  });
});

function localPlugin(patch: Partial<LocalPlugin> = {}): LocalPlugin {
  return {
    id: "dice",
    name: "骰子",
    version: "0.2.0",
    description: "掷骰子",
    dir: "/data/plugins/dice",
    requested: ["members:read", "composer:write"],
    guests: false,
    panels: [{ id: "main", title: "骰子", entry: "panel.html" }],
    commands: [{ name: "roll", description: "掷骰子", panel: "main" }],
    mcpServers: [
      {
        name: "dice",
        command: "node",
        args: ["./mcp.mjs"],
        description: "给 Agent 一个 roll_dice 工具",
        providers: [],
        state: "pending",
      },
    ],
    state: "needs-approval",
    ...patch,
  };
}

function settingsApi(plugins: LocalPlugin[]): LocalPluginsApi & {
  plugins: ReturnType<typeof vi.fn>;
} {
  return {
    plugins: vi.fn(async () => ({
      dir: "/data/plugins",
      mcpProviders: ["claude", "codex"] as const,
      plugins,
    })) as never,
    grantPlugin: vi.fn(async () => plugins[0]!),
    revokePlugin: vi.fn(async () => undefined),
    setPluginMcp: vi.fn(async () => plugins[0]!),
  };
}

describe("设置 · 插件", () => {
  it("列出权限说明，批准后刷新；MCP 要先批准插件", async () => {
    const api = settingsApi([localPlugin()]);
    render(<PluginsSettingsPanel api={api} />);
    expect(await screen.findByText("读取房间成员")).toBeTruthy();
    expect(screen.getByText("只填进输入框，发不发由你决定；插件不能替你发消息。")).toBeTruthy();
    expect(screen.getByText("只有你（访客看不到）")).toBeTruthy();
    expect(screen.getByText("先批准插件，再确认 MCP。")).toBeTruthy();
    // 整组放在 disabled 的 fieldset 里
    expect(screen.getByRole("checkbox", { name: "Claude Code" }).matches(":disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "批准" }));
    await waitFor(() => expect(api.grantPlugin).toHaveBeenCalledWith("dice"));
    await waitFor(() => expect(api.plugins).toHaveBeenCalledTimes(2));
  });

  it("升级多申请的权限标出「新增」，按钮变成重新批准", async () => {
    const api = settingsApi([
      localPlugin({
        requested: ["members:read", "room:read"],
        grant: { permissions: ["members:read"], version: "0.1.0", grantedAt: "x" },
      }),
    ]);
    render(<PluginsSettingsPanel api={api} />);
    expect(await screen.findByText("新增")).toBeTruthy();
    expect(screen.getByText("新版本多申请了权限，重新批准前整个插件停用。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "重新批准" })).toBeTruthy();
  });

  it("撤销要确认；逐个勾选运行时写入 MCP", async () => {
    const api = settingsApi([
      localPlugin({
        state: "enabled",
        grant: {
          permissions: ["members:read", "composer:write"],
          version: "0.2.0",
          grantedAt: "x",
        },
      }),
    ]);
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValue(true);
    render(<PluginsSettingsPanel api={api} />);
    const revoke = await screen.findByRole("button", { name: "撤销" });
    fireEvent.click(revoke);
    expect(api.revokePlugin).not.toHaveBeenCalled();
    fireEvent.click(revoke);
    await waitFor(() => expect(api.revokePlugin).toHaveBeenCalledWith("dice"));
    expect(confirm).toHaveBeenCalledTimes(2);

    const save = await screen.findByRole("button", { name: "全部移除" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByRole("checkbox", { name: "Codex CLI" }));
    });
    fireEvent.click(screen.getByRole("button", { name: "确认写入" }));
    await waitFor(() => expect(api.setPluginMcp).toHaveBeenCalledWith("dice", "dice", ["codex"]));
  });

  it("旧版 Server 没有接口时说明原因", async () => {
    const api = settingsApi([]);
    api.plugins.mockRejectedValue(Object.assign(new Error("x"), { status: 404 }));
    render(<PluginsSettingsPanel api={api} />);
    expect(await screen.findByText(/没有开放插件/)).toBeTruthy();
  });
});
