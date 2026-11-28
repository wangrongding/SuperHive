import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Invocation, Participant, ServerEvent } from "@superhive/protocol";
import { buildApp } from "./app.js";
import { Peer } from "./test-peer.js";

const OWNER = { Authorization: "Bearer test-token", "Content-Type": "application/json" };
const errorCode = (event: ServerEvent) => (event.type === "error" ? event.code : undefined);

describe("限时邀请与访客会话", () => {
  let close: (() => Promise<void>) | undefined;
  const peers: Peer[] = [];
  afterEach(async () => {
    for (const peer of peers.splice(0)) peer.socket.close();
    await close?.();
    close = undefined;
  });

  async function start() {
    let now = Date.now();
    const app = await buildApp({
      databasePath: ":memory:",
      token: "test-token",
      staticDir: "/definitely-not-present",
      accessSweepMs: 20,
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
      participantType: "human" | "agent",
      token = "test-token",
      roomId = "general",
    ) => {
      const peer = await Peer.connect(`ws://127.0.0.1:${port}/ws`);
      peers.push(peer);
      peer.send({ type: "participant.join", username, participantType, roomId, token });
      return peer;
    };
    const invite = async (minutes: number | null = 60, allowAgents = false) =>
      (await api("POST", "/api/rooms/general/invites", { expiresInMinutes: minutes, allowAgents }))
        .body as { token: string; invite: { id: string; expiresAt: string | null } };
    const redeem = async (token: string, username: string) =>
      api(
        "POST",
        "/api/invites/redeem",
        { token, username },
        { "Content-Type": "application/json" },
      );
    const guestHeaders = (token: string) => ({
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    });
    return {
      app,
      port,
      base,
      api,
      join,
      invite,
      redeem,
      guestHeaders,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it("远程访问拿不到共享凭证；本机房主仍能拿到", async () => {
    const { app } = await start();
    const remote = await app.inject({ url: "/api/meta", remoteAddress: "203.0.113.5" });
    expect(remote.json().joinToken).toBeUndefined();
    expect(remote.json().agentCommand).toBeUndefined();
    const remoteAccess = await app.inject({ url: "/api/access", remoteAddress: "203.0.113.5" });
    expect(remoteAccess.json()).toEqual({ role: "none", reason: "no_invite" });
    const local = await app.inject({ url: "/api/access", remoteAddress: "127.0.0.1" });
    expect(local.json()).toMatchObject({ role: "owner", joinToken: "test-token" });
  });

  it("邀请有效期内可多人使用，兑换出的访客只能进入该房间", async () => {
    const { api, invite, redeem, join, guestHeaders } = await start();
    await (await join("rd", "human")).next((event) => event.type === "room.snapshot");
    const created = await invite(60);
    expect(created.invite.expiresAt).toEqual(expect.any(String));

    const preview = await api("GET", `/api/invites/preview?token=${created.token}`, undefined, {});
    expect(preview.body).toMatchObject({ roomId: "general", state: "valid" });
    expect((await redeem(created.token, "rd")).body.code).toBe("USERNAME_TAKEN");
    const redeemed = await redeem(created.token, "alice");
    expect(redeemed.status).toBe(200);
    expect(redeemed.body).toMatchObject({ role: "guest", username: "alice", roomId: "general" });
    // 有效期内不限次数：同一链接其他人也能用，各自得到独立会话、同一截止时间
    const second = await redeem(created.token, "bob");
    expect(second.status).toBe(200);
    expect(second.body.expiresAt).toBe(created.invite.expiresAt);
    expect(second.body.token).not.toBe(redeemed.body.token);
    expect((await redeem(created.token, "bob")).body.code).toBe("USERNAME_TAKEN");

    const guestToken = redeemed.body.token as string;
    const headers = guestHeaders(guestToken);
    expect((await api("GET", "/api/rooms", undefined, headers)).body.rooms).toHaveLength(1);
    expect((await api("POST", "/api/rooms", { name: "x" }, headers)).status).toBe(403);
    await api("POST", "/api/rooms", { name: "secret" });
    expect((await api("GET", "/api/rooms/secret/messages", undefined, headers)).status).toBe(403);
    expect(
      (await api("POST", "/api/rooms/general/invites", { expiresInMinutes: 5 }, headers)).status,
    ).toBe(403);
    expect((await api("GET", "/api/access", undefined, headers)).body).toMatchObject({
      role: "guest",
      username: "alice",
    });

    // 只能以兑换时的名字进入兑换时的房间
    const wrongRoom = await join("alice", "human", guestToken, "secret");
    expect(errorCode(await wrongRoom.next((event) => event.type === "error"))).toBe(
      "ROOM_FORBIDDEN",
    );
    const wrongName = await join("mallory", "human", guestToken);
    expect(errorCode(await wrongName.next((event) => event.type === "error"))).toBe(
      "ROOM_FORBIDDEN",
    );
    const alice = await join("alice", "human", guestToken);
    const snapshot = await alice.next((event) => event.type === "room.snapshot");
    const self = snapshot.type === "room.snapshot" ? snapshot.self : undefined;
    expect(self?.access).toMatchObject({ kind: "guest", expiresAt: created.invite.expiresAt });
  });

  it("到期后主动断开访客，重连也被拒绝；续期后又能进入", async () => {
    const { invite, redeem, join, advance, api } = await start();
    const owner = await join("rd", "human");
    await owner.next((event) => event.type === "room.snapshot");
    const created = await invite(60);
    const guestToken = (await redeem(created.token, "alice")).body.token as string;
    const alice = await join("alice", "human", guestToken);
    const snapshot = await alice.next((event) => event.type === "room.snapshot");
    const sessionId =
      snapshot.type === "room.snapshot" ? snapshot.self.access?.sessionId : undefined;

    advance(61 * 60_000);
    expect(errorCode(await alice.next((event) => event.type === "error"))).toBe("SESSION_EXPIRED");
    await alice.waitClosed();
    const retry = await join("alice", "human", guestToken);
    expect(errorCode(await retry.next((event) => event.type === "error"))).toBe("SESSION_EXPIRED");

    // 房主续期：成员列表收到新的截止时间，访客可以重新进入
    const renewed = await api("POST", `/api/guests/${sessionId}/renew`, { expiresInMinutes: 30 });
    expect(renewed.status).toBe(200);
    const presence = await owner.next(
      (event) =>
        event.type === "presence.changed" &&
        event.participant.username === "alice" &&
        event.participant.access?.expiresAt === renewed.body.session.expiresAt,
    );
    const renewedAt =
      presence.type === "presence.changed" ? presence.participant.access : undefined;
    expect(renewedAt?.expiresAt).toEqual(renewed.body.session.expiresAt);
    const back = await join("alice", "human", guestToken);
    expect((await back.next((event) => event.type === "room.snapshot")).type).toBe("room.snapshot");
  });

  it("撤销或续期一个链接，凭它进来的所有人一起生效；结束的人留在离线列表", async () => {
    const { invite, redeem, join, api, advance } = await start();
    const owner = await join("rd", "human");
    await owner.next((event) => event.type === "room.snapshot");
    const created = await invite(60);
    const aliceToken = (await redeem(created.token, "alice")).body.token as string;
    const bobToken = (await redeem(created.token, "bob")).body.token as string;
    const alice = await join("alice", "human", aliceToken);
    await alice.next((event) => event.type === "room.snapshot");
    const bob = await join("bob", "human", bobToken);
    await bob.next((event) => event.type === "room.snapshot");

    // 续期链接：两人都延到新的截止时间
    const renewed = await api("POST", `/api/invites/${created.invite.id}/renew`, {
      expiresInMinutes: 120,
    });
    expect(renewed.body.invite).toMatchObject({ uses: 2 });
    // 房主在邀请列表里能拿回原链接的令牌，随时再复制
    const listed = (await api("GET", "/api/rooms/general/invites")).body.invites as Array<{
      id: string;
      token?: string;
    }>;
    expect(listed.find((item) => item.id === created.invite.id)?.token).toBe(created.token);
    advance(90 * 60_000);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(alice.closed).toBe(false);
    expect(bob.closed).toBe(false);

    // 撤销链接：两人一起被断开，再也进不来；成员列表里留着他们，标为已结束
    expect((await api("DELETE", `/api/invites/${created.invite.id}`)).status).toBe(200);
    expect(errorCode(await alice.next((event) => event.type === "error"))).toBe("SESSION_REVOKED");
    expect(errorCode(await bob.next((event) => event.type === "error"))).toBe("SESSION_REVOKED");
    const members = (await api("GET", "/api/rooms/general/participants")).body
      .participants as Participant[];
    expect(
      members
        .filter((member) => member.access)
        .map((member) => [member.username, member.status, member.access?.revoked])
        // 成员按最后活跃排序，两人被断开的先后不固定：这里只核对内容
        .sort(([left], [right]) => String(left).localeCompare(String(right))),
    ).toEqual([
      ["alice", "offline", true],
      ["bob", "offline", true],
    ]);
    expect((await redeem(created.token, "carol")).body.code).toBe("INVITE_REVOKED");
    // 下次再被邀请时可以沿用原来的名字，重新回到在线列表
    const again = await redeem((await invite(60)).token, "alice");
    expect(again.status).toBe(200);
    const back = await join("alice", "human", again.body.token as string);
    const snapshot = await back.next((event) => event.type === "room.snapshot");
    expect(snapshot.type === "room.snapshot" && snapshot.self.access?.ended).toBeFalsy();
  });

  it("未授权访客不带 @ 的消息不交给主 Agent，授权访客的照常交给它", async () => {
    const { api, invite, redeem, join } = await start();
    const owner = await join("rd", "human");
    await owner.next((event) => event.type === "room.snapshot");
    const lead = await join("lead", "agent");
    await lead.next((event) => event.type === "room.snapshot");
    expect((await api("PATCH", "/api/rooms/general", { leadAgent: "lead" })).status).toBe(200);

    const plainToken = (await redeem((await invite(60)).token, "alice")).body.token as string;
    const alice = await join("alice", "human", plainToken);
    await alice.next((event) => event.type === "room.snapshot");
    alice.send({ type: "message.send", clientMessageId: "chat", content: "随便聊聊" });
    await expect(owner.next((event) => event.type === "invocation.updated", 200)).rejects.toThrow();

    const trustedToken = (await redeem((await invite(60, true)).token, "bob")).body.token as string;
    const bob = await join("bob", "human", trustedToken);
    await bob.next((event) => event.type === "room.snapshot");
    bob.send({ type: "message.send", clientMessageId: "task", content: "帮我看下日志" });
    const mentioned = await lead.next((event) => event.type === "agent.mentioned");
    expect(mentioned.type === "agent.mentioned" && mentioned.lead).toBe(true);
  });

  it("访客 @ 房主的 Agent 需要房主批准；访客自己不能批准", async () => {
    const { invite, redeem, join, api, guestHeaders } = await start();
    const owner = await join("rd", "human");
    await owner.next((event) => event.type === "room.snapshot");
    const worker = await join("worker", "agent");
    await worker.next((event) => event.type === "room.snapshot");
    const guestToken = (await redeem((await invite(60)).token, "alice")).body.token as string;
    const alice = await join("alice", "human", guestToken);
    await alice.next((event) => event.type === "room.snapshot");

    alice.send({ type: "message.send", clientMessageId: "m1", content: "@worker 删掉 /tmp" });
    const blocked = await owner.next(
      (event) => event.type === "invocation.updated" && event.invocation.status === "blocked",
    );
    const invocation = (blocked as Extract<ServerEvent, { type: "invocation.updated" }>)
      .invocation as Invocation;
    expect(invocation.blockReason).toBe("guest_approval");

    alice.send({ type: "invocation.retry", invocationId: invocation.id });
    expect(errorCode(await alice.next((event) => event.type === "error"))).toBe("OWNER_ONLY");
    alice.send({ type: "topic.start" });
    expect(errorCode(await alice.next((event) => event.type === "error"))).toBe("OWNER_ONLY");
    for (const action of ["archive", "restore"]) {
      const response = await api(
        "POST",
        `/api/rooms/general/whiteboard/${action}`,
        { entries: [{ id: invocation.id, updatedAt: new Date().toISOString() }] },
        guestHeaders(guestToken),
      );
      expect(response.status).toBe(403);
      expect(response.body.code).toBe("OWNER_ONLY");
    }
    expect(
      (
        await api(
          "GET",
          "/api/rooms/general/whiteboard?view=archived",
          undefined,
          guestHeaders(guestToken),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await api(
          "GET",
          "/api/rooms/other/whiteboard?view=archived",
          undefined,
          guestHeaders(guestToken),
        )
      ).status,
    ).toBe(403);

    owner.send({ type: "invocation.retry", invocationId: invocation.id });
    const delivered = await worker.next((event) => event.type === "agent.mentioned");
    expect(delivered.type).toBe("agent.mentioned");
  });

  it("换个模型重试：模型带给 Agent、只有房主能指定", async () => {
    const { invite, redeem, join } = await start();
    const owner = await join("rd", "human");
    await owner.next((event) => event.type === "room.snapshot");
    const worker = await join("worker", "agent");
    await worker.next((event) => event.type === "room.snapshot");
    const guestToken = (await redeem((await invite(60, true)).token, "alice")).body.token as string;
    const alice = await join("alice", "human", guestToken);
    await alice.next((event) => event.type === "room.snapshot");

    alice.send({ type: "message.send", clientMessageId: "m1", content: "@worker 看一下" });
    const first = await worker.next((event) => event.type === "agent.mentioned");
    const messageId = first.type === "agent.mentioned" ? first.message.id : "";
    worker.send({
      type: "invocation.report",
      messageId,
      status: "failed",
      detail: "model_not_found",
    });
    const failed = await owner.next(
      (event) => event.type === "invocation.updated" && event.invocation.status === "failed",
    );
    const invocation = (failed as Extract<ServerEvent, { type: "invocation.updated" }>)
      .invocation as Invocation;

    // 访客能重试自己发起的，但不能换模型（花的是房主的钱）
    alice.send({ type: "invocation.retry", invocationId: invocation.id, model: "gpt-pricey" });
    expect(errorCode(await alice.next((event) => event.type === "error"))).toBe("OWNER_ONLY");
    // 调高思考强度同样花房主的钱：访客也不能指定
    alice.send({ type: "invocation.retry", invocationId: invocation.id, effort: "xhigh" });
    expect(errorCode(await alice.next((event) => event.type === "error"))).toBe("OWNER_ONLY");

    owner.send({
      type: "invocation.retry",
      invocationId: invocation.id,
      model: "gpt-other",
      effort: "high",
    });
    const retried = await worker.next((event) => event.type === "agent.mentioned");
    expect(retried).toMatchObject({ retry: true, model: "gpt-other", effort: "high" });
    const queued = await owner.next(
      (event) =>
        event.type === "invocation.updated" &&
        event.invocation.status === "queued" &&
        event.invocation.attempts === 2,
    );
    expect(
      ((queued as Extract<ServerEvent, { type: "invocation.updated" }>).invocation as Invocation)
        .detail,
    ).toBe("rd 请求换成 gpt-other（思考强度 high）重试");
  });

  it("允许调度 Agent 的邀请不需要逐次批准", async () => {
    const { invite, redeem, join } = await start();
    const worker = await join("worker", "agent");
    await worker.next((event) => event.type === "room.snapshot");
    const guestToken = (await redeem((await invite(60, true)).token, "alice")).body.token as string;
    const alice = await join("alice", "human", guestToken);
    await alice.next((event) => event.type === "room.snapshot");
    alice.send({ type: "message.send", clientMessageId: "m1", content: "@worker 看一下" });
    expect((await worker.next((event) => event.type === "agent.mentioned")).type).toBe(
      "agent.mentioned",
    );
  });

  it("访客带入的 Agent 能用自己的凭证退出房间，房主和访客本人不能用这个接口", async () => {
    const { invite, redeem, join, api, guestHeaders } = await start();
    const owner = await join("rd", "human");
    await owner.next((event) => event.type === "room.snapshot");
    const guestToken = (await redeem((await invite(null)).token, "alice")).body.token as string;
    const agentToken = (
      await api("POST", "/api/guest-agents", { username: "alice-bot" }, guestHeaders(guestToken))
    ).body.token as string;
    const bot = await join("alice-bot", "agent", agentToken);
    await bot.next((event) => event.type === "room.snapshot");

    expect((await api("POST", "/api/guest-agents/leave", {})).status).toBe(403);
    expect(
      (await api("POST", "/api/guest-agents/leave", {}, guestHeaders(guestToken))).status,
    ).toBe(403);
    const left = await api("POST", "/api/guest-agents/leave", {}, guestHeaders(agentToken));
    expect(left).toEqual({
      status: 200,
      body: { left: true, roomId: "general", username: "alice-bot" },
    });
    // 凭证随之作废，连接被断开；访客本人不受影响
    expect(
      (await api("POST", "/api/guest-agents/leave", {}, guestHeaders(agentToken))).status,
    ).toBe(401);
    await bot.waitClosed();
    expect(
      (await api("POST", "/api/guest-agents", { username: "alice-bot2" }, guestHeaders(guestToken)))
        .status,
    ).toBe(201);
  });

  it("访客带入的 Agent 随访客一起被移除，访客凭证不能冒充 Agent 调工具", async () => {
    const { invite, redeem, join, api, guestHeaders, base } = await start();
    const owner = await join("rd", "human");
    await owner.next((event) => event.type === "room.snapshot");
    const guestToken = (await redeem((await invite(null)).token, "alice")).body.token as string;
    const alice = await join("alice", "human", guestToken);
    await alice.next((event) => event.type === "room.snapshot");

    const created = await api(
      "POST",
      "/api/guest-agents",
      { username: "alice-bot" },
      guestHeaders(guestToken),
    );
    expect(created.status).toBe(201);
    expect(created.body.command).toContain("--room general --name alice-bot");
    expect(created.body.expiresAt).toBeNull();
    const agentToken = created.body.token as string;
    // 只有访客本人能带 Agent，访客 Agent 不能再带
    expect(
      (await api("POST", "/api/guest-agents", { username: "x" }, guestHeaders(agentToken))).status,
    ).toBe(403);

    const bot = await join("alice-bot", "agent", agentToken);
    const snapshot = await bot.next((event) => event.type === "room.snapshot");
    const listed = (
      snapshot.type === "room.snapshot" ? snapshot.participants : []
    ) as Participant[];
    expect(listed.find((member) => member.username === "rd")?.access).toBeUndefined();
    expect(snapshot.type === "room.snapshot" && snapshot.self.access).toMatchObject({
      sponsorName: "alice",
      expiresAt: null,
    });

    const mcp = async (token: string) => {
      const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: {
          headers: {
            Authorization: `Bearer ${token}`,
            "X-Hive-Room": "general",
            "X-Hive-Agent-Name": "alice-bot",
          },
        },
      });
      const client = new Client({ name: "t", version: "0" });
      await client.connect(transport as unknown as Transport);
      return client;
    };
    const client = await mcp(agentToken);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    await client.close();
    await expect(mcp(guestToken)).rejects.toThrow();

    const sessionId = (await api("GET", "/api/access", undefined, guestHeaders(guestToken))).body
      .sessionId as string;
    expect((await api("DELETE", `/api/guests/${sessionId}`)).status).toBe(200);
    expect(errorCode(await alice.next((event) => event.type === "error"))).toBe("SESSION_REVOKED");
    expect(errorCode(await bot.next((event) => event.type === "error"))).toBe("SESSION_REVOKED");
    await bot.waitClosed();
    const rejoin = await join("alice-bot", "agent", agentToken);
    expect(errorCode(await rejoin.next((event) => event.type === "error"))).toBe("SESSION_REVOKED");
  });

  it("房主可以单独暂停、恢复或移出访客带进来的 Agent，访客本人不受影响", async () => {
    const { invite, redeem, join, api, guestHeaders } = await start();
    const owner = await join("rd", "human");
    await owner.next((event) => event.type === "room.snapshot");
    const guestToken = (await redeem((await invite(null)).token, "alice")).body.token as string;
    const alice = await join("alice", "human", guestToken);
    await alice.next((event) => event.type === "room.snapshot");
    const created = await api(
      "POST",
      "/api/guest-agents",
      { username: "alice-bot" },
      guestHeaders(guestToken),
    );
    const agentToken = created.body.token as string;
    const agentSession = created.body.sessionId as string;
    const bot = await join("alice-bot", "agent", agentToken);
    await bot.next((event) => event.type === "room.snapshot");

    // 访客不能暂停；访客本人不能被暂停（用续期和移出管理）
    expect(
      (await api("POST", `/api/guests/${agentSession}/pause`, {}, guestHeaders(guestToken))).status,
    ).toBe(403);
    const aliceSession = (await api("GET", "/api/access", undefined, guestHeaders(guestToken))).body
      .sessionId as string;
    expect((await api("POST", `/api/guests/${aliceSession}/pause`, {})).status).toBe(409);

    expect((await api("POST", `/api/guests/${agentSession}/pause`, {})).status).toBe(200);
    expect(errorCode(await bot.next((event) => event.type === "error"))).toBe("SESSION_PAUSED");
    await bot.waitClosed();
    const paused = await owner.next(
      (event) =>
        event.type === "presence.changed" &&
        event.participant.username === "alice-bot" &&
        Boolean(event.participant.access?.paused),
    );
    expect(paused.type === "presence.changed" && paused.participant.access).toMatchObject({
      paused: true,
    });
    expect(paused.type === "presence.changed" && paused.participant.access?.ended).toBeUndefined();
    // 暂停期间重连被拒，原因是「暂停」而不是「被移除」
    const blocked = await join("alice-bot", "agent", agentToken);
    expect(errorCode(await blocked.next((event) => event.type === "error"))).toBe("SESSION_PAUSED");
    await blocked.waitClosed();

    // 恢复后同一个令牌能连回来；访客本人一直在线
    expect((await api("POST", `/api/guests/${agentSession}/resume`, {})).status).toBe(200);
    const back = await join("alice-bot", "agent", agentToken);
    await back.next((event) => event.type === "room.snapshot");
    expect(alice.socket.readyState).toBe(1);

    // 单独移出这个 Agent：它断开、再也连不上，访客本人不受影响
    expect((await api("DELETE", `/api/guests/${agentSession}`)).status).toBe(200);
    expect(errorCode(await back.next((event) => event.type === "error"))).toBe("SESSION_REVOKED");
    expect((await api("POST", `/api/guests/${agentSession}/resume`, {})).status).toBe(409);
    expect(alice.socket.readyState).toBe(1);
  });

  it("访客收不到其他房间的跨房间事件", async () => {
    const { invite, redeem, join, api } = await start();
    const guestToken = (await redeem((await invite(60)).token, "alice")).body.token as string;
    const alice = await join("alice", "human", guestToken);
    await alice.next((event) => event.type === "room.snapshot");
    await api("POST", "/api/rooms", { name: "secret" });
    await api("PATCH", "/api/rooms/general", { name: "大厅" });
    const changed = await alice.next((event) => event.type === "rooms.changed");
    expect(changed.type === "rooms.changed" && changed.room.id).toBe("general");
    expect(
      alice.events.some((event) => event.type === "rooms.changed" && event.room.id === "secret"),
    ).toBe(false);
  });
});
