import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import type { RunJoinCli } from "./remote-join-routes.js";
import { readRecord, remoteJoinId, writeRecord, type RemoteJoinRecord } from "./remote-joins.js";

const SERVER = "http://10.0.0.2:8787";

describe("/api/local/remote-joins", () => {
  let dir: string;
  let closeApp: (() => Promise<void>) | undefined;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "hive-remote-join-routes-"));
  });
  afterEach(async () => {
    await closeApp?.();
    closeApp = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  function record(patch: Partial<RemoteJoinRecord> = {}): RemoteJoinRecord {
    const now = new Date().toISOString();
    return {
      version: 1,
      id: remoteJoinId(SERVER, "kx001", "win-claude"),
      server: SERVER,
      roomId: "kx001",
      name: "win-claude",
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
      launch: null,
      lastError: null,
      ...patch,
    };
  }

  async function setup(runJoinCli?: RunJoinCli) {
    const app = await buildApp({
      databasePath: ":memory:",
      token: "join-token",
      staticDir: "/definitely-not-present",
      remoteJoins: { dir, ...(runJoinCli ? { runJoinCli } : {}) },
      localAgents: {
        cli: { command: "/usr/bin/node", args: ["/opt/superhive/dist/cli.js"] },
        serverUrl: "http://127.0.0.1:8787",
        spawn: vi.fn(),
        probe: async () => ({ installed: false, version: null }),
      },
    });
    closeApp = () => app.close();
    const session = (await app.inject({ method: "GET", url: "/api/local/session" })).json() as {
      ownerToken?: string;
    };
    return { app, owner: { "x-hive-owner": session.ownerToken ?? "" } };
  }

  it("lists the shared registry and needs the owner", async () => {
    const { app, owner } = await setup();
    expect((await app.inject({ method: "GET", url: "/api/local/remote-joins" })).statusCode).toBe(
      401,
    );
    expect(
      (await app.inject({ method: "GET", url: "/api/local/remote-joins", headers: owner })).json(),
    ).toEqual({ joins: [] });
    writeRecord(dir, record());
    writeFileSync(path.join(dir, `${record().id}.token`), "secret-token");
    const listed = await app.inject({
      method: "GET",
      url: "/api/local/remote-joins",
      headers: owner,
    });
    expect(listed.json().joins).toMatchObject([
      { name: "win-claude", status: "online", server: SERVER, roomId: "kx001", canRestart: false },
    ]);
    expect(listed.body).not.toContain("secret-token");
  });

  it("brings an agent in through hive join --background, token in the environment only", async () => {
    const runJoinCli = vi.fn<RunJoinCli>(async () => {
      writeRecord(dir, record({ access: "workspace", cwd: "/work" }));
      return { ok: true };
    });
    const { app, owner } = await setup(runJoinCli);
    const bad = await app.inject({
      method: "POST",
      url: "/api/local/remote-joins",
      headers: owner,
      payload: {
        server: SERVER,
        name: "win-claude",
        token: "t",
        runtime: "claude",
        access: "workspace",
      },
    });
    expect(bad.json().code).toBe("REMOTE_JOIN_CWD_REQUIRED");

    const created = await app.inject({
      method: "POST",
      url: "/api/local/remote-joins",
      headers: owner,
      payload: {
        server: `${SERVER}/`,
        roomId: "kx001",
        name: "win-claude",
        token: "secret-token",
        runtime: "claude",
        access: "workspace",
        cwd: "/work",
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().join).toMatchObject({ name: "win-claude", status: "online" });
    const [command, args, env] = runJoinCli.mock.calls[0]!;
    expect(command).toBe("/usr/bin/node");
    expect(args).toEqual([
      "/opt/superhive/dist/cli.js",
      "join",
      `--server=${SERVER}`,
      "--name=win-claude",
      "--provider=claude",
      "--access=workspace",
      "--room=kx001",
      "--cwd=/work",
      "--background",
    ]);
    expect(args.join(" ")).not.toContain("secret-token");
    expect(env).toMatchObject({ HIVE_AGENT_TOKEN: "secret-token", HIVE_REMOTE_JOINS_DIR: dir });
    expect(env).not.toHaveProperty("HIVE_SUPERVISOR_PID");

    // 同一个名字已经在跑：不再起第二个
    const again = await app.inject({
      method: "POST",
      url: "/api/local/remote-joins",
      headers: owner,
      payload: {
        server: SERVER,
        roomId: "kx001",
        name: "win-claude",
        token: "t",
        runtime: "claude",
      },
    });
    expect(again.json().code).toBe("REMOTE_JOIN_RUNNING");
    expect(runJoinCli).toHaveBeenCalledTimes(1);
  });

  it("reports why the CLI failed", async () => {
    const { app, owner } = await setup(async () => ({ ok: false, message: "连不上 Server" }));
    const failed = await app.inject({
      method: "POST",
      url: "/api/local/remote-joins",
      headers: owner,
      payload: { server: SERVER, name: "win-claude", token: "t", runtime: "claude" },
    });
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toMatchObject({ code: "REMOTE_JOIN_FAILED" });
    expect(JSON.stringify(failed.json())).toContain("连不上 Server");
  });

  it("takes it offline, then removes it and leaves the room on the other server", async () => {
    const { app, owner } = await setup();
    // 一个已经退出的进程号：停止时不用等
    const saved = record({ pid: 2 ** 22 + 12345 });
    writeRecord(dir, saved);
    const stopped = await app.inject({
      method: "POST",
      url: `/api/local/remote-joins/${saved.id}/stop`,
      headers: owner,
    });
    expect(stopped.json().join).toMatchObject({ status: "stopped", pid: null });
    expect(readRecord(dir, saved.id)?.stoppedAt).not.toBeNull();

    const start = await app.inject({
      method: "POST",
      url: `/api/local/remote-joins/${saved.id}/start`,
      headers: owner,
    });
    // 没记下启动参数（launch: null）：告诉人重新运行命令
    expect(start.statusCode).toBe(502);

    writeFileSync(path.join(dir, `${saved.id}.token`), "agent-token");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      expect(String(input)).toBe(`${SERVER}/api/guest-agents/leave`);
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer agent-token");
      return new Response("{}", { status: 200 });
    });
    try {
      const removed = await app.inject({
        method: "DELETE",
        url: `/api/local/remote-joins/${saved.id}?leave=1`,
        headers: owner,
      });
      expect(removed.json()).toEqual({ removed: true, left: true });
    } finally {
      fetchMock.mockRestore();
    }
    expect(readRecord(dir, saved.id)).toBeUndefined();
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/local/remote-joins/${saved.id}/stop`,
          headers: owner,
        })
      ).statusCode,
    ).toBe(404);
  });
});
