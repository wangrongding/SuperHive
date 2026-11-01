import type { RoomSummary } from "./hive-protocol.js";

export type ManagedStack = {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** 当前回合与排队都处理完时返回；重建前等它，避免打断正在执行的任务 */
  whenIdle?(): Promise<void>;
};

export type StackHooks = {
  onRoomsChanged: (room: RoomSummary) => void;
  onArchived: () => void;
};

export type AgentManagerOptions = {
  listRooms: () => Promise<RoomSummary[]>;
  createStack: (room: RoomSummary, hooks: StackHooks) => ManagedStack;
  log?: (message: string) => void;
  reconcileIntervalMs?: number;
};

type StackEntry = {
  stack: ManagedStack;
  starting: Promise<boolean>;
  /** 建立这个房间时的工作区；房间工作区变了就在空闲后重建 */
  workspace: string | undefined;
  restarting?: boolean;
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
    await Promise.all(rooms.map((room) => this.spawn(room)));
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

  private spawn(room: RoomSummary): Promise<void> {
    const roomId = room.id;
    if (this.stopping || this.stacks.has(roomId)) return Promise.resolve();
    const stack = this.options.createStack(room, {
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
    this.stacks.set(roomId, { stack, starting, workspace: room.workspace });
    return starting.then(() => undefined);
  }

  /** 房间工作区变了：等这个房间空闲后重建（新的工作目录、新的 Provider 会话），其他房间不受影响 */
  private async restart(room: RoomSummary): Promise<void> {
    const entry = this.stacks.get(room.id);
    if (!entry || entry.restarting) return;
    entry.restarting = true;
    await entry.starting;
    await entry.stack.whenIdle?.();
    if (this.stopping || this.stacks.get(room.id) !== entry) return;
    this.stacks.delete(room.id);
    await entry.stack.stop().catch(() => undefined);
    this.log(`[hive] 房间 #${room.id} 的工作区已变更，重新加入`);
    await this.spawn(room);
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
    else if (this.stacks.has(room.id)) this.maybeRestart(room);
    else void this.spawn(room);
  }

  private maybeRestart(room: RoomSummary): void {
    const entry = this.stacks.get(room.id);
    if (entry && (entry.workspace ?? "") !== (room.workspace ?? "")) void this.restart(room);
  }

  private async reconcile(): Promise<void> {
    if (this.stopping || this.reconciling) return;
    this.reconciling = true;
    try {
      const rooms = (await this.options.listRooms()).filter((room) => !room.archivedAt);
      const active = new Set(rooms.map((room) => room.id));
      for (const room of rooms) {
        if (!this.stacks.has(room.id)) void this.spawn(room);
        else this.maybeRestart(room);
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
