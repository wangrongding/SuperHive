import { createHash, randomUUID } from "node:crypto";
import QRCode from "qrcode";
import type {
  ChatMessage,
  ImChannel,
  ImChannelsInfo,
  ImConnection,
  ImLoginView,
  Participant,
  QuestionSpec,
} from "@ai-hive/protocol";
import { HiveError, type CreateMessageInput } from "../database.js";
import { publicConnection, type ImStore, type StoredConnection } from "./im-store.js";
import type { ImChannelDriver, ImInbound, ImKeyValue, ImTransport } from "./types.js";

export type ImHubDeps = {
  store: ImStore;
  drivers: Partial<Record<ImChannel, ImChannelDriver>>;
  getRoom(
    roomId: string,
  ): { id: string; name: string; archivedAt?: string | undefined } | undefined;
  listRoomIds(): string[];
  findParticipant(roomId: string, username: string): Participant | undefined;
  getMessage(id: string): ChatMessage | undefined;
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
    return this.deps.store.listConnections(roomId).map(publicConnection);
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
    this.deps.onConnectionsChanged(connection.roomId);
    return publicConnection(this.require(id));
  }

  async resume(id: string): Promise<ImConnection> {
    this.require(id);
    const connection = this.deps.store.setStatus(id, "connecting")!;
    this.deps.onConnectionsChanged(connection.roomId);
    void this.connect(connection);
    return publicConnection(connection);
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
    for (const id of this.deps.store.recentOutboundMessages(connection.id, message.chatId, 20)) {
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

  /** 沿 parent 链往上找这条消息是不是由某个 IM 会话发起的 */
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

  /** 房间里有新消息：判断要不要推给这个房间的 IM 连接 */
  onMessageCreated(message: ChatMessage): void {
    // 只转述 Agent 的发言；人发的（包括从 IM 进来的）不回推，避免回环
    if (message.senderType !== "agent" || message.via) return;
    if (message.kind === "topic" || message.kind === "delegation" || message.kind === "receipt")
      return;
    for (const connection of this.deps.store.listConnections(message.roomId)) {
      if (connection.status === "paused") continue;
      const origin = this.originOf(message, connection.id);
      const mentionsOwner = message.mentions.some(
        (name) => name.toLocaleLowerCase() === connection.ownerName.toLocaleLowerCase(),
      );
      // 由 IM 发起的任务链里，Agent 之间互相 @ 的讨论不推，只推给人看的结果
      const mentionsAgent = message.mentions.some((name) => {
        if (name.toLocaleLowerCase() === connection.ownerName.toLocaleLowerCase()) return false;
        return this.deps.findParticipant(message.roomId, name)?.type === "agent";
      });
      const deliver =
        mentionsOwner || (Boolean(origin) && (message.kind === "question" || !mentionsAgent));
      if (!deliver) continue;
      const chatId = origin?.chatId ?? connection.lastChatId;
      if (!chatId) continue;
      const driver = this.deps.drivers[connection.channel];
      this.deps.store.enqueue({
        connectionId: connection.id,
        messageId: message.id,
        chatId,
        ...(origin?.externalId && connection.channel === "feishu"
          ? { replyToExternalId: origin.externalId }
          : {}),
        text: this.format(message, driver?.maxTextLength ?? 1800),
      });
    }
    void this.pump();
  }

  private format(message: ChatMessage, limit: number): string {
    const header = `【${this.roomName(message.roomId)}】${message.senderName}：`;
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
    const full = `${header}\n${body}`;
    if (full.length <= limit) return full;
    const url = this.deps.webUrl(message.roomId);
    const suffix = `\n…（太长已截断，全文见网页 #${message.seq}${url ? `：${url}` : ""}）`;
    return full.slice(0, Math.max(0, limit - suffix.length)) + suffix;
  }

  async pump(): Promise<void> {
    if (this.pumping || this.closed) return;
    this.pumping = true;
    try {
      for (const item of this.deps.store.duePending(this.now())) {
        const transport = this.transports.get(item.connectionId);
        const connection = this.deps.store.getConnection(item.connectionId);
        if (!transport || !connection || connection.status !== "connected") continue;
        try {
          const externalId = await transport.sendText(
            item.chatId,
            item.text,
            item.replyToExternalId,
          );
          this.deps.store.markSent(item.id);
          this.deps.store.link({
            messageId: item.messageId,
            connectionId: item.connectionId,
            chatId: item.chatId,
            ...(externalId ? { externalId } : {}),
            direction: "out",
          });
        } catch (error) {
          const attempts = item.attempts + 1;
          this.deps.store.markRetry(
            item.id,
            attempts,
            this.now() + Math.min(5 * 60_000, 5_000 * 2 ** attempts),
            describe(error),
            attempts >= MAX_ATTEMPTS,
          );
        }
      }
    } finally {
      this.pumping = false;
    }
  }
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
