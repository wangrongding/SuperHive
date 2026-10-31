// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LocalAgent,
  ChatMessage,
  Invocation,
  Participant,
  ServerEvent,
} from "@ai-hive/protocol";
import { App } from "./App";

type RoomSnapshotEvent = Extract<ServerEvent, { type: "room.snapshot" }>;
// 与 zod 输入类型一致：快照里的 invocations / whiteboard 有默认值，可以省略
type ServerEventInput =
  | Exclude<ServerEvent, RoomSnapshotEvent>
  | (Omit<RoomSnapshotEvent, "invocations" | "whiteboard"> &
      Partial<Pick<RoomSnapshotEvent, "invocations" | "whiteboard">>);

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly instances: FakeWebSocket[] = [];

  readyState = 0;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.readyState = 3;
    this.emit("close", new Event("close"));
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", new Event("open"));
  }

  serverEvent(event: ServerEventInput): void {
    this.emit("message", new MessageEvent("message", { data: JSON.stringify(event) }));
  }

  private emit(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class FakeNotification {
  static permission: NotificationPermission = "default";
  static nextPermission: NotificationPermission = "granted";
  static readonly instances: FakeNotification[] = [];

  static async requestPermission(): Promise<NotificationPermission> {
    FakeNotification.permission = FakeNotification.nextPermission;
    return FakeNotification.permission;
  }

  constructor(
    readonly title: string,
    readonly options?: NotificationOptions,
  ) {
    FakeNotification.instances.push(this);
  }
}

function participant(id: string, username: string, type: Participant["type"]): Participant {
  return {
    id,
    roomId: "general",
    username,
    type,
    status: "online",
    joinedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const roomSummary = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  createdAt: `2026-07-18T00:00:0${id === "general" ? 0 : 1}.000Z`,
  onlineCount: 0,
  latestSeq: 0,
  ...extra,
});

const crossRoom: {
  mentions: ChatMessage[];
  invocations: Invocation[];
  invocationMessages: ChatMessage[];
  searchable: ChatMessage[];
} = { mentions: [], invocations: [], invocationMessages: [], searchable: [] };

/** 本机 Agent 接口的假实现；enabled 为 false 时 /api/local/session 返回 404（非本机） */
const localApi: {
  enabled: boolean;
  agents: LocalAgent[];
  requests: Array<{ url: string; method: string; owner: string | null; body?: unknown }>;
} = { enabled: false, agents: [], requests: [] };

function localAgent(overrides: Partial<LocalAgent> = {}): LocalAgent {
  return {
    id: "00000000-0000-4000-8000-0000000000e1",
    provider: "opencode",
    name: "Alice-opencode",
    access: "read-only",
    cwd: null,
    model: null,
    status: "starting",
    pid: 4242,
    startedAt: new Date().toISOString(),
    lastExitCode: null,
    lastError: null,
    restarts: 0,
    createdAt: new Date().toISOString(),
    mcpDisabled: [],
    ...overrides,
  } as LocalAgent;
}

describe("App mention autocomplete", () => {
  beforeEach(() => {
    FakeWebSocket.instances.length = 0;
    FakeNotification.instances.length = 0;
    crossRoom.mentions = [];
    crossRoom.invocations = [];
    crossRoom.invocationMessages = [];
    crossRoom.searchable = [];
    localApi.enabled = false;
    localApi.agents = [];
    localApi.requests = [];
    FakeNotification.permission = "default";
    FakeNotification.nextPermission = "granted";
    localStorage.clear();
    window.history.replaceState(null, "", window.location.pathname);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("Notification", FakeNotification);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/meta")) {
          return jsonResponse({
            name: "AI Hive",
            roomId: "general",
            httpUrl: "http://10.0.0.8:8787",
            wsUrl: "ws://10.0.0.8:8787/ws",
            mcpUrl: "http://10.0.0.8:8787/mcp",
            joinToken: "test-token",
            agentCommand:
              "npx --yes ai-hive@latest join --server http://10.0.0.8:8787 --name my-agent --token test-token",
          });
        }
        if (url.includes("/invites")) {
          if (init?.method === "POST") {
            return jsonResponse({
              token: "hvi_test",
              invite: {
                id: "00000000-0000-4000-8000-000000000999",
                roomId: "general",
                createdAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
                allowAgents: false,
                uses: 0,
              },
            });
          }
          return jsonResponse({ invites: [] });
        }
        if (url.includes("/api/local/")) {
          if (!localApi.enabled) return jsonResponse({ error: "not found" }, 404);
          const method = init?.method ?? "GET";
          const owner = new Headers(init?.headers).get("X-Hive-Owner");
          localApi.requests.push({
            url,
            method,
            owner,
            ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
          });
          if (url.endsWith("/api/local/session")) {
            return jsonResponse({ enabled: true, ownerToken: "owner-secret" });
          }
          if (owner !== "owner-secret") return jsonResponse({ error: "unauthorized" }, 401);
          if (url.includes("/api/local/directories")) {
            const target = new URL(url).searchParams.get("path");
            const launch = "/Users/alice/hive";
            const current = target ?? launch;
            return jsonResponse({
              path: current,
              parent: current === "/" ? null : current.replace(/\/[^/]+$/, "") || "/",
              entries: [
                { name: "apps", path: `${current}/apps` },
                { name: "packages", path: `${current}/packages` },
              ],
              truncated: false,
              defaults: { launch, home: "/Users/alice" },
            });
          }
          if (url.endsWith("/api/local/providers")) {
            return jsonResponse({
              providers: [
                { provider: "codex", command: "codex", installed: false, version: null },
                { provider: "opencode", command: "opencode", installed: true, version: "1.19.4" },
              ],
            });
          }
          if (url.endsWith("/api/local/agents") && method === "POST") {
            const body = JSON.parse(String(init!.body)) as { name: string };
            const agent = localAgent({ name: body.name });
            localApi.agents.push(agent);
            return jsonResponse({ agent }, 201);
          }
          if (url.endsWith("/api/local/agents")) return jsonResponse({ agents: localApi.agents });
        }
        if (url.includes("/api/mentions")) {
          return jsonResponse({ messages: crossRoom.mentions });
        }
        if (url.includes("/api/invocations")) {
          return jsonResponse({
            invocations: crossRoom.invocations,
            messages: crossRoom.invocationMessages,
          });
        }
        if (url.includes("/api/search")) {
          const query = new URL(url).searchParams.get("q") ?? "";
          return jsonResponse({
            messages: crossRoom.searchable.filter((message) => message.content.includes(query)),
          });
        }
        if (/\/api\/rooms\/[^/]+\/messages/.test(url)) {
          return jsonResponse({ messages: [], latestSeq: 0 });
        }
        if (url.includes("/api/rooms") && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as { id: string; name?: string };
          return jsonResponse({ room: roomSummary(body.id, { name: body.name ?? body.id }) }, 201);
        }
        if (url.includes("/api/rooms")) {
          return jsonResponse({ rooms: [roomSummary("general"), roomSummary("frontend")] });
        }
        return jsonResponse({ error: "not found" }, 404);
      }),
    );
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    window.requestAnimationFrame = (callback) => {
      callback(0);
      return 1;
    };
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("connects through the reachable dev server instead of an advertised stale LAN address", async () => {
    localStorage.setItem("ai-hive.username", "Alice");
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    // /api/meta advertises 10.0.0.8, but the page reaches the server through localhost.
    expect(socket.url).toBe("ws://localhost:8787/ws");
    act(() => socket.open());
    const self = participant("00000000-0000-4000-8000-000000000001", "Alice", "human");
    act(() =>
      socket.serverEvent({
        type: "room.snapshot",
        self,
        participants: [self],
        messages: [],
        latestSeq: 0,
      }),
    );
    expect(document.querySelector(".connection")?.classList.contains("online")).toBe(true);
  });

  it("keeps the mention option chosen with the keyboard in view", async () => {
    localStorage.setItem("ai-hive.username", "Alice");
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    const self = participant("00000000-0000-4000-8000-000000000001", "Alice", "human");
    const others = ["Bob", "Carol", "Dave"].map((name, index) =>
      participant(`00000000-0000-4000-8000-00000000001${index}`, name, "human"),
    );
    act(() =>
      socket.serverEvent({
        type: "room.snapshot",
        self,
        participants: [self, ...others],
        messages: [],
        latestSeq: 0,
      }),
    );
    const composer = screen.getByLabelText<HTMLTextAreaElement>("消息");
    fireEvent.change(composer, { target: { value: "@", selectionStart: 1 } });
    const scrolled = vi.mocked(Element.prototype.scrollIntoView);
    scrolled.mockClear();

    fireEvent.keyDown(composer, { key: "ArrowUp" });
    const last = screen.getAllByRole("option").at(-1)!;
    expect(last.getAttribute("aria-selected")).toBe("true");
    expect(scrolled.mock.contexts.at(-1)).toBe(last);
    expect(scrolled.mock.calls.at(-1)).toEqual([{ block: "nearest" }]);

    // 列表滚动后浏览器补发的鼠标事件（鼠标没动）不改变选中项
    const first = screen.getAllByRole("option")[0]!;
    fireEvent.mouseEnter(first);
    fireEvent.mouseMove(first);
    expect(last.getAttribute("aria-selected")).toBe("true");
  });

  it("recalls own sent messages with the arrow keys without touching a draft in progress", async () => {
    localStorage.setItem("ai-hive.username", "Alice");
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    const self = participant("00000000-0000-4000-8000-000000000001", "Alice", "human");
    const sent = (seq: number, senderName: string, content: string): ChatMessage => ({
      id: `00000000-0000-4000-8000-0000000001${String(seq).padStart(2, "0")}`,
      roomId: "general",
      seq,
      senderId: self.id,
      senderName,
      senderType: "human",
      content,
      mentions: [],
      traceId: "00000000-0000-4000-8000-000000000200",
      hopCount: 0,
      createdAt: "2026-10-31T00:00:00.000Z",
    });
    act(() =>
      socket.serverEvent({
        type: "room.snapshot",
        self,
        participants: [self],
        messages: [
          sent(1, "Alice", "第一条"),
          sent(2, "Bob", "别人的"),
          sent(3, "Alice", "第二条 @Bob"),
        ],
        latestSeq: 3,
      }),
    );
    const composer = screen.getByLabelText<HTMLTextAreaElement>("消息");

    fireEvent.keyDown(composer, { key: "ArrowUp" });
    expect(composer.value).toBe("第二条 @Bob");
    fireEvent.select(composer);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(localStorage.getItem("ai-hive.draft.alice.general")).toBeNull();
    fireEvent.keyDown(composer, { key: "ArrowUp" });
    expect(composer.value).toBe("第一条");
    fireEvent.keyDown(composer, { key: "ArrowDown" });
    fireEvent.keyDown(composer, { key: "ArrowDown" });
    expect(composer.value).toBe("");

    fireEvent.change(composer, { target: { value: "写到一半" } });
    fireEvent.keyDown(composer, { key: "ArrowUp" });
    expect(composer.value).toBe("写到一半");
  });

  it("opens on @, excludes self, filters members, and supports arrows, Enter, and Tab", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.type(screen.getByLabelText("你的用户名"), "Alice");
    await user.click(screen.getByRole("button", { name: /进入聊天室/ }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    // 默认开启 @ 通知，进入聊天室的点击手势里顺带请求浏览器授权
    await waitFor(() => expect(FakeNotification.permission).toBe("granted"));
    expect(screen.queryByRole("status", { name: "开启浏览器通知" })).toBeNull();

    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({
      type: "participant.join",
      username: "Alice",
    });

    // 快照到达前还在加载：不能先闪出"空房间"欢迎页
    const messageShadow = () =>
      document.querySelector(".message-list")!.shadowRoot as unknown as HTMLElement;
    expect(within(messageShadow()).queryByText(/协作什么？/)).toBeNull();

    const self = participant("00000000-0000-4000-8000-000000000001", "Alice", "human");
    act(() =>
      socket.serverEvent({
        type: "room.snapshot",
        self,
        participants: [
          self,
          participant("00000000-0000-4000-8000-000000000002", "backend-agent", "agent"),
          participant("00000000-0000-4000-8000-000000000003", "frontend-agent", "agent"),
        ],
        messages: [],
        latestSeq: 0,
      }),
    );
    // 快照确认房间是空的，才显示欢迎页
    expect(within(messageShadow()).getByText(/协作什么？/)).toBeTruthy();

    // 主题切换收在头像菜单里
    expect(screen.queryByRole("radiogroup", { name: "颜色主题" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "用户菜单" }));
    const themeSwitcher = within(screen.getByRole("menu", { name: "用户菜单" })).getByRole(
      "radiogroup",
      { name: "颜色主题" },
    );
    await user.click(within(themeSwitcher).getByRole("radio", { name: "浅色" }));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("ai-hive.theme")).toBe("light");
    await user.keyboard("{Escape}");

    const membersPanel = screen.getByLabelText("成员列表");
    // 添加成员的入口（邀请人类、接入 Agent）位于成员列表下方
    expect(within(membersPanel).getByRole("button", { name: "接入 Agent" })).toBeTruthy();
    // 邀请成员：选有效期后生成限时链接并复制
    await user.click(within(membersPanel).getByRole("button", { name: /邀请成员/ }));
    const inviteDialog = await screen.findByRole("dialog", { name: /邀请成员/ });
    expect(within(inviteDialog).getByRole("radio", { name: "24 小时" })).toHaveProperty(
      "ariaChecked",
      "true",
    );
    await user.click(within(inviteDialog).getByRole("button", { name: "生成并复制链接" }));
    expect(await within(inviteDialog).findByText("已复制邀请链接")).toBeTruthy();
    // 页面开在 localhost 上时，邀请链接换成 Server 公布的局域网地址，别人才打得开
    expect(await navigator.clipboard.readText()).toBe(
      `http://10.0.0.8:${window.location.port}/#general?invite=hvi_test`,
    );
    await user.click(within(inviteDialog).getByRole("button", { name: "关闭" }));
    const membersTrigger = screen.getByRole("button", { name: "打开成员列表" });
    await user.click(membersTrigger);
    expect(membersPanel.classList.contains("mobile-open")).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "关闭成员列表" }));
    await user.keyboard("{Escape}");
    expect(membersPanel.classList.contains("mobile-open")).toBe(false);
    expect(document.activeElement).toBe(membersTrigger);

    const composer = screen.getByPlaceholderText("发送消息，输入 @ 选择成员…");
    expect((composer as HTMLTextAreaElement).style.height).toBe("54px");

    const sentBeforeComposition = socket.sent.length;
    fireEvent.compositionStart(composer);
    fireEvent.change(composer, { target: { value: "nihao" } });
    fireEvent.keyDown(composer, {
      key: "Enter",
      code: "Enter",
      keyCode: 229,
      isComposing: true,
    });
    expect(socket.sent).toHaveLength(sentBeforeComposition);
    expect((composer as HTMLTextAreaElement).value).toBe("nihao");
    fireEvent.compositionEnd(composer);
    await user.clear(composer);

    const sentBeforePlainEnter = socket.sent.length;
    fireEvent.change(composer, { target: { value: "默认快捷键" } });
    fireEvent.keyDown(composer, { key: "Enter", code: "Enter" });
    expect(socket.sent).toHaveLength(sentBeforePlainEnter);
    expect((composer as HTMLTextAreaElement).value).toBe("默认快捷键");
    fireEvent.keyDown(composer, { key: "Enter", code: "Enter", ctrlKey: true });
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      type: "message.send",
      content: "默认快捷键",
    });

    const settingsTrigger = screen.getByRole("button", { name: "用户菜单" });
    await user.click(settingsTrigger);
    const userMenu = screen.getByRole("menu", { name: "用户菜单" });
    await user.click(within(userMenu).getByRole("menuitem", { name: /设置/ }));
    const settingsDialog = screen.getByRole("dialog", { name: "偏好设置" });
    expect(
      within(settingsDialog)
        .getByRole("radio", { name: /^组合键发送/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      within(settingsDialog)
        .getByRole("switch", { name: /^自动保存草稿/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.change(composer, { target: { value: "保留这份草稿" } });
    await waitFor(() =>
      expect(localStorage.getItem("ai-hive.draft.alice.general")).toBe("保留这份草稿"),
    );
    await user.click(within(settingsDialog).getByRole("radio", { name: /^Enter 发送/ }));
    expect(localStorage.getItem("ai-hive.send-shortcut")).toBe("enter");
    await user.click(within(settingsDialog).getByRole("radio", { name: "24 小时" }));
    expect(localStorage.getItem("ai-hive.time-format")).toBe("24h");

    await user.click(within(settingsDialog).getByRole("tab", { name: /^通知/ }));
    expect(
      within(settingsDialog)
        .getByRole("radio", { name: /^@ 我时通知/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(within(settingsDialog).queryByRole("button", { name: "立即授权" })).toBeNull();
    await user.click(within(settingsDialog).getByRole("radio", { name: /^关闭通知/ }));
    expect(localStorage.getItem("ai-hive.notify-messages")).toBe("off");
    await user.click(within(settingsDialog).getByRole("radio", { name: /^@ 我时通知/ }));
    await waitFor(() => expect(localStorage.getItem("ai-hive.notify-messages")).toBe("mentions"));
    await user.click(within(settingsDialog).getByRole("switch", { name: /^新消息提示音/ }));
    expect(localStorage.getItem("ai-hive.notification-sound")).toBe("true");
    await user.click(within(settingsDialog).getByRole("switch", { name: /^Agent 上下线/ }));
    expect(localStorage.getItem("ai-hive.notify-agent-presence")).toBe("true");

    await user.click(within(settingsDialog).getByRole("tab", { name: /^外观/ }));
    await user.click(within(settingsDialog).getByRole("radio", { name: "深色" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    await user.click(within(settingsDialog).getByRole("radio", { name: "紧凑" }));
    expect(document.documentElement.dataset.density).toBe("compact");
    await user.click(within(settingsDialog).getByRole("radio", { name: "大" }));
    expect(document.documentElement.dataset.messageSize).toBe("large");
    await user.click(within(settingsDialog).getByRole("switch", { name: /^减少动态效果/ }));
    expect(document.documentElement.dataset.reduceMotion).toBe("true");

    await user.click(within(settingsDialog).getByRole("button", { name: "关闭设置" }));
    expect(screen.queryByRole("dialog", { name: "偏好设置" })).toBeNull();
    expect(document.activeElement).toBe(settingsTrigger);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    const roomMessage = (seq: number, content: string, mentions: string[]) => ({
      id: `00000000-0000-4000-8000-0000000000${String(seq).padStart(2, "0")}`,
      roomId: "general",
      seq,
      senderId: "00000000-0000-4000-8000-000000000002",
      senderName: "backend-agent",
      senderType: "agent" as const,
      content,
      mentions,
      traceId: "00000000-0000-4000-8000-000000000011",
      hopCount: 1,
      createdAt: new Date().toISOString(),
    });
    act(() =>
      socket.serverEvent({
        type: "message.created",
        message: roomMessage(1, "@Alice 请查看这个结果", ["Alice"]),
      }),
    );
    expect(FakeNotification.instances.at(-1)?.title).toContain("提到了你");

    const notificationsBeforePlainMessage = FakeNotification.instances.length;
    act(() =>
      socket.serverEvent({
        type: "message.created",
        message: roomMessage(2, "没有提到任何人的普通消息", []),
      }),
    );
    expect(FakeNotification.instances).toHaveLength(notificationsBeforePlainMessage);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    await user.click(settingsTrigger);
    await user.click(
      within(screen.getByRole("menu", { name: "用户菜单" })).getByRole("menuitem", {
        name: /设置/,
      }),
    );
    const reopenedSettings = screen.getByRole("dialog", { name: "偏好设置" });
    await user.click(within(reopenedSettings).getByRole("tab", { name: /^通知/ }));
    await user.click(within(reopenedSettings).getByRole("radio", { name: /^当前房间任意消息/ }));
    await waitFor(() => expect(localStorage.getItem("ai-hive.notify-messages")).toBe("all"));
    await user.keyboard("{Escape}");
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    act(() =>
      socket.serverEvent({
        type: "message.created",
        message: roomMessage(3, "任意消息也会通知", []),
      }),
    );
    expect(FakeNotification.instances.at(-1)?.title).toBe("backend-agent · # general");
    expect(FakeNotification.instances.at(-1)?.options?.body).toBe("任意消息也会通知");
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });

    fireEvent.change(composer, { target: { value: "Enter 发送" } });
    fireEvent.keyDown(composer, { key: "Enter", code: "Enter" });
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      type: "message.send",
      content: "Enter 发送",
    });

    const agentDialogTrigger = screen.getByRole("button", { name: "接入 Agent" });
    await user.click(agentDialogTrigger);
    const agentDialog = screen.getByRole("dialog", { name: "把 Agent 接入 Hive" });
    expect(agentDialog).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "关闭" }));
    expect(screen.getByRole("radio", { name: /Codex/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("radio", { name: /^只读/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "复制命令" })).toBeNull();

    const commandText = () =>
      screen.getByText((_, element) => Boolean(element?.matches(".command code"))).textContent;
    const nextStep = () => user.click(screen.getByRole("button", { name: "下一步" }));
    const previousStep = () => user.click(screen.getByRole("button", { name: "上一步" }));

    await user.click(screen.getByRole("radio", { name: /Claude Code/ }));
    await nextStep();
    expect(screen.getByRole("heading", { name: /允许 Claude Code 在本机做什么/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /^只读/ }).getAttribute("aria-checked")).toBe("true");
    await nextStep();
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "复制命令，到终端运行" }),
    );
    expect(commandText()).toContain("--provider claude");
    await user.click(screen.getByRole("button", { name: "复制命令" }));
    expect(await navigator.clipboard.readText()).toContain("npx --yes ai-hive@latest join");
    expect(await navigator.clipboard.readText()).toContain("--name Alice-claude");
    expect(await navigator.clipboard.readText()).toContain("--access read-only");
    expect(screen.getByRole("button", { name: "已复制到剪贴板" })).toBeTruthy();

    await previousStep();
    await user.click(screen.getByRole("radio", { name: /^工作区/ }));
    await nextStep();
    await user.click(screen.getByRole("button", { name: "复制命令" }));
    expect(await navigator.clipboard.readText()).toContain("--access workspace --cwd .");

    await previousStep();
    await user.click(screen.getByRole("radio", { name: /^完全访问/ }));
    expect(screen.getByRole("alert").textContent).toContain("确认移除本机安全边界");
    expect(screen.getByRole("radio", { name: /^工作区/ }).getAttribute("aria-checked")).toBe(
      "true",
    );
    await user.click(screen.getByRole("button", { name: "我了解风险，开启完全访问" }));
    await nextStep();
    expect(commandText()).toContain("--access full --cwd .");

    await user.click(screen.getByRole("button", { name: "返回第 1 步：选择 Agent" }));
    await user.click(screen.getByRole("radio", { name: /GitHub Copilot/ }));
    await nextStep();
    await nextStep();
    await user.click(screen.getByRole("button", { name: "复制命令" }));
    expect(await navigator.clipboard.readText()).toContain(
      "--provider copilot --server http://10.0.0.8:8787",
    );
    expect(await navigator.clipboard.readText()).toContain("--name Alice-copilot");

    await user.click(screen.getByRole("button", { name: "返回第 1 步：选择 Agent" }));
    const copilotRadio = screen.getByRole("radio", { name: /GitHub Copilot/ });
    copilotRadio.focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: /OpenCode/ }));
    expect(screen.getByRole("radio", { name: /OpenCode/ }).getAttribute("aria-checked")).toBe(
      "true",
    );
    await nextStep();
    await nextStep();
    await user.click(screen.getByRole("button", { name: "复制命令" }));
    expect(await navigator.clipboard.readText()).toContain("--provider opencode ");
    expect(await navigator.clipboard.readText()).toContain("--name Alice-opencode");

    // omp 的工作区档无法把写入限制在当前目录，需要明确提示
    await user.click(screen.getByRole("button", { name: "返回第 1 步：选择 Agent" }));
    await user.click(screen.getByRole("radio", { name: /omp/ }));
    await nextStep();
    await user.click(screen.getByRole("radio", { name: /^工作区/ }));
    expect(screen.getByText(/omp 不会把文件写入限制在当前目录内/)).toBeTruthy();
    await nextStep();
    await user.click(screen.getByRole("button", { name: "复制命令" }));
    expect(await navigator.clipboard.readText()).toContain("--provider omp ");
    expect(await navigator.clipboard.readText()).toContain("--access workspace --cwd .");

    await user.click(screen.getByRole("button", { name: "返回第 1 步：选择 Agent" }));
    await user.click(screen.getByRole("radio", { name: /OpenClaw/ }));
    await nextStep();
    await nextStep();
    await user.click(screen.getByRole("button", { name: "复制命令" }));
    expect(await navigator.clipboard.readText()).toContain("--name Alice-openclaw");
    expect(await navigator.clipboard.readText()).toContain("--openclaw-configure-mcp");

    await user.click(screen.getByRole("button", { name: "完成" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(agentDialogTrigger);

    await user.click(agentDialogTrigger);
    expect(screen.getByRole("radio", { name: /OpenClaw/ }).getAttribute("aria-checked")).toBe(
      "true",
    );
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(agentDialogTrigger);

    await user.type(composer, "@");
    const mentionListbox = await screen.findByRole("listbox");
    expect(within(mentionListbox).getByText("@backend-agent")).toBeTruthy();
    expect(within(mentionListbox).getByText("@frontend-agent")).toBeTruthy();
    expect(within(mentionListbox).queryByText("@Alice")).toBeNull();

    await user.keyboard("{ArrowDown}{Enter}");
    expect((composer as HTMLTextAreaElement).value).toBe("@frontend-agent ");
    expect(screen.queryByRole("listbox")).toBeNull();

    await user.clear(composer);
    await user.type(composer, "ask @back");
    expect(screen.getByText("@backend-agent")).toBeTruthy();
    expect(screen.queryByText("@frontend-agent")).toBeNull();
    await user.keyboard("{Tab}");
    expect((composer as HTMLTextAreaElement).value).toBe("ask @backend-agent ");

    await user.clear(composer);
    await user.type(composer, "你好");
    await user.click(screen.getByRole("button", { name: "发送" }));
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      type: "message.send",
      content: "你好",
      clientMessageId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
    });
  });

  it("restores the saved username after refresh and only clears it on explicit logout", async () => {
    const user = userEvent.setup();
    localStorage.setItem("ai-hive.username", "SavedUser");
    render(<App />);

    expect(screen.queryByText("进入 AI Hive")).toBeNull();
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({
      type: "participant.join",
      username: "SavedUser",
    });

    act(() =>
      socket.serverEvent({
        type: "error",
        code: "USERNAME_TAKEN",
        message: "This username is already online in the room.",
      }),
    );
    expect(localStorage.getItem("ai-hive.username")).toBe("SavedUser");
    expect(screen.getByText(/已被同名 Agent 或其他身份占用/)).toBeTruthy();
    expect(FakeWebSocket.instances).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "用户菜单" }));
    await user.click(screen.getByRole("menuitem", { name: /退出/ }));
    expect(localStorage.getItem("ai-hive.username")).toBeNull();
    expect(screen.getByText("进入 AI Hive")).toBeTruthy();
  });

  it("switches rooms, shows unread dots, and creates rooms from the sidebar", async () => {
    const user = userEvent.setup();
    localStorage.setItem("ai-hive.username", "Alice");
    render(<App />);

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({
      type: "participant.join",
      roomId: "general",
    });

    const self = participant("00000000-0000-4000-8000-000000000001", "Alice", "human");
    act(() =>
      socket.serverEvent({
        type: "room.snapshot",
        self,
        participants: [self],
        messages: [],
        latestSeq: 0,
      }),
    );

    const roomsPanel = screen.getByLabelText("房间列表");
    await waitFor(() => expect(within(roomsPanel).getByText("# frontend")).toBeTruthy());

    act(() =>
      socket.serverEvent({
        type: "room.activity",
        roomId: "frontend",
        latestSeq: 5,
        onlineCount: 1,
      }),
    );
    expect(screen.getByLabelText("# frontend 有未读消息")).toBeTruthy();

    await user.click(within(roomsPanel).getByRole("button", { name: /# frontend/ }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const frontendSocket = FakeWebSocket.instances[1]!;
    act(() => frontendSocket.open());
    expect(JSON.parse(frontendSocket.sent[0]!)).toMatchObject({
      type: "participant.join",
      roomId: "frontend",
    });
    expect(localStorage.getItem("ai-hive.room")).toBe("frontend");
    expect(window.location.hash).toBe("#frontend");

    const frontendSelf = { ...self, roomId: "frontend" };
    act(() =>
      frontendSocket.serverEvent({
        type: "room.snapshot",
        self: frontendSelf,
        participants: [frontendSelf],
        messages: [
          {
            id: "00000000-0000-4000-8000-000000000020",
            roomId: "frontend",
            seq: 5,
            senderId: "00000000-0000-4000-8000-000000000001",
            senderName: "Alice",
            senderType: "human",
            content: "frontend 房间的第一条消息",
            mentions: [],
            traceId: "00000000-0000-4000-8000-000000000021",
            hopCount: 0,
            createdAt: new Date().toISOString(),
          },
        ],
        latestSeq: 5,
      }),
    );
    await waitFor(() => expect(localStorage.getItem("ai-hive.read-seq.frontend")).toBe("5"));
    expect(screen.queryByLabelText("# frontend 有未读消息")).toBeNull();

    await user.click(screen.getByRole("button", { name: "接入 Agent" }));
    await user.click(screen.getByRole("button", { name: "下一步" }));
    await user.click(screen.getByRole("button", { name: "下一步" }));
    expect(
      screen.getByText((_, element) =>
        Boolean(
          element?.matches(".command code") &&
          element.textContent?.includes("--name Alice-codex") &&
          !element.textContent.includes("--room"),
        ),
      ),
    ).toBeTruthy();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "新建房间" }));
    const roomDialog = screen.getByRole("dialog", { name: "新建房间" });
    await user.type(within(roomDialog).getByLabelText(/房间 ID/), "design");
    await user.click(within(roomDialog).getByRole("button", { name: "创建房间" }));

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === "POST",
      );
      expect(postCall).toBeTruthy();
      expect(JSON.parse(String((postCall![1] as RequestInit).body))).toMatchObject({
        id: "design",
        name: "design",
        createdBy: "Alice",
      });
    });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(3));
    const designSocket = FakeWebSocket.instances[2]!;
    act(() => designSocket.open());
    expect(JSON.parse(designSocket.sent[0]!)).toMatchObject({
      type: "participant.join",
      roomId: "design",
    });
    expect(localStorage.getItem("ai-hive.room")).toBe("design");
    expect(window.location.hash).toBe("#design");
  });

  it("lets a user recall their own message and renders tombstones for everyone", async () => {
    const user = userEvent.setup();
    localStorage.setItem("ai-hive.username", "Alice");
    localStorage.setItem("ai-hive.notify-prompt-dismissed", "true");
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());

    const self = participant("00000000-0000-4000-8000-000000000001", "Alice", "human");
    const agent = participant("00000000-0000-4000-8000-000000000002", "backend-agent", "agent");
    const base = {
      roomId: "general",
      mentions: [] as string[],
      traceId: "00000000-0000-4000-8000-000000000011",
      hopCount: 0,
      createdAt: new Date().toISOString(),
    };
    const mine = {
      ...base,
      id: "00000000-0000-4000-8000-000000000010",
      seq: 1,
      senderId: self.id,
      senderName: "Alice",
      senderType: "human" as const,
      content: "发错群了，密钥是 sk-secret",
    };
    const theirs = {
      ...base,
      id: "00000000-0000-4000-8000-000000000020",
      seq: 2,
      senderId: agent.id,
      senderName: "backend-agent",
      senderType: "agent" as const,
      content: "收到",
    };
    act(() =>
      socket.serverEvent({
        type: "room.snapshot",
        self,
        participants: [self, agent],
        messages: [mine, theirs],
        latestSeq: 2,
      }),
    );
    // 消息列表渲染在 shadow root 内，screen 查询不到
    const list = () =>
      within(document.querySelector(".message-list")!.shadowRoot as unknown as HTMLElement);
    await waitFor(() => expect(list().getByText("发错群了，密钥是 sk-secret")).toBeTruthy());

    // 只有自己的消息有撤回入口
    const recallButtons = list().getAllByRole("button", { name: "撤回这条消息" });
    expect(recallButtons).toHaveLength(1);
    const mentionButton = list().getByRole("button", { name: "在输入框中提及 backend-agent" });
    // 重复点击同一个人只 @ 一次
    await user.click(mentionButton);
    await user.click(mentionButton);
    expect((screen.getByRole("textbox", { name: "消息" }) as HTMLTextAreaElement).value).toBe(
      "@backend-agent ",
    );

    // 二次确认：先取消，再确认
    await user.click(recallButtons[0]!);
    const confirm = list().getByRole("group", { name: "确认撤回" });
    await user.click(within(confirm).getByRole("button", { name: "取消" }));
    expect(list().queryByRole("group", { name: "确认撤回" })).toBeNull();
    const sentBefore = socket.sent.length;
    await user.click(list().getByRole("button", { name: "撤回这条消息" }));
    await user.click(
      within(list().getByRole("group", { name: "确认撤回" })).getByRole("button", { name: "撤回" }),
    );
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({ type: "message.delete", messageId: mine.id });
    expect(socket.sent).toHaveLength(sentBefore + 1);

    // 服务端广播墓碑：正文消失、操作按钮消失、显示占位
    act(() =>
      socket.serverEvent({
        type: "message.deleted",
        message: { ...mine, content: "", mentions: [], deletedAt: new Date().toISOString() },
      }),
    );
    expect(list().queryByText("发错群了，密钥是 sk-secret")).toBeNull();
    expect(list().getByText("你撤回了一条消息")).toBeTruthy();
    expect(list().queryByRole("button", { name: "撤回这条消息" })).toBeNull();

    act(() =>
      socket.serverEvent({
        type: "message.deleted",
        message: { ...theirs, content: "", mentions: [], deletedAt: new Date().toISOString() },
      }),
    );
    expect(list().getByText("backend-agent 撤回了一条消息")).toBeTruthy();
    expect(list().queryByRole("button", { name: "在输入框中提及 backend-agent" })).toBeNull();

    act(() =>
      socket.serverEvent({
        type: "error",
        code: "FORBIDDEN",
        message: "Only the sender can recall a message.",
      }),
    );
    expect(screen.getByRole("alert").textContent).toContain("只能撤回自己发送的消息");
  });

  it("collapses earlier topics, starts a new topic, and follows a cleared room", async () => {
    const user = userEvent.setup();
    localStorage.setItem("ai-hive.username", "Alice");
    localStorage.setItem("ai-hive.notify-prompt-dismissed", "true");
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());

    const self = participant("00000000-0000-4000-8000-000000000001", "Alice", "human");
    const base = {
      roomId: "general",
      mentions: [] as string[],
      traceId: "00000000-0000-4000-8000-000000000011",
      hopCount: 0,
      createdAt: new Date().toISOString(),
      senderId: self.id,
      senderName: "Alice",
      senderType: "human" as const,
    };
    const message = (seq: number, content: string, kind?: "topic") => ({
      ...base,
      id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
      seq,
      content,
      ...(kind ? { kind } : {}),
    });
    act(() =>
      socket.serverEvent({
        type: "room.snapshot",
        self,
        participants: [self],
        messages: [
          message(1, "旧话题的讨论"),
          message(2, "Alice 开启了新话题", "topic"),
          message(3, "新话题的讨论"),
        ],
        latestSeq: 3,
      }),
    );
    const list = () =>
      within(document.querySelector(".message-list")!.shadowRoot as unknown as HTMLElement);
    await waitFor(() => expect(list().getByText("新话题的讨论")).toBeTruthy());
    // 更早的话题默认折叠，分隔线说明之前的消息不再是 Agent 上下文
    expect(list().queryByText("旧话题的讨论")).toBeNull();
    const shadow = document.querySelector(".message-list")!.shadowRoot!;
    expect(shadow.querySelector(".topic-divider")?.textContent).toContain("Alice 开启了新话题");
    await user.click(list().getByRole("button", { name: "显示更早的话题（1 条消息）" }));
    expect(list().getByText("旧话题的讨论")).toBeTruthy();

    // 开启新话题：发出 topic.start；收到分隔后按钮置灰，之前的话题重新折叠
    const newTopic = screen.getByRole("button", { name: "新话题" }) as HTMLButtonElement;
    expect(newTopic.disabled).toBe(false);
    await user.click(newTopic);
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({ type: "topic.start" });
    act(() =>
      socket.serverEvent({
        type: "message.created",
        message: message(4, "Alice 开启了新话题", "topic"),
      }),
    );
    await waitFor(() => expect(newTopic.disabled).toBe(true));
    expect(list().queryByText("新话题的讨论")).toBeNull();
    expect(list().getByRole("button", { name: "显示更早的话题（3 条消息）" })).toBeTruthy();

    // 房主清空了房间：本地只剩清空后的分隔
    act(() =>
      socket.serverEvent({
        type: "room.cleared",
        message: message(9, "Alice 清空了房间", "topic"),
      }),
    );
    await waitFor(() => expect(list().getByText(/Alice 清空了房间/)).toBeTruthy());
    expect(list().queryByRole("button", { name: /显示更早的话题/ })).toBeNull();
    expect(list().queryByText("Alice 开启了新话题", { exact: false })).toBeNull();
  });

  it("asks returning users to grant notification permission from an in-app prompt", async () => {
    const user = userEvent.setup();
    localStorage.setItem("ai-hive.username", "Alice");
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    // 已登录用户没有登录手势可用，不能在加载时直接弹授权，而是给一条可关闭的提示
    expect(FakeNotification.permission).toBe("default");
    const prompt = screen.getByRole("status", { name: "开启浏览器通知" });
    await user.click(within(prompt).getByRole("button", { name: "暂不" }));
    expect(screen.queryByRole("status", { name: "开启浏览器通知" })).toBeNull();
    expect(localStorage.getItem("ai-hive.notify-prompt-dismissed")).toBe("true");
    expect(localStorage.getItem("ai-hive.notify-messages")).toBeNull();

    // 设置面板仍能补授权
    await user.click(screen.getByRole("button", { name: "用户菜单" }));
    await user.click(screen.getByRole("menuitem", { name: /设置/ }));
    const settingsDialog = screen.getByRole("dialog", { name: "偏好设置" });
    await user.click(within(settingsDialog).getByRole("tab", { name: /^通知/ }));
    expect(
      within(settingsDialog)
        .getByRole("radio", { name: /^@ 我时通知/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await user.click(within(settingsDialog).getByRole("button", { name: "立即授权" }));
    await waitFor(() => expect(FakeNotification.permission).toBe("granted"));
    expect(within(settingsDialog).queryByRole("button", { name: "立即授权" })).toBeNull();
  });

  it("falls back to no notifications when the browser denies permission", async () => {
    const user = userEvent.setup();
    localStorage.setItem("ai-hive.username", "Alice");
    FakeNotification.nextPermission = "denied";
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    const prompt = screen.getByRole("status", { name: "开启浏览器通知" });
    await user.click(within(prompt).getByRole("button", { name: "开启" }));
    await waitFor(() => expect(localStorage.getItem("ai-hive.notify-messages")).toBe("off"));
    expect(screen.queryByRole("status", { name: "开启浏览器通知" })).toBeNull();
  });

  it("opens the room from a shared #roomId link and follows later hash changes", async () => {
    localStorage.setItem("ai-hive.username", "Alice");
    localStorage.setItem("ai-hive.room", "general");
    window.history.replaceState(null, "", "#frontend");
    render(<App />);

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const frontendSocket = FakeWebSocket.instances[0]!;
    act(() => frontendSocket.open());
    expect(JSON.parse(frontendSocket.sent[0]!)).toMatchObject({
      type: "participant.join",
      roomId: "frontend",
    });
    expect(localStorage.getItem("ai-hive.room")).toBe("frontend");

    act(() => {
      window.location.hash = "#design";
    });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const designSocket = FakeWebSocket.instances[1]!;
    act(() => designSocket.open());
    expect(JSON.parse(designSocket.sent[0]!)).toMatchObject({
      type: "participant.join",
      roomId: "design",
    });
    expect(localStorage.getItem("ai-hive.room")).toBe("design");

    act(() => {
      window.location.hash = "#not a valid room!";
    });
    await waitFor(() => expect(window.location.hash).toBe("#design"));
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("shows per-message invocation chips and sends retry, cancel, and budget actions", async () => {
    const user = userEvent.setup();
    localStorage.setItem("ai-hive.username", "Alice");
    localStorage.setItem("ai-hive.notify-prompt-dismissed", "true");
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());

    const self = participant("00000000-0000-4000-8000-000000000001", "Alice", "human");
    const backend = participant("00000000-0000-4000-8000-000000000002", "backend-agent", "agent");
    const frontend = participant("00000000-0000-4000-8000-000000000003", "frontend-agent", "agent");
    const reviewer = participant("00000000-0000-4000-8000-000000000004", "reviewer-agent", "agent");
    const now = new Date().toISOString();
    const messageBase = {
      roomId: "general",
      traceId: "00000000-0000-4000-8000-000000000011",
      hopCount: 0,
      createdAt: now,
    };
    const trigger = {
      ...messageBase,
      id: "00000000-0000-4000-8000-000000000010",
      seq: 2,
      senderId: self.id,
      senderName: "Alice",
      senderType: "human" as const,
      mentions: ["backend-agent", "frontend-agent", "reviewer-agent"],
      content: "@backend-agent @frontend-agent @reviewer-agent 一起看看构建",
    };
    const plain = {
      ...messageBase,
      id: "00000000-0000-4000-8000-000000000030",
      seq: 1,
      senderId: self.id,
      senderName: "Alice",
      senderType: "human" as const,
      mentions: [] as string[],
      content: "没有 @ 的普通消息",
    };
    const reply = {
      ...messageBase,
      id: "00000000-0000-4000-8000-000000000020",
      seq: 3,
      senderId: backend.id,
      senderName: "backend-agent",
      senderType: "agent" as const,
      mentions: [] as string[],
      content: "构建已修好",
    };
    const invocationBase = {
      roomId: "general",
      messageId: trigger.id,
      requesterName: "Alice",
      requesterType: "human" as const,
      attempts: 1,
      createdAt: now,
      updatedAt: now,
    };
    const running = {
      ...invocationBase,
      id: "00000000-0000-4000-8000-0000000000a1",
      agentId: backend.id,
      agentName: "backend-agent",
      status: "running" as const,
      progress: "执行命令：pnpm test",
      receivedAt: now,
      startedAt: new Date(Date.now() - 125_000).toISOString(),
    };
    const failed = {
      ...invocationBase,
      id: "00000000-0000-4000-8000-0000000000a2",
      agentId: frontend.id,
      agentName: "frontend-agent",
      status: "failed" as const,
      detail: "进程退出码 1",
      attempts: 2,
    };
    const blocked = {
      ...invocationBase,
      id: "00000000-0000-4000-8000-0000000000a3",
      agentId: reviewer.id,
      agentName: "reviewer-agent",
      status: "blocked" as const,
      blockReason: "consecutive_limit" as const,
      detail: "Agent 之间已连续对话 8 轮",
    };
    act(() =>
      socket.serverEvent({
        type: "room.snapshot",
        self,
        participants: [self, backend, frontend, reviewer],
        messages: [plain, trigger, reply],
        latestSeq: 3,
        invocations: [running, failed, blocked],
        whiteboard: [],
      }),
    );
    const shadow = () =>
      document.querySelector(".message-list")!.shadowRoot as unknown as HTMLElement;
    const list = () => within(shadow());
    await waitFor(() => expect(list().getByRole("list", { name: "Agent 调用状态" })).toBeTruthy());

    const chips = list().getByRole("list", { name: "Agent 调用状态" });
    expect(within(chips).getAllByRole("listitem")).toHaveLength(3);
    expect(within(chips).getByText("执行命令：pnpm test")).toBeTruthy();
    expect(within(chips).getByText("2分钟")).toBeTruthy();
    expect(within(chips).getByText("第2次")).toBeTruthy();
    expect(within(chips).getByText("Agent 之间已连续对话 8 轮")).toBeTruthy();
    // 只有触发了调用的消息才有状态行
    expect(list().getAllByRole("list", { name: "Agent 调用状态" })).toHaveLength(1);

    await user.click(within(chips).getByRole("button", { name: /^@backend-agent.*查看调用详情$/ }));
    const runtimeDialog = screen.getByRole("dialog", { name: "调用详情" });
    act(() =>
      socket.serverEvent({
        type: "invocation.updated",
        invocation: {
          ...running,
          runtime: {
            observability: "partial",
            lastHeartbeatAt: running.updatedAt,
            lastRuntimeEventAt: running.updatedAt,
            lastProgressAt: running.updatedAt,
            lastError: { at: running.updatedAt, code: 503 },
            history: [{ at: running.updatedAt, kind: "provider_error", code: 503 }],
          },
        },
      }),
    );
    expect(within(runtimeDialog).getByText(/尚未确认恢复.*HTTP 503/)).toBeTruthy();
    expect(within(runtimeDialog).getByText("部分事件可见")).toBeTruthy();
    await user.click(within(runtimeDialog).getByRole("button", { name: "关闭调用详情" }));

    await user.click(within(chips).getByRole("button", { name: "停止 @backend-agent" }));
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
      type: "invocation.cancel",
      invocationId: running.id,
    });
    await user.click(within(chips).getByRole("button", { name: "重试 @frontend-agent" }));
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
      type: "invocation.retry",
      invocationId: failed.id,
    });
    await user.click(
      within(chips).getByRole("button", { name: "为 Agent 对话追加 10 轮，恢复 @reviewer-agent" }),
    );
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({ type: "budget.extend", turns: 10 });

    // 房间级提示同样可以续命
    const notice = screen.getByRole("status", { name: "Agent 连续对话已暂停" });
    await user.click(within(notice).getByRole("button", { name: "继续 10 轮" }));
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({ type: "budget.extend", turns: 10 });

    // 被拦下的调用恢复后提示消失；运行中的调用完成后可以跳到回复
    act(() => {
      socket.serverEvent({
        type: "invocation.updated",
        invocation: { ...blocked, status: "queued", blockReason: undefined, attempts: 2 },
      });
      socket.serverEvent({
        type: "invocation.updated",
        invocation: {
          ...running,
          status: "completed",
          progress: undefined,
          replyMessageId: reply.id,
          finishedAt: new Date().toISOString(),
          updatedAt: new Date(Date.now() + 1000).toISOString(),
        },
      });
    });
    expect(screen.queryByRole("status", { name: "Agent 连续对话已暂停" })).toBeNull();
    expect(list().queryByText("执行命令：pnpm test")).toBeNull();
    expect(list().queryByRole("button", { name: "停止 @backend-agent" })).toBeNull();
    const jump = list().getByRole("button", { name: /^@backend-agent，已完成.*跳到回复$/ });
    await user.click(jump);
    const replyArticle = shadow().querySelector(`[data-message-id="${reply.id}"]`)!;
    expect(replyArticle.classList.contains("highlighted")).toBe(true);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();

    act(() =>
      socket.serverEvent({
        type: "error",
        code: "INVOCATION_NOT_RETRYABLE",
        message: "This invocation cannot be retried now.",
      }),
    );
    expect(screen.getByRole("alert").textContent).toContain("这次调用当前无法重试");

    // Agent 判断无需回复：已完成但没有回复消息，状态上要写明，免得像是漏处理
    act(() =>
      socket.serverEvent({
        type: "invocation.updated",
        invocation: {
          ...failed,
          status: "completed",
          detail: "无需回复",
          finishedAt: new Date().toISOString(),
          updatedAt: new Date(Date.now() + 2000).toISOString(),
        },
      }),
    );
    expect(within(chips).getByText("无需回复")).toBeTruthy();
  });

  it("launches an agent on this machine with one click when the page is local", async () => {
    const user = userEvent.setup();
    localStorage.setItem("ai-hive.username", "Alice");
    localApi.enabled = true;
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    const self = participant("00000000-0000-4000-8000-000000000001", "Alice", "human");
    act(() =>
      socket.serverEvent({
        type: "room.snapshot",
        self,
        participants: [self],
        messages: [],
        latestSeq: 0,
      }),
    );

    await user.click(screen.getByRole("button", { name: "接入 Agent" }));
    // 第 1 步标出本机装了哪些 CLI
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: /Codex.*本机未安装/ })).toBeTruthy(),
    );
    expect(screen.getByRole("radio", { name: /OpenCode.*1\.19\.4/ })).toBeTruthy();

    await user.click(screen.getByRole("radio", { name: /OpenCode/ }));
    await user.click(screen.getByRole("button", { name: "下一步" }));
    await user.click(screen.getByRole("button", { name: "下一步" }));
    expect(screen.getByRole("heading", { name: "在本机启动" })).toBeTruthy();
    expect(screen.getByText("或复制命令，到其他终端运行")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Agent 名称" }) as HTMLInputElement).value).toBe(
      "Alice-opencode",
    );

    await user.click(screen.getByRole("button", { name: "在本机启动" }));
    const created = localApi.requests.find((request) => request.method === "POST");
    expect(created).toMatchObject({
      owner: "owner-secret",
      body: { provider: "opencode", name: "Alice-opencode", access: "read-only" },
    });
    expect(await screen.findByText(/正在启动/)).toBeTruthy();

    // 服务端报告已上线后提示可以 @ 了，成员列表也标出它由本机启动
    localApi.agents = [localAgent({ status: "running" })];
    const agent = participant("00000000-0000-4000-8000-0000000000a9", "Alice-opencode", "agent");
    act(() => socket.serverEvent({ type: "presence.changed", participant: agent }));
    await waitFor(() => expect(screen.getByText(/已上线/)).toBeTruthy(), { timeout: 4_000 });
    expect(screen.getByTitle("由本机 Hive Server 启动")).toBeTruthy();

    // 本机房主也可以一键启动完全访问：需要工作目录，并给出无沙箱警告
    await user.click(screen.getByRole("button", { name: "返回第 2 步：设置权限" }));
    await user.click(screen.getByRole("radio", { name: /^完全访问/ }));
    await user.click(screen.getByRole("button", { name: "我了解风险，开启完全访问" }));
    await user.click(screen.getByRole("button", { name: "下一步" }));
    expect(screen.getByRole("heading", { name: "在本机启动" })).toBeTruthy();
    expect(screen.getByRole("note").textContent).toContain("完全访问没有任何沙箱");
    // 工作目录预填启动 Hive 的目录，不用手输
    const cwdInput = () => screen.getByRole("textbox", { name: "工作目录" }) as HTMLInputElement;
    await waitFor(() => expect(cwdInput().value).toBe("/Users/alice/hive"));

    // 点"选择…"用服务端列目录，进子目录后确认
    await user.click(screen.getByRole("button", { name: "选择…" }));
    const picker = screen.getByRole("group", { name: "选择工作目录" });
    // 家目录开头的路径显示成 ~/…，完整路径在 title 里
    await waitFor(() => expect(within(picker).getByText("~/hive")).toBeTruthy());
    expect(within(picker).getByText("~/hive").getAttribute("title")).toBe("/Users/alice/hive");
    await user.click(within(picker).getByRole("button", { name: "apps" }));
    await waitFor(() => expect(within(picker).getByText("~/hive/apps")).toBeTruthy());
    await user.click(within(picker).getByRole("button", { name: "选择当前目录" }));
    expect(cwdInput().value).toBe("/Users/alice/hive/apps");
    expect(screen.queryByRole("group", { name: "选择工作目录" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "在本机启动" }));
    expect(localApi.requests.filter((request) => request.method === "POST").at(-1)).toMatchObject({
      body: { access: "full", cwd: "/Users/alice/hive/apps" },
    });

    // 完全访问不跨次保留：关掉再打开回到只读
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "接入 Agent" }));
    await user.click(screen.getByRole("button", { name: "下一步" }));
    expect(screen.getByRole("radio", { name: /^只读/ }).getAttribute("aria-checked")).toBe("true");
  });

  it("shows the room whiteboard grouped by slot and keeps it in sync", async () => {
    const user = userEvent.setup();
    localStorage.setItem("ai-hive.username", "Alice");
    localStorage.setItem("ai-hive.notify-prompt-dismissed", "true");
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());

    const self = participant("00000000-0000-4000-8000-000000000001", "Alice", "human");
    const agent = participant("00000000-0000-4000-8000-000000000002", "backend-agent", "agent");
    const now = new Date().toISOString();
    const entryBase = {
      roomId: "general",
      authorId: agent.id,
      authorName: "backend-agent",
      unblocks: [] as string[],
      createdAt: now,
      updatedAt: now,
    };
    const ready = {
      ...entryBase,
      id: "00000000-0000-4000-8000-0000000000b1",
      key: "api",
      slot: "ready" as const,
      summary: "登录 API 已合入，可以接前端",
      repo: "ai-hive",
      branch: "feat/login",
      commit: "0123456789abcdef0123",
      unblocks: ["frontend-login"],
    };
    const blockedEntry = {
      ...entryBase,
      id: "00000000-0000-4000-8000-0000000000b2",
      key: "db",
      slot: "blocked" as const,
      summary: "等待数据库迁移权限",
    };
    act(() =>
      socket.serverEvent({
        type: "room.snapshot",
        self,
        participants: [self, agent],
        messages: [],
        latestSeq: 0,
        invocations: [],
        whiteboard: [ready, blockedEntry],
      }),
    );

    const panel = screen.getByLabelText("成员列表");
    const tab = within(panel).getByRole("tab", { name: /白板/ });
    expect(tab.getAttribute("aria-selected")).toBe("false");
    await user.click(tab);
    expect(tab.getAttribute("aria-selected")).toBe("true");
    const board = within(panel).getByRole("tabpanel");
    const headings = within(board)
      .getAllByRole("heading")
      .map((heading) => heading.textContent);
    expect(headings).toEqual(["阻塞1", "已就绪1"]);
    expect(within(board).getByText("登录 API 已合入，可以接前端")).toBeTruthy();
    expect(within(board).getByText("feat/login")).toBeTruthy();
    expect(within(board).getByText("0123456")).toBeTruthy();
    expect(within(board).getByText("解除阻塞：frontend-login")).toBeTruthy();

    act(() =>
      socket.serverEvent({
        type: "whiteboard.updated",
        entry: {
          ...entryBase,
          id: "00000000-0000-4000-8000-0000000000b3",
          key: "ui",
          slot: "in_progress",
          summary: "正在做登录页",
        },
      }),
    );
    expect(
      within(board)
        .getAllByRole("heading")
        .map((heading) => heading.textContent),
    ).toEqual(["阻塞1", "进行中1", "已就绪1"]);

    await user.click(within(board).getByRole("button", { name: "从白板移除：等待数据库迁移权限" }));
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
      type: "whiteboard.remove",
      entryId: blockedEntry.id,
    });
    act(() =>
      socket.serverEvent({
        type: "whiteboard.removed",
        roomId: "general",
        entryId: blockedEntry.id,
      }),
    );
    expect(within(board).queryByText("等待数据库迁移权限")).toBeNull();

    act(() => {
      socket.serverEvent({ type: "whiteboard.removed", roomId: "general", entryId: ready.id });
      socket.serverEvent({
        type: "whiteboard.removed",
        roomId: "general",
        entryId: "00000000-0000-4000-8000-0000000000b3",
      });
    });
    expect(within(panel).getByText("白板还是空的")).toBeTruthy();
    expect(within(panel).getByText("hive_board_update")).toBeTruthy();
  });

  it("opens search, mentions and agent tasks from the sidebar and jumps across rooms", async () => {
    const user = userEvent.setup();
    localStorage.setItem("ai-hive.username", "Alice");
    localStorage.setItem("ai-hive.notify-prompt-dismissed", "true");
    const mention: ChatMessage = {
      id: "00000000-0000-4000-8000-000000000101",
      roomId: "frontend",
      seq: 5,
      senderId: "00000000-0000-4000-8000-000000000102",
      senderName: "Bob",
      senderType: "human",
      content: "@Alice 登录页的设计稿好了",
      mentions: ["Alice"],
      traceId: "00000000-0000-4000-8000-000000000103",
      hopCount: 0,
      createdAt: new Date().toISOString(),
    };
    crossRoom.mentions = [mention];
    crossRoom.searchable = [mention];
    crossRoom.invocationMessages = [mention];
    crossRoom.invocations = [
      {
        id: "00000000-0000-4000-8000-000000000104",
        roomId: "frontend",
        messageId: mention.id,
        agentId: "00000000-0000-4000-8000-000000000105",
        agentName: "frontend-agent",
        requesterName: "Bob",
        requesterType: "human",
        status: "failed",
        detail: "连续失败 3 次",
        attempts: 1,
        createdAt: mention.createdAt,
        updatedAt: mention.createdAt,
      },
    ];
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    act(() =>
      socket.serverEvent({
        type: "room.snapshot",
        self: participant("00000000-0000-4000-8000-000000000001", "Alice", "human"),
        participants: [],
        messages: [],
        latestSeq: 0,
      }),
    );

    const mentionsEntry = await screen.findByRole("button", { name: "提及我，1 条未读" });
    expect(await screen.findByRole("button", { name: "Agent 任务，1 个需要处理" })).toBeTruthy();
    // 房间列表里该房间右侧显示需要处理的任务数
    expect(screen.getByRole("img", { name: "# frontend：1 个任务需要处理" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Agent 任务，1 个需要处理" }));
    const tasks = screen.getByRole("dialog", { name: "Agent 任务" });
    expect(within(tasks).getByText("@frontend-agent · 失败")).toBeTruthy();
    expect(within(tasks).getByText("连续失败 3 次")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Agent 任务" })).toBeNull();

    // ⌘K 打开搜索，输入后按 Enter 跳到原文所在房间
    await user.keyboard("{Meta>}k{/Meta}");
    const searchBox = await screen.findByRole("searchbox", { name: "搜索消息" });
    await user.type(searchBox, "设计稿");
    const searchDialog = screen.getByRole("dialog", { name: "搜索消息" });
    await waitFor(() =>
      expect(within(searchDialog).getByRole("option", { name: /Bob/ })).toBeTruthy(),
    );
    await user.keyboard("{Escape}");

    await user.click(mentionsEntry);
    const mentionsDialog = screen.getByRole("dialog", { name: "提及我" });
    // 默认只列未读，读过的提及会离开列表
    expect(
      within(mentionsDialog).getByRole("button", { name: "未读 1" }).getAttribute("aria-pressed"),
    ).toBe("true");
    await user.click(within(mentionsDialog).getByRole("option", { name: /登录页的设计稿/ }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    act(() => FakeWebSocket.instances[1]!.open());
    expect(JSON.parse(FakeWebSocket.instances[1]!.sent[0]!)).toMatchObject({
      type: "participant.join",
      roomId: "frontend",
    });
    expect(window.location.hash).toBe("#frontend");
  });
});
