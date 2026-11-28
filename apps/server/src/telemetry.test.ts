import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
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

const endpoint = { SUPERHIVE_TELEMETRY_URL: "https://stats.example.com" };
const batchUrl = "https://stats.example.com/api/batch";
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

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
    // 有人发消息后的定时器默认不让它跑：用例里自己调 heartbeat()
    activityDelayMs: DAY,
    ...options,
  });
  instances.push(telemetry);
  return {
    telemetry,
    fetch,
    advance: (ms: number) => {
      now += ms;
    },
    /** 有人发了消息，当天的心跳随即定下来（不等定时器） */
    speak: () => {
      telemetry.humanMessage();
      telemetry.heartbeat();
    },
  };
}

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
  it("is on by default and, running from source, records locally but never sends", async () => {
    const log = vi.fn();
    const { telemetry, fetch, speak } = make({ runMode: "source", log });
    telemetry.start();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("running from source"));
    expect(telemetry.status()).toMatchObject({
      active: true,
      enabled: true,
      endpoint: false,
      noticePending: true,
    });
    telemetry.feature("room_create");
    speak();
    await telemetry.flush();
    expect(fetch).not.toHaveBeenCalled();
    expect(telemetry.status().queued).toBe(2);
    // 预览就是要发给 Umami 的请求体
    const payload = telemetry.preview()!;
    expect(payload).toHaveLength(2);
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
          runMode: "source",
          feature: "room_create",
        }),
      },
    });
  });

  it.each(["npm", "desktop"] as const)(
    "installed as %s, sends to the project's own Umami without any configuration",
    async (runMode) => {
      const { telemetry, fetch, speak } = make({ runMode });
      expect(telemetry.status().endpoint).toBe(true);
      speak();
      await telemetry.flush();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(sent(fetch).url).toBe("https://60.205.92.58/api/batch");
      expect(sent(fetch).body[0]!.payload.data).toMatchObject({ runMode });
    },
  );

  it("sends from source only to an explicitly configured endpoint", async () => {
    const { telemetry, fetch, speak } = make({ runMode: "source", env: endpoint });
    expect(telemetry.status().endpoint).toBe(true);
    speak();
    await telemetry.flush();
    expect(sent(fetch).url).toBe(batchUrl);
  });

  it("does not fall back to the built-in endpoint when SUPERHIVE_TELEMETRY_URL is wrong", async () => {
    const log = vi.fn();
    const { telemetry, fetch, speak } = make({
      env: { SUPERHIVE_TELEMETRY_URL: "stats.example.com" },
      log,
    });
    telemetry.start();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("not an http(s) URL"));
    speak();
    await telemetry.flush();
    expect(fetch).not.toHaveBeenCalled();
    expect(telemetry.status()).toMatchObject({ endpoint: false, queued: 1 });
  });

  it("uses the website ID from SUPERHIVE_TELEMETRY_SITE", () => {
    const site = "0f8c2a4e-1b3d-4e5f-8a9b-0c1d2e3f4a5b";
    const { telemetry } = make({ env: { SUPERHIVE_TELEMETRY_SITE: site } });
    telemetry.feature("room_create");
    expect(telemetry.preview()![0]!.payload.website).toBe(site);
  });

  it("posts Umami's batch format with a SuperHive User-Agent and empties the queue", async () => {
    const log = vi.fn();
    const { telemetry, fetch, speak } = make({ env: endpoint, log });
    telemetry.feature("invite_member");
    speak();
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
      data: { agents_claude: 2, agents_codex: 1, rooms: "2-5", active: "yes" },
    });
    expect(telemetry.status().queued).toBe(0);
    expect(log).toHaveBeenCalledWith("Usage statistics sent (2 of 2 event(s) accepted)");
  });

  it("sends at most once a day, and only together with a heartbeat", async () => {
    const dir = tempDir();
    const { telemetry, fetch, advance, speak } = make({ dir, env: endpoint });
    // 只有功能事件、心跳还没定下来：不发（这次没发，也不能耽误后面该发的）
    telemetry.feature("room_create");
    telemetry.heartbeat();
    await telemetry.flush();
    expect(fetch).not.toHaveBeenCalled();
    // 预览里能看到待定的心跳
    expect(telemetry.status().queued).toBe(2);
    expect(telemetry.preview()!.map((item) => item.payload.data)).toEqual([
      expect.objectContaining({ feature: "room_create" }),
      expect.objectContaining({ rooms: "2-5", active: "no" }),
    ]);

    speak();
    await telemetry.flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sent(fetch).body.map((item) => item.payload.data)).toEqual([
      expect.objectContaining({ feature: "room_create" }),
      expect.objectContaining({ active: "yes" }),
    ]);

    // 当天再有事件、再查几次：都留到明天
    telemetry.feature("code_panel");
    telemetry.record("update_result", { kind: "npm", outcome: "success" });
    for (let hour = 0; hour < 5; hour += 1) {
      advance(HOUR);
      speak();
      await telemetry.flush();
    }
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(readTelemetryQueue(dir)).toHaveLength(2);

    // 第二天有人发消息：新一天的心跳和昨天留下的一起发
    advance(DAY);
    speak();
    await telemetry.flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sent(fetch, 1).body.map((item) => item.payload.name)).toEqual([
      "feature_first_used",
      "update_result",
      "heartbeat",
    ]);
  });

  it("settles a day nobody spoke as active=no once it is over, and sends it then", async () => {
    const { telemetry, fetch, advance } = make({ env: endpoint });
    telemetry.heartbeat();
    advance(10 * HOUR);
    telemetry.heartbeat();
    await telemetry.flush();
    expect(fetch).not.toHaveBeenCalled();

    advance(DAY);
    telemetry.heartbeat();
    await telemetry.flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [heartbeat] = sent(fetch).body;
    // 记在那天第一次看到的整点上
    expect(heartbeat!.payload).toMatchObject({
      name: "heartbeat",
      timestamp: Date.UTC(2026, 10, 28, 4) / 1000,
      data: { active: "no" },
    });
    expect(sent(fetch).body).toHaveLength(1);
    // 新的一天又是待定
    expect(telemetry.preview()!.map((item) => item.payload.data)).toEqual([
      expect.objectContaining({ active: "no" }),
    ]);
  });

  it("settles the heartbeat a minute after the day's first message and sends it", async () => {
    const dir = tempDir();
    const { telemetry, fetch } = make({ dir, env: endpoint, activityDelayMs: 0 });
    telemetry.heartbeat();
    telemetry.humanMessage();
    telemetry.humanMessage();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(sent(fetch).body.map((item) => item.payload.data)).toEqual([
      expect.objectContaining({ active: "yes" }),
    ]);
    expect(readTelemetryState(dir).state).toMatchObject({
      heartbeatDay: "2026-11-28",
      activeDay: "2026-11-28",
      sentDay: "2026-11-28",
    });
    expect(readTelemetryState(dir).state).not.toHaveProperty("pendingHeartbeat");
  });

  it("only remembers the day someone spoke, not how many messages", () => {
    const dir = tempDir();
    const { telemetry } = make({ dir });
    telemetry.status();
    const before = statSync(path.join(dir, "state.json")).mtimeMs;
    telemetry.humanMessage();
    const after = statSync(path.join(dir, "state.json")).mtimeMs;
    for (let index = 0; index < 20; index += 1) telemetry.humanMessage();
    expect(statSync(path.join(dir, "state.json")).mtimeMs).toBe(after);
    expect(after).toBeGreaterThanOrEqual(before);
    const raw = JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8")) as object;
    expect(raw).toMatchObject({ activeDay: "2026-11-28" });
    expect(Object.values(raw)).not.toContain(21);
  });

  it("picks up a heartbeat an earlier run left pending", async () => {
    const dir = tempDir();
    // 这天开着、没人发消息就关了
    const first = make({ dir });
    first.telemetry.heartbeat();
    first.telemetry.close();
    // 这天有人发了消息，没等心跳定下来就关了
    const second = make({ dir });
    second.advance(DAY);
    second.telemetry.heartbeat();
    second.telemetry.humanMessage();
    second.telemetry.close();
    // 几天后再开
    const third = make({ dir });
    third.advance(4 * DAY);
    third.telemetry.heartbeat();
    expect(
      readTelemetryQueue(dir).map((item) => [item.time.slice(0, 10), item.props.active]),
    ).toEqual([
      ["2026-11-28", "no"],
      ["2026-11-29", "yes"],
    ]);
    expect(readTelemetryState(dir).state.pendingHeartbeat?.time.slice(0, 10)).toBe("2026-12-02");
  });

  it("keeps what did not go out for the next day", async () => {
    const { telemetry, fetch, advance, speak } = make({ env: endpoint });
    fetch.mockRejectedValueOnce(new Error("offline"));
    telemetry.feature("code_panel");
    speak();
    await telemetry.flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(telemetry.status().queued).toBe(2);
    // 当天不再试
    advance(HOUR);
    await telemetry.flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    // 第二天：哪怕还没人发消息，昨天的心跳也在队列里，照常发
    advance(DAY);
    telemetry.heartbeat();
    await telemetry.flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sent(fetch, 1).body.map((item) => item.payload.name)).toEqual([
      "feature_first_used",
      "heartbeat",
    ]);
    expect(telemetry.status().queued).toBe(1);
  });

  it.each([500, 502, 503, 429, 408])(
    "keeps the events when the service answers %i",
    async (code) => {
      const { telemetry, fetch, speak } = make({ env: endpoint });
      fetch.mockResolvedValueOnce(new Response("busy", { status: code }));
      speak();
      await telemetry.flush();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(telemetry.status().queued).toBe(1);
    },
  );

  it("drops what the service rejects outright instead of sending it again", async () => {
    const { telemetry, fetch, speak } = make({ env: endpoint });
    fetch.mockResolvedValueOnce(Response.json({ error: "Bad request" }, { status: 400 }));
    speak();
    await telemetry.flush();
    expect(telemetry.status().queued).toBe(0);
  });

  it("keeps the events when Umami accepted none of them, but drops ones it rejected", async () => {
    const dir = tempDir();
    const { telemetry, fetch, advance, speak } = make({ dir, env: endpoint });
    fetch.mockResolvedValueOnce(Response.json({ size: 2, processed: 0, errors: 2, details: [] }));
    telemetry.feature("code_panel");
    speak();
    await telemetry.flush();
    expect(telemetry.status().queued).toBe(2);

    advance(DAY);
    fetch.mockResolvedValueOnce(Response.json({ size: 2, processed: 1, errors: 1, details: [] }));
    await telemetry.flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(readTelemetryQueue(dir)).toEqual([]);
  });

  it("sends everything queued in a single request", async () => {
    const dir = tempDir();
    const { telemetry, fetch, speak } = make({ dir, env: endpoint });
    for (let index = 0; index < 120; index += 1)
      telemetry.record("update_result", { kind: "npm", outcome: "success" });
    speak();
    await telemetry.flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sent(fetch).body).toHaveLength(121);
    expect(readTelemetryQueue(dir)).toEqual([]);
  });

  it("doesn't put events back when turned off or reset while sending", async () => {
    for (const change of ["off", "reset"] as const) {
      const dir = tempDir();
      const { telemetry, fetch, speak } = make({ dir, env: endpoint });
      telemetry.feature("code_panel");
      speak();
      fetch.mockImplementationOnce(async () => {
        if (change === "off") telemetry.setEnabled(false);
        else telemetry.resetInstallId();
        throw new Error("offline");
      });
      await telemetry.flush();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(readTelemetryQueue(dir)).toEqual([]);
    }
  });

  it("records nothing and creates no files when blocked by the environment", async () => {
    for (const env of [
      { SUPERHIVE_TELEMETRY: "0", ...endpoint },
      { DO_NOT_TRACK: "1", ...endpoint },
      { CI: "true", ...endpoint },
      { NODE_ENV: "test", ...endpoint },
    ]) {
      const dir = tempDir();
      const { telemetry, fetch, speak } = make({ dir, env });
      telemetry.start();
      telemetry.feature("room_create");
      speak();
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
    const dir = tempDir();
    const { telemetry, fetch, speak } = make({ dir, env: endpoint });
    telemetry.feature("room_create");
    telemetry.heartbeat();
    expect(telemetry.setEnabled(false)).toMatchObject({ active: false, enabled: false, queued: 0 });
    expect(readTelemetryState(dir).state).not.toHaveProperty("pendingHeartbeat");
    telemetry.feature("code_panel");
    speak();
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
    telemetry.humanMessage();
    expect(readTelemetryQueue(dir)).toEqual([]);
    expect(readTelemetryState(dir).state).not.toHaveProperty("activeDay");
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

  it("records one heartbeat per day with agent counts, a room bucket and whether anyone spoke", () => {
    const dir = tempDir();
    const { telemetry, advance, speak } = make({ dir });
    speak();
    speak();
    advance(HOUR);
    telemetry.heartbeat();
    expect(readTelemetryQueue(dir).map(({ event, props }) => ({ event, props }))).toEqual([
      {
        event: "heartbeat",
        props: { agents: { claude: 2, codex: 1 }, rooms: "2-5", active: "yes" },
      },
    ]);
    advance(DAY);
    speak();
    expect(readTelemetryQueue(dir).map((event) => event.event)).toEqual(["heartbeat", "heartbeat"]);
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
    telemetry.heartbeat();
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
    const { telemetry, fetch, speak } = make({ dir, env: endpoint });
    telemetry.status();
    appendTelemetryEvents(dir, [
      {
        event: "update_result",
        time: hourOf(Date.now()),
        context: { version: "0.4.8", runMode: "npm", os: "linux", arch: "x64", locale: "en" },
        props: { kind: "npm", outcome: "success" },
      },
    ]);
    speak();
    await telemetry.flush();
    expect(sent(fetch).body[0]!.payload).toMatchObject({
      name: "update_result",
      data: { version: "0.4.8", runMode: "npm", kind: "npm", outcome: "success" },
    });
  });
});
