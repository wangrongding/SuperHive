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
  static readonly instances: FakeNotification[] = [];

  static async requestPermission(): Promise<NotificationPermission> {
    FakeNotification.permission = "granted";
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

describe("App mention autocomplete", () => {
  beforeEach(() => {
    FakeWebSocket.instances.length = 0;
    FakeNotification.instances.length = 0;
    FakeNotification.permission = "default";
    localStorage.clear();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("Notification", FakeNotification);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              name: "AI Hive",
              roomId: "general",
              httpUrl: "http://10.0.0.8:8787",
              wsUrl: "ws://10.0.0.8:8787/ws",
              mcpUrl: "http://10.0.0.8:8787/mcp",
              joinToken: "test-token",
              agentCommand:
                "npx --yes ai-hive join --server http://10.0.0.8:8787 --room general --name my-agent --token test-token",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
      ),
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

    const settingsTrigger = screen.getByRole("button", { name: "打开设置" });
    await user.click(settingsTrigger);
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
    await waitFor(() => expect(localStorage.getItem("ai-hive.draft.alice")).toBe("保留这份草稿"));
    await user.click(within(settingsDialog).getByRole("radio", { name: /^Enter 发送/ }));
    expect(localStorage.getItem("ai-hive.send-shortcut")).toBe("enter");
    await user.click(within(settingsDialog).getByRole("radio", { name: "24 小时" }));
    expect(localStorage.getItem("ai-hive.time-format")).toBe("24h");

    await user.click(within(settingsDialog).getByRole("tab", { name: /^通知/ }));
    await user.click(within(settingsDialog).getByRole("switch", { name: /^提及我的消息/ }));
    await waitFor(() => expect(localStorage.getItem("ai-hive.notify-mentions")).toBe("true"));
    expect(FakeNotification.permission).toBe("granted");
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
    act(() =>
      socket.serverEvent({
        type: "message.created",
        message: {
          id: "00000000-0000-4000-8000-000000000010",
          roomId: "general",
          seq: 1,
          senderId: "00000000-0000-4000-8000-000000000002",
          senderName: "backend-agent",
          senderType: "agent",
          content: "@Alice 请查看这个结果",
          mentions: ["Alice"],
          traceId: "00000000-0000-4000-8000-000000000011",
          hopCount: 1,
          createdAt: new Date().toISOString(),
        },
      }),
    );
    expect(FakeNotification.instances.at(-1)?.title).toContain("提到了你");
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
    const agentDialog = screen.getByRole("dialog", { name: "把 Agent 接入当前房间" });
    expect(agentDialog).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "关闭" }));

    await user.click(screen.getByRole("button", { name: /Claude Code/ }));
    expect(
      screen.getByText((_, element) =>
        Boolean(
          element?.matches(".command code") && element.textContent?.includes("--provider claude"),
        ),
      ),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "复制命令" }));
    expect(await navigator.clipboard.readText()).toContain("--name Alice-claude");
    expect(await navigator.clipboard.readText()).toContain("--access read-only");

    await user.click(screen.getByRole("radio", { name: /^工作区/ }));
    await user.click(screen.getByRole("button", { name: "复制命令" }));
    expect(await navigator.clipboard.readText()).toContain("--access workspace --cwd .");

    await user.click(screen.getByRole("radio", { name: /^完全访问/ }));
    expect(screen.getByRole("alert").textContent).toContain("确认移除本机安全边界");
    expect(screen.getByText(/--access workspace --cwd \./)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "我了解风险，开启完全访问" }));
    await user.click(screen.getByRole("button", { name: "复制命令" }));
    expect(await navigator.clipboard.readText()).toContain("--access full --cwd .");

    await user.click(screen.getByRole("button", { name: /GitHub Copilot/ }));
    await user.click(screen.getByRole("button", { name: "复制命令" }));
    expect(await navigator.clipboard.readText()).toContain(
      "--provider copilot --server http://10.0.0.8:8787",
    );
    expect(await navigator.clipboard.readText()).toContain("--name Alice-copilot");

    await user.click(screen.getByRole("button", { name: /OpenClaw/ }));
    await user.click(screen.getByRole("button", { name: "复制命令" }));
    expect(await navigator.clipboard.readText()).toContain("--name Alice-openclaw");
    expect(await navigator.clipboard.readText()).toContain("--openclaw-configure-mcp");

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

    await user.click(screen.getByRole("button", { name: "退出" }));
    expect(localStorage.getItem("ai-hive.username")).toBeNull();
    expect(screen.getByText("进入 AI Hive")).toBeTruthy();
  });
});
