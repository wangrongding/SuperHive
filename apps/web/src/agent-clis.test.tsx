// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentCliJob } from "@superhive/protocol";
import { AgentClisGroup, JOB_POLL_MS } from "./agent-clis";
import type { AgentCliWithAgents } from "./local-agents";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const COMMAND =
  "'/Users/a/.npm-global/bin/codex-npm' i -g --prefix '/Users/a/.npm-global' @openai/codex@latest";

const INSTALL =
  "PATH='/usr/local/bin':\"$PATH\" '/usr/local/bin/npm' i -g @anthropic-ai/claude-code@latest";

const codex = (overrides: Partial<AgentCliWithAgents> = {}): AgentCliWithAgents => ({
  tool: "codex",
  name: "Codex",
  package: "@openai/codex",
  status: "ok",
  version: "0.160.0",
  installations: [
    {
      path: "/Users/a/.npm-global/bin/codex",
      realPath: "/Users/a/.npm-global/lib/node_modules/@openai/codex/bin/codex.js",
      version: "0.160.0",
      runnable: true,
      source: "npm",
      pathDefault: true,
    },
  ],
  conflict: false,
  latest: "0.170.0",
  updateAvailable: true,
  plan: { kind: "anchored", command: COMMAND },
  agents: [
    { id: "a1", name: "rd-codex", status: "running" },
    { id: "a2", name: "rd-codex2", status: "stopped" },
  ],
  ...overrides,
});

const claude = (overrides: Partial<AgentCliWithAgents> = {}): AgentCliWithAgents => ({
  tool: "claude",
  name: "Claude Code",
  package: "@anthropic-ai/claude-code",
  status: "notInstalled",
  version: null,
  installations: [],
  conflict: false,
  latest: null,
  updateAvailable: false,
  agents: [],
  ...overrides,
});

const job = (overrides: Partial<AgentCliJob> = {}): AgentCliJob => ({
  id: "job-1",
  tool: "codex",
  action: "upgrade",
  command: COMMAND,
  state: "running",
  progress: "",
  startedAt: "2026-11-19T02:00:00.000Z",
  versionBefore: "0.160.0",
  ...overrides,
});

function api(tools: AgentCliWithAgents[] = [codex(), claude()]) {
  return {
    agentClis: vi.fn<
      (refresh?: boolean) => Promise<{ tools: AgentCliWithAgents[]; job: AgentCliJob | null }>
    >(async () => ({ tools, job: null })),
    agentCliCurrent: vi.fn<() => Promise<AgentCliJob | null>>(async () => null),
    upgradeAgentCli: vi.fn<(tool: string, command: string) => Promise<AgentCliJob>>(async () =>
      job(),
    ),
    installAgentCli: vi.fn<(tool: string, command: string) => Promise<AgentCliJob>>(async () =>
      job({ tool: "claude", action: "install", command: INSTALL, versionBefore: null }),
    ),
    agentCliJob: vi.fn(async () => job()),
    act: vi.fn(async () => undefined),
    // 配置面板用的接口：这些用例不打开面板
    runtimeCredentials: vi.fn(async () => []),
    ...unusedConfigApi,
  };
}

const unused = () => vi.fn(() => Promise.reject(new Error("unused")));
const unusedConfigApi = {
  runtimeConfig: unused(),
  updateRuntimeFields: unused(),
  putRuntimeMcp: unused(),
  deleteRuntimeMcp: unused(),
  toggleRuntimeMcp: unused(),
  readRuntimeFile: unused(),
  writeRuntimeFile: unused(),
  revealRuntimeCredential: unused(),
  updateRuntimeCredentials: unused(),
  runtimeSkills: unused(),
  readRuntimeSkill: unused(),
  toggleRuntimeSkill: unused(),
  deleteRuntimeSkill: unused(),
};

describe("AgentClisGroup", () => {
  it("shows versions, source, and what can't be updated", async () => {
    const client = api([
      codex(),
      claude(),
      codex({
        tool: "copilot",
        name: "GitHub Copilot CLI",
        version: "1.0.88",
        latest: "1.0.114",
        plan: {
          kind: "manual",
          reason: "认不出 /Users/a/bin/copilot 是怎么装的，请用原来的安装方式升级",
        },
        agents: [],
      }),
      codex({
        tool: "openclaw",
        name: "OpenClaw",
        nodeGap: { required: ">=24.16.0", current: "20.1.0" },
        agents: [],
      }),
    ]);
    render(<AgentClisGroup api={client} />);
    const card = await screen.findByRole("region", { name: "Codex" });
    expect(card.textContent).toContain("0.160.0");
    expect(card.textContent).toContain("有新版 0.170.0");
    expect(card.textContent).toContain("npm");
    expect(screen.getByRole("region", { name: "Claude Code" }).textContent).toContain("未安装");
    // 认不出来源：只给原因，没有升级按钮
    const copilot = screen.getByRole("region", { name: "GitHub Copilot CLI" });
    expect(copilot.textContent).toContain("请用原来的安装方式升级");
    // 装了的都有「配置」，但没有升级按钮
    const buttons = (region: HTMLElement) =>
      [...region.querySelectorAll("button")].map((button) => button.textContent);
    expect(buttons(copilot)).toEqual(["配置"]);
    // Node 不满足：不给升级
    const openclaw = screen.getByRole("region", { name: "OpenClaw" });
    expect(openclaw.textContent).toContain("新版需要 Node >=24.16.0");
    expect(buttons(openclaw)).toEqual(["配置"]);
    // 没装、也没有配置文件：没有「配置」
    expect(buttons(screen.getByRole("region", { name: "Claude Code" }))).not.toContain("配置");
    expect(client.agentClis).toHaveBeenCalledWith(false);

    fireEvent.click(screen.getByRole("button", { name: "重新检测" }));
    await waitFor(() => expect(client.agentClis).toHaveBeenCalledWith(true));
  });

  it("lists every installation when they conflict", async () => {
    const client = api([
      codex({
        conflict: true,
        installations: [
          ...codex().installations,
          {
            path: "/Users/a/.nvm/versions/node/v20.1.0/bin/codex",
            realPath:
              "/Users/a/.nvm/versions/node/v20.1.0/lib/node_modules/@openai/codex/bin/codex.js",
            version: "0.150.0",
            runnable: true,
            source: "nvm",
            pathDefault: false,
          },
        ],
      }),
    ]);
    render(<AgentClisGroup api={client} />);
    const summary = await screen.findByText(/装了 2 处/);
    fireEvent.click(summary);
    expect(screen.getByText("/Users/a/.nvm/versions/node/v20.1.0/bin/codex")).toBeTruthy();
    expect(screen.getByText(/0\.150\.0 · nvm/)).toBeTruthy();
  });

  it("asks before running the exact command, then shows progress and offers restarts", async () => {
    const client = api();
    let current = job({ progress: "npm http fetch GET 200" });
    client.agentCliJob.mockImplementation(async () => current);
    render(<AgentClisGroup api={client} />);
    const upgrade = await screen.findByRole("button", { name: "升级到 0.170.0" });
    fireEvent.click(upgrade);
    // 确认气泡里是原样的命令；取消不执行
    const dialog = screen.getByRole("dialog", { name: "确认升级 Codex" });
    expect(dialog.textContent).toContain(COMMAND);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(client.upgradeAgentCli).not.toHaveBeenCalled();

    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(screen.getByRole("button", { name: "升级到 0.170.0" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "升级" }));
    });
    expect(client.upgradeAgentCli).toHaveBeenCalledWith("codex", COMMAND);
    expect(await screen.findByText("正在升级…", { selector: "span" })).toBeTruthy();
    // 一次只升级一个：重新检测也先停用
    expect(screen.getByRole("button", { name: "重新检测" }).hasAttribute("disabled")).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(JOB_POLL_MS);
    });
    expect(screen.getByText("npm http fetch GET 200")).toBeTruthy();

    current = job({ state: "succeeded", versionAfter: "0.170.0", progress: "changed 2 packages" });
    client.agentClis.mockImplementation(async () => ({
      tools: [codex({ version: "0.170.0", updateAvailable: false })],
      job: current,
    }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(JOB_POLL_MS);
    });
    expect(await screen.findByText(/已升级到 0\.170\.0/)).toBeTruthy();
    expect(screen.getByText(/rd-codex、rd-codex2/)).toBeTruthy();
    // 只重启在跑的
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "重启这 1 个 Agent" }));
    });
    expect(client.act).toHaveBeenCalledTimes(1);
    expect(client.act).toHaveBeenCalledWith("a1", "restart");
    expect(await screen.findByText("已重启 1 个 Agent")).toBeTruthy();
  });

  it("shows the reason and the last lines of output when an update fails", async () => {
    const client = api();
    client.agentClis.mockImplementation(async () => ({
      tools: [codex()],
      job: job(),
    }));
    client.agentCliJob.mockImplementation(async () =>
      job({
        state: "failed",
        reason: "命令出错退出（退出码 243）。",
        error: "npm error code EACCES\nnpm error path /usr/local/lib/node_modules",
      }),
    );
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<AgentClisGroup api={client} />);
    // 打开页面时已有升级在跑：接着轮询
    expect(await screen.findByText("正在升级…", { selector: "span" })).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(JOB_POLL_MS);
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("升级失败：命令出错退出（退出码 243）。");
    expect(alert.textContent).toContain("npm error code EACCES");
  });

  it("shows the server's refusal next to the button", async () => {
    const client = api();
    client.upgradeAgentCli.mockRejectedValue(
      new Error("Codex 的安装情况变了，升级命令和你确认的不一样，没有执行。请刷新后重新确认。"),
    );
    render(<AgentClisGroup api={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "升级到 0.170.0" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "升级" }));
    });
    expect(await screen.findByText(/升级命令和你确认的不一样/)).toBeTruthy();
  });

  it("shows progress right after confirming, and disables the other buttons with a reason", async () => {
    let resolve!: (value: AgentCliJob) => void;
    const client = api([codex(), claude({ plan: { kind: "anchored", command: INSTALL } })]);
    client.upgradeAgentCli.mockImplementation(
      () => new Promise<AgentCliJob>((done) => (resolve = done)),
    );
    render(<AgentClisGroup api={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "升级到 0.170.0" }));
    fireEvent.click(screen.getByRole("button", { name: "升级" }));
    // 服务端还在核对命令：这一行已经在进行中，确认按钮 busy，其它按钮停用并说明原因
    const codexCard = screen.getByRole("region", { name: "Codex" });
    expect(codexCard.getAttribute("aria-busy")).toBe("true");
    expect(codexCard.textContent).toContain("正在核对命令…");
    const busyButton = Array.from(codexCard.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("正在升级…"),
    );
    expect(busyButton?.hasAttribute("disabled")).toBe(true);
    const confirmButton = screen.getByRole("dialog").querySelector("button:last-child");
    expect(
      confirmButton?.hasAttribute("disabled") || confirmButton?.getAttribute("aria-busy"),
    ).toBeTruthy();
    const install = screen.getByRole("button", {
      name: "安装",
      description: "正在升级 Codex，完成后再试",
    });
    expect(install.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("正在升级 Codex，完成后才能操作其它 CLI。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "重新检测" }).hasAttribute("disabled")).toBe(true);

    await act(async () => resolve(job({ progress: "npm http fetch GET 200" })));
    expect(codexCard.textContent).toContain("npm http fetch GET 200");
    expect(screen.queryByText("正在核对命令…")).toBeNull();
    expect(screen.getByRole("button", { name: "安装" }).hasAttribute("disabled")).toBe(true);
  });

  it("restores a running job from the current-task endpoint before detection finishes", async () => {
    const client = api();
    let finishList!: () => void;
    client.agentClis.mockImplementation(
      () =>
        new Promise((done) => {
          finishList = () => done({ tools: [codex()], job: null });
        }),
    );
    client.agentCliCurrent.mockResolvedValue(job({ progress: "reify: timing" }));
    render(<AgentClisGroup api={client} />);
    expect(await screen.findByText("正在升级 Codex，完成后才能操作其它 CLI。")).toBeTruthy();
    await act(async () => finishList());
    expect(screen.getByRole("region", { name: "Codex" }).textContent).toContain("reify: timing");
    // 已经结束的旧结果不翻出来
    cleanup();
    const later = api();
    later.agentCliCurrent.mockResolvedValue(job({ state: "succeeded", versionAfter: "0.170.0" }));
    render(<AgentClisGroup api={later} />);
    await screen.findByRole("region", { name: "Codex" });
    expect(screen.queryByText(/已升级到/)).toBeNull();
  });

  it("installs a missing CLI after confirming the exact command, then re-detects", async () => {
    const client = api([
      claude({ plan: { kind: "anchored", command: INSTALL }, latest: "2.1.328" }),
    ]);
    let current = job({ tool: "claude", action: "install", command: INSTALL, versionBefore: null });
    client.agentCliJob.mockImplementation(async () => current);
    render(<AgentClisGroup api={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "安装" }));
    const dialog = screen.getByRole("dialog", { name: "确认安装 Claude Code" });
    expect(dialog.textContent).toContain(INSTALL);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await act(async () => {
      fireEvent.click(dialog.querySelector("button:last-child")!);
    });
    expect(client.installAgentCli).toHaveBeenCalledWith("claude", INSTALL);
    expect(client.upgradeAgentCli).not.toHaveBeenCalled();
    expect(await screen.findByText("正在安装…", { selector: "span" })).toBeTruthy();

    current = { ...current, state: "succeeded", versionAfter: "2.1.328" };
    client.agentClis.mockImplementation(async () => ({
      tools: [claude({ status: "ok", version: "2.1.328", latest: "2.1.328" })],
      job: current,
    }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(JOB_POLL_MS);
    });
    expect(await screen.findByText("已安装 Claude Code 2.1.328。")).toBeTruthy();
    expect(client.agentClis).toHaveBeenCalledTimes(2);
  });

  it("offers a reinstall for a CLI that is installed but won't run", async () => {
    const client = api([
      codex({
        status: "broken",
        version: null,
        latest: "0.170.0",
        updateAvailable: false,
        installations: [
          { ...codex().installations[0]!, version: null, runnable: false, error: "boom" },
        ],
      }),
    ]);
    render(<AgentClisGroup api={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "重新安装" }));
    // 确认框按「重新安装」说，不说「升级」
    const dialog = screen.getByRole("dialog", { name: "确认重新安装 Codex" });
    expect(dialog.textContent).toContain("在这台电脑上重新安装 Codex");
    expect(dialog.textContent).not.toContain("升级");
    expect(dialog.querySelector("button:last-child")!.textContent).toBe("重新安装");
    let current = job({ versionBefore: null });
    client.upgradeAgentCli.mockImplementation(async () => current);
    client.agentCliJob.mockImplementation(async () => current);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await act(async () => {
      fireEvent.click(dialog.querySelector("button:last-child")!);
    });
    expect(client.upgradeAgentCli).toHaveBeenCalledWith("codex", COMMAND);
    // 进行中也说「正在重新安装」：按钮和进度行都是
    expect(await screen.findByText("正在重新安装…", { selector: "span" })).toBeTruthy();
    expect(screen.queryByText("正在升级…")).toBeNull();

    // 原来那一处查不到版本：做完说「已重新安装」，不说「已升级到」
    current = { ...current, state: "succeeded", versionAfter: "0.170.0" };
    client.agentClis.mockImplementation(async () => ({
      tools: [codex({ version: "0.170.0", updateAvailable: false })],
      job: current,
    }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(JOB_POLL_MS);
    });
    expect(await screen.findByText(/已重新安装 Codex 0\.170\.0。/)).toBeTruthy();
    expect(screen.queryByText(/已升级到/)).toBeNull();
  });

  it("offers no install button without Node, and links official instructions when given", async () => {
    const client = api([
      claude({
        plan: { kind: "manual", reason: "这台电脑上找不到 Node.js 和 npm，先装好 Node.js" },
      }),
      claude({
        tool: "omp",
        name: "Oh My Pi",
        plan: {
          kind: "manual",
          reason: "Oh My Pi 要用 bun 安装，这台电脑上没有 bun；按官方说明安装",
          url: "https://omp.sh",
        },
      }),
      claude({
        tool: "openclaw",
        name: "OpenClaw",
        plan: { kind: "anchored", command: "npm i -g openclaw@latest" },
        nodeGap: { required: ">=24.16.0", current: "20.1.0" },
      }),
      claude({
        tool: "codex",
        name: "Codex",
        plan: { kind: "anchored", command: "npm i -g @openai/codex@latest" },
        binNotOnPath: "/opt/npm/bin",
      }),
    ]);
    render(<AgentClisGroup api={client} />);
    const claudeCard = await screen.findByRole("region", { name: "Claude Code" });
    expect(claudeCard.querySelector("button")).toBeNull();
    expect(claudeCard.textContent).toContain("先装好 Node.js");
    const omp = screen.getByRole("region", { name: "Oh My Pi" });
    expect(omp.querySelector("button")).toBeNull();
    expect(screen.getByRole("link", { name: "安装说明" }).getAttribute("href")).toBe(
      "https://omp.sh",
    );
    expect(screen.getByRole("region", { name: "OpenClaw" }).querySelector("button")).toBeNull();
    const codexCard = screen.getByRole("region", { name: "Codex" });
    expect(codexCard.querySelector("button")?.textContent).toBe("安装");
    expect(codexCard.textContent).toContain("/opt/npm/bin，这个目录不在登录终端的 PATH 里");
  });

  it("splits a fallback chain into readable steps and explains it", async () => {
    const script =
      "bash -c 'tmp=$(mktemp) && curl -fsSL https://claude.ai/install.sh -o $tmp && bash $tmp; status=$?; rm -f $tmp; exit $status'";
    const npm = "'/usr/local/bin/npm' i -g @anthropic-ai/claude-code@latest";
    const omp =
      "bash -c 'tmp=$(mktemp) && curl -fsSL https://omp.sh/install -o $tmp && sh $tmp; status=$?; rm -f $tmp; exit $status'";
    const client = api([
      claude({ plan: { kind: "anchored", command: `${script} || ${npm}` } }),
      claude({ tool: "omp", name: "Oh My Pi", plan: { kind: "anchored", command: omp } }),
      codex({ plan: { kind: "anchored", command: `'/a/opencode' upgrade || ${npm}` } }),
    ]);
    render(<AgentClisGroup api={client} />);
    const claudeCard = await screen.findByRole("region", { name: "Claude Code" });
    fireEvent.click(claudeCard.querySelector("button")!);
    let dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("先用官方安装脚本安装，失败了再自动改用 npm。");
    const steps = dialog.querySelectorAll("ol li code");
    expect(Array.from(steps).map((step) => step.textContent)).toEqual([script, npm]);
    expect(dialog.textContent).toContain("先试");
    expect(dialog.textContent).toContain("失败再用");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    fireEvent.click(screen.getByRole("region", { name: "Oh My Pi" }).querySelector("button")!);
    dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("会先把官方安装脚本下载到临时文件，再运行它。");
    expect(dialog.querySelector("ol")).toBeNull();
    expect(dialog.querySelector("code")?.textContent).toBe(omp);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    fireEvent.click(screen.getByRole("button", { name: "升级到 0.170.0" }));
    expect(screen.getByRole("dialog").textContent).toContain(
      "先用 Codex 自带的升级命令，失败了再自动改用下一种方式。",
    );
  });

  it("shows an unchanged version as a failure, not a success", async () => {
    const client = api();
    client.agentClis.mockImplementation(async () => ({ tools: [codex()], job: job() }));
    client.agentCliJob.mockImplementation(async () =>
      job({
        state: "failed",
        versionAfter: "0.160.0",
        reason:
          "命令执行完了，但 Codex 的版本还是 0.160.0，没有真的升级。可能是网络不通，或者装到了别处。",
        error: "Update ran successfully",
      }),
    );
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<AgentClisGroup api={client} />);
    await screen.findByText("正在升级…", { selector: "span" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(JOB_POLL_MS);
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("没有真的升级");
    expect(screen.queryByText(/已升级到/)).toBeNull();
    expect(screen.queryByRole("button", { name: /重启这/ })).toBeNull();
  });
});

describe("AgentClisGroup config button", () => {
  it("opens the CLI's config panel from its card, also for a missing CLI that has a config file", async () => {
    const client = api();
    client.runtimeCredentials.mockResolvedValue([
      { provider: "claude", configured: true } as never,
    ]);
    client.runtimeConfig.mockRejectedValue(new Error("读不到配置"));
    render(<AgentClisGroup api={client} />);
    const claudeCard = await screen.findByRole("region", { name: "Claude Code" });
    const open = await within(claudeCard).findByRole("button", { name: "配置" });
    fireEvent.click(open);
    expect(client.runtimeConfig).toHaveBeenCalledWith("claude");
    expect(await within(claudeCard).findByText("读不到配置")).toBeTruthy();
    fireEvent.click(within(claudeCard).getByRole("button", { name: "收起配置" }));
    expect(within(claudeCard).queryByText("读不到配置")).toBeNull();
  });

  it("opens the config panel directly when jumped to from the connect dialog", async () => {
    const client = api();
    client.runtimeConfig.mockRejectedValue(new Error("读不到配置"));
    render(<AgentClisGroup api={client} focusTool="codex" />);
    const codexCard = await screen.findByRole("region", { name: "Codex" });
    expect(await within(codexCard).findByRole("button", { name: "收起配置" })).toBeTruthy();
    expect(client.runtimeConfig).toHaveBeenCalledWith("codex");
  });
});
