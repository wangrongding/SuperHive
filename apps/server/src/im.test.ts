import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ChatMessage, ServerEvent } from "@superhive/protocol";
import WebSocket from "ws";
import { buildApp } from "./app.js";
import { parseChoice } from "./im/im-hub.js";
import { renderFeishuCard } from "./im/feishu-card.js";
import type {
  ImChannelDriver,
  ImInbound,
  ImLoginCallbacks,
  ImRich,
  ImTransportEvents,
} from "./im/types.js";

class Peer {
  readonly socket: WebSocket;
  readonly events: ServerEvent[] = [];
  private readonly listeners = new Set<() => void>();

  private constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.on("message", (raw) => {
      this.events.push(JSON.parse(raw.toString()) as ServerEvent);
      for (const listener of this.listeners) listener();
    });
  }

  static async connect(url: string): Promise<Peer> {
    const peer = new Peer(url);
    await new Promise<void>((resolve, reject) => {
      peer.socket.once("open", resolve);
      peer.socket.once("error", reject);
    });
    return peer;
  }

  send(event: object): void {
    this.socket.send(JSON.stringify(event));
  }

  async next(predicate: (event: ServerEvent) => boolean, timeoutMs = 2_000): Promise<ServerEvent> {
    const index = this.events.findIndex(predicate);
    if (index >= 0) return this.events.splice(index, 1)[0]!;
    return new Promise<ServerEvent>((resolve, reject) => {
      const check = () => {
        const found = this.events.findIndex(predicate);
        if (found < 0) return;
        cleanup();
        resolve(this.events.splice(found, 1)[0]!);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out waiting for WebSocket event."));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.listeners.delete(check);
      };
      this.listeners.add(check);
    });
  }
}

/** 假的 IM 渠道：扫码由测试触发，发出的文字记下来，入站消息由测试注入 */
class FakeChannel {
  sent: Array<{ chatId: string; text: string; replyTo?: string; rich?: ImRich }> = [];
  /** 每条发出的消息对应的平台消息 ID */
  sentIds = new Map<object, string>();
  /** 模拟支持卡片的渠道（飞书） */
  richCards = false;
  /** 设了就让发文字失败（模拟个人微信「要你先发一条消息」） */
  sendError: Error | undefined;
  /** 卡片原地更新、表情、文件的调用记录 */
  updates: Array<{ externalId: string; rich: ImRich }> = [];
  reactions: Array<{ op: "add" | "remove"; externalId: string; emoji?: string; id?: string }> = [];
  files: Array<{ chatId: string; name: string; kind: string; size: number; replyTo?: string }> = [];
  events: ImTransportEvents | undefined;
  login:
    { callbacks: ImLoginCallbacks; resolve: (owner: string, appId?: string) => void } | undefined;
  transports = 0;
  closes = 0;
  private counter = 0;

  driver(channel: "feishu" | "wechat"): ImChannelDriver {
    return {
      channel,
      maxTextLength: 200,
      ...(this.richCards ? { richTextLength: 1000 } : {}),
      login: (callbacks) =>
        new Promise((resolve, reject) => {
          callbacks.signal.addEventListener("abort", () => reject(new Error("已取消")));
          callbacks.onQr("https://example.test/qr", 300);
          this.login = {
            callbacks,
            resolve: (owner, appId = "cli_test") =>
              resolve({
                ownerActorId: owner,
                label: "测试机器人",
                config: { appId, ...(this.richCards ? { cardCallbacks: "1" } : {}) },
                secret: "s3cret",
                identityKey: "appId",
              }),
          };
        }),
      createTransport: () => {
        this.transports += 1;
        return {
          start: async (events) => {
            this.events = events;
          },
          sendText: async (chatId, text, replyTo) => {
            if (this.sendError) throw this.sendError;
            this.sent.push({ chatId, text, ...(replyTo ? { replyTo } : {}) });
            this.counter += 1;
            return `out-${this.counter}`;
          },
          ...(this.richCards
            ? {
                sendRich: async (chatId: string, rich: ImRich, text: string, replyTo?: string) => {
                  const item = { chatId, text, rich, ...(replyTo ? { replyTo } : {}) };
                  this.sent.push(item);
                  this.counter += 1;
                  this.sentIds.set(item, `out-${this.counter}`);
                  return `out-${this.counter}`;
                },
                updateRich: async (externalId: string, rich: ImRich) => {
                  this.updates.push({ externalId, rich });
                },
                react: async (externalId: string, emoji: string) => {
                  this.counter += 1;
                  const id = `reaction-${this.counter}`;
                  this.reactions.push({ op: "add", externalId, emoji, id });
                  return id;
                },
                unreact: async (externalId: string, id: string) => {
                  this.reactions.push({ op: "remove", externalId, id });
                },
                sendFile: async (
                  chatId: string,
                  file: { name: string; kind: string; data: Buffer },
                  replyTo?: string,
                ) => {
                  this.files.push({
                    chatId,
                    name: file.name,
                    kind: file.kind,
                    size: file.data.length,
                    ...(replyTo ? { replyTo } : {}),
                  });
                  this.counter += 1;
                  return `out-${this.counter}`;
                },
                download: async (_externalId: string, file: { key: string; name?: string }) => ({
                  name: file.name ?? `${file.key}.png`,
                  data: PNG,
                }),
              }
            : {}),
          close: async () => {
            this.closes += 1;
          },
        };
      },
    };
  }

  emit(message: Partial<ImInbound> & { text: string }): void {
    this.counter += 1;
    this.events!.onMessage({
      externalId: `in-${this.counter}`,
      chatId: "chat-1",
      chatType: "p2p",
      senderId: "owner-open-id",
      ...message,
    });
  }
}

const OWNER = { Authorization: "Bearer test-token", "Content-Type": "application/json" };
/** 1×1 PNG */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function until<T>(check: () => T | undefined, timeoutMs = 2_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() - started > timeoutMs) throw new Error("condition not met");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("IM 连接", () => {
  let close: (() => Promise<void>) | undefined;
  const peers: Peer[] = [];
  afterEach(async () => {
    for (const peer of peers.splice(0)) peer.socket.close();
    await close?.();
    close = undefined;
  });

  async function start(
    options: {
      richCards?: boolean;
      databasePath?: string;
      imKeyPath?: string;
      sandbox?: boolean;
    } = {},
  ) {
    const fake = new FakeChannel();
    fake.richCards = Boolean(options.richCards);
    const clock = { offset: 0 };
    const app = await buildApp({
      databasePath: options.databasePath ?? ":memory:",
      ...(options.imKeyPath ? { imKeyPath: options.imKeyPath } : {}),
      ...(options.sandbox ? { sandbox: true } : {}),
      now: () => Date.now() + clock.offset,
      token: "test-token",
      staticDir: "/definitely-not-present",
      imDrivers: { feishu: fake.driver("feishu"), wechat: fake.driver("wechat") },
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    close = () => app.close();
    const port = (app.server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    const api = async (method: string, url: string, body?: unknown) => {
      const headers = { ...OWNER } as Record<string, string>;
      if (body === undefined) delete headers["Content-Type"];
      const response = await fetch(`${base}${url}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: (await response.json()) as Record<string, any> };
    };
    const join = async (
      username: string,
      participantType: "human" | "agent",
      roomId = "general",
    ) => {
      const peer = await Peer.connect(`ws://127.0.0.1:${port}/ws`);
      peers.push(peer);
      peer.send({
        type: "participant.join",
        username,
        participantType,
        roomId,
        token: "test-token",
      });
      await peer.next((event) => event.type === "room.snapshot");
      return peer;
    };
    /** rd 在网页里，扫码把飞书接进 general */
    const connect = async () => {
      const rd = await join("rd", "human");
      const started = await api("POST", "/api/rooms/general/im/login", {
        channel: "feishu",
        ownerName: "rd",
      });
      expect(started.status).toBe(201);
      await until(() => fake.login);
      let view: Record<string, any> = {};
      for (let i = 0; i < 50 && view.status !== "waiting_scan"; i += 1) {
        view = (await api("GET", `/api/im/logins/${started.body.id}`)).body;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(view.qrDataUrl).toMatch(/^data:image\/png;base64,/);
      fake.login!.resolve("owner-open-id");
      await until(() => fake.events);
      let connections: Array<Record<string, any>> = [];
      for (let i = 0; i < 50 && connections[0]?.status !== "connected"; i += 1) {
        connections = (await api("GET", "/api/rooms/general/im")).body.connections;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return { rd, connections, loginId: started.body.id as string };
    };
    const setLevel = async (level: string) => {
      const [connection] = (await api("GET", "/api/rooms/general/im")).body.connections as Array<{
        id: string;
      }>;
      const result = await api("POST", `/api/im/connections/${connection!.id}/level`, { level });
      expect(result.body.level).toBe(level);
      return connection!.id;
    };
    return { app, port, api, join, connect, fake, clock, setLevel, base };
  }

  it("沙箱预览不恢复已保存的 IM 连接、也不能扫码新连；正常重启照常恢复", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hive-im-sandbox-"));
    const files = {
      databasePath: path.join(dir, "hive.sqlite"),
      imKeyPath: path.join(dir, "im-secret.key"),
    };
    const restart = async () => {
      for (const peer of peers.splice(0)) peer.socket.close();
      const current = close;
      close = undefined;
      await current?.();
    };
    try {
      const first = await start(files);
      await first.connect();
      expect(first.fake.transports).toBe(1);
      await restart();

      const preview = await start({ ...files, sandbox: true });
      await preview.join("rd", "human");
      const login = await preview.api("POST", "/api/rooms/general/im/login", {
        channel: "feishu",
        ownerName: "rd",
      });
      expect(login.status).not.toBe(201);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(preview.fake.transports).toBe(0);
      expect(preview.fake.login).toBeUndefined();
      await restart();

      // 对照：同一份数据不带沙箱启动，连接会恢复（说明上面没恢复是沙箱拦下的）
      const normal = await start(files);
      await until(() => normal.fake.transports === 1);
    } finally {
      await restart();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("扫码连接后，房主在 IM 里发的消息以房主身份进入房间并唤醒 Agent，结果回到原会话", async () => {
    const { join, connect, fake, api } = await start();
    const helper = await join("helper", "agent");
    const { rd, connections } = await connect();
    expect(connections[0]).toMatchObject({
      channel: "feishu",
      ownerName: "rd",
      label: "测试机器人",
    });
    expect(JSON.stringify(connections)).not.toContain("s3cret");
    expect(JSON.stringify(connections)).not.toContain("owner-open-id");

    fake.emit({ text: "@helper 看下测试" });
    const created = await rd.next(
      (event) => event.type === "message.created" && event.message.senderName === "rd",
    );
    const message = (created as { message: ChatMessage }).message;
    expect(message).toMatchObject({ content: "@helper 看下测试", via: { channel: "feishu" } });
    const mentioned = await helper.next((event) => event.type === "agent.mentioned");
    expect((mentioned as { message: ChatMessage }).message.id).toBe(message.id);

    // 同一条 IM 消息被平台重推：不重复入库、不重复唤醒
    fake.events!.onMessage({
      externalId: "in-1",
      chatId: "chat-1",
      chatType: "p2p",
      senderId: "owner-open-id",
      text: "@helper 看下测试",
    });

    helper.send({
      type: "message.send",
      clientMessageId: "reply-1",
      content: "测试是因为 @rd 的配置缺了一项",
      parentMessageId: message.id,
    });
    const delivered = await until(() => fake.sent.find((item) => item.text.includes("配置缺了")));
    expect(delivered).toMatchObject({ chatId: "chat-1", replyTo: "in-1" });
    // 顶部标注「房间名 - 发送者」
    expect(delivered.text.split("\n")[0]).toBe("general - helper");
    // 转述的正文里 @ 换成全角，不会在 IM 那边变成提及
    expect(delivered.text).toContain("＠rd");

    const history = await api("GET", "/api/rooms/general/messages");
    const fromIm = (history.body.messages as ChatMessage[]).filter((item) => item.via);
    expect(fromIm).toHaveLength(1);
  });

  it("只接受扫码人本人的消息；Agent 之间的讨论和网页上的消息不推到 IM", async () => {
    const { join, connect, fake } = await start();
    const helper = await join("helper", "agent");
    await join("worker", "agent");
    const { rd } = await connect();

    fake.emit({ text: "@helper 删库", senderId: "someone-else" });
    await until(() => fake.sent.find((item) => item.text.includes("只转发房主本人")));

    fake.emit({ text: "@helper 列出待办" });
    const created = await rd.next(
      (event) => event.type === "message.created" && event.message.senderName === "rd",
    );
    const trigger = (created as { message: ChatMessage }).message;
    await helper.next((event) => event.type === "agent.mentioned");
    const sentBefore = fake.sent.length;
    // helper 执行中转给 worker 的讨论不推；网页上 rd 自己发的消息也不推
    helper.send({ type: "invocation.report", messageId: trigger.id, status: "running" });
    helper.send({
      type: "message.send",
      clientMessageId: "chatter",
      content: "@worker 帮我查一下",
    });
    rd.send({ type: "message.send", clientMessageId: "web", content: "网页上说一句" });
    await rd.next(
      (event) => event.type === "message.created" && event.message.content === "网页上说一句",
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fake.sent.length).toBe(sentBefore);
  });

  it("没有 @ 时提示用法；/room 切换房间；暂停后不再收发，断开后连接消失", async () => {
    const { connect, fake, api, app } = await start();
    const { rd } = await connect();
    fake.emit({ text: "随便说一句" });
    await until(() => fake.sent.find((item) => item.text.includes("要让 Agent 处理")));
    await rd.next(
      (event) => event.type === "message.created" && event.message.content === "随便说一句",
    );

    fake.emit({ text: "/room" });
    await until(() => fake.sent.find((item) => item.text.includes("默认房间")));

    const [connection] = (await api("GET", "/api/rooms/general/im")).body.connections as Array<{
      id: string;
    }>;
    const paused = await api("POST", `/api/im/connections/${connection!.id}/pause`);
    expect(paused.body.status).toBe("paused");
    expect(fake.closes).toBe(1);
    const before = (await api("GET", "/api/rooms/general/messages")).body.messages.length;
    fake.emit({ text: "暂停期间的消息" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await api("GET", "/api/rooms/general/messages")).body.messages.length).toBe(before);

    expect((await api("DELETE", `/api/im/connections/${connection!.id}`)).status).toBe(200);
    expect((await api("GET", "/api/rooms/general/im")).body.connections).toEqual([]);
    void app;
  });

  it("Agent 的提问推到 IM，房主回复字母即点选作答并唤醒 Agent", async () => {
    const { join, connect, fake, port } = await start();
    const helper = await join("helper", "agent");
    const { rd } = await connect();
    fake.emit({ text: "@helper 发布一下" });
    const mentioned = await helper.next((event) => event.type === "agent.mentioned");
    const trigger = (mentioned as { message: ChatMessage }).message;
    helper.send({ type: "invocation.report", messageId: trigger.id, status: "running" });
    await rd.next(
      (event) => event.type === "invocation.updated" && event.invocation.status === "running",
    );

    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: {
        headers: {
          Authorization: "Bearer test-token",
          "X-Hive-Room": "general",
          "X-Hive-Agent-Name": "helper",
        },
      },
    });
    const client = new Client({ name: "im-test", version: "0.1.0" });
    await client.connect(transport as unknown as Transport);
    await client.callTool({
      name: "hive_ask_human",
      arguments: { question: "发到哪个环境？", options: ["测试环境", "正式环境"] },
    });
    const pushed = await until(() => fake.sent.find((item) => item.text.includes("发到哪个环境")));
    expect(pushed.text).toContain("A. 测试环境");
    expect(pushed.text).toContain("回复选项字母作答");

    fake.emit({ text: "a" });
    const woken = await helper.next(
      (event) => event.type === "agent.mentioned" && event.message.content.startsWith("选择 A"),
    );
    expect((woken as { message: ChatMessage }).message).toMatchObject({
      content: "选择 A：测试环境",
      answer: { selected: ["A"] },
    });
    await client.close();
  });

  it("提问卡片：正文只留问题，选项单独列出，回复字母照样作答", async () => {
    const { join, connect, fake, port } = await start({ richCards: true });
    const helper = await join("helper", "agent");
    const { rd } = await connect();
    fake.emit({ text: "@helper 发布一下" });
    const mentioned = await helper.next((event) => event.type === "agent.mentioned");
    const trigger = (mentioned as { message: ChatMessage }).message;
    helper.send({ type: "invocation.report", messageId: trigger.id, status: "running" });
    await rd.next(
      (event) => event.type === "invocation.updated" && event.invocation.status === "running",
    );
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: {
        headers: {
          Authorization: "Bearer test-token",
          "X-Hive-Room": "general",
          "X-Hive-Agent-Name": "helper",
        },
      },
    });
    const client = new Client({ name: "im-test", version: "0.1.0" });
    await client.connect(transport as unknown as Transport);
    await client.callTool({
      name: "hive_ask_human",
      arguments: { question: "发到哪个环境？", options: ["测试环境", "正式环境"] },
    });
    const pushed = await until(() => fake.sent.find((item) => item.rich?.tone === "question"));
    expect(pushed.rich).toMatchObject({
      title: "helper 有问题问你",
      tag: "单选",
      body: "发到哪个环境？",
      options: [
        { key: "A", label: "测试环境" },
        { key: "B", label: "正式环境" },
      ],
      choice: { multiple: false },
      note: expect.stringContaining("直接点选"),
    });
    // 回到发起任务的那条 IM 消息下面
    expect(pushed.replyTo).toBeDefined();
    const externalId = (await until(() => fake.sentIds.get(pushed)))!;
    // 别人点不算
    expect(
      fake.events!.onAction!({
        externalId,
        chatId: "chat-1",
        operatorId: "someone-else",
        value: { hive: "1", do: "answer", key: "B" },
      }),
    ).toMatchObject({ toast: { type: "error" } });
    const result = fake.events!.onAction!({
      externalId,
      chatId: "chat-1",
      operatorId: "owner-open-id",
      value: { hive: "1", do: "answer", key: "B" },
    });
    expect(result).toMatchObject({
      toast: { type: "success" },
      rich: { resolved: { text: "已回答" }, selected: ["B"], note: "rd 的回答：B：正式环境" },
    });
    const woken = await helper.next(
      (event) => event.type === "agent.mentioned" && event.message.content.startsWith("选择 B"),
    );
    expect((woken as { message: ChatMessage }).message.answer).toMatchObject({ selected: ["B"] });
    // 再点一次：已经答过了
    expect(
      fake.events!.onAction!({
        externalId,
        chatId: "chat-1",
        operatorId: "owner-open-id",
        value: { hive: "1", do: "answer", key: "A" },
      }),
    ).toMatchObject({ toast: { type: "info" }, rich: { resolved: { text: "已结束" } } });
    await client.close();
  });

  it("多选题在卡片上勾选加「其它」一起提交；网页上答了的提问卡片自动改成已回答", async () => {
    const { join, connect, fake, port } = await start({ richCards: true });
    const helper = await join("helper", "agent");
    const { rd } = await connect();
    fake.emit({ text: "@helper 准备发布" });
    const mentioned = await helper.next((event) => event.type === "agent.mentioned");
    const trigger = (mentioned as { message: ChatMessage }).message;
    helper.send({ type: "invocation.report", messageId: trigger.id, status: "running" });
    await rd.next(
      (event) => event.type === "invocation.updated" && event.invocation.status === "running",
    );
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: {
        headers: {
          Authorization: "Bearer test-token",
          "X-Hive-Room": "general",
          "X-Hive-Agent-Name": "helper",
        },
      },
    });
    const client = new Client({ name: "im-test", version: "0.1.0" });
    await client.connect(transport as unknown as Transport);
    await client.callTool({
      name: "hive_ask_human",
      arguments: { question: "要通知哪些人？", options: ["测试", "产品", "运营"], multiple: true },
    });
    const card = await until(() => fake.sent.find((item) => item.rich?.choice?.multiple));
    const externalId = fake.sentIds.get(card)!;
    expect(
      fake.events!.onAction!({
        externalId,
        chatId: "chat-1",
        operatorId: "owner-open-id",
        value: { do: "answer_form" },
        form: {},
      }),
    ).toMatchObject({ toast: { type: "warning" } });
    const result = fake.events!.onAction!({
      externalId,
      chatId: "chat-1",
      operatorId: "owner-open-id",
      value: { do: "answer_form" },
      form: { opt_A: true, opt_B: false, opt_C: true, other: "还有法务" },
    });
    expect(result).toMatchObject({ rich: { selected: ["A", "C"], resolved: { ok: true } } });
    const woken = await helper.next(
      (event) => event.type === "agent.mentioned" && event.message.kind !== "question",
    );
    expect((woken as { message: ChatMessage }).message.content).toBe(
      "选择 A：测试；C：运营；其它：还有法务",
    );

    // 再问一个，这次在网页上点选
    const answerMessage = (woken as { message: ChatMessage }).message;
    helper.send({ type: "invocation.report", messageId: answerMessage.id, status: "running" });
    await rd.next(
      (event) =>
        event.type === "invocation.updated" &&
        event.invocation.messageId === answerMessage.id &&
        event.invocation.status === "running",
    );
    await client.callTool({
      name: "hive_ask_human",
      arguments: { question: "现在发吗？", options: ["发", "不发"] },
    });
    const second = await until(() =>
      fake.sent.find((item) => item.rich?.body === "现在发吗？" && item.rich.choice),
    );
    const question = await rd.next(
      (event) =>
        event.type === "message.created" &&
        event.message.kind === "question" &&
        event.message.content.includes("现在发吗"),
    );
    rd.send({
      type: "question.answer",
      questionMessageId: (question as { message: ChatMessage }).message.id,
      selected: ["A"],
      clientMessageId: "web-answer",
    });
    const updated = await until(() =>
      fake.updates.find((item) => item.externalId === fake.sentIds.get(second)),
    );
    expect(updated.rich).toMatchObject({ resolved: { text: "已回答" }, selected: ["A"] });
    await client.close();
  });

  it("飞书派活：回一张进度卡片并随状态更新，消息上先标「处理中」完成后换成「完成」", async () => {
    const { join, connect, fake } = await start({ richCards: true });
    const helper = await join("helper", "agent");
    const { rd } = await connect();
    fake.emit({ text: "@helper 跑一下测试" });
    const mentioned = await helper.next((event) => event.type === "agent.mentioned");
    const trigger = (mentioned as { message: ChatMessage }).message;
    const card = await until(() => fake.sent.find((item) => item.rich?.steps));
    expect(card.rich).toMatchObject({
      title: "已派给 helper",
      tag: "进行中",
      steps: [{ label: "helper", state: "queued" }],
    });
    const inboundId = card.replyTo!;
    await until(() =>
      fake.reactions.find((item) => item.emoji === "Typing" && item.externalId === inboundId),
    );
    helper.send({
      type: "invocation.report",
      messageId: trigger.id,
      status: "running",
      progress: "执行命令：pnpm test",
    });
    const running = await until(
      () => fake.updates.find((item) => item.rich.steps?.[0]?.state === "running"),
      4_000,
    );
    expect(running.rich.steps![0]!.detail).toBe("执行命令：pnpm test");
    expect(running.rich.actions!.map((action) => action.label)).toContain("停止");
    helper.send({
      type: "message.send",
      clientMessageId: "done",
      content: "测试全过",
      parentMessageId: trigger.id,
    });
    const done = await until(() => fake.updates.find((item) => item.rich.resolved));
    expect(done.rich).toMatchObject({ tag: "已完成", steps: [{ state: "done" }] });
    await until(() => fake.reactions.find((item) => item.emoji === "DONE"));
    expect(fake.reactions.some((item) => item.op === "remove")).toBe(true);
    // 进行中的卡片上点「停止」：走网页同样的停止
    fake.emit({ text: "@helper 再跑一次" });
    const again = await helper.next((event) => event.type === "agent.mentioned");
    const second = (again as { message: ChatMessage }).message;
    helper.send({ type: "invocation.report", messageId: second.id, status: "running" });
    const card2 = await until(() =>
      [...fake.sent, ...fake.updates]
        .map((item) => item.rich)
        .find((rich) =>
          rich?.actions?.some(
            (action) => action.value.do === "stop" && action.value.message === second.id,
          ),
        ),
    );
    const sent2 = fake.sent.find((item) => item.rich?.steps && item.replyTo && item !== card)!;
    expect(
      fake.events!.onAction!({
        externalId: fake.sentIds.get(sent2)!,
        chatId: sent2.chatId,
        operatorId: "owner-open-id",
        value: { hive: "1", do: "stop", message: second.id },
      }),
    ).toMatchObject({ toast: { type: "success", text: "已请求停止 1 个任务" } });
    await helper.next((event) => event.type === "agent.cancel");
    void card2;
    void rd;
  });

  it("飞书发来的图片带进房间；房间里带附件的消息把文件真的发过去", async () => {
    const { join, connect, fake, api, base } = await start({ richCards: true });
    const helper = await join("helper", "agent");
    await connect();
    fake.emit({ text: "@helper 看这张图", files: [{ key: "img_1", kind: "image" }] });
    const mentioned = await helper.next((event) => event.type === "agent.mentioned");
    const posted = (mentioned as { message: ChatMessage }).message;
    expect(posted.attachments).toEqual([
      expect.objectContaining({ name: "img_1.png", kind: "image" }),
    ]);

    const [connection] = (await api("GET", "/api/rooms/general/im")).body.connections;
    await api("POST", `/api/im/connections/${connection.id}/level`, { level: "all" });
    const form = new FormData();
    form.append("file", new Blob([PNG], { type: "image/png" }), "shot.png");
    const upload = await fetch(`${base}/api/rooms/general/attachments`, {
      method: "POST",
      headers: { Authorization: "Bearer test-token" },
      body: form,
    });
    const attachment = (await upload.json()) as { id: string };
    helper.send({
      type: "message.send",
      clientMessageId: "with-file",
      content: "@rd 截图在这",
      parentMessageId: posted.id,
      attachmentIds: [attachment.id],
    });
    const file = await until(() => fake.files.find((item) => item.name === "shot.png"));
    expect(file).toMatchObject({ kind: "image", size: PNG.length });
    const cardItem = fake.sent.find((item) => item.rich?.body?.includes("截图在这"))!;
    expect(file.replyTo).toBe(fake.sentIds.get(cardItem));
  });

  it("扫码和连接状态的错误带结构化文案，网页可以按语言显示（中文原文照旧）", async () => {
    const { api, connect, fake } = await start();
    const { connections } = await connect();
    // 不需要配对码时提交配对码：HTTP 错误体带 text
    const started = await api("POST", "/api/rooms/general/im/login", {
      channel: "feishu",
      ownerName: "rd",
    });
    await until(() => fake.login);
    const code = await api("POST", `/api/im/logins/${started.body.id}/code`, { code: "1234" });
    expect(code.status).toBe(409);
    expect(code.body).toMatchObject({
      error: "当前不需要输入配对码。",
      code: "IM_NO_CODE",
      text: { key: "error.im.noCodeNeeded" },
    });
    // 同一个机器人换了个人扫码：扫码会话失败，带 errorText
    fake.login!.resolve("someone-else");
    let view: Record<string, any> = {};
    for (let i = 0; i < 50 && view.status !== "failed"; i += 1) {
      view = (await api("GET", `/api/im/logins/${started.body.id}`)).body;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(view).toMatchObject({
      status: "failed",
      error: expect.stringContaining("这个机器人已由另一个人连接"),
      errorText: { key: "error.im.takenByOther" },
    });
    // 驱动报的连接状态
    fake.events!.onStatus("error", { key: "error.im.wechatExpired" });
    let connection: Record<string, any> = {};
    for (let i = 0; i < 50 && connection.status !== "error"; i += 1) {
      connection = (await api("GET", "/api/rooms/general/im")).body.connections[0];
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(connection).toMatchObject({
      id: connections[0]!.id,
      detail: "微信登录已过期，请重新扫码连接。",
      detailText: { key: "error.im.wechatExpired" },
    });
    // 平台原样返回的错误只有原文
    fake.events!.onStatus("error", "socket hang up");
    for (let i = 0; i < 50 && connection.detail !== "socket hang up"; i += 1) {
      connection = (await api("GET", "/api/rooms/general/im")).body.connections[0];
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(connection.detailText).toBeUndefined();
  });

  it("我的 IM 连接：从哪个房间都列出全部连接；网页上能改默认房间", async () => {
    const { api, connect, join, base } = await start();
    const { connections } = await connect();
    await api("POST", "/api/rooms", { id: "proj", name: "项目" });
    await api("POST", "/api/rooms", { id: "secret", name: "秘密" });
    await join("rd", "human", "proj");
    const all = await api("GET", "/api/im/connections");
    expect(all.body.connections).toMatchObject([
      { id: connections[0]!.id, roomId: "general", roomName: "general", channel: "feishu" },
    ]);
    expect((await fetch(`${base}/api/im/connections`)).status).toBe(401);
    const id = connections[0]!.id;
    const unknown = await api("POST", `/api/im/connections/${id}/room`, { roomId: "nope" });
    expect(unknown.status).toBe(404);
    expect(unknown.body.text).toMatchObject({ key: "error.im.roomNotFound" });
    const stranger = await api("POST", `/api/im/connections/${id}/room`, { roomId: "secret" });
    expect(stranger.status).toBe(400);
    expect(stranger.body.text).toMatchObject({ key: "error.im.notRoomMember" });
    const moved = await api("POST", `/api/im/connections/${id}/room`, { roomId: "proj" });
    expect(moved.body).toMatchObject({ roomId: "proj", roomName: "项目" });
  });

  it("个人微信要你先发消息才能推：暂停推送、标出原因，收到你的消息后把攒下的合成一条补发", async () => {
    const { api, join, fake } = await start();
    const rd = await join("rd", "human");
    const helper = await join("helper", "agent");
    const started = await api("POST", "/api/rooms/general/im/login", {
      channel: "wechat",
      ownerName: "rd",
      acceptRisk: true,
    });
    expect(started.status).toBe(201);
    await until(() => fake.login);
    fake.login!.resolve("owner-open-id");
    await until(() => fake.events);
    let connection: Record<string, any> = {};
    for (let i = 0; i < 50 && connection.status !== "connected"; i += 1) {
      connection = (await api("GET", "/api/im/connections")).body.connections[0] ?? {};
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    void rd;
    fake.sendError = Object.assign(new Error("prepare failed (errcode -1)"), { name: "ApiError" });
    const say = (content: string, id: string) =>
      helper.send({ type: "message.send", clientMessageId: id, content });
    say("@rd 第一条", "w1");
    for (let i = 0; i < 100 && connection.attention !== "needs_message"; i += 1) {
      connection = (await api("GET", "/api/im/connections")).body.connections[0];
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(connection).toMatchObject({
      attention: "needs_message",
      heldSince: expect.any(String),
      delivery: { pending: 1 },
    });
    // 暂停期间不再重试、不算失败
    say("@rd 第二条", "w2");
    say("@rd 第三条", "w3");
    await new Promise((resolve) => setTimeout(resolve, 300));
    connection = (await api("GET", "/api/im/connections")).body.connections[0];
    expect(connection.delivery).toMatchObject({ pending: 3 });
    expect(connection.delivery.lastStatus).toBeUndefined();

    // 你在微信里发了一条：恢复推送，攒下的三条合成一条补发
    fake.sendError = undefined;
    fake.emit({ text: "在吗" });
    const caughtUp = await until(() =>
      fake.sent.find((item) => item.text.startsWith("推送暂停期间有 3 条没送到")),
    );
    expect(caughtUp.text).toContain("第一条");
    expect(caughtUp.text).toContain("第三条");
    connection = (await api("GET", "/api/im/connections")).body.connections[0];
    expect(connection.attention).toBeUndefined();
    expect(connection.delivery.pending).toBe(0);
    expect(connection.delivery.lastSentAt).toEqual(expect.any(String));
  });

  it("个人微信必须确认风险；访客身份不能作为发言人", async () => {
    const { api, join } = await start();
    await join("rd", "human");
    const risky = await api("POST", "/api/rooms/general/im/login", {
      channel: "wechat",
      ownerName: "rd",
    });
    expect(risky.body.code).toBe("IM_RISK_NOT_ACCEPTED");
    const accepted = await api("POST", "/api/rooms/general/im/login", {
      channel: "wechat",
      ownerName: "rd",
      acceptRisk: true,
    });
    expect(accepted.status).toBe(201);
    const nobody = await api("POST", "/api/rooms/general/im/login", {
      channel: "feishu",
      ownerName: "ghost",
    });
    expect(nobody.body.code).toBe("NOT_A_MEMBER");
    const anonymous = await fetch(`http://127.0.0.1:${(await start()).port}/api/im/channels`);
    expect(anonymous.status).toBe(401);
  });
});

describe("IM 推送档位", () => {
  let close: (() => Promise<void>) | undefined;
  const peers: Peer[] = [];
  afterEach(async () => {
    for (const peer of peers.splice(0)) peer.socket.close();
    await close?.();
    close = undefined;
  });

  async function setup(
    options: {
      richCards?: boolean;
      webUrl?: string;
      localAgents?: boolean;
      locale?: "zh-CN" | "en";
    } = {},
  ) {
    const fake = new FakeChannel();
    fake.richCards = Boolean(options.richCards);
    const clock = { offset: 0 };
    const app = await buildApp({
      databasePath: ":memory:",
      ...(options.webUrl ? { webUrl: options.webUrl } : {}),
      ...(options.localAgents
        ? {
            localAgents: {
              cli: { command: "/usr/bin/node", args: ["cli.js"] },
              serverUrl: "http://127.0.0.1:8787",
              spawn: () => {
                throw new Error("not in this test");
              },
              probe: async () => ({ installed: false, version: null }),
            },
          }
        : {}),
      token: "test-token",
      staticDir: "/definitely-not-present",
      now: () => Date.now() + clock.offset,
      imDrivers: { feishu: fake.driver("feishu") },
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    close = () => app.close();
    const port = (app.server.address() as AddressInfo).port;
    const api = async (method: string, url: string, body?: unknown) => {
      const headers = { ...OWNER } as Record<string, string>;
      if (body === undefined) delete headers["Content-Type"];
      const response = await fetch(`http://127.0.0.1:${port}${url}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: (await response.json()) as Record<string, any> };
    };
    const join = async (
      username: string,
      participantType: "human" | "agent",
      roomId = "general",
    ) => {
      const peer = await Peer.connect(`ws://127.0.0.1:${port}/ws`);
      peers.push(peer);
      peer.send({
        type: "participant.join",
        username,
        participantType,
        roomId,
        token: "test-token",
      });
      await peer.next((event) => event.type === "room.snapshot");
      return peer;
    };
    const rd = await join("rd", "human");
    const helper = await join("helper", "agent");
    const started = await api("POST", "/api/rooms/general/im/login", {
      channel: "feishu",
      ownerName: "rd",
      ...(options.locale ? { locale: options.locale } : {}),
    });
    await until(() => fake.login);
    fake.login!.resolve("owner-open-id");
    await until(() => fake.events);
    let id = "";
    for (let i = 0; i < 50; i += 1) {
      const [connection] = (await api("GET", "/api/rooms/general/im")).body.connections;
      if (connection?.status === "connected") {
        id = connection.id;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    void started;
    /** rd 在网页上派活给 helper，返回触发消息 */
    const assign = async (content: string, clientMessageId: string) => {
      rd.send({ type: "message.send", clientMessageId, content });
      const created = await rd.next(
        (event) => event.type === "message.created" && event.message.content === content,
      );
      await helper.next((event) => event.type === "agent.mentioned");
      return (created as { message: ChatMessage }).message;
    };
    const setLevel = async (level: string) =>
      (await api("POST", `/api/im/connections/${id}/level`, { level })).body;
    return { api, fake, clock, rd, helper, assign, setLevel, id, join, app };
  }

  it("默认「与我相关」：网页派的活，Agent 没提到房主，最终结果也推到房主私聊", async () => {
    const { fake, helper, assign, api } = await setup();
    const trigger = await assign("@helper 看下日志", "web-1");
    helper.send({ type: "invocation.report", messageId: trigger.id, status: "running" });
    helper.send({
      type: "message.send",
      clientMessageId: "final",
      content: "日志里是磁盘满了",
      parentMessageId: trigger.id,
    });
    const delivered = await until(() => fake.sent.find((item) => item.text.includes("磁盘满了")));
    // 网页任务发到房主私聊，不发到「最近说过话的会话」
    expect(delivered.chatId).toBe("user:owner-open-id");
    expect(delivered.replyTo).toBeUndefined();
    expect(delivered.text.split("\n")[0]).toBe("general - helper");
    const [connection] = (await api("GET", "/api/rooms/general/im")).body.connections;
    expect(connection.level).toBe("mine");
    expect(connection.delivery).toMatchObject({ lastStatus: "sent", pending: 0 });
  });

  it("委派链只推交给房主的最终结果，Agent 之间的转交和中间回复不推", async () => {
    const { fake, helper, assign, join, rd } = await setup();
    const worker = await join("worker", "agent");
    const trigger = await assign("@helper 整理发布说明", "web-3");
    helper.send({ type: "invocation.report", messageId: trigger.id, status: "running" });
    // helper 执行中把子任务转给 worker（不带 parent，服务端按执行中的调用补上）
    helper.send({ type: "message.send", clientMessageId: "hand", content: "@worker 列一下改动" });
    const handed = await worker.next((event) => event.type === "agent.mentioned");
    const handoff = (handed as { message: ChatMessage }).message;
    worker.send({
      type: "message.send",
      clientMessageId: "w-reply",
      content: "改动有三项",
      parentMessageId: handoff.id,
    });
    await rd.next(
      (event) => event.type === "message.created" && event.message.content === "改动有三项",
    );
    helper.send({
      type: "message.send",
      clientMessageId: "h-final",
      content: "发布说明整理好了",
      parentMessageId: trigger.id,
    });
    await until(() => fake.sent.find((item) => item.text.includes("发布说明整理好了")));
    expect(fake.sent.some((item) => item.text.includes("列一下改动"))).toBe(false);
    expect(fake.sent.some((item) => item.text.includes("改动有三项"))).toBe(false);
  });

  it("任务失败、结果未知推一条状态通知；同一状态只推一次", async () => {
    const { fake, helper, assign } = await setup();
    const trigger = await assign("@helper 跑一下部署", "web-2");
    helper.send({ type: "invocation.report", messageId: trigger.id, status: "running" });
    helper.send({
      type: "invocation.report",
      messageId: trigger.id,
      status: "failed",
      detail: "部署脚本退出码 1",
    });
    const notice = await until(() => fake.sent.find((item) => item.text.includes("失败")));
    expect(notice.text).toContain(`处理 #${trigger.seq} 失败：部署脚本退出码 1`);
    expect(notice.chatId).toBe("user:owner-open-id");
    helper.send({ type: "invocation.report", messageId: trigger.id, status: "failed" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fake.sent.filter((item) => item.text.includes("失败"))).toHaveLength(1);
  });

  it("「全部消息」：不回显房主，其他人和 Agent 的普通消息合并，提到房主立即推", async () => {
    const { fake, rd, helper, setLevel, join, clock, api } = await setup({ richCards: true });
    expect((await setLevel("all")).level).toBe("all");
    const guest = await join("guest", "human");
    rd.send({ type: "message.send", clientMessageId: "hi", content: "大家好" });
    guest.send({ type: "message.send", clientMessageId: "guest-hi", content: "客人问好" });
    helper.send({ type: "message.send", clientMessageId: "chat", content: "收到" });
    await rd.next((event) => event.type === "message.created" && event.message.content === "收到");
    expect(fake.sent.some((item) => item.text.includes("收到"))).toBe(false);
    helper.send({ type: "message.send", clientMessageId: "urgent", content: "@rd 请确认" });
    await until(() => fake.sent.find((item) => item.text.includes("请确认")));
    clock.offset = 4 * 60_000;
    const digest = await until(
      () => fake.sent.find((item) => item.text.includes("客人问好")),
      5_000,
    );
    expect(digest.rich).toMatchObject({ tone: "digest", title: "2 条新消息" });
    expect(digest.text).toContain("general - helper\n收到");
    expect(fake.sent.some((item) => item.text.includes("大家好"))).toBe(false);
    expect((await api("GET", "/api/rooms/general/im")).body.connections[0].crossRoomAll).toBe(
      false,
    );
    const before = fake.sent.length;
    fake.emit({ text: "从飞书说一句" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(fake.sent.slice(before).some((item) => item.text.includes("general - rd\n从飞书"))).toBe(
      false,
    );
  });

  it("跨房间 all 默认仅相关；显式开启后按房间合并，保留跨房间标记和切换按钮", async () => {
    const ctx = await setup({ richCards: true });
    const { fake, helper, setLevel, clock, api, id, rd } = ctx;
    const { omp, rdProj } = await otherRoom(ctx);
    await setLevel("all");
    expect(
      (await api("POST", `/api/im/connections/${id}/cross-room-all`, { crossRoomAll: "true" }))
        .status,
    ).toBe(400);
    omp.send({ type: "message.send", clientMessageId: "other-noise", content: "不相关跨房间发言" });
    await rdProj.next(
      (event) => event.type === "message.created" && event.message.content === "不相关跨房间发言",
    );
    omp.send({ type: "message.send", clientMessageId: "other-urgent", content: "@rd 跨房间确认" });
    await until(() => fake.sent.find((item) => item.text.includes("跨房间确认")));
    expect(
      (await api("POST", `/api/im/connections/${id}/cross-room-all`, { crossRoomAll: true })).body
        .crossRoomAll,
    ).toBe(true);
    for (const [peer, prefix] of [
      [helper, "当前"],
      [omp, "其它"],
    ] as const) {
      peer.send({
        type: "message.send",
        clientMessageId: `${prefix}-1`,
        content: `${prefix}房间第一条`,
      });
      peer.send({
        type: "message.send",
        clientMessageId: `${prefix}-2`,
        content: `${prefix}房间第二条`,
      });
    }
    await rd.next(
      (event) => event.type === "message.created" && event.message.content === "当前房间第二条",
    );
    await rdProj.next(
      (event) => event.type === "message.created" && event.message.content === "其它房间第二条",
    );
    clock.offset = 4 * 60_000;
    const current = await until(
      () => fake.sent.find((item) => item.text.includes("当前房间第一条")),
      5_000,
    );
    const other = await until(
      () => fake.sent.find((item) => item.text.includes("其它房间第一条")),
      5_000,
    );
    expect(current.rich).toMatchObject({ tone: "digest", room: "general" });
    expect(current.text).not.toContain("其它房间");
    expect(other.rich).toMatchObject({
      tone: "digest",
      room: "项目",
      otherRoom: { id: "proj", name: "项目" },
    });
    expect(other.rich!.actions!.at(-1)).toMatchObject({ value: { do: "goto", room: "proj" } });
    expect(fake.sent.some((item) => item.text.includes("不相关跨房间发言"))).toBe(false);
    expect(
      (await api("POST", `/api/im/connections/${id}/cross-room-all`, { crossRoomAll: false })).body
        .crossRoomAll,
    ).toBe(false);
  });

  it.each(["im", "mine", "agents", "all"])(
    "%s：真实定时触发不推，IM 创建确认、提问及最终结果照推",
    async (level) => {
      const { fake, helper, rd, clock, setLevel, app } = await setup({ richCards: true });
      await setLevel(level);
      fake.emit({ text: "@helper 两分钟后检查" });
      const start = await helper.next((event) => event.type === "agent.mentioned");
      const trigger = (start as { message: ChatMessage }).message;
      helper.send({ type: "invocation.report", messageId: trigger.id, status: "running" });
      await rd.next(
        (event) => event.type === "invocation.updated" && event.invocation.status === "running",
      );
      const port = (app.server.address() as AddressInfo).port;
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: {
          headers: {
            Authorization: "Bearer test-token",
            "X-Hive-Room": "general",
            "X-Hive-Agent-Name": "helper",
          },
        },
      });
      const client = new Client({ name: "im-schedule-test", version: "0.1.0" });
      await client.connect(transport as unknown as Transport);
      try {
        const created = await client.callTool({
          name: "hive_schedule_create",
          arguments: {
            runAt: new Date(Date.now() + 2 * 60_000).toISOString(),
            task: "给 Agent 的长备忘，不应推送",
            clientMessageId: "im-schedule",
          },
        });
        expect(created.isError).toBeFalsy();
        helper.send({
          type: "message.send",
          clientMessageId: "schedule-confirmed",
          content: "已安排两分钟后检查",
          parentMessageId: trigger.id,
        });
        await until(() => fake.sent.find((item) => item.text.includes("已安排两分钟后检查")));
        clock.offset = 3 * 60_000;
        (app as unknown as { runSchedules: () => void }).runSchedules();
        const fired = await helper.next(
          (event) => event.type === "agent.mentioned" && event.message.kind === "schedule",
        );
        const scheduled = (fired as { message: ChatMessage }).message;
        expect(scheduled.senderType).toBe("human");
        helper.send({ type: "invocation.report", messageId: scheduled.id, status: "running" });
        await rd.next(
          (event) =>
            event.type === "invocation.updated" &&
            event.invocation.messageId === scheduled.id &&
            event.invocation.status === "running",
        );
        await client.callTool({
          name: "hive_ask_human",
          arguments: { question: "定时检查需要确认吗？", options: ["确认", "取消"] },
        });
        await until(() => fake.sent.find((item) => item.rich?.tone === "question"));
        fake.emit({ text: "a" });
        const answered = await helper.next(
          (event) => event.type === "agent.mentioned" && Boolean(event.message.answer),
        );
        helper.send({
          type: "message.send",
          clientMessageId: "scheduled-result",
          content: "定时检查结果已确认",
          parentMessageId: (answered as { message: ChatMessage }).message.id,
        });
        await until(() => fake.sent.find((item) => item.text.includes("定时检查结果已确认")));
        expect(fake.sent.some((item) => item.text.includes("给 Agent 的长备忘"))).toBe(false);
        expect(fake.sent.some((item) => item.text.includes("⏰ 定时任务"))).toBe(false);
      } finally {
        await client.close();
      }
    },
  );

  it("「全部 Agent 消息」：其它 Agent 发言攒满 3 分钟合并成一条", async () => {
    const { fake, helper, clock, setLevel } = await setup();
    await setLevel("agents");
    helper.send({ type: "message.send", clientMessageId: "a", content: "第一句" });
    helper.send({ type: "message.send", clientMessageId: "b", content: "第二句" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fake.sent.some((item) => item.text.includes("第一句"))).toBe(false);
    clock.offset = 4 * 60_000;
    const digest = await until(() => fake.sent.find((item) => item.text.includes("第一句")), 5_000);
    expect(digest.text).toContain("第二句");
  });

  it("支持卡片的渠道：回复、失败提醒和合并推送都发卡片，纯文本留作退路", async () => {
    const { fake, helper, assign, clock, setLevel } = await setup({ richCards: true });
    const trigger = await assign("@helper 看一下 <T> 泛型", "web-rich");
    helper.send({
      type: "message.send",
      clientMessageId: "r1",
      content: "**结论**：可以\n- 第一点",
      parentMessageId: trigger.id,
    });
    const reply = await until(() => fake.sent.find((item) => item.rich?.body?.includes("结论")));
    expect(reply.rich).toMatchObject({
      title: "helper 的回复",
      tone: "reply",
      room: "general",
      subtitle: expect.stringMatching(/^#\d+ · /),
      body: "**结论**：可以\n- 第一点",
    });
    expect(reply.text).toContain("general - helper");

    const second = await assign("@helper 再跑一次", "web-rich-2");
    helper.send({ type: "invocation.report", messageId: second.id, status: "running" });
    helper.send({
      type: "invocation.report",
      messageId: second.id,
      status: "failed",
      detail: "退出码 1",
    });
    const failed = await until(() => fake.sent.find((item) => item.rich?.tone === "danger"));
    expect(failed.rich).toMatchObject({
      title: "helper 处理失败",
      tag: "失败",
      body: expect.stringContaining("**原因**：退出码 1"),
    });

    await setLevel("agents");
    helper.send({ type: "message.send", clientMessageId: "d1", content: "第一句" });
    helper.send({ type: "message.send", clientMessageId: "d2", content: "第二句" });
    clock.offset = 4 * 60_000;
    const digest = await until(() => fake.sent.find((item) => item.rich?.tone === "digest"), 5_000);
    expect(digest.rich).toMatchObject({ title: "2 条新消息" });
    expect(digest.rich!.sections!.map((section) => section.body)).toEqual(["第一句", "第二句"]);
  });

  it("失败卡片带重试 / 忽略按钮：点重试重新派发并把卡片改成已处理", async () => {
    const { fake, helper, assign } = await setup({ richCards: true });
    const trigger = await assign("@helper 部署", "web-act");
    helper.send({ type: "invocation.report", messageId: trigger.id, status: "running" });
    helper.send({
      type: "invocation.report",
      messageId: trigger.id,
      status: "failed",
      detail: "退出码 1",
    });
    const notice = await until(() => fake.sent.find((item) => item.rich?.tone === "danger"));
    expect(notice.rich!.actions!.map((action) => action.label)).toEqual(["重试", "忽略"]);
    const externalId = fake.sentIds.get(notice)!;
    const result = fake.events!.onAction!({
      externalId,
      chatId: notice.chatId,
      operatorId: "owner-open-id",
      value: { hive: "1", do: "retry" },
    });
    expect(result).toMatchObject({
      toast: { type: "success", text: "已重试" },
      rich: { resolved: { text: "已重试", ok: true } },
    });
    const redelivered = await helper.next(
      (event) => event.type === "agent.mentioned" && event.message.id === trigger.id,
    );
    expect(redelivered).toBeDefined();
    // 已经重试过：重复点击或飞书重投同一回调都不再执行，返回已处理的卡片
    expect(
      fake.events!.onAction!({
        externalId,
        chatId: notice.chatId,
        operatorId: "owner-open-id",
        value: { hive: "1", do: "retry" },
      }),
    ).toMatchObject({
      toast: { type: "info", text: "这条任务已经处理过了" },
      rich: { resolved: { text: "已重试" } },
    });
    // 「继续」也一样：不会因重复回调再追加轮数
    expect(
      fake.events!.onAction!({
        externalId,
        chatId: notice.chatId,
        operatorId: "owner-open-id",
        value: { hive: "1", do: "continue" },
      }),
    ).toMatchObject({ toast: { type: "info" } });
    // 只有房主本人能点
    expect(
      fake.events!.onAction!({
        externalId,
        chatId: notice.chatId,
        operatorId: "someone-else",
        value: { hive: "1", do: "retry" },
      }),
    ).toMatchObject({ toast: { type: "error", text: "只有房主本人可以操作" } });
  });

  it("命令：/who 看谁在忙，/level 切换推送档位，/cards 开关卡片按钮", async () => {
    const { fake, id, api } = await setup();
    fake.emit({ text: "/who" });
    await until(() => fake.sent.find((item) => item.text.includes("helper")));
    expect(fake.sent.at(-1)!.text).toMatch(/🟢 空闲\u3000helper/);
    fake.emit({ text: "/level agents" });
    await until(() => fake.sent.find((item) => item.text.startsWith("已切换为：全部 Agent 消息")));
    const [connection] = (await api("GET", "/api/rooms/general/im")).body.connections;
    expect(connection).toMatchObject({ id, level: "agents" });
    fake.emit({ text: "/cards on" });
    await until(() => fake.sent.find((item) => item.text.startsWith("这个渠道不支持卡片")));
  });

  it("选对话对象：/to 卡片点选后不带 @ 自动发给它，回复哪个 Agent 的卡片就发给谁", async () => {
    const { fake, helper, join } = await setup({ richCards: true });
    const codex = await join("rd-codex", "agent");
    fake.emit({ text: "/to" });
    const picker = await until(() => fake.sent.find((item) => item.rich?.title === "选择对话对象"));
    expect(picker.rich!.actions!.map((action) => action.label)).toEqual([
      "helper · 空闲",
      "rd-codex · 空闲",
      "不指定",
    ]);
    const externalId = fake.sentIds.get(picker)!;
    const click = (operatorId: string, agent: string) =>
      fake.events!.onAction!({
        externalId,
        chatId: picker.chatId,
        operatorId,
        value: { hive: "1", do: "target", agent },
      });
    expect(click("someone-else", "rd-codex")).toMatchObject({ toast: { type: "error" } });
    const picked = click("owner-open-id", "rd-codex");
    expect(picked).toMatchObject({ rich: { tag: "当前：rd-codex" } });
    // 重复回调：结果一样，不出错
    expect(click("owner-open-id", "rd-codex")).toMatchObject({ rich: { tag: "当前：rd-codex" } });

    fake.emit({ text: "看下构建为什么慢" });
    const toCodex = await codex.next((event) => event.type === "agent.mentioned");
    expect((toCodex as { message: ChatMessage }).message.content).toBe(
      "@rd-codex 看下构建为什么慢",
    );
    // 开头写名字临时找别人（不带 @ 时要写完整的名字或去掉前缀后的名字）
    fake.emit({ text: "helper 你也看看" });
    const toHelper = await helper.next((event) => event.type === "agent.mentioned");
    expect((toHelper as { message: ChatMessage }).message.content).toBe("@helper 你也看看");
    // 回复 helper 的卡片：发给 helper，而不是当前对象
    helper.send({
      type: "message.send",
      clientMessageId: "h-reply",
      content: "我看了，是缓存问题 @rd",
    });
    const card = await until(() => fake.sent.find((item) => item.rich?.body?.includes("缓存问题")));
    expect(card.rich).toMatchObject({
      footer: "当前：general → rd-codex",
      actions: [
        { label: "继续问它", value: { do: "follow", agent: "helper" } },
        { label: "切换对象", value: { do: "to" } },
        { label: "切换房间", value: { do: "room" } },
        { label: "菜单", value: { do: "menu" } },
      ],
    });
    fake.emit({ text: "怎么修？", replyToExternalId: fake.sentIds.get(card)! });
    const followUp = await helper.next((event) => event.type === "agent.mentioned");
    expect((followUp as { message: ChatMessage }).message.content).toBe("@helper 怎么修？");
    // 「继续问它」：之后不带 @ 的消息发给它，卡片不变
    const tap = (value: Record<string, string>, externalId = fake.sentIds.get(card)!) =>
      fake.events!.onAction!({
        externalId,
        chatId: card.chatId,
        operatorId: "owner-open-id",
        value: { hive: "1", ...value },
      });
    expect(tap({ do: "follow", agent: "helper" })).toEqual({
      toast: { type: "success", text: "之后直接打字就发给 helper" },
    });
    fake.emit({ text: "再看看" });
    const next = await helper.next(
      (event) => event.type === "agent.mentioned" && event.message.content === "@helper 再看看",
    );
    expect(next).toBeTruthy();
    // 「菜单」和发「菜单」两个字都弹出控制面板
    expect(tap({ do: "menu" })).toMatchObject({ toast: { text: "已发来控制面板" } });
    fake.emit({ text: "菜单" });
    await until(() => fake.sent.filter((item) => item.rich?.title === "控制面板").length === 2);
    const panel = fake.sent.find((item) => item.rich?.title === "控制面板")!;
    expect(panel.rich).toMatchObject({ room: "general" });
    expect(panel.rich!.body).toContain("helper（直接打字就发给它）");
  });

  it("简写对上多个 Agent 弹卡片选，选完带着原消息发出且只发一次；没对上按普通文字处理", async () => {
    const { fake, join, rd } = await setup({ richCards: true });
    const one = await join("rd-claude", "agent");
    await join("rd-claude2", "agent");
    fake.emit({ text: "@rd-cl 看下这个" });
    const picker = await until(() => fake.sent.find((item) => item.rich?.tag === "选一个"));
    expect(picker.rich!.actions!.map((action) => action.label)).toEqual([
      "rd-claude",
      "rd-claude2",
    ]);
    const action = picker.rich!.actions![0]!;
    const click = () =>
      fake.events!.onAction!({
        externalId: fake.sentIds.get(picker)!,
        chatId: picker.chatId,
        operatorId: "owner-open-id",
        value: { hive: "1", ...action.value },
      });
    expect(click()).toMatchObject({ rich: { resolved: { text: "已发给 rd-claude" } } });
    const woken = await one.next((event) => event.type === "agent.mentioned");
    expect((woken as { message: ChatMessage }).message.content).toBe("@rd-claude 看下这个");
    expect(click()).toMatchObject({ toast: { type: "info" }, rich: { resolved: { ok: false } } });
    // 没对上：原样进房间，提示用法
    fake.emit({ text: "today 天气不错" });
    const plainMessage = await rd.next(
      (event) => event.type === "message.created" && event.message.content === "today 天气不错",
    );
    expect((plainMessage as { message: ChatMessage }).message.mentions).toEqual([]);
  });

  it("/room 卡片点一下切换房间，并恢复那个房间选过的对象；旧连接退回文字编号", async () => {
    const { fake, join, api, id } = await setup({ richCards: true });
    await api("POST", "/api/rooms", { id: "proj", name: "项目" });
    await join("rd", "human", "proj");
    await join("rd-omp", "agent", "proj");
    fake.emit({ text: "/room" });
    const picker = await until(() => fake.sent.find((item) => item.rich?.title === "切换房间"));
    const labels = picker.rich!.actions!.map((action) => action.label);
    expect(labels[0]).toMatch(/^● general · \d+ 人在线/);
    expect(labels).toContainEqual(expect.stringMatching(/^项目 · /));
    const switched = fake.events!.onAction!({
      externalId: fake.sentIds.get(picker)!,
      chatId: picker.chatId,
      operatorId: "owner-open-id",
      value: { hive: "1", do: "room", room: "proj" },
    });
    expect(switched).toMatchObject({ rich: { title: "已切换到 项目", tag: "当前：未指定" } });
    const [connection] = (await api("GET", "/api/rooms/proj/im")).body.connections;
    expect(connection.id).toBe(id);
    fake.emit({ text: "/to omp" });
    await until(() => fake.sent.find((item) => item.text === "之后不带 @ 的消息都发给 rd-omp。"));

    // 旧连接（没开卡片按钮）：文字列表 + 回编号
    fake.emit({ text: "/cards off" });
    await until(() => fake.sent.find((item) => item.text.startsWith("已关闭卡片按钮")));
    fake.emit({ text: "/room" });
    const list = await until(() => fake.sent.find((item) => item.text.includes("回复编号切换")));
    const generalIndex = list.text.split("\n").find((line) => line.includes("general"))![0];
    fake.emit({ text: generalIndex! });
    await until(() => fake.sent.find((item) => item.text.startsWith("已切换到房间「general」")));
    fake.emit({ text: "/room proj" });
    const back = await until(() =>
      fake.sent.find((item) => item.text.startsWith("已切换到房间「项目」")),
    );
    // 回到项目房间时恢复上次选的对象
    expect(back.text).toContain("对话对象：rd-omp");
  });

  it("/help 是一张说明卡片，带常用操作按钮；/who、/level 也是卡片，档位点一下就切换", async () => {
    const { fake, api, id } = await setup({ richCards: true });
    fake.emit({ text: "/help" });
    const help = await until(() =>
      fake.sent.find((item) => item.rich?.title === "SuperHive 使用说明"),
    );
    expect(help.rich!.sections!.map((section) => section.title)).toEqual([
      "💬 发消息",
      "🙋 回答 Agent 的提问",
      "⌨️ 命令",
      "📌 机器人菜单（可选）",
    ]);
    expect(help.rich!.actions!.map((action) => action.label)).toEqual([
      "选对话对象",
      "切换房间",
      "谁在忙",
      "推送档位",
    ]);
    const click = (externalId: string, value: Record<string, string>) =>
      fake.events!.onAction!({
        externalId,
        chatId: help.chatId,
        operatorId: "owner-open-id",
        value: { hive: "1", ...value },
      });
    click(fake.sentIds.get(help)!, { do: "who" });
    const who = await until(() => fake.sent.find((item) => item.rich?.title === "谁在忙"));
    expect(who.rich!.body).toContain("**helper**");
    click(fake.sentIds.get(help)!, { do: "level" });
    const level = await until(() => fake.sent.find((item) => item.rich?.title === "推送档位"));
    expect(level.rich!.tag).toBe("当前：与我相关");
    expect(click(fake.sentIds.get(level)!, { do: "level", level: "agents" })).toMatchObject({
      rich: { tag: "当前：全部 Agent 消息" },
    });
    const [connection] = (await api("GET", "/api/rooms/general/im")).body.connections;
    expect(connection).toMatchObject({ id, level: "agents" });
  });

  it("卡片上的「在网页查看」带房主登录票，在别的设备上点开直接以房主身份进入；/web 也能拿到", async () => {
    const { fake, helper, assign, app } = await setup({
      richCards: true,
      webUrl: "http://10.0.0.8:5188",
    });
    const trigger = await assign("@helper 看下", "web-link");
    helper.send({
      type: "message.send",
      clientMessageId: "r",
      content: "看完了",
      parentMessageId: trigger.id,
    });
    const card = await until(() => fake.sent.find((item) => item.rich?.body === "看完了"));
    const link = new URL(card.rich!.link!.url);
    expect(`${link.origin}${link.pathname}`).toBe("http://10.0.0.8:5188/");
    expect(link.hash).toBe("#general");
    const ticket = link.searchParams.get("login")!;
    expect(ticket).toMatch(/^hoi_/);
    const login = await app.inject({
      method: "POST",
      url: "/api/owner-login",
      payload: { ticket, deviceName: "iPhone · 飞书" },
      remoteAddress: "10.0.0.30",
    });
    const { token } = login.json() as { token: string };
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/access",
          headers: { authorization: `Bearer ${token}` },
          remoteAddress: "10.0.0.30",
        })
      ).json(),
    ).toEqual({ role: "owner", joinToken: token });

    fake.emit({ text: "/web" });
    const web = await until(() =>
      fake.sent.find((item) => item.rich?.title === "在网页上打开 Hive"),
    );
    expect(web.rich!.link!.url).toContain("login=hoi_");
  });

  it("其他设备申请管理这台电脑：批准卡推到本机扫码连接的账号，房主本人点允许后获批；设备上的操作推提醒", async () => {
    const { fake, app, id } = await setup({
      richCards: true,
      webUrl: "http://10.0.0.8:5188",
      localAgents: true,
    });
    fake.emit({ text: "/web" });
    const web = await until(() =>
      fake.sent.find((item) => item.rich?.title === "在网页上打开 Hive"),
    );
    const ticket = new URL(web.rich!.link!.url).searchParams.get("login")!;
    const { token } = (
      await app.inject({
        method: "POST",
        url: "/api/owner-login",
        payload: { ticket, deviceName: "iPhone · 飞书" },
        remoteAddress: "10.0.0.30",
      })
    ).json() as { token: string };
    const device = (method: "GET" | "POST", url: string) =>
      app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${token}` },
        remoteAddress: "10.0.0.30",
      });
    expect((await device("GET", "/api/local/session")).json()).toMatchObject({
      mode: "device",
      approval: "im",
      manageUntil: null,
    });

    const request = (await device("POST", "/api/local/manage-request")).json();
    expect(request.delivered).toBe(1);
    const card = await until(() => fake.sent.find((item) => item.rich?.title === "需要你批准"));
    expect(card.chatId).toBe("user:owner-open-id");
    expect(card.rich!.body).toContain("iPhone · 飞书");
    const externalId = fake.sentIds.get(card)!;
    expect(
      fake.events!.onAction!({
        externalId,
        chatId: card.chatId,
        operatorId: "someone-else",
        value: { hive: "1", do: "host_approval", id: request.approval.id, decision: "allow" },
      }),
    ).toMatchObject({ toast: { type: "error" } });
    expect(
      fake.events!.onAction!({
        externalId,
        chatId: card.chatId,
        operatorId: "owner-open-id",
        value: { hive: "1", do: "host_approval", id: request.approval.id, decision: "allow" },
      }),
    ).toMatchObject({
      toast: { text: "已允许" },
      rich: { resolved: { text: "已允许", ok: true } },
    });
    expect((await device("GET", "/api/local/session")).json().manageUntil).toEqual(
      expect.any(String),
    );

    // 设备上做了管理操作：推一条提醒到房主私聊
    expect((await device("POST", "/api/local/owner-devices/revoke-all")).statusCode).toBe(200);
    const notice = await until(() =>
      fake.sent.find((item) => item.text.includes("退出了其他 0 台已登录的设备")),
    );
    expect(notice.chatId).toBe("user:owner-open-id");

    // 取消登记后，申请只能回本机批准
    const { ownerToken } = (await app.inject({ method: "GET", url: "/api/local/session" })).json();
    const unset = await app.inject({
      method: "PUT",
      url: `/api/local/host-approvers/${id}`,
      headers: { "x-hive-owner": ownerToken },
      payload: { allowed: false },
    });
    expect(unset.json().approvers).toMatchObject([{ connectionId: id, allowed: false }]);
    const second = (await device("POST", "/api/local/manage-request")).json();
    expect(second.delivered).toBe(0);
  });

  it("群里派的活，回到群里的卡片不带房主登录票；群里发 /web 只提示去私聊", async () => {
    const { fake, helper } = await setup({ richCards: true, webUrl: "http://10.0.0.8:5188" });
    fake.emit({ text: "@helper 看下", chatType: "group", chatId: "oc_group" });
    const mention = await helper.next((event) => event.type === "agent.mentioned");
    const trigger = (mention as { message: ChatMessage }).message;
    helper.send({
      type: "message.send",
      clientMessageId: "g-reply",
      content: "群里的回复",
      parentMessageId: trigger.id,
    });
    const card = await until(() => fake.sent.find((item) => item.rich?.body === "群里的回复"));
    expect(card.chatId).toBe("oc_group");
    expect(card.rich!.link!.url).toBe("http://10.0.0.8:5188/#general");
    // 进度卡片也一样
    const progress = fake.sent.find((item) => item.rich?.steps);
    expect(progress?.rich?.link?.url ?? "").not.toContain("login=");
    fake.emit({ text: "/web", chatType: "group", chatId: "oc_group" });
    const refused = await until(() =>
      fake.sent.find((item) => item.text.includes("私聊里发 /web")),
    );
    expect(refused.rich).toBeUndefined();
    // 私聊照常带票
    fake.emit({ text: "/web" });
    const web = await until(() =>
      fake.sent.find((item) => item.rich?.title === "在网页上打开 Hive"),
    );
    expect(web.rich!.link!.url).toContain("login=hoi_");
  });

  it("暂停后不推，恢复后不补发暂停期间的消息", async () => {
    const { fake, helper, setLevel, id, api } = await setup();
    await setLevel("all");
    await api("POST", `/api/im/connections/${id}/pause`);
    helper.send({ type: "message.send", clientMessageId: "p", content: "暂停时说的" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await api("POST", `/api/im/connections/${id}/resume`);
    await until(async () => true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fake.sent.some((item) => item.text.includes("暂停时说的"))).toBe(false);
  });
  /** 去掉用户和 Agent 写的内容后，界面文字里不该再有中文 */
  // 汉字和中文标点；转述正文时 @ 换成的全角 ＠ 不算
  const CJK = /[\u3400-\u9fff\u3001-\u303f\uff01\uff08\uff09\uff0c\uff1a\uff1b\uff1f]/u;
  function uiText(rich: ImRich, userContent: string[] = []): string {
    let text = JSON.stringify({ ...rich, link: rich.link?.label });
    for (const content of userContent) text = text.split(content).join("");
    return text;
  }

  it("English：/lang en 后命令回复、卡片标题按钮提示都是英文，再切回中文；网页也能切", async () => {
    const { fake, api, id, helper, assign } = await setup({
      richCards: true,
      webUrl: "http://10.0.0.8:5188",
    });
    fake.emit({ text: "/lang en" });
    await until(() => fake.sent.find((item) => item.text === "Switched to English."));
    expect((await api("GET", "/api/rooms/general/im")).body.connections[0]).toMatchObject({
      id,
      locale: "en",
    });

    fake.emit({ text: "/help" });
    const help = await until(() => fake.sent.find((item) => item.rich?.title === "SuperHive help"));
    expect(help.rich!.locale).toBe("en");
    expect(help.rich!.actions!.map((action) => action.label)).toEqual([
      "Pick agent",
      "Switch room",
      "Who's busy",
      "Notifications",
    ]);
    expect(uiText(help.rich!)).not.toMatch(CJK);

    fake.emit({ text: "menu" });
    const menu = await until(() => fake.sent.find((item) => item.rich?.title === "Control panel"));
    // 唯一的中文是切换语言的按钮本身
    expect(uiText(menu.rich!, ["切换到中文"])).not.toMatch(CJK);
    expect(menu.rich!.actions!.at(-1)).toMatchObject({
      label: "切换到中文",
      value: { do: "lang", locale: "zh-CN" },
    });

    fake.emit({ text: "/who" });
    const who = await until(() => fake.sent.find((item) => item.rich?.title === "Who's busy"));
    expect(who.rich!.body).toContain("**helper**\u3000Idle");
    fake.emit({ text: "/level" });
    const level = await until(() => fake.sent.find((item) => item.rich?.title === "Notifications"));
    expect(level.rich!.tag).toBe("Current: Relevant to me");
    expect(uiText(level.rich!)).not.toMatch(CJK);
    fake.emit({ text: "/nope" });
    await until(() => fake.sent.find((item) => item.text.startsWith("Unknown command: /nope")));

    // 失败提醒：标题、按钮、说明是英文，原因是服务端或 Agent 给的原文
    const trigger = await assign("@helper 部署", "web-en");
    helper.send({ type: "invocation.report", messageId: trigger.id, status: "running" });
    helper.send({
      type: "invocation.report",
      messageId: trigger.id,
      status: "failed",
      detail: "exit 1",
    });
    const notice = await until(() => fake.sent.find((item) => item.rich?.tone === "danger"));
    expect(notice.rich).toMatchObject({ title: "helper failed", tag: "Failed" });
    expect(notice.rich!.actions!.map((action) => action.label)).toEqual(["Retry", "Dismiss"]);
    expect(uiText(notice.rich!, ["@helper 部署", "部署"])).not.toMatch(CJK);
    const retried = fake.events!.onAction!({
      externalId: fake.sentIds.get(notice)!,
      chatId: notice.chatId,
      operatorId: "owner-open-id",
      value: { hive: "1", do: "retry" },
    });
    expect(retried).toMatchObject({
      toast: { text: "Retried" },
      rich: { resolved: { text: "Retried" }, note: "Retried by rd in Feishu" },
    });

    // 控制面板上点「切换到中文」：卡片原地换成中文
    expect(
      fake.events!.onAction!({
        externalId: fake.sentIds.get(menu)!,
        chatId: menu.chatId,
        operatorId: "owner-open-id",
        value: { hive: "1", do: "lang", locale: "zh-CN" },
      }),
    ).toMatchObject({ toast: { text: "已切换为中文" }, rich: { title: "控制面板" } });

    // 网页上也能切
    const switched = await api("POST", `/api/im/connections/${id}/locale`, { locale: "en" });
    expect(switched.body.locale).toBe("en");
    expect((await api("POST", `/api/im/connections/${id}/locale`, { locale: "fr" })).status).toBe(
      400,
    );
  });

  it("English：新连接跟随扫码时网页的语言；文字渠道的提问按英文重排，选项原文照旧", async () => {
    const { fake, api, helper, app } = await setup({ locale: "en" });
    expect((await api("GET", "/api/rooms/general/im")).body.connections[0].locale).toBe("en");
    fake.emit({ text: "随便说一句" });
    await until(() =>
      fake.sent.find((item) =>
        item.text.startsWith('Posted to "general". To get an agent on it, @ it in your message.'),
      ),
    );
    fake.emit({ text: "@helper 发布" });
    const mentioned = await helper.next((event) => event.type === "agent.mentioned");
    const trigger = (mentioned as { message: ChatMessage }).message;
    helper.send({ type: "invocation.report", messageId: trigger.id, status: "running" });
    const port = (app.server.address() as AddressInfo).port;
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: {
        headers: {
          Authorization: "Bearer test-token",
          "X-Hive-Room": "general",
          "X-Hive-Agent-Name": "helper",
        },
      },
    });
    const client = new Client({ name: "im-test", version: "0.1.0" });
    await client.connect(transport as unknown as Transport);
    await client.callTool({
      name: "hive_ask_human",
      arguments: { question: "Which environment?", options: ["staging", "production"] },
    });
    const pushed = await until(() =>
      fake.sent.find((item) => item.text.includes("Which environment?")),
    );
    expect(pushed.text.split("\n").slice(1)).toEqual([
      "❓ Which environment?",
      "(Choose one)",
      "A. staging",
      "B. production",
      "(Reply with an option letter, e.g. A, or in your own words)",
    ]);
    // 命令中英文都认：「菜单」「menu」都打开控制面板（文字渠道回用法）
    fake.emit({ text: "菜单" });
    await until(() => fake.sent.find((item) => item.text.startsWith("Using SuperHive:")));
    fake.emit({ text: "/lang 中文" });
    await until(() => fake.sent.find((item) => item.text === "已切换为中文。"));
    fake.emit({ text: "/lang klingon" });
    await until(() => fake.sent.find((item) => item.text.startsWith("语言只能是")));
    await client.close();
  });
  /** 在另一个房间 proj 里：rd 在网页上派活给 rd-omp，rd-omp 回复，返回回复消息 */
  async function otherRoom(
    ctx: Awaited<ReturnType<typeof setup>>,
    options: { roomName?: string } = {},
  ) {
    await ctx.api("POST", "/api/rooms", { id: "proj", name: options.roomName ?? "项目" });
    const rdProj = await ctx.join("rd", "human", "proj");
    const omp = await ctx.join("rd-omp", "agent", "proj");
    const assign = async (content: string, clientMessageId: string) => {
      rdProj.send({ type: "message.send", clientMessageId, content });
      const mentioned = await omp.next((event) => event.type === "agent.mentioned");
      const trigger = (mentioned as { message: ChatMessage }).message;
      omp.send({ type: "invocation.report", messageId: trigger.id, status: "running" });
      return trigger;
    };
    const reply = async (trigger: ChatMessage, content: string, clientMessageId: string) => {
      omp.send({
        type: "message.send",
        clientMessageId,
        content,
        parentMessageId: trigger.id,
      });
    };
    return { rdProj, omp, assign, reply };
  }

  it("所有房间：其他房间的结果、失败提醒默认也推过来，卡片标「#房间」橙色、带「切过去继续」；回复卡片发到那个房间", async () => {
    const ctx = await setup({ richCards: true });
    const { fake, api, id, helper, assign: assignHere } = ctx;
    const { rdProj, omp, assign, reply } = await otherRoom(ctx);
    expect((await api("GET", "/api/rooms/general/im")).body.connections[0].scope).toBe("all");

    // 当前房间的卡片照旧
    const here = await assignHere("@helper 看下", "here-1");
    helper.send({ type: "invocation.report", messageId: here.id, status: "running" });
    helper.send({
      type: "message.send",
      clientMessageId: "here-reply",
      content: "当前房间的结果",
      parentMessageId: here.id,
    });
    const current = await until(() =>
      fake.sent.find((item) => item.text.includes("当前房间的结果")),
    );
    expect(current.rich!.otherRoom).toBeUndefined();
    expect(current.text.startsWith("[#")).toBe(false);

    // 其他房间：任务结果
    const trigger = await assign("@rd-omp 部署", "proj-1");
    await reply(trigger, "部署好了", "proj-reply");
    const result = await until(() => fake.sent.find((item) => item.text.includes("部署好了")));
    expect(result.text.startsWith("[#项目] ")).toBe(true);
    expect(result.rich).toMatchObject({ room: "项目", otherRoom: { id: "proj", name: "项目" } });
    expect(result.rich!.actions!.at(-1)).toMatchObject({
      label: "切到 #项目 继续",
      value: { do: "goto", room: "proj" },
    });
    const card = renderFeishuCard(result.rich!) as any;
    expect(card.header.template).toBe("orange");
    expect(card.header.text_tag_list[0]).toMatchObject({
      text: { content: "#项目" },
      color: "orange",
    });

    // 其他房间：失败提醒仍是红色，加房间标签
    const failing = await assign("@rd-omp 回滚", "proj-2");
    omp.send({
      type: "invocation.report",
      messageId: failing.id,
      status: "failed",
      detail: "exit 1",
    });
    const notice = await until(() => fake.sent.find((item) => item.rich?.tone === "danger"));
    expect(notice.rich!.otherRoom).toMatchObject({ id: "proj" });
    const noticeCard = renderFeishuCard(notice.rich!) as any;
    expect(noticeCard.header.template).toBe("red");
    expect(noticeCard.header.text_tag_list.map((tag: any) => tag.text.content)).toEqual([
      "#项目",
      "失败",
    ]);
    if (process.env.IM_SAMPLE) {
      const fs = await import("node:fs");
      fs.writeFileSync(
        "/tmp/im-all-rooms-samples.json",
        JSON.stringify(
          {
            currentRoom: renderFeishuCard(current.rich!),
            otherRoom: card,
            otherRoomFailed: noticeCard,
          },
          null,
          2,
        ),
      );
    }

    // 直接回复其他房间的卡片：消息进那个房间，发给卡片上的 Agent
    fake.emit({ text: "再检查一遍", replyToExternalId: fake.sentIds.get(result)! });
    const followUp = await rdProj.next(
      (event) => event.type === "message.created" && event.message.content.includes("再检查一遍"),
    );
    expect((followUp as { message: ChatMessage }).message).toMatchObject({
      roomId: "proj",
      content: "@rd-omp 再检查一遍",
      via: { channel: "feishu" },
    });
    await omp.next((event) => event.type === "agent.mentioned");
    // 当前房间没变
    expect((await api("GET", "/api/rooms/general/im")).body.connections[0].id).toBe(id);

    // 失败卡片上点重试：作用在卡片所在的房间
    expect(
      fake.events!.onAction!({
        externalId: fake.sentIds.get(notice)!,
        chatId: notice.chatId,
        operatorId: "owner-open-id",
        value: { hive: "1", do: "retry" },
      }),
    ).toMatchObject({ toast: { type: "success", text: "已重试" } });
    await omp.next((event) => event.type === "agent.mentioned" && event.message.id === failing.id);

    // 点「切到 #项目 继续」：当前房间切过去，卡片留着内容、去掉这个按钮
    const gone = fake.events!.onAction!({
      externalId: fake.sentIds.get(result)!,
      chatId: result.chatId,
      operatorId: "owner-open-id",
      value: { hive: "1", do: "goto", room: "proj" },
    });
    expect(gone).toMatchObject({
      toast: { type: "success", text: expect.stringContaining("已切换到房间「项目」") },
      rich: { body: expect.stringContaining("部署好了") },
    });
    expect((gone as any).rich.actions.some((item: any) => item.value.do === "goto")).toBe(false);
    expect((await api("GET", "/api/rooms/proj/im")).body.connections[0].id).toBe(id);
  });

  it("仅当前房间时其他房间不推；归档的房间不推；同一个 IM 账号接了两个连接只推一次", async () => {
    const ctx = await setup({ richCards: true });
    const { fake, api, id } = ctx;
    const { assign, reply } = await otherRoom(ctx);
    fake.emit({ text: "/scope current" });
    await until(() => fake.sent.find((item) => item.text === "接收范围改为：仅默认房间"));
    expect((await api("GET", "/api/rooms/general/im")).body.connections[0].scope).toBe("current");
    const first = await assign("@rd-omp 一", "scope-1");
    await reply(first, "只在项目里", "scope-reply-1");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fake.sent.some((item) => item.text.includes("只在项目里"))).toBe(false);

    // 网页上改回所有房间，再把项目归档：归档房间的也不推
    expect(
      (await api("POST", `/api/im/connections/${id}/scope`, { scope: "all" })).body.scope,
    ).toBe("all");
    const second = await assign("@rd-omp 二", "scope-2");
    await api("PATCH", "/api/rooms/proj", { archived: true });
    await reply(second, "归档房间的回复", "scope-reply-2");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fake.sent.some((item) => item.text.includes("归档房间的回复"))).toBe(false);
    await api("PATCH", "/api/rooms/proj", { archived: false });

    // 同一个飞书账号又接了一个机器人，绑在项目房间：项目里的消息只推一次（走绑在项目的那个）
    const previous = fake.login;
    const started = await api("POST", "/api/rooms/proj/im/login", {
      channel: "feishu",
      ownerName: "rd",
    });
    expect(started.status).toBe(201);
    await until(() => fake.login !== previous && fake.login);
    fake.login!.resolve("owner-open-id", "cli_second");
    for (let i = 0; i < 50; i += 1) {
      const list = (await api("GET", "/api/rooms/proj/im")).body.connections;
      if (list[0]?.status === "connected") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const third = await assign("@rd-omp 三", "scope-3");
    await reply(third, "两个连接只推一次", "scope-reply-3");
    await until(() => fake.sent.find((item) => item.text.includes("两个连接只推一次")));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const pushed = fake.sent.filter((item) => item.text.includes("两个连接只推一次"));
    expect(pushed).toHaveLength(1);
    // 绑在项目房间的那个连接推的：不算其他房间
    expect(pushed[0]!.rich!.otherRoom).toBeUndefined();
  });

  it("English：其他房间的卡片、按钮和 /scope 都是英文", async () => {
    const ctx = await setup({ richCards: true, locale: "en" });
    const { fake } = ctx;
    const { assign, reply } = await otherRoom(ctx, { roomName: "proj" });
    const trigger = await assign("@rd-omp deploy", "en-1");
    await reply(trigger, "deployed", "en-reply");
    const result = await until(() => fake.sent.find((item) => item.text.includes("deployed")));
    expect(result.text.startsWith("[#proj] ")).toBe(true);
    expect(result.rich!.actions!.at(-1)!.label).toBe("Continue in #proj");
    fake.emit({ text: "/scope" });
    await until(() =>
      fake.sent.find((item) =>
        item.text.startsWith("Hearing from: All rooms (cards from other rooms are orange)"),
      ),
    );
    fake.emit({ text: "/scope nope" });
    await until(() => fake.sent.find((item) => item.text.startsWith("The scope must be")));
  });
  it("房主没进过的房间里，同名的访客「rd」不算房主：不推、不能切过去、不能以它的身份发言", async () => {
    const ctx = await setup({ richCards: true });
    const { fake, api } = ctx;
    await api("POST", "/api/rooms", { id: "proj", name: "项目" });
    const omp = await ctx.join("rd-omp", "agent", "proj");
    const invite = (
      await api("POST", "/api/rooms/proj/invites", { expiresInMinutes: 60, allowAgents: true })
    ).body;
    const redeemed = await fetch(
      `http://127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}/api/invites/redeem`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: invite.token, username: "rd" }),
      },
    ).then((response) => response.json() as Promise<{ token: string; role: string }>);
    expect(redeemed.role).toBe("guest");
    const guest = await Peer.connect(
      `ws://127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}/ws`,
    );
    peers.push(guest);
    guest.send({
      type: "participant.join",
      username: "rd",
      participantType: "human",
      roomId: "proj",
      token: redeemed.token,
    });
    await guest.next((event) => event.type === "room.snapshot");

    // 访客 rd 派的任务、Agent 提到 rd 的消息：都不推到房主的飞书
    guest.send({ type: "message.send", clientMessageId: "guest-1", content: "@rd-omp 帮我看下" });
    const mentioned = await omp.next((event) => event.type === "agent.mentioned");
    const trigger = (mentioned as { message: ChatMessage }).message;
    omp.send({ type: "invocation.report", messageId: trigger.id, status: "running" });
    omp.send({
      type: "message.send",
      clientMessageId: "guest-reply",
      content: "访客任务的结果 @rd",
      parentMessageId: trigger.id,
    });
    await guest.next(
      (event) =>
        event.type === "message.created" && event.message.content.includes("访客任务的结果"),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fake.sent.some((item) => item.text.includes("访客任务的结果"))).toBe(false);

    // 不能切过去：/room 和「切过去」按钮都给出「还不是成员」
    fake.emit({ text: "/room proj" });
    await until(() => fake.sent.find((item) => item.text.startsWith("你还不是房间「项目」的成员")));
    fake.emit({ text: "menu" });
    const menu = await until(() => fake.sent.find((item) => item.rich?.title === "控制面板"));
    expect(
      fake.events!.onAction!({
        externalId: fake.sentIds.get(menu)!,
        chatId: menu.chatId,
        operatorId: "owner-open-id",
        value: { hive: "1", do: "goto", room: "proj" },
      }),
    ).toMatchObject({
      toast: { type: "error", text: expect.stringContaining("还不是房间「项目」的成员") },
    });
    // 换房间卡片里也没有它
    fake.emit({ text: "/room" });
    const picker = await until(() => fake.sent.find((item) => item.rich?.title === "切换房间"));
    expect(picker.rich!.actions!.some((action) => action.value.room === "proj")).toBe(false);
    const [connection] = (await api("GET", "/api/rooms/general/im")).body.connections;
    expect(connection.roomId).toBe("general");
  });
});

describe("parseChoice", () => {
  const spec = {
    options: [
      { key: "A", label: "一" },
      { key: "B", label: "二" },
      { key: "C", label: "三" },
    ],
    multiple: true,
  };
  it("解析字母回复，大小写与分隔符都可以", () => {
    expect(parseChoice("a", spec)).toEqual(["A"]);
    expect(parseChoice("A,C", spec)).toEqual(["A", "C"]);
    expect(parseChoice("a、c", spec)).toEqual(["A", "C"]);
  });
  it("不像选项、选了不存在的项或单选多选时按文字处理", () => {
    expect(parseChoice("先跑测试", spec)).toBeUndefined();
    expect(parseChoice("D", spec)).toBeUndefined();
    expect(parseChoice("A,B", { ...spec, multiple: false })).toBeUndefined();
    expect(parseChoice("A", undefined)).toBeUndefined();
  });
});
