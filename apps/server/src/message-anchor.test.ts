import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import type { AddressInfo } from "node:net";
import { Peer } from "./test-peer.js";

describe("message ID anchors", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let peer: Peer | undefined;
  afterEach(async () => {
    peer?.socket.close();
    await app?.close();
  });

  it("loads sequence context by ID and does not expose messages outside the authorized room", async () => {
    app = await buildApp({
      databasePath: ":memory:",
      token: "test-token",
      staticDir: "/nope",
      sandbox: true,
    });
    const headers = { Authorization: "Bearer test-token" };
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
    peer.send({ type: "message.send", content: "原问题", clientMessageId: "anchor" });
    const created = await peer.next((event) => event.type === "message.created");
    if (created.type !== "message.created") throw new Error("Message missing");
    const message = created.message;
    const anchored = await app.inject({
      url: `/api/rooms/general/messages?messageId=${message.id}&limit=1`,
      headers,
    });
    expect(anchored.json().messages).toEqual([message]);
    expect(
      (await app.inject({ url: "/api/rooms/general/messages?messageId=not-a-uuid", headers }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          url: `/api/rooms/general/messages?messageId=${crypto.randomUUID()}`,
          headers,
        })
      ).statusCode,
    ).toBe(404);
    const room = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers,
      payload: { id: "other", name: "other" },
    });
    expect(room.statusCode).toBe(201);
    expect(
      (await app.inject({ url: `/api/rooms/other/messages?messageId=${message.id}`, headers }))
        .statusCode,
    ).toBe(404);
    const invite = await app.inject({
      method: "POST",
      url: "/api/rooms/general/invites",
      headers,
      payload: { expiresInMinutes: 60 },
    });
    const guest = await app.inject({
      method: "POST",
      url: "/api/invites/redeem",
      payload: { token: invite.json().token, username: "alice" },
    });
    const guestHeaders = { Authorization: `Bearer ${guest.json().token}` };
    expect(
      (
        await app.inject({
          url: `/api/rooms/other/messages?messageId=${message.id}`,
          headers: guestHeaders,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: `/api/rooms/general/messages?messageId=${message.id}`,
          headers: guestHeaders,
        })
      ).statusCode,
    ).toBe(200);
  });
});
