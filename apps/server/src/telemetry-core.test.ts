import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { docsUrl } from "@superhive/protocol";
import {
  QUEUE_LIMIT,
  TELEMETRY_DOCS_URL,
  TELEMETRY_EVENTS,
  appendTelemetryEvents,
  hourOf,
  readTelemetryQueue,
  readTelemetryState,
  resetTelemetryId,
  roomBucket,
  sanitizeEvent,
  setTelemetryEnabled,
  takeTelemetryQueue,
  telemetryBlocker,
  telemetryEndpoint,
  writeTelemetryState,
} from "./telemetry-core.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hive-telemetry-core-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const context = { version: "0.4.9", runMode: "npm", os: "darwin", arch: "arm64", locale: "zh-CN" };
const event = (
  props: Record<string, unknown> = { feature: "room_create" },
  name = "feature_first_used",
) => ({
  event: name,
  time: hourOf(Date.UTC(2026, 10, 28, 4, 37)),
  context,
  props,
});

describe("telemetry-core", () => {
  it("is byte-identical to the copy shipped in the superhive package", () => {
    const here = readFileSync(path.join(import.meta.dirname, "telemetry-core.ts"), "utf8");
    const cli = readFileSync(
      path.resolve(import.meta.dirname, "../../../packages/superhive/src/telemetry-core.ts"),
      "utf8",
    );
    expect(cli).toBe(here);
  });

  it("links to the same docs page as the web app", () => {
    expect(TELEMETRY_DOCS_URL).toBe(docsUrl("telemetry"));
  });
});

describe("telemetryBlocker", () => {
  it("reports nothing in an ordinary environment", () => {
    expect(telemetryBlocker({})).toBeUndefined();
    expect(
      telemetryBlocker({ SUPERHIVE_TELEMETRY: "1", DO_NOT_TRACK: "0", CI: "false" }),
    ).toBeUndefined();
  });

  it.each([
    [{ SUPERHIVE_TELEMETRY: "0" }, "env"],
    [{ SUPERHIVE_TELEMETRY: "off" }, "env"],
    [{ SUPERHIVE_TELEMETRY: "false" }, "env"],
    [{ DO_NOT_TRACK: "1" }, "do_not_track"],
    [{ DO_NOT_TRACK: "true" }, "do_not_track"],
    [{ CI: "true" }, "ci"],
    [{ CI: "1" }, "ci"],
    [{ GITHUB_ACTIONS: "true" }, "ci"],
    [{ GITLAB_CI: "true" }, "ci"],
    [{ BUILDKITE: "true" }, "ci"],
    [{ JENKINS_URL: "http://jenkins" }, "ci"],
    [{ HIVE_SANDBOX: "1" }, "sandbox"],
    [{ VITEST: "true" }, "test"],
    [{ NODE_ENV: "test" }, "test"],
  ])("turns statistics off for %o", (env, blocker) => {
    expect(telemetryBlocker(env)).toBe(blocker);
  });

  it("checks the explicit opt-out before anything else", () => {
    expect(telemetryBlocker({ SUPERHIVE_TELEMETRY: "0", CI: "true" })).toBe("env");
  });
});

describe("telemetryEndpoint", () => {
  it("has no built-in endpoint, so nothing is sent until one is configured", () => {
    expect(telemetryEndpoint({})).toBeUndefined();
  });

  it("accepts only http(s) addresses from the environment", () => {
    expect(telemetryEndpoint({ SUPERHIVE_TELEMETRY_URL: "https://stats.example.com/e" })).toBe(
      "https://stats.example.com/e",
    );
    expect(telemetryEndpoint({ SUPERHIVE_TELEMETRY_URL: "file:///etc/passwd" })).toBeUndefined();
    expect(telemetryEndpoint({ SUPERHIVE_TELEMETRY_URL: "not a url" })).toBeUndefined();
  });
});

describe("event whitelist", () => {
  it("keeps whitelisted fields and drops everything else", () => {
    const clean = sanitizeEvent(
      event(
        {
          kind: "agent_cli",
          outcome: "failure",
          reason: "timeout",
          target: "claude",
          action: "upgrade",
          // 不在白名单里的字段、报错原文、路径：一律去掉
          error: "EACCES: permission denied, open '/Users/rd/.npmrc'",
          path: "/Users/rd/project",
        },
        "update_result",
      ),
    );
    expect(clean?.props).toEqual({
      kind: "agent_cli",
      outcome: "failure",
      reason: "timeout",
      target: "claude",
      action: "upgrade",
    });
  });

  it("drops values outside the allowed set instead of passing free text", () => {
    const clean = sanitizeEvent(
      event({ kind: "npm", outcome: "failure", reason: "npm ERR! 404 Not Found" }, "update_result"),
    );
    expect(clean?.props).toEqual({ kind: "npm", outcome: "failure" });
  });

  it("drops the whole event when a required field is missing or wrong", () => {
    expect(sanitizeEvent(event({ feature: "/Users/rd/secret" }))).toBeUndefined();
    expect(sanitizeEvent(event({}))).toBeUndefined();
    expect(sanitizeEvent(event({ rooms: "many" }, "heartbeat"))).toBeUndefined();
  });

  it("drops unknown events, bad times and bad common fields", () => {
    expect(sanitizeEvent(event({ text: "hello" }, "message_sent"))).toBeUndefined();
    expect(sanitizeEvent({ ...event(), time: "2026-11-28T04:37:12.000Z" })).toBeUndefined();
    expect(
      sanitizeEvent({ ...event(), context: { ...context, version: "rd's build" } }),
    ).toBeUndefined();
    expect(
      sanitizeEvent({ ...event(), context: { ...context, os: "rd-macbook.local" } }),
    ).toBeUndefined();
    expect(
      sanitizeEvent({ ...event(), context: { ...context, hostname: "rd-macbook" } })?.context,
    ).toEqual(context);
  });

  it("keeps only known counter keys and caps the counts", () => {
    const clean = sanitizeEvent(
      event(
        { agents: { claude: 3, codex: 1000, "rd's-agent": 2, opencode: 0 }, rooms: "6-20" },
        "heartbeat",
      ),
    );
    expect(clean?.props).toEqual({ agents: { claude: 3, codex: 99 }, rooms: "6-20" });
  });

  it("lists only enums and counters (no free text fields)", () => {
    for (const fields of Object.values(TELEMETRY_EVENTS)) {
      for (const field of Object.values(fields)) expect(["enum", "counts"]).toContain(field.kind);
    }
  });

  it("buckets room counts", () => {
    expect([0, 1, 2, 5, 6, 20, 21, 300].map(roomBucket)).toEqual([
      "0",
      "1",
      "2-5",
      "2-5",
      "6-20",
      "6-20",
      "21+",
      "21+",
    ]);
  });
});

describe("local queue and state", () => {
  it("keeps at most QUEUE_LIMIT events, dropping the oldest", () => {
    const dir = tempDir();
    const many = Array.from({ length: QUEUE_LIMIT + 50 }, (_, index) =>
      event({ agents: { claude: index + 1 }, rooms: "1" }, "heartbeat"),
    );
    for (let index = 0; index < many.length; index += 25) {
      appendTelemetryEvents(dir, many.slice(index, index + 25));
    }
    const queued = readTelemetryQueue(dir);
    expect(queued).toHaveLength(QUEUE_LIMIT);
    expect((queued.at(-1)!.props.agents as Record<string, number>).claude).toBe(99);
    expect((queued[0]!.props.agents as Record<string, number>).claude).toBe(51);
  });

  it("filters events on the way in and skips corrupted lines", () => {
    const dir = tempDir();
    appendTelemetryEvents(dir, [event(), event({ feature: "secret" }), { nope: true }]);
    writeFileSync(path.join(dir, "queue.jsonl"), "{broken\n", { flag: "a" });
    appendTelemetryEvents(dir, [event({ feature: "code_panel" })]);
    expect(readTelemetryQueue(dir).map((item) => item.props.feature)).toEqual([
      "room_create",
      "code_panel",
    ]);
  });

  it("hands out each queued event once", () => {
    const dir = tempDir();
    appendTelemetryEvents(dir, [event()]);
    expect(takeTelemetryQueue(dir)).toHaveLength(1);
    expect(takeTelemetryQueue(dir)).toEqual([]);
    expect(readTelemetryQueue(dir)).toEqual([]);
  });

  it("turning off deletes what has not been sent; reset changes the ID and deletes it too", () => {
    const dir = tempDir();
    const { state } = readTelemetryState(dir);
    writeTelemetryState(dir, state);
    appendTelemetryEvents(dir, [event()]);
    const off = setTelemetryEnabled(dir, false);
    expect(off.enabled).toBe(false);
    expect(off.noticeShownAt).toBeDefined();
    expect(readTelemetryQueue(dir)).toEqual([]);

    setTelemetryEnabled(dir, true);
    appendTelemetryEvents(dir, [event()]);
    const reset = resetTelemetryId(dir);
    expect(reset.installId).not.toBe(state.installId);
    expect(readTelemetryState(dir).state.installId).toBe(reset.installId);
    expect(readTelemetryQueue(dir)).toEqual([]);
  });

  it("starts over with a fresh random ID when the state file is missing or corrupted", () => {
    const dir = tempDir();
    expect(readTelemetryState(dir).stored).toBe(false);
    writeFileSync(path.join(dir, "state.json"), "{ not json");
    const { state, stored } = readTelemetryState(dir);
    expect(stored).toBe(false);
    expect(state.installId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
