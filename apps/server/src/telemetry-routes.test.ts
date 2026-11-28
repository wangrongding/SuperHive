import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentCliUpdateResult, buildApp } from "./app.js";
import type { AgentCliJob } from "@superhive/protocol";
import { dayOf, readTelemetryQueue, readTelemetryState } from "./telemetry-core.js";
import { Peer } from "./test-peer.js";

const cli = { command: "/usr/bin/node", args: ["/opt/superhive/dist/cli.js"] };
const probe = async () => ({ installed: false, version: null });

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(env: NodeJS.ProcessEnv = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "hive-telemetry-routes-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const fetch = vi.fn(async () => new Response(null, { status: 204 }));
  const app = await buildApp({
    databasePath: ":memory:",
    token: "join-token",
    staticDir: "/definitely-not-present",
    localAgents: {
      cli,
      serverUrl: "http://127.0.0.1:8787",
      spawn: vi.fn(),
      probe,
    },
    telemetry: { dir, env, fetch: fetch as unknown as typeof globalThis.fetch },
  });
  cleanups.push(() => app.close());
  const session = (await app.inject({ method: "GET", url: "/api/local/session" })).json() as {
    ownerToken: string;
  };
  const owner = { "x-hive-owner": session.ownerToken };
  const admin = { authorization: "Bearer join-token" };
  return { app, dir, owner, admin, fetch };
}

describe("telemetry routes", () => {
  it("lets the local owner read the status, turn it off and preview the data", async () => {
    const { app, owner } = await setup();
    const status = await app.inject({ url: "/api/local/telemetry", headers: owner });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ active: true, enabled: true, noticePending: true });

    const created = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { authorization: "Bearer join-token" },
      payload: { id: "design", name: "Design" },
    });
    expect(created.statusCode).toBe(201);
    const preview = await app.inject({ url: "/api/local/telemetry/preview", headers: owner });
    const payload = preview.json().payload as Array<{
      payload: { name: string; data: Record<string, unknown> };
    }>;
    expect(payload.map((event) => [event.payload.name, event.payload.data.feature])).toEqual([
      ["feature_first_used", "room_create"],
    ]);
    // 房间名、房间 ID 都不在数据里
    expect(JSON.stringify(payload)).not.toMatch(/design/i);

    const notice = await app.inject({
      method: "POST",
      url: "/api/local/telemetry/notice",
      headers: owner,
    });
    expect(notice.json()).toMatchObject({ noticePending: false });

    const off = await app.inject({
      method: "PUT",
      url: "/api/local/telemetry",
      headers: owner,
      payload: { enabled: false },
    });
    expect(off.json()).toMatchObject({ active: false, enabled: false, queued: 0 });
    expect(
      (await app.inject({ url: "/api/local/telemetry/preview", headers: owner })).json(),
    ).toEqual({ payload: null });
    expect((await app.inject({ url: "/api/meta" })).json().telemetry).toBeUndefined();
  });

  it("only lets the owner on this computer change it", async () => {
    const { app, owner } = await setup();
    // 不带本机房主凭证
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/local/telemetry",
          payload: { enabled: false },
        })
      ).statusCode,
    ).toBe(401);
    // 带着凭证，但请求来自别的电脑
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/local/telemetry",
          headers: owner,
          remoteAddress: "192.0.2.10",
          payload: { enabled: false },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/local/telemetry",
          headers: owner,
          payload: { enabled: "no" },
        })
      ).statusCode,
    ).toBe(400);
  });

  it("accepts the web page's whitelisted events from the owner only", async () => {
    const { app, dir, admin } = await setup();
    expect((await app.inject({ url: "/api/meta" })).json().telemetry).toBe(true);
    const send = (payload: object, headers: Record<string, string> = admin) =>
      app.inject({ method: "POST", url: "/api/telemetry/events", headers, payload });

    expect(
      (
        await send({
          locale: "en",
          events: [
            { event: "feature_first_used", props: { feature: "code_panel" } },
            {
              event: "update_result",
              props: { kind: "desktop", outcome: "failure", reason: "network" },
            },
          ],
        })
      ).statusCode,
    ).toBe(204);
    expect(
      readTelemetryQueue(dir).map(({ event, props, context }) => ({
        event,
        props,
        locale: context.locale,
      })),
    ).toEqual([
      { event: "feature_first_used", props: { feature: "code_panel" }, locale: "en" },
      {
        event: "update_result",
        props: { kind: "desktop", outcome: "failure", reason: "network" },
        locale: "en",
      },
    ]);

    // 网页不能报服务端才知道的事、不能带白名单以外的字段
    expect(
      (await send({ events: [{ event: "heartbeat", props: { rooms: "1" } }] })).statusCode,
    ).toBe(400);
    expect(
      (
        await send({
          events: [
            { event: "feature_first_used", props: { feature: "code_panel", path: "/Users/rd" } },
          ],
        })
      ).statusCode,
    ).toBe(400);
    expect((await send({ events: [] }, {})).statusCode).toBe(401);
    expect(readTelemetryQueue(dir)).toHaveLength(2);
  });

  it("does nothing when the environment turns statistics off", async () => {
    const { app, dir, owner, admin } = await setup({ DO_NOT_TRACK: "1" });
    expect(
      (await app.inject({ url: "/api/local/telemetry", headers: owner })).json(),
    ).toMatchObject({
      active: false,
      blocker: "do_not_track",
      noticePending: false,
    });
    await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: admin,
      payload: { id: "x", name: "X" },
    });
    await app.inject({
      method: "POST",
      url: "/api/telemetry/events",
      headers: admin,
      payload: { events: [{ event: "feature_first_used", props: { feature: "code_panel" } }] },
    });
    expect((await app.inject({ url: "/api/meta" })).json().telemetry).toBeUndefined();
    expect(readTelemetryQueue(dir)).toEqual([]);
  });
});

describe("whether anyone is using it", () => {
  it("marks the day when a person sends a message, not when an agent does", async () => {
    const { app, dir } = await setup();
    await app.listen({ host: "127.0.0.1", port: 0 });
    const url = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/ws`;
    const join = async (username: string, participantType: "human" | "agent") => {
      const peer = await Peer.connect(url);
      cleanups.push(() => peer.socket.close());
      peer.send({
        type: "participant.join",
        roomId: "general",
        token: "join-token",
        username,
        participantType,
      });
      await peer.next((event) => event.type === "room.snapshot");
      return peer;
    };
    const say = async (peer: Peer, content: string) => {
      peer.send({ type: "message.send", content, clientMessageId: content });
      await peer.next(
        (event) => event.type === "message.created" && event.message.clientMessageId === content,
      );
    };
    const agent = await join("rd-claude", "agent");
    await say(agent, "agent 自己说话");
    expect(readTelemetryState(dir).state.activeDay).toBeUndefined();

    const human = await join("rd", "human");
    await say(human, "有人在用");
    expect(readTelemetryState(dir).state.activeDay).toBe(dayOf(Date.now()));
    // 只记日期，消息内容和条数都不进统计
    expect(JSON.stringify(readTelemetryState(dir).state)).not.toContain("有人在用");
  });
});

describe("agent CLI update results", () => {
  const job = (patch: Partial<AgentCliJob>): AgentCliJob => ({
    id: "job",
    tool: "claude",
    action: "upgrade",
    command: "npm install -g @anthropic-ai/claude-code@latest",
    state: "succeeded",
    progress: "",
    startedAt: "2026-11-28T04:00:00.000Z",
    ...patch,
  });

  it("keeps only the CLI, the action and a failure category", () => {
    expect(agentCliUpdateResult(job({}))).toEqual({
      kind: "agent_cli",
      target: "claude",
      action: "upgrade",
      outcome: "success",
    });
    expect(
      agentCliUpdateResult(
        job({
          tool: "codex",
          action: "install",
          state: "failed",
          reason: "安装超时",
          reasonText: { key: "error.agentCli.timeout", params: { minutes: "10" } },
          error: "npm ERR! /Users/rd/.npm/_logs/debug.log",
        }),
      ),
    ).toEqual({
      kind: "agent_cli",
      target: "codex",
      action: "install",
      outcome: "failure",
      reason: "timeout",
    });
    expect(agentCliUpdateResult(job({ state: "failed" })).reason).toBe("unknown");
  });
});
