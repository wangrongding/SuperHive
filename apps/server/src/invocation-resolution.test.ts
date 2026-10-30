import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Invocation, ServerEvent } from "@ai-hive/protocol";
import { buildApp } from "./app.js";
import { Peer } from "./test-peer.js";

describe("异常调用的收起与忽略", () => {
  let close: (() => Promise<void>) | undefined;
  const peers: Peer[] = [];
  afterEach(async () => {
    for (const peer of peers.splice(0)) peer.socket.close();
    await close?.();
  });

  const invocationOf = (event: ServerEvent): Invocation | undefined =>
    event.type === "invocation.updated" ? event.invocation : undefined;

  it("停止请求久未确认改为结果未知，人可以忽略；访客不能忽略别人的调用", async () => {
    let now = Date.now();
    const app = await buildApp({
      databasePath: ":memory:",
      token: "test-token",
      staticDir: "/definitely-not-present",
      invocationSweepMs: 20,
      now: () => now,
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    close = () => app.close();
    const port = (app.server.address() as AddressInfo).port;
    const join = async (username: string, type: "human" | "agent", token = "test-token") => {
      const peer = await Peer.connect(`ws://127.0.0.1:${port}/ws`);
      peers.push(peer);
      peer.send({ type: "participant.join", username, participantType: type, token });
      await peer.next((event) => event.type === "room.snapshot");
      return peer;
    };
    const human = await join("rd", "human");
    const agent = await join("worker", "agent");
    human.send({ type: "message.send", clientMessageId: "m1", content: "@worker 干活" });
    const mentioned = await agent.next((event) => event.type === "agent.mentioned");
    const messageId = mentioned.type === "agent.mentioned" ? mentioned.message.id : "";
    agent.send({ type: "invocation.report", messageId, status: "running" });
    const running = invocationOf(
      await human.next((event) => invocationOf(event)?.status === "running"),
    )!;
    human.send({ type: "invocation.cancel", invocationId: running.id });
    await human.next((event) => invocationOf(event)?.status === "cancelling");

    // Agent 一直不确认：10 分钟后不再显示「停止中」
    agent.socket.close();
    now += 11 * 60_000;
    const unknown = invocationOf(
      await human.next((event) => invocationOf(event)?.status === "timed_out", 3_000),
    )!;
    expect(unknown.detail).toContain("停止请求超过");

    // 访客不能忽略房主发起的调用
    const json = { Authorization: "Bearer test-token", "Content-Type": "application/json" };
    const base = `http://127.0.0.1:${port}`;
    const invite = (await (
      await fetch(`${base}/api/rooms/general/invites`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ expiresInMinutes: 60, allowAgents: false }),
      })
    ).json()) as { token: string };
    const redeemed = (await (
      await fetch(`${base}/api/invites/redeem`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: invite.token, username: "guest" }),
      })
    ).json()) as { token: string };
    const guest = await join("guest", "human", redeemed.token);
    guest.send({ type: "invocation.dismiss", invocationIds: [unknown.id] });
    const denied = await guest.next((event) => event.type === "error");
    expect(denied.type === "error" && denied.code).toBe("OWNER_ONLY");

    human.send({ type: "invocation.dismiss", invocationIds: [unknown.id] });
    const dismissed = invocationOf(
      await human.next((event) => invocationOf(event)?.resolution?.kind === "dismissed"),
    )!;
    expect(dismissed).toMatchObject({ status: "timed_out", resolution: { by: "rd" } });
  });
});
