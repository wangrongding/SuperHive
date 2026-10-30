import type { ServerEvent } from "@ai-hive/protocol";
import WebSocket from "ws";

/** 测试用的 WebSocket 客户端：缓存收到的事件，按条件等待 */
export class Peer {
  readonly socket: WebSocket;
  readonly events: ServerEvent[] = [];
  private readonly listeners = new Set<() => void>();
  closed = false;

  private constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.on("message", (raw) => {
      this.events.push(JSON.parse(raw.toString()) as ServerEvent);
      for (const listener of this.listeners) listener();
    });
    this.socket.on("close", () => {
      this.closed = true;
      for (const listener of this.listeners) listener();
    });
  }

  static async connect(url: string): Promise<Peer> {
    const peer = new Peer(url);
    await new Promise<void>((resolve, reject) => {
      peer.socket.once("open", resolve);
      peer.socket.once("error", reject);
    });
    return peer;
  }

  send(event: object): void {
    this.socket.send(JSON.stringify(event));
  }

  async next(predicate: (event: ServerEvent) => boolean, timeoutMs = 1_500): Promise<ServerEvent> {
    const index = this.events.findIndex(predicate);
    if (index >= 0) return this.events.splice(index, 1)[0]!;
    return new Promise<ServerEvent>((resolve, reject) => {
      const check = () => {
        const found = this.events.findIndex(predicate);
        if (found < 0) return;
        cleanup();
        resolve(this.events.splice(found, 1)[0]!);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out waiting for WebSocket event."));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.listeners.delete(check);
      };
      this.listeners.add(check);
    });
  }

  async waitClosed(timeoutMs = 1_500): Promise<void> {
    if (this.closed) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("socket did not close")), timeoutMs);
      this.socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
