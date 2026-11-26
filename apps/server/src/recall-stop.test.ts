import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Invocation, ServerEvent } from "@superhive/protocol";
import { buildApp } from "./app.js";
import { Peer } from "./test-peer.js";

let cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const step of cleanup.reverse()) await step();
  cleanup = [];
});

type Mentioned = Extract<ServerEvent, { type: "agent.mentioned" }>;

async function room() {
  const app = await buildApp({
    databasePath: ":memory:",
    token: "test-token",
    staticDir: "/definitely-not-present",
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  cleanup.push(() => app.close());
  const port = (app.server.address() as AddressInfo).port;
  const snapshots = new Map<string, ServerEvent>();
  const join = async (
    username: string,
    participantType: "human" | "agent",
    token = "test-token",
  ) => {
    const peer = await Peer.connect(`ws://127.0.0.1:${port}/ws`);
    cleanup.push(() => peer.socket.close());
    peer.send({
      type: "participant.join",
      username,
      participantType,
      roomId: "general",
      token,
    });
    snapshots.set(username, await peer.next((event) => event.type === "room.snapshot"));
    return peer;
  };
  return {
    app,
    port,
    join,
    snapshots,
    alice: await join("Alice", "human"),
    helper: await join("helper", "agent"),
  };
}

const updated =
  (messageId: string, match: (invocation: Invocation) => boolean) => (event: ServerEvent) =>
    event.type === "invocation.updated" &&
    event.invocation.messageId === messageId &&
    match(event.invocation);

describe("recalling a message that dispatched work", () => {
  it("only-recall also cancels work that has not been received and can no longer be dispatched", async () => {
    const { alice, helper } = await room();
    alice.send({
      type: "message.send",
      clientMessageId: "queued-recall",
      content: "@helper not started",
    });
    const { message } = (await helper.next(
      (event) => event.type === "agent.mentioned",
    )) as Mentioned;
    alice.send({ type: "message.delete", messageId: message.id });
    const event = await alice.next(
      updated(message.id, (invocation) => invocation.status === "cancelled"),
    );
    expect(event).toMatchObject({ invocation: { status: "cancelled", messageRecalled: true } });
  });

  it("stops the running task when recalled with stop, and says why", async () => {
    const { alice, helper } = await room();
    alice.send({ type: "message.send", clientMessageId: "m1", content: "@helper 删掉 build" });
    const { message } = (await helper.next(
      (event) => event.type === "agent.mentioned",
    )) as Mentioned;
    helper.send({ type: "invocation.report", messageId: message.id, status: "running" });
    await alice.next(updated(message.id, (invocation) => invocation.status === "running"));

    alice.send({ type: "message.delete", messageId: message.id, stop: true });
    const cancel = await helper.next((event) => event.type === "agent.cancel");
    expect(cancel.type === "agent.cancel" && cancel.messageId).toBe(message.id);
    await alice.next(updated(message.id, (invocation) => invocation.status === "cancelling"));
    helper.send({
      type: "invocation.report",
      messageId: message.id,
      status: "cancelled",
      detail: "收到停止请求",
    });
    const done = await alice.next(
      updated(message.id, (invocation) => invocation.status === "cancelled"),
    );
    expect(done.type === "invocation.updated" && done.invocation.detail).toBeUndefined();
  });

  it("cancels a queued task outright, and only-recall leaves running work alone", async () => {
    const { alice, helper } = await room();
    alice.send({ type: "message.send", clientMessageId: "q1", content: "@helper 排队的活" });
    const queued = ((await helper.next((event) => event.type === "agent.mentioned")) as Mentioned)
      .message;
    alice.send({ type: "message.delete", messageId: queued.id, stop: true });
    const cancelled = await alice.next(
      updated(queued.id, (invocation) => invocation.status === "cancelled"),
    );
    expect(cancelled.type === "invocation.updated" && cancelled.invocation.detail).toBeUndefined();
    // Agent 那边也让它把排队的这条丢掉
    expect(await helper.next((event) => event.type === "agent.cancel")).toMatchObject({
      messageId: queued.id,
    });

    alice.send({ type: "message.send", clientMessageId: "r1", content: "@helper 继续做" });
    const running = ((await helper.next((event) => event.type === "agent.mentioned")) as Mentioned)
      .message;
    helper.send({ type: "invocation.report", messageId: running.id, status: "running" });
    await alice.next(updated(running.id, (invocation) => invocation.status === "running"));
    alice.send({ type: "message.delete", messageId: running.id });
    await alice.next((event) => event.type === "message.deleted");
    await expect(helper.next((event) => event.type === "agent.cancel", 200)).rejects.toThrow();
  });

  it("asks the agent to stop a delivered queued task, and files an unconfirmed stop as handled", async () => {
    const { alice, helper } = await room();
    alice.send({ type: "message.send", clientMessageId: "d1", content: "@helper 马上要开始" });
    const { message } = (await helper.next(
      (event) => event.type === "agent.mentioned",
    )) as Mentioned;
    helper.send({ type: "invocation.report", messageId: message.id, status: "received" });
    await alice.next(updated(message.id, (invocation) => Boolean(invocation.receivedAt)));

    alice.send({ type: "message.delete", messageId: message.id, stop: true });
    // 已经送达：不在服务端直接判成「未执行」，等 Agent 确认
    await alice.next(updated(message.id, (invocation) => invocation.status === "cancelling"));
    expect(await helper.next((event) => event.type === "agent.cancel")).toMatchObject({
      messageId: message.id,
    });
    helper.send({ type: "invocation.report", messageId: message.id, status: "uncertain" });
    const done = await alice.next(
      updated(
        message.id,
        (invocation) => invocation.status === "timed_out" && Boolean(invocation.resolution),
      ),
    );
    const invocation = (done as Extract<ServerEvent, { type: "invocation.updated" }>).invocation;
    expect(invocation.detail).toBeUndefined();
    // 人已经在撤回确认里处理过，不再算作需要处理
    expect(invocation.resolution?.kind).toBe("dismissed");
  });

  it.each(["running", "cancelled", "failed", "completed"] as const)(
    "rejects retries of recalled %s work with an explicit error",
    async (status) => {
      const { alice, helper } = await room();
      alice.send({
        type: "message.send",
        clientMessageId: "retry",
        content: "@helper private task",
      });
      const { message } = (await helper.next(
        (event) => event.type === "agent.mentioned",
      )) as Mentioned;
      helper.send({ type: "invocation.report", messageId: message.id, status });
      const event = await alice.next(
        updated(message.id, (invocation) => invocation.status === status),
      );
      const invocation = (event as Extract<ServerEvent, { type: "invocation.updated" }>).invocation;
      alice.send({ type: "message.delete", messageId: message.id });
      await alice.next((event) => event.type === "message.deleted");
      alice.send({ type: "invocation.retry", invocationId: invocation.id });
      expect(await alice.next((event) => event.type === "error")).toMatchObject({
        code: "INVOCATION_MESSAGE_RECALLED",
        message: "消息已撤回，不能重试它派出的任务。",
        text: { key: "error.invocation.messageRecalled" },
      });
      await expect(helper.next((event) => event.type === "agent.mentioned", 100)).rejects.toThrow();
    },
  );

  it("clears traces and redacts details for owners, guests, API reads and reconnects, but keeps replies", async () => {
    const { app, port, alice, helper, join, snapshots } = await room();
    const invite = (
      await app.inject({
        method: "POST",
        url: "/api/rooms/general/invites",
        headers: { authorization: "Bearer test-token" },
        payload: { expiresInMinutes: 60, showTrace: true },
      })
    ).json();
    const guestToken = (
      await app.inject({
        method: "POST",
        url: "/api/invites/redeem",
        payload: { token: invite.token, username: "Viewer" },
      })
    ).json().token as string;
    const guest = await Peer.connect(`ws://127.0.0.1:${port}/ws`);
    cleanup.push(() => guest.socket.close());
    guest.send({
      type: "participant.join",
      username: "Viewer",
      participantType: "human",
      roomId: "general",
      token: guestToken,
    });
    await expect(guest.next((event) => event.type === "room.snapshot")).resolves.toMatchObject({
      type: "room.snapshot",
    });

    alice.send({ type: "message.send", clientMessageId: "trace", content: "@helper private task" });
    const { message } = (await helper.next(
      (event) => event.type === "agent.mentioned",
    )) as Mentioned;
    helper.send({
      type: "invocation.report",
      messageId: message.id,
      status: "running",
      detail: "private detail",
      progress: "private progress",
    });
    const running = await alice.next(
      updated(message.id, (invocation) => invocation.status === "running"),
    );
    const invocationId = (running as Extract<ServerEvent, { type: "invocation.updated" }>)
      .invocation.id;
    const step = {
      id: "private-step",
      kind: "text",
      startedAt: new Date().toISOString(),
      text: "private trace",
    };
    helper.send({ type: "invocation.trace", messageId: message.id, steps: [step] });
    for (const viewer of [alice, guest]) {
      await expect(
        viewer.next((event) => event.type === "invocation.trace" && event.steps.length > 0),
      ).resolves.toMatchObject({ steps: [step] });
      viewer.events.length = 0;
    }

    alice.send({ type: "message.delete", messageId: message.id });
    for (const viewer of [alice, guest]) {
      await viewer.next((event) => event.type === "message.deleted");
      expect(await viewer.next((event) => event.type === "invocation.trace")).toMatchObject({
        invocationId,
        steps: [],
        ended: true,
      });
      const event = await viewer.next(updated(message.id, () => true));
      expect(JSON.stringify(event)).not.toContain("private");
    }
    helper.send({ type: "invocation.trace", messageId: message.id, steps: [step] });
    helper.send({
      type: "invocation.report",
      messageId: message.id,
      status: "running",
      detail: "private again",
      progress: "private again",
      runtimeEvent: { kind: "activity", phase: "tool_running", tool: "command" },
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        requests: 1,
        peakContextTokens: 1,
        peakCacheWriteTokens: 0,
        model: "demo-model",
      },
    });
    for (const viewer of [alice, guest]) {
      const event = await viewer.next(updated(message.id, () => true));
      expect(JSON.stringify(event)).not.toContain("private");
      await expect(
        viewer.next((event) => event.type === "invocation.trace", 100),
      ).rejects.toThrow();
    }

    for (const token of ["test-token", guestToken]) {
      const response = await app.inject({
        method: "GET",
        url: "/api/rooms/general/invocations",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain("private");
      expect(response.json().invocations[0]).toMatchObject({
        id: invocationId,
        status: "running",
        messageRecalled: true,
      });
      expect(response.json().invocations[0].runtime).toBeUndefined();
      expect(response.json().invocations[0].usage).toBeUndefined();
    }
    const reopened = await join("Reopened", "human");
    expect(JSON.stringify(snapshots.get("Reopened"))).not.toContain("private");
    await expect(
      reopened.next((event) => event.type === "invocation.trace", 100),
    ).rejects.toThrow();
    guest.socket.close();
    await guest.waitClosed();
    const returningGuest = await join("Viewer", "human", guestToken);
    expect(JSON.stringify(snapshots.get("Viewer"))).not.toContain("private");
    await expect(
      returningGuest.next((event) => event.type === "invocation.trace", 100),
    ).rejects.toThrow();

    helper.send({
      type: "message.send",
      clientMessageId: "reply",
      content: "An independent reply",
      parentMessageId: message.id,
    });
    expect(
      await alice.next(
        (event) => event.type === "message.created" && event.message.senderName === "helper",
      ),
    ).toMatchObject({ message: { content: "An independent reply" } });
  });
});
