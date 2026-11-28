import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recordCliTelemetry, telemetryCommand } from "./telemetry-command.js";
import {
  appendTelemetryEvents,
  hourOf,
  readTelemetryQueue,
  readTelemetryState,
  writeTelemetryState,
  type TelemetryRunMode,
} from "./telemetry-core.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hive-telemetry-cli-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(
  args: string[],
  env: NodeJS.ProcessEnv = {},
  dir = tempDir(),
  runMode: TelemetryRunMode = "source",
) {
  const output: string[] = [];
  telemetryCommand(args, { env, dir, runMode, write: (text) => output.push(text) });
  return { text: output.join("\n"), dir };
}

const queued = (dir: string) =>
  appendTelemetryEvents(dir, [
    {
      event: "feature_first_used",
      time: hourOf(Date.now()),
      context: { version: "0.4.9", runMode: "npm", os: "linux", arch: "x64", locale: "en" },
      props: { feature: "room_create" },
    },
  ]);

describe("hive telemetry", () => {
  it("is on by default and, installed from npm or the desktop app, reports to the built-in Umami", () => {
    for (const runMode of ["npm", "desktop"] as const) {
      const { text } = run(["status"], {}, tempDir(), runMode);
      expect(text).toContain("匿名使用统计：开\n");
      expect(text).toContain("上报到：https://60.205.92.58（自部署的 Umami，每天最多发一次）");
      expect(text).toContain("hive telemetry off");
    }
  });

  it("running from source only records locally unless SUPERHIVE_TELEMETRY_URL is set", () => {
    const { text } = run(["status"]);
    expect(text).toContain(
      "匿名使用统计：开（源码运行默认不上报：只在本机记录，一条都不发；要发设 SUPERHIVE_TELEMETRY_URL）",
    );
    expect(text).not.toContain("上报到");
    expect(
      run(["status"], { SUPERHIVE_TELEMETRY_URL: "https://stats.example.com" }).text,
    ).toContain("上报到：https://stats.example.com（自部署的 Umami，每天最多发一次）");
    // 设错了不退回内置地址
    expect(
      run(["status"], { SUPERHIVE_TELEMETRY_URL: "stats.example.com" }, tempDir(), "npm").text,
    ).toContain("SUPERHIVE_TELEMETRY_URL 不是 http(s) 地址：只在本机记录，一条都不发");
  });

  it("works out the run mode from where this copy of superhive lives", () => {
    // 跑测试时就在仓库里：按源码运行算
    const output: string[] = [];
    telemetryCommand(["status"], { env: {}, dir: tempDir(), write: (text) => output.push(text) });
    expect(output.join("\n")).toContain("源码运行默认不上报");
  });

  it("explains why it is off when the environment blocks it", () => {
    expect(run(["status"], { DO_NOT_TRACK: "1" }).text).toContain(
      "关（设置了环境变量 DO_NOT_TRACK）",
    );
    expect(run(["status"], { CI: "true" }).text).toContain("关（在 CI 环境里运行）");
    expect(run([], { SUPERHIVE_TELEMETRY: "0" }).text).toContain("SUPERHIVE_TELEMETRY=0");
  });

  it("turns off, deletes unsent data, and turns back on", () => {
    const dir = tempDir();
    writeTelemetryState(dir, readTelemetryState(dir).state);
    queued(dir);
    expect(run(["off"], {}, dir).text).toContain("已关闭");
    expect(readTelemetryState(dir).state.enabled).toBe(false);
    expect(readTelemetryQueue(dir)).toEqual([]);
    expect(run(["status"], {}, dir).text).toContain("关（你选了关闭");
    expect(run(["preview"], {}, dir).text).toBe("匿名使用统计已关闭，没有要发送的数据。");
    run(["on"], {}, dir);
    expect(readTelemetryState(dir).state.enabled).toBe(true);
  });

  it("prints the same Umami request body the Server would send", () => {
    const dir = tempDir();
    const { state } = readTelemetryState(dir);
    writeTelemetryState(dir, state);
    expect(run(["preview"], {}, dir).text).toBe("还没有要发送的数据。");
    queued(dir);
    const payload = JSON.parse(run(["preview"], {}, dir).text);
    expect(payload).toEqual([
      {
        type: "event",
        payload: {
          website: "b2d13ec6-3fa6-47bf-9cbd-7317357517fc",
          hostname: "superhive.app",
          url: "/feature_first_used",
          name: "feature_first_used",
          language: "en",
          timestamp: expect.any(Number),
          id: state.installId,
          data: {
            schema: 1,
            version: "0.4.9",
            runMode: "npm",
            os: "linux",
            arch: "x64",
            locale: "en",
            feature: "room_create",
          },
        },
      },
    ]);
    const site = "0f8c2a4e-1b3d-4e5f-8a9b-0c1d2e3f4a5b";
    const custom = JSON.parse(run(["preview"], { SUPERHIVE_TELEMETRY_SITE: site }, dir).text);
    expect(custom[0].payload.website).toBe(site);
  });

  it("includes today's heartbeat that is still waiting for someone to send a message", () => {
    const dir = tempDir();
    const time = hourOf(Date.now());
    const pendingHeartbeat = {
      event: "heartbeat" as const,
      time,
      context: {
        version: "0.4.9",
        runMode: "npm",
        os: "linux",
        arch: "x64",
        locale: "en",
      } as const,
      props: { agents: { claude: 1 }, rooms: "1", active: "no" },
    };
    writeTelemetryState(dir, { ...readTelemetryState(dir).state, pendingHeartbeat });
    const preview = () =>
      JSON.parse(run(["preview"], {}, dir).text) as Array<{ payload: { data: object } }>;
    expect(preview().map((item) => item.payload.data)).toEqual([
      expect.objectContaining({ agents_claude: 1, rooms: "1", active: "no" }),
    ]);
    expect(run(["status"], {}, dir).text).toContain("等着发的数据：1 条");
    // 当天有人发过消息：发出去时是 active=yes
    writeTelemetryState(dir, {
      ...readTelemetryState(dir).state,
      activeDay: time.slice(0, 10),
    });
    expect(preview()[0]!.payload.data).toMatchObject({ active: "yes" });
    // 关掉时待定的心跳也一起删掉
    run(["off"], {}, dir);
    expect(readTelemetryState(dir).state).not.toHaveProperty("pendingHeartbeat");
  });

  it("resets the install ID", () => {
    const dir = tempDir();
    const { state } = readTelemetryState(dir);
    writeTelemetryState(dir, state);
    const { text } = run(["reset"], {}, dir);
    const next = readTelemetryState(dir).state.installId;
    expect(next).not.toBe(state.installId);
    expect(text).toContain(next);
  });

  it("rejects unknown subcommands", () => {
    expect(() => run(["maybe"])).toThrow(/telemetry maybe/);
  });
});

describe("recordCliTelemetry", () => {
  const record = (dir: string, env: NodeJS.ProcessEnv = {}) =>
    recordCliTelemetry(
      "update_result",
      { kind: "npm", outcome: "failure", reason: "install_failed", error: "npm ERR! 403" },
      { version: "0.4.9", env, dir },
    );

  it("appends to the local queue only (never sends), without free text", () => {
    const dir = tempDir();
    writeTelemetryState(dir, readTelemetryState(dir).state);
    record(dir);
    expect(readTelemetryQueue(dir).map((event) => event.props)).toEqual([
      { kind: "npm", outcome: "failure", reason: "install_failed" },
    ]);
  });

  it("does nothing when turned off, blocked, or before any Server has set it up", () => {
    const fresh = tempDir();
    record(fresh);
    expect(existsSync(path.join(fresh, "queue.jsonl"))).toBe(false);

    const blocked = tempDir();
    writeTelemetryState(blocked, readTelemetryState(blocked).state);
    record(blocked, { DO_NOT_TRACK: "1" });
    expect(readTelemetryQueue(blocked)).toEqual([]);

    const off = tempDir();
    writeTelemetryState(off, { ...readTelemetryState(off).state, enabled: false });
    record(off);
    expect(readTelemetryQueue(off)).toEqual([]);
  });
});
