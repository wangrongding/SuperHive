// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalAgent, Participant } from "@superhive/protocol";
import type { LocalAgentsState } from "./local-agents";
import { LocalAgentUpdatesGroup, OutdatedBadge } from "./local-agent-updates";

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

  it("lists only live agents on outdated code, one row and one button each", async () => {
    const act = vi.fn(async () => undefined);
    const setAutoUpdate = vi.fn(async () => undefined);
    const onShowAgents = vi.fn();
    const local = localWith({
      act,
      setAutoUpdate,
      agents: [
        fresh(1, "rd-claude3", {
          busy: true,
          outdated: true,
          restartWhenIdle: true,
          version: { package: "0.3.1", commit: "aaaaaaaaaa" },
        }),
        fresh(2, "rd-codex", { busy: false, outdated: true, version: undefined }),
        fresh(3, "rd-busy", { busy: true, outdated: true }),
        // 已停止的：下次启动就是新代码，不列
        fresh(4, "rd-omp", { status: "stopped", outdated: true }),
        fresh(5, "rd-claude"),
        fresh(6, "rd-copilot", { busy: true }),
      ],
    });
    render(<LocalAgentUpdatesGroup local={local} onShowAgents={onShowAgents} />);
    expect(screen.getByText(/当前代码：0\.3\.1 · bbbbbbb；3 个 Agent 在跑旧版本/)).toBeTruthy();
    const list = screen.getByRole("list", { name: "在跑旧版本的 Agent" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((row) => row.querySelector("strong")!.textContent)).toEqual([
      "rd-claude3",
      "rd-codex",
      "rd-busy",
    ]);
    expect(rows[0]!.textContent).toContain("空闲后重启 · 0.3.1 · aaaaaaa");
    expect(rows[1]!.textContent).toContain("空闲 · 版本未上报");
    expect(rows[2]!.textContent).toContain("正在执行任务 · 0.3.1 · bbbbbbb");
    for (const row of rows) expect(row.querySelectorAll("button")).toHaveLength(1);
    // 忙、已安排空闲后重启：剩下的只有立即重启
    expect(within(rows[0]!).getByRole("button").textContent).toBe("立即重启");
    // 只有一个空闲的，不出批量按钮
    expect(screen.queryByRole("button", { name: /重启全部空闲的/ })).toBeNull();

    // 空闲的：重启（Server 端等任务做完，这时就是马上重启）
    fireEvent.click(within(rows[1]!).getByRole("button", { name: "重启" }));
    await waitFor(() => expect(act).toHaveBeenCalledWith(id(2), "restart"));
    // 忙、还没安排的：空闲后重启，不打断
    fireEvent.click(within(rows[2]!).getByRole("button", { name: "空闲后重启" }));
    await waitFor(() => expect(act).toHaveBeenCalledWith(id(3), "restart"));
    expect(act).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "查看全部 Agent" }));
    expect(onShowAgents).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("switch", { name: /代码更新后自动重启/ }));
    expect(setAutoUpdate).toHaveBeenCalledWith(false);
  });

  it("says everything is up to date instead of listing every agent", () => {
    const local = localWith({
      agents: [
        fresh(1, "rd-claude"),
        fresh(2, "rd-codex", { busy: true }),
        fresh(3, "rd-omp", { status: "stopped", outdated: true }),
      ],
    });
    render(<LocalAgentUpdatesGroup local={local} />);
    expect(screen.getByRole("status").textContent).toBe("当前代码：0.3.1 · bbbbbbb；都是最新的");
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.queryByText("rd-claude")).toBeNull();
    // 没给跳转就不显示链接
    expect(screen.queryByRole("button", { name: "查看全部 Agent" })).toBeNull();
  });

  it("restarts all idle outdated agents at once when there is more than one", async () => {
    const act = vi.fn(async () => undefined);
    const local = localWith({
      act,
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
          agents: [{ ...base, busy: true, outdated: true, restartWhenIdle: true }],
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
    const { container } = render(
      <LocalAgentUpdatesGroup local={localWith({ autoUpdate: undefined })} />,
    );
    expect(container.textContent).toBe("");
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
