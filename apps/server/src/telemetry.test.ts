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
  // 默认像 Umami 的 /api/batch 一样全部收下
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    const size = (JSON.parse(String(init.body)) as unknown[]).length;
    return Response.json({ size, processed: size, errors: 0, details: [], cache: null });
  });
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

const endpoint = { SUPERHIVE_TELEMETRY_URL: "https://stats.example.com" };
const batchUrl = "https://stats.example.com/api/batch";
const HOUR = 60 * 60_000;

type Sent = Array<{ type: string; payload: Record<string, unknown> & { data: object } }>;
function sent(fetch: ReturnType<typeof make>["fetch"], call = 0) {
  const [url, init] = fetch.mock.calls[call]!;
  return {
    url,
    headers: init.headers as Record<string, string>,
    body: JSON.parse(String(init.body)) as Sent,
  };
}

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
    // 预览就是要发给 Umami 的请求体
    const payload = telemetry.preview()!;
    expect(payload).toHaveLength(62);
    expect(payload[0]).toMatchObject({
      type: "event",
      payload: {
        website: "b2d13ec6-3fa6-47bf-9cbd-7317357517fc",
        hostname: "superhive.app",
        url: "/feature_first_used",
        name: "feature_first_used",
        timestamp: Date.UTC(2026, 10, 28, 4) / 1000,
        id: telemetry.status().installId,
        data: expect.objectContaining({
          schema: 1,
          version: "0.4.9",
          runMode: "desktop",
          feature: "room_create",
        }),
      },
    });
  });

  it("uses the website ID from SUPERHIVE_TELEMETRY_SITE", () => {
    const site = "0f8c2a4e-1b3d-4e5f-8a9b-0c1d2e3f4a5b";
    const { telemetry } = make({ env: { SUPERHIVE_TELEMETRY_SITE: site } });
    telemetry.feature("room_create");
    expect(telemetry.preview()![0]!.payload.website).toBe(site);
  });

  it("posts Umami's batch format with a SuperHive User-Agent and empties the queue", async () => {
    const log = vi.fn();
    const { telemetry, fetch } = make({ env: endpoint, log });
    telemetry.feature("invite_member");
    telemetry.heartbeat();
    await telemetry.flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    const { url, headers, body } = sent(fetch);
    expect(url).toBe(batchUrl);
    // 不带 UA（Node 默认是 node）Umami 会当机器人丢掉
    expect(headers["user-agent"]).toMatch(
      /^SuperHive\/0\.4\.9 \((darwin|win32|linux|other); (x64|arm64|other)\)$/,
    );
    expect(headers["content-type"]).toBe("application/json");
    expect(body.map((item) => item.payload.name)).toEqual(["feature_first_used", "heartbeat"]);
    expect(body[1]!.payload).toMatchObject({
      id: telemetry.status().installId,
      data: { agents_claude: 2, agents_codex: 1, rooms: "2-5" },
    });
    expect(telemetry.status().queued).toBe(0);
    expect(log).toHaveBeenCalledWith("Usage statistics sent (2 of 2 event(s) accepted)");
  });

  it("keeps the events when the network is down and retries an hour later", async () => {
    const { telemetry, fetch, advance } = make({ env: endpoint });
    fetch.mockRejectedValueOnce(new Error("offline"));
    telemetry.feature("code_panel");
    await telemetry.flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(telemetry.status().queued).toBe(1);
    // 等待期里不再发（攒够一批提前发也不发）
    telemetry.feature("room_create");
    await telemetry.flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    advance(HOUR);
    await telemetry.flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sent(fetch, 1).body.map((item) => item.payload.data)).toEqual([
      expect.objectContaining({ feature: "code_panel" }),
      expect.objectContaining({ feature: "room_create" }),
    ]);
    expect(telemetry.status().queued).toBe(0);
  });

  it.each([500, 502, 503, 429, 408])("retries later when the service answers %i", async (code) => {
    const { telemetry, fetch } = make({ env: endpoint });
    fetch.mockResolvedValueOnce(new Response("busy", { status: code }));
    telemetry.feature("code_panel");
    await telemetry.flush();
    expect(telemetry.status().queued).toBe(1);
  });

  it("waits twice as long after each failure in a row, up to a day", async () => {
    const { telemetry, fetch, advance } = make({ env: endpoint });
    fetch.mockRejectedValue(new Error("offline"));
    telemetry.feature("code_panel");
    const attempts: number[] = [];
    for (let hour = 0; hour < 60; hour += 1) {
      const before = fetch.mock.calls.length;
      await telemetry.flush();
      if (fetch.mock.calls.length > before) attempts.push(hour);
      advance(HOUR);
    }
    // 第 0 小时失败，隔 1、2、4、8、16 小时，之后每次隔 24 小时
    expect(attempts).toEqual([0, 1, 3, 7, 15, 31, 55]);
    expect(telemetry.status().queued).toBe(1);
  });

  it("drops a batch the service rejects outright instead of retrying it", async () => {
    const { telemetry, fetch } = make({ env: endpoint });
    fetch.mockResolvedValueOnce(Response.json({ error: "Bad request" }, { status: 400 }));
    telemetry.feature("code_panel");
    await telemetry.flush();
    expect(telemetry.status().queued).toBe(0);
    // 没进等待期：新的照常发
    telemetry.feature("room_create");
    await telemetry.flush();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("retries when Umami accepted none of the batch, but drops events it rejected", async () => {
    const { telemetry, fetch, advance } = make({ env: endpoint });
    fetch.mockResolvedValueOnce(Response.json({ size: 2, processed: 0, errors: 2, details: [] }));
    telemetry.feature("code_panel");
    telemetry.feature("room_create");
    await telemetry.flush();
    expect(telemetry.status().queued).toBe(2);

    advance(HOUR);
    fetch.mockResolvedValueOnce(Response.json({ size: 2, processed: 1, errors: 1, details: [] }));
    await telemetry.flush();
    expect(telemetry.status().queued).toBe(0);
  });

  it("sends at most 50 events per request and keeps the rest when one fails", async () => {
    const dir = tempDir();
    const { telemetry, fetch } = make({ dir, env: endpoint, batchSize: 1000 });
    for (let index = 0; index < 120; index += 1)
      telemetry.record("update_result", { kind: "npm", outcome: "success" });
    fetch.mockImplementationOnce(async (_url, init) => {
      const size = (JSON.parse(String(init.body)) as unknown[]).length;
      return Response.json({ size, processed: size, errors: 0 });
    });
    fetch.mockRejectedValueOnce(new Error("offline"));
    await telemetry.flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sent(fetch, 0).body).toHaveLength(50);
    expect(sent(fetch, 1).body).toHaveLength(50);
    // 第一批收下了；第二批失败，它和第三批留着下次发
    expect(readTelemetryQueue(dir)).toHaveLength(70);
  });

  it("doesn't put events back when turned off or reset while sending", async () => {
    for (const change of ["off", "reset"] as const) {
      const dir = tempDir();
      const { telemetry, fetch } = make({ dir, env: endpoint });
      telemetry.feature("code_panel");
      fetch.mockImplementationOnce(async () => {
        if (change === "off") telemetry.setEnabled(false);
        else telemetry.resetInstallId();
        throw new Error("offline");
      });
      await telemetry.flush();
      expect(readTelemetryQueue(dir)).toEqual([]);
    }
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
    telemetry.feature("code_panel");
    expect(telemetry.preview()?.[0]?.payload.id).toBe(after.installId);
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
    expect(sent(fetch).body[0]!.payload).toMatchObject({
      name: "update_result",
      data: { version: "0.4.8", runMode: "npm", kind: "npm", outcome: "success" },
    });
  });
});
