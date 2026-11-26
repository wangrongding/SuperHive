// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImConnection, NetworkProxyState, Participant } from "@superhive/protocol";
import type { LocalAgentsState } from "./local-agents";
import {
  StatusBar,
  agentCounts,
  contextPercent,
  imSummary,
  type StatusBarProps,
} from "./status-bar";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const now = "2026-11-26T06:00:00.000Z";

function agent(username: string, status: Participant["status"], extra: Partial<Participant> = {}) {
  return {
    id: crypto.randomUUID(),
    roomId: "build",
    username,
    type: "agent",
    status,
    joinedAt: now,
    lastSeenAt: now,
    ...extra,
  } as Participant;
}

function connection(status: ImConnection["status"], extra: Partial<ImConnection> = {}) {
  return {
    id: crypto.randomUUID(),
    roomId: "build",
    channel: "feishu",
    ownerName: "rd",
    label: "SuperHive",
    status,
    level: "mentions",
    ...extra,
  } as ImConnection;
}

describe("agentCounts", () => {
  it("只数 Agent：离线不算在线，忙碌单独数", () => {
    const people = [
      agent("a", "online"),
      agent("b", "busy"),
      agent("c", "offline"),
      { ...agent("rd", "online"), type: "human" } as Participant,
    ];
    expect(agentCounts(people)).toEqual({ total: 3, online: 2, busy: 1 });
  });
});

describe("contextPercent", () => {
  it("按自动压缩阈值算百分比，最多 100，不知道阈值时没有", () => {
    const context = { contextTokens: 50_000, compactWindow: 200_000 };
    expect(contextPercent(agent("a", "online", { context } as Partial<Participant>))).toBe(25);
    expect(
      contextPercent(
        agent("a", "online", {
          context: { contextTokens: 300_000, compactWindow: 200_000 },
        } as Partial<Participant>),
      ),
    ).toBe(100);
    expect(
      contextPercent(
        agent("a", "online", { context: { contextTokens: 1 } } as Partial<Participant>),
      ),
    ).toBeUndefined();
    expect(contextPercent(undefined)).toBeUndefined();
  });
});

describe("imSummary", () => {
  it("要处理的优先，其次连接中，再是已连上的渠道", () => {
    expect(imSummary(undefined)).toBeUndefined();
    expect(imSummary([])?.tone).toBe("pending");
    expect(imSummary([connection("connected"), connection("error")])).toMatchObject({
      tone: "warning",
    });
    expect(imSummary([connection("connected"), connection("connecting")])?.tone).toBe("pending");
    expect(imSummary([connection("connected")])).toEqual({ tone: "ok", label: "飞书" });
  });
});

function fakeLocal(extra: Partial<LocalAgentsState> = {}): LocalAgentsState {
  const proxy: NetworkProxyState = {
    mode: "system",
    url: "http://127.0.0.1:7890",
    effective: { url: "http://127.0.0.1:7890" },
  } as NetworkProxyState;
  return {
    enabled: true,
    canManage: true,
    networkProxy: vi.fn(async () => proxy),
    updateNetworkProxy: vi.fn(async (input: { mode: NetworkProxyState["mode"] }) => ({
      ...proxy,
      mode: input.mode,
    })),
    ...extra,
  } as unknown as LocalAgentsState;
}

function renderBar(overrides: Partial<StatusBarProps> = {}) {
  const props: StatusBarProps = {
    connectionState: "online",
    meta: undefined,
    participants: [agent("rd-claude", "busy"), agent("rd-codex", "online")],
    leadAgentName: "rd-claude",
    isOwner: true,
    local: { enabled: false } as unknown as LocalAgentsState,
    openAgentTasks: vi.fn(),
    openSettings: vi.fn(),
    openProxySettings: vi.fn(),
    settingsOpen: false,
    messageNotifications: "mentions",
    updateMessageNotifications: vi.fn(async () => undefined),
    sendShortcut: "modifier-enter",
    setSendShortcut: vi.fn(),
    themePreference: "system",
    setThemePreference: vi.fn(),
    interfaceDensity: "comfortable",
    setInterfaceDensity: vi.fn(),
    localePreference: "system",
    hide: vi.fn(),
    ...overrides,
  };
  render(<StatusBar {...props} />);
  return props;
}

describe("StatusBar", () => {
  it("左边显示连接和 Agent 数，点 Agent 数打开任务面板", () => {
    const props = renderBar();
    expect(screen.getByRole("contentinfo", { name: "状态栏" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hive 连接：已连接" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /2 个 Agent 在线、1 个正在执行任务/ }));
    expect(props.openAgentTasks).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "主 Agent rd-claude：忙碌" })).toBeTruthy();
  });

  it("改发送方式：弹出单选、写进 localStorage，Esc 关掉并把焦点还给按钮", () => {
    const props = renderBar();
    const trigger = screen.getByRole("button", { name: "发送消息的快捷键" });
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const dialog = screen.getByRole("dialog", { name: "发送消息的快捷键" });
    fireEvent.click(screen.getByRole("radio", { name: /Enter 发送/ }));
    expect(props.setSendShortcut).toHaveBeenCalledWith("enter");
    expect(localStorage.getItem("superhive.send-shortcut")).toBe("enter");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("外观菜单改主题和密度，也能隐藏状态栏", () => {
    const props = renderBar();
    fireEvent.click(screen.getByRole("button", { name: "外观：主题、密度和语言" }));
    fireEvent.click(screen.getByRole("radio", { name: "深色" }));
    expect(props.setThemePreference).toHaveBeenCalledWith("dark");
    fireEvent.click(screen.getByRole("radio", { name: "紧凑" }));
    expect(props.setInterfaceDensity).toHaveBeenCalledWith("compact");
    fireEvent.click(screen.getByRole("button", { name: /隐藏状态栏/ }));
    expect(props.hide).toHaveBeenCalled();
  });

  it("菜单里 ↓ 在选项之间移动", () => {
    renderBar();
    fireEvent.click(screen.getByRole("button", { name: "消息通知" }));
    const dialog = screen.getByRole("dialog", { name: "消息通知" });
    const radios = screen.getAllByRole("radio");
    expect(document.activeElement).toBe(screen.getByRole("radio", { checked: true }));
    const index = radios.indexOf(document.activeElement as HTMLElement);
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    expect(document.activeElement).toBe(radios[(index + 1) % radios.length]);
  });

  it("本机房主才看到代理；切代理调同一个接口", async () => {
    const local = fakeLocal();
    renderBar({ local });
    const proxy = await screen.findByRole("button", { name: "本机 Agent 的网络代理" });
    expect(proxy.textContent).toContain("跟随系统");
    fireEvent.click(proxy);
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: /不用代理/ }));
    });
    expect(local.updateNetworkProxy).toHaveBeenCalledWith({ mode: "none" });
  });

  it("Server 这台电脑上的房主才看到「MCP · 技能」，点开进统一管理", async () => {
    const runtimeOverview = vi.fn(async () => ({
      providers: [],
      mcp: [{ name: "docs", entries: [] }],
      skills: [
        { name: "pdf", entries: [] },
        { name: "lark", entries: [] },
      ],
    }));
    const props = renderBar({ local: fakeLocal({ mode: "local", runtimeOverview }) });
    const item = await screen.findByRole("button", {
      name: "管理这台电脑上各 CLI 的全局 MCP 和技能",
    });
    expect(item.textContent).toContain("MCP 1 · 技能 2");
    fireEvent.click(item);
    expect(props.openSettings).toHaveBeenCalledWith("runtimes");
    cleanup();

    // 房主的其他设备：没有这一项，也不去读
    const remote = vi.fn(runtimeOverview);
    renderBar({ local: fakeLocal({ mode: "device", runtimeOverview: remote }) });
    await screen.findByRole("button", { name: "本机 Agent 的网络代理" });
    expect(screen.queryByRole("button", { name: /全局 MCP 和技能/ })).toBeNull();
    expect(remote).not.toHaveBeenCalled();
  });

  it("访客：没有代理、IM、故障这些房主才有的项", () => {
    renderBar({ isOwner: false });
    expect(screen.queryByRole("button", { name: "本机 Agent 的网络代理" })).toBeNull();
    expect(screen.queryByRole("button", { name: /IM 连接/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /故障/ })).toBeNull();
    // 和自己有关的照常显示
    expect(screen.getByRole("button", { name: "消息通知" })).toBeTruthy();
  });

  it("有故障时显示数量，点开故障单", () => {
    const open = vi.fn();
    renderBar({ incidents: { count: 3, open } });
    fireEvent.click(screen.getByRole("button", { name: /3 个故障还没处理/ }));
    expect(open).toHaveBeenCalled();
  });

  it("断开时连接项标红并在弹窗里说明", () => {
    renderBar({ connectionState: "offline" });
    const item = screen.getByRole("button", { name: "Hive 连接：已断开" });
    expect(item.className).toContain("danger");
    fireEvent.click(item);
    expect(screen.getByText(/连不上 Hive Server/)).toBeTruthy();
  });
});
