// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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
    localStorage.clear();
    vi.stubGlobal("WebSocket", FakeWebSocket);
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
    const membersTrigger = screen.getByRole("button", { name: "打开成员列表" });
    await user.click(membersTrigger);
    expect(membersPanel.classList.contains("mobile-open")).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "关闭成员列表" }));
    await user.keyboard("{Escape}");
    expect(membersPanel.classList.contains("mobile-open")).toBe(false);
    expect(document.activeElement).toBe(membersTrigger);

    const connectPanel = screen.getByLabelText("Agent 接入");
    await user.click(screen.getByRole("button", { name: "打开 Agent 接入面板" }));
    expect(connectPanel.classList.contains("mobile-open")).toBe(true);
    await user.click(screen.getByRole("button", { name: "关闭 Agent 接入面板" }));
    expect(connectPanel.classList.contains("mobile-open")).toBe(false);

    const composer = screen.getByPlaceholderText("发送消息，输入 @ 选择成员…");
    expect((composer as HTMLTextAreaElement).style.height).toBe("54px");
    await user.click(screen.getByRole("button", { name: "复制 Claude Code Agent 命令" }));
    expect(
      screen.getByText((_, element) =>
        Boolean(
          element?.matches(".command code") && element.textContent?.includes("--provider claude"),
        ),
      ),
    ).toBeTruthy();
    expect(await navigator.clipboard.readText()).toContain("--name Alice-claude");
    await user.click(screen.getByRole("button", { name: "复制 GitHub Copilot Agent 命令" }));
    expect(await navigator.clipboard.readText()).toContain(
      "--provider copilot --server http://10.0.0.8:8787",
    );
    expect(await navigator.clipboard.readText()).toContain("--name Alice-copilot");
    await user.click(screen.getByRole("button", { name: "复制 OpenClaw Agent 命令" }));
    expect(await navigator.clipboard.readText()).toContain("--name Alice-openclaw");
    expect(await navigator.clipboard.readText()).toContain("--openclaw-configure-mcp");
    await user.type(composer, "@");
    expect(await screen.findByRole("listbox")).toBeTruthy();
    expect(screen.getByText("@backend-agent")).toBeTruthy();
    expect(screen.getByText("@frontend-agent")).toBeTruthy();
    expect(screen.queryByText("@Alice")).toBeNull();

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
    expect(screen.getByText(/正在等待旧连接释放并自动重连/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "退出" }));
    expect(localStorage.getItem("ai-hive.username")).toBeNull();
    expect(screen.getByText("进入 AI Hive")).toBeTruthy();
  });
});
