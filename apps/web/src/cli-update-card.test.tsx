// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentCliJob } from "@superhive/protocol";
import { JOB_POLL_MS } from "./agent-clis";
import {
  CARD_INTERVAL_MS,
  CliUpdateCard,
  offerKeys,
  readCardMemory,
  shouldOffer,
} from "./cli-update-card";
import type { AgentCliWithAgents } from "./local-agents";
import { StatusAgentClisPopover, useStatusAgentClis } from "./status-runtimes";

const started = "2026-11-28T02:00:00.000Z";
const NPM = (pkg: string) => `'/Users/a/.nvm/versions/node/v22.1.0/bin/npm' i -g ${pkg}@latest`;

const cli = (overrides: Partial<AgentCliWithAgents>): AgentCliWithAgents => ({
  tool: "codex",
  name: "Codex",
  package: "@openai/codex",
  status: "ok",
  version: "0.160.0",
  installations: [],
  conflict: false,
  latest: "0.170.0",
  updateAvailable: true,
  plan: { kind: "anchored", command: NPM("@openai/codex") },
  agents: [],
  ...overrides,
});

/** 5 个 CLI：3 个能一键升级、1 个只能手动升级、1 个已是最新 */
const fiveClis = (): AgentCliWithAgents[] => [
  cli({
    tool: "claude",
    name: "Claude Code",
    package: "@anthropic-ai/claude-code",
    version: "2.1.0",
    latest: "2.2.0",
    plan: { kind: "anchored", command: "'/Users/a/.local/bin/claude' update" },
    agents: [{ id: "a1", name: "rd-claude", status: "running" }],
  }),
  cli({ agents: [{ id: "a2", name: "rd-codex", status: "running" }] }),
  cli({
    tool: "gemini",
    name: "Gemini CLI",
    package: "@google/gemini-cli",
    version: "0.70.0",
    latest: "0.71.0",
    plan: { kind: "anchored", command: NPM("@google/gemini-cli") },
  }),
  cli({
    tool: "copilot",
    name: "GitHub Copilot CLI",
    package: "@github/copilot",
    version: "1.0.1",
    latest: "1.1.0",
    plan: {
      kind: "manual",
      reason: "认不出 /Users/a/bin/copilot 是怎么装的，请用原来的安装方式升级",
      command: "npm i -g @github/copilot@latest",
    },
  }),
  cli({
    tool: "opencode",
    name: "OpenCode",
    package: "opencode-ai",
    version: "1.4.0",
    latest: "1.4.0",
    updateAvailable: false,
  }),
];

const job = (
  tool: AgentCliWithAgents["tool"],
  overrides: Partial<AgentCliJob> = {},
): AgentCliJob => ({
  id: `job-${tool}`,
  tool,
  action: "upgrade",
  command: "x",
  state: "running",
  progress: "",
  startedAt: started,
  versionBefore: "1.0.0",
  ...overrides,
});

function fakeApi(tools: AgentCliWithAgents[] = fiveClis()) {
  const jobs = new Map<string, AgentCliJob>();
  let running = 0;
  return {
    jobs,
    agentClis: vi.fn(async () => ({ tools, job: null, jobs: [] as AgentCliJob[] })),
    upgradeAgentCli: vi.fn(async (tool: AgentCliWithAgents["tool"], command: string) => {
      // 和服务端一样最多同时跑 2 个（这里替身取 2，验证排队显示）
      const next = job(tool, { command, state: running < 2 ? "running" : "queued" });
      if (next.state === "running") running += 1;
      jobs.set(next.id, next);
      return next;
    }),
    agentCliJob: vi.fn(async (id: string) => jobs.get(id)!),
    act: vi.fn(async () => undefined),
  };
}

function Harness({
  api,
  now = () => Date.parse(started),
  openSettings = () => undefined,
}: {
  api: ReturnType<typeof fakeApi>;
  now?: () => number;
  openSettings?: () => void;
}) {
  const state = useStatusAgentClis(api, false);
  return (
    <>
      <CliUpdateCard
        state={state}
        api={api}
        paused={false}
        openSettings={openSettings}
        now={now}
        startupDelayMs={20}
      />
      <div data-testid="popover">
        <StatusAgentClisPopover state={state} api={api} openSettings={openSettings} />
      </div>
    </>
  );
}

const card = () => screen.getByRole("region", { name: /CLI/ });

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("提醒节流", () => {
  const t0 = Date.parse(started);
  it("有没见过的新版才弹；离上次弹出或关掉不到 24 小时不弹", () => {
    expect(shouldOffer({ seen: [] }, ["codex@0.170.0"], t0)).toBe(true);
    expect(shouldOffer({ seen: [] }, [], t0)).toBe(false);
    expect(shouldOffer({ at: t0, seen: [] }, ["codex@0.170.0"], t0 + CARD_INTERVAL_MS - 1)).toBe(
      false,
    );
    expect(shouldOffer({ at: t0, seen: [] }, ["codex@0.170.0"], t0 + CARD_INTERVAL_MS)).toBe(true);
    // 点过「稍后」的这一批：过了 24 小时也不再弹，出了新版本才弹
    const seen = { at: t0, seen: ["codex@0.170.0"] };
    expect(shouldOffer(seen, ["codex@0.170.0"], t0 + 2 * CARD_INTERVAL_MS)).toBe(false);
    expect(shouldOffer(seen, ["codex@0.171.0"], t0 + CARD_INTERVAL_MS)).toBe(true);
    // 时钟往回拨：不至于永远不弹
    expect(shouldOffer({ at: t0, seen: [] }, ["codex@0.170.0"], t0 - 1000)).toBe(true);
    expect(offerKeys([cli({})])).toEqual(["codex@0.170.0"]);
  });

  it("坏掉的存储按没记过算", () => {
    localStorage.setItem("superhive.cliUpdateCard.v1", "{bad");
    expect(readCardMemory()).toEqual({ seen: [] });
    localStorage.setItem("superhive.cliUpdateCard.v1", JSON.stringify({ at: "x", seen: [1, "a"] }));
    expect(readCardMemory()).toEqual({ seen: ["a"] });
  });
});

describe("CLI 更新提醒卡片", () => {
  it("延迟后检测一次再弹；只能手动升级的给可复制命令；点「稍后」记下来，再打开页面不再弹", async () => {
    const api = fakeApi();
    let now = Date.parse(started);
    render(<Harness api={api} now={() => now} />);
    // 刚打开页面：状态栏取了一次，卡片还没弹
    expect(screen.queryByRole("region", { name: /CLI/ })).toBeNull();
    expect(await screen.findByRole("region", { name: "4 个 CLI 可更新" })).toBeTruthy();
    // 延迟到点又检测了一次（页面加载 1 次 + 弹层 1 次 + 延迟后 1 次）
    expect(api.agentClis.mock.calls.length).toBeGreaterThanOrEqual(3);
    const region = card();
    expect(region.textContent).toContain("Claude Code");
    expect(region.textContent).toContain("2.1.0 → 2.2.0");
    expect(region.textContent).not.toContain("OpenCode");
    expect(region.textContent).toContain("需要手动更新");
    expect(region.textContent).toContain("npm i -g @github/copilot@latest");
    expect(within(region).getByRole("button", { name: "复制命令" })).toBeTruthy();
    expect(within(region).getByRole("button", { name: "全部更新" })).toBeTruthy();
    // 弹出就算提醒过
    expect(readCardMemory().at).toBe(now);

    fireEvent.click(within(region).getByRole("button", { name: "稍后" }));
    expect(screen.queryByRole("region", { name: /CLI/ })).toBeNull();
    expect(readCardMemory().seen).toEqual(
      expect.arrayContaining(["claude@2.2.0", "codex@0.170.0", "gemini@0.71.0", "copilot@1.1.0"]),
    );
    cleanup();

    // 25 小时后、版本没变：不再弹
    now += 25 * 60 * 60_000;
    render(<Harness api={api} now={() => now} />);
    await waitFor(() => expect(api.agentClis.mock.calls.length).toBeGreaterThanOrEqual(6));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 60)));
    expect(screen.queryByRole("region", { name: /CLI/ })).toBeNull();
  });

  it("没理它直接刷新：24 小时内不再弹", async () => {
    const api = fakeApi();
    const now = Date.parse(started);
    render(<Harness api={api} now={() => now + 60_000} />);
    await screen.findByRole("region", { name: "4 个 CLI 可更新" });
    cleanup();
    render(<Harness api={api} now={() => now + 2 * 60_000} />);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 80)));
    expect(screen.queryByRole("region", { name: /CLI/ })).toBeNull();
  });

  it("Esc 和「查看」也算关掉；「查看」打开运行时设置", async () => {
    const api = fakeApi();
    const openSettings = vi.fn();
    render(<Harness api={api} openSettings={openSettings} />);
    const region = await screen.findByRole("region", { name: "4 个 CLI 可更新" });
    fireEvent.click(within(region).getByRole("button", { name: "查看" }));
    expect(openSettings).toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: /CLI/ })).toBeNull();
    expect(readCardMemory().seen).toHaveLength(4);
    cleanup();
    localStorage.clear();
    render(<Harness api={api} />);
    const again = await screen.findByRole("region", { name: "4 个 CLI 可更新" });
    fireEvent.keyDown(within(again).getByRole("button", { name: "稍后" }), { key: "Escape" });
    expect(screen.queryByRole("region", { name: /CLI/ })).toBeNull();
  });

  it("全部更新：先确认命令，再同时开始、超出的排队；每行单独显示结果，失败的看完整输出、单独重试，升完提示重启", async () => {
    const api = fakeApi();
    render(<Harness api={api} />);
    const region = await screen.findByRole("region", { name: "4 个 CLI 可更新" });
    fireEvent.click(within(region).getByRole("button", { name: "全部更新" }));
    const confirm = within(region).getByRole("group", { name: "确认升级 3 个 CLI" });
    expect(confirm.textContent).toContain("'/Users/a/.local/bin/claude' update");
    expect(confirm.textContent).toContain(NPM("@google/gemini-cli"));
    // 手动升级的不在里面
    expect(confirm.textContent).not.toContain("copilot");
    expect(api.upgradeAgentCli).not.toHaveBeenCalled();
    // Esc 只收起确认
    fireEvent.keyDown(confirm, { key: "Escape" });
    expect(within(card()).queryByRole("group")).toBeNull();
    expect(card()).toBeTruthy();

    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(within(card()).getByRole("button", { name: "全部更新" }));
    await act(async () => {
      fireEvent.click(within(card()).getByRole("button", { name: "升级 3 个" }));
    });
    expect(api.upgradeAgentCli.mock.calls.map(([tool]) => tool)).toEqual([
      "claude",
      "codex",
      "gemini",
    ]);
    const running = card();
    expect(running.getAttribute("aria-label")).toBe("正在更新 1/3 个 CLI");
    expect(within(running).getByRole("listitem", { name: "Gemini CLI" }).textContent).toContain(
      "排队中",
    );
    // 进行中可以收起到状态栏
    expect(within(running).getByRole("button", { name: "收起到状态栏" })).toBeTruthy();

    // Claude 成功、Codex 失败（带完整输出），Gemini 排到了、也成功
    api.jobs.set("job-claude", job("claude", { state: "succeeded", versionAfter: "2.2.0" }));
    api.jobs.set(
      "job-codex",
      job("codex", {
        state: "failed",
        reason: "命令连续 3 分钟没有任何输出，像是卡住了，已停止。",
        error: "npm http fetch GET",
        output: "npm warn deprecated\nnpm http fetch GET",
      }),
    );
    api.jobs.set("job-gemini", job("gemini", { state: "running", progress: "reify: timing" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(JOB_POLL_MS);
    });
    expect(within(card()).getByRole("listitem", { name: "Gemini CLI" }).textContent).toContain(
      "reify: timing",
    );
    api.jobs.set("job-gemini", job("gemini", { state: "succeeded", versionAfter: "0.71.0" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(JOB_POLL_MS);
    });
    const done = card();
    expect(done.getAttribute("aria-label")).toBe("1 个 CLI 更新失败");
    const codexRow = within(done).getByRole("listitem", { name: "Codex" });
    expect(codexRow.textContent).toContain("卡住了");
    expect(within(codexRow).getByText("查看完整输出")).toBeTruthy();
    expect(codexRow.textContent).toContain("npm warn deprecated");
    expect(within(done).getByRole("listitem", { name: "Claude Code" }).textContent).toContain(
      "已升级到 2.2.0",
    );
    // 升完的里面有在跑的 Agent：一个按钮重启
    fireEvent.click(within(done).getByRole("button", { name: "重启这 1 个 Agent" }));
    await waitFor(() => expect(api.act).toHaveBeenCalledWith("a1", "restart"));

    // 单独重试失败的那一个
    fireEvent.click(within(codexRow).getByRole("button", { name: "重试" }));
    await waitFor(() => expect(api.upgradeAgentCli).toHaveBeenCalledTimes(4));
    expect(api.upgradeAgentCli.mock.calls[3]![0]).toBe("codex");
  });

  it("没能开始的（命令变了等）在那一行显示原因", async () => {
    const api = fakeApi();
    api.upgradeAgentCli.mockImplementation(async (tool) => {
      if (tool === "codex") throw new Error("Codex 的安装情况变了");
      return job(tool);
    });
    render(<Harness api={api} />);
    const region = await screen.findByRole("region", { name: "4 个 CLI 可更新" });
    fireEvent.click(within(region).getByRole("button", { name: "全部更新" }));
    await act(async () => {
      fireEvent.click(within(card()).getByRole("button", { name: "升级 3 个" }));
    });
    const row = within(card()).getByRole("listitem", { name: "Codex" });
    expect(row.textContent).toContain("Codex 的安装情况变了");
    expect(row.textContent).toContain("失败");
  });
});

describe("状态栏弹层 · 全部升级", () => {
  it("两个以上能一键升级时给「全部升级」，确认后同时开始；在跑的那一行不再算进去", async () => {
    const api = fakeApi();
    render(<Harness api={api} />);
    const popover = screen.getByTestId("popover");
    const button = await within(popover).findByRole("button", { name: "全部升级" });
    expect(popover.textContent).toContain("3 个可以一键升级");
    fireEvent.click(button);
    const confirm = within(popover).getByRole("group", { name: "确认升级 3 个 CLI" });
    await act(async () => {
      fireEvent.click(within(confirm).getByRole("button", { name: "升级 3 个" }));
    });
    expect(api.upgradeAgentCli).toHaveBeenCalledTimes(3);
    expect(within(popover).queryByRole("button", { name: "全部升级" })).toBeNull();
    expect(within(popover).getByRole("listitem", { name: "Gemini CLI" }).textContent).toContain(
      "排队中",
    );
    // 手动升级的那一行给可复制的命令
    expect(
      within(within(popover).getByRole("listitem", { name: "GitHub Copilot CLI" })).getByRole(
        "button",
        { name: "复制命令" },
      ),
    ).toBeTruthy();
  });
});
