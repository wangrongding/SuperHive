import type {
  ChatMessage,
  MessagesResponse,
  Participant,
  RoomSummary,
  ServerEvent,
} from "./hive-protocol.js";
import WebSocket from "ws";

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
};

export type Snapshot = {
  self: Participant;
  latestSeq: number;
  messages: ChatMessage[];
};

export type RoomClientHandlers = {
  onSnapshot: (snapshot: Snapshot) => void | Promise<void>;
  onMention: (message: ChatMessage, latestSeq: number) => void;
  onRoomsChanged?: (room: RoomSummary) => void;
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
    this.sendRaw({ type: "agent.typing", active });
  }

  async fetchInstructions(): Promise<string> {
    const response = await fetch(`${this.options.serverUrl}/agent.md`);
    if (!response.ok) throw new Error(`无法获取服务器 Agent 规则 (${response.status})`);
    return response.text();
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
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${this.options.token}` },
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
        }),
      );
    });
    socket.on("message", (raw) => this.handleEvent(JSON.parse(raw.toString()) as ServerEvent));
    socket.on("error", (error) => this.handlers.onError(error));
    socket.on("close", () => {
      if (this.stopped) return;
      for (const [clientMessageId, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error("聊天室连接在确认回复前断开。"));
        this.pending.delete(clientMessageId);
      }
      const wait = Math.min(10_000, 500 * 2 ** this.retry++);
      this.reconnectTimer = setTimeout(() => this.connect(), wait);
    });
  }

  private handleEvent(event: ServerEvent): void {
    if (event.type === "room.snapshot") {
      this.retry = 0;
      void this.handlers.onSnapshot({
        self: event.self,
        latestSeq: event.latestSeq,
        messages: event.messages,
      });
      return;
    }
    if (event.type === "agent.mentioned") {
      this.handlers.onMention(event.message, event.latestSeq);
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
