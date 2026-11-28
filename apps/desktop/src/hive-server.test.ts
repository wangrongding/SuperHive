import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discover,
  loopbackOrigin,
  serverEnv,
  startServer,
  statePathFor,
  superhiveHome,
  type ServiceState,
} from "./hive-server.js";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function state(overrides: Partial<ServiceState> = {}): ServiceState {
  return {
    pid: 123,
    instanceId: "abc",
    healthUrl: "http://127.0.0.1:8787/health",
    publicUrl: "http://192.168.1.2:8787",
    dataDir: dir!,
    logPath: path.join(dir!, "server.log"),
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("discover", () => {
  it("connects to the Hive that hive start already runs", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "hive-discover-"));
    writeFileSync(
      statePathFor(dir),
      JSON.stringify(state({ healthUrl: "http://0.0.0.0:9000/health" })),
    );
    const result = await discover({
      dataDir: dir,
      preferredPort: 8787,
      alive: () => true,
      health: async () => ({ status: "ok", instanceId: "abc" }),
      isPortFree: async () => true,
    });
    expect(result).toMatchObject({
      kind: "existing",
      origin: "http://127.0.0.1:9000",
      source: "state",
    });
  });

  it("drops a stale state file and starts its own", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "hive-discover-"));
    writeFileSync(statePathFor(dir), JSON.stringify(state()));
    const result = await discover({
      dataDir: dir,
      preferredPort: 8787,
      alive: () => false,
      health: async () => undefined,
      isPortFree: async () => true,
    });
    expect(result).toEqual({ kind: "start", port: 8787 });
    expect(() => readFileSync(statePathFor(dir!))).toThrow();
  });

  it("does not trust a recorded pid whose instance id changed (pid reused)", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "hive-discover-"));
    writeFileSync(statePathFor(dir), JSON.stringify(state()));
    const result = await discover({
      dataDir: dir,
      preferredPort: 8787,
      alive: () => true,
      health: async () => ({ status: "ok", instanceId: "someone-else" }),
      isPortFree: async (port) => port !== 8787,
    });
    // 8787 被一个「别的 Hive」占着：首选端口上的 Hive 照样直接连
    expect(result).toMatchObject({
      kind: "existing",
      origin: "http://127.0.0.1:8787",
      source: "port",
    });
  });

  it("moves to the next free port when something else holds the preferred one", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "hive-discover-"));
    const result = await discover({
      dataDir: dir,
      preferredPort: 8787,
      alive: () => false,
      health: async () => undefined,
      isPortFree: async (port) => port >= 8789,
    });
    expect(result).toEqual({ kind: "start", port: 8789 });
  });
});

describe("paths and origins", () => {
  it("uses ~/.superhive, the legacy ~/.ai-hive only when it is the one that exists", () => {
    const exists = (set: string[]) => (file: string) => set.includes(file);
    expect(superhiveHome({}, "/h", exists([]))).toBe("/h/.superhive");
    expect(superhiveHome({}, "/h", exists(["/h/.ai-hive"]))).toBe("/h/.ai-hive");
    expect(superhiveHome({}, "/h", exists(["/h/.ai-hive", "/h/.superhive"]))).toBe("/h/.superhive");
    expect(superhiveHome({ SUPERHIVE_DESKTOP_DATA_DIR: "/tmp/x" }, "/h", exists([]))).toBe(
      "/tmp/x",
    );
  });

  it("always opens the window on loopback", () => {
    expect(loopbackOrigin("http://0.0.0.0:8787/health")).toBe("http://127.0.0.1:8787");
    expect(loopbackOrigin("http://localhost:8787/health")).toBe("http://127.0.0.1:8787");
    expect(loopbackOrigin("http://192.168.1.2:8787/health")).toBe("http://127.0.0.1:8787");
  });
});

describe("server environment", () => {
  it("defaults new agents and workspaces to the home directory, not the install directory", () => {
    const env = serverEnv(
      {
        PATH: "/usr/bin",
        ELECTRON_RUN_AS_NODE: "1",
        UNSET: undefined,
      },
      "/Users/rd",
      { HIVE_PORT: "8787" },
    );
    expect(env).toEqual({ PATH: "/usr/bin", HIVE_LAUNCH_DIR: "/Users/rd", HIVE_PORT: "8787" });
  });

  it("keeps a HIVE_LAUNCH_DIR the user set, and ignores a blank one", () => {
    expect(serverEnv({ HIVE_LAUNCH_DIR: "/srv/work" }, "/Users/rd").HIVE_LAUNCH_DIR).toBe(
      "/srv/work",
    );
    expect(serverEnv({ HIVE_LAUNCH_DIR: "  " }, "/Users/rd").HIVE_LAUNCH_DIR).toBe("/Users/rd");
  });

  it("forks the server in the home directory with HIVE_LAUNCH_DIR set", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "superhive-desktop-env-"));
    const forked: Array<{ env: Record<string, string>; cwd: string }> = [];
    await expect(
      startServer({
        fork: async (_entry, env, cwd) => {
          forked.push({ env, cwd });
          throw new Error("stop here");
        },
        serverEntry: "/app/server/index.js",
        staticDir: "/app/web",
        dataDir: dir,
        port: 1,
        env: { PATH: "/usr/bin" },
        agentCli: ["/app/SuperHive", "--superhive-cli"],
        launcher: "test",
        home: "/Users/rd",
        packaged: true,
      }),
    ).rejects.toThrow("stop here");
    expect(forked).toHaveLength(1);
    expect(forked[0]!.cwd).toBe("/Users/rd");
    expect(forked[0]!.env.HIVE_LAUNCH_DIR).toBe("/Users/rd");
    // 没传 host 时只听本机（桌面端按「允许局域网设备访问」显式传，默认开启时传 0.0.0.0）
    expect(forked[0]!.env.HIVE_HOST).toBe("127.0.0.1");
    // 安装包：匿名使用统计按桌面版算
    expect(forked[0]!.env.HIVE_DESKTOP_PACKAGED).toBe("1");
  });

  it("marks only the packaged app, so development builds count as running from source", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "superhive-desktop-env-"));
    const forked: Array<Record<string, string>> = [];
    await expect(
      startServer({
        fork: async (_entry, env) => {
          forked.push(env);
          throw new Error("stop here");
        },
        serverEntry: "/app/server/index.js",
        staticDir: "/app/web",
        dataDir: dir,
        port: 1,
        // 从安装包里的终端又起了开发版：外面带进来的也去掉
        env: { PATH: "/usr/bin", HIVE_DESKTOP_PACKAGED: "1" },
        agentCli: ["/app/SuperHive", "--superhive-cli"],
        launcher: "test",
        home: "/Users/rd",
        packaged: false,
      }),
    ).rejects.toThrow("stop here");
    expect(forked[0]).not.toHaveProperty("HIVE_DESKTOP_PACKAGED");
  });
});
