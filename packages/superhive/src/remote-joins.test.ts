import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addServerToNoProxy } from "./no-proxy.js";
import { formatJoins, leaveOne } from "./remote-join-command.js";
import { RemoteJoinTracker, relaunchArgs } from "./remote-join-tracker.js";
import {
  STALE_MS,
  findRecord,
  leaveRemoteRoom,
  listRemoteJoins,
  readRecord,
  readToken,
  remoteJoinId,
  remoteJoinsDir,
  requestStop,
  stopRemoteJoin,
  stopRequested,
  viewOf,
  writeRecord,
  type RemoteJoinRecord,
} from "./remote-joins.js";

const here = path.dirname(fileURLToPath(import.meta.url));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "hive-remote-joins-"));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

function record(patch: Partial<RemoteJoinRecord> = {}): RemoteJoinRecord {
  const now = new Date().toISOString();
  const base: RemoteJoinRecord = {
    version: 1,
    id: remoteJoinId("http://10.0.0.2:8787", "kx001", "caibao-claude"),
    server: "http://10.0.0.2:8787",
    roomId: "kx001",
    name: "caibao-claude",
    runtime: "claude",
    access: "read-only",
    cwd: null,
    model: null,
    pid: process.pid,
    background: true,
    startedAt: now,
    updatedAt: now,
    stoppedAt: null,
    logFile: null,
    rooms: { kx001: true },
    launch: { command: "node", args: ["cli.js", "join"], cwd: "/" },
    lastError: null,
  };
  return { ...base, ...patch };
}

describe("two copies", () => {
  it("apps/server and packages/superhive ship the same remote-joins.ts", () => {
    const strip = (text: string) =>
      text
        .split("\n")
        .filter((line) => !line.includes("remote-joins.test.ts 校验两份一致"))
        .join("\n");
    const mine = readFileSync(path.join(here, "remote-joins.ts"), "utf8");
    const server = readFileSync(
      path.join(here, "../../../apps/server/src/remote-joins.ts"),
      "utf8",
    );
    expect(strip(server)).toBe(strip(mine));
  });
});

describe("remoteJoinId / remoteJoinsDir", () => {
  it("is stable across trailing slashes and letter case", () => {
    const id = remoteJoinId("http://10.0.0.2:8787", "kx001", "Caibao");
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(remoteJoinId("HTTP://10.0.0.2:8787/", "kx001", "caibao")).toBe(id);
    expect(remoteJoinId("http://10.0.0.2:8787", null, "caibao")).not.toBe(id);
    expect(remoteJoinId("http://10.0.0.3:8787", "kx001", "caibao")).not.toBe(id);
  });

  it("defaults under ~/.superhive and can be overridden", () => {
    expect(remoteJoinsDir({}, "/home/a")).toBe(path.join("/home/a", ".superhive", "remote-joins"));
    expect(remoteJoinsDir({ HIVE_REMOTE_JOINS_DIR: "/tmp/x" }, "/home/a")).toBe(
      path.resolve("/tmp/x"),
    );
  });
});

describe("viewOf", () => {
  it("online when the process is alive, the heartbeat is fresh and a room is connected", () => {
    const view = viewOf(record(), { isAlive: () => true });
    expect(view.status).toBe("online");
    expect(view.pid).toBe(process.pid);
    expect(view.canRestart).toBe(true);
    expect(view.rooms).toEqual([{ roomId: "kx001", connected: true }]);
  });

  it("connecting while no room is connected yet", () => {
    expect(viewOf(record({ rooms: {} }), { isAlive: () => true }).status).toBe("connecting");
  });

  it("stopped when the process is gone or the heartbeat is stale (pid may be reused)", () => {
    expect(viewOf(record(), { isAlive: () => false }).status).toBe("stopped");
    const stale = record({ updatedAt: new Date(Date.now() - STALE_MS - 1_000).toISOString() });
    const view = viewOf(stale, { isAlive: () => true });
    expect(view.status).toBe("stopped");
    expect(view.pid).toBeNull();
    expect(view.rooms[0]!.connected).toBe(false);
    expect(view.stoppedAt).toBe(stale.updatedAt);
  });
});

describe("findRecord", () => {
  it("finds by name or id prefix and asks for the id when names collide", () => {
    const a = record();
    const b = record({
      id: remoteJoinId("http://10.0.0.9:8787", null, "caibao-claude"),
      server: "http://10.0.0.9:8787",
      roomId: null,
    });
    writeRecord(dir, a);
    expect(findRecord(dir, "CAIBAO-claude")?.id).toBe(a.id);
    writeRecord(dir, b);
    expect(() => findRecord(dir, "caibao-claude")).toThrow(/改用 id/);
    expect(findRecord(dir, b.id.slice(0, 6))?.id).toBe(b.id);
    expect(findRecord(dir, "nobody")).toBeUndefined();
  });

  it("ignores files that aren't records", () => {
    writeFileSync(path.join(dir, "zzzz.json"), "{}");
    writeFileSync(path.join(dir, "0123456789abcdef.json"), "not json");
    expect(listRemoteJoins(dir)).toEqual([]);
  });
});

describe("RemoteJoinTracker", () => {
  const input = () => ({
    dir,
    server: "http://10.0.0.2:8787",
    roomId: null,
    name: "win-claude",
    runtime: "claude",
    access: "workspace",
    cwd: "C:/work",
    model: null,
    token: "secret-token",
    background: true,
    logFile: "/tmp/x.log",
    launch: { command: "node", args: ["cli.js", "join"], cwd: "/" },
  });

  it("registers, tracks rooms, heartbeats and marks itself stopped", () => {
    vi.useFakeTimers();
    const tracker = new RemoteJoinTracker(input());
    const onStop = vi.fn();
    tracker.start(onStop);
    const saved = readRecord(dir, tracker.id)!;
    expect(saved.pid).toBe(process.pid);
    expect(saved.background).toBe(true);
    // token 单独存（0600），不进 json，也不经接口返回
    expect(JSON.stringify(saved)).not.toContain("secret-token");
    expect(readToken(dir, tracker.id)).toBe("secret-token");
    if (process.platform !== "win32") {
      expect(statSync(path.join(dir, `${tracker.id}.token`)).mode & 0o777).toBe(0o600);
    }

    tracker.setRoom("api", true);
    tracker.setRoom("web", false);
    expect(viewOf(readRecord(dir, tracker.id)!).status).toBe("online");
    tracker.removeRoom("api");
    expect(viewOf(readRecord(dir, tracker.id)!).status).toBe("connecting");

    requestStop(dir, tracker.id);
    vi.advanceTimersByTime(1_100);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(stopRequested(dir, tracker.id)).toBe(false);

    tracker.noteError("连不上");
    tracker.markStopped(true);
    const stopped = readRecord(dir, tracker.id)!;
    expect(stopped.pid).toBeNull();
    expect(stopped.stoppedAt).not.toBeNull();
    expect(stopped.lastError).toBe("连不上");
    expect(stopped.rooms).toEqual({ web: false });
  });

  it("refuses to run twice under the same name and leaves a newer process's record alone", () => {
    const first = new RemoteJoinTracker({ ...input(), pid: process.pid });
    first.start(() => undefined);
    const second = new RemoteJoinTracker({ ...input(), pid: 999_999 });
    expect(second.runningElsewhere()?.pid).toBe(process.pid);
    second.markStopped(false);
    expect(readRecord(dir, first.id)!.pid).toBe(process.pid);
    first.markStopped(false);
  });
});

describe("stopRemoteJoin", () => {
  it("asks the process to stop and waits for it to exit by itself", async () => {
    const saved = record({ pid: 4242 });
    writeRecord(dir, saved);
    let alive = true;
    const kill = vi.fn();
    const pending = stopRemoteJoin(dir, saved.id, {
      timeoutMs: 2_000,
      isAlive: () => alive,
      kill,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stopRequested(dir, saved.id)).toBe(true);
    alive = false;
    const result = await pending;
    expect(kill).not.toHaveBeenCalled();
    expect(result?.pid).toBeNull();
    expect(result?.stoppedAt).not.toBeNull();
    expect(result?.rooms).toEqual({ kx001: false });
    expect(stopRequested(dir, saved.id)).toBe(false);
  });

  it("kills the process tree when it doesn't exit in time", async () => {
    const saved = record({ pid: 4243 });
    writeRecord(dir, saved);
    let alive = true;
    const kill = vi.fn(() => {
      alive = false;
    });
    await stopRemoteJoin(dir, saved.id, { timeoutMs: 100, isAlive: () => alive, kill });
    expect(kill).toHaveBeenCalledWith(4243);
    expect(readRecord(dir, saved.id)?.pid).toBeNull();
  });
});

describe("leaveRemoteRoom", () => {
  const respond = (status: number, body: unknown = {}) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("posts to /api/guest-agents/leave with the agent's own token", async () => {
    const fetchImpl = respond(200, { left: true });
    expect(await leaveRemoteRoom("http://10.0.0.2:8787/", "tok", fetchImpl)).toEqual({
      left: true,
    });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe("http://10.0.0.2:8787/api/guest-agents/leave");
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer tok" });
  });

  it("treats an expired token as already gone, explains old servers and other errors", async () => {
    expect(await leaveRemoteRoom("http://h", "t", respond(401))).toEqual({ left: true });
    expect(await leaveRemoteRoom("http://h", "t", respond(404))).toMatchObject({
      left: false,
      error: expect.stringContaining("版本较旧"),
    });
    expect(
      await leaveRemoteRoom("http://h", "t", respond(403, { error: "只有访客带入的 Agent" })),
    ).toEqual({ left: false, error: "只有访客带入的 Agent" });
    const offline = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await leaveRemoteRoom("http://h", "t", offline)).toMatchObject({
      left: false,
      error: expect.stringContaining("ECONNREFUSED"),
    });
  });
});

describe("leaveOne", () => {
  it("takes it offline and keeps it in the list", async () => {
    const saved = record({ pid: null, stoppedAt: new Date().toISOString() });
    writeRecord(dir, saved);
    expect(await leaveOne(dir, saved, false)).toEqual({ left: false });
    expect(readRecord(dir, saved.id)).toBeDefined();
  });

  it("with --leave-room asks the other server and forgets it", async () => {
    const saved = record({ pid: null, stoppedAt: new Date().toISOString() });
    writeRecord(dir, saved);
    writeFileSync(path.join(dir, `${saved.id}.token`), "tok");
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    expect(await leaveOne(dir, saved, true, fetchImpl as unknown as typeof fetch)).toEqual({
      left: true,
    });
    expect(readRecord(dir, saved.id)).toBeUndefined();
    expect(readToken(dir, saved.id)).toBeUndefined();
  });
});

describe("formatJoins", () => {
  it("prints an empty hint, and status, place and process for each agent", () => {
    expect(formatJoins([])).toContain("--background");
    const text = formatJoins([viewOf(record(), { isAlive: () => true })]);
    expect(text).toContain("在线  caibao-claude（claude）  http://10.0.0.2:8787 #kx001");
    expect(text).toContain(`进程 ${process.pid}（后台）`);
  });
});

describe("relaunchArgs", () => {
  it("drops the token and --background so they never end up on disk", () => {
    expect(
      relaunchArgs([
        "join",
        "--server",
        "http://h",
        "--token",
        "secret",
        "--token=secret2",
        "--background",
        "--name",
        "a",
      ]),
    ).toEqual(["join", "--server", "http://h", "--name", "a"]);
  });
});

describe("addServerToNoProxy", () => {
  it("adds the Hive host to NO_PROXY only when a proxy is set", () => {
    const none: NodeJS.ProcessEnv = {};
    expect(addServerToNoProxy(none, "http://192.168.1.5:8787")).toBe(false);
    expect(none.NO_PROXY).toBeUndefined();

    const env: NodeJS.ProcessEnv = { https_proxy: "http://127.0.0.1:7890", NO_PROXY: "localhost" };
    expect(addServerToNoProxy(env, "http://192.168.1.5:8787")).toBe(true);
    expect(env.NO_PROXY).toBe("localhost,192.168.1.5");
    expect(env.no_proxy).toBe("localhost,192.168.1.5");
    expect(addServerToNoProxy(env, "http://192.168.1.5:9000")).toBe(false);
    expect(addServerToNoProxy({ HTTP_PROXY: "x", NO_PROXY: "*" }, "http://h")).toBe(false);
  });
});
