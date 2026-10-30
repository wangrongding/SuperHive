import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ChatMessage, ServerEvent } from "@ai-hive/protocol";
import WebSocket from "ws";
import { buildApp } from "./app.js";
import { parseChoice } from "./im/im-hub.js";
import type {
  ImChannelDriver,
  ImInbound,
  ImLoginCallbacks,
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
  sent: Array<{ chatId: string; text: string; replyTo?: string }> = [];
  events: ImTransportEvents | undefined;
  login: { callbacks: ImLoginCallbacks; resolve: (owner: string) => void } | undefined;
  transports = 0;
  closes = 0;
  private counter = 0;

  driver(channel: "feishu" | "wechat"): ImChannelDriver {
    return {
      channel,
      maxTextLength: 200,
      login: (callbacks) =>
        new Promise((resolve, reject) => {
          callbacks.signal.addEventListener("abort", () => reject(new Error("已取消")));
          callbacks.onQr("https://example.test/qr", 300);
          this.login = {
            callbacks,
            resolve: (owner) =>
              resolve({
                ownerActorId: owner,
                label: "测试机器人",
                config: { appId: "cli_test" },
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
            this.sent.push({ chatId, text, ...(replyTo ? { replyTo } : {}) });
            this.counter += 1;
            return `out-${this.counter}`;
          },
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

  async function start() {
    const fake = new FakeChannel();
    const clock = { offset: 0 };
    const app = await buildApp({
      databasePath: ":memory:",
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
    const join = async (username: string, participantType: "human" | "agent") => {
      const peer = await Peer.connect(`ws://127.0.0.1:${port}/ws`);
      peers.push(peer);
      peer.send({
        type: "participant.join",
        username,
        participantType,
        roomId: "general",
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
    return { app, port, api, join, connect, fake, clock, setLevel };
  }

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
    await until(() => fake.sent.find((item) => item.text.includes("当前房间")));

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

  async function setup() {
    const fake = new FakeChannel();
    const clock = { offset: 0 };
    const app = await buildApp({
      databasePath: ":memory:",
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
    const join = async (username: string, participantType: "human" | "agent") => {
      const peer = await Peer.connect(`ws://127.0.0.1:${port}/ws`);
      peers.push(peer);
      peer.send({
        type: "participant.join",
        username,
        participantType,
        roomId: "general",
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
    return { api, fake, clock, rd, helper, assign, setLevel, id, join };
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

  it("「全部消息」：人和 Agent 的消息都逐条推送，IM 自己发进来的不回推", async () => {
    const { fake, rd, helper, setLevel } = await setup();
    expect((await setLevel("all")).level).toBe("all");
    rd.send({ type: "message.send", clientMessageId: "hi", content: "大家好" });
    const human = await until(() => fake.sent.find((item) => item.text.includes("大家好")));
    expect(human.text).toBe("general - rd\n大家好");
    helper.send({ type: "message.send", clientMessageId: "chat", content: "收到" });
    await until(() => fake.sent.find((item) => item.text === "general - helper\n收到"));
    const before = fake.sent.length;
    fake.emit({ text: "从飞书说一句" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(fake.sent.slice(before).some((item) => item.text.includes("general - rd\n从飞书"))).toBe(
      false,
    );
  });

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
