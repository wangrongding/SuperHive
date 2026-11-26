// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Artifact,
  LocalAgent,
  ChatMessage,
  Invocation,
  Participant,
  Schedule,
  ServerEvent,
  WhiteboardEntry,
} from "@superhive/protocol";
import { App } from "./App";
import { LoginDialog } from "./login-dialog";
import type { GuestAccess } from "./access-gate";
import { setLocalePreference } from "./i18n";

type RoomSnapshotEvent = Extract<ServerEvent, { type: "room.snapshot" }>;
// 与 zod 输入类型一致：快照里的 invocations / whiteboard / schedules 有默认值，可以省略
type ServerEventInput =
  | Exclude<ServerEvent, RoomSnapshotEvent>
  | (Omit<
      RoomSnapshotEvent,
      "invocations" | "whiteboard" | "schedules" | "approvals" | "features"
    > &
      Partial<
        Pick<
          RoomSnapshotEvent,
          "invocations" | "whiteboard" | "schedules" | "approvals" | "features"
        >
      >);

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

/** 「进展」最下面折叠着 Agent 白板原文：展开后返回它的内容区域 */
async function openAgentBoard(
  user: ReturnType<typeof userEvent.setup>,
  panel: HTMLElement,
): Promise<HTMLElement> {
  await user.click(within(panel).getByText("Agent 白板（原文）"));
  return panel.querySelector<HTMLElement>(".progress-board-body")!;
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
  /** GET /api/schedules：所有能看到的房间的定时任务与它们触发的调用 */
  schedules: Schedule[];
  scheduleInvocations: Invocation[];
  scheduleRequests: Array<{ url: string; method: string; body?: unknown }>;
} = {
  mentions: [],
  invocations: [],
  invocationMessages: [],
  searchable: [],
  schedules: [],
  scheduleInvocations: [],
  scheduleRequests: [],
};

const whiteboardApi: {
  entries: WhiteboardEntry[];
  requests: Array<{ action: string; entries: Array<{ id: string; updatedAt: string }> }>;
} = { entries: [], requests: [] };

/** 房间产物接口与按 afterSeq 补拉的历史消息 */
const artifactsApi: { artifacts: Artifact[]; history: ChatMessage[]; requests: string[] } = {
  artifacts: [],
  history: [],
  requests: [],
};

/** 房主的置顶房间（服务端存的那份）和收到的 PUT /api/room-pins */
const roomPins: { ids: string[]; requests: string[][] } = { ids: [], requests: [] };
const pinnedSummary = (id: string) => {
  const index = roomPins.ids.indexOf(id);
  return roomSummary(id, index < 0 ? {} : { pinned: index });
};

/** 本机 Agent 接口的假实现；enabled 为 false 时 /api/local/session 返回 404（非本机） */
const localApi: {
  enabled: boolean;
  agents: LocalAgent[];
  requests: Array<{ url: string; method: string; owner: string | null; body?: unknown }>;
  cleanupBatch: { id: string; count: number } | null;
  clearFailure?: string;
  /** Server 所在电脑的平台（/api/local/session 的 hostPlatform）；不给时模拟旧版 Server */
  hostPlatform?: string;
} = { enabled: false, agents: [], requests: [], cleanupBatch: null };

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

// 这组是长流程的整页交互测试，较慢的机器（如 Windows 办公机）上单个用例可能超过默认 5 秒
vi.setConfig({ testTimeout: 60_000 });

describe("App mention autocomplete", () => {
  beforeEach(() => {
    FakeWebSocket.instances.length = 0;
    FakeNotification.instances.length = 0;
    crossRoom.mentions = [];
    crossRoom.invocations = [];
    crossRoom.invocationMessages = [];
    crossRoom.searchable = [];
    crossRoom.schedules = [];
    crossRoom.scheduleInvocations = [];
    crossRoom.scheduleRequests = [];
    whiteboardApi.entries = [];
    whiteboardApi.requests = [];
    localApi.enabled = false;
    localApi.agents = [];
    delete localApi.hostPlatform;
    localApi.requests = [];
    localApi.clearFailure = undefined;
    localApi.cleanupBatch = null;
    roomPins.ids = [];
    roomPins.requests = [];
    artifactsApi.artifacts = [];
    artifactsApi.history = [];
    artifactsApi.requests = [];
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
            name: "SuperHive",
            roomId: "general",
            httpUrl: "http://10.0.0.8:8787",
            wsUrl: "ws://10.0.0.8:8787/ws",
            mcpUrl: "http://10.0.0.8:8787/mcp",
            joinToken: "test-token",
            agentCommand:
              "npx --yes superhive@latest join --server http://10.0.0.8:8787 --name my-agent --token test-token",
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
            return jsonResponse({
              enabled: true,
              mode: "local",
              ownerToken: "owner-secret",
              hostLabel: "alice-mac",
              ...(localApi.hostPlatform ? { hostPlatform: localApi.hostPlatform } : {}),
            });
          }
          if (owner !== "owner-secret") return jsonResponse({ error: "unauthorized" }, 401);
          if (/\/api\/local\/rooms\/[^/]+\/clear$/.test(url))
            return localApi.clearFailure
              ? jsonResponse({ code: "WHITEBOARD_PROTECTED", error: localApi.clearFailure }, 409)
              : jsonResponse({ removed: { messages: 0, invocations: 0, whiteboard: 0 } });
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
          if (/\/api\/local\/rooms\/[^/]+\/attachments\/[^/]+\/open$/.test(url))
            return jsonResponse({ opened: true, name: "plan.md" });
          if (url.includes("/api/local/worktrees/"))
            return jsonResponse({
              worktrees: [],
              autoCleanup: false,
              cleanupBatch: localApi.cleanupBatch,
            });
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
        if (url.includes("/api/schedules")) {
          const method = init?.method ?? "GET";
          crossRoom.scheduleRequests.push({
            url,
            method,
            ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
          });
          const cancel = /\/api\/schedules\/([^/]+)\/cancel$/.exec(url);
          if (cancel && method === "POST") {
            const target = crossRoom.schedules.find((item) => item.id === cancel[1])!;
            const schedule = {
              ...target,
              status: "cancelled" as const,
              cancelledBy: "Alice",
              detail: "Alice 取消了",
              updatedAt: new Date(Date.now() + 1_000).toISOString(),
            };
            return jsonResponse({ schedule });
          }
          return jsonResponse({
            schedules: crossRoom.schedules,
            invocations: crossRoom.scheduleInvocations,
            onlineInvocationIds: [],
          });
        }
        if (url.includes("/api/search")) {
          const query = new URL(url).searchParams.get("q") ?? "";
          return jsonResponse({
            messages: crossRoom.searchable.filter((message) => message.content.includes(query)),
          });
        }
        if (/\/api\/rooms\/[^/]+\/messages/.test(url)) {
          const afterSeq = Number(new URL(url).searchParams.get("afterSeq") ?? 0);
          const messages = artifactsApi.history.filter((message) => message.seq > afterSeq);
          return jsonResponse({ messages, latestSeq: messages.at(-1)?.seq ?? 0 });
        }
        if (/\/api\/rooms\/[^/]+\/attachments\?/.test(url)) {
          artifactsApi.requests.push(url);
          const type = new URL(url).searchParams.get("type");
          const all = artifactsApi.artifacts;
          return jsonResponse({
            artifacts: all.filter((item) =>
              type === "image"
                ? item.kind === "image"
                : type === "file"
                  ? item.kind !== "image"
                  : true,
            ),
            counts: {
              all: all.length,
              image: all.filter((item) => item.kind === "image").length,
              file: all.filter((item) => item.kind !== "image").length,
              document: all.length,
            },
          });
        }
        if (url.includes("/whiteboard")) {
          if (init?.method === "POST") {
            const action = url.endsWith("/archive") ? "archive" : "restore";
            const body = JSON.parse(String(init.body)) as {
              entries: Array<{ id: string; updatedAt: string }>;
            };
            whiteboardApi.requests.push({ action, entries: body.entries });
            const changed = body.entries.map(({ id }) => {
              const previous = whiteboardApi.entries.find((entry) => entry.id === id)!;
              const updatedAt = new Date(Date.parse(previous.updatedAt) + 1).toISOString();
              const entry = { ...previous };
              delete entry.archivedAt;
              return {
                ...entry,
                updatedAt,
                ...(action === "archive" ? { archivedAt: updatedAt } : {}),
              };
            });
            whiteboardApi.entries = whiteboardApi.entries.map(
              (entry) => changed.find((updated) => updated.id === entry.id) ?? entry,
            );
            return jsonResponse({ entries: changed });
          }
          const view = new URL(url).searchParams.get("view") ?? "current";
          return jsonResponse({
            entries: whiteboardApi.entries.filter((entry) =>
              view === "all" ? true : view === "archived" ? entry.archivedAt : !entry.archivedAt,
            ),
          });
        }
        if (url.includes("/api/rooms") && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as { id: string; name?: string };
          return jsonResponse({ room: roomSummary(body.id, { name: body.name ?? body.id }) }, 201);
        }
        if (url.includes("/api/room-pins")) {
          const body = JSON.parse(String(init!.body)) as { roomIds: string[] };
          roomPins.ids = body.roomIds;
          roomPins.requests.push(body.roomIds);
          return jsonResponse({ roomIds: body.roomIds });
        }
        if (url.includes("/api/rooms")) {
          return jsonResponse({ rooms: [pinnedSummary("general"), pinnedSummary("frontend")] });
        }
        // 附件正文：Markdown 标题里带上附件 ID 的末尾，分得清是哪一版
        const attachment = /\/api\/attachments\/([0-9a-f-]+)$/.exec(url);
        if (attachment) return new Response(`# 版本 ${attachment[1]!.slice(-4)}`);
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
    localStorage.setItem("superhive.username", "Alice");
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

  it("shows actual room loading phases, retries a missing snapshot and removes the loader once messages arrive", async () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem("superhive.username", "Alice");
      render(<App />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const socket = FakeWebSocket.instances[0]!;
      const loading = () =>
        document.querySelector(".message-list")?.shadowRoot?.querySelector(".room-loading");
      expect(loading()?.querySelector("[data-loading-title]")?.textContent).toBe("准备房间");
      act(() => socket.open());
      expect(loading()?.querySelector("[data-loading-title]")?.textContent).toBe("载入房间消息");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_000);
      });
      expect(loading()?.querySelector("[data-loading-hint]")?.textContent).toBe(
        "已连接，正在等待房间消息；暂时还没有收到消息快照。",
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      expect(socket.readyState).toBe(3);
      expect(loading()?.querySelector("[data-loading-title]")?.textContent).toBe(
        "连接中断，正在重试",
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(FakeWebSocket.instances).toHaveLength(2);
      const recovered = FakeWebSocket.instances[1]!;
      act(() => {
        recovered.open();
        recovered.serverEvent({
          type: "room.snapshot",
          self: participant("self", "Alice", "human"),
          participants: [],
          messages: [],
          latestSeq: 0,
        });
      });
      expect(loading()).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(recovered.readyState).toBe(FakeWebSocket.OPEN);
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it("focuses the composer once when the page opens", async () => {
    localStorage.setItem("superhive.username", "Alice");
    localStorage.setItem("superhive.notify-prompt-dismissed", "true");
    render(<App />);
    await waitFor(() => expect(document.activeElement?.tagName).toBe("TEXTAREA"));
  });

  it("keeps members ordered by last activity across snapshots and presence updates", async () => {
    localStorage.setItem("superhive.username", "Alice");
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    const self = {
      ...participant("00000000-0000-4000-8000-000000000001", "Alice", "human"),
      lastSeenAt: "2026-11-17T10:00:01.000Z",
    };
    const busy = {
      ...participant("00000000-0000-4000-8000-000000000002", "alpha", "agent"),
      status: "busy" as const,
      lastSeenAt: "2026-11-17T10:00:00.000Z",
    };
    const recent = {
      ...participant("00000000-0000-4000-8000-000000000003", "zulu", "agent"),
      lastSeenAt: "2026-11-17T10:00:02.000Z",
    };
    const offline = {
      ...participant("00000000-0000-4000-8000-000000000004", "offline-old", "agent"),
      status: "offline" as const,
      lastSeenAt: "2026-11-17T09:00:00.000Z",
    };
    const offlineRecent = {
      ...participant("00000000-0000-4000-8000-000000000005", "offline-new", "agent"),
      status: "offline" as const,
      lastSeenAt: "2026-11-17T10:00:03.000Z",
    };
    const snapshot = (members: Participant[]) =>
      socket.serverEvent({
        type: "room.snapshot",
        self,
        participants: members,
        messages: [],
        latestSeq: 0,
      });
    const memberNames = () =>
      [...document.querySelectorAll("#side-panel-members .member-copy strong")].map(
        (element) => element.textContent,
      );

    act(() => snapshot([busy, self, recent, offline, offlineRecent]));
    expect(memberNames()).toEqual(["zulu", "Alice", "alpha", "offline-new", "offline-old"]);

    const activeSelf = { ...self, lastSeenAt: "2026-11-17T10:00:03.500Z" };
    const message: ChatMessage = {
      id: "00000000-0000-4000-8000-000000000007",
      seq: 1,
      roomId: self.roomId,
      senderId: self.id,
      senderName: self.username,
      senderType: self.type,
      content: "hello",
      mentions: [],
      traceId: "00000000-0000-4000-8000-000000000008",
      hopCount: 0,
      clientMessageId: "message-activity",
      createdAt: activeSelf.lastSeenAt,
    };
    act(() => {
      socket.serverEvent({ type: "message.created", message });
      socket.serverEvent({ type: "presence.changed", participant: activeSelf });
    });
    expect(memberNames()).toEqual(["Alice", "zulu", "alpha", "offline-new", "offline-old"]);

    const active = { ...busy, lastSeenAt: "2026-11-17T10:00:04.000Z" };
    act(() => socket.serverEvent({ type: "presence.changed", participant: active }));
    expect(memberNames()).toEqual(["alpha", "Alice", "zulu", "offline-new", "offline-old"]);

    const newcomer = {
      ...participant("00000000-0000-4000-8000-000000000006", "beta", "agent"),
      lastSeenAt: active.lastSeenAt,
    };
    act(() => socket.serverEvent({ type: "presence.changed", participant: newcomer }));
    expect(memberNames()).toEqual(["alpha", "beta", "Alice", "zulu", "offline-new", "offline-old"]);

    const disconnected = {
      ...active,
      status: "offline" as const,
      lastSeenAt: "2026-11-17T10:00:05.000Z",
    };
    act(() => socket.serverEvent({ type: "presence.changed", participant: disconnected }));
    expect(memberNames()).toEqual(["beta", "Alice", "zulu", "alpha", "offline-new", "offline-old"]);

    const reconnected = {
      ...offline,
      status: "online" as const,
      lastSeenAt: "2026-11-17T10:00:06.000Z",
    };
    act(() => socket.serverEvent({ type: "presence.changed", participant: reconnected }));
    const expected = ["offline-old", "beta", "Alice", "zulu", "alpha", "offline-new"];
    expect(memberNames()).toEqual(expected);
    act(() => snapshot([activeSelf, recent, disconnected, newcomer, offlineRecent, reconnected]));
    expect(memberNames()).toEqual(expected);
  });

  it("removes expired worktree notices without dismissing a newer batch", async () => {
    localStorage.setItem("superhive.username", "Alice");
    localStorage.setItem("superhive.notify-prompt-dismissed", "true");
    localApi.enabled = true;
    const firstId = "00000000-0000-4000-8000-000000000091";
    const secondId = "00000000-0000-4000-8000-000000000092";
    localApi.cleanupBatch = { id: firstId, count: 1 };
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
    await screen.findByText("1 个任务目录已合入，可清理。");
    localApi.cleanupBatch = null;
    act(() =>
      socket.serverEvent({
        type: "worktree.cleanup",
        roomId: "general",
        batchId: firstId,
        count: 0,
        state: "expired",
        automatic: false,
      }),
    );
    await waitFor(() => expect(screen.queryByText("清理这批目录")).toBeNull());
    localApi.cleanupBatch = { id: secondId, count: 2 };
    act(() =>
      socket.serverEvent({
        type: "worktree.cleanup",
        roomId: "general",
        batchId: secondId,
        count: 2,
        state: "available",
        automatic: false,
      }),
    );
    await screen.findByText("2 个任务目录已合入，可清理。");
    act(() =>
      socket.serverEvent({
        type: "worktree.cleanup",
        roomId: "general",
        batchId: firstId,
        count: 1,
        state: "completed",
        automatic: false,
      }),
    );
    expect(screen.getByText("2 个任务目录已合入，可清理。")).toBeTruthy();
    localApi.cleanupBatch = null;
    act(() =>
      socket.serverEvent({
        type: "worktree.cleanup",
        roomId: "general",
        batchId: secondId,
        count: 0,
        state: "expired",
        automatic: false,
      }),
    );
    await waitFor(() => expect(screen.queryByText("清理这批目录")).toBeNull());
  });

  it("previews the draft as Markdown, colors its syntax while editing, and expands the composer", async () => {
    const user = userEvent.setup();
    localStorage.setItem("superhive.username", "Alice");
    localStorage.setItem("superhive.notify-prompt-dismissed", "true");
    const { container } = render(<App />);
    const composer = screen.getByLabelText<HTMLTextAreaElement>("消息");
    fireEvent.change(composer, { target: { value: "# 计划\n- **先**跑测试" } });
    // 编辑时：高亮层给标题、加粗上色
    const highlight = container.querySelector(".composer-highlight")!;
    expect(highlight.querySelector(".md-heading")?.textContent).toBe("计划");
    expect(highlight.querySelector(".md-strong")?.textContent).toBe("先");
    // 预览：按消息里同样的 Markdown 渲染，点一下回到编辑
    await user.click(screen.getByRole("button", { name: "预览" }));
    const preview = await screen.findByRole("region", { name: "Markdown 预览" });
    await waitFor(() => expect(preview.querySelector("h1")?.textContent).toBe("计划"));
    expect(preview.querySelector("strong")?.textContent).toBe("先");
    await user.click(preview);
    expect(screen.queryByRole("region", { name: "Markdown 预览" })).toBeNull();
    // 展开：内容不多也立刻变高（约半屏），上限也变大
    const before = Number.parseInt(composer.style.maxHeight, 10);
    const heightBefore = Number.parseInt(composer.style.height, 10);
    await user.click(screen.getByRole("button", { name: "展开输入框" }));
    await waitFor(() =>
      expect(Number.parseInt(composer.style.maxHeight, 10)).toBeGreaterThan(before),
    );
    expect(Number.parseInt(composer.style.height, 10)).toBeGreaterThan(heightBefore);
    expect(Number.parseInt(composer.style.height, 10)).toBeGreaterThanOrEqual(176);
    expect(screen.getByRole("button", { name: "收起输入框" }).textContent).toContain("收起");
  });

  it("keeps the mention option chosen with the keyboard in view", async () => {
    localStorage.setItem("superhive.username", "Alice");
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
    // 输入框已自动聚焦：先让 React 记下当前光标位置，否则按方向键时它会以为光标变了、把选中项重置
    fireEvent.keyUp(composer, { key: "@" });
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
    localStorage.setItem("superhive.username", "Alice");
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
    expect(localStorage.getItem("superhive.draft.alice.general")).toBeNull();
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
    // 第一次用的房主会看到上手引导，这里先跳过
    await user.click(await screen.findByRole("button", { name: "跳过，以后再说" }));
    expect(localStorage.getItem("superhive.onboarding")).toBe("done");

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
    expect(localStorage.getItem("superhive.theme")).toBe("light");
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
      expect(localStorage.getItem("superhive.draft.alice.general")).toBe("保留这份草稿"),
    );
    await user.click(within(settingsDialog).getByRole("radio", { name: /^Enter 发送/ }));
    expect(localStorage.getItem("superhive.send-shortcut")).toBe("enter");
    await user.click(within(settingsDialog).getByRole("radio", { name: "24 小时" }));
    expect(localStorage.getItem("superhive.time-format")).toBe("24h");

    await user.click(within(settingsDialog).getByRole("tab", { name: /^通知/ }));
    expect(
      within(settingsDialog)
        .getByRole("radio", { name: /^@ 我时通知/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(within(settingsDialog).queryByRole("button", { name: "立即授权" })).toBeNull();
    await user.click(within(settingsDialog).getByRole("radio", { name: /^关闭通知/ }));
    expect(localStorage.getItem("superhive.notify-messages")).toBe("off");
    await user.click(within(settingsDialog).getByRole("radio", { name: /^@ 我时通知/ }));
    await waitFor(() => expect(localStorage.getItem("superhive.notify-messages")).toBe("mentions"));
    await user.click(within(settingsDialog).getByRole("switch", { name: /^新消息提示音/ }));
    expect(localStorage.getItem("superhive.notification-sound")).toBe("true");
    await user.click(within(settingsDialog).getByRole("switch", { name: /^Agent 上下线/ }));
    expect(localStorage.getItem("superhive.notify-agent-presence")).toBe("true");

    await user.click(within(settingsDialog).getByRole("tab", { name: /^外观/ }));
    await user.click(within(settingsDialog).getByRole("radio", { name: "深色" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    await user.click(within(settingsDialog).getByRole("radio", { name: "紧凑" }));
    expect(document.documentElement.dataset.density).toBe("compact");
    // 消息区宽度：默认「加宽」，切换后存在本机
    expect(document.documentElement.dataset.threadWidth).toBe("wide");
    await user.click(within(settingsDialog).getByRole("radio", { name: "铺满" }));
    expect(document.documentElement.dataset.threadWidth).toBe("full");
    expect(localStorage.getItem("superhive.thread-width")).toBe("full");
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
    await waitFor(() => expect(localStorage.getItem("superhive.notify-messages")).toBe("all"));
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
    // 不替人默认选一个：选之前「下一步」不能点
    expect(screen.getByRole("radio", { name: /Codex/ }).getAttribute("aria-checked")).toBe("false");
    expect((screen.getByRole("button", { name: "下一步" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.queryByRole("radio", { name: /^只读/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "复制命令" })).toBeNull();

    const commandText = () =>
      screen.getByText((_, element) => Boolean(element?.matches(".command code"))).textContent;
    const nextStep = () => user.click(screen.getByRole("button", { name: "下一步" }));
    const previousStep = () => user.click(screen.getByRole("button", { name: "上一步" }));

    // 点 Agent 只是选中，不自动跳步；点「下一步」才到第 2 步，默认工作区档
    await user.click(screen.getByRole("radio", { name: /Claude Code/ }));
    expect(screen.queryByRole("heading", { name: /允许 Claude Code 在本机做什么/ })).toBeNull();
    await nextStep();
    expect(screen.getByRole("heading", { name: /允许 Claude Code 在本机做什么/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /^工作区/ }).getAttribute("aria-checked")).toBe(
      "true",
    );
    await nextStep();
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "复制命令，到终端运行" }),
    );
    expect(commandText()).toContain("--provider claude");
    // 还没启动、也没复制命令：不出现「完成」，免得点了什么也没发生
    expect(screen.queryByRole("button", { name: "完成" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "复制命令" }));
    expect(screen.getByRole("button", { name: "完成" })).toBeTruthy();
    expect(await navigator.clipboard.readText()).toContain("npx --yes superhive@latest join");
    expect(await navigator.clipboard.readText()).toContain("--name Alice-claude");
    expect(await navigator.clipboard.readText()).toContain("--access workspace --cwd .");
    expect(screen.getByRole("button", { name: "已复制到剪贴板" })).toBeTruthy();

    // 选权限也只是选中，点「下一步」才到第 3 步
    await previousStep();
    await user.click(screen.getByRole("radio", { name: /^只读/ }));
    expect(screen.queryByRole("button", { name: "复制命令" })).toBeNull();
    await nextStep();
    await user.click(screen.getByRole("button", { name: "复制命令" }));
    expect(await navigator.clipboard.readText()).toContain("--access read-only");

    await previousStep();
    await user.click(screen.getByRole("radio", { name: /^完全访问/ }));
    // 和 worktree 自动清理同款就地确认气泡：选项旁边弹出，确认前权限不变
    const fullAccessPopover = screen.getByRole("dialog", { name: "确认开启完全访问" });
    expect(fullAccessPopover.textContent).toContain("确认移除本机安全边界");
    expect(screen.getByRole("radio", { name: /^只读/ }).getAttribute("aria-checked")).toBe("true");
    // Esc 收起气泡并把焦点还给「完全访问」选项，没有勾上
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "确认开启完全访问" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: /^完全访问/ }));
    expect(screen.getByRole("radio", { name: /^只读/ }).getAttribute("aria-checked")).toBe("true");
    // 重新点开，这次确认，才切到完全访问
    await user.click(screen.getByRole("radio", { name: /^完全访问/ }));
    await user.click(screen.getByRole("button", { name: "我了解风险，开启完全访问" }));
    expect(screen.getByRole("radio", { name: /^完全访问/ }).getAttribute("aria-checked")).toBe(
      "true",
    );
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
    // 方向键只是选中，不跳步
    expect(screen.getByRole("heading", { name: "选择要接入的 Agent" })).toBeTruthy();
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

    // 再打开时重新选 Agent
    await user.click(agentDialogTrigger);
    expect(screen.getByRole("radio", { name: /OpenClaw/ }).getAttribute("aria-checked")).toBe(
      "false",
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
    localStorage.setItem("superhive.username", "SavedUser");
    render(<App />);

    expect(screen.queryByText("进入 SuperHive")).toBeNull();
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
    expect(localStorage.getItem("superhive.username")).toBe("SavedUser");
    expect(screen.getByText(/已被同名 Agent 或其他身份占用/)).toBeTruthy();
    expect(FakeWebSocket.instances).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "用户菜单" }));
    await user.click(screen.getByRole("menuitem", { name: /退出/ }));
    expect(localStorage.getItem("superhive.username")).toBeNull();
    expect(screen.getByText("进入 SuperHive")).toBeTruthy();
  });

  it("focuses the username field and explains invalid names inline before joining", async () => {
    const user = userEvent.setup();
    render(<App />);

    const input = screen.getByLabelText<HTMLInputElement>("你的用户名");
    expect(document.activeElement).toBe(input);
    // 左栏的演示房间是装饰，读屏跳过
    expect(document.querySelector(".showcase")?.getAttribute("aria-hidden")).toBe("true");

    await user.click(screen.getByRole("button", { name: /进入聊天室/ }));
    expect(screen.getByRole("alert").textContent).toBe("先输入一个名字。");
    expect(input.getAttribute("aria-invalid")).toBe("true");

    await user.type(input, "rong ding!");
    expect(screen.queryByRole("alert")).toBeNull();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("alert").textContent).toBe("只能用中英文、数字、点、下划线与连字符。");
    expect(FakeWebSocket.instances).toHaveLength(0);

    await user.clear(input);
    await user.type(input, "荣顶{Enter}");
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    expect(localStorage.getItem("superhive.username")).toBe("荣顶");
  });

  it("lets the join button be pressed again when the login page stays up", () => {
    vi.useFakeTimers();
    try {
      const onJoin = vi.fn();
      render(<LoginDialog reduceMotion onJoin={onJoin} />);
      const input = screen.getByLabelText("你的用户名");
      fireEvent.change(input, { target: { value: "荣顶" } });
      fireEvent.submit(input.closest("form")!);
      const button = screen.getByRole("button", { name: /正在进入/ });
      expect(button.hasAttribute("disabled")).toBe(true);
      // 加载中再提交不会重复进入
      fireEvent.submit(input.closest("form")!);
      expect(onJoin).toHaveBeenCalledTimes(1);

      act(() => vi.advanceTimersByTime(4_000));
      expect(screen.getByRole("button", { name: /进入聊天室/ }).hasAttribute("disabled")).toBe(
        false,
      );

      onJoin.mockImplementationOnce(() => {
        throw new Error("boom");
      });
      fireEvent.submit(input.closest("form")!);
      expect(screen.getByRole("alert").textContent).toBe("没能进入，请再试一次。");
      expect(screen.getByRole("button", { name: /进入聊天室/ }).hasAttribute("disabled")).toBe(
        false,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("本机房主从顶栏「⎇ 分支」下拉打开「任务目录」面板；房间设置里不再放任务目录清单", async () => {
    const user = userEvent.setup();
    localApi.enabled = true;
    localStorage.setItem("superhive.username", "Alice");
    localStorage.setItem("superhive.notify-prompt-dismissed", "true");
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
    const roomsPanel = screen.getByLabelText("房间列表");
    await waitFor(() => expect(within(roomsPanel).getByText("# frontend")).toBeTruthy());
    act(() =>
      socket.serverEvent({
        type: "rooms.changed",
        room: { ...roomSummary("general"), workspace: "/repo/web", branch: "main" },
      }),
    );
    await waitFor(() =>
      expect(localApi.requests.some((request) => request.url.endsWith("/api/local/session"))).toBe(
        true,
      ),
    );
    const toggle = await screen.findByRole("button", { name: /^main/ });
    await user.click(toggle);
    await user.click(await screen.findByRole("button", { name: "管理任务目录" }));
    const sheet = await screen.findByRole("dialog", { name: "任务目录" });
    expect(within(sheet).getByRole("checkbox", { name: /自动清理已合入的任务目录/ })).toBeTruthy();
    expect(
      localApi.requests.some((request) => request.url.includes("/api/local/worktrees/general")),
    ).toBe(true);
    await user.click(within(sheet).getByRole("button", { name: "关闭任务目录面板" }));
    expect(screen.queryByRole("dialog", { name: "任务目录" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(toggle));

    // 打开「产物」时任务目录面板让位：大面板同时只开一个
    await user.click(toggle);
    await user.click(await screen.findByRole("button", { name: "管理任务目录" }));
    await screen.findByRole("dialog", { name: "任务目录" });
    const artifacts = screen.getByRole("button", { name: /^产物/ });
    await user.click(artifacts);
    expect(screen.queryByRole("dialog", { name: "任务目录" })).toBeNull();
    await user.click(artifacts);

    await user.click(screen.getByRole("button", { name: "管理房间 general" }));
    const dialog = screen.getByRole("dialog", { name: "房间设置 · # general" });
    expect(within(dialog).queryByRole("checkbox", { name: /自动清理/ })).toBeNull();
    expect(within(dialog).queryByText("清理选中（0）")).toBeNull();
  });

  it("shows the workspace's git branch under the room name and keeps it updated", async () => {
    localStorage.setItem("superhive.username", "Alice");
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
    const roomsPanel = screen.getByLabelText("房间列表");
    await waitFor(() => expect(within(roomsPanel).getByText("# frontend")).toBeTruthy());
    act(() =>
      socket.serverEvent({
        type: "rooms.changed",
        room: { ...roomSummary("frontend"), workspace: "/repo/web", branch: "feat/sidebar" },
      }),
    );
    expect(within(roomsPanel).getByText("feat/sidebar")).toBeTruthy();
    act(() =>
      socket.serverEvent({
        type: "rooms.changed",
        room: { ...roomSummary("frontend"), workspace: "/repo/web", branch: "main" },
      }),
    );
    expect(within(roomsPanel).queryByText("feat/sidebar")).toBeNull();
    expect(within(roomsPanel).getByText("main")).toBeTruthy();
  });

  it("marks the room's lead agent and says plain messages go to it", async () => {
    localStorage.setItem("superhive.username", "Alice");
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    const self = participant("00000000-0000-4000-8000-000000000001", "Alice", "human");
    // 正常跟随工作区的 Agent：名字后面不挂任何标签（以前会挂「目录」）
    const helper = {
      ...participant("00000000-0000-4000-8000-000000000002", "helper", "agent"),
      workspace: { cwd: "/code/proj" },
    };
    act(() =>
      socket.serverEvent({
        type: "room.snapshot",
        self,
        participants: [self, helper],
        messages: [],
        latestSeq: 0,
      }),
    );
    const roomsPanel = screen.getByLabelText("房间列表");
    await waitFor(() => expect(within(roomsPanel).getByText("# frontend")).toBeTruthy());
    expect(screen.queryByText("主")).toBeNull();
    expect(screen.queryByText("目录")).toBeNull();
    expect(document.querySelector(".member-badge")).toBeNull();
    expect(screen.getByPlaceholderText("发送消息，输入 @ 选择成员…")).toBeTruthy();
    act(() =>
      socket.serverEvent({
        type: "rooms.changed",
        room: { ...roomSummary("general"), leadAgent: "helper" },
      }),
    );
    await waitFor(() => expect(screen.getByText("主")).toBeTruthy());
    // 「主」弱化成灰字，不是标签
    expect(screen.getByText("主").className).toBe("member-lead-mark");
    expect(screen.getByPlaceholderText("发送消息，不 @ 时交给主 Agent helper…")).toBeTruthy();
  });

  it("opens right-click menus on rooms and members with common actions", async () => {
    localStorage.setItem("superhive.username", "Alice");
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    const self = participant("00000000-0000-4000-8000-000000000001", "Alice", "human");
    const helper = participant("00000000-0000-4000-8000-000000000002", "helper", "agent");
    act(() =>
      socket.serverEvent({
        type: "room.snapshot",
        self,
        participants: [self, helper],
        messages: [],
        latestSeq: 0,
      }),
    );
    const roomsPanel = screen.getByLabelText("房间列表");
    const general = await within(roomsPanel).findByText("# general");
    const names = () =>
      [...roomsPanel.querySelectorAll(".room-item-name")].map((item) => item.textContent);
    // 都没有消息：按创建时间，后建的 frontend 在上
    await waitFor(() => expect(names()).toEqual(["# frontend", "# general"]));

    fireEvent.contextMenu(general, { clientX: 40, clientY: 80 });
    let roomMenu = screen.getByRole("menu", { name: "# general" });
    expect(within(roomMenu).getByRole("menuitem", { name: "复制房间链接" })).toBeTruthy();
    // 没置顶的不能手动排
    expect(within(roomMenu).queryByRole("menuitem", { name: /上移/ })).toBeNull();
    fireEvent.click(within(roomMenu).getByRole("menuitem", { name: "置顶" }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(names()).toEqual(["# general", "# frontend"]);
    const pinnedGroup = within(roomsPanel).getByRole("group", { name: "已置顶" });
    expect(within(pinnedGroup).getByText("# general")).toBeTruthy();
    expect(pinnedGroup.querySelector(".room-item-pin")).toBeTruthy();
    await waitFor(() => expect(roomPins.requests).toEqual([["general"]]));

    fireEvent.contextMenu(within(roomsPanel).getByText("# general"), { clientX: 40, clientY: 80 });
    roomMenu = screen.getByRole("menu", { name: "# general" });
    expect(within(roomMenu).getByRole("menuitem", { name: /上移/ })).toBeTruthy();
    fireEvent.click(within(roomMenu).getByRole("menuitem", { name: "取消置顶" }));
    expect(names()).toEqual(["# frontend", "# general"]);
    expect(within(roomsPanel).queryByRole("group", { name: "已置顶" })).toBeNull();
    await waitFor(() => expect(roomPins.requests).toEqual([["general"], []]));

    const memberRow = screen
      .getAllByText("helper")
      .map((node) => node.closest(".member-row"))
      .find(Boolean)!;
    fireEvent.contextMenu(memberRow, { clientX: 300, clientY: 200 });
    const memberMenu = screen.getByRole("menu", { name: "helper" });
    expect(within(memberMenu).getByRole("menuitem", { name: "查看 Agent 任务" })).toBeTruthy();
    fireEvent.keyDown(memberMenu, { key: "Enter" });
    expect((screen.getByLabelText("消息") as HTMLTextAreaElement).value).toContain("@helper");
  });

  it("opens the same member menu from a sender's avatar or name in the conversation", async () => {
    localStorage.setItem("superhive.username", "Alice");
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    const self = participant("00000000-0000-4000-8000-000000000001", "Alice", "human");
    const helper = participant("00000000-0000-4000-8000-000000000002", "helper", "agent");
    const message = (id: string, seq: number, sender: Participant, content: string) =>
      ({
        id,
        roomId: "general",
        seq,
        senderId: sender.id,
        senderName: sender.username,
        senderType: sender.type,
        content,
        mentions: [],
        traceId: "00000000-0000-4000-8000-0000000000f0",
        hopCount: 0,
        createdAt: new Date().toISOString(),
      }) as ChatMessage;
    const gone = participant("00000000-0000-4000-8000-000000000003", "old-bot", "agent");
    act(() =>
      socket.serverEvent({
        type: "room.snapshot",
        self,
        participants: [self, helper],
        messages: [
          message("00000000-0000-4000-8000-0000000000f1", 1, helper, "你好"),
          message("00000000-0000-4000-8000-0000000000f2", 2, gone, "我已经离开了"),
        ],
        latestSeq: 2,
      }),
    );
    const list = () =>
      within(document.querySelector(".message-list")!.shadowRoot as unknown as HTMLElement);
    const labels = (menu: HTMLElement) =>
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent);

    // 成员列表里的菜单作为基准
    const memberRow = screen
      .getAllByText("helper")
      .map((node) => node.closest(".member-row"))
      .find(Boolean)!;
    fireEvent.contextMenu(memberRow, { clientX: 300, clientY: 200 });
    const fromList = labels(screen.getByRole("menu", { name: "helper" }));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(fromList).toContain("查看 Agent 任务");

    // 对话流里右击头像、右击名字，菜单和成员列表一致
    const sender = await waitFor(() => list().getByText("helper", { selector: ".message-sender" }));
    const avatar = sender.closest(".message")!.querySelector(".avatar") as HTMLElement;
    fireEvent.contextMenu(avatar, { clientX: 100, clientY: 100 });
    expect(labels(screen.getByRole("menu", { name: "helper" }))).toEqual(fromList);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    // 键盘：聚焦名字后按菜单键（坐标为 0）也能打开
    sender.focus();
    fireEvent.contextMenu(sender, { clientX: 0, clientY: 0 });
    expect(labels(screen.getByRole("menu", { name: "helper" }))).toEqual(fromList);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    // 已经不在房间的成员：只剩 @ 它和复制名字
    fireEvent.contextMenu(list().getByText("old-bot", { selector: ".message-sender" }), {
      clientX: 100,
      clientY: 100,
    });
    expect(labels(screen.getByRole("menu", { name: "old-bot" }))).toEqual([
      "@ old-bot",
      "复制名字",
    ]);
  });

  it("switches rooms, shows unread dots, and creates rooms from the sidebar", async () => {
    const user = userEvent.setup();
    localStorage.setItem("superhive.username", "Alice");
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
    expect(localStorage.getItem("superhive.room")).toBe("frontend");
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
    await waitFor(() => expect(localStorage.getItem("superhive.read-seq.frontend")).toBe("5"));
    expect(screen.queryByLabelText("# frontend 有未读消息")).toBeNull();

    await user.click(screen.getByRole("button", { name: "接入 Agent" }));
    await user.click(screen.getByRole("radio", { name: /Codex/ }));
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
    expect(localStorage.getItem("superhive.room")).toBe("design");
    expect(window.location.hash).toBe("#design");
  });

  it("lets a user recall their own message and renders tombstones for everyone", async () => {
    const user = userEvent.setup();
    localStorage.setItem("superhive.username", "Alice");
    localStorage.setItem("superhive.notify-prompt-dismissed", "true");
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

    // 还有 Agent 在做这条消息派的活：确认里默认「撤回并停止」，也可以只撤回
    const now = new Date().toISOString();
    // 只是在排队：撤回后本来就不会执行，没有「只撤回」可选；说明直接显示出来（触屏看不到悬停提示）
    act(() =>
      socket.serverEvent({
        type: "invocation.updated",
        invocation: {
          id: "00000000-0000-4000-8000-0000000000b1",
          roomId: "general",
          messageId: mine.id,
          agentId: agent.id,
          agentName: "backend-agent",
          requesterName: "Alice",
          requesterType: "human",
          status: "queued",
          attempts: 1,
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    await user.click(recallButtons[0]!);
    const queuedConfirm = list().getByRole("group", { name: "确认撤回" });
    expect(within(queuedConfirm).queryByRole("button", { name: "只撤回" })).toBeNull();
    expect(queuedConfirm.textContent).toContain("已经改的文件、跑过的命令不会撤销");
    await user.click(within(queuedConfirm).getByRole("button", { name: "取消" }));
    act(() =>
      socket.serverEvent({
        type: "invocation.updated",
        invocation: {
          id: "00000000-0000-4000-8000-0000000000b1",
          roomId: "general",
          messageId: mine.id,
          agentId: agent.id,
          agentName: "backend-agent",
          requesterName: "Alice",
          requesterType: "human",
          status: "running",
          attempts: 1,
          createdAt: now,
          updatedAt: now,
          startedAt: now,
        },
      }),
    );
    await user.click(list().getByRole("button", { name: "撤回这条消息" }));
    const stopConfirm = list().getByRole("group", { name: "确认撤回" });
    expect(stopConfirm.textContent).toContain("撤回并停止 @backend-agent 的任务？");
    expect(within(stopConfirm).getByRole("button", { name: "只撤回" })).toBeTruthy();
    const sentBeforeStop = socket.sent.length;
    await user.click(within(stopConfirm).getByRole("button", { name: "撤回并停止" }));
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
      type: "message.delete",
      messageId: mine.id,
      stop: true,
    });
    expect(socket.sent).toHaveLength(sentBeforeStop + 1);
    act(() =>
      socket.serverEvent({
        type: "invocation.updated",
        invocation: {
          id: "00000000-0000-4000-8000-0000000000b1",
          roomId: "general",
          messageId: mine.id,
          agentId: agent.id,
          agentName: "backend-agent",
          requesterName: "Alice",
          requesterType: "human",
          status: "completed",
          attempts: 1,
          createdAt: now,
          updatedAt: now,
          finishedAt: now,
        },
      }),
    );

    // 二次确认：先取消，再确认
    await user.click(list().getByRole("button", { name: "撤回这条消息" }));
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

  it("purges recalled traces from state and ignores any later steps", async () => {
    localStorage.setItem("superhive.username", "Alice");
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    const self = participant("00000000-0000-4000-8000-000000000001", "Alice", "human");
    const agent = participant("00000000-0000-4000-8000-000000000002", "worker", "agent");
    const now = new Date().toISOString();
    const message: ChatMessage = {
      id: "00000000-0000-4000-8000-000000000010",
      roomId: "general",
      seq: 1,
      senderId: self.id,
      senderName: self.username,
      senderType: "human",
      content: "@worker task",
      mentions: ["worker"],
      traceId: "00000000-0000-4000-8000-000000000011",
      hopCount: 0,
      createdAt: now,
    };
    const task: Invocation = {
      id: "00000000-0000-4000-8000-000000000020",
      roomId: "general",
      messageId: message.id,
      agentId: agent.id,
      agentName: agent.username,
      requesterName: self.username,
      requesterType: "human",
      status: "running",
      attempts: 1,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
    };
    const step = {
      id: "step",
      kind: "text" as const,
      text: "Secret execution narrative",
      startedAt: now,
    };
    act(() => {
      socket.serverEvent({
        type: "room.snapshot",
        self,
        participants: [self, agent],
        messages: [message],
        latestSeq: 1,
        invocations: [task],
        features: ["trace"],
      });
      socket.serverEvent({
        type: "invocation.trace",
        roomId: "general",
        invocationId: task.id,
        steps: [step],
      });
    });
    const root = document.querySelector(".message-list")!.shadowRoot!;
    await waitFor(() => expect(root.textContent).toContain(step.text));
    act(() => {
      socket.serverEvent({
        type: "message.deleted",
        message: { ...message, content: "", mentions: [], deletedAt: now },
      });
      socket.serverEvent({
        type: "invocation.updated",
        invocation: { ...task, messageRecalled: true },
      });
      socket.serverEvent({
        type: "invocation.trace",
        roomId: "general",
        invocationId: task.id,
        steps: [step],
      });
    });
    expect(root.textContent).not.toContain(step.text);
    expect(root.textContent).toContain("任务仍在继续");
    act(() => {
      socket.serverEvent({
        type: "room.snapshot",
        self,
        participants: [self, agent],
        messages: [message],
        latestSeq: 1,
        invocations: [task],
        features: ["trace"],
      });
    });
    expect(root.textContent).not.toContain(step.text);
  });

  it("collapses earlier topics, starts a new topic, and follows a cleared room", async () => {
    const user = userEvent.setup();
    localStorage.setItem("superhive.username", "Alice");
    localStorage.setItem("superhive.notify-prompt-dismissed", "true");
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

  it("loads earlier messages above without moving the viewport to the very top", async () => {
    const user = userEvent.setup();
    localStorage.setItem("superhive.username", "Alice");
    localStorage.setItem("superhive.notify-prompt-dismissed", "true");
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
    act(() =>
      socket.serverEvent({
        type: "room.snapshot",
        self,
        participants: [self],
        messages: Array.from({ length: 120 }, (_, index) => ({
          ...base,
          id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
          seq: index + 1,
          content: `第 ${index + 1} 条`,
        })),
        latestSeq: 120,
      }),
    );
    const container = document.querySelector(".message-list")! as HTMLElement;
    const list = () => within(container.shadowRoot as unknown as HTMLElement);
    await waitFor(() => expect(list().getByText("第 120 条")).toBeTruthy());
    expect(list().queryByText("第 1 条")).toBeNull();
    expect(
      list().getByRole("button", { name: "显示更早的 95 条消息（共隐藏 95 条）" }),
    ).toBeTruthy();

    // jsdom 没有布局：让 scrollHeight 随已挂载消息数增长、scrollTop 可存取，验证锚定算式
    const height = () => container.shadowRoot!.querySelectorAll("[data-message-id]").length * 40;
    let scrollTop = 200;
    Object.defineProperty(container, "scrollHeight", { configurable: true, get: height });
    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });
    // 恢复走 scrollTo({ behavior: "instant" })（容器 CSS 是 scroll-behavior: smooth）；
    // jsdom 的 scrollTo 不实现，替换成与 scrollTop 同一存储的桩
    container.scrollTo = ((options: ScrollToOptions) => {
      scrollTop = options.top ?? 0;
    }) as typeof container.scrollTo;

    await user.click(list().getByRole("button", { name: /显示更早的/ }));
    expect(list().getByText("第 1 条")).toBeTruthy();
    // 点击时 25 条已挂载（高 1000，视口在 200）；展开后 120 条（高 4800），
    // 保持「视口到内容底部的距离」800 不变 → scrollTop 应为 4000，而不是停在顶部 0
    expect(height()).toBe(4800);
    expect(scrollTop).toBe(4000);
  });

  it("compact receipt links expand their result while long human messages stay open", async () => {
    const user = userEvent.setup();
    localStorage.setItem("superhive.username", "Alice");
    localStorage.setItem("superhive.notify-prompt-dismissed", "true");
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    const self = participant("00000000-0000-4000-8000-000000000001", "Alice", "human");
    const agent = participant("00000000-0000-4000-8000-000000000002", "worker", "agent");
    const makeMessage = (
      messageSeq: number,
      sender: Participant,
      content: string,
    ): ChatMessage => ({
      id: `00000000-0000-4000-8000-${String(5000 + messageSeq).padStart(12, "0")}`,
      roomId: "general",
      seq: messageSeq,
      senderId: sender.id,
      senderName: sender.username,
      senderType: sender.type,
      content,
      mentions: [],
      traceId: "00000000-0000-4000-8000-000000000011",
      hopCount: 0,
      createdAt: new Date().toISOString(),
    });
    const result = makeMessage(1, agent, "结论\n" + "完整证据\n".repeat(20));
    const human = makeMessage(2, self, "人的详细要求\n" + "完整要求\n".repeat(20));
    const receipt: ChatMessage = {
      ...makeMessage(3, agent, `@worker 子任务回执 · 已完成\n[结果见 #1](#message/${result.id}/1)`),
      kind: "receipt",
      mentions: ["worker"],
      text: {
        key: "receipt.compact",
        params: {
          requester: "worker",
          status: "已完成",
          task: "验证",
          seq: 1,
          resultMessageId: result.id,
        },
      },
    };
    act(() =>
      socket.serverEvent({
        type: "room.snapshot",
        self,
        participants: [self, agent],
        messages: [result, human, receipt],
        latestSeq: 3,
      }),
    );
    const root = document.querySelector(".message-list")!.shadowRoot!;
    const list = within(root as unknown as HTMLElement);
    const resultNode = () => root.querySelector(`[data-message-id="${result.id}"]`)!;
    await waitFor(() => expect(resultNode().querySelector(".collapsed")).not.toBeNull());
    expect(root.querySelector(`[data-message-id="${human.id}"] .message-collapsible`)).toBeNull();
    await user.click(await list.findByRole("button", { name: "结果见 #1" }));
    await waitFor(() => expect(resultNode().classList.contains("highlighted")).toBe(true));
    expect(resultNode().querySelector(".collapsed")).toBeNull();
  });

  it("opens room artifacts from the chat header and jumps back to an older message", async () => {
    const user = userEvent.setup();
    localStorage.setItem("superhive.username", "Alice");
    localStorage.setItem("superhive.notify-prompt-dismissed", "true");
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());

    const self = participant("00000000-0000-4000-8000-000000000001", "Alice", "human");
    const agent = participant("00000000-0000-4000-8000-000000000002", "rd-codex", "agent");
    const message = (seq: number, content: string): ChatMessage => ({
      id: `00000000-0000-4000-8000-${String(1000 + seq).padStart(12, "0")}`,
      roomId: "general",
      seq,
      senderId: agent.id,
      senderName: "rd-codex",
      senderType: "agent",
      content,
      mentions: [],
      traceId: "00000000-0000-4000-8000-000000000011",
      hopCount: 0,
      createdAt: new Date().toISOString(),
    });
    const artifact = (seq: number, name: string): Artifact => ({
      id: `00000000-0000-4000-8000-${String(2000 + seq).padStart(12, "0")}`,
      name,
      mime: "text/markdown",
      size: 1200,
      kind: "text",
      sha256: "b".repeat(64),
      category: "document",
      messageId: message(seq, "").id,
      messageSeq: seq,
      senderId: agent.id,
      senderName: "rd-codex",
      senderType: "agent",
      createdAt: new Date().toISOString(),
    });
    // 快照里只有最近的 150–200 号；报告在更早的 2 号消息里
    artifactsApi.history = Array.from({ length: 200 }, (_, index) =>
      message(index + 1, `第 ${index + 1} 条`),
    );
    artifactsApi.history[1]!.content = `第 2 条\n\n${"完整的验证结果\n".repeat(30)}`;
    artifactsApi.artifacts = [artifact(2, "report.md")];
    act(() =>
      socket.serverEvent({
        type: "room.snapshot",
        self,
        participants: [self, agent],
        messages: artifactsApi.history.slice(150),
        latestSeq: 200,
      }),
    );

    const entry = await screen.findByRole("button", { name: "产物：1 个图片和文件" });
    expect(entry.textContent).toContain("1");
    // 右侧栏只剩成员、进展（定时任务在左侧）；「产物」是头部打开的大面板
    expect(
      within(screen.getByRole("tablist", { name: "侧栏视图" }))
        .getAllByRole("tab")
        .map((tab) => tab.id),
    ).toEqual(["side-tab-members", "side-tab-whiteboard"]);
    await user.click(entry);
    expect(entry.getAttribute("aria-pressed")).toBe("true");
    const panel = screen.getByRole("dialog", { name: "产物" });
    expect(panel.classList.contains("maximized")).toBe(true);
    expect(await within(panel).findByText("report.md")).toBeTruthy();

    // 新附件到达：列表与角标自动更新
    const fresh = { ...message(201, ""), attachments: [] as ChatMessage["attachments"] };
    const added = artifact(201, "summary.md");
    fresh.attachments = [
      {
        id: added.id,
        name: added.name,
        mime: added.mime,
        size: added.size,
        kind: added.kind,
        sha256: added.sha256,
      },
    ];
    artifactsApi.artifacts = [added, ...artifactsApi.artifacts];
    artifactsApi.history.push(fresh);
    act(() => socket.serverEvent({ type: "message.created", message: fresh }));
    expect(await within(panel).findByText("summary.md")).toBeTruthy();

    // 定位到更早的消息：先补拉 2 号起的消息，再滚过去高亮
    await user.click(within(panel).getByRole("button", { name: "定位到 report.md 所在的消息" }));
    // 先关面板再跳
    expect(screen.queryByRole("dialog", { name: "产物" })).toBeNull();
    const container = document.querySelector(".message-list")! as HTMLElement;
    const list = within(container.shadowRoot as unknown as HTMLElement);
    await waitFor(() => expect(list.getByText("第 2 条", { exact: false })).toBeTruthy());
    expect(
      container.shadowRoot!.querySelector(
        `[data-message-id="${message(2, "").id}"] .message-collapsible.collapsed`,
      ),
    ).toBeNull();
    await waitFor(() =>
      expect(
        container
          .shadowRoot!.querySelector(`[data-message-id="${message(2, "").id}"]`)
          ?.classList.contains("highlighted"),
      ).toBe(true),
    );

    // Esc 关面板，焦点回到头部入口
    await user.click(entry);
    expect(screen.getByRole("dialog", { name: "产物" })).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "产物" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(entry));
  });

  it("本机房主在预览里能用本机应用打开、在文件夹中显示附件；不在 Server 那台电脑上时没有这两个按钮", async () => {
    const user = userEvent.setup();
    localStorage.setItem("superhive.username", "Alice");
    localStorage.setItem("superhive.notify-prompt-dismissed", "true");
    Object.assign(URL, { createObjectURL: () => "blob:doc", revokeObjectURL: () => {} });
    const self = participant("00000000-0000-4000-8000-000000000001", "Alice", "human");
    const agent = participant("00000000-0000-4000-8000-000000000002", "rd-codex", "agent");
    const message: ChatMessage = {
      id: "00000000-0000-4000-8000-000000003001",
      roomId: "general",
      seq: 1,
      senderId: agent.id,
      senderName: agent.username,
      senderType: "agent",
      content: "交付",
      mentions: [],
      traceId: "00000000-0000-4000-8000-000000000011",
      hopCount: 0,
      createdAt: new Date().toISOString(),
      attachments: [
        {
          id: "00000000-0000-4000-8000-000000004001",
          name: "plan.md",
          mime: "text/markdown",
          size: 100,
          kind: "text",
          sha256: "c".repeat(64),
        },
      ],
    };
    const openPreview = async () => {
      render(<App />);
      await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
      const socket = FakeWebSocket.instances.at(-1)!;
      act(() => socket.open());
      act(() =>
        socket.serverEvent({
          type: "room.snapshot",
          self,
          participants: [self, agent],
          messages: [message],
          latestSeq: 1,
        }),
      );
      const container = document.querySelector(".message-list")! as HTMLElement;
      const list = within(container.shadowRoot as unknown as HTMLElement);
      await user.click(await list.findByRole("button", { name: "预览 plan.md" }));
      return screen.findByRole("dialog", { name: "预览 plan.md" });
    };

    // 远程设备、访客：/api/local 不可用，只能下载
    let dialog = await openPreview();
    expect(within(dialog).getByRole("button", { name: "下载" })).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "用本机应用打开" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "在文件夹中显示" })).toBeNull();
    cleanup();

    localApi.enabled = true;
    dialog = await openPreview();
    await user.click(await within(dialog).findByRole("button", { name: "用本机应用打开" }));
    await user.click(within(dialog).getByRole("button", { name: "在文件夹中显示" }));
    await waitFor(() =>
      expect(
        localApi.requests
          .filter((request) => request.url.includes("/attachments/"))
          .map((request) => ({ url: request.url, owner: request.owner, body: request.body })),
      ).toEqual(
        (["open", "reveal"] as const).map((mode) => ({
          url: "http://localhost:8787/api/local/rooms/general/attachments/00000000-0000-4000-8000-000000004001/open",
          owner: "owner-secret",
          body: { mode },
        })),
      ),
    );
  });

  it("docks a file preview into the right sidebar so the chat stays usable, and offers newer versions", async () => {
    const user = userEvent.setup();
    localStorage.setItem("superhive.username", "Alice");
    localStorage.setItem("superhive.notify-prompt-dismissed", "true");
    // 成员栏原本收起：停靠预览时露出来，关掉预览又收回去
    localStorage.setItem("superhive.members-collapsed", "true");
    Object.assign(URL, { createObjectURL: () => "blob:doc", revokeObjectURL: () => {} });
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());

    const self = participant("00000000-0000-4000-8000-000000000001", "Alice", "human");
    const agent = participant("00000000-0000-4000-8000-000000000002", "rd-codex", "agent");
    const other = participant("00000000-0000-4000-8000-000000000003", "rd-claude", "agent");
    const withFile = (seq: number, sender: Participant, name: string): ChatMessage => ({
      id: `00000000-0000-4000-8000-${String(3000 + seq).padStart(12, "0")}`,
      roomId: "general",
      seq,
      senderId: sender.id,
      senderName: sender.username,
      senderType: "agent",
      content: `第 ${seq} 版`,
      mentions: [],
      traceId: "00000000-0000-4000-8000-000000000011",
      hopCount: 0,
      createdAt: new Date().toISOString(),
      attachments: [
        {
          id: `00000000-0000-4000-8000-${String(4000 + seq).padStart(12, "0")}`,
          name,
          mime: "text/markdown",
          size: 100 + seq,
          kind: "text",
          sha256: "c".repeat(64),
        },
      ],
    });
    act(() =>
      socket.serverEvent({
        type: "room.snapshot",
        self,
        participants: [self, agent, other],
        messages: [withFile(1, agent, "plan.md")],
        latestSeq: 1,
      }),
    );
    const workspace = document.querySelector(".workspace")!;
    expect(workspace.classList.contains("members-collapsed")).toBe(true);
    const container = document.querySelector(".message-list")! as HTMLElement;
    const list = within(container.shadowRoot as unknown as HTMLElement);
    await user.click(await list.findByRole("button", { name: "预览 plan.md" }));
    const dialog = await screen.findByRole("dialog", { name: "预览 plan.md" });
    await user.click(within(dialog).getByRole("button", { name: "在右侧栏打开" }));

    // 弹窗关掉，预览占住右侧栏；输入框照常能用
    expect(screen.queryByRole("dialog", { name: "预览 plan.md" })).toBeNull();
    expect(workspace.classList.contains("preview-docked")).toBe(true);
    expect(workspace.classList.contains("members-collapsed")).toBe(false);
    const sidebar = screen.getByRole("complementary", { name: "成员列表" });
    expect(within(sidebar).queryByRole("tablist", { name: "侧栏视图" })).toBeNull();
    expect(
      await within(sidebar).findByRole("heading", { name: "版本 4001" }, { timeout: 5_000 }),
    ).toBeTruthy();
    expect((workspace as HTMLElement).style.getPropertyValue("--panel-width")).toBe("560px");
    expect(screen.getByRole("textbox", { name: "消息" })).toBeTruthy();

    // 别人发的同名文件不算新版本；同一个人再发才算，点一下换过去
    act(() =>
      socket.serverEvent({ type: "message.created", message: withFile(2, other, "plan.md") }),
    );
    expect(within(sidebar).queryByRole("button", { name: "有新版本" })).toBeNull();
    act(() =>
      socket.serverEvent({ type: "message.created", message: withFile(3, agent, "plan.md") }),
    );
    await user.click(await within(sidebar).findByRole("button", { name: "有新版本" }));
    expect(
      await within(sidebar).findByRole("heading", { name: "版本 4003" }, { timeout: 5_000 }),
    ).toBeTruthy();
    expect(within(sidebar).queryByRole("button", { name: "有新版本" })).toBeNull();

    // 放大成弹窗再停回去
    await user.click(within(sidebar).getByRole("button", { name: "放大成弹窗" }));
    expect(workspace.classList.contains("preview-docked")).toBe(false);
    const popped = await screen.findByRole("dialog", { name: "预览 plan.md" });
    await user.click(within(popped).getByRole("button", { name: "在右侧栏打开" }));
    expect(workspace.classList.contains("preview-docked")).toBe(true);

    // 关掉预览：右侧栏回到原来收起的样子
    await user.click(within(sidebar).getByRole("button", { name: "关闭侧栏预览" }));
    expect(workspace.classList.contains("preview-docked")).toBe(false);
    expect(workspace.classList.contains("members-collapsed")).toBe(true);
    expect(localStorage.getItem("superhive.members-collapsed")).toBe("true");
  });

  it("asks returning users to grant notification permission from an in-app prompt", async () => {
    const user = userEvent.setup();
    localStorage.setItem("superhive.username", "Alice");
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    // 已登录用户没有登录手势可用，不能在加载时直接弹授权，而是给一条可关闭的提示
    expect(FakeNotification.permission).toBe("default");
    const prompt = screen.getByRole("status", { name: "开启浏览器通知" });
    await user.click(within(prompt).getByRole("button", { name: "暂不" }));
    expect(screen.queryByRole("status", { name: "开启浏览器通知" })).toBeNull();
    expect(localStorage.getItem("superhive.notify-prompt-dismissed")).toBe("true");
    expect(localStorage.getItem("superhive.notify-messages")).toBeNull();

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
    localStorage.setItem("superhive.username", "Alice");
    FakeNotification.nextPermission = "denied";
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    const prompt = screen.getByRole("status", { name: "开启浏览器通知" });
    await user.click(within(prompt).getByRole("button", { name: "开启" }));
    await waitFor(() => expect(localStorage.getItem("superhive.notify-messages")).toBe("off"));
    expect(screen.queryByRole("status", { name: "开启浏览器通知" })).toBeNull();
  });

  it("opens the room from a shared #roomId link and follows later hash changes", async () => {
    localStorage.setItem("superhive.username", "Alice");
    localStorage.setItem("superhive.room", "general");
    window.history.replaceState(null, "", "#frontend");
    render(<App />);

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const frontendSocket = FakeWebSocket.instances[0]!;
    act(() => frontendSocket.open());
    expect(JSON.parse(frontendSocket.sent[0]!)).toMatchObject({
      type: "participant.join",
      roomId: "frontend",
    });
    expect(localStorage.getItem("superhive.room")).toBe("frontend");

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
    expect(localStorage.getItem("superhive.room")).toBe("design");

    act(() => {
      window.location.hash = "#not a valid room!";
    });
    await waitFor(() => expect(window.location.hash).toBe("#design"));
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("shows server-written texts in the selected language", async () => {
    setLocalePreference("en");
    try {
      localStorage.setItem("superhive.username", "Alice");
      localStorage.setItem("superhive.notify-prompt-dismissed", "true");
      render(<App />);
      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
      const socket = FakeWebSocket.instances[0]!;
      act(() => socket.open());
      const self = participant("00000000-0000-4000-8000-000000000001", "Alice", "human");
      const agent = participant("00000000-0000-4000-8000-000000000002", "backend-agent", "agent");
      const now = new Date().toISOString();
      const trigger = {
        id: "00000000-0000-4000-8000-000000000010",
        roomId: "general",
        seq: 1,
        senderId: self.id,
        senderName: "Alice",
        senderType: "human" as const,
        mentions: ["backend-agent"],
        content: "@backend-agent 看看",
        traceId: "00000000-0000-4000-8000-000000000011",
        hopCount: 0,
        createdAt: now,
      };
      const cleared = {
        ...trigger,
        id: "00000000-0000-4000-8000-000000000012",
        seq: 2,
        mentions: [],
        kind: "topic" as const,
        content: "Alice 开启了新话题",
        text: { key: "topic.started", params: { name: "Alice" } },
      };
      act(() =>
        socket.serverEvent({
          type: "room.snapshot",
          self,
          participants: [self, agent],
          messages: [trigger, cleared],
          latestSeq: 2,
          invocations: [
            {
              id: "00000000-0000-4000-8000-0000000000a1",
              roomId: "general",
              messageId: trigger.id,
              agentId: agent.id,
              agentName: "backend-agent",
              requesterName: "Alice",
              requesterType: "human",
              status: "queued",
              detail: "已送达，排队中",
              detailText: { key: "invocation.delivered" },
              attempts: 1,
              createdAt: now,
              updatedAt: now,
              receivedAt: now,
            },
          ],
          whiteboard: [],
        }),
      );
      const shadow = () =>
        document.querySelector(".message-list")!.shadowRoot as unknown as HTMLElement;
      await waitFor(() => expect(shadow().textContent).toContain("Alice started a new topic"));
      expect(shadow().textContent).not.toContain("开启了新话题");

      act(() =>
        socket.serverEvent({
          type: "error",
          code: "OWNER_ONLY",
          message: "访客只能忽略自己发起的调用。",
          text: { key: "error.guest.dismissOwn" },
        }),
      );
      expect(screen.getByRole("alert").textContent).toContain(
        "Guests can only dismiss tasks they started.",
      );
    } finally {
      setLocalePreference("zh-CN");
    }
  });

  it("shows per-message invocation chips and sends retry, cancel, and budget actions", async () => {
    const user = userEvent.setup();
    localStorage.setItem("superhive.username", "Alice");
    localStorage.setItem("superhive.notify-prompt-dismissed", "true");
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
    localStorage.setItem("superhive.username", "Alice");
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

    // 选了没装的 Codex：可以直接跳到设置的「Agent 运行时」去装，关掉设置回到接入弹窗原来那一步
    await user.click(screen.getByRole("radio", { name: /Codex/ }));
    await user.click(screen.getByRole("button", { name: "去安装 Codex →" }));
    expect(screen.queryByRole("heading", { name: "选择要接入的 Agent" })).toBeNull();
    expect(screen.getByRole("tab", { name: /Agent 运行时/ }).getAttribute("aria-selected")).toBe(
      "true",
    );
    await user.keyboard("{Escape}");
    expect(screen.getByRole("heading", { name: "选择要接入的 Agent" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /Codex/ }).getAttribute("aria-checked")).toBe("true");

    await user.click(screen.getByRole("radio", { name: /OpenCode/ }));
    expect(
      screen.getByRole("button", { name: "升级或调整 OpenCode 的配置（接口地址、密钥、模型等）→" }),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "下一步" }));
    await user.click(screen.getByRole("radio", { name: /^只读/ }));
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
    // 「本机」写在第二行说明里（提供方 · 本机 · 角色），不在名字后挂标签
    const origin = screen.getByTitle("由本机 Hive Server 启动");
    expect(origin.textContent).toBe("本机");
    // 运行时只给读屏（头像已经看得出来），默认的「通用协作 Agent」不再显示
    expect(origin.closest("small")?.textContent).toMatch(/^Agent · 本机$/);

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

    // 完全访问不跨次保留：关掉再打开回到工作区档
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "接入 Agent" }));
    await user.click(screen.getByRole("radio", { name: /OpenCode/ }));
    await user.click(screen.getByRole("button", { name: "下一步" }));
    expect(screen.getByRole("radio", { name: /^工作区/ }).getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("Server 在 Windows 上时，Claude Code 的工作区档说明没有系统沙箱；按 Server 平台判断，不看浏览器", async () => {
    const user = userEvent.setup();
    localStorage.setItem("superhive.username", "Alice");
    localApi.enabled = true;
    localApi.hostPlatform = "win32";
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
    const note =
      /Windows 上没有系统沙箱：命令可以访问工作区以外的文件；有风险的操作靠 Claude 的自动审核拦下，或先请你确认/;

    await user.click(screen.getByRole("button", { name: "接入 Agent" }));
    await user.click(await screen.findByRole("radio", { name: /Claude Code/ }));
    await user.click(screen.getByRole("button", { name: "下一步" }));
    // 说明写在工作区档的选项里，只读、完全访问不写
    expect(screen.getByRole("radio", { name: /^工作区/ }).textContent).toMatch(note);
    expect(screen.getByRole("radio", { name: /^只读/ }).textContent).not.toMatch(note);
    expect(screen.getByRole("radio", { name: /^完全访问/ }).textContent).not.toMatch(note);

    // 别的运行时在 Windows 上的工作区档有自己的限制方式：不写
    await user.click(screen.getByRole("button", { name: "返回第 1 步：选择 Agent" }));
    await user.click(screen.getByRole("radio", { name: /OpenCode/ }));
    await user.click(screen.getByRole("button", { name: "下一步" }));
    expect(screen.getByRole("radio", { name: /^工作区/ }).textContent).not.toMatch(note);
  });

  it("Server 不在 Windows 上（或旧版 Server 不报平台）时，Claude Code 的工作区档不写无沙箱说明", async () => {
    const user = userEvent.setup();
    localStorage.setItem("superhive.username", "Alice");
    localApi.enabled = true;
    localApi.hostPlatform = "darwin";
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
    await user.click(await screen.findByRole("radio", { name: /Claude Code/ }));
    await user.click(screen.getByRole("button", { name: "下一步" }));
    expect(screen.getByRole("radio", { name: /^工作区/ }).textContent).not.toContain(
      "没有系统沙箱",
    );
  });

  it("defaults clear-room confirmation to archiving and offers an explicit chat-only choice", async () => {
    const user = userEvent.setup();
    localApi.enabled = true;
    localStorage.setItem("superhive.username", "Alice");
    localStorage.setItem("superhive.notify-prompt-dismissed", "true");
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
    await waitFor(() =>
      expect(localApi.requests.some((request) => request.url.endsWith("/api/local/session"))).toBe(
        true,
      ),
    );
    await user.click(screen.getByRole("button", { name: "管理房间 general" }));
    const dialog = screen.getByRole("dialog", { name: "房间设置 · # general" });
    await waitFor(() =>
      expect(
        within(dialog).getByRole<HTMLButtonElement>("button", { name: "清空房间" }).disabled,
      ).toBe(false),
    );
    await user.click(within(dialog).getByRole("button", { name: "清空房间" }));
    expect(
      within(dialog).getByRole<HTMLInputElement>("checkbox", {
        name: "同时归档当前白板（历史可恢复）",
      }).checked,
    ).toBe(true);
    expect(
      within(dialog).getByText(
        "进行中和阻塞的事项也会一起归档；仍占用工作区的事项会阻止清空，请先清理对应 worktree。",
      ),
    ).toBeTruthy();
    localApi.clearFailure = "受保护事项未处理，本次未删除任何记录。";
    await user.click(within(dialog).getByRole("button", { name: "确认清空" }));
    await waitFor(() => expect(within(dialog).getByText(localApi.clearFailure!)).toBeTruthy());
    expect(screen.getByRole("dialog", { name: "房间设置 · # general" })).toBe(dialog);
    localApi.clearFailure = undefined;
    await user.click(within(dialog).getByRole("button", { name: "确认清空" }));
    await waitFor(() =>
      expect(
        localApi.requests.find((request) => request.url.endsWith("/rooms/general/clear"))?.body,
      ).toEqual({ username: "Alice", whiteboard: "archive", entries: [] }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "房间设置 · # general" })).toBeNull(),
    );
    await user.click(screen.getByRole("button", { name: "管理房间 frontend" }));
    const otherDialog = screen.getByRole("dialog", { name: "房间设置 · # frontend" });
    await user.click(within(otherDialog).getByRole("button", { name: "清空房间" }));
    await user.click(
      within(otherDialog).getByRole("checkbox", { name: "同时归档当前白板（历史可恢复）" }),
    );
    expect(
      within(otherDialog).getByText("仅清空聊天与调用记录，保留白板，不解除工作区占用。"),
    ).toBeTruthy();
    await user.click(within(otherDialog).getByRole("button", { name: "确认清空" }));
    await waitFor(() =>
      expect(
        localApi.requests.find((request) => request.url.endsWith("/rooms/frontend/clear"))?.body,
      ).toEqual({ username: "Alice", whiteboard: "keep" }),
    );
  });

  it("clears only current board state on linked events and preserves boards for chat-only and other rooms", async () => {
    const user = userEvent.setup();
    localStorage.setItem("superhive.username", "Alice");
    localStorage.setItem("superhive.notify-prompt-dismissed", "true");
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    const self = participant("00000000-0000-4000-8000-000000000001", "Alice", "human");
    const now = "2026-11-16T00:00:00.000Z";
    const entry: WhiteboardEntry = {
      id: "00000000-0000-4000-8000-0000000000b1",
      roomId: "general",
      key: "done",
      slot: "ready",
      summary: "board item",
      authorId: self.id,
      authorName: self.username,
      unblocks: [],
      createdAt: now,
      updatedAt: now,
    };
    const message: ChatMessage = {
      id: "00000000-0000-4000-8000-000000000010",
      roomId: "general",
      seq: 1,
      senderId: self.id,
      senderName: self.username,
      senderType: "human",
      content: "cleared",
      kind: "topic",
      mentions: [],
      traceId: "00000000-0000-4000-8000-000000000011",
      hopCount: 0,
      createdAt: now,
    };
    act(() =>
      socket.serverEvent({
        type: "room.snapshot",
        self,
        participants: [self],
        messages: [],
        latestSeq: 0,
        whiteboard: [entry],
      }),
    );
    const panel = screen.getByLabelText("成员列表");
    const tab = within(panel).getByRole("tab", { name: /进展/ });
    await user.click(tab);
    const board = await openAgentBoard(user, panel);
    act(() => socket.serverEvent({ type: "room.cleared", message, whiteboardArchived: false }));
    expect(within(board).getByText(entry.summary)).toBeTruthy();
    act(() =>
      socket.serverEvent({
        type: "room.cleared",
        message: { ...message, roomId: "frontend" },
        whiteboardArchived: true,
      }),
    );
    expect(within(board).getByText(entry.summary)).toBeTruthy();
    act(() => {
      socket.serverEvent({
        type: "whiteboard.removed",
        roomId: "general",
        entryId: entry.id,
        archivedEntry: { ...entry, archivedAt: now },
      });
      socket.serverEvent({ type: "room.cleared", message, whiteboardArchived: true });
    });
    expect(within(panel).queryByText(entry.summary)).toBeNull();
    expect(tab.textContent).toBe("进展");
    whiteboardApi.entries = [{ ...entry, archivedAt: now }];
    await user.click(within(board).getByRole("button", { name: "历史归档" }));
    await waitFor(() => expect(within(board).getByText(entry.summary)).toBeTruthy());
  });

  it("shows the room whiteboard grouped by slot and keeps it in sync", async () => {
    const user = userEvent.setup();
    localStorage.setItem("superhive.username", "Alice");
    localStorage.setItem("superhive.notify-prompt-dismissed", "true");
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
      repo: "superhive",
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
    const directory = {
      ...entryBase,
      id: "00000000-0000-4000-8000-0000000000b4",
      key: "worktree:legacy",
      slot: "blocked" as const,
      summary: "Directory reservation",
    };
    whiteboardApi.entries = [ready, blockedEntry, directory];
    vi.spyOn(window, "confirm").mockReturnValue(true);
    act(() =>
      socket.serverEvent({
        type: "room.snapshot",
        self,
        participants: [self, agent],
        messages: [],
        latestSeq: 0,
        invocations: [],
        whiteboard: [ready, blockedEntry, directory],
      }),
    );

    const panel = screen.getByLabelText("成员列表");
    const tab = within(panel).getByRole("tab", { name: /进展/ });
    expect(tab.getAttribute("aria-selected")).toBe("false");
    await user.click(tab);
    expect(tab.getAttribute("aria-selected")).toBe("true");
    // 白板阻塞留在「在做」里标「卡住了」；没有要人处理的事，标签数字显示在做的条数
    expect(tab.textContent).toBe("进展2");
    const progress = within(panel).getByRole("tabpanel");
    expect(
      within(progress)
        .getAllByRole("heading")
        .slice(0, 3)
        .map((heading) => heading.textContent),
    ).toEqual(["等你处理", "在做2", "最近完成"]);
    expect(within(progress).getByText("做完待验收")).toBeTruthy();
    expect(within(progress).getByText("卡住了")).toBeTruthy();
    // 任务目录登记只在原文里
    expect(within(progress).getAllByText("Directory reservation")).toHaveLength(1);
    const board = await openAgentBoard(user, panel);
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
    ).toEqual(["阻塞1", "进行中的工作1", "已就绪1"]);

    expect(
      (within(board).getByRole("checkbox", { name: "选择事项：db" }) as HTMLInputElement).disabled,
    ).toBe(false);
    expect(
      within(board).queryByRole("button", { name: "从白板移除：等待数据库迁移权限" }),
    ).toBeNull();
    await user.click(within(board).getByRole("button", { name: "归档事项：api" }));
    await waitFor(() => expect(within(board).queryByText(ready.summary)).toBeNull());
    expect(whiteboardApi.requests).toEqual([
      { action: "archive", entries: [{ id: ready.id, updatedAt: ready.updatedAt }] },
    ]);
    expect(tab.textContent).toBe("进展2");
    await user.click(within(board).getByRole("button", { name: "历史归档" }));
    await waitFor(() => expect(within(board).getByText(ready.summary)).toBeTruthy());
    expect(within(board).queryByText(blockedEntry.summary)).toBeNull();
    await user.click(
      within(board).getByRole("button", { name: "从白板移除：登录 API 已合入，可以接前端" }),
    );
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
      type: "whiteboard.remove",
      entryId: ready.id,
      updatedAt: whiteboardApi.entries.find((entry) => entry.id === ready.id)!.updatedAt,
    });
    act(() =>
      socket.serverEvent({
        type: "whiteboard.removed",
        roomId: "general",
        entryId: ready.id,
      }),
    );
    expect(within(board).queryByText(ready.summary)).toBeNull();
    await user.click(within(board).getByRole("button", { name: "当前事项" }));

    act(() => {
      socket.serverEvent({
        type: "whiteboard.removed",
        roomId: "general",
        entryId: blockedEntry.id,
      });
      socket.serverEvent({
        type: "whiteboard.removed",
        roomId: "general",
        entryId: "00000000-0000-4000-8000-0000000000b3",
      });
      socket.serverEvent({ type: "whiteboard.removed", roomId: "general", entryId: directory.id });
    });
    expect(within(board).getByText("白板还是空的")).toBeTruthy();
    expect(within(board).getByText("hive_board_update")).toBeTruthy();
    expect(within(progress).getByText("没有要你处理的事")).toBeTruthy();
  });

  it("does not let a stale history response resurrect deleted items or overwrite a restore", async () => {
    const user = userEvent.setup();
    localStorage.setItem("superhive.username", "Alice");
    localStorage.setItem("superhive.notify-prompt-dismissed", "true");
    const updatedAt = "2026-11-16T00:00:00.000Z";
    const baseEntry = {
      roomId: "general",
      authorId: "00000000-0000-4000-8000-000000000002",
      authorName: "helper",
      unblocks: [],
      createdAt: updatedAt,
      updatedAt,
      archivedAt: updatedAt,
      slot: "ready" as const,
    };
    const restored = {
      ...baseEntry,
      id: "00000000-0000-4000-8000-0000000000b1",
      key: "restored",
      summary: "restored item",
    };
    const deleted = {
      ...baseEntry,
      id: "00000000-0000-4000-8000-0000000000b2",
      key: "deleted",
      summary: "deleted item",
    };
    let resolveHistory!: (response: Response) => void;
    const originalFetch = (fetch as ReturnType<typeof vi.fn>).getMockImplementation()!;
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) =>
        String(input).includes("/whiteboard?view=all")
          ? new Promise<Response>((resolve) => {
              resolveHistory = resolve;
            })
          : originalFetch(input, init),
    );
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
        whiteboard: [],
      }),
    );
    const panel = screen.getByLabelText("成员列表");
    const tab = within(panel).getByRole("tab", { name: /进展/ });
    await user.click(tab);
    const board = await openAgentBoard(user, panel);
    await user.click(within(board).getByRole("button", { name: "历史归档" }));
    await waitFor(() => expect(resolveHistory).toBeTypeOf("function"));
    const current: WhiteboardEntry = { ...restored };
    delete current.archivedAt;
    act(() => {
      socket.serverEvent({
        type: "whiteboard.updated",
        // 恢复后刚更新过：超过 1 天没更新的「在做」条目不计入标签数字
        entry: { ...current, updatedAt: new Date().toISOString() },
      });
      socket.serverEvent({ type: "whiteboard.removed", roomId: "general", entryId: deleted.id });
      resolveHistory(jsonResponse({ entries: [restored, deleted] }));
    });
    await waitFor(() => expect(within(panel).queryByText("正在加载白板历史…")).toBeNull());
    expect(within(board).queryByText(deleted.summary)).toBeNull();
    expect(within(board).queryByText(restored.summary)).toBeNull();
    await user.click(within(board).getByRole("button", { name: "当前事项" }));
    expect(within(board).getByText(restored.summary)).toBeTruthy();
    expect(tab.textContent).toBe("进展1");
  });

  it.each(["snapshot", "clear"])(
    "discards a history request after a room %s",
    async (eventType) => {
      const user = userEvent.setup();
      localStorage.setItem("superhive.username", "Alice");
      localStorage.setItem("superhive.notify-prompt-dismissed", "true");
      let resolveHistory!: (response: Response) => void;
      let historyRequests = 0;
      const originalFetch = (fetch as ReturnType<typeof vi.fn>).getMockImplementation()!;
      (fetch as ReturnType<typeof vi.fn>).mockImplementation(
        (input: RequestInfo | URL, init?: RequestInit) =>
          String(input).includes("/whiteboard?view=all")
            ? historyRequests++ === 0
              ? new Promise<Response>((resolve) => {
                  resolveHistory = resolve;
                })
              : Promise.resolve(jsonResponse({ entries: [] }))
            : originalFetch(input, init),
      );
      render(<App />);
      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
      const socket = FakeWebSocket.instances[0]!;
      act(() => socket.open());
      const self = participant("00000000-0000-4000-8000-000000000001", "Alice", "human");
      const snapshot = {
        type: "room.snapshot" as const,
        self,
        participants: [self],
        messages: [],
        latestSeq: 0,
        whiteboard: [],
      };
      act(() => socket.serverEvent(snapshot));
      const panel = screen.getByLabelText("成员列表");
      await user.click(within(panel).getByRole("tab", { name: /进展/ }));
      const board = await openAgentBoard(user, panel);
      await user.click(within(board).getByRole("button", { name: "历史归档" }));
      await waitFor(() => expect(resolveHistory).toBeTypeOf("function"));
      act(() => {
        if (eventType === "snapshot") socket.serverEvent(snapshot);
        else
          socket.serverEvent({
            type: "room.cleared",
            whiteboardArchived: true,
            message: {
              id: "00000000-0000-4000-8000-000000000010",
              roomId: "general",
              seq: 1,
              senderId: self.id,
              senderName: self.username,
              senderType: "human",
              content: "cleared",
              kind: "topic",
              mentions: [],
              traceId: "00000000-0000-4000-8000-000000000011",
              hopCount: 0,
              createdAt: "2026-11-16T00:00:00.000Z",
            },
          });
        resolveHistory(
          jsonResponse({
            entries: [
              {
                id: "00000000-0000-4000-8000-0000000000b1",
                key: "old",
                roomId: "general",
                slot: "ready",
                summary: "stale history",
                archivedAt: "2026-11-16T00:00:00.000Z",
                updatedAt: "2026-11-16T00:00:00.000Z",
                createdAt: "2026-11-16T00:00:00.000Z",
                authorId: self.id,
                authorName: "Alice",
                unblocks: [],
              },
            ],
          }),
        );
      });
      await waitFor(() => expect(within(panel).queryByText("正在加载白板历史…")).toBeNull());
      expect(within(panel).queryByText("stale history")).toBeNull();
      expect(historyRequests).toBe(2);
    },
  );

  it("shows a thinking card in the conversation while an agent works and folds it above the reply", async () => {
    localStorage.setItem("superhive.username", "Alice");
    localStorage.setItem("superhive.notify-prompt-dismissed", "true");
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    const self = participant("00000000-0000-4000-8000-000000000001", "Alice", "human");
    const agent = participant("00000000-0000-4000-8000-000000000002", "helper", "agent");
    const now = new Date().toISOString();
    const message: ChatMessage = {
      id: "00000000-0000-4000-8000-0000000000a1",
      roomId: "general",
      seq: 1,
      senderId: self.id,
      senderName: "Alice",
      senderType: "human",
      content: "@helper 提交一下",
      mentions: ["helper"],
      traceId: "00000000-0000-4000-8000-0000000000a2",
      hopCount: 0,
      createdAt: now,
    };
    const invocation = {
      id: "00000000-0000-4000-8000-0000000000a3",
      roomId: "general",
      messageId: message.id,
      agentId: agent.id,
      agentName: "helper",
      requesterId: self.id,
      requesterName: "Alice",
      requesterType: "human" as const,
      status: "running" as const,
      attempts: 1,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
    };
    act(() =>
      socket.serverEvent({
        type: "room.snapshot",
        self,
        participants: [self, agent],
        messages: [message],
        latestSeq: 1,
        invocations: [invocation],
      }),
    );
    act(() =>
      socket.serverEvent({
        type: "invocation.trace",
        roomId: "general",
        invocationId: invocation.id,
        steps: [
          { id: "x", kind: "text", text: "先看一下改动", startedAt: now, endedAt: now },
          {
            id: "t1",
            kind: "tool",
            tool: "command",
            summary: "git status",
            status: "running",
            startedAt: now,
          },
        ],
      }),
    );
    const list = () =>
      within(document.querySelector(".message-list")!.shadowRoot as unknown as HTMLElement);
    // 对话流里出现「思考中」卡片：顶部是当前这一步，主体是中途说的话，命令收成一行
    const card = await waitFor(() => list().getByRole("article", { name: "helper 正在处理" }));
    expect(within(card).getByText("运行 git status")).toBeTruthy();
    await waitFor(() => expect(within(card).getByText("先看一下改动")).toBeTruthy());
    // 步骤收成一行汇总，点了看完整时间线
    expect(within(card).getByRole("button", { name: /运行 1 条命令.*看完整时间线/ })).toBeTruthy();
    // 状态行不再重复当前这一步；底部「谁在干活」也不再重复列出有卡片的 Agent
    expect(list().getAllByText("运行 git status")).toHaveLength(1);
    expect(
      document.querySelector(".message-list")!.shadowRoot!.querySelector(".typing"),
    ).toBeNull();
    // 思考摘要按纯文本显示，和中途说的话分开
    act(() =>
      socket.serverEvent({
        type: "invocation.trace",
        roomId: "general",
        invocationId: invocation.id,
        steps: [
          {
            id: "th1",
            kind: "thinking",
            text: "<b>Checking</b> the diff [link](https://x.y)",
            startedAt: now,
          },
        ],
      }),
    );
    // 思考按 Markdown 渲染：HTML 原样显示成文字，链接不可点
    await waitFor(() => expect(within(card).getByText("link")).toBeTruthy());
    expect(within(card).getByText("link").closest(".thinking-card-line.thinking")).toBeTruthy();
    expect(card.textContent).toContain("<b>Checking</b>");
    expect(within(card).queryByRole("link")).toBeNull();

    // 详情弹窗里的完整时间线默认收起，免得同一份内容摆两遍
    await userEvent.setup().click(list().getByRole("button", { name: /@helper.*查看调用详情/ }));
    const dialog = screen.getByRole("dialog", { name: "调用详情" });
    const full = within(dialog)
      .getByText(/完整执行过程（3 步）/)
      .closest("details")!;
    expect(full.open).toBe(false);
    const trace = within(dialog).getByRole("region", { name: "执行过程" });
    act(() =>
      socket.serverEvent({
        type: "invocation.trace",
        roomId: "general",
        invocationId: invocation.id,
        steps: [{ id: "t1", kind: "tool", status: "error", startedAt: now, endedAt: now }],
      }),
    );
    expect(within(trace).getByText("失败")).toBeTruthy();
    await userEvent.setup().keyboard("{Escape}");

    // 做完并回复：卡片消失，回复上方收成一行回顾，点开还能看这一轮的过程
    const reply: ChatMessage = {
      ...message,
      id: "00000000-0000-4000-8000-0000000000a4",
      seq: 2,
      senderId: agent.id,
      senderName: "helper",
      senderType: "agent",
      content: "提交好了",
      mentions: [],
      parentMessageId: message.id,
    };
    act(() => {
      socket.serverEvent({
        type: "invocation.trace",
        roomId: "general",
        invocationId: invocation.id,
        steps: [],
        ended: true,
      });
      socket.serverEvent({ type: "message.created", message: reply });
      socket.serverEvent({
        type: "invocation.updated",
        invocation: {
          ...invocation,
          status: "completed",
          finishedAt: now,
          updatedAt: now,
          replyMessageId: reply.id,
        },
      });
    });
    await waitFor(() =>
      expect(list().queryByRole("article", { name: "helper 正在处理" })).toBeNull(),
    );
    const recap = list().getByRole("button", { name: /^helper 的过程/ });
    expect(recap.textContent).toContain("运行 1 条命令");
    await userEvent.setup().click(recap);
    await waitFor(() => expect(list().getByText("先看一下改动")).toBeTruthy());
  });

  it("clicking a busy agent in the member list jumps to what it is working on instead of mentioning it", async () => {
    const user = userEvent.setup();
    localStorage.setItem("superhive.username", "Alice");
    localStorage.setItem("superhive.notify-prompt-dismissed", "true");
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    const self = participant("00000000-0000-4000-8000-000000000001", "Alice", "human");
    const busy = { ...participant("00000000-0000-4000-8000-000000000002", "helper", "agent") };
    busy.status = "busy";
    const idle = participant("00000000-0000-4000-8000-000000000003", "idle-bot", "agent");
    const now = new Date().toISOString();
    const ask = (seq: number, content: string): ChatMessage => ({
      id: `00000000-0000-4000-8000-0000000001${String(seq).padStart(2, "0")}`,
      roomId: "general",
      seq,
      senderId: self.id,
      senderName: "Alice",
      senderType: "human",
      content,
      mentions: ["helper"],
      traceId: "00000000-0000-4000-8000-0000000000f1",
      hopCount: 0,
      createdAt: now,
    });
    const queuedAsk = ask(1, "@helper 排队的那件");
    const runningAsk = ask(2, "@helper 正在做的那件");
    const task = (id: string, message: ChatMessage, status: "running" | "queued") => ({
      id,
      roomId: "general",
      messageId: message.id,
      agentId: busy.id,
      agentName: "helper",
      requesterId: self.id,
      requesterName: "Alice",
      requesterType: "human" as const,
      status,
      attempts: 1,
      createdAt: now,
      updatedAt: now,
    });
    act(() =>
      socket.serverEvent({
        type: "room.snapshot",
        self,
        participants: [self, busy, idle],
        messages: [queuedAsk, runningAsk],
        latestSeq: 2,
        invocations: [
          task("00000000-0000-4000-8000-0000000002a1", queuedAsk, "queued"),
          task("00000000-0000-4000-8000-0000000002a2", runningAsk, "running"),
        ],
      }),
    );
    const memberRow = (name: string) =>
      [...document.querySelectorAll<HTMLElement>(".member-list .member")].find(
        (row) => row.querySelector("strong")?.firstChild?.textContent === name,
      )!;
    await waitFor(() => expect(memberRow("helper").classList.contains("has-task")).toBe(true));
    const row = memberRow("helper");
    // 悬停提示和读屏描述说明点击会跳过去，副标题不变（默认的「通用协作 Agent」不显示）
    const hint = document.getElementById(row.getAttribute("aria-describedby")!)!;
    expect(hint.textContent).toBe("正在处理 #2 等 2 条 · 点击跳过去");
    expect(row.querySelector("small")?.textContent).not.toContain("点击跳过去");
    expect(row.hasAttribute("title")).toBe(false);
    expect(memberRow("idle-bot").classList.contains("has-task")).toBe(false);

    const shadow = () => document.querySelector(".message-list")!.shadowRoot!;
    const highlighted = (message: ChatMessage) =>
      shadow()
        .querySelector(`[data-message-id="${message.id}"]`)
        ?.classList.contains("highlighted");
    const composer = screen.getByRole("textbox", { name: "消息" }) as HTMLTextAreaElement;

    // 先跳正在执行的那条，有多条时提示第几条
    await user.click(row);
    await waitFor(() => expect(highlighted(runningAsk)).toBe(true));
    expect(await screen.findByText("@helper 在办的第 1/2 条")).toBeTruthy();
    expect(composer.value).toBe("");
    // 再点一次循环到下一条（键盘也行）
    row.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(highlighted(queuedAsk)).toBe(true));
    expect(await screen.findByText("@helper 在办的第 2/2 条")).toBeTruthy();
    expect(composer.value).toBe("");

    // 忙碌时 @ 它走名字旁的按钮
    await user.click(within(row).getByRole("button", { name: "在输入框里 @helper" }));
    expect(composer.value).toBe("@helper ");
    // 空闲的 Agent 照旧点一下 @ 它
    await user.click(memberRow("idle-bot"));
    expect(composer.value).toContain("@idle-bot");
  });

  it("jumps to the room where a busy agent is working when its task is elsewhere", async () => {
    const user = userEvent.setup();
    localStorage.setItem("superhive.username", "Alice");
    localStorage.setItem("superhive.notify-prompt-dismissed", "true");
    const elsewhere: ChatMessage = {
      id: "00000000-0000-4000-8000-000000000301",
      roomId: "frontend",
      seq: 42,
      senderId: "00000000-0000-4000-8000-000000000302",
      senderName: "Bob",
      senderType: "human",
      content: "@helper 改一下登录页",
      mentions: ["helper"],
      traceId: "00000000-0000-4000-8000-000000000303",
      hopCount: 0,
      createdAt: new Date().toISOString(),
    };
    crossRoom.invocationMessages = [elsewhere];
    crossRoom.invocations = [
      {
        id: "00000000-0000-4000-8000-000000000304",
        roomId: "frontend",
        messageId: elsewhere.id,
        agentId: "00000000-0000-4000-8000-000000000305",
        agentName: "helper",
        requesterName: "Bob",
        requesterType: "human",
        status: "running",
        attempts: 1,
        createdAt: elsewhere.createdAt,
        updatedAt: elsewhere.createdAt,
      },
    ];
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    const self = participant("00000000-0000-4000-8000-000000000001", "Alice", "human");
    const helper = participant("00000000-0000-4000-8000-000000000002", "helper", "agent");
    act(() =>
      socket.serverEvent({
        type: "room.snapshot",
        self,
        participants: [self, helper],
        messages: [],
        latestSeq: 0,
      }),
    );
    const row = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(".member-list .member.has-task");
      expect(element).toBeTruthy();
      return element!;
    });
    expect(document.getElementById(row.getAttribute("aria-describedby")!)?.textContent).toBe(
      "正在处理 #frontend #42 · 点击跳过去",
    );
    await user.click(row);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    act(() => FakeWebSocket.instances[1]!.open());
    expect(JSON.parse(FakeWebSocket.instances[1]!.sent[0]!)).toMatchObject({
      type: "participant.join",
      roomId: "frontend",
    });
    act(() =>
      FakeWebSocket.instances[1]!.serverEvent({
        type: "room.snapshot",
        self: { ...self, roomId: "frontend" },
        participants: [{ ...self, roomId: "frontend" }],
        messages: [elsewhere],
        latestSeq: 42,
      }),
    );
    await waitFor(() =>
      expect(
        document
          .querySelector(".message-list")!
          .shadowRoot!.querySelector(`[data-message-id="${elsewhere.id}"]`)
          ?.classList.contains("highlighted"),
      ).toBe(true),
    );
  });

  it("offers send-and-insert only when the draft mentions an agent that is running", async () => {
    localStorage.setItem("superhive.username", "Alice");
    localStorage.setItem("superhive.notify-prompt-dismissed", "true");
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    const self = participant("00000000-0000-4000-8000-000000000001", "Alice", "human");
    const helper = {
      ...participant("00000000-0000-4000-8000-000000000002", "helper", "agent"),
      provider: "claude",
    };
    const idle = {
      ...participant("00000000-0000-4000-8000-000000000003", "idle", "agent"),
      provider: "claude",
    };
    const now = new Date().toISOString();
    act(() =>
      socket.serverEvent({
        type: "room.snapshot",
        self,
        participants: [self, helper, idle],
        messages: [],
        latestSeq: 0,
        invocations: [
          {
            id: "00000000-0000-4000-8000-0000000000f1",
            roomId: "general",
            messageId: "00000000-0000-4000-8000-0000000000f2",
            agentId: helper.id,
            agentName: "helper",
            requesterName: "Alice",
            requesterType: "human",
            status: "running",
            attempts: 1,
            createdAt: now,
            updatedAt: now,
          },
        ],
      }),
    );
    const composer = screen.getByRole("textbox", { name: "消息" });
    fireEvent.change(composer, { target: { value: "@idle 看一下" } });
    expect(screen.queryByRole("button", { name: "引导" })).toBeNull();
    fireEvent.change(composer, { target: { value: "@helper 顺便把 README 也改了" } });
    fireEvent.click(screen.getByRole("button", { name: "引导" }));
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      type: "message.send",
      content: "@helper 顺便把 README 也改了",
      steer: true,
    });
  });

  it("collapses the room list and remembers the choice after a reload", async () => {
    const user = userEvent.setup();
    localStorage.setItem("superhive.username", "Alice");
    localStorage.setItem("superhive.notify-prompt-dismissed", "true");
    const { container, unmount } = render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
    const workspace = container.querySelector(".workspace")!;
    expect(workspace.classList.contains("rooms-collapsed")).toBe(false);
    await user.click(screen.getByRole("button", { name: "隐藏房间列表" }));
    expect(workspace.classList.contains("rooms-collapsed")).toBe(true);
    expect(localStorage.getItem("superhive.rooms-collapsed")).toBe("true");
    unmount();

    const again = render(<App />);
    expect(again.container.querySelector(".workspace")!.classList.contains("rooms-collapsed")).toBe(
      true,
    );
    await user.click(screen.getByRole("button", { name: "显示房间列表" }));
    expect(again.container.querySelector(".workspace")!.classList.contains("rooms-collapsed")).toBe(
      false,
    );
  });

  it("reorders pinned rooms by dragging and with Alt+arrow keys, and keeps the order on the server", async () => {
    const user = userEvent.setup();
    localStorage.setItem("superhive.username", "Alice");
    localStorage.setItem("superhive.notify-prompt-dismissed", "true");
    // 旧版存在本机的手动顺序不再沿用，启动时清掉
    localStorage.setItem("superhive.room-order", JSON.stringify(["frontend", "general"]));
    roomPins.ids = ["general", "frontend"];
    const { container, unmount } = render(<App />);
    const names = () =>
      [...container.querySelectorAll(".room-list .room-item-name")].map((node) => node.textContent);
    await waitFor(() => expect(names()).toEqual(["# general", "# frontend"]));
    // jsdom 没有 PointerEvent：用 MouseEvent 补一个带 pointerId / pointerType 的
    if (typeof window.PointerEvent === "undefined") {
      class TestPointerEvent extends MouseEvent {
        pointerId: number;
        pointerType: string;
        constructor(type: string, init: PointerEventInit = {}) {
          super(type, init);
          this.pointerId = init.pointerId ?? 0;
          this.pointerType = init.pointerType ?? "mouse";
        }
      }
      vi.stubGlobal("PointerEvent", TestPointerEvent);
    }
    // jsdom 不排版：给两项各一个 36px 高的位置，拖拽才算得出落点
    const items = [...container.querySelectorAll<HTMLElement>(".room-list .room-item")];
    items.forEach((item, index) => {
      item.getBoundingClientRect = () =>
        ({
          top: index * 36,
          bottom: index * 36 + 36,
          height: 36,
          left: 0,
          right: 200,
          width: 200,
        }) as DOMRect;
    });
    container.querySelector<HTMLElement>(".room-list")!.getBoundingClientRect = () =>
      ({ top: 0, bottom: 400, height: 400, left: 0, right: 200, width: 200 }) as DOMRect;
    // 拖拽时的自动滚动每帧排一次：这里换成真正异步的帧，免得同步回调无限递归
    window.requestAnimationFrame = (callback) =>
      window.setTimeout(() => callback(performance.now()), 16);
    window.cancelAnimationFrame = (id) => window.clearTimeout(id);
    const main = items[0]!.querySelector<HTMLElement>(".room-item-main")!;
    fireEvent.pointerDown(main, {
      button: 0,
      pointerId: 1,
      clientX: 10,
      clientY: 10,
      pointerType: "mouse",
    });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 10, clientY: 30 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 10, clientY: 60 });
    expect(items[0]!.classList.contains("dragging")).toBe(true);
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 10, clientY: 60 });
    // 松手后先滑到新位置，再提交顺序
    await waitFor(() => expect(names()).toEqual(["# frontend", "# general"]));
    await waitFor(() => expect(roomPins.requests).toEqual([["frontend", "general"]]));
    expect(localStorage.getItem("superhive.room-order")).toBeNull();

    // 键盘：Alt + ↑ 把 general 移回第一位
    const general = [...container.querySelectorAll<HTMLElement>(".room-list .room-item-main")][1]!;
    general.focus();
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
    expect(names()).toEqual(["# general", "# frontend"]);
    await waitFor(() => expect(roomPins.ids).toEqual(["general", "frontend"]));
    unmount();

    // 重新打开（换设备也一样）：顺序来自服务端
    roomPins.ids = ["frontend", "general"];
    const again = render(<App />);
    await waitFor(() =>
      expect(
        [...again.container.querySelectorAll(".room-list .room-item-name")].map(
          (node) => node.textContent,
        ),
      ).toEqual(["# frontend", "# general"]),
    );
  });

  it("sorts unpinned rooms by their latest message and re-sorts when a new one arrives", async () => {
    localStorage.setItem("superhive.username", "Alice");
    localStorage.setItem("superhive.notify-prompt-dismissed", "true");
    const { container } = render(<App />);
    const names = () =>
      [...container.querySelectorAll(".room-list .room-item-name")].map((node) => node.textContent);
    await waitFor(() => expect(names()).toEqual(["# frontend", "# general"]));
    await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
    const socket = FakeWebSocket.instances.at(-1)!;
    act(() => socket.open());
    const activity = (latestSeq: number, lastActivityAt: string) =>
      act(() =>
        socket.serverEvent({
          type: "room.activity",
          roomId: "general",
          latestSeq,
          onlineCount: 1,
          lastActivityAt,
        }),
      );
    activity(1, "2026-11-13T04:00:00.000Z");
    expect(names()).toEqual(["# general", "# frontend"]);

    // 鼠标停在列表上时先不动，移开后再排
    const list = container.querySelector<HTMLElement>(".room-list")!;
    fireEvent.pointerEnter(list);
    act(() =>
      socket.serverEvent({
        type: "rooms.changed",
        room: roomSummary("frontend", { latestSeq: 3, lastActivityAt: "2026-11-13T04:05:00.000Z" }),
      }),
    );
    expect(names()).toEqual(["# general", "# frontend"]);
    fireEvent.pointerLeave(list);
    expect(names()).toEqual(["# frontend", "# general"]);
  });

  it("lists every room's scheduled tasks in the left-side panel, with room tabs for pending ones, cancels and follows live updates", async () => {
    const user = userEvent.setup();
    localStorage.setItem("superhive.username", "Alice");
    localStorage.setItem("superhive.notify-prompt-dismissed", "true");
    localStorage.removeItem("superhive.schedules-seen-at");
    const self = participant("00000000-0000-4000-8000-000000000001", "Alice", "human");
    const agent = participant("00000000-0000-4000-8000-000000000002", "helper", "agent");
    const now = new Date().toISOString();
    const base = {
      roomId: "general",
      agentId: agent.id,
      agentName: "helper",
      requesterId: self.id,
      requesterName: "Alice",
      originMessageId: "00000000-0000-4000-8000-0000000000c0",
      originSeq: 3,
      timeZone: "Asia/Shanghai",
      createdAt: now,
      updatedAt: now,
    };
    const pending: Schedule = {
      ...base,
      id: "00000000-0000-4000-8000-0000000000c1",
      task: "0 点提醒 Alice 看部署结果",
      runAt: new Date(Date.now() + 90 * 60_000).toISOString(),
      status: "scheduled",
    };
    const fired: Schedule = {
      ...base,
      id: "00000000-0000-4000-8000-0000000000c2",
      task: "推送日报",
      runAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      status: "fired",
      triggerMessageId: "00000000-0000-4000-8000-0000000000d1",
      invocationId: "00000000-0000-4000-8000-0000000000e1",
    };
    // 另一个房间的周期任务（比当前房间的更早执行）和一个已错过的
    const patrol: Schedule = {
      ...base,
      roomId: "frontend",
      id: "00000000-0000-4000-8000-0000000000c3",
      task: "巡检 MR 评论",
      runAt: new Date(Date.now() + 20 * 60_000).toISOString(),
      status: "scheduled",
      everyMinutes: 30,
      until: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      occurrence: 2,
      seriesId: "00000000-0000-4000-8000-0000000000f1",
    };
    const missed: Schedule = {
      ...base,
      roomId: "frontend",
      id: "00000000-0000-4000-8000-0000000000c4",
      task: "周报汇总",
      runAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      status: "missed",
      detail: "Server 当时没在运行",
    };
    crossRoom.schedules = [pending, fired, patrol, missed];
    crossRoom.scheduleInvocations = [
      {
        id: fired.invocationId!,
        roomId: "general",
        messageId: fired.triggerMessageId!,
        agentId: agent.id,
        agentName: "helper",
        requesterId: self.id,
        requesterName: "Alice",
        requesterType: "human",
        status: "completed",
        attempts: 1,
        createdAt: now,
        updatedAt: now,
      },
    ];
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    act(() =>
      socket.serverEvent({
        type: "room.snapshot",
        self,
        participants: [self, agent],
        messages: [],
        latestSeq: 0,
      }),
    );

    // 右侧栏不再有「定时」
    expect(screen.queryByRole("tab", { name: /定时/ })).toBeNull();
    // 左侧入口：两个房间共 2 个待执行；没打开过面板，错过和没有回复的醒目提示
    const entry = await screen.findByRole("button", {
      name: "定时任务，2 个待执行，2 个没有正常完成",
    });
    await user.click(entry);
    const dialog = screen.getByRole("dialog", { name: "定时任务" });
    const tasks = () =>
      [...dialog.querySelectorAll("li:not([hidden] li) .schedule-task")].map(
        (task) => task.textContent,
      );
    const tabNames = () =>
      within(dialog)
        .getAllByRole("tab")
        .map((tab) => tab.getAttribute("aria-label"));
    // 顶部一行 tab：全部 + 有待执行任务的房间，当前房间排在前面并默认选中
    expect(tabNames()).toEqual([
      "全部，2 个待执行",
      "# general，1 个待执行",
      "# frontend，1 个待执行",
    ]);
    const generalTab = within(dialog).getByRole("tab", { name: "# general，1 个待执行" });
    expect(generalTab.getAttribute("aria-selected")).toBe("true");
    // 主区只列待执行；已结束的收在底部
    expect(tasks()).toEqual(["0 点提醒 Alice 看部署结果"]);
    const historyToggle = within(dialog).getByRole("button", { name: "已结束 1 条" });
    expect(historyToggle.getAttribute("aria-expanded")).toBe("false");

    // 左右键切 tab：切到「全部」，同组按执行时间，别的房间那个 20 分钟后的排在前面
    generalTab.focus();
    await user.keyboard("{ArrowLeft}");
    const allTab = within(dialog).getByRole("tab", { name: "全部，2 个待执行" });
    expect(allTab.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(allTab);
    expect(tasks()).toEqual(["巡检 MR 评论", "0 点提醒 Alice 看部署结果"]);
    await user.click(within(dialog).getByRole("button", { name: "已结束 2 条" }));
    expect(tasks()).toEqual(["巡检 MR 评论", "0 点提醒 Alice 看部署结果", "推送日报", "周报汇总"]);
    expect(within(dialog).getAllByRole("button", { name: "打开房间 frontend" })).toHaveLength(2);
    expect(within(dialog).getByText(/每 30 分钟 · 第 2 次 · 到/)).toBeTruthy();
    expect(within(dialog).getByText("没有回复")).toBeTruthy();
    expect(within(dialog).getByText("已错过")).toBeTruthy();
    // 打开过就算看过：入口只剩待执行数
    expect(screen.getByRole("button", { name: "定时任务，2 个待执行" })).toBeTruthy();

    // 点房间 tab：已结束的也只列这个房间的
    await user.click(within(dialog).getByRole("tab", { name: "# frontend，1 个待执行" }));
    expect(tasks()).toEqual(["巡检 MR 评论", "周报汇总"]);
    await user.click(allTab);

    // 取消走跨房间的 HTTP 接口，以当前用户名义
    await user.click(
      within(dialog).getByRole("button", { name: "取消定时任务：0 点提醒 Alice 看部署结果" }),
    );
    await waitFor(() =>
      expect(crossRoom.scheduleRequests.at(-1)).toEqual({
        url: expect.stringContaining(`/api/schedules/${pending.id}/cancel`),
        method: "POST",
        body: { by: "Alice" },
      }),
    );
    await waitFor(() => expect(within(dialog).getByText("已取消")).toBeTruthy());
    expect(screen.getByRole("button", { name: "定时任务，1 个待执行" })).toBeTruthy();
    // 取消后 general 没有待执行的了，它的 tab 跟着消失
    expect(tabNames()).toEqual(["全部，1 个待执行", "# frontend，1 个待执行"]);

    // 别的房间推来的更新也合并进面板（服务端跨房间推送）
    act(() =>
      socket.serverEvent({
        type: "schedule.updated",
        schedule: {
          ...patrol,
          status: "failed",
          detail: "执行的 Agent 已被移出房间",
          updatedAt: new Date(Date.now() + 5_000).toISOString(),
        },
      }),
    );
    expect(within(dialog).getByText("没能发出")).toBeTruthy();
    // 一个待执行的都没有：空状态说明，已结束的照样能看
    expect(tabNames()).toEqual(["全部，0 个待执行"]);
    expect(within(dialog).getByText("没有待执行的定时任务")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "已结束 4 条" })).toBeTruthy();
    // 看过之后新出的失败照样醒目提示
    expect(screen.getByRole("button", { name: "定时任务，1 个没有正常完成" })).toBeTruthy();

    // 点房间名跳过去并关掉面板
    await user.click(within(dialog).getAllByRole("button", { name: "打开房间 frontend" })[0]!);
    expect(screen.queryByRole("dialog", { name: "定时任务" })).toBeNull();
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    act(() => FakeWebSocket.instances[1]!.open());
    expect(JSON.parse(FakeWebSocket.instances[1]!.sent[0]!)).toMatchObject({
      type: "participant.join",
      roomId: "frontend",
    });
  });

  it("keeps the room spinner while another task in the room failed", async () => {
    localStorage.setItem("superhive.username", "Alice");
    const at = new Date().toISOString();
    const task = (id: string, status: Invocation["status"]) =>
      ({
        id,
        roomId: "frontend",
        messageId: "00000000-0000-4000-8000-000000000201",
        agentId: "00000000-0000-4000-8000-000000000105",
        agentName: "frontend-agent",
        requesterName: "Alice",
        requesterType: "human",
        status,
        attempts: 1,
        createdAt: at,
        updatedAt: at,
      }) as Invocation;
    crossRoom.invocations = [
      task("00000000-0000-4000-8000-000000000311", "running"),
      task("00000000-0000-4000-8000-000000000312", "failed"),
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
    // 失败的计数和转圈并排：房间里还有 Agent 在干活，不能因为一条失败就看不出来
    expect(await screen.findByRole("img", { name: "# frontend：1 个任务需要处理" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "# frontend：1 个任务进行中" })).toBeTruthy();
  });

  it("reminds me across rooms when my task needs me or finishes, and jumps to it", async () => {
    const user = userEvent.setup();
    localStorage.setItem("superhive.username", "Alice");
    localStorage.setItem("superhive.notify-prompt-dismissed", "true");
    FakeNotification.permission = "granted";
    const at = new Date().toISOString();
    const task = (id: string, status: Invocation["status"], extra: Partial<Invocation> = {}) =>
      ({
        id,
        roomId: "frontend",
        messageId: "00000000-0000-4000-8000-000000000201",
        agentId: "00000000-0000-4000-8000-000000000105",
        agentName: "frontend-agent",
        requesterName: "Alice",
        requesterType: "human",
        status,
        attempts: 1,
        createdAt: at,
        updatedAt: at,
        ...extra,
      }) as Invocation;
    const first = "00000000-0000-4000-8000-000000000301";
    const second = "00000000-0000-4000-8000-000000000302";
    crossRoom.invocations = [task(first, "running"), task(second, "running")];
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
    expect(await screen.findByRole("img", { name: "# frontend：2 个任务进行中" })).toBeTruthy();
    // 标签页图标：你派的任务在跑，蓝点；标题不带数字
    await waitFor(() =>
      expect(document.querySelector<HTMLLinkElement>('link[rel~="icon"]')?.dataset.badge).toBe(
        "running",
      ),
    );
    expect(document.title.startsWith("(")).toBe(false);

    // 页面不在前台：两条任务各弹一条系统通知，不会互相顶掉
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    act(() => {
      socket.serverEvent({ type: "invocation.updated", invocation: task(first, "waiting_human") });
      socket.serverEvent({
        type: "invocation.updated",
        invocation: task(second, "failed", { detail: "测试没过" }),
      });
    });
    expect(FakeNotification.instances.map((item) => item.title)).toEqual([
      "frontend-agent 在等你回答",
      "frontend-agent 的任务失败了",
    ]);
    expect(FakeNotification.instances[1]!.options?.body).toBe("# frontend · 测试没过");
    expect(new Set(FakeNotification.instances.map((item) => item.options?.tag)).size).toBe(2);
    // 同一状态的重复推送不再提醒
    act(() =>
      socket.serverEvent({
        type: "invocation.updated",
        invocation: task(second, "failed", { detail: "测试没过" }),
      }),
    );
    expect(FakeNotification.instances).toHaveLength(2);
    // 侧栏列出需要处理的，最急的在前
    const group = screen.getByRole("region", { name: "需要你处理" });
    expect(
      within(group)
        .getAllByRole("button")
        .map((item) => item.textContent),
    ).toEqual(["等你回答frontend-agent · # frontend", "失败frontend-agent · # frontend"]);
    // 需要你处理的优先：红点，标题数出 2 条
    expect(document.querySelector<HTMLLinkElement>('link[rel~="icon"]')?.dataset.badge).toBe(
      "attention",
    );
    expect(document.title.startsWith("(2) ")).toBe(true);

    // 回到前台、但看的是别的房间：做完了在页面内提示，房间上标「完成未看」
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      socket.serverEvent({ type: "invocation.updated", invocation: task(first, "completed") });
    });
    expect(FakeNotification.instances).toHaveLength(2);
    const toasts = screen.getByRole("region", { name: "任务提醒" });
    expect(within(toasts).getByText("frontend-agent 做完了")).toBeTruthy();
    expect(screen.getByRole("img", { name: "# frontend：1 个任务需要处理" })).toBeTruthy();
    act(() =>
      socket.serverEvent({
        type: "invocation.updated",
        invocation: task(second, "failed", {
          detail: "测试没过",
          resolution: { kind: "dismissed", at },
        }),
      }),
    );
    expect(
      await screen.findByRole("img", { name: "# frontend：1 个任务做完了，还没看" }),
    ).toBeTruthy();
    // 没有要处理、也没有在跑的了：只剩做完未看，绿点，标题去掉数字（图标在 effect 里改，和上面一样要等）
    await waitFor(() =>
      expect(document.querySelector<HTMLLinkElement>('link[rel~="icon"]')?.dataset.badge).toBe(
        "unseen",
      ),
    );
    expect(document.title.startsWith("(")).toBe(false);

    // 点「查看」跳到那个房间；看过之后「完成未看」消失
    // 点整条提示就跳过去，没有单独的「查看」按钮
    expect(within(toasts).queryByRole("button", { name: "查看" })).toBeNull();
    await user.click(within(toasts).getByRole("button", { name: /frontend-agent 做完了/ }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    await waitFor(() =>
      expect(screen.queryByRole("img", { name: "# frontend：1 个任务做完了，还没看" })).toBeNull(),
    );
    expect(within(toasts).queryByText("frontend-agent 做完了")).toBeNull();
  });

  it("walks a first-time owner through connecting an agent, notifications and IM", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.type(screen.getByLabelText("你的用户名"), "Alice");
    await user.click(screen.getByRole("button", { name: /进入聊天室/ }));
    const guide = await screen.findByRole("dialog", { name: "三步开始用 SuperHive" });
    expect(within(guide).getByText("接入一个 Agent")).toBeTruthy();
    expect(within(guide).getByText("连上飞书或微信")).toBeTruthy();
    // 进入时已顺带授权了通知，这一步自动算完成
    await waitFor(() => expect(within(guide).getByText("第一次使用 · 已完成 1/3")).toBeTruthy());

    // 去接 Agent：引导先收起，弹窗关掉后可以接着看
    await user.click(within(guide).getByRole("button", { name: "接入 Agent" }));
    expect(screen.queryByRole("dialog", { name: "三步开始用 SuperHive" })).toBeNull();
    await user.keyboard("{Escape}");
    await user.click(await screen.findByRole("button", { name: "继续上手引导（1/3）" }));
    await user.click(
      within(screen.getByRole("dialog", { name: "三步开始用 SuperHive" })).getByRole("button", {
        name: "跳过，以后再说",
      }),
    );
    expect(screen.queryByRole("dialog", { name: "三步开始用 SuperHive" })).toBeNull();
    expect(screen.queryByRole("button", { name: /继续上手引导/ })).toBeNull();
    expect(localStorage.getItem("superhive.onboarding")).toBe("done");
  });

  it("does not show the first-time guide to people who already used this browser", async () => {
    localStorage.setItem("superhive.username", "Alice");
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    expect(screen.queryByRole("dialog", { name: "三步开始用 SuperHive" })).toBeNull();
    expect(localStorage.getItem("superhive.onboarding")).toBeNull();
  });

  it("opens search, mentions and agent tasks from the sidebar and jumps across rooms", async () => {
    const user = userEvent.setup();
    localStorage.setItem("superhive.username", "Alice");
    localStorage.setItem("superhive.notify-prompt-dismissed", "true");
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

  it("opens Go To with ⌘P, jumps to the next task needing attention with ⌘J, and lists shortcuts", async () => {
    const user = userEvent.setup();
    localStorage.setItem("superhive.username", "Alice");
    localStorage.setItem("superhive.notify-prompt-dismissed", "true");
    const question: ChatMessage = {
      id: "00000000-0000-4000-8000-000000000201",
      roomId: "frontend",
      seq: 7,
      senderId: "00000000-0000-4000-8000-000000000202",
      senderName: "Bob",
      senderType: "human",
      content: "@frontend-agent 改一下登录页",
      mentions: ["frontend-agent"],
      traceId: "00000000-0000-4000-8000-000000000203",
      hopCount: 0,
      createdAt: new Date().toISOString(),
    };
    crossRoom.invocationMessages = [question];
    crossRoom.invocations = [
      {
        id: "00000000-0000-4000-8000-000000000204",
        roomId: "frontend",
        messageId: question.id,
        agentId: "00000000-0000-4000-8000-000000000205",
        agentName: "frontend-agent",
        requesterName: "Bob",
        requesterType: "human",
        status: "waiting_human",
        detail: "用哪套配色？",
        attempts: 1,
        createdAt: question.createdAt,
        updatedAt: question.createdAt,
      },
    ];
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    act(() => FakeWebSocket.instances[0]!.open());
    act(() =>
      FakeWebSocket.instances[0]!.serverEvent({
        type: "room.snapshot",
        self: participant("00000000-0000-4000-8000-000000000001", "Alice", "human"),
        participants: [],
        messages: [],
        latestSeq: 0,
      }),
    );
    await screen.findByRole("button", { name: "Agent 任务，1 个需要处理" });

    // 输入框里打 ? 只是输入文字，不会弹出快捷键帮助；⌘/ 任何时候都能打开
    const composer = screen.getByRole("textbox", { name: "消息" });
    await user.click(composer);
    await user.keyboard("?");
    expect(screen.queryByRole("dialog", { name: "快捷键" })).toBeNull();
    await user.keyboard("{Meta>}/{/Meta}");
    const help = await screen.findByRole("dialog", { name: "快捷键" });
    expect(within(help).getByText("跳到下一个要你处理的任务")).toBeTruthy();
    await user.type(within(help).getByRole("searchbox", { name: "筛选快捷键" }), "房间");
    expect(within(help).queryByText("换行")).toBeNull();
    expect(within(help).getByText("把选中的置顶房间上移一格")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "快捷键" })).toBeNull();

    // ⌘P 打开跳转器：要处理的任务排最前，可按名字筛
    await user.keyboard("{Meta>}p{/Meta}");
    const goto = await screen.findByRole("dialog", { name: "跳转到" });
    const options = within(goto).getAllByRole("option");
    expect(options[0]!.textContent).toContain("@frontend-agent · 等你回答");
    await user.click(within(goto).getByRole("button", { name: /^要处理/ }));
    for (const option of within(goto).getAllByRole("option")) {
      expect(option.textContent).toContain("要处理");
    }
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "跳转到" })).toBeNull();

    // ⌘J 直接跳到那条任务所在的房间
    await user.keyboard("{Meta>}j{/Meta}");
    expect(await screen.findByText("要处理的第 1/1 条 · @frontend-agent · 等你回答")).toBeTruthy();
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    act(() => FakeWebSocket.instances[1]!.open());
    expect(JSON.parse(FakeWebSocket.instances[1]!.sent[0]!)).toMatchObject({
      type: "participant.join",
      roomId: "frontend",
    });
  });
  it("工作区入口：显示未提交改动数，打开只读面板，房主可在房间设置里允许访客查看", async () => {
    const user = userEvent.setup();
    localStorage.setItem("superhive.username", "Alice");
    localStorage.setItem("superhive.notify-prompt-dismissed", "true");
    const original = globalThis.fetch;
    const patches: unknown[] = [];
    let guestsAllowed = false;
    const general = () =>
      roomSummary("general", {
        workspace: "/Users/alice/hive",
        ...(guestsAllowed ? { workspaceFilesGuests: true } : {}),
      });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/rooms/general/workspace/status"))
          return jsonResponse({ git: true, branch: "main", changes: [] });
        if (url.includes("/api/rooms/general/workspace"))
          return jsonResponse({
            configured: true,
            name: "hive",
            git: true,
            changeCount: 3,
            guestsAllowed,
            canReveal: true,
            sources: [{ id: "workspace", kind: "workspace", label: "hive", branch: "main" }],
          });
        if (url.endsWith("/api/rooms/general") && init?.method === "PATCH") {
          const body = JSON.parse(String(init.body)) as { workspaceFilesGuests?: boolean };
          patches.push(body);
          guestsAllowed = Boolean(body.workspaceFilesGuests);
          return jsonResponse({ room: general() });
        }
        if (/\/api\/rooms(\?|$)/.test(url) && !init?.method)
          return jsonResponse({ rooms: [general(), roomSummary("frontend")] });
        return original(input, init);
      }),
    );
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
    // 进房间后稍等再查改动数（避免和首屏请求挤在一起），全量并行跑测试时可能更慢
    const entry = await screen.findByRole(
      "button",
      { name: "工作区文件与改动（3 个文件有未提交改动）" },
      { timeout: 5000 },
    );
    expect(entry.textContent).toContain("3");
    await user.click(entry);
    const panel = await screen.findByRole("dialog", { name: "工作区" });
    expect(await within(panel).findByText("没有未提交的改动。")).toBeTruthy();
    fireEvent.keyDown(panel, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "工作区" })).toBeNull());

    await user.click(screen.getByRole("button", { name: "管理房间 general" }));
    const dialog = screen.getByRole("dialog", { name: "房间设置 · # general" });
    const allow = within(dialog).getByRole<HTMLInputElement>("checkbox", {
      name: "允许访客查看工作区文件与改动",
    });
    expect(allow.checked).toBe(false);
    await user.click(allow);
    await user.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(patches).toEqual([{ name: "general", workspaceFilesGuests: true }]));
  });

  it("访客只在房主允许后才看到工作区入口", async () => {
    localStorage.setItem("superhive.notify-prompt-dismissed", "true");
    const original = globalThis.fetch;
    let allowed = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/meta"))
          return jsonResponse({
            name: "SuperHive",
            roomId: "general",
            httpUrl: "http://localhost:8787",
            wsUrl: "ws://localhost:8787/ws",
            mcpUrl: "http://localhost:8787/mcp",
          });
        if (url.includes("/workspace"))
          return jsonResponse({ configured: true, git: true, changeCount: 1, sources: [] });
        if (/\/api\/rooms(\?|$)/.test(url))
          return jsonResponse({
            rooms: [
              roomSummary("general", {
                workspace: "/Users/alice/hive",
                ...(allowed ? { workspaceFilesGuests: true } : {}),
              }),
            ],
          });
        return original(input, init);
      }),
    );
    const guest = {
      role: "guest",
      token: "hvs_guest",
      username: "bob",
      roomId: "general",
      expiresAt: null,
      allowAgents: false,
      showTrace: true,
    } as unknown as GuestAccess;
    render(<App guest={guest} />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    const self = participant("00000000-0000-4000-8000-000000000002", "bob", "human");
    act(() =>
      socket.serverEvent({
        type: "room.snapshot",
        self,
        participants: [self],
        messages: [],
        latestSeq: 0,
      }),
    );
    await screen.findByRole("heading", { name: "general" });
    expect(screen.queryByRole("button", { name: /工作区文件与改动/ })).toBeNull();
    allowed = true;
    act(() =>
      socket.serverEvent({
        type: "rooms.changed",
        room: roomSummary("general", {
          workspace: "/Users/alice/hive",
          workspaceFilesGuests: true,
        }),
      }),
    );
    expect(await screen.findByRole("button", { name: /工作区文件与改动/ })).toBeTruthy();
  });
});
