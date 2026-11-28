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

function run(args: string[], env: NodeJS.ProcessEnv = {}, dir = tempDir()) {
  const output: string[] = [];
  telemetryCommand(args, { env, dir, write: (text) => output.push(text) });
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
  it("shows that it is on by default, recorded locally only without an endpoint", () => {
    const { text } = run(["status"]);
    expect(text).toContain("匿名使用统计：开（还没配上报地址：只在本机记录，一条都不发）");
    expect(text).toContain("hive telemetry off");
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

  it("prints the same JSON body the Server would send", () => {
    const dir = tempDir();
    const { state } = readTelemetryState(dir);
    writeTelemetryState(dir, state);
    queued(dir);
    const payload = JSON.parse(run(["preview"], {}, dir).text);
    expect(payload).toMatchObject({ schema: 1, installId: state.installId });
    expect(payload.events).toHaveLength(1);
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
