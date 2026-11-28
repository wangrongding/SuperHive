import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Telemetry, type TelemetryOptions } from "./telemetry.js";
import {
  appendTelemetryEvents,
  hourOf,
  readTelemetryQueue,
  readTelemetryState,
  setTelemetryEnabled,
} from "./telemetry-core.js";

const dirs: string[] = [];
const instances: Telemetry[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hive-telemetry-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const instance of instances.splice(0)) instance.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function make(options: Partial<TelemetryOptions> = {}) {
  let now = Date.UTC(2026, 10, 28, 4, 30);
  const fetch = vi.fn(async () => new Response(null, { status: 204 }));
  const telemetry = new Telemetry({
    dir: options.dir ?? tempDir(),
    version: "0.4.9",
    runMode: "desktop",
    // 不继承跑测试时的环境（VITEST、CI 会挡住统计）
    env: {},
    now: () => now,
    fetch: fetch as unknown as typeof globalThis.fetch,
    snapshot: () => ({ agents: { claude: 2, codex: 1 }, rooms: 3 }),
    ...options,
  });
  instances.push(telemetry);
  return {
    telemetry,
    fetch,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const endpoint = { SUPERHIVE_TELEMETRY_URL: "https://stats.example.com/v1/events" };

describe("Telemetry", () => {
  it("is on by default and records locally, but never sends without an endpoint", async () => {
    const { telemetry, fetch } = make();
    expect(telemetry.status()).toMatchObject({
      active: true,
      enabled: true,
      endpoint: false,
      noticePending: true,
    });
    telemetry.feature("room_create");
    telemetry.heartbeat();
    for (let index = 0; index < 60; index += 1)
      telemetry.record("update_result", {
        kind: "desktop",
        outcome: "success",
      });
    await telemetry.flush();
    expect(fetch).not.toHaveBeenCalled();
    expect(telemetry.status().queued).toBe(62);
    const payload = telemetry.preview()!;
    expect(payload.installId).toBe(telemetry.status().installId);
    expect(payload.events[0]).toEqual({
      event: "feature_first_used",
      time: "2026-11-28T04:00:00.000Z",
      context: expect.objectContaining({ version: "0.4.9", runMode: "desktop" }),
      props: { feature: "room_create" },
    });
  });

  it("posts the queued batch once and drops it whether or not the upload worked", async () => {
    const { telemetry, fetch } = make({ env: endpoint });
    telemetry.feature("invite_member");
    await telemetry.flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(endpoint.SUPERHIVE_TELEMETRY_URL);
    const body = JSON.parse(String(init.body)) as {
      schema: number;
      installId: string;
      events: unknown[];
    };
    expect(body).toMatchObject({ schema: 1, installId: telemetry.status().installId });
    expect(body.events).toHaveLength(1);
    expect(telemetry.status().queued).toBe(0);

    fetch.mockRejectedValueOnce(new Error("offline"));
    telemetry.feature("code_panel");
    await telemetry.flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    // 失败不重试、不堆积
    expect(telemetry.status().queued).toBe(0);
    await telemetry.flush();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("sends early once the batch size is reached", async () => {
    const { telemetry, fetch } = make({ env: endpoint, batchSize: 3 });
    for (let index = 0; index < 3; index += 1)
      telemetry.record("update_result", { kind: "npm", outcome: "success" });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  });

  it("records nothing and creates no files when blocked by the environment", async () => {
    for (const env of [
      { SUPERHIVE_TELEMETRY: "0", ...endpoint },
      { DO_NOT_TRACK: "1", ...endpoint },
      { CI: "true", ...endpoint },
      { NODE_ENV: "test", ...endpoint },
    ]) {
      const dir = tempDir();
      const { telemetry, fetch } = make({ dir, env });
      telemetry.start();
      telemetry.feature("room_create");
      telemetry.heartbeat();
      telemetry.incident("internal", "server");
      await telemetry.flush();
      expect(telemetry.status()).toMatchObject({ active: false, noticePending: false, queued: 0 });
      expect(telemetry.preview()).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
      expect(existsSync(path.join(dir, "state.json"))).toBe(false);
      expect(existsSync(path.join(dir, "queue.jsonl"))).toBe(false);
    }
    const sandbox = make({ sandbox: true, env: endpoint });
    sandbox.telemetry.feature("room_create");
    expect(sandbox.telemetry.status()).toMatchObject({ active: false, blocker: "sandbox" });
  });

  it("stops recording when turned off and deletes what was not sent", async () => {
    const { telemetry, fetch } = make({ env: endpoint });
    telemetry.feature("room_create");
    expect(telemetry.setEnabled(false)).toMatchObject({ active: false, enabled: false, queued: 0 });
    telemetry.feature("code_panel");
    telemetry.heartbeat();
    await telemetry.flush();
    expect(fetch).not.toHaveBeenCalled();
    expect(telemetry.setEnabled(true)).toMatchObject({ active: true, noticePending: false });
  });

  it("picks up `hive telemetry off` from the CLI without a restart", () => {
    const dir = tempDir();
    const { telemetry } = make({ dir });
    expect(telemetry.active()).toBe(true);
    setTelemetryEnabled(dir, false);
    expect(telemetry.active()).toBe(false);
    telemetry.feature("room_create");
    expect(readTelemetryQueue(dir)).toEqual([]);
  });

  it("records each feature's first use only once per computer", () => {
    const dir = tempDir();
    const first = make({ dir });
    first.telemetry.feature("agent_join");
    first.telemetry.feature("agent_join");
    first.telemetry.close();
    // 重启后（新的进程）也不再记
    const second = make({ dir });
    second.telemetry.feature("agent_join");
    second.telemetry.feature("im_connect");
    expect(readTelemetryQueue(dir).map((event) => event.props.feature)).toEqual([
      "agent_join",
      "im_connect",
    ]);
  });

  it("sends a heartbeat once per day with agent counts, a room bucket and incident counts", () => {
    const dir = tempDir();
    const { telemetry, advance } = make({ dir });
    telemetry.incident("external", "invocation");
    telemetry.incident("external", "invocation");
    telemetry.incident("internal", "server");
    telemetry.heartbeat();
    telemetry.heartbeat();
    advance(60 * 60_000);
    telemetry.heartbeat();
    expect(readTelemetryQueue(dir).map(({ event, props }) => ({ event, props }))).toEqual([
      { event: "heartbeat", props: { agents: { claude: 2, codex: 1 }, rooms: "2-5" } },
      {
        event: "incident_counts",
        props: { counts: { "external.invocation": 2, "internal.server": 1 } },
      },
    ]);
    advance(24 * 60 * 60_000);
    telemetry.heartbeat();
    expect(readTelemetryQueue(dir).map((event) => event.event)).toEqual([
      "heartbeat",
      "incident_counts",
      "heartbeat",
    ]);
  });

  it("shows the first-time notice only once, also after a restart", () => {
    const dir = tempDir();
    const first = make({ dir });
    expect(first.telemetry.status().noticePending).toBe(true);
    expect(first.telemetry.markNoticeShown().noticePending).toBe(false);
    first.telemetry.close();
    expect(make({ dir }).telemetry.status().noticePending).toBe(false);
  });

  it("resets the install ID and drops what was queued under the old one", () => {
    const { telemetry } = make();
    const before = telemetry.status().installId;
    telemetry.feature("room_create");
    const after = telemetry.resetInstallId();
    expect(after.installId).not.toBe(before);
    expect(after.queued).toBe(0);
    expect(telemetry.preview()?.installId).toBe(after.installId);
  });

  it("uses the owner's web UI language for the locale field", () => {
    const dir = tempDir();
    const { telemetry } = make({ dir });
    telemetry.setUiLocale("en");
    telemetry.feature("room_create");
    expect(readTelemetryQueue(dir)[0]?.context.locale).toBe("en");
    expect(readTelemetryState(dir).state.uiLocale).toBe("en");
  });

  it("sends events that the CLI appended to the shared queue", async () => {
    const dir = tempDir();
    const { telemetry, fetch } = make({ dir, env: endpoint });
    telemetry.status();
    appendTelemetryEvents(dir, [
      {
        event: "update_result",
        time: hourOf(Date.now()),
        context: { version: "0.4.8", runMode: "npm", os: "linux", arch: "x64", locale: "en" },
        props: { kind: "npm", outcome: "success" },
      },
    ]);
    await telemetry.flush();
    const body = JSON.parse(
      String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    );
    expect(body.events[0]).toMatchObject({ event: "update_result", context: { version: "0.4.8" } });
  });
});
