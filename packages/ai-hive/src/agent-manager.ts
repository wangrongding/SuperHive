import type { RoomSummary } from "./hive-protocol.js";

export type ManagedStack = {
  start(): Promise<void>;
  stop(): Promise<void>;
};

export type StackHooks = {
  onRoomsChanged: (room: RoomSummary) => void;
  onArchived: () => void;
};

export type AgentManagerOptions = {
  listRooms: () => Promise<RoomSummary[]>;
  createStack: (roomId: string, hooks: StackHooks) => ManagedStack;
  log?: (message: string) => void;
  reconcileIntervalMs?: number;
};

type StackEntry = {
  stack: ManagedStack;
  starting: Promise<boolean>;
};

export class AgentManager {
  private readonly stacks = new Map<string, StackEntry>();
  private readonly log: (message: string) => void;
  private readonly reconcileIntervalMs: number;
  private stopping = false;
  private reconciling = false;
  private timer?: NodeJS.Timeout;

  constructor(private readonly options: AgentManagerOptions) {
    this.log = options.log ?? console.log;
    this.reconcileIntervalMs = options.reconcileIntervalMs ?? 60_000;
  }

  async start(): Promise<string[]> {
    const rooms = (await this.options.listRooms()).filter((room) => !room.archivedAt);
    await Promise.all(rooms.map((room) => this.spawn(room.id)));
    const joined = [...this.stacks.keys()];
    if (joined.length === 0) throw new Error("未能加入任何房间。");
    if (this.reconcileIntervalMs > 0) {
      this.timer = setInterval(() => void this.reconcile(), this.reconcileIntervalMs);
      this.timer.unref();
    }
    return joined;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    const entries = [...this.stacks.values()];
    this.stacks.clear();
    await Promise.allSettled(
      entries.map(async (entry) => {
        await entry.starting;
        await entry.stack.stop();
      }),
    );
  }

  private spawn(roomId: string): Promise<void> {
    if (this.stopping || this.stacks.has(roomId)) return Promise.resolve();
    const stack = this.options.createStack(roomId, {
      onRoomsChanged: (room) => this.handleRoomsChanged(room),
      onArchived: () => void this.remove(roomId, "已归档"),
    });
    const starting = stack.start().then(
      () => {
        this.log(`[hive] 已加入房间 #${roomId}`);
        return true;
      },
      (error: unknown) => {
        this.stacks.delete(roomId);
        this.log(
          `[hive] 加入房间 #${roomId} 失败：${error instanceof Error ? error.message : String(error)}（其他房间不受影响）`,
        );
        return false;
      },
    );
    this.stacks.set(roomId, { stack, starting });
    return starting.then(() => undefined);
  }

  private async remove(roomId: string, reason: string): Promise<void> {
    const entry = this.stacks.get(roomId);
    if (!entry) return;
    this.stacks.delete(roomId);
    await entry.starting;
    await entry.stack.stop().catch((error: unknown) => {
      this.log(
        `[hive] 停止房间 #${roomId} 时出错：${error instanceof Error ? error.message : String(error)}`,
      );
    });
    this.log(`[hive] 已离开房间 #${roomId}（${reason}）`);
  }

  private handleRoomsChanged(room: RoomSummary): void {
    if (this.stopping) return;
    if (room.archivedAt) void this.remove(room.id, "已归档");
    else void this.spawn(room.id);
  }

  private async reconcile(): Promise<void> {
    if (this.stopping || this.reconciling) return;
    this.reconciling = true;
    try {
      const rooms = (await this.options.listRooms()).filter((room) => !room.archivedAt);
      const active = new Set(rooms.map((room) => room.id));
      for (const room of rooms) {
        if (!this.stacks.has(room.id)) void this.spawn(room.id);
      }
      for (const roomId of this.stacks.keys()) {
        if (!active.has(roomId)) void this.remove(roomId, "已归档");
      }
    } catch (error) {
      this.log(
        `[hive] 房间列表对账失败：${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.reconciling = false;
    }
  }
}
