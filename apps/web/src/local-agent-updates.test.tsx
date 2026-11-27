// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalAgent, Participant } from "@superhive/protocol";
import type { LocalAgentsState } from "./local-agents";
import {
  LocalAgentAdvancedSettings,
  LocalAgentUpdatesGroup,
  OutdatedBadge,
} from "./local-agent-updates";

const base: LocalAgent = {
  id: "11111111-1111-4111-8111-111111111111",
  provider: "claude",
  name: "rd-claude",
  access: "full",
  cwd: "/repo",
  model: null,
  effort: null,
  compactWindow: null,
  cacheTtl: null,
  status: "running",
  pid: 100,
  startedAt: null,
  lastExitCode: null,
  lastError: null,
  restarts: 0,
  createdAt: "2026-11-19T00:00:00.000Z",
  mcpDisabled: [],
  autoSteer: false,
};

function localWith(overrides: Partial<LocalAgentsState>): LocalAgentsState {
  return {
    enabled: true,
    canManage: true,
    autoUpdate: true,
    currentVersion: { package: "0.3.1", commit: "bbbbbbbbbb", fingerprint: "new.tree" },
    agents: [],
    refreshAgents: vi.fn(async () => undefined),
    setAutoUpdate: vi.fn(async () => undefined),
    act: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as LocalAgentsState;
}

describe("LocalAgentUpdatesGroup", () => {
  afterEach(cleanup);

  const id = (n: number) =>
    `${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-4${n}${n}${n}-8${n}${n}${n}-${String(n).repeat(12)}`;
  const fresh = (n: number, name: string, extra: Partial<LocalAgent> = {}): LocalAgent => ({
    ...base,
    id: id(n),
    name,
    version: { package: "0.3.1", commit: "bbbbbbbbbb" },
    ...extra,
  });

  const longAgo = new Date(Date.now() - 45 * 60_000).toISOString();
  const justNow = new Date(Date.now() - 2 * 60_000).toISOString();

  it("stays hidden while auto-restart has every outdated agent covered", () => {
    const local = localWith({
      agents: [
        fresh(1, "rd-claude"),
        fresh(2, "rd-codex", { busy: true }),
        // 已停止的：下次启动就是新代码
        fresh(3, "rd-omp", { status: "stopped", outdated: true }),
        // 开着自动重启、刚落后不久、在等它忙完：交给自动重启
        fresh(4, "rd-claude3", {
          busy: true,
          outdated: true,
          restartWhenIdle: true,
          outdatedSince: justNow,
        }),
        fresh(5, "rd-claude4", { outdated: true, restartWhenIdle: true }),
      ],
    });
    const { container } = render(<LocalAgentUpdatesGroup local={local} onShowAgents={vi.fn()} />);
    expect(container.textContent).toBe("");
    expect(screen.queryByRole("switch")).toBeNull();
    // 仍在后台刷新列表，状态变了才能及时露出来
    expect(local.refreshAgents).toHaveBeenCalled();
  });

  it("shows one line and the agents that need a hand when auto-restart can't get to them", async () => {
    const act = vi.fn(async () => undefined);
    const onShowAgents = vi.fn();
    const local = localWith({
      act,
      agents: [
        // 落后 45 分钟还在忙：一直没能重启
        fresh(1, "rd-claude3", {
          busy: true,
          outdated: true,
          restartWhenIdle: true,
          outdatedSince: longAgo,
          version: { package: "0.3.1", commit: "aaaaaaaaaa" },
        }),
        // 自动重启不再管的（这个版本已经自动重启过一次仍是旧的）
        fresh(2, "rd-codex", { busy: false, outdated: true, version: undefined }),
        fresh(3, "rd-busy", { busy: true, outdated: true }),
        // 交给自动重启的、最新的：不列
        fresh(4, "rd-waiting", {
          busy: true,
          outdated: true,
          restartWhenIdle: true,
          outdatedSince: justNow,
        }),
        fresh(5, "rd-claude"),
      ],
    });
    render(<LocalAgentUpdatesGroup local={local} onShowAgents={onShowAgents} />);
    expect(screen.getByRole("status").textContent).toBe("3 个 Agent 在跑旧版本，一直没能自动重启");
    const list = screen.getByRole("list", { name: "在跑旧版本的 Agent" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((row) => row.querySelector("strong")!.textContent)).toEqual([
      "rd-claude3",
      "rd-codex",
      "rd-busy",
    ]);
    expect(rows[0]!.textContent).toContain("空闲后重启，已等 45 分钟 · 0.3.1 · aaaaaaa");
    expect(rows[1]!.textContent).toContain("空闲 · 版本未上报");
    expect(rows[2]!.textContent).toContain("正在执行任务 · 0.3.1 · bbbbbbb");
    for (const row of rows) expect(row.querySelectorAll("button")).toHaveLength(1);
    expect(within(rows[0]!).getByRole("button").textContent).toBe("立即重启");
    // 开关不在这里，挪到了「高级」
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button", { name: /重启全部空闲的/ })).toBeNull();

    fireEvent.click(within(rows[1]!).getByRole("button", { name: "重启" }));
    await waitFor(() => expect(act).toHaveBeenCalledWith(id(2), "restart"));
    fireEvent.click(within(rows[2]!).getByRole("button", { name: "空闲后重启" }));
    await waitFor(() => expect(act).toHaveBeenCalledWith(id(3), "restart"));
    expect(act).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "查看全部 Agent" }));
    expect(onShowAgents).toHaveBeenCalledOnce();
  });

  it("lists every live outdated agent once auto-restart is turned off", () => {
    const local = localWith({
      autoUpdate: false,
      agents: [
        fresh(1, "a", { outdated: true }),
        fresh(2, "b", { outdated: true, busy: true }),
        fresh(3, "c", { status: "stopped", outdated: true }),
        fresh(4, "d"),
      ],
    });
    render(<LocalAgentUpdatesGroup local={local} />);
    expect(screen.getByRole("status").textContent).toBe(
      "自动重启已关，2 个 Agent 在跑旧版本，重启后才用上新代码",
    );
    const rows = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(rows.map((row) => row.querySelector("strong")!.textContent)).toEqual(["a", "b"]);
    // 没给跳转就不显示链接
    expect(screen.queryByRole("button", { name: "查看全部 Agent" })).toBeNull();
  });

  it("restarts all idle outdated agents at once when there is more than one", async () => {
    const act = vi.fn(async () => undefined);
    const local = localWith({
      act,
      autoUpdate: false,
      agents: [
        fresh(1, "a", { outdated: true }),
        fresh(2, "b", { outdated: true }),
        fresh(3, "c", { outdated: true, busy: true, restartWhenIdle: true }),
      ],
    });
    render(<LocalAgentUpdatesGroup local={local} />);
    fireEvent.click(screen.getByRole("button", { name: "重启全部空闲的（2 个）" }));
    await waitFor(() => expect(act).toHaveBeenCalledTimes(2));
    expect(act).toHaveBeenCalledWith(id(1), "restart");
    expect(act).toHaveBeenCalledWith(id(2), "restart");
  });

  it("asks before restarting now, and warns that running tasks get interrupted", async () => {
    const act = vi.fn(async () => undefined);
    render(
      <LocalAgentUpdatesGroup
        local={localWith({
          act,
          agents: [
            { ...base, busy: true, outdated: true, restartWhenIdle: true, outdatedSince: longAgo },
          ],
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "立即重启" }));
    const confirm = screen.getByRole("dialog", { name: "确认立即重启 rd-claude" });
    expect(confirm.textContent).toContain("正在执行的会被中断");
    expect(act).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "立即重启" }));
    await waitFor(() => expect(act).toHaveBeenCalledWith(base.id, "restart", { now: true }));
  });

  it("stays hidden on a Server that does not support auto-update", () => {
    const local = localWith({
      autoUpdate: undefined,
      agents: [fresh(1, "a", { outdated: true })],
    });
    const { container } = render(
      <>
        <LocalAgentUpdatesGroup local={local} />
        <LocalAgentAdvancedSettings local={local} />
      </>,
    );
    expect(container.textContent).toBe("");
  });
});

describe("LocalAgentAdvancedSettings", () => {
  afterEach(cleanup);

  it("keeps the auto-restart switch in a collapsed 高级 section, on by default", async () => {
    const setAutoUpdate = vi.fn(async () => undefined);
    const { container } = render(
      <LocalAgentAdvancedSettings local={localWith({ setAutoUpdate })} />,
    );
    const details = container.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")!.textContent).toBe("高级");
    const toggle = within(details).getByRole("switch", { name: /代码更新后自动重启/ });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(details.textContent).toContain("当前代码：0.3.1 · bbbbbbb");
    fireEvent.click(toggle);
    await waitFor(() => expect(setAutoUpdate).toHaveBeenCalledWith(false));
  });
});

describe("OutdatedBadge", () => {
  afterEach(cleanup);
  const participant: Participant = {
    id: "44444444-4444-4444-8444-444444444444",
    roomId: "general",
    username: "rd-claude",
    type: "agent",
    status: "online",
    joinedAt: "2026-11-19T00:00:00.000Z",
    lastSeenAt: "2026-11-19T00:00:00.000Z",
  };

  it("only shows for outdated agents, with the running version in the tooltip", () => {
    const { rerender, container } = render(<OutdatedBadge participant={participant} />);
    expect(container.textContent).toBe("");
    rerender(
      <OutdatedBadge
        participant={{ ...participant, outdated: true, version: { package: "0.3.0" } }}
      />,
    );
    const badge = screen.getByText("旧版本");
    // 需要重启才用上新代码：提醒级（黄色），和成员名旁其它标签同一套样式
    expect(badge.className).toBe("member-badge warning");
    expect(badge.getAttribute("aria-label")).toBe(
      "运行的是 0.3.0，比当前代码旧；重启后才用上新代码",
    );
  });
});
