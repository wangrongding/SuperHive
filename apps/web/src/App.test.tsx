// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Participant, ServerEvent } from "@ai-hive/protocol";
import { App } from "./App";

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

  serverEvent(event: ServerEvent): void {
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

describe("App mention autocomplete", () => {
  beforeEach(() => {
    FakeWebSocket.instances.length = 0;
    FakeNotification.instances.length = 0;
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

    const themeSwitcher = screen.getByRole("radiogroup", { name: "颜色主题" });
    await user.click(within(themeSwitcher).getByRole("radio", { name: "浅色" }));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("ai-hive.theme")).toBe("light");

    const membersPanel = screen.getByLabelText("成员列表");
    expect(within(membersPanel).getByRole("button", { name: "接入 Agent" })).toBeTruthy();
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
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: /OpenClaw/ }));
    expect(screen.getByRole("radio", { name: /OpenClaw/ }).getAttribute("aria-checked")).toBe(
      "true",
    );
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
});
