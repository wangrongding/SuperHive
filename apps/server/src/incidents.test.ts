import Database from "better-sqlite3";
import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import type { Invocation, ServerText } from "@superhive/protocol";
import {
  classifyClientError,
  classifyInvocation,
  classifyProtocolError,
  classifyServerError,
  invocationOrigin,
  normalizeMessage,
  redact,
  registerIncidentSecret,
  stackFrames,
  type IncidentOccurrence,
} from "./incidents.js";
import { IncidentStore } from "./incident-store.js";
import {
  DISPATCH_TIMEOUT_MS,
  IncidentDesk,
  incidentShortId,
  protectedChanges,
  type IncidentDeskDeps,
} from "./incident-desk.js";

const BASE = Date.parse("2026-11-22T02:00:00.000Z");

function invocation(patch: Partial<Invocation> = {}): Invocation {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    roomId: "build",
    messageId: "22222222-2222-4222-8222-222222222222",
    agentId: "agent-1",
    agentName: "rd-codex",
    requesterId: "human-1",
    requesterName: "rd",
    requesterType: "human",
    status: "timed_out",
    attempts: 1,
    createdAt: new Date(BASE).toISOString(),
    updatedAt: new Date(BASE).toISOString(),
    detail: "Agent 在线却没有确认收到",
    detailText: { key: "invocation.unacknowledged" },
    ...patch,
  } as Invocation;
}

function serverOccurrence(stackFile = "apps/server/src/app.ts"): IncidentOccurrence {
  const error = new TypeError("Cannot read properties of undefined (reading 'id')");
  error.stack = `TypeError: Cannot read properties of undefined (reading 'id')\n    at handleReport (/repo/${stackFile}:3130:20)\n    at Socket.<anonymous> (/repo/apps/server/src/app.ts:5700:11)`;
  return classifyServerError(error, { route: "ws invocation.report", codeVersion: "abc" });
}

describe("incident classification", () => {
  it("tells external failures from ours by the bridge's reason key", () => {
    expect(invocationOrigin("bridge.upstreamFailed")).toBe("external");
    expect(invocationOrigin("bridge.modelFailed")).toBe("external");
    expect(invocationOrigin("bridge.crashedMidTurn")).toBe("external");
    expect(invocationOrigin("invocation.stale")).toBe("internal");
    expect(invocationOrigin("bridge.steerEndRace")).toBe("internal");
    // 新键、旧版 Bridge 的中文说明：说不清是谁的，只记不派
    expect(invocationOrigin("bridge.somethingNew")).toBe("unknown");
    expect(invocationOrigin(undefined)).toBe("unknown");
    // 按设计如此的不算故障
    expect(invocationOrigin("bridge.beyondCatchUp")).toBeUndefined();
  });

  it("fingerprints an invocation failure by reason and runtime, and skips non-failures", () => {
    const occurrence = classifyInvocation(invocation(), { provider: "codex", codeVersion: "abc" });
    expect(occurrence).toMatchObject({
      origin: "internal",
      source: "invocation",
      fingerprint: "invocation:invocation.unacknowledged:codex",
      sample: {
        agentName: "rd-codex",
        provider: "codex",
        invocationId: "11111111-1111-4111-8111-111111111111",
        codeVersion: "abc",
      },
    });
    // 重试后是新的一次
    expect(classifyInvocation(invocation({ attempts: 2 }), {})!.ref).not.toBe(occurrence!.ref);
    expect(classifyInvocation(invocation({ status: "completed" }), {})).toBeUndefined();
    expect(
      classifyInvocation(
        invocation({
          resolution: { kind: "dismissed", at: new Date(BASE).toISOString() },
        } as Partial<Invocation>),
        {},
      ),
    ).toBeUndefined();
    const upstream = classifyInvocation(
      invocation({
        detailText: { key: "bridge.upstreamFailed", params: { reason: "529 overloaded", why: "" } },
      }),
      { provider: "claude" },
    )!;
    expect(upstream.origin).toBe("external");
    // 标题只取说明的第一句，不带「点继续……」这类处理建议
    expect(upstream.title).toBe("claude · 上游模型服务出错");
  });

  it("files upstream failures apart by the failure kind the bridge reported", () => {
    const upstream = (failure: Invocation["failure"]) =>
      classifyInvocation(
        invocation({
          status: "failed",
          detailText: { key: "bridge.upstreamFailed", params: { reason: "x", why: "" } },
          ...(failure ? { failure } : {}),
        }),
        { provider: "claude" },
      )!;
    expect(upstream("rate_limited")).toMatchObject({
      origin: "external",
      fingerprint: "invocation:bridge.upstreamFailed:rate_limited:claude",
      title: "claude · 上游模型服务出错（rate_limited）",
    });
    expect(upstream("quota").fingerprint).toBe("invocation:bridge.upstreamFailed:quota:claude");
    // 请求被拒说不清是谁的：可能是运行时或我们拼的请求有问题，记下来不自动派修
    expect(upstream("invalid_request").origin).toBe("unknown");
    // 旧版 Bridge 不报失败原因：照旧按说明键归类
    expect(upstream(undefined)).toMatchObject({
      origin: "external",
      fingerprint: "invocation:bridge.upstreamFailed:claude",
    });
  });

  it("counts a failed task workspace check as ours, apart from other uncertain or unsafe turns", () => {
    const verify =
      "这一轮已执行完，但没能复核任务目录（Cannot safely select the task workspaces; confirm before retrying: Cannot verify managed task workspace (401): Online local agent required）。";
    const uncertain = classifyInvocation(
      invocation({ detailText: { key: "bridge.uncertain", params: { reason: verify } } }),
      { provider: "claude" },
    )!;
    expect(uncertain).toMatchObject({
      origin: "internal",
      fingerprint: "invocation:bridge.uncertain:workspace-check:claude",
    });
    const unsafe = classifyInvocation(
      invocation({
        status: "failed",
        detailText: {
          key: "bridge.unsafe",
          params: {
            reason:
              "Cannot safely select the task workspace; confirm before retrying: Cannot verify managed task workspace (401): Online local agent required",
          },
        },
      }),
      { provider: "claude" },
    )!;
    expect(unsafe).toMatchObject({
      origin: "internal",
      fingerprint: "invocation:bridge.unsafe:workspace-check:claude",
    });
    // 同键别的原因照旧：CLI 找不到算外部，模型断流说不清
    const missing = classifyInvocation(
      invocation({
        status: "failed",
        detailText: { key: "bridge.unsafe", params: { reason: "找不到 Codex 命令" } },
      }),
      { provider: "codex" },
    )!;
    expect(missing).toMatchObject({
      origin: "external",
      fingerprint: "invocation:bridge.unsafe:codex",
    });
    expect(
      classifyInvocation(
        invocation({ detailText: { key: "bridge.uncertain", params: { reason: "流中断。" } } }),
        { provider: "claude" },
      )!.origin,
    ).toBe("unknown");
  });

  it("keeps the fingerprint stable across line numbers, machines and bundle hashes", () => {
    const a = new Error("boom 42 at /Users/alice/repo/x.ts");
    a.stack =
      "Error: boom\n    at run (/Users/alice/repo/apps/server/src/worktrees.ts:10:5)\n    at node:internal/process/task_queues:95:5";
    const b = new Error("boom 7 at /Users/bob/other/x.ts");
    b.stack = "Error: boom\n    at run (/home/bob/hive/apps/server/src/worktrees.ts:99:1)";
    expect(classifyServerError(a, { route: "GET /x" }).fingerprint).toBe(
      classifyServerError(b, { route: "GET /x" }).fingerprint,
    );
    expect(stackFrames(a.stack)).toEqual(["run@apps/server/src/worktrees.ts"]);
    expect(
      stackFrames("TypeError: x\nrender@http://localhost:5173/assets/index-AbC123xy.js:1:200"),
    ).toEqual(["render@index.js"]);
    expect(normalizeMessage("room 3f2a9c1e-1111-4111-8111-111111111111 has 12 items")).toBe(
      "room <id> has <n> items",
    );
  });

  it("strips the home directory from details and stacks", () => {
    const home = homedir();
    const error = new Error(`ENOENT: ${home}/secret/file`);
    error.stack = `Error: x\n    at f (${home}/repo/apps/server/src/a.ts:1:1)`;
    const occurrence = classifyServerError(error, { route: "GET /x" });
    expect(occurrence.sample.detail).not.toContain(home);
    expect(occurrence.sample.stack).not.toContain(home);
  });

  it("classifies protocol and web errors as ours, without event content", () => {
    const protocol = classifyProtocolError(
      "invocation.report",
      [
        { code: "invalid_enum_value", path: ["status"] },
        { code: "too_big", path: ["usage", "requests"] },
      ],
      { roomId: "build", agentName: "rd-codex" },
    );
    expect(protocol).toMatchObject({
      origin: "internal",
      source: "protocol",
      fingerprint: "protocol:invocation.report:status:invalid_enum_value,usage.requests:too_big",
    });
    const web = classifyClientError(
      {
        kind: "error",
        name: "TypeError",
        message: "x is undefined",
        stack:
          "TypeError: x is undefined\n    at Panel (http://localhost:5173/assets/index-Zz91kk2a.js:3:10)",
        url: "http://localhost:5173/rooms/build?token=secret#x",
      },
      { roomId: "build" },
    );
    expect(web).toMatchObject({
      origin: "internal",
      source: "web",
      fingerprint: "web:error:TypeError:Panel@index.js",
      sample: { url: "http://localhost:5173/rooms/build" },
    });
  });

  it("files no incident for Vite dev-server noise, but keeps production errors", () => {
    const report = (stack: string) =>
      classifyClientError({ kind: "error", name: "TypeError", message: "boom", stack }, {});
    // 热更新替换过的模块（改到一半的代码、Hook 顺序对不上）
    expect(
      report(
        "ReferenceError: Button is not defined\n    at Composer (http://localhost:5188/src/composer.tsx?t=1795578227463:661:43)\n    at renderWithHooks (http://localhost:5188/node_modules/.vite/deps/react-dom_client.js?v=7c706b7b:4398:19)",
      ),
    ).toBeUndefined();
    // 依赖重新预构建：页面里混着两份 React
    expect(
      report(
        "TypeError: Cannot read properties of null (reading 'useRef')\n    at exports.useRef (http://localhost:5188/node_modules/.vite/deps/react-BBoXEtLn.js?v=3619afb2:766:30)\n    at RichComposer (http://localhost:5188/src/rich-composer.tsx:131:19)\n    at renderWithHooks (http://localhost:5188/node_modules/.vite/deps/react-dom_client.js?v=7c706b7b:4398:19)",
      ),
    ).toBeUndefined();
    // 同一份预构建依赖、没被热更新过的源码：真实的报错照常记
    expect(
      report(
        "TypeError: boom\n    at RichComposer (http://localhost:5188/src/rich-composer.tsx:131:19)\n    at renderWithHooks (http://localhost:5188/node_modules/.vite/deps/react-dom_client.js?v=7c706b7b:4398:19)\n    at x (http://localhost:5188/node_modules/.vite/deps/react-BBoXEtLn.js?v=7c706b7b:1:1)",
      ),
    ).toMatchObject({ source: "web" });
    expect(
      report("TypeError: boom\n    at Panel (http://127.0.0.1:8787/assets/index-Zz91kk2a.js:3:10)"),
    ).toMatchObject({ source: "web" });
  });

  it("files no incident when the server itself ended the agent mid-turn", () => {
    for (const key of [
      "invocation.interruptedAgentStopped",
      "invocation.interruptedAgentRestarted",
      "invocation.interruptedAgentRemoved",
      "invocation.interruptedServerStopped",
    ]) {
      expect(invocationOrigin(key)).toBeUndefined();
      expect(
        classifyInvocation(invocation({ status: "failed", detailText: { key } }), {}),
      ).toBeUndefined();
    }
  });
});

describe("credential redaction", () => {
  it.each([
    ["Bearer header", "request failed: Authorization: Bearer abc123def456ghi", "abc123def456ghi"],
    ["Basic header", "Authorization: Basic dXNlcjpwYXNzd29yZA==", "dXNlcjpwYXNzd29yZA=="],
    ["sk- key", "upstream rejected key sk-ant-api03-AbCdEf123456", "sk-ant-api03-AbCdEf123456"],
    ["GitHub token", "push failed with ghp_1234567890abcdefABCDEF", "ghp_1234567890abcdefABCDEF"],
    [
      "GitHub PAT",
      "token github_pat_11ABCDEFG0123456789_abcdef",
      "github_pat_11ABCDEFG0123456789_abcdef",
    ],
    ["Slack token", "slack said no to xoxb-1234-5678-abcdefgh", "xoxb-1234-5678-abcdefgh"],
    [
      "JWT",
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
    ],
    [
      "URL user and password",
      "fetch https://alice:hunter2pass@git.example.com/repo",
      "hunter2pass",
    ],
    [
      "token query",
      "GET http://127.0.0.1:8787/api/x?room=build&token=hvs_abcdef123456",
      "hvs_abcdef123456",
    ],
    ["key query", "GET https://api.example.com/v1?api_key=AKIA1234567890", "AKIA1234567890"],
    [
      "signature query",
      "https://s3.example.com/f?X-Amz-Signature=deadbeefcafe0011",
      "deadbeefcafe0011",
    ],
    ["JSON token field", '{"token": "hvi_supersecretvalue1"}', "hvi_supersecretvalue1"],
    ["owner header", "x-hive-owner: 0123456789abcdef0123", "0123456789abcdef0123"],
    ["password assignment", "password=correct-horse-battery", "correct-horse-battery"],
  ])("removes a %s", (_label, text, secret) => {
    const cleaned = redact(text);
    expect(cleaned).not.toContain(secret);
    expect(cleaned).toContain("<secret>");
  });

  it("replaces this server's own tokens by their exact value", () => {
    const token = "f00dfeedcafebabe1234";
    registerIncidentSecret(token);
    expect(redact(`unexpected ${token} in body`)).toBe("unexpected <secret> in body");
  });

  it("keeps one fingerprint for the same error with different credentials", () => {
    const a = classifyServerError(new Error("auth failed for Bearer aaaaaaaaaaaa"), { route: "x" });
    const b = classifyServerError(new Error("auth failed for Bearer bbbbbbbbbbbb"), { route: "x" });
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.title).not.toContain("aaaaaaaaaaaa");
    expect(a.sample.detail).not.toContain("aaaaaaaaaaaa");
  });

  it("redacts parameters of structured invocation details", () => {
    const occurrence = classifyInvocation(
      invocation({
        detailText: {
          key: "bridge.upstreamFailed",
          params: { reason: "401 for sk-live-0123456789abcdef", why: "" },
        },
      }),
      {},
    )!;
    expect(JSON.stringify(occurrence.sample)).not.toContain("sk-live-0123456789abcdef");
  });
});

describe("incident store", () => {
  it("merges occurrences by fingerprint, keeps the latest samples and ignores repeats", () => {
    let now = BASE;
    const store = new IncidentStore(new Database(":memory:"), () => now);
    const occurrence = classifyInvocation(invocation(), { provider: "codex" })!;
    const first = store.record(occurrence);
    expect(first).toMatchObject({ created: true, incident: { count: 1, status: "open" } });
    expect(store.record(occurrence)).toBe("duplicate");
    for (let attempt = 2; attempt <= 7; attempt++) {
      now += 1000;
      store.record(classifyInvocation(invocation({ attempts: attempt }), { provider: "codex" })!);
    }
    const [incident] = store.list();
    expect(incident).toMatchObject({ count: 7, recentCount: 7 });
    expect(incident!.samples).toHaveLength(5);
  });
});

type Sent = { roomId: string; requester: string; agent: string; text: ServerText };

function desk(
  options: {
    settings?: Record<string, unknown>;
    running?: string | undefined;
    changed?: Array<{ status: string; file: string }> | undefined;
    contains?: boolean;
    invocations?: Map<string, Invocation>;
  } = {},
) {
  let now = BASE;
  const settings = new Map<string, string>();
  settings.set(
    "incidents",
    JSON.stringify({
      autoDispatch: true,
      roomId: "build",
      requester: "rd",
      fixer: "rd-claude2",
      reviewer: "rd-claude",
      ...options.settings,
    }),
  );
  const dispatched: Sent[] = [];
  const notices: ServerText[] = [];
  const invocations = options.invocations ?? new Map<string, Invocation>();
  const store = new IncidentStore(new Database(":memory:"), () => now);
  let contains = options.contains ?? false;
  const deps: IncidentDeskDeps = {
    store,
    readSetting: (key) => settings.get(key),
    writeSetting: (key, value) => settings.set(key, value),
    now: () => now,
    runningCommit: "running" in options ? options.running : "a".repeat(40),
    git: {
      containsFix: async () => contains,
      changedFiles: async () =>
        "changed" in options ? options.changed : [{ status: "M", file: "apps/server/src/app.ts" }],
    },
    dispatch: (input) => {
      dispatched.push(input);
      const id = `inv-${dispatched.length}`;
      invocations.set(id, invocation({ id, status: "running", detailText: undefined }));
      return { invocationId: id, messageId: `msg-${dispatched.length}` };
    },
    notify: (input) => notices.push(input.text),
    getInvocation: (id) => invocations.get(id),
    changed: () => undefined,
  };
  const instance = new IncidentDesk(deps);
  return {
    desk: instance,
    store,
    dispatched,
    notices,
    invocations,
    advance: (ms: number) => (now += ms),
    setContains: (value: boolean) => (contains = value),
  };
}

function hit(target: ReturnType<typeof desk>, times: number, file?: string) {
  let incident;
  for (let index = 0; index < times; index++) {
    target.advance(1000);
    incident = target.desk.record({ ...serverOccurrence(file), ref: `hit-${Math.random()}` });
  }
  return incident!;
}

describe("incident desk", () => {
  it("dispatches an internal incident once it reaches the threshold, with lessons and guard rails", () => {
    const target = desk();
    expect(hit(target, 2).status).toBe("open");
    expect(target.dispatched).toHaveLength(0);
    const incident = hit(target, 1);
    expect(incident.status).toBe("fixing");
    expect(target.dispatched).toHaveLength(1);
    const sent = target.dispatched[0]!;
    expect(sent).toMatchObject({ roomId: "build", requester: "rd", agent: "rd-claude2" });
    expect(sent.text.key).toBe("incident.dispatch");
    expect(sent.text.params).toMatchObject({ short: incidentShortId(incident.id), attempt: 1 });
    expect(String(sent.text.params!.protected)).toContain("apps/server/src/agent-instructions.ts");
    expect(String(sent.text.params!.scene)).toContain("handleReport");
    // 修着的时候再出现只计数，不重复派
    hit(target, 3);
    expect(target.dispatched).toHaveLength(1);
  });

  it("keeps credentials out of the dispatch message", () => {
    const target = desk({ settings: { threshold: 1 } });
    const token = "0wnerT0kenValue9876";
    const error = new Error(`boom with x-hive-owner: hdr-secret-123 and ${token}`);
    error.stack = `Error: boom\n    at f (/repo/apps/server/src/a.ts:1:1)\n    at g (http://h/x?token=query-secret-456)`;
    const occurrence = classifyServerError(error, { route: "GET /x" });
    // 令牌在归档之后才登记，发出前那一遍也要能抹掉
    registerIncidentSecret(token);
    occurrence.sample.detail = `${occurrence.sample.detail} ${token}`;
    target.desk.record(occurrence);
    const sent = JSON.stringify(target.dispatched[0]!.text);
    expect(sent).not.toContain("hdr-secret-123");
    expect(sent).not.toContain("query-secret-456");
    expect(sent).not.toContain(token);
    expect(sent).toContain("<secret>");
  });

  it("never dispatches external or unknown failures, and stays quiet when switched off", () => {
    const external = desk();
    for (let attempt = 1; attempt <= 5; attempt++) {
      external.desk.record(
        classifyInvocation(
          invocation({ attempts: attempt, detailText: { key: "bridge.upstreamFailed" } }),
          {},
        )!,
      );
    }
    expect(external.dispatched).toHaveLength(0);
    const off = desk({ settings: { autoDispatch: false } });
    hit(off, 5);
    expect(off.dispatched).toHaveLength(0);
    // 不是从源码仓库跑的：修了也核对不了，不派
    const packaged = desk({ running: undefined });
    hit(packaged, 5);
    expect(packaged.dispatched).toHaveLength(0);
  });

  it("respects the daily dispatch limit", () => {
    const target = desk({ settings: { dailyLimit: 1, threshold: 1 } });
    hit(target, 1, "apps/server/src/a.ts");
    hit(target, 1, "apps/server/src/b.ts");
    expect(target.dispatched).toHaveLength(1);
    expect(target.desk.snapshot().dispatchedToday).toBe(1);
  });

  it("records a reported fix as a lesson and resolves it once the fix is in the running code", async () => {
    const target = desk({ settings: { threshold: 1 } });
    const incident = hit(target, 1);
    await expect(
      target.desk.report({ roomId: "build", agentName: "rd-codex" }, incident.id, {
        status: "failed",
        reason: "x",
      }),
    ).rejects.toMatchObject({ code: "INCIDENT_NOT_ASSIGNED" });
    const reported = await target.desk.report(
      { roomId: "build", agentName: "RD-Claude2" },
      incident.id,
      {
        status: "fixed",
        commit: "b".repeat(40),
        branch: "fix/incident",
        symptom: "调用卡住",
        cause: "没处理 undefined",
        fix: "先判空",
      },
    );
    expect(reported.incident.status).toBe("fix_submitted");
    expect(target.store.lessons()).toMatchObject([{ symptom: "调用卡住", verified: false }]);
    // 还没合入：再出现只计数
    hit(target, 2);
    expect(target.store.get(incident.id)!.status).toBe("fix_submitted");
    target.setContains(true);
    await target.desk.sweep();
    expect(target.store.get(incident.id)).toMatchObject({ status: "resolved" });
    expect(target.store.lessons()[0]!.verified).toBe(true);

    // 修好后又出现：重新打开、提醒人考虑回滚，再派一次（第 2 次就到上限，升级给人）
    const again = hit(target, 1);
    expect(target.notices.map((text) => text.key)).toContain("incident.recurred");
    expect(again.reopenedCount).toBe(1);
    expect(target.store.lessons()[0]!.verified).toBe(false);
  });

  it("escalates to a person after the configured number of failed attempts", async () => {
    const target = desk({ settings: { threshold: 1, maxAttempts: 2 } });
    const incident = hit(target, 1);
    await target.desk.report({ roomId: "build", agentName: "rd-claude2" }, incident.id, {
      status: "failed",
      reason: "复现不了",
    });
    expect(target.store.get(incident.id)).toMatchObject({ status: "open", failedAttempts: 1 });
    // 再派一次，这次调用失败了
    hit(target, 1);
    expect(target.dispatched).toHaveLength(2);
    target.invocations.set("inv-2", invocation({ id: "inv-2", status: "failed" }));
    await target.desk.sweep();
    expect(target.store.get(incident.id)).toMatchObject({ status: "escalated", failedAttempts: 2 });
    expect(target.notices.map((text) => text.key)).toContain("incident.escalated");
    expect(target.desk.attention()).toBe(1);
    // 升级后不再自动派
    hit(target, 3);
    expect(target.dispatched).toHaveLength(2);
    // 房主重新打开：清零修失败次数，自动修复重新有机会
    target.desk.act(incident.id, "reopen");
    expect(target.store.get(incident.id)).toMatchObject({ status: "open", failedAttempts: 0 });
  });

  it("times out a dispatch that never reports back", async () => {
    const target = desk({ settings: { threshold: 1 } });
    const incident = hit(target, 1);
    target.invocations.set("inv-1", invocation({ id: "inv-1", status: "completed" }));
    await target.desk.sweep();
    expect(target.store.get(incident.id)!.status).toBe("fixing");
    target.advance(DISPATCH_TIMEOUT_MS + 1);
    await target.desk.sweep();
    expect(target.store.get(incident.id)).toMatchObject({ status: "open", failedAttempts: 1 });
  });

  it("escalates a fix that touches protected code instead of accepting it", async () => {
    const target = desk({
      settings: { threshold: 1 },
      changed: [
        { status: "M", file: "apps/server/src/app.ts" },
        { status: "M", file: "apps/server/src/agent-instructions.ts" },
      ],
    });
    const incident = hit(target, 1);
    const reported = await target.desk.report(
      { roomId: "build", agentName: "rd-claude2" },
      incident.id,
      { status: "fixed", commit: "c".repeat(40), symptom: "s", cause: "c", fix: "f" },
    );
    expect(reported.protectedFiles).toEqual(["apps/server/src/agent-instructions.ts"]);
    expect(target.store.get(incident.id)!.status).toBe("escalated");
    expect(target.store.lessons()).toHaveLength(0);
  });

  it("flags edits to existing tests for the reviewer without blocking", async () => {
    const target = desk({
      settings: { threshold: 1 },
      changed: [
        { status: "A", file: "apps/server/src/new.test.ts" },
        { status: "M", file: "apps/server/src/app.test.ts" },
      ],
    });
    const incident = hit(target, 1);
    const reported = await target.desk.report(
      { roomId: "build", agentName: "rd-claude2" },
      incident.id,
      { status: "fixed", commit: "d".repeat(40), symptom: "s", cause: "c", fix: "f" },
    );
    expect(reported.modifiedTests).toEqual(["apps/server/src/app.test.ts"]);
    expect(target.store.get(incident.id)!.status).toBe("fix_submitted");
  });

  it("matches protected paths by exact file or directory prefix", () => {
    expect(
      protectedChanges([
        "skills/superhive/SKILL.md",
        "apps/server/src/incident-store.ts",
        "apps/server/src/incidents.test.ts",
        "apps/web/package.json",
        "package.json",
      ]),
    ).toEqual(["skills/superhive/SKILL.md", "apps/server/src/incident-store.ts", "package.json"]);
  });

  it("adds approved rule proposals to the agent rules", () => {
    const target = desk();
    const proposal = target.desk.propose(
      { roomId: "build", agentName: "rd-claude2" },
      "合入前先跑全量测试",
      "这次漏跑 docs 测试",
    );
    expect(target.desk.rulesAddendum()).toBe("");
    target.desk.decide(proposal.id, "approve", "local-owner");
    expect(target.desk.rulesAddendum()).toContain("1. 合入前先跑全量测试");
    expect(() => target.desk.decide(proposal.id, "approve", "local-owner")).toThrow();
    target.desk.decide(proposal.id, "retire", "local-owner");
    expect(target.desk.rulesAddendum()).toBe("");
  });

  it("lets the owner dispatch by hand below the threshold, but not external failures", () => {
    const target = desk({ settings: { autoDispatch: false } });
    const incident = hit(target, 1);
    expect(target.desk.act(incident.id, "dispatch").status).toBe("fixing");
    const external = target.desk.record(
      classifyInvocation(invocation({ detailText: { key: "bridge.modelFailed" } }), {})!,
    )!;
    expect(() => target.desk.act(external.id, "dispatch")).toThrow(/external cause/);
    // 说不清是谁的：房主判断后可以手动派
    const unclear = target.desk.record(
      classifyInvocation(invocation({ detailText: { key: "bridge.somethingNew" } }), {})!,
    )!;
    expect(target.desk.act(unclear.id, "dispatch").status).toBe("fixing");
  });

  it("puts the most relevant lessons first", async () => {
    const target = desk({ settings: { threshold: 1 } });
    const incident = hit(target, 1);
    await target.desk.report({ roomId: "build", agentName: "rd-claude2" }, incident.id, {
      status: "fixed",
      commit: "e".repeat(40),
      symptom: "本单",
      cause: "c",
      fix: "f",
    });
    target.store.addLesson({
      incidentId: "other",
      source: "web",
      title: "别处",
      symptom: "网页",
      cause: "c",
      fix: "f",
      agentName: "x",
    });
    expect(target.desk.relevantLessons(incident).map((lesson) => lesson.symptom)).toEqual([
      "本单",
      "网页",
    ]);
  });
});
