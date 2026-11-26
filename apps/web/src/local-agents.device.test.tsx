// @vitest-environment jsdom

import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalAgent } from "@superhive/protocol";
import { HostManageNotice, OwnerDevicesPanel } from "./host-settings";
import { AgentSettingsDialog } from "./agent-settings-dialog";
import { useLocalAgents, type LocalAgentsState } from "./local-agents";

/** 房主在其他设备上：凭设备令牌管理 Server 所在电脑 */

const DEVICE_TOKEN = "hod_device";
const DEVICE_ID = "00000000-0000-4000-8000-0000000000d1";

const agent: LocalAgent = {
  id: "00000000-0000-4000-8000-0000000000a1",
  provider: "omp",
  name: "rd-omp",
  access: "full",
  cwd: "/Users/rd/work",
  model: null,
  effort: null,
  compactWindow: null,
  cacheTtl: null,
  status: "stopped",
  pid: null,
  startedAt: null,
  lastExitCode: null,
  lastError: null,
  restarts: 0,
  createdAt: new Date().toISOString(),
  mcpDisabled: [],
  autoSteer: false,
};

type Call = { url: string; method: string; headers: Headers; body?: unknown };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** 可编程的假 Server：handler 返回 undefined 时走默认响应 */
function fakeServer(
  state: { manageUntil: string | null },
  handler?: (call: Call) => Response | undefined,
) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = {
        url: String(input),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      };
      calls.push(call);
      const custom = handler?.(call);
      if (custom) return custom;
      if (call.url.endsWith("/api/local/session")) {
        return json({
          enabled: true,
          mode: "device",
          deviceId: DEVICE_ID,
          hostLabel: "studio-mac",
          manageUntil: state.manageUntil,
          approval: "im",
        });
      }
      if (call.url.endsWith("/api/local/agents")) return json({ agents: [agent] });
      if (call.url.endsWith("/api/local/keep-awake")) return json({ error: "off" }, 404);
      return json({ error: "not found" }, 404);
    }),
  );
  return calls;
}

const future = () => new Date(Date.now() + 3_600_000).toISOString();

describe("房主设备上的本机功能", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("用设备令牌请求，不带本机凭证；没获批时管理按钮置灰并提示申请", async () => {
    const calls = fakeServer({ manageUntil: null });
    function Harness() {
      const local = useLocalAgents("", true, DEVICE_TOKEN);
      return (
        <>
          <HostManageNotice local={local} />
          {local.agents[0] && (
            <AgentSettingsDialog agent={local.agents[0]} local={local} onClose={() => undefined} />
          )}
        </>
      );
    }
    render(<Harness />);
    expect(await screen.findByRole("button", { name: "申请管理这台电脑" })).toBeTruthy();
    expect(
      ((await screen.findByRole("button", { name: "启动" })) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByRole("button", { name: "删除" }) as HTMLButtonElement).disabled).toBe(true);
    for (const call of calls.filter((item) => item.url.includes("/api/local/"))) {
      expect(call.headers.get("Authorization")).toBe(`Bearer ${DEVICE_TOKEN}`);
      expect(call.headers.get("X-Hive-Owner")).toBeNull();
    }
  });

  it("完全权限的操作要批准：等到批准后带批准单重发；被拒时取消", async () => {
    let decision: "approved" | "denied" = "approved";
    const calls = fakeServer({ manageUntil: future() }, (call) => {
      if (call.url.endsWith(`/api/local/agents/${agent.id}/start`)) {
        if (call.headers.get("X-Hive-Approval") === "ap-1") {
          return json({ agent: { ...agent, status: "starting" } });
        }
        return json(
          {
            error: "这项操作需要你在飞书里确认一次。",
            code: "APPROVAL_REQUIRED",
            approval: { id: "ap-1", kind: "action", status: "pending", summary: "启动" },
            delivered: 1,
          },
          403,
        );
      }
      if (call.url.endsWith("/api/local/approvals/ap-1")) {
        return json({ approval: { id: "ap-1", kind: "action", status: decision } });
      }
      return undefined;
    });
    const { result } = renderHook(() => useLocalAgents("", true, DEVICE_TOKEN));
    await waitFor(() => expect(result.current.canManage).toBe(true));

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.act(agent.id, "start");
    });
    await waitFor(() => expect(result.current.waitingApproval?.id).toBe("ap-1"));
    await act(() => pending);
    const starts = calls.filter((call) => call.url.endsWith("/start"));
    expect(starts.map((call) => call.headers.get("X-Hive-Approval"))).toEqual([null, "ap-1"]);
    expect(result.current.waitingApproval).toBeUndefined();

    decision = "denied";
    await act(() =>
      expect(result.current.act(agent.id, "start")).rejects.toThrow("没有获得批准，操作已取消。"),
    );
  });

  it("设备被退出后本机功能整体收起；服务端说没有管理权时以服务端为准", async () => {
    const state = { manageUntil: future() as string | null };
    let revoked = false;
    fakeServer(state, (call) => {
      if (call.url.endsWith("/api/local/agents/" + agent.id + "/stop")) {
        state.manageUntil = null;
        return json({ error: "还没有获准", code: "MANAGE_REQUIRED" }, 403);
      }
      if (revoked && call.url.endsWith("/api/local/agents")) {
        return json({ error: "失效", code: "DEVICE_SESSION_INVALID" }, 401);
      }
      return undefined;
    });
    const { result } = renderHook(() => useLocalAgents("", true, DEVICE_TOKEN));
    await waitFor(() => expect(result.current.canManage).toBe(true));
    await act(() => expect(result.current.act(agent.id, "stop")).rejects.toThrow("还没有获准"));
    await waitFor(() => expect(result.current.canManage).toBe(false));

    revoked = true;
    await waitFor(() => expect(result.current.enabled).toBe(false), { timeout: 5_000 });
    expect(result.current.reason).toBe("失效");
  });

  it("管理权到期后自动回到只读", async () => {
    fakeServer({ manageUntil: new Date(Date.now() + 300).toISOString() });
    const { result } = renderHook(() => useLocalAgents("", false, DEVICE_TOKEN));
    await waitFor(() => expect(result.current.canManage).toBe(true));
    await waitFor(() => expect(result.current.canManage).toBe(false), { timeout: 3_000 });
  });

  it("设备上的已登录设备：不显示登录二维码和总令牌，只能退出自己", async () => {
    const devices = [
      { id: DEVICE_ID, name: "iPhone", source: "pair", createdAt: "", lastSeenAt: "" },
      { id: "other", name: "iPad", source: "im", createdAt: "", lastSeenAt: "" },
    ];
    const local = {
      enabled: true,
      mode: "device",
      deviceId: DEVICE_ID,
      canManage: false,
      ownerDevices: async () => devices,
      hostApprovers: async () => [],
    } as unknown as LocalAgentsState;
    render(<OwnerDevicesPanel local={local} />);
    expect(await screen.findByText("iPhone（这台）")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "显示登录二维码" })).toBeNull();
    expect(screen.queryByText("房主接入令牌（高级）")).toBeNull();
    expect(screen.getAllByRole("button", { name: "退出登录" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /退出其他所有设备|全部退出/ })).toBeNull();
  });
});

describe("本机 Agent 列表后台刷新", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("首次拉取失败（如 Server 换代中）后，面板没打开也会自己补上", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let agentsCalls = 0;
    fakeServer({ manageUntil: "2099-01-01T00:00:00.000Z" }, (call) => {
      if (!call.url.endsWith("/api/local/agents")) return undefined;
      agentsCalls += 1;
      return agentsCalls === 1 ? json({ error: "restarting" }, 503) : undefined;
    });
    const { result } = renderHook(() => useLocalAgents("", false, DEVICE_TOKEN));
    await waitFor(() => expect(agentsCalls).toBe(1));
    expect(result.current.agents).toEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    await waitFor(() => expect(result.current.agents.map((item) => item.name)).toEqual(["rd-omp"]));
  });
});
