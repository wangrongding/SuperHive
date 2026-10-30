import { createHash, randomUUID } from "node:crypto";
import QRCode from "qrcode";
import type {
  ChatMessage,
  ImChannel,
  ImChannelsInfo,
  ImConnection,
  ImDeliveryLevel,
  ImLoginView,
  Invocation,
  Participant,
  QuestionSpec,
} from "@ai-hive/protocol";
import { HiveError, type CreateMessageInput } from "../database.js";
import {
  publicConnection,
  type ImStore,
  type OutboxCheck,
  type OutboxItem,
  type StoredConnection,
} from "./im-store.js";
import {
  USER_TARGET,
  type ImChannelDriver,
  type ImInbound,
  type ImKeyValue,
  type ImTransport,
} from "./types.js";

export type ImHubDeps = {
  store: ImStore;
  drivers: Partial<Record<ImChannel, ImChannelDriver>>;
  getRoom(
    roomId: string,
  ): { id: string; name: string; archivedAt?: string | undefined } | undefined;
  listRoomIds(): string[];
  findParticipant(roomId: string, username: string): Participant | undefined;
  getMessage(id: string): ChatMessage | undefined;
  getInvocation(id: string): Invocation | undefined;
  /** 沿委派链向上的调用（不含自身，最近的在前） */
  invocationAncestors(id: string): Invocation[];
  /** 以房主身份发消息，走与网页发送相同的入库与派发 */
  post(owner: Participant, input: CreateMessageInput): ChatMessage;
  /** 点选式回答：按提问里保存的题目校验后生成完整答案 */
  choose(
    owner: Participant,
    questionId: string,
    selected: string[],
    clientMessageId: string,
  ): ChatMessage;
  /** 这条提问是否还在等人回答 */
  isWaiting(questionId: string): boolean;
  /** 网页地址，用于截断长消息时附上全文链接 */
  webUrl(roomId: string): string | undefined;
  onConnectionsChanged(roomId: string): void;
  log(message: string, detail?: unknown): void;
  now?: () => number;
};

type LoginSession = {
  view: ImLoginView;
  abort: AbortController;
  codeWaiter?: ((code: string) => void) | undefined;
  ownerName: string;
};

const MAX_ATTEMPTS = 8;
/** 「全部 Agent 消息」档的合并窗口 */
export const DIGEST_WINDOW_MS = 3 * 60_000;
const LOGIN_TTL_MS = 10 * 60_000;
const HELP = [
  "AI Hive 用法：",
  "· 直接发文字：以你的身份发进当前房间；要让 Agent 干活，在消息里 @ 它，如「@rd-claude 看下测试为什么挂了」",
  "· Agent 向你提问时，直接回复这条提问，或回复选项字母（多选用逗号隔开，如 A,C）",
  "· /room 查看当前房间，/room 房间ID 切换房间",
  "· /status 查看连接状态",
].join("\n");

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const value = error as { message?: unknown; msg?: unknown; code?: unknown };
    const text = value.message ?? value.msg;
    if (typeof text === "string" && text) return text;
    if (value.code !== undefined) return `错误 ${String(value.code)}`;
  }
  return String(error);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 40);
}

/** 正文里的 @ 换成全角：推到 IM 的内容只是转述，不能在 IM 侧被当成提及 */
function plain(text: string): string {
  return text.replace(/@/g, "＠");
}

/**
 * IM 中枢：管理房间的 IM 连接，把房主在 IM 里发的消息以房主本人身份送进房间，
 * 再把由此发起的任务结果、@ 房主的消息和需要房主回答的提问送回原来的 IM 会话。
 * - 身份：只认扫码的那个人；其他人发来的消息不进房间。
 * - 去重：平台重推的同一条消息只处理一次（入站去重表 + 消息的 clientMessageId）。
 * - 出站：先入持久化队列再发，失败按退避重试，重启后继续；自己发出的消息不会再被收回来。
 */
export class ImHub {
  private readonly transports = new Map<string, ImTransport>();
  private readonly logins = new Map<string, LoginSession>();
  private pumpTimer: NodeJS.Timeout | undefined;
  private pumping = false;
  private closed = false;
  /** 正在把这个连接收到的 IM 消息发进房间：它产生的房间消息不再推回同一个连接 */
  private posting: string | undefined;

  constructor(private readonly deps: ImHubDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  channels(): ImChannelsInfo {
    return {
      feishu: { enabled: Boolean(this.deps.drivers.feishu) },
      wechat: { enabled: Boolean(this.deps.drivers.wechat) },
    };
  }

  list(roomId: string): ImConnection[] {
    return this.deps.store.listConnections(roomId).map((connection) => this.view(connection));
  }

  private view(connection: StoredConnection): ImConnection {
    return publicConnection(connection, this.deps.store.deliveryStats(connection.id));
  }

  setLevel(id: string, level: ImDeliveryLevel): ImConnection {
    const connection = this.require(id);
    this.deps.store.setLevel(id, level);
    this.deps.onConnectionsChanged(connection.roomId);
    return this.view(this.require(id));
  }

  start(): void {
    for (const connection of this.deps.store.listConnections()) {
      if (connection.status !== "paused") void this.connect(connection);
    }
    this.pumpTimer = setInterval(() => void this.pump(), 3_000);
    this.pumpTimer.unref();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.pumpTimer) clearInterval(this.pumpTimer);
    for (const login of this.logins.values()) login.abort.abort();
    await Promise.allSettled([...this.transports.values()].map((transport) => transport.close()));
    this.transports.clear();
  }

  /* ---------- 扫码连接 ---------- */

  startLogin(roomId: string, channel: ImChannel, ownerName: string): ImLoginView {
    const driver = this.deps.drivers[channel];
    if (!driver) throw new HiveError("IM_DISABLED", "这个渠道没有启用。");
    const owner = this.deps.findParticipant(roomId, ownerName);
    if (!owner || owner.type !== "human") {
      throw new HiveError("NOT_A_MEMBER", "需要以房间里的人类成员身份连接。");
    }
    // 同一个房间同一渠道同时只跑一个扫码流程
    for (const [id, login] of this.logins) {
      if (login.view.roomId === roomId && login.view.channel === channel && this.isOpen(login)) {
        login.abort.abort();
        this.logins.delete(id);
      }
    }
    const id = randomUUID();
    const login: LoginSession = {
      view: { id, channel, roomId, status: "starting" },
      abort: new AbortController(),
      ownerName: owner.username,
    };
    this.logins.set(id, login);
    void this.runLogin(login, driver);
    const timer = setTimeout(() => {
      if (this.isOpen(login))
        this.finishLogin(login, { status: "failed", error: "扫码超时，请重新开始。" });
      login.abort.abort();
      setTimeout(() => this.logins.delete(id), 60_000).unref();
    }, LOGIN_TTL_MS);
    timer.unref();
    return login.view;
  }

  getLogin(id: string): ImLoginView | undefined {
    return this.logins.get(id)?.view;
  }

  cancelLogin(id: string): ImLoginView | undefined {
    const login = this.logins.get(id);
    if (!login) return undefined;
    if (this.isOpen(login)) {
      login.abort.abort();
      this.finishLogin(login, { status: "cancelled" });
    }
    return login.view;
  }

  submitCode(id: string, code: string): ImLoginView | undefined {
    const login = this.logins.get(id);
    if (!login) return undefined;
    if (login.view.status !== "need_code" || !login.codeWaiter) {
      throw new HiveError("IM_NO_CODE", "当前不需要输入配对码。");
    }
    const resolve = login.codeWaiter;
    login.codeWaiter = undefined;
    this.updateLogin(login, { status: "connecting" });
    resolve(code);
    return login.view;
  }

  private isOpen(login: LoginSession): boolean {
    return !["succeeded", "failed", "cancelled"].includes(login.view.status);
  }

  private updateLogin(login: LoginSession, patch: Partial<ImLoginView>): void {
    login.view = { ...login.view, ...patch };
  }

  private finishLogin(login: LoginSession, patch: Partial<ImLoginView>): void {
    const rest: ImLoginView = { ...login.view };
    delete rest.qrDataUrl;
    delete rest.qrUrl;
    delete rest.expiresAt;
    login.view = { ...rest, ...patch };
    login.codeWaiter = undefined;
  }

  private loginKv(loginId: string): ImKeyValue {
    const namespace = `login:${loginId}`;
    return {
      get: (key) => this.deps.store.kvGet(namespace, key),
      set: (key, value) => this.deps.store.kvSet(namespace, key, value),
      delete: (key) => this.deps.store.kvDelete(namespace, key),
    };
  }

  private async runLogin(login: LoginSession, driver: ImChannelDriver): Promise<void> {
    const namespace = `login:${login.view.id}`;
    try {
      const result = await driver.login({
        signal: login.abort.signal,
        kv: this.loginKv(login.view.id),
        onQr: (url, expiresIn) => {
          if (!this.isOpen(login)) return;
          void QRCode.toDataURL(url, { margin: 1, width: 240 }).then((qrDataUrl) => {
            if (!this.isOpen(login)) return;
            this.updateLogin(login, {
              status: "waiting_scan",
              qrUrl: url,
              qrDataUrl,
              ...(expiresIn
                ? { expiresAt: new Date(this.now() + expiresIn * 1_000).toISOString() }
                : {}),
            });
          });
        },
        onScanned: () => {
          if (this.isOpen(login)) this.updateLogin(login, { status: "scanned" });
        },
        requestCode: (isRetry) =>
          new Promise<string>((resolve, reject) => {
            if (!this.isOpen(login)) return reject(new Error("已取消"));
            login.codeWaiter = resolve;
            this.updateLogin(login, {
              status: "need_code",
              ...(isRetry ? { error: "配对码不对，请重新输入。" } : {}),
            });
            login.abort.signal.addEventListener("abort", () => reject(new Error("已取消")), {
              once: true,
            });
          }),
      });
      if (!this.isOpen(login)) {
        this.deps.store.kvDelete(namespace);
        return;
      }
      this.updateLogin(login, { status: "connecting" });
      const connection = this.saveConnection(login, driver, result);
      this.deps.store.kvMove(namespace, connection.id);
      this.finishLogin(login, { status: "succeeded", connectionId: connection.id });
      this.deps.onConnectionsChanged(connection.roomId);
      void this.connect(connection);
    } catch (error) {
      this.deps.store.kvDelete(namespace);
      if (!this.isOpen(login)) return;
      this.finishLogin(login, {
        status: login.abort.signal.aborted ? "cancelled" : "failed",
        error: describe(error),
      });
    }
  }

  private saveConnection(
    login: LoginSession,
    driver: ImChannelDriver,
    result: Awaited<ReturnType<ImChannelDriver["login"]>>,
  ): StoredConnection {
    const identity = result.config[result.identityKey];
    const existing = identity
      ? this.deps.store.findByIdentity(driver.channel, result.identityKey, identity)
      : undefined;
    if (existing) {
      // 已经连过的同一个机器人 / 账号：换了扫码人就拒绝，避免别人顶替房主身份
      if (existing.ownerActorId !== result.ownerActorId) {
        throw new Error("这个机器人已由另一个人连接，需要原来的人扫码，或先在原房间断开。");
      }
      void this.disconnectTransport(existing.id);
      this.deps.store.updateSecret(existing.id, result.secret);
      this.deps.store.kvDelete(existing.id);
      const moved = this.deps.store.update(existing.id, {
        roomId: login.view.roomId,
        ownerName: login.ownerName,
        label: result.label,
        config: result.config,
      })!;
      if (moved.roomId !== existing.roomId) this.deps.onConnectionsChanged(existing.roomId);
      return this.deps.store.setStatus(moved.id, "connecting")!;
    }
    return this.deps.store.createConnection({
      roomId: login.view.roomId,
      channel: driver.channel,
      ownerName: login.ownerName,
      ownerActorId: result.ownerActorId,
      label: result.label,
      config: result.config,
      secret: result.secret,
    });
  }

  /* ---------- 连接生命周期 ---------- */

  private kvOf(connectionId: string): ImKeyValue {
    return {
      get: (key) => this.deps.store.kvGet(connectionId, key),
      set: (key, value) => this.deps.store.kvSet(connectionId, key, value),
      delete: (key) => this.deps.store.kvDelete(connectionId, key),
    };
  }

  private setStatus(id: string, status: ImConnection["status"], detail?: string): void {
    const current = this.deps.store.getConnection(id);
    if (!current || (current.status === status && current.detail === detail)) return;
    // 暂停是房主的决定，传输层迟到的状态不能把它改回来
    if (current.status === "paused" && status !== "paused") return;
    this.deps.store.setStatus(id, status, detail);
    this.deps.onConnectionsChanged(current.roomId);
  }

  private async connect(connection: StoredConnection): Promise<void> {
    if (this.closed) return;
    const driver = this.deps.drivers[connection.channel];
    if (!driver) {
      this.setStatus(connection.id, "error", "这个渠道已被关闭（HIVE_IM_WECHAT=0）。");
      return;
    }
    await this.disconnectTransport(connection.id);
    let transport: ImTransport;
    try {
      transport = driver.createTransport({
        config: connection.config,
        secret: this.deps.store.secretOf(connection.id) ?? "",
        kv: this.kvOf(connection.id),
      });
    } catch (error) {
      this.setStatus(connection.id, "error", describe(error));
      return;
    }
    this.transports.set(connection.id, transport);
    this.setStatus(connection.id, "connecting");
    try {
      await transport.start({
        onMessage: (message) => {
          try {
            this.handleInbound(connection.id, message);
          } catch (error) {
            this.deps.log("im inbound failed", error);
          }
        },
        onStatus: (status, detail) => {
          if (this.transports.get(connection.id) === transport)
            this.setStatus(connection.id, status, detail);
        },
      });
      if (this.transports.get(connection.id) === transport) {
        this.setStatus(connection.id, "connected");
        void this.pump();
      }
    } catch (error) {
      if (this.transports.get(connection.id) === transport) {
        this.transports.delete(connection.id);
        this.setStatus(connection.id, "error", describe(error));
      }
    }
  }

  private async disconnectTransport(id: string): Promise<void> {
    const transport = this.transports.get(id);
    if (!transport) return;
    this.transports.delete(id);
    await transport.close().catch(() => undefined);
  }

  async pause(id: string): Promise<ImConnection> {
    const connection = this.require(id);
    await this.disconnectTransport(id);
    this.deps.store.setStatus(id, "paused");
    this.deps.store.dropPending(id);
    this.deps.onConnectionsChanged(connection.roomId);
    return this.view(this.require(id));
  }

  async resume(id: string): Promise<ImConnection> {
    this.require(id);
    const connection = this.deps.store.setStatus(id, "connecting")!;
    this.deps.onConnectionsChanged(connection.roomId);
    void this.connect(connection);
    return this.view(connection);
  }

  async remove(id: string): Promise<void> {
    const connection = this.require(id);
    await this.disconnectTransport(id);
    this.deps.store.deleteConnection(id);
    this.deps.onConnectionsChanged(connection.roomId);
  }

  connectionRoom(id: string): string | undefined {
    return this.deps.store.getConnection(id)?.roomId;
  }

  private require(id: string): StoredConnection {
    const connection = this.deps.store.getConnection(id);
    if (!connection) throw new HiveError("IM_NOT_FOUND", "这个 IM 连接不存在。");
    return connection;
  }

  /* ---------- 入站：IM → 房间 ---------- */

  private reply(
    connection: StoredConnection,
    chatId: string,
    text: string,
    replyTo?: string,
  ): void {
    const transport = this.transports.get(connection.id);
    void transport?.sendText(chatId, text, replyTo).catch((error: unknown) => {
      this.deps.log("im reply failed", error);
    });
  }

  handleInbound(connectionId: string, message: ImInbound): void {
    const connection = this.deps.store.getConnection(connectionId);
    if (!connection || connection.status === "paused") return;
    if (!this.deps.store.claimInbound(connection.id, message.externalId)) return;
    if (message.senderId !== connection.ownerActorId) {
      // 群里其他人 @ 机器人不回应；私聊提示一次即可
      if (message.chatType === "p2p") {
        this.reply(
          connection,
          message.chatId,
          "这个机器人只转发房主本人的消息。",
          message.externalId,
        );
      }
      return;
    }
    if (connection.channel === "wechat" && message.chatType !== "p2p") return;
    if (message.unsupported || !message.text) {
      this.reply(connection, message.chatId, "目前只支持文字消息。", message.externalId);
      return;
    }
    this.deps.store.touchInbound(connection.id, message.chatId);
    const text = message.text.trim();
    if (text.startsWith("/")) {
      this.handleCommand(connection, message, text);
      return;
    }
    const owner = this.deps.findParticipant(connection.roomId, connection.ownerName);
    if (!owner || owner.type !== "human") {
      this.reply(
        connection,
        message.chatId,
        `在房间「${connection.roomId}」里找不到成员 ${connection.ownerName}，请先在网页上进入这个房间。`,
        message.externalId,
      );
      return;
    }
    const clientMessageId = `im-${digest(`${connection.id}:${message.externalId}`)}`;
    let posted: ChatMessage;
    this.posting = connection.id;
    try {
      const question = this.questionFor(connection, message, text);
      posted = question
        ? this.answer(owner, question, text, clientMessageId, connection.channel)
        : this.deps.post(owner, {
            content: text,
            clientMessageId,
            via: { channel: connection.channel },
          });
    } catch (error) {
      this.reply(
        connection,
        message.chatId,
        `没能发进房间：${describe(error)}`,
        message.externalId,
      );
      return;
    } finally {
      this.posting = undefined;
    }
    this.deps.store.link({
      messageId: posted.id,
      connectionId: connection.id,
      chatId: message.chatId,
      externalId: message.externalId,
      direction: "in",
    });
    if (!posted.replyToMessageId && posted.mentions.length === 0) {
      this.reply(
        connection,
        message.chatId,
        `已发到房间「${this.roomName(connection.roomId)}」。要让 Agent 处理，请在消息里 @ 它；回复 /help 查看用法。`,
        message.externalId,
      );
    }
  }

  /** 这条 IM 消息是不是在回答 Agent 的提问：引用回复了推过来的提问，或没有 @ 任何人且会话里有在等的提问 */
  private questionFor(
    connection: StoredConnection,
    message: ImInbound,
    text: string,
  ): ChatMessage | undefined {
    if (message.replyToExternalId) {
      const id = this.deps.store.messageForExternal(connection.id, message.replyToExternalId);
      const quoted = id ? this.deps.getMessage(id) : undefined;
      if (quoted?.kind === "question" && this.deps.isWaiting(quoted.id)) return quoted;
    }
    if (/@[\p{L}\p{N}_.-]/u.test(text)) return undefined;
    // 网页任务的提问是按人发到私聊的（user: 目标），在私聊里作答时两种会话标识都要查
    const recent = [
      ...this.deps.store.recentOutboundMessages(connection.id, message.chatId, 20),
      ...(message.chatType === "p2p"
        ? this.deps.store.recentOutboundMessages(
            connection.id,
            `${USER_TARGET}${message.senderId}`,
            20,
          )
        : []),
    ];
    for (const id of recent) {
      const candidate = this.deps.getMessage(id);
      if (
        candidate?.kind === "question" &&
        candidate.roomId === connection.roomId &&
        this.deps.isWaiting(candidate.id)
      ) {
        return candidate;
      }
    }
    return undefined;
  }

  private answer(
    owner: Participant,
    question: ChatMessage,
    text: string,
    clientMessageId: string,
    channel: ImChannel,
  ): ChatMessage {
    const keys = parseChoice(text, question.question);
    if (keys) return this.deps.choose(owner, question.id, keys, clientMessageId);
    return this.deps.post(owner, {
      content: text,
      clientMessageId,
      replyToMessageId: question.id,
      via: { channel },
    });
  }

  private roomName(roomId: string): string {
    return this.deps.getRoom(roomId)?.name ?? roomId;
  }

  private handleCommand(connection: StoredConnection, message: ImInbound, text: string): void {
    const [command, ...args] = text.split(/\s+/);
    const say = (reply: string) =>
      this.reply(connection, message.chatId, reply, message.externalId);
    switch (command?.toLowerCase()) {
      case "/help":
        return say(HELP);
      case "/status":
        return say(
          `${connection.label} 已连接到房间「${this.roomName(connection.roomId)}」，以 ${connection.ownerName} 的身份发言。`,
        );
      case "/room": {
        const target = args[0];
        if (!target) {
          const rooms = this.deps
            .listRoomIds()
            .filter((id) => this.deps.findParticipant(id, connection.ownerName)?.type === "human");
          return say(
            `当前房间：${this.roomName(connection.roomId)}（${connection.roomId}）\n可切换：${rooms.join("、") || "无"}\n切换：/room 房间ID`,
          );
        }
        const room = this.deps.getRoom(target);
        if (!room || room.archivedAt) return say(`没有房间 ${target}。`);
        const member = this.deps.findParticipant(room.id, connection.ownerName);
        if (!member || member.type !== "human") {
          return say(`你还不是房间「${room.name}」的成员，请先在网页上进入一次。`);
        }
        const previous = connection.roomId;
        this.deps.store.update(connection.id, { roomId: room.id });
        this.deps.onConnectionsChanged(previous);
        this.deps.onConnectionsChanged(room.id);
        return say(`已切换到房间「${room.name}」。`);
      }
      default:
        return say(`不认识的命令 ${command}。\n${HELP}`);
    }
  }

  /* ---------- 出站：房间 → IM ---------- */

  /** 沿 parent 链往上找这条消息是不是由这个 IM 连接发起的 */
  private originOf(message: ChatMessage, connectionId: string) {
    let current: ChatMessage | undefined = message;
    for (let depth = 0; current && depth < 64; depth += 1) {
      const link = this.deps.store
        .linksOf(current.id)
        .find((item) => item.connectionId === connectionId && item.direction === "in");
      if (link) return link;
      current = current.parentMessageId ? this.deps.getMessage(current.parentMessageId) : undefined;
    }
    return undefined;
  }

  private ownerOf(connection: StoredConnection): Participant | undefined {
    const owner = this.deps.findParticipant(connection.roomId, connection.ownerName);
    return owner?.type === "human" ? owner : undefined;
  }

  /** 这条调用最初是谁派的：沿委派链走到最上游 */
  private rootRequesterId(invocation: Invocation): string | undefined {
    const chain = this.deps.invocationAncestors(invocation.id);
    return (chain.at(-1) ?? invocation).requesterId;
  }

  /** 推送目标：由这个连接发起的回到原会话；其余一律发到房主私聊，不猜「最近说过话的会话」 */
  private target(connection: StoredConnection, origin?: { chatId: string; externalId?: string }) {
    if (origin) {
      return {
        chatId: origin.chatId,
        ...(origin.externalId && connection.channel === "feishu"
          ? { replyToExternalId: origin.externalId }
          : {}),
      };
    }
    return { chatId: `${USER_TARGET}${connection.ownerActorId}` };
  }

  private mentionsOwner(message: ChatMessage, connection: StoredConnection): boolean {
    const name = connection.ownerName.toLocaleLowerCase();
    return message.mentions.some((mention) => mention.toLocaleLowerCase() === name);
  }

  private enqueueMessage(
    connection: StoredConnection,
    message: ChatMessage,
    options: { batch?: boolean; check?: OutboxCheck } = {},
  ): void {
    const origin = this.originOf(message, connection.id);
    const driver = this.deps.drivers[connection.channel];
    const eventKey = `msg:${message.id}`;
    const created = this.deps.store.enqueue({
      connectionId: connection.id,
      eventKey,
      messageId: message.id,
      ...this.target(connection, origin),
      text: this.format(message, driver?.maxTextLength ?? 1800),
      ...(options.batch ? { batch: true } : {}),
      ...(options.check ? { check: options.check } : {}),
    });
    // 同一条消息已作为合并项排队：现在要求立即发（例如它就是房主任务的最终结果）
    if (!created && !options.batch) this.deps.store.promote(connection.id, eventKey);
  }

  /** 房间里有新消息：按每个连接的档位决定推不推 */
  onMessageCreated(message: ChatMessage): void {
    for (const connection of this.deps.store.listConnections(message.roomId)) {
      if (connection.status === "paused") continue;
      // 从这个连接发进来的消息不再推回去
      if (this.posting === connection.id) continue;
      const decision = this.decide(connection, message);
      if (decision === "skip") {
        if (message.senderType === "agent") this.deps.store.countFiltered(connection.id);
        continue;
      }
      this.enqueueMessage(connection, message, {
        ...(decision === "batch" ? { batch: true } : {}),
        ...(message.kind === "question"
          ? { check: { kind: "question" as const, messageId: message.id } }
          : {}),
      });
    }
    this.schedulePump();
  }

  private decide(connection: StoredConnection, message: ChatMessage): "now" | "batch" | "skip" {
    if (connection.level === "all") return "now";
    if (message.senderType !== "agent" || message.via || message.kind === "topic") return "skip";
    const mentionsOwner = this.mentionsOwner(message, connection);
    if (connection.level === "im") {
      // 早期行为：IM 发起的任务链里给人看的回复，以及提到房主的消息
      if (message.kind === "delegation" || message.kind === "receipt") return "skip";
      const origin = this.originOf(message, connection.id);
      const mentionsAgent = message.mentions.some(
        (name) =>
          name.toLocaleLowerCase() !== connection.ownerName.toLocaleLowerCase() &&
          this.deps.findParticipant(message.roomId, name)?.type === "agent",
      );
      return mentionsOwner || (origin && (message.kind === "question" || !mentionsAgent))
        ? "now"
        : "skip";
    }
    // 与我相关：真正提到房主的消息（含问房主的问题）马上推；任务的最终结果由调用状态推
    if (mentionsOwner) return "now";
    if (connection.level === "agents" && message.kind !== "receipt") return "batch";
    return "skip";
  }

  /**
   * 调用状态变化：房主任务的最终结果，以及需要房主知道或处理的状态（失败、结果未知、被拦下、等批准）。
   * 这些往往没有对应的聊天消息，只看新消息会漏掉。
   */
  onInvocationUpdated(invocation: Invocation): void {
    for (const connection of this.deps.store.listConnections(invocation.roomId)) {
      if (connection.status === "paused" || connection.level === "im") continue;
      const owner = this.ownerOf(connection);
      if (!owner) continue;
      const ownTask = this.rootRequesterId(invocation) === owner.id;
      // 最终结果：房主直接派的这一轮交付的回复（委派出去的子任务回执给 Agent，不推）
      if (
        invocation.status === "completed" &&
        invocation.replyMessageId &&
        invocation.requesterId === owner.id
      ) {
        const reply = this.deps.getMessage(invocation.replyMessageId);
        if (reply && !reply.deletedAt) this.enqueueMessage(connection, reply);
        continue;
      }
      const approval =
        invocation.status === "blocked" && invocation.blockReason === "guest_approval";
      if (!approval && !ownTask) continue;
      const notice = this.statusNotice(invocation);
      if (!notice) continue;
      const trigger = this.deps.getMessage(invocation.messageId);
      const origin = trigger ? this.originOf(trigger, connection.id) : undefined;
      const driver = this.deps.drivers[connection.channel];
      this.deps.store.enqueue({
        connectionId: connection.id,
        eventKey: `inv:${invocation.id}:${invocation.attempts}:${invocation.status}`,
        ...this.target(connection, origin),
        text: this.clip(
          `${this.roomName(invocation.roomId)} - ${invocation.agentName}\n${notice}`,
          invocation.roomId,
          driver?.maxTextLength ?? 1800,
        ),
        check: {
          kind: "invocation",
          id: invocation.id,
          status: invocation.status,
          attempts: invocation.attempts,
        },
      });
    }
    this.schedulePump();
  }

  private statusNotice(invocation: Invocation): string | undefined {
    const trigger = this.deps.getMessage(invocation.messageId);
    const ref = trigger ? `#${trigger.seq}` : "这条任务";
    const detail = invocation.detail ? plain(invocation.detail.replace(/\s+/g, " ")) : "";
    switch (invocation.status) {
      case "failed":
        return `⚠️ 处理 ${ref} 失败${detail ? `：${detail}` : ""}\n到网页查看或重试 ${ref}`;
      case "timed_out":
        return `⚠️ 处理 ${ref} 结果未知（长时间没有进展，不代表失败）\n到网页查看 ${ref}`;
      case "blocked":
        return invocation.blockReason === "guest_approval"
          ? `🔒 ${plain(invocation.requesterName)} 是访客，请 ${invocation.agentName} 处理 ${ref}，等你批准\n到网页点「批准」`
          : `⏸️ ${ref} 已暂停：${detail || "Agent 对话轮数到了上限"}\n到网页点「继续」`;
      default:
        return undefined;
    }
  }

  private formatAttachments(message: ChatMessage): string[] {
    const attachments = message.attachments ?? [];
    if (!attachments.length) return [];
    return [
      `📎 附件 ${attachments.length} 个：`,
      ...attachments.map((item) => `· ${item.name}（${formatSize(item.size)}）`),
      `到网页查看 #${message.seq}${this.deps.webUrl(message.roomId) ? `：${this.deps.webUrl(message.roomId)}` : ""}`,
    ];
  }

  /** 消息顶部统一标注「房间名 - 发送者」 */
  private format(message: ChatMessage, limit: number): string {
    const header = `${this.roomName(message.roomId)} - ${message.senderName}`;
    let body = plain(message.content);
    if (message.kind === "question") {
      body = body.replace(
        /（(点选选项|回复这条消息)[^）]*）\s*$/u,
        message.question
          ? message.question.multiple
            ? "（回复选项字母作答，多选用逗号隔开，如 A,C；也可以直接回复文字）"
            : "（回复选项字母作答，如 A；也可以直接回复文字）"
          : "（直接回复这条消息作答）",
      );
    }
    const extra = this.formatAttachments(message);
    const tail = extra.length ? `\n\n${extra.join("\n")}` : "";
    const head = body ? `${header}\n${body}` : header;
    return this.clip(head, message.roomId, limit - tail.length, message.seq) + tail;
  }

  private clip(text: string, roomId: string, limit: number, seq?: number): string {
    if (text.length <= limit) return text;
    const url = this.deps.webUrl(roomId);
    const suffix = `\n…（太长已截断，全文见网页${seq ? ` #${seq}` : ""}${url ? `：${url}` : ""}）`;
    return text.slice(0, Math.max(0, limit - suffix.length)) + suffix;
  }

  /** 发送前复核：问题已被回答、调用已经变了状态，就不再发过时的提醒 */
  private stillRelevant(item: OutboxItem): boolean {
    const check = item.check;
    if (!check) return true;
    if (check.kind === "question") return this.deps.isWaiting(check.messageId);
    const current = this.deps.getInvocation(check.id);
    // 已被人忽略或被之后的正常任务收起的异常，也不再提醒
    return Boolean(
      current &&
      !current.resolution &&
      current.status === check.status &&
      current.attempts === check.attempts,
    );
  }

  /**
   * 放到下一拍再发：新消息入队时，产生它的那次操作（例如提问把调用转为等人回答）还没做完，
   * 立即复核会把刚入队的提醒误判为过时
   */
  private schedulePump(): void {
    setImmediate(() => void this.pump());
  }

  async pump(): Promise<void> {
    if (this.pumping || this.closed) return;
    this.pumping = true;
    try {
      const due = this.deps.store.duePending(this.now());
      // 合并项：同一会话攒满一个窗口后合成一条（或按长度切成几条）发
      const batches = new Map<string, OutboxItem[]>();
      for (const item of due) {
        if (!item.batch) continue;
        const key = `${item.connectionId}\u0000${item.chatId}`;
        batches.set(key, [...(batches.get(key) ?? []), item]);
      }
      for (const item of due) {
        if (item.batch) continue;
        await this.sendItems([item], item.text);
      }
      for (const items of batches.values()) {
        const oldest = Date.parse(items[0]!.createdAt ?? new Date(this.now()).toISOString());
        if (this.now() - oldest < DIGEST_WINDOW_MS) continue;
        const connection = this.deps.store.getConnection(items[0]!.connectionId);
        const limit = (connection && this.deps.drivers[connection.channel]?.maxTextLength) ?? 1800;
        for (const group of chunk(items, limit)) {
          await this.sendItems(group, group.map((item) => item.text).join("\n\n———\n\n"));
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private async sendItems(items: OutboxItem[], text: string): Promise<void> {
    const first = items[0]!;
    const transport = this.transports.get(first.connectionId);
    const connection = this.deps.store.getConnection(first.connectionId);
    if (!transport || !connection || connection.status !== "connected") return;
    const live = items.filter((item) => {
      if (this.stillRelevant(item)) return true;
      this.deps.store.markSkipped(item.id);
      return false;
    });
    if (!live.length) return;
    try {
      const externalId = await transport.sendText(
        first.chatId,
        live.length === items.length ? text : live.map((item) => item.text).join("\n\n———\n\n"),
        first.replyToExternalId,
      );
      for (const item of live) {
        this.deps.store.markSent(item.id);
        if (item.messageId) {
          this.deps.store.link({
            messageId: item.messageId,
            connectionId: item.connectionId,
            chatId: item.chatId,
            ...(externalId ? { externalId } : {}),
            direction: "out",
          });
        }
      }
    } catch (error) {
      for (const item of live) {
        const attempts = item.attempts + 1;
        this.deps.store.markRetry(
          item.id,
          attempts,
          this.now() + Math.min(5 * 60_000, 5_000 * 2 ** attempts),
          describe(error),
          attempts >= MAX_ATTEMPTS,
        );
      }
    } finally {
      this.deps.onConnectionsChanged(connection.roomId);
    }
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 合并项按单条长度上限切组 */
function chunk(items: OutboxItem[], limit: number): OutboxItem[][] {
  const groups: OutboxItem[][] = [];
  let current: OutboxItem[] = [];
  let length = 0;
  for (const item of items) {
    const next = length + item.text.length + 9;
    if (current.length && next > limit) {
      groups.push(current);
      current = [];
      length = 0;
    }
    current.push(item);
    length += item.text.length + 9;
  }
  if (current.length) groups.push(current);
  return groups;
}

/** 「A」「a,c」「A、C」这类回复解析成选项；不像选项或与题目不符时返回 undefined，按文字回答 */
export function parseChoice(text: string, spec: QuestionSpec | undefined): string[] | undefined {
  if (!spec) return undefined;
  const trimmed = text.trim();
  if (!/^[A-Za-z](\s*[,，、;；\s]\s*[A-Za-z])*$/.test(trimmed)) return undefined;
  const keys = [...new Set(trimmed.toUpperCase().match(/[A-Z]/g) ?? [])];
  if (!keys.length || keys.some((key) => !spec.options.some((option) => option.key === key))) {
    return undefined;
  }
  if (!spec.multiple && keys.length > 1) return undefined;
  return keys;
}
