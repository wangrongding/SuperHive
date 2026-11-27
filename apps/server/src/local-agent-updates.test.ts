import { describe, expect, it, vi } from "vitest";
import type { AgentCodeVersion } from "@superhive/protocol";
import { HiveDatabase } from "./database.js";
import {
  AUTO_RESTART_COOLDOWN_MS,
  LocalAgentSupervisor,
  type ChildHandle,
  type LocalAgentSupervisorOptions,
  type SpawnAgent,
} from "./local-agents.js";

/** 收到 SIGTERM 就退出的假进程 */
class FakeChild implements ChildHandle {
  readonly signals: NodeJS.Signals[] = [];
  private exitListeners: Array<(code: number | null) => void> = [];
  constructor(readonly pid: number) {}
  onOutput() {}
  onExit(listener: (code: number | null) => void) {
    this.exitListeners.push(listener);
  }
  kill(signal: NodeJS.Signals) {
    this.signals.push(signal);
    for (const listener of this.exitListeners) listener(0);
    this.exitListeners = [];
  }
}

const cli = { command: "/usr/bin/node", args: ["/repo/packages/superhive/src/cli.ts"] };
const flush = () => new Promise((resolve) => setImmediate(resolve));

const v1: AgentCodeVersion = { package: "0.3.1", commit: "a".repeat(40), fingerprint: "old.tree" };
const v2: AgentCodeVersion = { package: "0.3.1", commit: "b".repeat(40), fingerprint: "new.tree" };

/**
 * 一个本机 Agent 在线、上报 running 版本；current 是 Server 现在看到的版本，busy 是跨房间忙的名字。
 * 定时器只记下不触发（测试直接调 checkUpdates），时间手动推进。
 */
function setup(extra: Partial<LocalAgentSupervisorOptions> = {}) {
  const database = new HiveDatabase(":memory:");
  const children: FakeChild[] = [];
  const spawn = vi.fn<SpawnAgent>(() => {
    const child = new FakeChild(2000 + children.length);
    children.push(child);
    return child;
  });
  const state = {
    current: v2 as AgentCodeVersion | undefined,
    running: new Map<string, AgentCodeVersion | undefined>(),
    busy: new Set<string>(),
    online: true,
    now: 1_000_000,
  };
  const supervisor = new LocalAgentSupervisor({
    database,
    cli,
    serverUrl: "http://127.0.0.1:8787",
    joinToken: "join-token",
    isAgentOnline: () => state.online,
    isNameInUse: () => false,
    spawn,
    probe: async () => ({ installed: true, version: null }),
    setTimer: () => ({ cancel: () => undefined }),
    now: () => state.now,
    runningVersion: (name) => state.running.get(name),
    busyAgentNames: () => state.busy,
    currentVersion: async () => state.current,
    ...extra,
  });
  const agent = supervisor.create({ provider: "omp", name: "rd-omp", access: "read-only" });
  state.running.set("rd-omp", v1);
  // 让缓存的当前版本过期，下次检查重新读
  const tick = (ms = 11_000) => (state.now += ms);
  return { database, supervisor, children, spawn, state, agent, tick };
}

describe("local agent auto-update", () => {
  it("reports cross-room busy, the running version and whether it is outdated", async () => {
    const { supervisor, state, agent } = setup();
    state.busy.add("rd-omp");
    await supervisor.checkUpdates();
    const view = supervisor.get(agent.id);
    expect(view).toMatchObject({ busy: true, version: v1, outdated: true, restartWhenIdle: true });
    // 跑的就是当前代码：不旧，也不安排重启
    state.running.set("rd-omp", v2);
    state.busy.clear();
    expect(supervisor.get(agent.id)).toMatchObject({ busy: false, version: v2 });
    expect(supervisor.get(agent.id).outdated).toBeUndefined();
    expect(supervisor.get(agent.id).restartWhenIdle).toBeUndefined();
    await supervisor.shutdown();
  });

  it("reports since when an agent has been outdated, restarting the clock when the current code changes", async () => {
    const { supervisor, state, agent, tick } = setup();
    state.busy.add("rd-omp");
    const first = state.now;
    await supervisor.checkUpdates();
    expect(supervisor.get(agent.id).outdatedSince).toBe(new Date(first).toISOString());
    // 一直忙着：时间不跟着往后挪
    tick(60_000);
    await supervisor.checkUpdates();
    expect(supervisor.get(agent.id).outdatedSince).toBe(new Date(first).toISOString());
    // 当前代码又换了：从现在重新计
    state.current = { ...v2, commit: "c".repeat(40), fingerprint: "newer.tree" };
    tick();
    const second = state.now;
    await supervisor.checkUpdates();
    expect(supervisor.get(agent.id).outdatedSince).toBe(new Date(second).toISOString());
    // 跟上了：不再报
    state.running.set("rd-omp", state.current);
    expect(supervisor.get(agent.id).outdatedSince).toBeUndefined();
    await supervisor.shutdown();
  });

  it("treats an online agent that reports no version as outdated, but not one that is still starting", async () => {
    const { supervisor, state, agent } = setup();
    state.busy.add("rd-omp");
    await supervisor.checkUpdates();
    state.running.set("rd-omp", undefined);
    expect(supervisor.get(agent.id).outdated).toBe(true);
    state.online = false;
    expect(supervisor.get(agent.id).outdated).toBeUndefined();
    await supervisor.shutdown();
  });

  it("does not judge anything when the current version is unknown", async () => {
    const { supervisor, state, agent, spawn } = setup();
    state.current = undefined;
    await supervisor.checkUpdates();
    expect(supervisor.get(agent.id).outdated).toBeUndefined();
    expect(spawn).toHaveBeenCalledTimes(1);
    await supervisor.shutdown();
  });

  it("restarts an outdated agent only once it is idle", async () => {
    const { supervisor, state, children, spawn, tick } = setup();
    state.busy.add("rd-omp");
    await supervisor.checkUpdates();
    await flush();
    // 忙：跳过，正在做的任务不被打断
    expect(children[0]!.signals).toEqual([]);
    expect(spawn).toHaveBeenCalledTimes(1);

    state.busy.clear();
    tick();
    await supervisor.checkUpdates();
    await flush();
    expect(children[0]!.signals).toEqual(["SIGTERM"]);
    expect(spawn).toHaveBeenCalledTimes(2);
    await supervisor.shutdown();
  });

  it("auto-restarts once per target version and keeps a cooldown between auto-restarts", async () => {
    const { supervisor, state, spawn, tick, agent } = setup();
    await supervisor.checkUpdates();
    await flush();
    expect(spawn).toHaveBeenCalledTimes(2);

    // 重启后仍上报旧版本（例如版本判断出了岔子）：同一个目标不再重启
    tick();
    await supervisor.checkUpdates();
    await flush();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(supervisor.get(agent.id).outdated).toBe(true);
    expect(supervisor.get(agent.id).restartWhenIdle).toBeUndefined();

    // 又合入了新代码：在冷却期内先不动
    state.current = { ...v2, fingerprint: "newer.tree" };
    tick();
    await supervisor.checkUpdates();
    await flush();
    expect(spawn).toHaveBeenCalledTimes(2);

    // 过了冷却期再重启
    tick(AUTO_RESTART_COOLDOWN_MS);
    await supervisor.checkUpdates();
    await flush();
    expect(spawn).toHaveBeenCalledTimes(3);
    await supervisor.shutdown();
  });

  it("does nothing automatic when auto-update is turned off", async () => {
    const { supervisor, spawn, agent } = setup();
    expect(supervisor.autoUpdateEnabled()).toBe(true);
    supervisor.setAutoUpdate(false);
    await supervisor.checkUpdates();
    await flush();
    expect(spawn).toHaveBeenCalledTimes(1);
    // 仍标出旧版本，只是不安排自动重启
    expect(supervisor.get(agent.id)).toMatchObject({ outdated: true });
    expect(supervisor.get(agent.id).restartWhenIdle).toBeUndefined();
    await supervisor.shutdown();
  });

  it("restarts only one outdated agent per check so they do not all relaunch at once", async () => {
    const { supervisor, state, spawn, tick } = setup();
    supervisor.create({ provider: "omp", name: "rd-omp2", access: "read-only" });
    state.running.set("rd-omp2", v1);
    await supervisor.checkUpdates();
    await flush();
    expect(spawn).toHaveBeenCalledTimes(3);
    tick();
    await supervisor.checkUpdates();
    await flush();
    expect(spawn).toHaveBeenCalledTimes(4);
    await supervisor.shutdown();
  });

  it("defers a manual restart while busy and runs it once idle; restart now does not wait", async () => {
    const { supervisor, state, children, spawn, agent } = setup({
      // 这里只看手动重启：不让自动更新插手
      runningVersion: () => v2,
    });
    state.busy.add("rd-omp");
    const deferred = await supervisor.restartWhenIdle(agent.id);
    expect(deferred.restartWhenIdle).toBe(true);
    expect(children[0]!.signals).toEqual([]);
    await supervisor.checkUpdates();
    await flush();
    expect(spawn).toHaveBeenCalledTimes(1);

    state.busy.clear();
    await supervisor.checkUpdates();
    await flush();
    expect(children[0]!.signals).toEqual(["SIGTERM"]);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(supervisor.get(agent.id).restartWhenIdle).toBeUndefined();

    // 空闲时「重启」直接重启
    await supervisor.restartWhenIdle(agent.id);
    expect(spawn).toHaveBeenCalledTimes(3);
    // 忙时「立即重启」不等
    state.busy.add("rd-omp");
    await supervisor.restart(agent.id);
    expect(spawn).toHaveBeenCalledTimes(4);
    await supervisor.shutdown();
  });

  it("stopping drops a pending restart", async () => {
    const { supervisor, state, spawn, agent } = setup({ runningVersion: () => v2 });
    state.busy.add("rd-omp");
    await supervisor.restartWhenIdle(agent.id);
    await supervisor.stop(agent.id);
    state.busy.clear();
    await supervisor.checkUpdates();
    await flush();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(supervisor.get(agent.id).status).toBe("stopped");
    await supervisor.shutdown();
  });

  it("notifies when the current version changes so member badges refresh", async () => {
    const onCurrentVersionChange = vi.fn();
    const { supervisor, state, tick } = setup({ onCurrentVersionChange });
    await supervisor.checkUpdates();
    expect(onCurrentVersionChange).not.toHaveBeenCalled();
    state.current = { ...v2, fingerprint: "newer.tree" };
    tick();
    supervisor.currentCodeVersion();
    await flush();
    expect(onCurrentVersionChange).toHaveBeenCalledTimes(1);
    await supervisor.shutdown();
  });
});

describe("busyAgentNames", () => {
  it("counts queued, running, cancelling and unfinished waiting_human invocations across rooms", () => {
    const database = new HiveDatabase(":memory:");
    const statuses = {
      "Busy-A": "running",
      "busy-b": "queued",
      stopping: "cancelling",
      asking: "waiting_human",
      asked: "waiting_human",
      done: "completed",
      held: "blocked",
    } as const;
    Object.entries(statuses).forEach(([name, status], index) => {
      const roomId = index % 2 ? "b" : "a";
      database.ensureRoom(roomId, "rd");
      const human = database.upsertParticipant({ roomId, username: "rd", type: "human" });
      const agent = database.upsertParticipant({ roomId, username: name, type: "agent" });
      const { message } = database.createMessage(human, {
        content: `@${name}`,
        clientMessageId: `m-${name}`,
      });
      const { invocation } = database.createInvocation({ message, agent, status: "queued" });
      database.updateInvocation(invocation.id, {
        status,
        // 提问后本轮已结束：在等人回答，但进程空着
        ...(name === "asked" ? { finishedAt: new Date().toISOString() } : {}),
      });
    });
    expect([...database.busyAgentNames()].sort()).toEqual([
      "asking",
      "busy-a",
      "busy-b",
      "stopping",
    ]);
    database.close();
  });
});

describe("local agent auto-update over the app", () => {
  it("marks outdated agents in the member list, lists busy/version, and restarts when idle by default", async () => {
    const { buildApp } = await import("./app.js");
    const { Peer } = await import("./test-peer.js");
    const children: FakeChild[] = [];
    const app = await buildApp({
      databasePath: ":memory:",
      token: "join-token",
      staticDir: "/definitely-not-present",
      localAgents: {
        cli,
        serverUrl: "http://127.0.0.1:8787",
        spawn: () => {
          const child = new FakeChild(3000 + children.length);
          children.push(child);
          return child;
        },
        probe: async () => ({ installed: true, version: null }),
        currentVersion: async () => v2,
      },
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const peers: Array<Awaited<ReturnType<typeof Peer.connect>>> = [];
    try {
      const port = (app.server.address() as { port: number }).port;
      const session = (await app.inject({ method: "GET", url: "/api/local/session" })).json() as {
        ownerToken: string;
      };
      const owner = { "x-hive-owner": session.ownerToken };
      const created = (
        await app.inject({
          method: "POST",
          url: "/api/local/agents",
          headers: owner,
          payload: { provider: "omp", name: "rd-omp", access: "read-only" },
        })
      ).json() as { agent: { id: string } };
      const id = created.agent.id;

      // 本机 Agent（跑旧代码）和别处的一个 Agent（包版本更低）、一个人上线
      const connect = async (join: object) => {
        const peer = await Peer.connect(`ws://127.0.0.1:${port}/ws`);
        peers.push(peer);
        peer.send({ type: "participant.join", roomId: "general", token: "join-token", ...join });
        await peer.next((event) => event.type === "room.snapshot");
        return peer;
      };
      await connect({ username: "rd-omp", participantType: "agent", version: v1 });
      await connect({
        username: "remote",
        participantType: "agent",
        version: { package: "0.2.0" },
      });
      await connect({ username: "rd", participantType: "human" });

      const listed = async () =>
        (await app.inject({ method: "GET", url: "/api/local/agents", headers: owner })).json() as {
          agents: Array<Record<string, unknown>>;
          autoUpdate: boolean;
          currentVersion?: AgentCodeVersion;
        };
      // 第一次列表触发计算当前版本
      await listed();
      await flush();
      const body = await listed();
      expect(body.autoUpdate).toBe(true);
      expect(body.currentVersion).toEqual(v2);
      expect(body.agents[0]).toMatchObject({ busy: false, version: v1, outdated: true });

      const members = (
        await app.inject({
          method: "GET",
          url: "/api/rooms/general/participants",
          headers: { authorization: "Bearer join-token" },
        })
      ).json() as { participants: Array<{ username: string; outdated?: boolean }> };
      const byName = new Map(members.participants.map((item) => [item.username, item]));
      expect(byName.get("rd-omp")).toMatchObject({ outdated: true, version: v1 });
      expect(byName.get("remote")).toMatchObject({ outdated: true });
      expect(byName.get("rd")?.outdated).toBeUndefined();

      // 关掉自动更新
      const off = await app.inject({
        method: "PUT",
        url: "/api/local/agents/auto-update",
        headers: owner,
        payload: { enabled: false },
      });
      expect(off.json()).toEqual({ autoUpdate: false });
      expect((await listed()).autoUpdate).toBe(false);

      // 默认「重启」：空闲时立即重启；when 不对时拒绝
      const restarted = await app.inject({
        method: "POST",
        url: `/api/local/agents/${id}/restart`,
        headers: owner,
      });
      expect(restarted.statusCode).toBe(200);
      expect(children).toHaveLength(2);
      const invalid = await app.inject({
        method: "POST",
        url: `/api/local/agents/${id}/restart`,
        headers: owner,
        payload: { when: "later" },
      });
      expect(invalid.statusCode).toBe(400);
      const now = await app.inject({
        method: "POST",
        url: `/api/local/agents/${id}/restart`,
        headers: owner,
        payload: { when: "now" },
      });
      expect(now.statusCode).toBe(200);
      expect(children).toHaveLength(3);
    } finally {
      for (const peer of peers) peer.socket.close();
      await app.close();
    }
  });
});
