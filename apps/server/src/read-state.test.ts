import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { ServerEvent } from "@superhive/protocol";
import { buildApp } from "./app.js";
import { Peer } from "./test-peer.js";

const OWNER = { Authorization: "Bearer test-token", "Content-Type": "application/json" };
const isReadState = (event: ServerEvent) => event.type === "read-state.changed";

describe("已读状态存在 Server，跟着人走", () => {
  let close: (() => Promise<void>) | undefined;
  const peers: Peer[] = [];
  afterEach(async () => {
    for (const peer of peers.splice(0)) peer.socket.close();
    await close?.();
    close = undefined;
  });

  async function start() {
    let now = Date.parse("2026-11-28T00:00:00.000Z");
    const app = await buildApp({
      databasePath: ":memory:",
      token: "test-token",
      staticDir: "/definitely-not-present",
      now: () => now,
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    close = () => app.close();
    const port = (app.server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    const api = async (method: string, url: string, body?: unknown, headers: object = OWNER) => {
      const plain = { ...(headers as Record<string, string>) };
      if (body === undefined) delete plain["Content-Type"];
      const response = await fetch(`${base}${url}`, {
        method,
        headers: plain,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: (await response.json()) as Record<string, any> };
    };
    const join = async (
      username: string,
      roomId = "general",
      token = "test-token",
      participantType: "human" | "agent" = "human",
    ) => {
      const peer = await Peer.connect(`ws://127.0.0.1:${port}/ws`);
      peers.push(peer);
      peer.send({ type: "participant.join", username, participantType, roomId, token });
      await peer.next((event) => event.type === "room.snapshot");
      return peer;
    };
    /** 发一条消息，返回它的 seq */
    const say = async (peer: Peer, content: string) => {
      peer.send({ type: "message.send", clientMessageId: content, content });
      const created = await peer.next(
        (event) => event.type === "message.created" && event.message.content === content,
      );
      return created.type === "message.created" ? created.message.seq : 0;
    };
    const guest = async (username: string) => {
      const invite = (await api("POST", "/api/rooms/general/invites", { expiresInMinutes: 60 }))
        .body as { token: string };
      const redeemed = await api(
        "POST",
        "/api/invites/redeem",
        { token: invite.token, username },
        { "Content-Type": "application/json" },
      );
      const token = redeemed.body.token as string;
      return {
        token,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      };
    };
    return {
      api,
      join,
      say,
      guest,
      advance: (ms: number) => {
        now += ms;
      },
      nowIso: () => new Date(now).toISOString(),
    };
  }

  it("一台设备读了，同一个人的其他设备马上收到；Agent 收不到", async () => {
    const { api, join, say } = await start();
    await api("POST", "/api/rooms", { name: "frontend" });
    // 房主的两台设备：一台看着 general，一台看着 frontend
    const deviceA = await join("rd", "general");
    const deviceB = await join("rd", "frontend");
    const agent = await join("worker", "general", "test-token", "agent");
    const seq = await say(deviceA, "第一条");

    const saved = await api("PUT", "/api/read-state", { rooms: { general: seq } });
    expect(saved).toEqual({ status: 200, body: { rooms: { general: seq } } });
    const pushed = await deviceB.next(isReadState);
    expect(pushed).toEqual({ type: "read-state.changed", rooms: { general: seq } });
    // 发起写入的那台也收到（它合并时取较大值，不受影响）
    await deviceA.next(isReadState);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(agent.events.filter(isReadState)).toEqual([]);

    // 换一台设备（新开的网页）读回来也是同一份
    expect((await api("GET", "/api/read-state")).body).toEqual({ rooms: { general: seq } });
  });

  it("只进不退：旧的、相同的位置被忽略，不推送；超过最新消息的按最新记", async () => {
    const { api, join, say } = await start();
    const device = await join("rd");
    const first = await say(device, "一");
    const second = await say(device, "二");

    await api("PUT", "/api/read-state", { rooms: { general: second } });
    await device.next(isReadState);
    const older = await api("PUT", "/api/read-state", { rooms: { general: first } });
    expect(older.body).toEqual({ rooms: {} });
    const same = await api("PUT", "/api/read-state", { rooms: { general: second } });
    expect(same.body).toEqual({ rooms: {} });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(device.events.filter(isReadState)).toEqual([]);
    expect((await api("GET", "/api/read-state")).body.rooms).toEqual({ general: second });

    // 本地缓存可能来自已重置的旧库：比最新消息还大的不能把以后的新消息都算成已读
    const beyond = await api("PUT", "/api/read-state", { rooms: { general: second + 1000 } });
    expect(beyond.body).toEqual({ rooms: {} });
    const third = await say(device, "三");
    expect((await api("PUT", "/api/read-state", { rooms: { general: third + 5 } })).body).toEqual({
      rooms: { general: third },
    });
    // 不存在的房间、非法值不记
    expect((await api("PUT", "/api/read-state", { rooms: { missing: 3 } })).body).toEqual({
      rooms: {},
    });
    expect((await api("PUT", "/api/read-state", { rooms: { general: -1 } })).status).toBe(400);
  });

  it("迁移：本地记录更大的写回 Server，更小的保持 Server 的", async () => {
    const { api, join, say } = await start();
    await api("POST", "/api/rooms", { name: "frontend" });
    const general = await join("rd", "general");
    const frontend = await join("rd", "frontend");
    const g1 = await say(general, "g1");
    const g2 = await say(general, "g2");
    const f1 = await say(frontend, "f1");
    await api("PUT", "/api/read-state", { rooms: { general: g2 } });

    // 升级前这台设备本地记着 general 读到 g1、frontend 读到 f1：网页把两边取较大值写回
    const migrated = await api("PUT", "/api/read-state", { rooms: { general: g1, frontend: f1 } });
    expect(migrated.body).toEqual({ rooms: { frontend: f1 } });
    expect((await api("GET", "/api/read-state")).body.rooms).toEqual({
      general: g2,
      frontend: f1,
    });
  });

  it("访客各记各的，看不到也改不了别的房间和房主的已读", async () => {
    const { api, join, say, guest } = await start();
    await api("POST", "/api/rooms", { name: "secret" });
    const owner = await join("rd", "general");
    const seq = await say(owner, "大家好");
    const secretPeer = await join("rd", "secret");
    const secretSeq = await say(secretPeer, "机密");
    await api("PUT", "/api/read-state", { rooms: { general: seq, secret: secretSeq } });
    await owner.next(isReadState);

    const alice = await guest("alice");
    const bob = await guest("bob");
    const alicePeer = await join("alice", "general", alice.token);
    const bobPeer = await join("bob", "general", bob.token);
    // 房主读了不算访客读了
    expect((await api("GET", "/api/read-state", undefined, alice.headers)).body).toEqual({
      rooms: {},
    });
    expect(alicePeer.events.filter(isReadState)).toEqual([]);

    const saved = await api(
      "PUT",
      "/api/read-state",
      { rooms: { general: seq, secret: secretSeq } },
      alice.headers,
    );
    // 访客只能写自己房间的
    expect(saved.body).toEqual({ rooms: { general: seq } });
    expect(await alicePeer.next(isReadState)).toEqual({
      type: "read-state.changed",
      rooms: { general: seq },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bobPeer.events.filter(isReadState)).toEqual([]);
    expect(owner.events.filter(isReadState)).toEqual([]);
    expect((await api("GET", "/api/read-state", undefined, bob.headers)).body).toEqual({
      rooms: {},
    });
    expect((await api("GET", "/api/read-state", undefined, alice.headers)).body).toEqual({
      rooms: { general: seq },
    });
    // 没凭证不行
    expect((await api("GET", "/api/read-state", undefined, {})).status).toBe(401);
  });

  it("定时任务面板的「看过」时间也跟着人走，只进不退，不认未来时间", async () => {
    const { api, join, advance, nowIso } = await start();
    const device = await join("rd");
    const seenAt = nowIso();
    const saved = await api("PUT", "/api/read-state", { schedulesSeenAt: seenAt });
    expect(saved.body).toEqual({ rooms: {}, schedulesSeenAt: seenAt });
    expect(await device.next(isReadState)).toEqual({
      type: "read-state.changed",
      rooms: {},
      schedulesSeenAt: seenAt,
    });
    const earlier = new Date(Date.parse(seenAt) - 60_000).toISOString();
    expect((await api("PUT", "/api/read-state", { schedulesSeenAt: earlier })).body).toEqual({
      rooms: {},
    });
    advance(1_000);
    const future = new Date(Date.parse(seenAt) + 86_400_000).toISOString();
    expect((await api("PUT", "/api/read-state", { schedulesSeenAt: future })).body).toEqual({
      rooms: {},
      schedulesSeenAt: nowIso(),
    });
    expect((await api("GET", "/api/read-state")).body).toEqual({
      rooms: {},
      schedulesSeenAt: nowIso(),
    });
  });
});
