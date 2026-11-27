// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  LocalAgent,
  McpCatalog,
  McpHealth,
  RuntimeInstallPlan,
  RuntimeInstallRequest,
  RuntimeInstallResult,
  RuntimeOverview,
} from "@superhive/protocol";
import { LocalApiError } from "./local-agents";
import { RuntimeHubDialog, type RuntimeHubApi } from "./runtime-hub";
import { RuntimeOverviewBlock } from "./runtime-overview";
import { McpStore } from "./runtime-store";

afterEach(cleanup);

const TOKEN = "ghp_store_secret";

const overview: RuntimeOverview = {
  providers: [
    { provider: "claude", mcpSupported: true, mcpCanToggle: false },
    { provider: "codex", mcpSupported: true, mcpCanToggle: true },
    { provider: "opencode", mcpSupported: true, mcpCanToggle: true },
    {
      provider: "openclaw",
      mcpSupported: false,
      mcpCanToggle: false,
      mcpNote: "OpenClaw 还不支持在配置文件里管理 MCP",
    },
  ],
  mcp: [
    {
      name: "deepwiki",
      entries: [
        { provider: "claude", enabled: true, transport: "http" },
        { provider: "codex", enabled: true, transport: "http" },
        { provider: "opencode", enabled: true, transport: "http" },
      ],
    },
  ],
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
      description: { zh: "GitHub 官方 MCP", en: "GitHub MCP" },
      tagline: {
        zh: "让 Agent 看和处理 GitHub 上的仓库、问题和 PR",
        en: "Work with GitHub",
      },
      category: "code",
      docs: "https://github.com/github/github-mcp-server",
      transport: "http",
      url: "https://api.githubcopilot.com/mcp/",
      headers: { Authorization: "Bearer {token}" },
      params: [
        {
          id: "token",
          label: { zh: "GitHub 令牌", en: "GitHub token" },
          help: { zh: "在 GitHub 新建一个令牌", en: "Create a token" },
          kind: "secret",
          required: true,
          getUrl: "https://github.com/settings/personal-access-tokens/new",
        },
      ],
      runtimes: ["claude", "codex", "opencode", "omp", "copilot"],
    },
    {
      id: "chrome-devtools",
      name: "chrome-devtools",
      title: "Chrome DevTools",
      publisher: "Google",
      description: { zh: "控制 Chrome", en: "Drive Chrome" },
      tagline: { zh: "让 Agent 打开和检查你的 Chrome 浏览器", en: "Drive Chrome" },
      category: "browser",
      badge: { zh: "需要 Chrome", en: "Needs Chrome" },
      docs: "https://github.com/ChromeDevTools/chrome-devtools-mcp",
      transport: "stdio",
      command: "npx",
      args: ["-y", "chrome-devtools-mcp@1.14.0"],
      params: [],
      // 只能装进 Claude Code 和 Codex：opencode 收进「为什么没有」
      runtimes: ["claude", "codex"],
    },
    {
      id: "deepwiki",
      name: "deepwiki",
      title: "DeepWiki",
      publisher: "Cognition",
      description: { zh: "问公开仓库", en: "Ask repos" },
      tagline: { zh: "问任何公开 GitHub 项目是怎么回事", en: "Ask repos" },
      category: "docs",
      docs: "https://docs.devin.ai/work-with-devin/deepwiki-mcp",
      transport: "http",
      url: "https://mcp.deepwiki.com/mcp",
      params: [],
      runtimes: ["claude", "codex", "opencode"],
    },
  ],
};

function agent(id: string, name: string, provider: string, busy = false): LocalAgent {
  return { id, name, provider, status: "running", busy } as unknown as LocalAgent;
}

function planFor(request: RuntimeInstallRequest, id = "plan-1"): RuntimeInstallPlan {
  return {
    id,
    expiresAt: Date.now() + 600_000,
    recipeId: request.recipeId,
    catalogVersion: "test",
    name: request.name,
    transport: "http",
    env: [],
    headers: [],
    targets: request.targets.map((provider) => ({
      provider,
      file: `~/.${provider}/config`,
      agents:
        provider === "claude"
          ? [{ id: "a1", name: "rd-claude", status: "running" }]
          : provider === "codex"
            ? [
                { id: "a2", name: "rd-codex", status: "running" },
                { id: "a3", name: "rd-codex2", status: "stopped" },
              ]
            : [],
    })),
  };
}

function storeApi(options: { fail?: "codex"; staleOnce?: boolean } = {}) {
  let stale = options.staleOnce ?? false;
  const agents = [
    agent("a1", "rd-claude", "claude"),
    agent("a2", "rd-codex", "codex", true),
    agent("a3", "rd-codex2", "codex"),
  ];
  const api = {
    runtimeOverview: vi.fn(async () => overview),
    runtimeInstallCatalog: vi.fn(async () => catalog),
    previewRuntimeInstall: vi.fn(async (request: RuntimeInstallRequest) =>
      planFor(request, `plan-${api.previewRuntimeInstall.mock.calls.length}`),
    ),
    applyRuntimeInstall: vi.fn(
      async (
        request: RuntimeInstallRequest & { planId: string },
      ): Promise<RuntimeInstallResult> => {
        if (stale) {
          stale = false;
          throw new LocalApiError("配置文件在预览之后被改过", 409, "plan_stale", {});
        }
        return {
          results: request.targets.map((provider) =>
            provider === options.fail
              ? { provider, ok: false, file: "~/.codex/config.toml", error: "EACCES: 没有写入权限" }
              : { provider, ok: true, file: `~/.${provider}/config` },
          ),
          overview,
        };
      },
    ),
    verifyRuntimeMcp: vi.fn(async (): Promise<McpHealth> => ({
      ok: true,
      tools: 3,
      tokens: 1200,
      checkedAt: 1,
    })),
    agents,
    refreshAgents: vi.fn(async () => undefined),
    act: vi.fn(async () => undefined),
    syncRuntimeSkill: vi.fn(),
    syncRuntimeMcp: vi.fn(),
    addRuntimeMcp: vi.fn(),
    toggleRuntimeMcp: vi.fn(),
    deleteRuntimeMcp: vi.fn(),
    toggleRuntimeSkill: vi.fn(),
  };
  return api;
}

const asApi = (api: ReturnType<typeof storeApi>) => api as unknown as RuntimeHubApi;

describe("MCP 商店", () => {
  it("卡片写人话：一句话说明、免费 / 需要密钥标签、已安装到几个 CLI；搜索和分类能筛", async () => {
    render(<McpStore api={asApi(storeApi())} />);
    const grid = await screen.findByRole("list", { name: "可以安装的 MCP" });
    const cards = within(grid).getAllByRole("listitem");
    expect(cards).toHaveLength(3);

    const github = cards[0]!;
    expect(github.textContent).toContain("让 Agent 看和处理 GitHub 上的仓库、问题和 PR");
    expect(github.textContent).toContain("需要密钥");
    expect(within(github).getByRole("button", { name: "安装 GitHub" }).textContent).toBe("安装");

    const chrome = cards[1]!;
    expect(chrome.textContent).toContain("免费");
    expect(chrome.textContent).toContain("需要 Chrome");

    // DeepWiki 已在全部 3 个能装的 CLI 里：不再给安装按钮
    const deepwiki = cards[2]!;
    expect(deepwiki.textContent).toContain("已安装到 3 个 CLI");
    expect(within(deepwiki).queryByRole("button")).toBeNull();

    // 不出现开发者术语
    const text = document.body.textContent ?? "";
    for (const word of ["远程地址", "请求头", "冻结", "argv", "transport", "stdio"]) {
      expect(text).not.toContain(word);
    }

    fireEvent.click(screen.getByRole("button", { name: "浏览器" }));
    expect(within(grid).getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "浏览器" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索" }), {
      target: { value: "文档" },
    });
    expect(screen.queryByText("GitHub")).toBeNull();
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索" }), {
      target: { value: "没有这种东西" },
    });
    expect(screen.getByText("没有找到，换个词试试。")).toBeTruthy();
  });

  it("抽屉默认勾上所有能装的 CLI，不能装的收进「为什么没有」，详细信息默认折叠", async () => {
    render(<McpStore api={asApi(storeApi())} />);
    fireEvent.click(await screen.findByRole("button", { name: "安装 Chrome DevTools" }));
    const drawer = screen.getByRole("dialog", { name: "安装 Chrome DevTools" });
    expect(within(drawer).getByText("不用填任何东西。")).toBeTruthy();

    const group = within(drawer).getByRole("group", { name: "装到哪些 CLI" });
    const switches = within(group).getAllByRole("switch");
    expect(switches.map((item) => item.textContent)).toEqual(["Claude Code", "Codex"]);
    expect(switches.every((item) => item.getAttribute("aria-checked") === "true")).toBe(true);

    const why = within(drawer).getByText("为什么没有 opencode、OpenClaw").closest("details")!;
    expect(why.open).toBe(false);
    expect(why.textContent).toContain("opencode 用不了这个");

    const details = within(drawer).getByText("详细信息").closest("details")!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain("npx -y chrome-devtools-mcp@1.14.0");
    expect(details.textContent).toContain("rd-claude");

    // 关掉一个 CLI
    fireEvent.click(switches[1]!);
    expect(switches[1]!.getAttribute("aria-checked")).toBe("false");

    // Esc 只收起抽屉
    fireEvent.keyDown(drawer, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "安装 Chrome DevTools" })).toBeNull();
    expect(screen.getByRole("list", { name: "可以安装的 MCP" })).toBeTruthy();
  });

  it("只填密钥就能装：后台先预览再按同一份计划写，结果用人话说，重启时跳过正在干活的", async () => {
    const api = storeApi();
    render(<McpStore api={asApi(api)} />);
    fireEvent.click(await screen.findByRole("button", { name: "安装 GitHub" }));
    const drawer = screen.getByRole("dialog", { name: "安装 GitHub" });
    const install = within(drawer).getByRole("button", { name: "安装" });
    expect((install as HTMLButtonElement).disabled).toBe(true);

    const link = within(drawer).getByRole("link", { name: "去哪拿这个密钥 ↗" });
    expect(link.getAttribute("href")).toBe(
      "https://github.com/settings/personal-access-tokens/new",
    );
    const input = within(drawer).getByLabelText(/GitHub 令牌/) as HTMLInputElement;
    expect(input.type).toBe("password");
    fireEvent.change(input, { target: { value: TOKEN } });
    expect(within(drawer).getByText(/密钥会按各 CLI 自己的方式存进它们的配置文件/)).toBeTruthy();

    await act(async () => {
      fireEvent.click(install);
    });
    const request = {
      recipeId: "github",
      name: "github",
      params: { token: TOKEN },
      targets: ["claude", "codex", "opencode"],
    };
    expect(api.previewRuntimeInstall).toHaveBeenCalledWith(request);
    expect(api.applyRuntimeInstall).toHaveBeenCalledWith({ ...request, planId: "plan-1" });

    const done = await within(drawer).findByRole("status");
    expect(done.textContent).toContain("已装好：Claude Code、Codex、opencode");
    // 只列正在运行的；停着的下次启动自然会加载
    expect(done.textContent).toContain("重启这些 Agent 后生效：rd-claude、rd-codex");
    expect(done.textContent).not.toContain("rd-codex2");
    expect(drawer.textContent).not.toContain(TOKEN);

    await act(async () => {
      fireEvent.click(within(drawer).getByRole("button", { name: "现在重启它们" }));
    });
    expect(api.refreshAgents).toHaveBeenCalled();
    expect(api.act).toHaveBeenCalledTimes(1);
    expect(api.act).toHaveBeenCalledWith("a1", "restart");
    const lines = within(done)
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(lines[0]).toBe("rd-claude 正在重启");
    expect(lines[1]).toContain("rd-codex 正在干活，先跳过了");

    fireEvent.click(within(drawer).getByRole("button", { name: "完成" }));
    expect(screen.queryByRole("dialog", { name: "安装 GitHub" })).toBeNull();
  });

  it("某个 CLI 没装上单独说原因和怎么办；计划刚好失效时自动重新预览一次", async () => {
    const api = storeApi({ fail: "codex", staleOnce: true });
    render(<McpStore api={asApi(api)} />);
    fireEvent.click(await screen.findByRole("button", { name: "安装 Chrome DevTools" }));
    const drawer = screen.getByRole("dialog", { name: "安装 Chrome DevTools" });
    await act(async () => {
      fireEvent.click(within(drawer).getByRole("button", { name: "安装" }));
    });
    const done = await within(drawer).findByRole("status");
    expect(api.previewRuntimeInstall).toHaveBeenCalledTimes(2);
    expect(api.applyRuntimeInstall).toHaveBeenLastCalledWith(
      expect.objectContaining({ planId: "plan-2" }),
    );
    expect(done.textContent).toContain("已装好：Claude Code");
    expect(done.textContent).toContain("Codex 没装上");
    expect(done.textContent).toContain("EACCES: 没有写入权限");
    expect(done.textContent).toContain("看看这个文件能不能改：~/.codex/config.toml");
    // 只有装好的 CLI 上的 Agent 要重启
    expect(done.textContent).toContain("重启这些 Agent 后生效：rd-claude");
    expect(done.textContent).not.toContain("rd-codex");
  });

  it("出错时在抽屉里说没装上，不丢已经填的", async () => {
    const api = storeApi();
    api.previewRuntimeInstall.mockRejectedValueOnce(new Error("这个 MCP 已经在 Codex 里了"));
    render(<McpStore api={asApi(api)} />);
    fireEvent.click(await screen.findByRole("button", { name: "安装 GitHub" }));
    const drawer = screen.getByRole("dialog", { name: "安装 GitHub" });
    fireEvent.change(within(drawer).getByLabelText(/GitHub 令牌/), { target: { value: TOKEN } });
    await act(async () => {
      fireEvent.click(within(drawer).getByRole("button", { name: "安装" }));
    });
    expect(within(drawer).getByRole("alert").textContent).toBe(
      "没装上：这个 MCP 已经在 Codex 里了",
    );
    expect((within(drawer).getByLabelText(/GitHub 令牌/) as HTMLInputElement).value).toBe(TOKEN);
  });
});

describe("MCP 与技能大面板", () => {
  it("两个页签：已安装是统一管理表，发现 / 安装是商店；Esc 关掉面板", async () => {
    const api = storeApi();
    const onClose = vi.fn();
    render(<RuntimeHubDialog api={asApi(api)} onClose={onClose} />);
    const dialog = screen.getByRole("dialog", { name: "MCP 与技能" });
    expect(dialog.className).toContain("full");
    const tabs = within(dialog).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["已安装", "发现 / 安装"]);
    expect(await within(dialog).findByRole("table")).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "发现更多 MCP" }));
    await waitFor(() =>
      expect(within(dialog).getByRole("list", { name: "可以安装的 MCP" })).toBeTruthy(),
    );
    expect(tabs[1]!.getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});

describe("装完测能不能用", () => {
  it("远程的装完直接测：测出要登录就说原因和怎么办，再测一次通过后显示工具数", async () => {
    const api = storeApi();
    api.verifyRuntimeMcp.mockResolvedValueOnce({
      ok: false,
      problem: "auth",
      reason: "服务要求登录或密钥（HTTP 401）",
      checkedAt: 1,
    });
    render(<McpStore api={asApi(api)} />);
    fireEvent.click(await screen.findByRole("button", { name: "安装 GitHub" }));
    const drawer = screen.getByRole("dialog", { name: "安装 GitHub" });
    // 远程的不运行本机命令：没有「试运行」的勾选
    expect(within(drawer).queryByRole("checkbox")).toBeNull();
    fireEvent.change(within(drawer).getByLabelText(/GitHub 令牌/), { target: { value: TOKEN } });
    await act(async () => {
      fireEvent.click(within(drawer).getByRole("button", { name: "安装" }));
    });
    const done = await within(drawer).findByRole("status");
    await waitFor(() => expect(done.textContent).toContain("需要登录"));
    // 测的是第一个装好的 CLI 里那一份
    expect(api.verifyRuntimeMcp).toHaveBeenCalledWith("github", "claude");
    expect(done.textContent).toContain("服务要求登录或密钥（HTTP 401）");
    expect(done.textContent).toContain("检查密钥填得对不对");
    expect(done.textContent).not.toContain("已写配置");

    await act(async () => {
      fireEvent.click(within(drawer).getByRole("button", { name: "再测一次" }));
    });
    await waitFor(() => expect(done.textContent).toContain("能用 · 3 个工具"));
    expect(done.textContent).toContain("开局约占 1,200 token");
    expect(within(drawer).queryByRole("button", { name: "再测一次" })).toBeNull();
    // 测完让外面跟着刷新（「已安装」和状态栏角标）
    expect(api.runtimeOverview).toHaveBeenCalledTimes(3);
  });

  it("本机命令要人同意才试运行：默认勾上、看得见，取消后装完不运行，点了才测", async () => {
    const api = storeApi();
    api.verifyRuntimeMcp.mockResolvedValueOnce({
      ok: false,
      problem: "failed",
      reason: "找不到要运行的命令",
      checkedAt: 1,
    });
    render(<McpStore api={asApi(api)} />);
    fireEvent.click(await screen.findByRole("button", { name: "安装 Chrome DevTools" }));
    const drawer = screen.getByRole("dialog", { name: "安装 Chrome DevTools" });
    const box = within(drawer).getByRole("checkbox", {
      name: /装好后试运行一次，看能不能用/,
    }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(drawer.textContent).toContain("第一次要先下载");
    const details = within(drawer).getByText("详细信息").closest("details")!;
    expect(details.textContent).toContain("装好后会运行一次来测能不能用");

    fireEvent.click(box);
    expect(details.textContent).toContain("现在不会运行任何东西");
    await act(async () => {
      fireEvent.click(within(drawer).getByRole("button", { name: "安装" }));
    });
    const done = await within(drawer).findByRole("status");
    expect(api.verifyRuntimeMcp).not.toHaveBeenCalled();
    expect(done.textContent).toContain("还没测能不能用");

    await act(async () => {
      fireEvent.click(within(drawer).getByRole("button", { name: "现在试运行一次" }));
    });
    await waitFor(() => expect(done.textContent).toContain("起不来"));
    expect(api.verifyRuntimeMcp).toHaveBeenCalledWith("chrome-devtools", "claude");
    // 起不来时提示它需要什么（清单里没写时用通用的一句）
    expect(done.textContent).toContain("找不到要运行的命令");
    expect(done.textContent).toContain("看看它需要的软件装好没有");
  });

  it("测的接口本身失败时说没测成，可以再点", async () => {
    const api = storeApi();
    api.verifyRuntimeMcp.mockRejectedValueOnce(new Error("Server 没响应"));
    render(<McpStore api={asApi(api)} />);
    fireEvent.click(await screen.findByRole("button", { name: "安装 Chrome DevTools" }));
    const drawer = screen.getByRole("dialog", { name: "安装 Chrome DevTools" });
    await act(async () => {
      fireEvent.click(within(drawer).getByRole("button", { name: "安装" }));
    });
    const done = await within(drawer).findByRole("status");
    await waitFor(() => expect(done.textContent).toContain("没测成"));
    expect(done.textContent).toContain("Server 没响应");
    expect(within(drawer).getByRole("button", { name: "再测一次" })).toBeTruthy();
  });
});

describe("已安装表里的状态", () => {
  const withHealth: RuntimeOverview = {
    ...overview,
    mcp: [
      {
        name: "context7",
        entries: [{ provider: "claude", enabled: true, transport: "http" }],
        health: { ok: true, tools: 2, tokens: 800, checkedAt: 1 },
      },
      {
        name: "github",
        entries: [{ provider: "claude", enabled: true, transport: "http" }],
        health: { ok: false, problem: "auth", reason: "HTTP 401", checkedAt: 1 },
      },
      { name: "memory", entries: [{ provider: "claude", enabled: true, transport: "stdio" }] },
    ],
  };

  it("只有出问题的那一行标出来，正常和没测过的不显示；再测一次后按新结果刷新", async () => {
    const api = storeApi();
    api.runtimeOverview.mockResolvedValue(withHealth);
    render(<RuntimeOverviewBlock api={asApi(api)} />);
    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => row.getAttribute("data-name"))).toEqual([
      "context7",
      "github",
      "memory",
    ]);
    expect(rows[0]!.textContent).not.toContain("能用");
    expect(within(rows[0]!).queryByRole("button", { name: "再测一次" })).toBeNull();
    expect(rows[1]!.textContent).toContain("需要登录");
    expect(rows[1]!.querySelector(".runtime-overview-problem")?.getAttribute("title")).toContain(
      "HTTP 401",
    );
    expect(within(rows[2]!).queryByRole("button", { name: "再测一次" })).toBeNull();

    api.runtimeOverview.mockResolvedValue({
      ...withHealth,
      mcp: withHealth.mcp.map((row) =>
        row.name === "github"
          ? { ...row, health: { ok: true, tools: 5, tokens: 100, checkedAt: 2 } }
          : row,
      ),
    });
    await act(async () => {
      fireEvent.click(within(rows[1]!).getByRole("button", { name: "再测一次" }));
    });
    expect(api.verifyRuntimeMcp).toHaveBeenCalledWith("github");
    await waitFor(() => expect(table.textContent).not.toContain("需要登录"));
  });

  it("从角标点进来时定位并标出那一行", async () => {
    const api = storeApi();
    api.runtimeOverview.mockResolvedValue(withHealth);
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    render(<RuntimeOverviewBlock api={asApi(api)} focusMcp="github" />);
    const table = await screen.findByRole("table");
    const row = within(table)
      .getAllByRole("row")
      .find((item) => item.getAttribute("data-name") === "github")!;
    await waitFor(() => expect(row.className).toBe("focused"));
    expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
  });
});
