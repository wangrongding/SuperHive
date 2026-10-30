import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ChatMessage, ServerEvent, UploadedAttachment } from "@ai-hive/protocol";
import { buildApp, type BuildAppOptions } from "./app.js";
import { Peer } from "./test-peer.js";

const OWNER = { Authorization: "Bearer test-token" };
const errorCode = (event: ServerEvent) => (event.type === "error" ? event.code : undefined);

/** 1×1 透明 PNG */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

describe("附件", () => {
  let close: (() => Promise<void>) | undefined;
  const peers: Peer[] = [];
  afterEach(async () => {
    for (const peer of peers.splice(0)) peer.socket.close();
    await close?.();
    close = undefined;
  });

  async function start(options: Partial<BuildAppOptions> = {}) {
    let now = Date.now();
    const dir = mkdtempSync(path.join(tmpdir(), "hive-att-test-"));
    const app = await buildApp({
      databasePath: ":memory:",
      token: "test-token",
      staticDir: "/definitely-not-present",
      attachmentsDir: dir,
      now: () => now,
      ...options,
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    close = () => app.close();
    const port = (app.server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    const upload = async (
      name: string,
      content: Buffer | string,
      headers: Record<string, string> = OWNER,
      roomId = "general",
    ) => {
      const form = new FormData();
      form.append(
        "file",
        new Blob([typeof content === "string" ? content : new Uint8Array(content)]),
        name,
      );
      const response = await fetch(`${base}/api/rooms/${roomId}/attachments`, {
        method: "POST",
        headers,
        body: form,
      });
      const text = await response.text();
      return {
        status: response.status,
        body: (text ? JSON.parse(text) : {}) as Record<string, any>,
        text,
      };
    };
    const download = (id: string, headers: Record<string, string> = OWNER) =>
      fetch(`${base}/api/attachments/${id}`, { headers });
    const join = async (username: string, type: "human" | "agent", token = "test-token") => {
      const peer = await Peer.connect(`ws://127.0.0.1:${port}/ws`);
      peers.push(peer);
      peer.send({ type: "participant.join", username, participantType: type, token });
      await peer.next((event) => event.type === "room.snapshot");
      return peer;
    };
    const sendMessage = async (peer: Peer, input: Record<string, unknown>) => {
      peer.send({ type: "message.send", ...input });
      return peer.next((event) => event.type === "message.created" || event.type === "error");
    };
    const guest = async (username: string, roomId = "general") => {
      const json = { ...OWNER, "Content-Type": "application/json" };
      if (roomId !== "general") {
        await fetch(`${base}/api/rooms`, {
          method: "POST",
          headers: json,
          body: JSON.stringify({ id: roomId }),
        });
      }
      const invite = (await (
        await fetch(`${base}/api/rooms/${roomId}/invites`, {
          method: "POST",
          headers: json,
          body: JSON.stringify({ expiresInMinutes: 60, allowAgents: false }),
        })
      ).json()) as { token: string };
      const redeemed = (await (
        await fetch(`${base}/api/invites/redeem`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: invite.token, username }),
        })
      ).json()) as { token: string };
      return { token: redeemed.token, headers: { Authorization: `Bearer ${redeemed.token}` } };
    };
    return {
      app,
      dir,
      base,
      port,
      upload,
      download,
      join,
      sendMessage,
      guest,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  const created = (event: ServerEvent): ChatMessage => {
    if (event.type !== "message.created")
      throw new Error(`expected message.created: ${JSON.stringify(event)}`);
    return event.message;
  };

  it("上传图片后只有上传者能读；随消息发出后同房间可读、其他房间拒绝", async () => {
    const { upload, download, join, sendMessage, guest } = await start();
    const owner = await join("rd", "human");
    const alice = await guest("alice");
    const outsider = await guest("eve", "secret");

    const uploaded = await upload("../../shot.png", PNG);
    expect(uploaded.status).toBe(201);
    const item = uploaded.body as UploadedAttachment;
    expect(item).toMatchObject({
      name: "shot.png",
      kind: "image",
      mime: "image/png",
      size: PNG.length,
      width: 1,
      height: 1,
      roomId: "general",
    });
    // 还没发出：访客（另一个上传者）看不到
    expect((await download(item.id, alice.headers)).status).toBe(404);
    expect((await download(item.id)).status).toBe(200);

    // 只带附件、正文为空
    const message = created(
      await sendMessage(owner, { clientMessageId: "m1", attachmentIds: [item.id] }),
    );
    expect(message.content).toBe("");
    expect(message.attachments).toEqual([
      expect.objectContaining({ id: item.id, name: "shot.png", kind: "image" }),
    ]);

    const read = await download(item.id, alice.headers);
    expect(read.status).toBe(200);
    expect(read.headers.get("content-type")).toBe("image/png");
    expect(read.headers.get("x-content-type-options")).toBe("nosniff");
    expect(read.headers.get("content-disposition")).toMatch(/^inline/);
    expect(Buffer.from(await read.arrayBuffer()).equals(PNG)).toBe(true);
    expect((await download(item.id, outsider.headers)).status).toBe(403);
    expect((await download(item.id, {})).status).toBe(401);
    // 凭证只认 Authorization 头，不认 URL 参数
    expect((await fetch(`${read.url}?token=test-token`)).status).toBe(401);
  });

  it("HTML、SVG 按纯文本下载，不交给浏览器渲染；二进制文件不内联", async () => {
    const { upload, download } = await start();
    const html = (await upload("page.html", "<script>alert(1)</script>")).body;
    expect(html).toMatchObject({ kind: "text", mime: "text/plain" });
    const svg = (await upload("logo.svg", '<svg xmlns="http://www.w3.org/2000/svg"/>')).body;
    expect(svg.kind).toBe("text");
    const response = await download(html.id);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    const binary = (await upload("blob.dat", Buffer.from([0, 1, 2, 3, 0xff]))).body;
    expect(binary).toMatchObject({ kind: "file", mime: "application/octet-stream" });
  });

  it("重发同一条消息幂等；附件不能被第二条消息再用；空消息被拒", async () => {
    const { upload, join, sendMessage } = await start();
    const owner = await join("rd", "human");
    const item = (await upload("a.txt", "hello")).body;
    const first = created(
      await sendMessage(owner, {
        clientMessageId: "same",
        content: "看看",
        attachmentIds: [item.id],
      }),
    );
    const again = created(
      await sendMessage(owner, {
        clientMessageId: "same",
        content: "看看",
        attachmentIds: [item.id],
      }),
    );
    expect(again.id).toBe(first.id);
    expect(
      errorCode(await sendMessage(owner, { clientMessageId: "other", attachmentIds: [item.id] })),
    ).toBe("ATTACHMENT_UNAVAILABLE");
    expect(errorCode(await sendMessage(owner, { clientMessageId: "empty", content: "  " }))).toBe(
      "EMPTY_MESSAGE",
    );
  });

  it("访客不能把别人待发的附件挂到自己消息上，也不能跨房间", async () => {
    const { upload, join, sendMessage, guest } = await start();
    await join("rd", "human");
    const ownerItem = (await upload("a.txt", "secret")).body;
    const alice = await guest("alice");
    const alicePeer = await join("alice", "human", alice.token);
    expect(
      errorCode(
        await sendMessage(alicePeer, { clientMessageId: "x", attachmentIds: [ownerItem.id] }),
      ),
    ).toBe("ATTACHMENT_UNAVAILABLE");
    const own = (await upload("b.txt", "mine", alice.headers)).body;
    expect(
      created(await sendMessage(alicePeer, { clientMessageId: "y", attachmentIds: [own.id] }))
        .attachments,
    ).toHaveLength(1);
    // 访客上传到别的房间
    expect((await upload("c.txt", "x", alice.headers, "secret")).status).toBe(403);
  });

  it("未发出的附件 24 小时后过期，清理后文件删除", async () => {
    const { app, upload, download, join, sendMessage, advance, dir } = await start();
    const owner = await join("rd", "human");
    const item = (await upload("old.txt", "stale")).body;
    advance(24 * 60 * 60_000 + 1);
    expect((await download(item.id)).status).toBe(410);
    expect(
      errorCode(await sendMessage(owner, { clientMessageId: "late", attachmentIds: [item.id] })),
    ).toBe("ATTACHMENT_EXPIRED");
    const files = () => readdirSync(dir).filter((name) => name !== ".tmp");
    expect(files()).toHaveLength(1);
    (app as unknown as { attachmentStore: { sweep(): unknown } }).attachmentStore.sweep();
    expect(readdirSync(path.join(dir, files()[0]!))).toEqual([]);
  });

  it("撤回只撤这条消息的引用；内容相同的另一条仍可读，最后一个引用撤回后文件被清理", async () => {
    const { upload, download, join, sendMessage, advance, dir, app } = await start();
    const owner = await join("rd", "human");
    const a = (await upload("same.txt", "shared content")).body;
    const b = (await upload("same-copy.txt", "shared content")).body;
    expect(a.sha256).toBe(b.sha256);
    const m1 = created(await sendMessage(owner, { clientMessageId: "1", attachmentIds: [a.id] }));
    const m2 = created(await sendMessage(owner, { clientMessageId: "2", attachmentIds: [b.id] }));

    owner.send({ type: "message.delete", messageId: m1.id });
    const deleted = await owner.next((event) => event.type === "message.deleted");
    expect(deleted.type === "message.deleted" && deleted.message.attachments).toBeFalsy();
    expect((await download(a.id)).status).toBe(410);
    expect((await download(b.id)).status).toBe(200);

    const sweep = () =>
      (app as unknown as { attachmentStore: { sweep(): unknown } }).attachmentStore.sweep();
    advance(11 * 60_000);
    sweep();
    const blob = path.join(dir, a.sha256.slice(0, 2));
    expect(readdirSync(blob)).toHaveLength(1);

    owner.send({ type: "message.delete", messageId: m2.id });
    await owner.next((event) => event.type === "message.deleted");
    advance(11 * 60_000);
    sweep();
    expect(existsSync(blob) ? readdirSync(blob) : []).toHaveLength(0);
  });

  it("超出房间配额与单文件上限时拒绝", async () => {
    const { upload } = await start({ roomAttachmentQuotaBytes: 1024 });
    expect((await upload("a.txt", "x".repeat(800))).status).toBe(201);
    const over = await upload("b.txt", "y".repeat(800));
    expect(over.status).toBe(413);
    expect(over.body.code).toBe("ROOM_ATTACHMENT_QUOTA");
  });

  it("单个文件超过 20 MiB 被拒绝，临时文件不残留", async () => {
    const { upload, dir } = await start();
    const big = await upload("big.bin", Buffer.alloc(20 * 1024 * 1024 + 1, 1));
    expect(big.status, big.text).toBe(413);
    expect(big.body.code).toBe("ATTACHMENT_TOO_LARGE");
    expect(readdirSync(path.join(dir, ".tmp"))).toEqual([]);
  });

  it("上传中途取消不留下记录和临时文件", async () => {
    const { port, dir, upload } = await start();
    await new Promise<void>((resolve) => {
      const boundary = "----hive";
      const request = httpRequest({
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/api/rooms/general/attachments",
        headers: {
          ...OWNER,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": String(5 * 1024 * 1024),
        },
      });
      request.on("error", () => resolve());
      request.write(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.bin"\r\n\r\n`,
      );
      request.write(Buffer.alloc(256 * 1024, 7));
      setTimeout(() => {
        request.destroy();
        resolve();
      }, 100);
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(readdirSync(path.join(dir, ".tmp"))).toEqual([]);
    expect(readdirSync(dir).filter((name) => name !== ".tmp")).toEqual([]);
    // 服务端仍正常
    expect((await upload("ok.txt", "ok")).status).toBe(201);
  });

  it("Agent 经 hive_attachment_read 读取文本分段与图片；未发出或撤回的读不到", async () => {
    const { base, upload, join, sendMessage } = await start();
    const owner = await join("rd", "human");
    await join("reader", "agent");
    const text = (await upload("notes.md", `${"中".repeat(10)}tail`)).body;
    const image = (await upload("shot.png", PNG)).body;
    const pending = (await upload("pending.txt", "draft")).body;
    const message = created(
      await sendMessage(owner, {
        clientMessageId: "m",
        content: "@reader 看附件",
        attachmentIds: [text.id, image.id],
      }),
    );

    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: {
        headers: { ...OWNER, "X-Hive-Room": "general", "X-Hive-Agent-Name": "reader" },
      },
    });
    const client = new Client({ name: "att-test", version: "0.1.0" });
    await client.connect(transport as unknown as Transport);

    // 每个汉字 3 字节：maxBytes=10 只能完整读到 3 个字，不截断字符
    const first = await client.callTool({
      name: "hive_attachment_read",
      arguments: { attachmentId: text.id, maxBytes: 10 },
    });
    const firstData = first.structuredContent as { text: string; nextOffset: number };
    expect(firstData.text).toBe("中中中");
    expect(firstData.nextOffset).toBe(9);
    const rest = await client.callTool({
      name: "hive_attachment_read",
      arguments: { attachmentId: text.id, offset: 9 },
    });
    expect(rest.structuredContent as { text: string; nextOffset: number | null }).toMatchObject({
      text: `${"中".repeat(7)}tail`,
      nextOffset: null,
    });

    const picture = await client.callTool({
      name: "hive_attachment_read",
      arguments: { attachmentId: image.id },
    });
    const content = picture.content as Array<{ type: string; data?: string; mimeType?: string }>;
    expect(content.find((part) => part.type === "image")).toEqual({
      type: "image",
      data: PNG.toString("base64"),
      mimeType: "image/png",
    });

    const notSent = await client.callTool({
      name: "hive_attachment_read",
      arguments: { attachmentId: pending.id },
    });
    expect(notSent.isError).toBe(true);

    owner.send({ type: "message.delete", messageId: message.id });
    await owner.next((event) => event.type === "message.deleted");
    const recalled = await client.callTool({
      name: "hive_attachment_read",
      arguments: { attachmentId: text.id },
    });
    expect(recalled.isError).toBe(true);
    await client.close();
  });

  it("本机房主 Agent 拿到 Server 存的文件路径；访客拿不到", async () => {
    const { app, upload, join, sendMessage, guest } = await start();
    const owner = await join("rd", "human");
    const item = (await upload("a.txt", "hello")).body;
    // 还没发出不提供路径
    const early = await app.inject({
      url: `/api/attachments/${item.id}/local-path`,
      headers: OWNER,
      remoteAddress: "127.0.0.1",
    });
    expect(early.statusCode).toBe(404);
    await sendMessage(owner, { clientMessageId: "m", attachmentIds: [item.id] });
    const local = await app.inject({
      url: `/api/attachments/${item.id}/local-path`,
      headers: OWNER,
      remoteAddress: "127.0.0.1",
    });
    expect(local.statusCode).toBe(200);
    expect(existsSync(local.json().path)).toBe(true);
    const remote = await app.inject({
      url: `/api/attachments/${item.id}/local-path`,
      headers: OWNER,
      remoteAddress: "203.0.113.9",
    });
    expect(remote.statusCode).toBe(403);
    const alice = await guest("alice");
    const viaGuest = await app.inject({
      url: `/api/attachments/${item.id}/local-path`,
      headers: alice.headers,
      remoteAddress: "127.0.0.1",
    });
    expect(viaGuest.statusCode).toBe(403);
  });
});
