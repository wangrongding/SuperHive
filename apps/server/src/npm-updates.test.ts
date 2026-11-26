import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NpmUpdateInfo, NpmUpdateJob } from "@superhive/protocol";
import { buildApp } from "./app.js";
import { NpmUpdateManager } from "./npm-updates.js";

const info: NpmUpdateInfo = {
  current: "0.4.8",
  latest: "0.4.9",
  notes: ["Fixes"],
  releaseUrl: "https://github.com/wangrongding/SuperHive/releases/tag/v0.4.9",
  canUpdate: true,
  blocker: null,
  manualCommand: "hive update",
  busyAgents: [],
  canHandover: true,
};
const job: NpmUpdateJob = {
  id: "job",
  target: "0.4.9",
  previous: "0.4.8",
  phase: "installing",
  startedAt: 100,
  updatedAt: 100,
};
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

async function setup(change: Partial<NpmUpdateInfo> = {}) {
  const manager = {
    inspect: vi.fn(async () => ({ ...info, ...change })),
    launch: vi.fn(async () => job),
    current: vi.fn(() => null),
  };
  const app = await buildApp({ databasePath: ":memory:", token: "owner", npmUpdates: manager });
  apps.push(app);
  const session = await app.inject({
    url: "/api/local/update/session",
    remoteAddress: "127.0.0.1",
    headers: { host: "localhost" },
  });
  const headers = { host: "localhost", "x-hive-owner": session.json().ownerToken as string };
  return { app, manager, headers };
}

describe("npm update routes", () => {
  it("allows only the local owner to trigger and inspect updates", async () => {
    const { app, manager, headers } = await setup();
    const post = {
      method: "POST" as const,
      url: "/api/local/update",
      payload: { target: "0.4.9" },
    };
    expect(
      (
        await app.inject({
          ...post,
          headers: { host: "localhost", authorization: "Bearer owner" },
          remoteAddress: "127.0.0.1",
        })
      ).statusCode,
    ).toBe(401);
    expect((await app.inject({ ...post, headers, remoteAddress: "192.0.2.1" })).statusCode).toBe(
      403,
    );
    expect(
      (
        await app.inject({
          ...post,
          headers: { ...headers, "x-forwarded-for": "192.0.2.1" },
          remoteAddress: "127.0.0.1",
        })
      ).statusCode,
    ).toBe(403);
    expect(manager.launch).not.toHaveBeenCalled();
    expect((await app.inject({ ...post, headers, remoteAddress: "127.0.0.1" })).statusCode).toBe(
      202,
    );
    expect(manager.launch).toHaveBeenCalledWith("0.4.9", undefined);
    expect(
      (await app.inject({ url: "/api/local/update/current", headers, remoteAddress: "127.0.0.1" }))
        .statusCode,
    ).toBe(200);
  });
  it("exposes no local paths, busy Agent names, or update command to remote viewers", async () => {
    const { app } = await setup();
    expect((await app.inject("/api/update")).statusCode).toBe(401);
    const response = await app.inject({
      url: "/api/update",
      headers: { authorization: "Bearer owner" },
      remoteAddress: "192.0.2.1",
    });
    expect(response.json()).toEqual({
      update: {
        current: info.current,
        latest: info.latest,
        notes: info.notes,
        releaseUrl: info.releaseUrl,
      },
    });
  });
  it("requires renewed confirmation if busy Agents cannot be handed over", async () => {
    const { app, headers, manager } = await setup({ canHandover: false, busyAgents: ["agent"] });
    const request = {
      method: "POST" as const,
      url: "/api/local/update",
      headers,
      remoteAddress: "127.0.0.1",
    };
    const blocked = await app.inject({ ...request, payload: { target: "0.4.9" } });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().code).toBe("UPDATE_BUSY");
    expect(manager.launch).not.toHaveBeenCalled();
    expect(
      (await app.inject({ ...request, payload: { target: "0.4.9", choice: "wait" } })).statusCode,
    ).toBe(202);
    expect(manager.launch).toHaveBeenCalledWith("0.4.9", "wait");
  });
  it("rejects stale versions, unsupported installations and arbitrary commands", async () => {
    const { app, headers, manager } = await setup({ canUpdate: false, blocker: "source" });
    const request = {
      method: "POST" as const,
      url: "/api/local/update",
      headers,
      remoteAddress: "127.0.0.1",
    };
    expect((await app.inject({ ...request, payload: { target: "0.4.8" } })).statusCode).toBe(409);
    expect(
      (await app.inject({ ...request, payload: { target: "0.4.9", command: "anything" } }))
        .statusCode,
    ).toBe(400);
    expect((await app.inject({ ...request, payload: { target: "0.4.9;evil" } })).statusCode).toBe(
      400,
    );
    expect(manager.launch).not.toHaveBeenCalled();
  });
  it("returns a readable failure without stopping the Server", async () => {
    const { app, headers, manager } = await setup();
    manager.launch.mockRejectedValueOnce(new Error("An update is already running"));
    const response = await app.inject({
      method: "POST",
      url: "/api/local/update",
      headers,
      remoteAddress: "127.0.0.1",
      payload: { target: "0.4.9" },
    });
    expect(response.json().error).toContain("already running");
    expect((await app.inject("/health")).statusCode).toBe(200);
  });
  it("coalesces concurrent checks and caches them for an hour", async () => {
    const run = vi.fn(async () => JSON.stringify(info));
    const manager = new NpmUpdateManager({ command: "node", args: ["cli"] }, "/isolated", run);
    await Promise.all([manager.inspect(), manager.inspect()]);
    await manager.inspect();
    expect(run).toHaveBeenCalledOnce();
    await manager.inspect(true);
    expect(run).toHaveBeenCalledTimes(2);
  });
  it("restores persisted progress after Server replacement and reports a dead worker without retrying", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "hive-update-manager-"));
    const run = vi.fn(async () => JSON.stringify(info));
    try {
      writeFileSync(
        path.join(directory, "web-update.json"),
        JSON.stringify({ ...job, updatedAt: Date.now() - 10_000, workerPid: 42 }),
      );
      const manager = new NpmUpdateManager(
        { command: "node", args: ["cli"] },
        directory,
        run,
        () => true,
      );
      expect(manager.current()?.id).toBe(job.id);
      const replacement = new NpmUpdateManager(
        { command: "node", args: ["cli"] },
        directory,
        run,
        () => false,
      );
      expect(replacement.current()).toMatchObject({ id: job.id, phase: "failed" });
      await expect(replacement.launch("0.4.9")).rejects.toThrow("stopped unexpectedly");
      expect(run).not.toHaveBeenCalled();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
