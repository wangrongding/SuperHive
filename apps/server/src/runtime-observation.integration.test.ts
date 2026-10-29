import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { ServerEvent } from "@ai-hive/protocol";
import { buildApp } from "./app.js";

const sockets: WebSocket[] = [];
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await app?.close();
  app = undefined;
});
it("broadcasts runtime facts and restores them in a reconnect snapshot, without clearing errors on heartbeat", async () => {
  app = await buildApp({
    databasePath: ":memory:",
    token: "test-token",
    staticDir: "/does-not-exist",
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  async function join(name: string, participantType: "human" | "agent") {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    sockets.push(socket);
    const events: ServerEvent[] = [];
    socket.on("message", (data) => events.push(JSON.parse(data.toString()) as ServerEvent));
    await new Promise<void>((resolve) => socket.once("open", resolve));
    const send = (event: object) => socket.send(JSON.stringify(event));
    const next = async (type: ServerEvent["type"]) => {
      await expect.poll(() => events.some((event) => event.type === type)).toBe(true);
      return events.splice(
        events.findIndex((event) => event.type === type),
        1,
      )[0]!;
    };
    send({
      type: "participant.join",
      username: name,
      participantType,
      roomId: "general",
      token: "test-token",
    });
    const snapshot = await next("room.snapshot");
    return { send, next, snapshot };
  }
  const human = await join("Alice", "human");
  const agent = await join("helper", "agent");
  human.send({ type: "message.send", clientMessageId: "runtime-test", content: "@helper work" });
  const mention = await agent.next("agent.mentioned");
  if (mention.type !== "agent.mentioned") throw new Error("missing mention");
  await human.next("invocation.updated");
  agent.send({
    type: "invocation.report",
    messageId: mention.message.id,
    status: "running",
    runtimeEvent: { kind: "activity", phase: "tool_running", tool: "read" },
  });
  const progress = await human.next("invocation.updated");
  if (progress.type !== "invocation.updated") throw new Error("missing progress");
  expect(progress.invocation.runtime).toMatchObject({
    phase: "tool_running",
    tool: "read",
    lastProgressAt: expect.any(String),
  });
  agent.send({
    type: "invocation.report",
    messageId: mention.message.id,
    status: "running",
    runtimeEvent: { kind: "provider_error", code: 503 },
  });
  await human.next("invocation.updated");
  agent.send({ type: "invocation.report", messageId: mention.message.id, status: "running" });
  const heartbeat = await human.next("invocation.updated");
  if (heartbeat.type !== "invocation.updated") throw new Error("missing heartbeat");
  expect(heartbeat.invocation.runtime?.lastError).toMatchObject({ code: 503 });
  expect(heartbeat.invocation.runtime?.lastProgressAt).toBe(
    progress.invocation.runtime?.lastProgressAt,
  );
  const { snapshot } = await join("Observer", "human");
  if (snapshot.type !== "room.snapshot") throw new Error("missing snapshot");
  expect(snapshot.invocations[0]?.runtime).toEqual(heartbeat.invocation.runtime);
});
