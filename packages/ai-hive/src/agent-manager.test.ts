import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager, type ManagedStack, type StackHooks } from "./agent-manager.js";
import type { RoomSummary } from "./hive-protocol.js";

function room(id: string, extra: Partial<RoomSummary> = {}): RoomSummary {
  return {
    id,
    name: id,
    createdAt: "2026-07-18T00:00:00.000Z",
    onlineCount: 0,
    latestSeq: 0,
    ...extra,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type FakeStack = ManagedStack & {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
};

function fakeStack(overrides: Partial<FakeStack> = {}): FakeStack {
  return {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("AgentManager", () => {
  const stacks = new Map<string, FakeStack>();
  const hooksByRoom = new Map<string, StackHooks>();
  let log: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    stacks.clear();
    hooksByRoom.clear();
    log = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function manager(
    rooms: RoomSummary[] | (() => Promise<RoomSummary[]>),
    options: { reconcileIntervalMs?: number; makeStack?: (roomId: string) => FakeStack } = {},
  ): { manager: AgentManager; createStack: ReturnType<typeof vi.fn> } {
    const listRooms = typeof rooms === "function" ? rooms : async () => rooms;
    const createStack = vi.fn((roomId: string, hooks: StackHooks): ManagedStack => {
      const stack = options.makeStack?.(roomId) ?? fakeStack();
      stacks.set(roomId, stack);
      hooksByRoom.set(roomId, hooks);
      return stack;
    });
    return {
      manager: new AgentManager({
        listRooms,
        createStack,
        log,
        reconcileIntervalMs: options.reconcileIntervalMs ?? 0,
      }),
      createStack,
    };
  }

  it("joins every non-archived room at startup", async () => {
    const { manager: m, createStack } = manager([
      room("general"),
      room("dev"),
      room("old", { archivedAt: "2026-07-18T01:00:00.000Z" }),
    ]);
    const joined = await m.start();
    expect(joined.sort()).toEqual(["dev", "general"]);
    expect(createStack).toHaveBeenCalledTimes(2);
    expect(stacks.get("general")!.start).toHaveBeenCalledTimes(1);
    expect(stacks.get("dev")!.start).toHaveBeenCalledTimes(1);
  });

  it("spawns a new room once even when rooms.changed arrives from every connection", async () => {
    const { manager: m, createStack } = manager([room("general")]);
    await m.start();
    const hooks = hooksByRoom.get("general")!;
    hooks.onRoomsChanged(room("fresh"));
    hooks.onRoomsChanged(room("fresh"));
    hooks.onRoomsChanged(room("fresh"));
    await Promise.resolve();
    expect(createStack).toHaveBeenCalledTimes(2);
    expect(stacks.get("fresh")!.start).toHaveBeenCalledTimes(1);
  });

  it("stops the stack when its room is archived and ignores repeats; respawns on restore", async () => {
    const { manager: m, createStack } = manager([room("general"), room("dev")]);
    await m.start();
    const hooks = hooksByRoom.get("general")!;
    const archived = room("dev", { archivedAt: "2026-07-18T01:00:00.000Z" });
    hooks.onRoomsChanged(archived);
    hooks.onRoomsChanged(archived);
    await vi.waitFor(() => expect(stacks.get("dev")!.stop).toHaveBeenCalledTimes(1));

    hooks.onRoomsChanged(room("general", { name: "改名" }));
    expect(createStack).toHaveBeenCalledTimes(2);

    hooks.onRoomsChanged(room("dev"));
    await Promise.resolve();
    expect(createStack).toHaveBeenCalledTimes(3);
  });

  it("keeps other rooms alive when one stack fails to start", async () => {
    const { manager: m } = manager([room("general"), room("broken")], {
      makeStack: (roomId) =>
        roomId === "broken"
          ? fakeStack({ start: vi.fn(async () => Promise.reject(new Error("join denied"))) })
          : fakeStack(),
    });
    const joined = await m.start();
    expect(joined).toEqual(["general"]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("join denied"));
  });

  it("throws when no room can be joined", async () => {
    const { manager: m } = manager([room("general")], {
      makeStack: () => fakeStack({ start: vi.fn(async () => Promise.reject(new Error("nope"))) }),
    });
    await expect(m.start()).rejects.toThrow(/未能加入任何房间/);
  });

  it("waits for a pending start before stopping an archived room", async () => {
    const gate = deferred<void>();
    const slow = fakeStack({ start: vi.fn(() => gate.promise) });
    const { manager: m } = manager([room("general")], {
      makeStack: () => slow,
    });
    const starting = m.start();
    starting.catch(() => undefined);
    await vi.waitFor(() => expect(hooksByRoom.has("general")).toBe(true));
    hooksByRoom
      .get("general")!
      .onRoomsChanged(room("general", { archivedAt: "2026-07-18T01:00:00.000Z" }));
    await Promise.resolve();
    expect(slow.stop).not.toHaveBeenCalled();
    gate.resolve();
    await vi.waitFor(() => expect(slow.stop).toHaveBeenCalledTimes(1));
    await expect(starting).rejects.toThrow(/未能加入任何房间/);
  });

  it("stops every stack on shutdown even when one stop rejects", async () => {
    const { manager: m } = manager([room("general"), room("dev")], {
      makeStack: (roomId) =>
        roomId === "dev"
          ? fakeStack({ stop: vi.fn(async () => Promise.reject(new Error("boom"))) })
          : fakeStack(),
    });
    await m.start();
    await m.stop();
    expect(stacks.get("general")!.stop).toHaveBeenCalledTimes(1);
    expect(stacks.get("dev")!.stop).toHaveBeenCalledTimes(1);
    hooksByRoom.get("general")!.onRoomsChanged(room("late"));
    expect(stacks.has("late")).toBe(false);
  });

  it("reconciles missed room changes through polling", async () => {
    vi.useFakeTimers();
    let listing: RoomSummary[] = [room("general"), room("dev")];
    const { manager: m, createStack } = manager(async () => listing, {
      reconcileIntervalMs: 1_000,
    });
    await m.start();
    expect(createStack).toHaveBeenCalledTimes(2);

    listing = [room("general"), room("fresh")];
    await vi.advanceTimersByTimeAsync(1_000);
    expect(createStack).toHaveBeenCalledTimes(3);
    expect(stacks.get("fresh")!.start).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(stacks.get("dev")!.stop).toHaveBeenCalledTimes(1));

    await m.stop();
  });
});
