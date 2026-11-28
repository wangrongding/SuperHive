import type {
  ChatMessage,
  Invocation,
  InvocationReport,
  MessagesResponse,
  Participant,
  RoomSummary,
  ServerEvent,
  TraceStep,
  WhiteboardEntry,
} from "./hive-protocol.js";
import WebSocket from "ws";
import { runningCodeVersion, type AgentCodeVersion } from "./code-version.js";

/**
 * 读房间数据（消息、白板、成员）的 HTTP 请求最多等多久：和按序号、按 ID 读一条消息用的是同一个接口、同一个时限。
 * 本机 Server 正常几十毫秒就回；卡住不回时按时限放弃，抛 TimeoutError，Bridge 当成连不上、等它恢复，
 * 不会一直挂到 Node 默认的 5 分钟
 */
const REQUEST_TIMEOUT_MS = 10_000;

export class RoomClientError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "RoomClientError";
  }
}

export async function fetchRooms(serverUrl: string, token: string): Promise<RoomSummary[]> {
  const response = await fetch(`${serverUrl}/api/rooms`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`无法获取房间列表 (${response.status})`);
  return ((await response.json()) as { rooms: RoomSummary[] }).rooms;
}

export type RoomClientOptions = {
  serverUrl: string;
  roomId: string;
  username: string;
  token: string;
  persona?: string;
  provider?: string;
  /** 上报的代码版本；默认是本进程的版本 */
  version?: AgentCodeVersion;
  /** 在本房间实际的工作目录、房间设置的工作区、没用上的原因；加入时上报，旧版服务端会忽略 */
  workspace?: { cwd: string; roomWorkspace?: string; note?: string; noSandbox?: boolean };
  /** 被房主暂停（SESSION_PAUSED）后隔多久再试着重连；默认 45 秒 */
  pausedRetryMs?: number;
  /** 读房间数据的请求时限；默认 REQUEST_TIMEOUT_MS，测试注入 */
  requestTimeoutMs?: number;
};

export type Snapshot = {
  self: Participant;
  latestSeq: number;
  messages: ChatMessage[];
  participants: Participant[];
  /** 旧版服务端为 undefined：Agent 需退回到纯本地的去重判断 */
  invocations?: Invocation[];
};

export type RoomClientHandlers = {
  onSnapshot: (snapshot: Snapshot) => void | Promise<void>;
  onMention: (
    message: ChatMessage,
    latestSeq: number,
    retry: boolean,
    steer?: boolean,
    first?: boolean,
    /** 没有 @ 任何人、因为是房间的主 Agent 才派来的 */
    lead?: boolean,
    /** 人点「换个模型重试」选的模型：只对这一次生效 */
    model?: string,
    /** 人对一次中途中断点了「继续」 */
    resume?: boolean,
    /** 人点「换个模型重试」时选的思考强度：只对这一次生效 */
    effort?: string,
    /** 服务端标的这条提及落在哪一道会话（Invocation.laneKey）；老服务端没有 */
    laneKey?: string,
  ) => void;
  onCancel?: (messageId: string, turn?: string[]) => void;
  /** 人批了 / 拒了执行中申请的权限 */
  onApprovalDecision?: (requestId: string, allow: boolean, reason?: string) => void;
  /** 本机 Hive Server 请本进程退出（Windows 上停止本机 Agent 时用） */
  onShutdown?: () => void;
  onMessageDeleted?: (message: ChatMessage) => void;
  onRoomsChanged?: (room: RoomSummary) => void;
  /** 加入房间成功（收到快照）/ 连接断开：本机「带到别处的 Agent」清单据此显示是否在线 */
  onConnectionChange?: (connected: boolean) => void;
  onError: (error: Error) => void;
};

type PendingSend = {
  resolve: (message: ChatMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class RoomClient {
  private socket?: WebSocket;
  private stopped = false;
  private retry = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private readonly pending = new Map<string, PendingSend>();
  /** 断线期间产生的状态回报，按消息只保留最新一条，重新加入房间后补发 */
  private readonly outbox = new Map<string, InvocationReport>();
  private joined = false;
  /** 旧版服务端的快照没有 invocations，也不认识 invocation.report，向它发送会触发错误 */
  private serverTracksInvocations = true;
  /** 服务端能接收执行过程（旧版服务端不认识这个事件，会回错误） */
  private serverAcceptsTrace = false;
  /** 服务端能把执行中的权限申请转给人批（旧版服务端没有，这时直接拒绝） */
  private serverAcceptsApproval = false;
  private serverAcceptsSession = false;
  private serverAcceptsTools = false;
  /** 上次知道的 Hive 工具状态：状态变了才发，重连后补发连不上的情况 */
  private hiveTools: { hive: "connected" | "unavailable"; detail?: string } | undefined;
  /** 这个房间当前的 Provider 会话：重连后再报一次 */
  private session?: { sessionId: string; cwd: string };
  /** 正在干活：重连后服务端会把状态重置成在线，要再报一次，否则成员列表显示空闲、对话流里却还在执行 */
  private typing = false;
  /** 房主暂停了这个访客 Agent：重连拉长间隔，直到重新加入成功 */
  private paused = false;

  constructor(
    private readonly options: RoomClientOptions,
    private readonly handlers: RoomClientHandlers,
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
    this.heartbeatTimer = setInterval(() => this.sendRaw({ type: "presence.heartbeat" }), 15_000);
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.socket?.close(1000, "Agent stopping");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Agent stopped before the message was acknowledged."));
    }
    this.pending.clear();
  }

  setTyping(active: boolean): void {
    this.typing = active;
    this.sendRaw({ type: "agent.typing", active });
  }

  /** 回报调用进展；连接不可用时进入 outbox，重连后补发（终态不会因断线丢失） */
  report(report: Omit<InvocationReport, "type">): void {
    const event: InvocationReport = { type: "invocation.report", ...report };
    if (this.joined && !this.serverTracksInvocations) return;
    if (this.joined && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(event));
      return;
    }
    const previous = this.outbox.get(report.messageId);
    // 已有终态时，不让迟到的中间状态覆盖它
    if (previous && previous.status !== "received" && previous.status !== "running") {
      if (report.status === "received" || report.status === "running") return;
    }
    this.outbox.set(report.messageId, event);
  }

  /** 还在 outbox 里没送达的终态回报：进程退出前由 Bridge 落盘，下次加入时补发 */
  undeliveredReports(): InvocationReport[] {
    return [...this.outbox.values()].filter(
      (report) => report.status !== "received" && report.status !== "running",
    );
  }

  /** 上报执行过程：只是实时状态，连接不可用就直接丢掉，不进 outbox */
  /** 把执行中的权限申请交给服务端转给人批；连不上或服务端不支持时返回 false（调用方按拒绝处理） */
  requestApproval(request: {
    messageId: string;
    requestId: string;
    tool: string;
    summary: string;
    detail?: string;
  }): boolean {
    if (!this.serverAcceptsApproval || this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify({ type: "approval.request", ...request }));
    return true;
  }

  /** 报告这个房间当前用的 Provider 会话，人可以在终端里 resume 接着它；服务端不支持就只记下 */
  reportSession(sessionId: string, cwd: string): void {
    if (this.session?.sessionId === sessionId && this.session.cwd === cwd) return;
    this.session = { sessionId, cwd };
    if (this.serverAcceptsSession) this.sendRaw({ type: "agent.session", sessionId, cwd });
  }

  /**
   * 报告这个 Agent 的 Hive 工具（MCP）连上了没有：连不上时网页成员列表里会标出来，
   * 不能悄无声息地少了 hive_* 工具。状态没变不重发；服务端不支持就只记下。
   */
  reportHiveTools(hive: "connected" | "unavailable", detail?: string): void {
    const next = {
      hive,
      ...(hive === "unavailable" && detail ? { detail: detail.slice(0, 500) } : {}),
    };
    if (this.hiveTools?.hive === next.hive && this.hiveTools.detail === next.detail) return;
    this.hiveTools = next;
    if (this.serverAcceptsTools) this.sendRaw({ type: "agent.tools", ...next });
  }

  trace(messageId: string, steps: TraceStep[]): void {
    if (!this.serverAcceptsTrace || steps.length === 0) return;
    this.sendRaw({ type: "invocation.trace", messageId, steps });
  }

  /** 一次读请求的时限（连同读响应体） */
  private deadline(): AbortSignal {
    return AbortSignal.timeout(this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
  }

  async fetchWhiteboard(): Promise<WhiteboardEntry[]> {
    const response = await fetch(
      new URL(
        `/api/rooms/${encodeURIComponent(this.options.roomId)}/whiteboard`,
        this.options.serverUrl,
      ),
      { headers: { Authorization: `Bearer ${this.options.token}` }, signal: this.deadline() },
    );
    // 旧版服务端没有白板接口，视为空白板
    if (response.status === 404) return [];
    if (!response.ok) throw new Error(`无法读取协作白板 (${response.status})`);
    return ((await response.json()) as { entries: WhiteboardEntry[] }).entries;
  }

  async fetchParticipants(): Promise<Participant[]> {
    const response = await fetch(
      new URL(
        `/api/rooms/${encodeURIComponent(this.options.roomId)}/participants`,
        this.options.serverUrl,
      ),
      { headers: { Authorization: `Bearer ${this.options.token}` }, signal: this.deadline() },
    );
    if (!response.ok) throw new Error(`无法读取房间成员 (${response.status})`);
    return ((await response.json()) as { participants: Participant[] }).participants;
  }

  async fetchInstructions(): Promise<string> {
    const response = await fetch(`${this.options.serverUrl}/agent.md`);
    if (!response.ok) throw new Error(`无法获取服务器 Agent 规则 (${response.status})`);
    return response.text();
  }

  async fetchMessageAt(seq: number, id: string): Promise<ChatMessage | undefined> {
    const url = new URL(
      `/api/rooms/${encodeURIComponent(this.options.roomId)}/messages`,
      this.options.serverUrl,
    );
    url.searchParams.set("afterSeq", String(seq - 1));
    url.searchParams.set("limit", "1");
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.options.token}` },
      signal: this.deadline(),
    });
    if (!response.ok) throw new Error(`无法读取子任务结果 (${response.status})`);
    const payload = (await response.json()) as MessagesResponse;
    return payload.messages.find((message) => message.id === id && message.seq === seq);
  }

  /** 按 ID 读一条消息（不知道序号时用，例如手打回复的提问）；不在本房间或读不到时返回 undefined */
  async fetchMessageById(id: string): Promise<ChatMessage | undefined> {
    const url = new URL(
      `/api/rooms/${encodeURIComponent(this.options.roomId)}/messages`,
      this.options.serverUrl,
    );
    url.searchParams.set("messageId", id);
    url.searchParams.set("limit", "1");
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.options.token}` },
      signal: this.deadline(),
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`无法读取消息 (${response.status})`);
    const payload = (await response.json()) as MessagesResponse;
    return payload.messages.find((message) => message.id === id);
  }

  async fetchMessages(afterSeq: number): Promise<{ messages: ChatMessage[]; latestSeq: number }> {
    const all: ChatMessage[] = [];
    let cursor = afterSeq;
    let latestSeq = afterSeq;
    for (;;) {
      const url = new URL(
        `/api/rooms/${encodeURIComponent(this.options.roomId)}/messages`,
        this.options.serverUrl,
      );
      url.searchParams.set("afterSeq", String(cursor));
      url.searchParams.set("limit", "500");
      // 每一页各自计时：卡住的那一页按时限放弃，已经拉到的页不白等
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${this.options.token}` },
        signal: this.deadline(),
      });
      if (!response.ok) throw new Error(`无法补拉公共消息 (${response.status})`);
      const payload = (await response.json()) as MessagesResponse;
      all.push(...payload.messages);
      latestSeq = payload.latestSeq;
      const last = payload.messages.at(-1);
      if (!last || payload.messages.length < 500) break;
      cursor = last.seq;
    }
    return { messages: all, latestSeq };
  }

  sendMessage(input: {
    content: string;
    clientMessageId: string;
    parentMessageId: string;
    attachmentIds?: string[];
  }): Promise<ChatMessage> {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("聊天室连接已断开，稍后将自动重试。"));
    }
    const promise = new Promise<ChatMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(input.clientMessageId);
        reject(new Error("服务端未在 15 秒内确认 Agent 回复。"));
      }, 15_000);
      this.pending.set(input.clientMessageId, { resolve, reject, timer });
    });
    this.sendRaw({ type: "message.send", ...input });
    return promise;
  }

  private connect(): void {
    if (this.stopped) return;
    const wsUrl = this.options.serverUrl.replace(/^http/, "ws") + "/ws";
    const socket = new WebSocket(wsUrl);
    this.socket = socket;
    socket.on("open", () => {
      socket.send(
        JSON.stringify({
          type: "participant.join",
          username: this.options.username,
          participantType: "agent",
          roomId: this.options.roomId,
          token: this.options.token,
          ...(this.options.persona ? { persona: this.options.persona } : {}),
          ...(this.options.provider ? { provider: this.options.provider } : {}),
          // 让 Server 知道这个进程跑的是哪份代码：落后时由本机 Server 在它空闲后重启
          version: this.options.version ?? runningCodeVersion(),
          ...(this.options.workspace ? { workspace: this.options.workspace } : {}),
        }),
      );
    });
    socket.on("message", (raw) => this.handleEvent(JSON.parse(raw.toString()) as ServerEvent));
    socket.on("error", (error) => this.handlers.onError(error));
    socket.on("close", () => {
      const wasJoined = this.joined;
      this.joined = false;
      if (wasJoined) this.handlers.onConnectionChange?.(false);
      if (this.stopped) return;
      for (const [clientMessageId, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error("聊天室连接在确认回复前断开。"));
        this.pending.delete(clientMessageId);
      }
      // 暂停不是结束：照常重连，但不用 10 秒一次地敲门，恢复后最多晚这么久回来
      const wait = this.paused
        ? (this.options.pausedRetryMs ?? 45_000)
        : Math.min(10_000, 500 * 2 ** this.retry++);
      this.reconnectTimer = setTimeout(() => this.connect(), wait);
    });
  }

  private handleEvent(event: ServerEvent): void {
    if (event.type === "room.snapshot") {
      this.retry = 0;
      this.paused = false;
      if (!this.joined) this.handlers.onConnectionChange?.(true);
      this.joined = true;
      this.serverTracksInvocations = Array.isArray(event.invocations);
      this.serverAcceptsTrace = event.features?.includes("trace") === true;
      this.serverAcceptsApproval = event.features?.includes("approval") === true;
      this.serverAcceptsSession = event.features?.includes("session") === true;
      if (this.serverAcceptsSession && this.session) {
        this.sendRaw({ type: "agent.session", ...this.session });
      }
      this.serverAcceptsTools = event.features?.includes("tools") === true;
      // 服务端重启后成员信息里没有这一项了：连不上的情况要重新报
      if (this.serverAcceptsTools && this.hiveTools?.hive === "unavailable") {
        this.sendRaw({ type: "agent.tools", ...this.hiveTools });
      }
      if (this.typing) this.sendRaw({ type: "agent.typing", active: true });
      if (this.serverTracksInvocations) {
        for (const report of this.outbox.values()) this.sendRaw(report);
      }
      this.outbox.clear();
      // 补拉漏掉的消息要再请求服务端：服务端正好重启时会失败。不能让这个 Promise 无人接住
      // （Node 会把整个 Agent 进程崩掉，正在干的活全变成「结果未知」）；断开连接，重连后拿新快照再补一次
      const socket = this.socket;
      void Promise.resolve()
        .then(() =>
          this.handlers.onSnapshot({
            self: event.self,
            latestSeq: event.latestSeq,
            messages: event.messages,
            participants: event.participants,
            ...(event.invocations ? { invocations: event.invocations } : {}),
          }),
        )
        .catch((error: unknown) => {
          this.handlers.onError(error instanceof Error ? error : new Error(String(error)));
          if (!this.stopped && socket === this.socket) socket?.terminate();
        });
      return;
    }
    if (event.type === "agent.mentioned") {
      this.handlers.onMention(
        event.message,
        event.latestSeq,
        event.retry === true,
        event.steer === true,
        event.first === true,
        event.lead === true,
        event.model,
        event.resume === true,
        event.effort,
        event.laneKey,
      );
      return;
    }
    if (event.type === "agent.cancel") {
      this.handlers.onCancel?.(event.messageId, event.turn);
      return;
    }
    if (event.type === "approval.decision") {
      this.handlers.onApprovalDecision?.(event.requestId, event.allow, event.reason);
      return;
    }
    if (event.type === "agent.shutdown") {
      this.handlers.onShutdown?.();
      return;
    }
    if (event.type === "message.deleted") {
      this.handlers.onMessageDeleted?.(event.message);
      return;
    }
    if (event.type === "message.created" && event.message.clientMessageId) {
      const pending = this.pending.get(event.message.clientMessageId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(event.message.clientMessageId);
        pending.resolve(event.message);
      }
      return;
    }
    if (event.type === "rooms.changed") {
      this.handlers.onRoomsChanged?.(event.room);
      return;
    }
    if (event.type === "error") {
      const error = new RoomClientError(`${event.code}: ${event.message}`, event.code);
      if (event.code === "SESSION_PAUSED") this.paused = true;
      const first = this.pending.entries().next().value as [string, PendingSend] | undefined;
      if (first) {
        const [clientMessageId, pending] = first;
        clearTimeout(pending.timer);
        this.pending.delete(clientMessageId);
        pending.reject(error);
      }
      this.handlers.onError(error);
    }
  }

  private sendRaw(event: object): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(event));
  }
}
