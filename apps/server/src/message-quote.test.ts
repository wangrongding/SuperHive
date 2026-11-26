import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { buildApp } from "./app.js";
import { Peer } from "./test-peer.js";

describe("quoted replies", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let peer: Peer | undefined;
  afterEach(async () => {
    peer?.socket.close();
    await app?.close();
  });

  it("records which message a web message quotes and broadcasts it", async () => {
    app = await buildApp({
      databasePath: ":memory:",
      token: "test-token",
      staticDir: "/nope",
      sandbox: true,
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    peer = await Peer.connect(`ws://127.0.0.1:${port}/ws`);
    peer.send({
      type: "participant.join",
      roomId: "general",
      username: "rd",
      participantType: "human",
      token: "test-token",
    });
    await peer.next((event) => event.type === "room.snapshot");
    peer.send({ type: "message.send", content: "原问题", clientMessageId: "quoted" });
    const original = await peer.next((event) => event.type === "message.created");
    if (original.type !== "message.created") throw new Error("Message missing");

    peer.send({
      type: "message.send",
      content: `> #${original.message.seq} · rd\n> 原问题\n\n补充一句`,
      clientMessageId: "quoting",
      quotedMessageId: original.message.id,
    });
    const quoting = await peer.next(
      (event) => event.type === "message.created" && event.message.clientMessageId === "quoting",
    );
    if (quoting.type !== "message.created") throw new Error("Message missing");
    expect(quoting.message.quote).toEqual({
      messageId: original.message.id,
      seq: original.message.seq,
      senderName: "rd",
    });
    // 引用块里的文字不算新的 @：正文没写 @ 时不唤醒任何人
    expect(quoting.message.mentions).toEqual([]);

    const listed = await app.inject({
      url: "/api/rooms/general/messages",
      headers: { Authorization: "Bearer test-token" },
    });
    expect(
      (listed.json().messages as { id: string; quote?: unknown }[]).find(
        (message) => message.id === quoting.message.id,
      )?.quote,
    ).toEqual(quoting.message.quote);
  });
});
