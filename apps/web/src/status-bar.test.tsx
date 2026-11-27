// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImConnection, NetworkProxyState, Participant } from "@superhive/protocol";
import type { LocalAgentsState } from "./local-agents";
import {
  StatusBar,
  agentCounts,
  agentsOf,
  filterLeadChoices,
  contextPercent,
  imSummary,
  leadCacheState,
  type StatusBarProps,
} from "./status-bar";
import { resetUpdateCenter, updateCenter } from "./update-center";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  resetUpdateCenter();
  delete window.superhiveDesktop;
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

describe("leadCacheState", () => {
  const at = Date.parse(now);
  const expires = (ms: number) => ({ cacheExpiresAt: new Date(at + ms).toISOString() });
  it("充足、不到 5 分钟临期、到点才算过期；不知道有效期返回 undefined", () => {
    expect(leadCacheState(expires(23.5 * 60_000), at)).toEqual({ tone: "ok", minutes: 23 });
    expect(leadCacheState(expires(4 * 60_000 + 59_000), at)).toEqual({
      tone: "warning",
      minutes: 4,
    });
    // 最后不到一分钟还没过期，不提前标成过期
    expect(leadCacheState(expires(30_000), at)).toEqual({ tone: "warning", minutes: 0 });
    expect(leadCacheState(expires(0), at)).toEqual({ tone: "expired", minutes: 0 });
    expect(leadCacheState(expires(-60_000), at)).toEqual({ tone: "expired", minutes: 0 });
    expect(leadCacheState({}, at)).toBeUndefined();
    expect(leadCacheState({ cacheExpiresAt: "bad" }, at)).toBeUndefined();
    expect(leadCacheState(undefined, at)).toBeUndefined();
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
    openRuntimeHub: vi.fn(),
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

  it("房主点主 Agent 能直接换成房间里别的 Agent；访客没有切换", () => {
    const setLeadAgent = vi.fn();
    renderBar({ setLeadAgent });
    fireEvent.click(screen.getByRole("button", { name: "主 Agent rd-claude：忙碌" }));
    // 先只有一个入口，点了才列出 Agent
    expect(screen.queryByRole("listbox", { name: "切换主 Agent" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /切换主 Agent/ }));
    const group = screen.getByRole("listbox", { name: "切换主 Agent" });
    expect(group).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: /rd-codex/ }));
    expect(setLeadAgent).toHaveBeenCalledWith("rd-codex");
    expect(screen.queryByRole("dialog")).toBeNull();
    cleanup();
    renderBar({ setLeadAgent: undefined });
    fireEvent.click(screen.getByRole("button", { name: "主 Agent rd-claude：忙碌" }));
    expect(screen.queryByRole("button", { name: /切换主 Agent/ })).toBeNull();
  });

  it("没有主 Agent 时房主能在状态栏里选一个", () => {
    const setLeadAgent = vi.fn();
    renderBar({ setLeadAgent, leadAgentName: undefined });
    fireEvent.click(screen.getByRole("button", { name: /这个房间还没有主 Agent/ }));
    fireEvent.click(screen.getByRole("option", { name: /rd-claude/ }));
    expect(setLeadAgent).toHaveBeenCalledWith("rd-claude");
  });

  it("自动设的主 Agent 名字后面标「自动」，详情里写明是自动设的", () => {
    renderBar({ leadAuto: true });
    const trigger = screen.getByRole("button", { name: "主 Agent rd-claude（自动设的）：忙碌" });
    expect(trigger.textContent).toContain("自动");
    fireEvent.click(trigger);
    expect(screen.getByText("自动（第一个加入的 Agent）")).toBeTruthy();
    cleanup();
    renderBar();
    const manual = screen.getByRole("button", { name: "主 Agent rd-claude：忙碌" });
    expect(manual.textContent).not.toContain("自动");
    fireEvent.click(manual);
    expect(screen.getByText("房主指定")).toBeTruthy();
  });

  it("手动设的主 Agent 被删后，「设主 Agent」先给建议人选：在线的本机 Agent 优先", () => {
    const setLeadAgent = vi.fn();
    renderBar({
      setLeadAgent,
      leadAgentName: "gone",
      participants: [
        agent("remote", "online", { joinedAt: "2026-11-26T05:00:00.000Z" }),
        agent("offline-local", "offline"),
        agent("local", "busy"),
      ],
      local: fakeLocal({
        agents: [{ name: "local" }, { name: "offline-local" }],
      } as unknown as Partial<LocalAgentsState>),
    });
    fireEvent.click(screen.getByRole("button", { name: /主 Agent gone 已不在这个房间/ }));
    expect(screen.getByText("主 Agent gone 已不在这个房间，请重新选择。")).toBeTruthy();
    expect(screen.getByText("建议：local")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "设为主 Agent" }));
    expect(setLeadAgent).toHaveBeenCalledWith("local");
  });

  it("没有本机 Agent 时建议最先加入的在线 Agent", () => {
    renderBar({
      setLeadAgent: vi.fn(),
      leadAgentName: undefined,
      participants: [
        agent("late", "online", { joinedAt: "2026-11-26T07:00:00.000Z" }),
        agent("early", "online", { joinedAt: "2026-11-26T05:00:00.000Z" }),
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: /这个房间还没有主 Agent/ }));
    expect(screen.getByText("建议：early")).toBeTruthy();
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

  it("Server 这台电脑上的房主才看到「MCP · 技能」，点开直接是 MCP 与技能大面板", async () => {
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
      name: "给这台电脑上的各个 CLI 装 MCP、管理技能",
    });
    expect(item.textContent).toContain("MCP 1 · 技能 2");
    fireEvent.click(item);
    expect(props.openRuntimeHub).toHaveBeenCalled();
    expect(props.openSettings).not.toHaveBeenCalled();
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

  describe("版本弹层里的「检查更新」", () => {
    const open = () => fireEvent.click(screen.getByRole("button", { name: "Hive 连接：已连接" }));

    it("网页版房主点了收起弹层，绕开缓存查一次，结果在右下角说", async () => {
      const fetcher = vi.fn(async (url: string) =>
        Response.json(
          url.endsWith("/api/update?refresh=1")
            ? { update: null, current: "0.4.9", blocker: null }
            : url.endsWith("/api/update")
              ? { update: null }
              : [],
        ),
      );
      vi.stubGlobal("fetch", fetcher);
      renderBar({
        im: { base: "http://localhost:9999", token: "owner", dialogOpen: false, open: vi.fn() },
      });
      await waitFor(() => expect(updateCenter().npmCheck).toBeTruthy());
      open();
      fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
      expect(screen.queryByRole("dialog", { name: /Hive 连接/ })).toBeNull();
      await waitFor(() => expect(updateCenter().notice?.text).toBe("已是最新版本 0.4.9"));
      expect(fetcher.mock.calls.some((call) => call[0].endsWith("?refresh=1"))).toBe(true);
    });

    it("访客、没有更新渠道时不显示", () => {
      renderBar({ isOwner: false });
      open();
      expect(screen.queryByRole("button", { name: "检查更新" })).toBeNull();
    });

    it("桌面端问客户端马上查一次", async () => {
      const fn = vi.fn();
      const checkNow = vi.fn(async () => ({ status: "latest" as const, currentVersion: "0.4.9" }));
      window.superhiveDesktop = {
        version: 1,
        platform: "darwin",
        terminal: Object.fromEntries(
          ["create", "write", "resize", "kill", "onData", "onExit", "onNewRequest"].map((name) => [
            name,
            fn,
          ]),
        ),
        updates: {
          get: vi.fn(async () => null),
          open: fn,
          dismiss: fn,
          onChange: vi.fn(() => () => undefined),
          checkNow,
        },
      };
      renderBar();
      open();
      fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
      await waitFor(() => expect(updateCenter().notice?.text).toBe("已是最新版本 0.4.9"));
      expect(checkNow).toHaveBeenCalledOnce();
    });
  });

  it("断开时连接项标红并在弹窗里说明", () => {
    renderBar({ connectionState: "offline" });
    const item = screen.getByRole("button", { name: "Hive 连接：已断开" });
    expect(item.className).toContain("danger");
    fireEvent.click(item);
    expect(screen.getByText(/连不上 Hive Server/)).toBeTruthy();
  });

  describe("主 Agent 弹层", () => {
    const leadWith = (context: NonNullable<Participant["context"]>) => [
      agent("rd-claude", "busy", { context } as Partial<Participant>),
      agent("rd-codex", "online"),
    ];
    const minutesFromNow = (minutes: number) =>
      new Date(Date.now() + minutes * 60_000 + 30_000).toISOString();
    const openLead = () => {
      fireEvent.click(screen.getByRole("button", { name: "主 Agent rd-claude：忙碌" }));
      return screen.getByRole("dialog", { name: "主 Agent rd-claude：忙碌" });
    };

    it("上下文一行：进度条 · 百分比 · 用量/阈值；不再有成段说明，解释在悬停提示里", () => {
      renderBar({
        participants: leadWith({
          at: now,
          contextTokens: 121_000,
          compactWindow: 400_000,
          cacheExpiresAt: minutesFromNow(23),
        }),
      });
      const dialog = openLead();
      expect(screen.getByRole("meter", { name: "上下文用量" }).getAttribute("aria-valuenow")).toBe(
        "30",
      );
      expect(dialog.textContent).toContain("30%");
      expect(dialog.textContent).toMatch(/121k\s*\/\s*400k/);
      expect(dialog.textContent).not.toContain("上一轮结束时");
      expect(dialog.textContent).not.toContain("离自动压缩阈值");
      expect(dialog.textContent).not.toContain("从最后一次模型请求算起");
      expect(dialog.querySelector(".status-popover-note")).toBeNull();
      // 解释还在：读屏名 / 悬停提示里
      const line = dialog.querySelector(".status-context-line")!;
      expect(line.getAttribute("aria-label")).toContain("离自动压缩阈值 400k 还有 279k");
      expect(line.getAttribute("aria-label")).not.toContain("缓存");
    });

    it("缓存单独一行 chip：充足、临期、过期三种状态", () => {
      renderBar({
        participants: leadWith({
          at: now,
          contextTokens: 1000,
          compactWindow: 400_000,
          cacheExpiresAt: minutesFromNow(23),
        }),
      });
      let chip = openLead().querySelector(".status-cache-chip")!;
      expect(chip.textContent).toBe("还剩 23 分钟");
      expect(chip.className).toContain("ok");
      expect(chip.getAttribute("aria-label")).toContain("从最后一次模型请求算起");
      cleanup();
      renderBar({
        participants: leadWith({ at: now, contextTokens: 1000, cacheExpiresAt: minutesFromNow(3) }),
      });
      chip = openLead().querySelector(".status-cache-chip")!;
      expect(chip.textContent).toBe("还剩 3 分钟");
      expect(chip.className).toContain("warning");
      cleanup();
      renderBar({
        participants: leadWith({
          at: now,
          contextTokens: 1000,
          cacheExpiresAt: new Date(Date.now() - 60_000).toISOString(),
        }),
      });
      chip = openLead().querySelector(".status-cache-chip")!;
      expect(chip.textContent).toBe("已过期");
      expect(chip.className).toContain("expired");
    });

    it("不知道缓存有效期就整行不显示", () => {
      renderBar({
        participants: leadWith({ at: now, contextTokens: 1000, compactWindow: 400_000 }),
      });
      const dialog = openLead();
      expect(dialog.querySelector(".status-cache-chip")).toBeNull();
      expect(screen.queryByText("缓存")).toBeNull();
      expect(screen.getByText("上下文")).toBeTruthy();
    });

    it("「切换主 Agent」展开后能收起：再点开关、选当前那项、选别的、Esc、点外面", async () => {
      const setLeadAgent = vi.fn();
      renderBar({ setLeadAgent });
      const trigger = screen.getByRole("button", { name: "主 Agent rd-claude：忙碌" });
      openLead();
      const toggle = screen.getByRole("button", { name: /切换主 Agent/ });
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      // 展开后开关还在，再点一次收起
      fireEvent.click(toggle);
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      expect(screen.getByRole("listbox", { name: "切换主 Agent" })).toBeTruthy();
      expect(document.activeElement).toBe(screen.getByRole("option", { name: /rd-claude/ }));
      fireEvent.click(toggle);
      expect(screen.queryByRole("listbox", { name: "切换主 Agent" })).toBeNull();
      expect(screen.getByRole("dialog")).toBeTruthy();

      // 选当前那项：关掉弹层、不发请求、焦点回到状态栏按钮
      fireEvent.click(toggle);
      fireEvent.click(screen.getByRole("option", { name: /rd-claude/ }));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(setLeadAgent).not.toHaveBeenCalled();
      await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
      expect(document.activeElement).toBe(trigger);

      // Esc：焦点在列表里时
      openLead();
      fireEvent.click(screen.getByRole("button", { name: /切换主 Agent/ }));
      fireEvent.keyDown(screen.getByRole("option", { name: /rd-codex/ }), { key: "Escape" });
      expect(screen.queryByRole("dialog")).toBeNull();
      await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
      expect(document.activeElement).toBe(trigger);

      // Esc：焦点不在弹层里（落在 body）时也能关
      openLead();
      (document.activeElement as HTMLElement | null)?.blur();
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(screen.queryByRole("dialog")).toBeNull();

      // 点外面：关掉，焦点没被别处接走就回到按钮
      openLead();
      fireEvent.click(screen.getByRole("button", { name: /切换主 Agent/ }));
      fireEvent.pointerDown(document.body);
      expect(screen.queryByRole("dialog")).toBeNull();
      await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
      expect(document.activeElement).toBe(trigger);

      // 选别的：切换并关掉
      openLead();
      fireEvent.click(screen.getByRole("button", { name: /切换主 Agent/ }));
      fireEvent.click(screen.getByRole("option", { name: /rd-codex/ }));
      expect(setLeadAgent).toHaveBeenCalledWith("rd-codex");
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("点外面的输入框关掉弹层时，不把焦点抢回状态栏按钮", async () => {
      renderBar();
      const input = document.createElement("input");
      document.body.append(input);
      openLead();
      fireEvent.pointerDown(input);
      input.focus();
      expect(screen.queryByRole("dialog")).toBeNull();
      await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
      expect(document.activeElement).toBe(input);
      input.remove();
    });
  });
});

describe("切换主 Agent 的列表", () => {
  const roster = (count: number) => [
    agent("lead", "online", { provider: "claude" }),
    agent("busy-one", "busy", { provider: "codex" }),
    agent("gone", "offline", { provider: "mystery" }),
    ...Array.from({ length: count - 3 }, (_, index) =>
      agent(`idle-${String(index).padStart(2, "0")}`, "online", { provider: "claude" }),
    ),
  ];
  const openList = (participants: Participant[]) => {
    const setLeadAgent = vi.fn();
    renderBar({ setLeadAgent, leadAgentName: "lead", participants });
    fireEvent.click(screen.getByRole("button", { name: /^主 Agent lead/ }));
    fireEvent.click(screen.getByRole("button", { name: /切换主 Agent/ }));
    return setLeadAgent;
  };

  it("排序：在线空闲的在前，忙的其次，离线的最后；同一档按名字", () => {
    const sorted = agentsOf([
      agent("z-off", "offline"),
      agent("b-busy", "busy"),
      agent("y-idle", "online"),
      { ...agent("rd", "online"), type: "human" } as Participant,
      agent("a-busy", "busy"),
      agent("x-idle", "online"),
    ]).map((participant) => participant.username);
    expect(sorted).toEqual(["x-idle", "y-idle", "a-busy", "b-busy", "z-off"]);
  });

  it("过滤按名字或运行时，不分大小写；空白不过滤", () => {
    const list = [
      agent("rd-Claude", "online", { provider: "claude" }),
      agent("glm", "online", { provider: "omp" }),
    ];
    expect(filterLeadChoices(list, "  ")).toBe(list);
    expect(filterLeadChoices(list, "CLAU").map((a) => a.username)).toEqual(["rd-Claude"]);
    expect(filterLeadChoices(list, "omp").map((a) => a.username)).toEqual(["glm"]);
  });

  it("每项有运行时图标；忙的写「忙」，离线的变灰排最后且不能选", () => {
    const setLeadAgent = openList(roster(5));
    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.querySelector(".status-lead-name")?.textContent)).toEqual(
      ["idle-00", "idle-01", "lead", "busy-one", "gone"],
    );
    // claude / codex 有厂商标识，未知运行时回退成 AI
    expect(options[0]!.querySelector(".status-lead-avatar .provider-logo")).toBeTruthy();
    expect(options[4]!.querySelector(".status-lead-avatar")?.textContent).toBe("AI");
    const busy = screen.getByRole("option", { name: "busy-one（codex）：忙碌" });
    expect(busy.querySelector(".status-lead-state")?.textContent).toBe("忙");
    expect(
      screen.getByRole("option", { name: "lead（claude）：在线" }).getAttribute("aria-selected"),
    ).toBe("true");
    const offline = screen.getByRole("option", { name: "gone（mystery）：离线，不能设为主 Agent" });
    expect(offline.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(offline);
    expect(setLeadAgent).not.toHaveBeenCalled();
    // 不到 8 个没有过滤框，焦点落在当前主 Agent 那项
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("option", { name: /^lead/ }));
  });

  it("Agent 超过 8 个时顶上有过滤框：焦点进框，↑↓ 跳过离线的，回车选中", () => {
    const setLeadAgent = openList(roster(16));
    const input = screen.getByRole("combobox", { name: "过滤 Agent" });
    expect(document.activeElement).toBe(input);
    // 一开始高亮当前主 Agent
    const activeName = () =>
      document
        .getElementById(input.getAttribute("aria-activedescendant")!)
        ?.querySelector(".status-lead-name")?.textContent;
    expect(activeName()).toBe("lead");

    fireEvent.change(input, { target: { value: "o" } });
    // 剩 busy-one、gone：离线的 gone 在列表里但高亮跳过它
    expect(
      screen.getAllByRole("option").map((o) => o.querySelector(".status-lead-name")?.textContent),
    ).toEqual(["busy-one", "gone"]);
    expect(activeName()).toBe("busy-one");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(activeName()).toBe("busy-one");
    expect(document.activeElement).toBe(input);

    fireEvent.change(input, { target: { value: "idle-1" } });
    expect(activeName()).toBe("idle-10");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(activeName()).toBe("idle-11");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(activeName()).toBe("idle-12");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(setLeadAgent).toHaveBeenCalledWith("idle-12");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("过滤不到时提示没有匹配；框里按 Esc 关掉弹层", () => {
    const setLeadAgent = openList(roster(9));
    const input = screen.getByRole("combobox", { name: "过滤 Agent" });
    fireEvent.change(input, { target: { value: "nobody" } });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("没有匹配的 Agent")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(setLeadAgent).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
