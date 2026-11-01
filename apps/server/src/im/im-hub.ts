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
} from "@superhive/protocol";
import { HiveError, type CreateMessageInput } from "../database.js";
import {
  publicConnection,
  type ImStore,
  type OutboxCheck,
  type OutboxItem,
  type StoredConnection,
} from "./im-store.js";
import { OPTION_FIELD_PREFIX, OTHER_FIELD } from "./feishu-card.js";
import { applyChoice, matchAgents, resolveAliases } from "./im-routing.js";
import {
  USER_TARGET,
  type ImChannelDriver,
  type ImInbound,
  type ImAction,
  type ImActionResult,
  type ImKeyValue,
  type ImRich,
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
    other?: string,
  ): ChatMessage;
  /** 卡片按钮：重试 / 批准、忽略、追加对话轮数（与网页上的同名操作同一套校验） */
  retry(owner: Participant, invocationId: string): void;
  dismiss(owner: Participant, invocationId: string): void;
  extendBudget(owner: Participant, turns: number): void;
  /** 一条消息触发的调用（进度卡片按它们画） */
  invocationsFor(messageId: string): Invocation[];
  /** 读出房间附件的内容，转发到 IM */
  readAttachment(
    id: string,
  ): Promise<{ name: string; mime: string; kind: string; data: Buffer } | undefined>;
  /** 把 IM 发来的文件存成房主的待发附件，返回发消息时要带上的附件字段 */
  saveFiles(
    owner: Participant,
    files: Array<{ name: string; data: Buffer }>,
  ): Promise<Pick<CreateMessageInput, "attachments" | "onInsert">>;
  /** 房间成员（/who 用） */
  participants(roomId: string): Participant[];
  /** 房间里进行中、等人回答的任务数（房间卡片上显示） */
  roomTasks(roomId: string): { running: number; waiting: number };
  /** 这条提问是否还在等人回答 */
  isWaiting(questionId: string): boolean;
  /** 网页地址，用于截断长消息时附上全文链接 */
  webUrl(roomId: string): string | undefined;
  /** 卡片按钮上的网页地址：带房主登录票，在没登录过的设备上点开也能直接进 */
  loginUrl?(connectionId: string, roomId: string): string | undefined;
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
  "SuperHive 用法：",
  "· 直接发文字、图片或文件：以你的身份发进当前房间；要让 Agent 干活，在消息里 @ 它，如「@rd-claude 看下测试为什么挂了」",
  "· Agent 向你提问时，点卡片上的选项，或回复这条提问打字（选项字母也行，多选用逗号隔开，如 A,C）",
  "· /to 选对话对象：选好后直接打字就发给它；也可以 /to codex。临时找别人写 @简写，如 @codex",
  "· 回复某个 Agent 的卡片，就是接着跟它说",
  "· /room 切换房间（点卡片或回编号），/room 房间ID 直接切",
  "· /who 看房间里的 Agent 谁在忙",
  "· /level 查看推送档位，/level mine|im|agents|all 切换",
  "· /web 获取在手机或其他电脑上打开网页的登录链接",
  "· /status 查看连接状态",
  "· /cards on 在飞书后台开通卡片回调后打开卡片按钮（重新扫码会自动开通）",
  "· 机器人菜单：飞书开发者后台 → 机器人 → 自定义菜单，菜单项选「推送事件」，事件 key 填 to、room、who、level、help",
].join("\n");

const LEVEL_TEXT: Record<ImDeliveryLevel, string> = {
  mine: "与我相关（默认）：给你的最终结果、提到你、问你的问题、需要你处理的异常",
  im: "仅 IM 发起：只推从这里发起的任务结果和提到你的消息",
  agents: "全部 Agent 消息：另外把 Agent 的发言每 3 分钟合并推一次",
  all: "全部消息：房间里每条消息都推",
};

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
  /** 正在处理这个连接的卡片作答：卡片由回调应答直接更新 */
  private answeringFromCard: string | undefined;

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
        onAction: (action) => {
          try {
            return this.handleAction(connection.id, action);
          } catch (error) {
            this.deps.log("im card action failed", error);
            return { toast: { type: "error", text: `操作失败：${describe(error)}` } };
          }
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
    const files = this.transports.get(connection.id)?.download ? (message.files ?? []) : [];
    if ((message.unsupported && !files.length) || (!message.text && !files.length)) {
      this.reply(
        connection,
        message.chatId,
        files.length || message.files?.length
          ? "目前只支持文字、图片和文件。"
          : "目前只支持文字消息。",
        message.externalId,
      );
      return;
    }
    this.deps.store.touchInbound(connection.id, message.chatId);
    // 记下会话是私聊还是群：带房主登录票的链接只发到私聊
    this.deps.store.kvSet(connection.id, `chatType:${message.chatId}`, message.chatType);
    const text = message.text.trim();
    if (text.startsWith("/") && !files.length) {
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
    // 只回了一个数字：选上一条文字菜单里的那一项（没开卡片按钮的连接用）
    if (!files.length && /^\d{1,2}$/.test(text)) {
      if (this.pickFromTextMenu(connection, owner, message, Number(text))) return;
    }
    // 明确回复了提问卡片就是作答；否则按「回复了谁的卡片 → 简写 → 当前对话对象」决定发给谁
    const quoted = this.quotedQuestion(connection, message);
    let content = text;
    let routed = false;
    if (!quoted && text) {
      const route = this.route(connection, message, text);
      if (!route) return;
      content = route.content;
      routed = route.routed;
    }
    if (files.length) {
      void this.inboundWithFiles(connection, owner, message, content, files, clientMessageId);
      return;
    }
    let posted: ChatMessage;
    this.posting = connection.id;
    try {
      // 指定了对话对象时，没有引用提问的消息一律发给对象，不再猜是在回答哪个提问
      const question =
        quoted ??
        (routed || this.targetOf(connection)
          ? undefined
          : this.recentQuestion(connection, message, content));
      posted = question
        ? this.answer(owner, question, text, clientMessageId, connection.channel)
        : this.deps.post(owner, {
            content,
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
    this.afterInbound(connection, message, posted);
  }

  /** 带图片 / 文件的消息：先下载存成附件，再以房主身份发进房间 */
  private async inboundWithFiles(
    connection: StoredConnection,
    owner: Participant,
    message: ImInbound,
    text: string,
    files: NonNullable<ImInbound["files"]>,
    clientMessageId: string,
  ): Promise<void> {
    const transport = this.transports.get(connection.id);
    const downloaded: Array<{ name: string; data: Buffer }> = [];
    const failures: string[] = [];
    for (const file of files) {
      try {
        downloaded.push(await transport!.download!(message.externalId, file));
      } catch (error) {
        failures.push(
          `${file.name ?? (file.kind === "image" ? "图片" : "文件")}：${describe(error)}`,
        );
      }
    }
    if (!downloaded.length && !text) {
      this.reply(
        connection,
        message.chatId,
        `没能收下附件（${failures.join("；")}）。如果提示没有权限，请在网页上重新扫码连接飞书。`,
        message.externalId,
      );
      return;
    }
    let posted: ChatMessage;
    try {
      const attachments = downloaded.length ? await this.deps.saveFiles(owner, downloaded) : {};
      this.posting = connection.id;
      try {
        posted = this.deps.post(owner, {
          content: text,
          clientMessageId,
          via: { channel: connection.channel },
          ...attachments,
        });
      } finally {
        this.posting = undefined;
      }
    } catch (error) {
      this.reply(
        connection,
        message.chatId,
        `没能发进房间：${describe(error)}`,
        message.externalId,
      );
      return;
    }
    if (failures.length) {
      this.reply(
        connection,
        message.chatId,
        `有附件没能收下：${failures.join("；")}`,
        message.externalId,
      );
    }
    this.afterInbound(connection, message, posted);
  }

  /** 发进房间之后：记下来源；派了活的回一张进度卡片并标上「处理中」，否则提示用法 */
  private afterInbound(
    connection: StoredConnection,
    message: ImInbound,
    posted: ChatMessage,
  ): void {
    this.deps.store.link({
      messageId: posted.id,
      connectionId: connection.id,
      chatId: message.chatId,
      externalId: message.externalId,
      direction: "in",
    });
    const tasks = this.deps.invocationsFor(posted.id);
    if (tasks.length) {
      this.setReaction(connection, posted.id, "Typing");
      if (this.cardsEnabled(connection)) {
        const rich = this.taskRich(connection, posted, tasks);
        this.deps.store.enqueue({
          connectionId: connection.id,
          eventKey: `task:${posted.id}`,
          chatId: message.chatId,
          ...(connection.channel === "feishu" ? { replyToExternalId: message.externalId } : {}),
          text: rich.summary,
          rich,
        });
        this.schedulePump();
      }
      return;
    }
    if (posted.replyToMessageId) {
      // 回答了提问：标个「完成」
      this.setReaction(connection, posted.id, "DONE");
      return;
    }
    if (posted.mentions.length === 0) {
      this.reply(
        connection,
        message.chatId,
        `已发到房间「${this.roomName(connection.roomId)}」。要让 Agent 处理，请在消息里 @ 它；回复 /help 查看用法。`,
        message.externalId,
      );
    }
  }

  /** 这条 IM 消息是不是在回答 Agent 的提问：引用回复了推过来的提问，或没有 @ 任何人且会话里有在等的提问 */
  private quotedQuestion(
    connection: StoredConnection,
    message: ImInbound,
  ): ChatMessage | undefined {
    if (!message.replyToExternalId) return undefined;
    const id = this.deps.store.messageForExternal(connection.id, message.replyToExternalId);
    const quoted = id ? this.deps.getMessage(id) : undefined;
    return quoted?.kind === "question" && this.deps.isWaiting(quoted.id) ? quoted : undefined;
  }

  /** 没有引用、也没 @ 任何人：会话里最近一条还在等回答的提问 */
  private recentQuestion(
    connection: StoredConnection,
    message: ImInbound,
    text: string,
  ): ChatMessage | undefined {
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
        if (this.richCapable(connection)) {
          this.enqueueCard(
            connection,
            message.chatId,
            "help",
            message.externalId,
            this.helpCard(connection),
          );
          return;
        }
        return say(HELP);
      case "/status":
        return say(
          `${connection.label} 已连接到房间「${this.roomName(connection.roomId)}」，以 ${connection.ownerName} 的身份发言。`,
        );
      case "/room": {
        const target = args[0];
        if (!target) {
          if (this.cardsEnabled(connection)) {
            this.enqueueCard(
              connection,
              message.chatId,
              "room",
              message.externalId,
              this.roomPicker(connection),
            );
            return;
          }
          const rooms = this.memberRooms(connection);
          this.saveTextMenu(connection, { kind: "room", items: rooms.map((room) => room.id) });
          return say(
            [
              `当前房间：${this.roomName(connection.roomId)}`,
              ...rooms.map(
                (room, index) =>
                  `${index + 1}. ${room.name}${room.id === connection.roomId ? "（当前）" : ""}`,
              ),
              "回复编号切换，或 /room 房间ID",
            ].join("\n"),
          );
        }
        const failure = this.switchRoom(connection, target);
        return say(failure ?? this.roomSwitchedText(connection));
      }
      case "/to": {
        const arg = args.join(" ").trim();
        if (arg) {
          if (["off", "0", "无", "不指定"].includes(arg.toLowerCase())) {
            this.setTarget(connection, undefined);
            return say("已取消指定对话对象。");
          }
          const hits = matchAgents(
            arg.replace(/^@/, ""),
            this.agentNames(connection.roomId),
            "loose",
          );
          if (hits.length !== 1) {
            return say(
              hits.length
                ? `对上了多个：${hits.join("、")}，请写得更具体些。`
                : `房间里没有 ${arg}。`,
            );
          }
          this.setTarget(connection, hits[0]);
          return say(`之后不带 @ 的消息都发给 ${hits[0]}。`);
        }
        if (this.cardsEnabled(connection)) {
          this.enqueueCard(
            connection,
            message.chatId,
            "to",
            message.externalId,
            this.agentPicker(connection),
          );
          return;
        }
        const agents = this.agentNames(connection.roomId);
        this.saveTextMenu(connection, { kind: "target", items: agents });
        const current = this.targetOf(connection);
        return say(
          [
            `当前对话对象：${current ?? "未指定"}`,
            ...agents.map((agent, index) => `${index + 1}. ${agent}`),
            "0. 不指定",
            "回复编号选择，或 /to 名字（可简写）",
          ].join("\n"),
        );
      }
      case "/web": {
        if (message.chatType !== "p2p") {
          return say("登录链接只发到私聊：请在和机器人的私聊里发 /web。");
        }
        const url = this.cardUrl(connection, connection.roomId);
        if (!url) return say("这个服务没有配置网页地址。");
        if (this.richCapable(connection)) {
          this.enqueueCard(connection, message.chatId, "web", message.externalId, {
            title: "在网页上打开 Hive",
            subtitle: this.roomName(connection.roomId),
            tone: "reply",
            body: "点下面的按钮，在这台设备上以房主身份进入，不用填令牌。",
            note: "链接 24 小时内有效，过期后再发 /web 获取，只发给你本人；不要转发给别人。手机要和运行 Hive 的电脑在同一个网络里才能打开。",
            link: { label: "在网页打开", url },
            summary: "在网页上打开 Hive",
          });
          return;
        }
        return say(`在网页上打开（24 小时内有效，不要转发）：${url}`);
      }
      case "/who": {
        const agents = this.deps
          .participants(connection.roomId)
          .filter((participant) => participant.type === "agent");
        if (this.richCapable(connection)) {
          this.enqueueCard(
            connection,
            message.chatId,
            "who",
            message.externalId,
            this.whoCard(connection),
          );
          return;
        }
        if (!agents.length) return say("这个房间里还没有 Agent。");
        const icon = { online: "🟢 空闲", busy: "🔄 忙碌", offline: "⚪ 离线" } as const;
        return say(
          [
            `房间「${this.roomName(connection.roomId)}」里的 Agent：`,
            ...agents.map((agent) => `${icon[agent.status]}\u3000${agent.username}`),
          ].join("\n"),
        );
      }
      case "/level": {
        const target = args[0]?.toLowerCase() as ImDeliveryLevel | undefined;
        if (!target && this.richCapable(connection)) {
          this.enqueueCard(
            connection,
            message.chatId,
            "level",
            message.externalId,
            this.levelCard(connection),
          );
          return;
        }
        if (!target) {
          return say(
            [
              `当前推送档位：${LEVEL_TEXT[connection.level ?? "mine"]}`,
              "切换：/level mine | im | agents | all",
            ].join("\n"),
          );
        }
        if (!(target in LEVEL_TEXT)) return say("档位只能是 mine、im、agents 或 all。");
        this.deps.store.setLevel(connection.id, target);
        this.deps.onConnectionsChanged(connection.roomId);
        return say(`已切换为：${LEVEL_TEXT[target]}`);
      }
      case "/cards": {
        const on = args[0]?.toLowerCase() !== "off";
        if (!this.deps.drivers[connection.channel]?.richTextLength) {
          return say("这个渠道不支持卡片。");
        }
        this.deps.store.update(connection.id, {
          config: { ...connection.config, cardCallbacks: on ? "1" : "0" },
        });
        return say(
          on
            ? "已打开卡片按钮：之后的提问、提醒可以直接在卡片上点。需要飞书应用已开通卡片回调（card.action.trigger）和消息更新权限，否则点了没反应；重新扫码会自动开通。"
            : "已关闭卡片按钮，提问改回打字作答。",
        );
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

  /** 卡片按钮能回调、卡片能原地更新：扫码时申请了卡片回调（或用 /cards on 声明已在后台开通） */
  private cardsEnabled(connection: StoredConnection): boolean {
    return (
      Boolean(this.deps.drivers[connection.channel]?.richTextLength) &&
      connection.config.cardCallbacks === "1"
    );
  }

  /* ---------- 表情回应：处理中 → 完成 ---------- */

  /** 这些连接的应用没有表情权限，不再尝试 */
  private readonly noReactions = new Set<string>();

  private inboundExternalId(connection: StoredConnection, messageId: string): string | undefined {
    return this.deps.store
      .linksOf(messageId)
      .find((link) => link.connectionId === connection.id && link.direction === "in")?.externalId;
  }

  private setReaction(connection: StoredConnection, messageId: string, emoji: string): void {
    const transport = this.transports.get(connection.id);
    const externalId = this.inboundExternalId(connection, messageId);
    if (!transport?.react || !externalId || this.noReactions.has(connection.id)) return;
    void transport.react(externalId, emoji).then(
      (reactionId) => {
        if (reactionId) {
          this.deps.store.kvSet(connection.id, `reaction:${messageId}:${emoji}`, reactionId);
        }
      },
      (error: unknown) => {
        this.noReactions.add(connection.id);
        this.deps.log("im reaction failed（重新扫码可开通表情权限）", error);
      },
    );
  }

  private clearReaction(connection: StoredConnection, messageId: string, emoji: string): void {
    const transport = this.transports.get(connection.id);
    const externalId = this.inboundExternalId(connection, messageId);
    const key = `reaction:${messageId}:${emoji}`;
    const reactionId = this.deps.store.kvGet(connection.id, key);
    if (!transport?.unreact || !externalId || !reactionId) return;
    this.deps.store.kvDelete(connection.id, key);
    void transport.unreact(externalId, reactionId).catch(() => undefined);
  }

  /* ---------- 飞书派的任务：进度卡片 ---------- */

  private readonly taskTimers = new Map<string, NodeJS.Timeout>();

  private taskRich(
    connection: StoredConnection,
    message: ChatMessage,
    tasks: Invocation[],
  ): ImRich {
    const steps = tasks.map((task) => {
      const state: NonNullable<ImRich["steps"]>[number]["state"] =
        task.status === "queued"
          ? "queued"
          : task.status === "running" || task.status === "cancelling"
            ? "running"
            : task.status === "waiting_human"
              ? "waiting"
              : task.status === "completed"
                ? "done"
                : "failed";
      const reply = task.replyMessageId ? this.deps.getMessage(task.replyMessageId) : undefined;
      const detail =
        state === "queued"
          ? task.receivedAt
            ? "已送达，排队中"
            : "排队中"
          : state === "running"
            ? (task.progress ?? "执行中")
            : state === "waiting"
              ? "在等你回答"
              : state === "done"
                ? reply
                  ? `已回复 #${reply.seq}`
                  : "已完成"
                : (TASK_STATUS_TEXT[task.status] ?? task.status) +
                  (task.detail ? `：${oneLine(task.detail, 60)}` : "");
      return { label: task.agentName, state, detail };
    });
    const finished = steps.every((step) => step.state === "done" || step.state === "failed");
    const failed = steps.some((step) => step.state === "failed");
    const url = this.cardUrl(connection, message.roomId);
    return {
      title: `已派给 ${tasks.map((task) => task.agentName).join("、")}`,
      subtitle: `${this.roomName(message.roomId)} · #${message.seq}`,
      tone: "reply",
      tag: finished ? (failed ? "未全部完成" : "已完成") : "进行中",
      body: `> ${plain(oneLine(message.content, 120))}`,
      steps,
      ...(finished && !failed ? { resolved: { text: "已完成", ok: true } } : {}),
      note: finished ? "结果已单独发来" : "这张卡片会随进度自动更新",
      ...this.footerFor(connection),
      ...(this.cardsEnabled(connection) ? { actions: [SWITCH_TARGET_ACTION] } : {}),
      ...(url ? { link: { label: `在网页查看 #${message.seq}`, url } } : {}),
      summary: `已派给 ${tasks.map((task) => task.agentName).join("、")}`,
    };
  }

  /** 进度变化时更新卡片（同一张卡片 2 秒内最多改一次，结束状态立即改）并收尾表情 */
  private trackTask(connection: StoredConnection, invocation: Invocation): void {
    const messageId = invocation.messageId;
    if (!this.inboundExternalId(connection, messageId)) return;
    const message = this.deps.getMessage(messageId);
    if (!message) return;
    const tasks = this.deps.invocationsFor(messageId);
    const settled = (task: Invocation) =>
      ["completed", "failed", "cancelled", "timed_out", "blocked"].includes(task.status);
    if (tasks.length && tasks.every(settled)) {
      const finalKey = `reaction:${messageId}:final`;
      if (!this.deps.store.kvGet(connection.id, finalKey)) {
        this.deps.store.kvSet(connection.id, finalKey, "1");
        this.clearReaction(connection, messageId, "Typing");
        this.setReaction(
          connection,
          messageId,
          tasks.every((task) => task.status === "completed") ? "DONE" : "CrossMark",
        );
      }
    }
    if (!this.cardsEnabled(connection)) return;
    const key = `${connection.id}:${messageId}`;
    const flush = () => {
      this.taskTimers.delete(key);
      const delivery = this.deps.store.deliveryByKey(connection.id, `task:${messageId}`);
      if (!delivery) return;
      const rich = this.taskRich(connection, message, this.deps.invocationsFor(messageId));
      if (delivery.status === "pending") {
        this.deps.store.setRich(delivery.id, rich, rich.summary);
        return;
      }
      const transport = this.transports.get(connection.id);
      if (delivery.status !== "sent" || !delivery.externalId || !transport?.updateRich) return;
      this.deps.store.setRich(delivery.id, rich);
      void transport
        .updateRich(delivery.externalId, this.forChat(connection, delivery.chatId, rich))
        .catch((error: unknown) => {
          this.deps.log("im task card update failed", error);
        });
    };
    if (tasks.length && tasks.every(settled)) {
      clearTimeout(this.taskTimers.get(key));
      flush();
    } else if (!this.taskTimers.has(key)) {
      const timer = setTimeout(flush, TASK_CARD_THROTTLE_MS);
      timer.unref?.();
      this.taskTimers.set(key, timer);
    }
  }

  /* ---------- 发给谁：当前对话对象、简写、回复卡片 ---------- */

  private agentNames(roomId: string): string[] {
    return this.deps
      .participants(roomId)
      .filter((participant) => participant.type === "agent")
      .map((participant) => participant.username);
  }

  /** 这个连接在当前房间选定的对话对象（每个房间各记一个，一直有效直到手动更换） */
  private targetOf(connection: StoredConnection, roomId = connection.roomId): string | undefined {
    const name = this.deps.store.kvGet(connection.id, `target:${roomId}`);
    // 对象被移出房间就当没选
    return name && this.agentNames(roomId).includes(name) ? name : undefined;
  }

  private setTarget(connection: StoredConnection, agent: string | undefined): void {
    if (agent) this.deps.store.kvSet(connection.id, `target:${connection.roomId}`, agent);
    else this.deps.store.kvDelete(connection.id, `target:${connection.roomId}`);
  }

  /** 回复的是哪张卡片：Agent 的回复 / 提到你 → 它；进度卡片 → 这次派到的 Agent；提醒卡片 → 那个 Agent */
  private agentsOfCard(connection: StoredConnection, externalId: string): string[] {
    const agents = this.agentNames(connection.roomId);
    const messageId = this.deps.store.messageForExternal(connection.id, externalId);
    const message = messageId ? this.deps.getMessage(messageId) : undefined;
    if (message?.senderType === "agent" && message.kind !== "question") {
      return agents.includes(message.senderName) ? [message.senderName] : [];
    }
    const delivery = this.deps.store.deliveryByExternal(connection.id, externalId);
    if (delivery?.eventKey.startsWith("task:")) {
      const names = this.deps
        .invocationsFor(delivery.eventKey.slice("task:".length))
        .map((invocation) => invocation.agentName);
      return [...new Set(names)].filter((name) => agents.includes(name));
    }
    if (delivery?.check?.kind === "invocation") {
      const invocation = this.deps.getInvocation(delivery.check.id);
      return invocation && agents.includes(invocation.agentName) ? [invocation.agentName] : [];
    }
    return [];
  }

  /**
   * 决定这条消息发给谁，返回改写后的正文；简写对上多个 Agent 时先发一张选择卡片，返回 undefined。
   * routed=消息里的 @ 是这里补上的（不再按「最近的提问」猜它是在作答）。
   */
  private route(
    connection: StoredConnection,
    message: ImInbound,
    text: string,
  ): { content: string; routed: boolean } | undefined {
    const hasMention = /@[\p{L}\p{N}_.-]/u.test(text);
    if (message.replyToExternalId && !hasMention) {
      const names = this.agentsOfCard(connection, message.replyToExternalId);
      if (names.length) {
        return { content: `${names.map((name) => `@${name}`).join(" ")} ${text}`, routed: true };
      }
    }
    const alias = resolveAliases(text, this.agentNames(connection.roomId));
    if (alias.kind === "resolved") return { content: alias.content, routed: true };
    if (alias.kind === "ambiguous") {
      this.askWhichAgent(connection, message, text, alias.token, alias.candidates);
      return undefined;
    }
    const target = hasMention ? undefined : this.targetOf(connection);
    return target
      ? { content: `@${target} ${text}`, routed: true }
      : { content: text, routed: false };
  }

  /** 简写对上多个 Agent：记下原消息，让人点一个（或回编号） */
  private askWhichAgent(
    connection: StoredConnection,
    message: ImInbound,
    text: string,
    token: string,
    candidates: string[],
  ): void {
    const id = digest(`${connection.id}:${message.externalId}`).slice(0, 16);
    this.deps.store.kvSet(
      connection.id,
      `pending:${id}`,
      JSON.stringify({
        text,
        token,
        externalId: message.externalId,
        chatId: message.chatId,
        chatType: message.chatType,
        senderId: message.senderId,
      }),
    );
    const prompt = `「${token}」对上了 ${candidates.length} 个 Agent，发给谁？`;
    if (this.cardsEnabled(connection)) {
      this.enqueueCard(connection, message.chatId, `pick:${id}`, message.externalId, {
        title: prompt,
        subtitle: this.roomName(connection.roomId),
        tone: "question",
        tag: "选一个",
        body: `> ${plain(oneLine(text, 120))}`,
        actions: candidates.map((agent, index) => ({
          label: agent,
          value: { do: "pick", agent, id },
          style: index === 0 ? "primary" : "default",
        })),
        note: "点一下就带着这条消息发出",
        summary: prompt,
      });
      return;
    }
    this.saveTextMenu(connection, { kind: "pick", items: candidates, id });
    this.reply(
      connection,
      message.chatId,
      [
        prompt,
        ...candidates.map((agent, index) => `${index + 1}. ${agent}`),
        "回复编号即可发出",
      ].join("\n"),
      message.externalId,
    );
  }

  /** 把挂起的那条消息按选中的 Agent 发出 */
  private sendPending(
    connection: StoredConnection,
    owner: Participant,
    id: string,
    agent: string,
  ): { ok: true } | { ok: false; reason: string } {
    const raw = this.deps.store.kvGet(connection.id, `pending:${id}`);
    if (!raw) return { ok: false, reason: "这条消息已经发出过了" };
    if (!this.agentNames(connection.roomId).includes(agent)) {
      return { ok: false, reason: `房间里没有 ${agent}` };
    }
    const pending = JSON.parse(raw) as {
      text: string;
      token: string;
      externalId: string;
      chatId: string;
      chatType: "p2p" | "group";
      senderId: string;
    };
    let posted: ChatMessage;
    this.posting = connection.id;
    try {
      posted = this.deps.post(owner, {
        content: applyChoice(pending.text, pending.token, agent),
        // 与原消息直接发进房间时同一个幂等键：重复点击只发一次
        clientMessageId: `im-${digest(`${connection.id}:${pending.externalId}`)}`,
        via: { channel: connection.channel },
      });
    } catch (error) {
      return { ok: false, reason: describe(error) };
    } finally {
      this.posting = undefined;
    }
    this.deps.store.kvDelete(connection.id, `pending:${id}`);
    this.afterInbound(
      connection,
      {
        externalId: pending.externalId,
        chatId: pending.chatId,
        chatType: pending.chatType,
        senderId: pending.senderId,
        text: pending.text,
      },
      posted,
    );
    return { ok: true };
  }

  /* ---------- 选择卡片：对话对象、房间 ---------- */

  private agentPicker(connection: StoredConnection, title = "选择对话对象"): ImRich {
    const current = this.targetOf(connection);
    const agents = this.deps
      .participants(connection.roomId)
      .filter((participant) => participant.type === "agent");
    const state = { online: "空闲", busy: "忙碌", offline: "离线" } as const;
    return {
      title,
      subtitle: this.roomName(connection.roomId),
      tone: "reply",
      tag: `当前：${current ?? "未指定"}`,
      ...(agents.length ? {} : { body: "这个房间里还没有 Agent。" }),
      actions: [
        ...agents.map((agent) => ({
          label: `${agent.username} · ${state[agent.status]}`,
          value: { do: "target", agent: agent.username },
          style: agent.username === current ? ("primary" as const) : ("default" as const),
        })),
        {
          label: "不指定",
          value: { do: "target", agent: "" },
          style: current ? ("default" as const) : ("primary" as const),
        },
      ],
      note: "选好后直接打字就发给它（每个房间各记一个，一直有效）；临时找别人可以写 @简写，如 @codex",
      summary: `${title}：当前 ${current ?? "未指定"}`,
    };
  }

  private memberRooms(connection: StoredConnection): Array<{ id: string; name: string }> {
    return this.deps
      .listRoomIds()
      .filter((id) => this.deps.findParticipant(id, connection.ownerName)?.type === "human")
      .map((id) => ({ id, name: this.roomName(id) }));
  }

  private roomPicker(connection: StoredConnection): ImRich {
    const rooms = this.memberRooms(connection);
    return {
      title: "切换房间",
      subtitle: `当前：${this.roomName(connection.roomId)}`,
      tone: "reply",
      tag: `${rooms.length} 个房间`,
      actions: rooms.map((room) => {
        const online = this.deps
          .participants(room.id)
          .filter((participant) => participant.status !== "offline").length;
        const tasks = this.deps.roomTasks(room.id);
        const extra = [
          `${online} 人在线`,
          ...(tasks.running ? [`${tasks.running} 个进行中`] : []),
          ...(tasks.waiting ? [`${tasks.waiting} 个等你回答`] : []),
        ].join(" · ");
        return {
          label: `${room.id === connection.roomId ? "● " : ""}${room.name} · ${extra}`,
          value: { do: "room", room: room.id },
          style: room.id === connection.roomId ? ("primary" as const) : ("default" as const),
        };
      }),
      note: "点一下就切换；切过去会恢复你在那个房间选过的对话对象",
      summary: `切换房间：当前 ${this.roomName(connection.roomId)}`,
    };
  }

  /** 切换房间；返回失败原因 */
  private switchRoom(connection: StoredConnection, roomId: string): string | undefined {
    const room = this.deps.getRoom(roomId);
    if (!room || room.archivedAt) return `没有房间 ${roomId}。`;
    const member = this.deps.findParticipant(room.id, connection.ownerName);
    if (!member || member.type !== "human") {
      return `你还不是房间「${room.name}」的成员，请先在网页上进入一次。`;
    }
    const previous = connection.roomId;
    if (previous === room.id) return undefined;
    this.deps.store.update(connection.id, { roomId: room.id });
    this.deps.onConnectionsChanged(previous);
    this.deps.onConnectionsChanged(room.id);
    return undefined;
  }

  private enqueueCard(
    connection: StoredConnection,
    chatId: string,
    key: string,
    replyTo: string | undefined,
    rich: ImRich,
  ): void {
    this.deps.store.enqueue({
      connectionId: connection.id,
      eventKey: `ui:${key}:${randomUUID()}`,
      chatId,
      ...(replyTo && connection.channel === "feishu" && !replyTo.startsWith("menu:")
        ? { replyToExternalId: replyTo }
        : {}),
      text: rich.summary,
      rich,
    });
    this.schedulePump();
  }

  /* ---------- 文字菜单：没开卡片按钮的连接回编号 ---------- */

  private saveTextMenu(
    connection: StoredConnection,
    menu: { kind: "room" | "target" | "pick"; items: string[]; id?: string },
  ): void {
    this.deps.store.kvSet(connection.id, "menu", JSON.stringify({ ...menu, at: this.now() }));
  }

  private pickFromTextMenu(
    connection: StoredConnection,
    owner: Participant,
    message: ImInbound,
    index: number,
  ): boolean {
    const raw = this.deps.store.kvGet(connection.id, "menu");
    if (!raw) return false;
    const menu = JSON.parse(raw) as {
      kind: "room" | "target" | "pick";
      items: string[];
      id?: string;
      at: number;
    };
    if (this.now() - menu.at > TEXT_MENU_TTL_MS) return false;
    const item = index === 0 && menu.kind === "target" ? "" : menu.items[index - 1];
    if (item === undefined) return false;
    this.deps.store.kvDelete(connection.id, "menu");
    const say = (text: string) => this.reply(connection, message.chatId, text, message.externalId);
    if (menu.kind === "room") {
      const failure = this.switchRoom(connection, item);
      say(failure ?? this.roomSwitchedText(connection));
    } else if (menu.kind === "target") {
      this.setTarget(connection, item || undefined);
      say(item ? `之后不带 @ 的消息都发给 ${item}。` : "已取消指定对话对象。");
    } else {
      const result = this.sendPending(connection, owner, menu.id!, item);
      if (!result.ok) say(result.reason);
    }
    return true;
  }

  private roomSwitchedText(connection: StoredConnection): string {
    const current = this.deps.store.getConnection(connection.id) ?? connection;
    const target = this.targetOf(current);
    return `已切换到房间「${this.roomName(current.roomId)}」。${
      target ? `对话对象：${target}。` : "还没选对话对象，发 /to 选一个。"
    }`;
  }

  /** 发给房主本人的会话：私聊推送（user: 目标），或入站时记下的私聊 */
  private isPrivateChat(connection: StoredConnection, chatId: string): boolean {
    return (
      chatId.startsWith(USER_TARGET) ||
      this.deps.store.kvGet(connection.id, `chatType:${chatId}`) === "p2p"
    );
  }

  /** 发到群里的卡片去掉链接里的房主登录票：群里谁点都会以房主身份进入 */
  private forChat(connection: StoredConnection, chatId: string, rich: ImRich): ImRich {
    if (!rich.link || this.isPrivateChat(connection, chatId)) return rich;
    try {
      const url = new URL(rich.link.url);
      if (!url.searchParams.has("login")) return rich;
      url.searchParams.delete("login");
      return { ...rich, link: { ...rich.link, url: url.toString() } };
    } catch {
      return rich;
    }
  }

  /** 卡片按钮的网页地址：带登录票；发到群里时由 forChat 去掉 */
  private cardUrl(connection: StoredConnection, roomId: string): string | undefined {
    return this.deps.loginUrl?.(connection.id, roomId) ?? this.deps.webUrl(roomId);
  }

  /** 能发卡片（不要求按钮回调）：飞书都行，微信只能发文字 */
  private richCapable(connection: StoredConnection): boolean {
    return Boolean(this.deps.drivers[connection.channel]?.richTextLength);
  }

  /** 常用操作按钮（需要卡片回调） */
  private quickActions(connection: StoredConnection): Pick<ImRich, "actions"> {
    if (!this.cardsEnabled(connection)) return {};
    return {
      actions: [
        { label: "选对话对象", value: { do: "to" }, style: "primary" },
        { label: "切换房间", value: { do: "room" }, style: "default" },
        { label: "谁在忙", value: { do: "who" }, style: "default" },
        { label: "推送档位", value: { do: "level" }, style: "default" },
      ],
    };
  }

  private helpCard(connection: StoredConnection): ImRich {
    const target = this.targetOf(connection);
    const buttons = this.cardsEnabled(connection);
    return {
      title: "SuperHive 使用说明",
      subtitle: `当前：${this.roomName(connection.roomId)} → ${target ?? "未指定对话对象"}`,
      tone: "reply",
      tag: buttons ? "卡片按钮已开" : "文字模式",
      sections: [
        {
          title: "💬 发消息",
          body: [
            "- 直接发文字、图片、文件，以你的身份进入当前房间",
            `- ${target ? `没写 @ 的消息会发给 **${target}**` : "先选一个**对话对象**，之后不用再写 @"}`,
            "- 临时找别人：写简写，如 `@codex 看下`；对上多个会让你选",
            "- **引用回复**某个 Agent 的卡片，就是接着跟它说",
          ].join("\n"),
        },
        {
          title: "🙋 回答 Agent 的提问",
          body: buttons
            ? "- 在提问卡片上直接点选项；多选勾选后点「提交」\n- 也可以引用回复提问卡片打字"
            : "- 引用回复提问，写选项字母（多选用逗号隔开，如 `A,C`）或直接写答案",
        },
        {
          title: "⌨️ 命令",
          body: [
            "- `/to` 选对话对象，`/to codex` 直接指定，`/to off` 取消",
            "- `/room` 切换房间",
            "- `/who` 谁在忙",
            "- `/level` 推送档位",
            "- `/web` 在手机或其他电脑上打开网页（自动登录）",
            "- `/status` 连接状态",
            ...(buttons ? [] : ["- `/cards on` 在飞书后台开通卡片回调后打开按钮"]),
          ].join("\n"),
        },
        {
          title: "📌 机器人菜单（可选）",
          body: "飞书开发者后台 → 机器人 → 自定义菜单，菜单项选「推送事件」，事件 key 填 `to`、`room`、`who`、`level`、`help`",
        },
      ],
      ...(buttons ? {} : { note: "重新扫码连接飞书后，提问、提醒卡片上会出现可以点的按钮" }),
      ...this.quickActions(connection),
      summary: "SuperHive 使用说明",
    };
  }

  private whoCard(connection: StoredConnection): ImRich {
    const agents = this.deps
      .participants(connection.roomId)
      .filter((participant) => participant.type === "agent");
    const target = this.targetOf(connection);
    const order = { busy: 0, online: 1, offline: 2 } as const;
    const icon = { online: "🟢", busy: "🔄", offline: "⚪" } as const;
    const label = { online: "空闲", busy: "忙碌", offline: "离线" } as const;
    const busy = agents.filter((agent) => agent.status === "busy").length;
    return {
      title: "谁在忙",
      subtitle: this.roomName(connection.roomId),
      tone: "reply",
      tag: busy ? `${busy} 个忙碌` : "都空闲",
      body: agents.length
        ? [...agents]
            .sort(
              (a, b) => order[a.status] - order[b.status] || a.username.localeCompare(b.username),
            )
            .map(
              (agent) =>
                // 正文会转义尖括号，这里只用 Markdown，不用 <font>
                `${icon[agent.status]} **${agent.username}**\u3000${label[agent.status]}${
                  agent.username === target ? " · 当前对话对象" : ""
                }`,
            )
            .join("\n")
        : "这个房间里还没有 Agent。",
      ...(this.cardsEnabled(connection)
        ? { actions: [{ label: "选对话对象", value: { do: "to" }, style: "primary" as const }] }
        : {}),
      summary: `谁在忙：${busy} 个忙碌`,
    };
  }

  private levelCard(connection: StoredConnection): ImRich {
    const current = connection.level ?? "mine";
    const names: Record<ImDeliveryLevel, string> = {
      mine: "与我相关",
      im: "仅 IM 发起",
      agents: "全部 Agent 消息",
      all: "全部消息",
    };
    const levels = Object.keys(names) as ImDeliveryLevel[];
    return {
      title: "推送档位",
      subtitle: this.roomName(connection.roomId),
      tone: "reply",
      tag: `当前：${names[current]}`,
      body: levels
        .map(
          (level) =>
            `${level === current ? "✅" : "▫️"} **${names[level]}**\n${LEVEL_TEXT[level].split("：").slice(1).join("：")}`,
        )
        .join("\n"),
      ...(this.cardsEnabled(connection)
        ? {
            actions: levels.map((level) => ({
              label: names[level],
              value: { do: "level", level },
              style: level === current ? ("primary" as const) : ("default" as const),
            })),
          }
        : { note: "切换：/level mine | im | agents | all" }),
      summary: `推送档位：${names[current]}`,
    };
  }

  /** 回复、进度卡片底部：当前发给谁，旁边一个「切换」 */
  private footerFor(connection: StoredConnection): Pick<ImRich, "footer"> {
    if (!this.cardsEnabled(connection)) return {};
    return {
      footer: `当前：${this.roomName(connection.roomId)} → ${this.targetOf(connection) ?? "未指定"}`,
    };
  }

  /* ---------- 卡片交互 ---------- */

  /** 已发出的提醒卡片：调用之后被重试、忽略、恢复或完成，就把卡片改成已处理、去掉按钮 */
  private settleNotices(connection: StoredConnection, invocation: Invocation): void {
    const transport = this.transports.get(connection.id);
    if (!transport?.updateRich || !this.cardsEnabled(connection)) return;
    for (const delivery of this.deps.store.sentInvocationNotices(connection.id, invocation.id)) {
      const check = delivery.check;
      if (!delivery.rich || delivery.rich.resolved || check?.kind !== "invocation") continue;
      if (
        !invocation.resolution &&
        invocation.status === check.status &&
        invocation.attempts === check.attempts
      ) {
        continue;
      }
      const rich: ImRich = {
        ...delivery.rich,
        resolved: settledLabel(invocation),
      };
      this.deps.store.setRich(delivery.id, rich);
      void transport
        .updateRich(delivery.externalId!, this.forChat(connection, delivery.chatId, rich))
        .catch((error: unknown) => {
          this.deps.log("im notice card update failed", error);
        });
    }
  }

  /** 提问被回答（网页点选、手打回复、另一个 IM）：把已推出去的提问卡片改成已回答 */
  private settleQuestion(connection: StoredConnection, answer: ChatMessage): void {
    const questionId = answer.answer?.questionMessageId ?? answer.replyToMessageId;
    const question = questionId ? this.deps.getMessage(questionId) : undefined;
    if (question?.kind !== "question") return;
    const transport = this.transports.get(connection.id);
    if (!transport?.updateRich || !this.cardsEnabled(connection)) return;
    const link = this.deps.store
      .linksOf(question.id)
      .find((item) => item.connectionId === connection.id && item.direction === "out");
    if (!link?.externalId) return;
    const rich = this.forChat(
      connection,
      link.chatId,
      this.answeredQuestion(connection, question, answer),
    );
    void transport.updateRich(link.externalId, rich).catch((error: unknown) => {
      this.deps.log("im question card update failed", error);
    });
  }

  private answeredQuestion(
    connection: StoredConnection,
    question: ChatMessage,
    answer: ChatMessage | { selected: string[]; other?: string; by: string },
  ): ImRich {
    const driver = this.deps.drivers[connection.channel];
    const base = this.richMessage(connection, question, driver?.richTextLength ?? 4000);
    const selected = "selected" in answer ? answer.selected : (answer.answer?.selected ?? []);
    const text =
      "selected" in answer
        ? [
            ...selected.map(
              (key) =>
                `${key}：${question.question?.options.find((item) => item.key === key)?.label ?? ""}`,
            ),
            ...(answer.other ? [`其它：${answer.other}`] : []),
          ].join("；")
        : plain(oneLine(answer.content, 200));
    const by = "selected" in answer ? answer.by : answer.senderName;
    return {
      ...base,
      selected,
      resolved: { text: "已回答", ok: true },
      note: `${by} 的回答：${text}`,
    };
  }

  /** 人在卡片上点了按钮：校验是房主本人，再走与网页相同的操作；返回即时提示与更新后的卡片 */
  private handleAction(connectionId: string, action: ImAction): ImActionResult | undefined {
    const result = this.handleActionInner(connectionId, action);
    const connection = this.deps.store.getConnection(connectionId);
    if (!result?.rich || !connection) return result;
    // 被点的卡片发在哪个会话：按推送记录找（私聊推送的目标是 user:），找不到按回调里的会话
    const chatId =
      this.deps.store.deliveryByExternal(connection.id, action.externalId)?.chatId ??
      this.deps.store
        .linksOf(this.deps.store.messageForExternal(connection.id, action.externalId) ?? "")
        .find((link) => link.connectionId === connection.id)?.chatId ??
      action.chatId;
    return { ...result, rich: this.forChat(connection, chatId, result.rich) };
  }

  private handleActionInner(connectionId: string, action: ImAction): ImActionResult | undefined {
    const connection = this.deps.store.getConnection(connectionId);
    if (!connection || connection.status === "paused") {
      return { toast: { type: "warning", text: "这个连接已暂停" } };
    }
    if (action.operatorId !== connection.ownerActorId) {
      return { toast: { type: "error", text: "只有房主本人可以操作" } };
    }
    const owner = this.ownerOf(connection);
    if (!owner) {
      return { toast: { type: "error", text: `在房间里找不到成员 ${connection.ownerName}` } };
    }
    const op = action.value.do;
    if (op === "answer" || op === "answer_form")
      return this.answerFromCard(connection, owner, action);
    if (op === "retry" || op === "dismiss" || op === "continue") {
      return this.invocationFromCard(connection, owner, action, op);
    }
    if (op === "target") {
      const agent = action.value.agent ?? "";
      if (agent && !this.agentNames(connection.roomId).includes(agent)) {
        return { toast: { type: "error", text: `房间里没有 ${agent}` } };
      }
      this.setTarget(connection, agent || undefined);
      return {
        toast: { type: "success", text: agent ? `之后直接打字就发给 ${agent}` : "已取消指定" },
        rich: this.agentPicker(connection),
      };
    }
    if (op === "room" && !action.value.room) {
      this.enqueueCard(connection, action.chatId, "room", undefined, this.roomPicker(connection));
      return { toast: { type: "info", text: "已发来房间卡片" } };
    }
    if (op === "who") {
      this.enqueueCard(connection, action.chatId, "who", undefined, this.whoCard(connection));
      return { toast: { type: "info", text: "已发来成员状态" } };
    }
    if (op === "level") {
      const level = action.value.level as ImDeliveryLevel | undefined;
      if (!level) {
        this.enqueueCard(connection, action.chatId, "level", undefined, this.levelCard(connection));
        return { toast: { type: "info", text: "已发来推送档位" } };
      }
      if (!(level in LEVEL_TEXT)) return { toast: { type: "error", text: "没有这个档位" } };
      this.deps.store.setLevel(connection.id, level);
      this.deps.onConnectionsChanged(connection.roomId);
      const current = this.deps.store.getConnection(connection.id) ?? connection;
      return { toast: { type: "success", text: "已切换推送档位" }, rich: this.levelCard(current) };
    }
    if (op === "room") {
      const failure = this.switchRoom(connection, action.value.room ?? "");
      if (failure) return { toast: { type: "error", text: failure } };
      const current = this.deps.store.getConnection(connection.id) ?? connection;
      return {
        toast: { type: "success", text: `已切换到 ${this.roomName(current.roomId)}` },
        // 卡片原地变成新房间的对象选择
        rich: this.agentPicker(current, `已切换到 ${this.roomName(current.roomId)}`),
      };
    }
    if (op === "to") {
      this.enqueueCard(connection, action.chatId, "to", undefined, this.agentPicker(connection));
      return { toast: { type: "info", text: "已发来选择卡片" } };
    }
    if (op === "pick") {
      const delivery = this.deps.store.deliveryByExternal(connection.id, action.externalId);
      const result = this.sendPending(
        connection,
        owner,
        action.value.id ?? "",
        action.value.agent ?? "",
      );
      const base = delivery?.rich;
      if (!result.ok) {
        return {
          toast: { type: "info", text: result.reason },
          ...(base ? { rich: { ...base, resolved: { text: "已处理", ok: false } } } : {}),
        };
      }
      const rich: ImRich | undefined = base
        ? { ...base, resolved: { text: `已发给 ${action.value.agent}`, ok: true } }
        : undefined;
      if (delivery && rich) this.deps.store.setRich(delivery.id, rich);
      return { toast: { type: "success", text: "已发出" }, ...(rich ? { rich } : {}) };
    }
    return undefined;
  }

  private answerFromCard(
    connection: StoredConnection,
    owner: Participant,
    action: ImAction,
  ): ImActionResult {
    const questionId = this.deps.store.messageForExternal(connection.id, action.externalId);
    const question = questionId ? this.deps.getMessage(questionId) : undefined;
    if (question?.kind !== "question") {
      return { toast: { type: "error", text: "找不到这条提问" } };
    }
    if (!this.deps.isWaiting(question.id)) {
      const driver = this.deps.drivers[connection.channel];
      return {
        toast: { type: "info", text: "这个问题已经回答过了" },
        rich: {
          ...this.richMessage(connection, question, driver?.richTextLength ?? 4000),
          resolved: { text: "已结束", ok: false },
        },
      };
    }
    const form = action.form ?? {};
    const keys =
      action.value.do === "answer"
        ? [action.value.key ?? ""]
        : Object.entries(form)
            .filter(
              ([name, value]) =>
                name.startsWith(OPTION_FIELD_PREFIX) && (value === true || value === "true"),
            )
            .map(([name]) => name.slice(OPTION_FIELD_PREFIX.length));
    const other = typeof form[OTHER_FIELD] === "string" ? form[OTHER_FIELD].trim() : "";
    const picked = keys.filter(Boolean);
    if (!picked.length && !other) {
      return { toast: { type: "warning", text: "请先选一个选项，或填写其它答案" } };
    }
    const clientMessageId = `im-card-${digest(
      `${connection.id}:${action.externalId}:${picked.join(",")}:${other}`,
    )}`;
    this.posting = connection.id;
    this.answeringFromCard = connection.id;
    try {
      if (question.question) {
        this.deps.choose(owner, question.id, picked, clientMessageId, other || undefined);
      } else {
        this.deps.post(owner, {
          content: other,
          clientMessageId,
          replyToMessageId: question.id,
          via: { channel: connection.channel },
        });
      }
    } catch (error) {
      return { toast: { type: "error", text: describe(error) } };
    } finally {
      this.posting = undefined;
      this.answeringFromCard = undefined;
    }
    return {
      toast: { type: "success", text: "已提交" },
      rich: this.answeredQuestion(connection, question, {
        selected: picked,
        ...(other ? { other } : {}),
        by: owner.username,
      }),
    };
  }

  private invocationFromCard(
    connection: StoredConnection,
    owner: Participant,
    action: ImAction,
    op: "retry" | "dismiss" | "continue",
  ): ImActionResult {
    const delivery = this.deps.store.deliveryByExternal(connection.id, action.externalId);
    const check = delivery?.check;
    if (!delivery?.rich || check?.kind !== "invocation") {
      return { toast: { type: "error", text: "找不到这条任务" } };
    }
    // 已处理过（重复点击、飞书超时重投同一回调，或已在网页上处理）：不再执行，
    // 尤其「继续」每执行一次都会再追加轮数
    if (delivery.rich.resolved) {
      return { toast: { type: "info", text: "这条任务已经处理过了" }, rich: delivery.rich };
    }
    const label =
      op === "dismiss"
        ? "已忽略"
        : op === "continue"
          ? `已追加 ${BUDGET_EXTEND_TURNS} 轮`
          : delivery.rich.tone === "approval"
            ? "已批准"
            : "已重试";
    try {
      if (op === "retry") this.deps.retry(owner, check.id);
      else if (op === "dismiss") this.deps.dismiss(owner, check.id);
      else this.deps.extendBudget(owner, BUDGET_EXTEND_TURNS);
    } catch (error) {
      return { toast: { type: "error", text: describe(error) } };
    }
    const rich: ImRich = {
      ...delivery.rich,
      resolved: { text: label, ok: op !== "dismiss" },
      note: `${owner.username} 在飞书上${label.replace(/^已/, "")}`,
    };
    this.deps.store.setRich(delivery.id, rich);
    return { toast: { type: "success", text: label }, rich };
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
      ...(driver?.richTextLength
        ? { rich: this.richMessage(connection, message, driver.richTextLength) }
        : {}),
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
      // 提问被回答了：推出去的提问卡片改成已回答（卡片上点的由回调自己更新）
      if (
        (message.answer || message.replyToMessageId) &&
        message.senderType === "human" &&
        this.answeringFromCard !== connection.id
      ) {
        this.settleQuestion(connection, message);
      }
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
      if (connection.status === "paused") continue;
      // 飞书派的任务：进度卡片、处理中/完成表情；已发出的提醒卡片随状态改成已处理
      this.trackTask(connection, invocation);
      this.settleNotices(connection, invocation);
      if (connection.level === "im") continue;
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
      const rich = driver?.richTextLength
        ? this.richNotice(connection, invocation, trigger, this.cardsEnabled(connection))
        : undefined;
      this.deps.store.enqueue({
        connectionId: connection.id,
        eventKey: `inv:${invocation.id}:${invocation.attempts}:${invocation.status}`,
        ...this.target(connection, origin),
        ...(rich ? { rich } : {}),
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

  /** 调用状态提醒的卡片：失败、结果未知、被拦下、等批准 */
  private richNotice(
    connection: StoredConnection,
    invocation: Invocation,
    trigger: ChatMessage | undefined,
    interactive: boolean,
  ): ImRich | undefined {
    const ref = trigger ? `#${trigger.seq}` : "这条任务";
    const detail = invocation.detail ? invocation.detail.replace(/\s+/g, " ").trim() : "";
    const agent = invocation.agentName;
    const url = this.cardUrl(connection, invocation.roomId);
    const subtitle = `${this.roomName(invocation.roomId)}${trigger ? ` · #${trigger.seq}` : ""}`;
    const quote = trigger ? `> ${plain(oneLine(trigger.content, 120))}` : "";
    const act = (
      ...items: Array<[string, string, "primary" | "default" | "danger"]>
    ): Pick<ImRich, "actions"> =>
      interactive
        ? { actions: items.map(([label, op, style]) => ({ label, value: { do: op }, style })) }
        : {};
    const ignore: [string, string, "default"] = ["忽略", "dismiss", "default"];
    const base = (rich: Omit<ImRich, "subtitle" | "link" | "summary">): ImRich => ({
      ...rich,
      subtitle,
      summary: `${rich.title}${detail ? `：${detail}` : ""}`,
      ...(url ? { link: { label: `到网页处理 ${ref}`, url } } : {}),
    });
    switch (invocation.status) {
      case "failed":
        return base({
          title: `${agent} 处理失败`,
          tone: "danger",
          tag: "失败",
          body: [quote, detail ? `**原因**：${plain(detail)}` : ""].filter(Boolean).join("\n\n"),
          note: interactive ? "可以直接重试，或到网页看详情" : `可以到网页查看详情，或重试 ${ref}`,
          ...act(["重试", "retry", "primary"], ignore),
        });
      case "timed_out":
        return base({
          title: `${agent} 结果未知`,
          tone: "warning",
          tag: "结果未知",
          body: quote,
          note: "长时间没有进展，不代表失败；到网页确认后再决定是否重试",
          ...act(ignore),
        });
      case "blocked":
        return invocation.blockReason === "guest_approval"
          ? base({
              title: `访客的任务等你批准`,
              tone: "approval",
              tag: "待批准",
              body: [`**${plain(invocation.requesterName)}**（访客）请 **${agent}** 处理：`, quote]
                .filter(Boolean)
                .join("\n\n"),
              note: interactive ? "批准后才会派发" : "到网页点「批准」后才会派发",
              ...act(["批准", "retry", "primary"], ignore),
            })
          : base({
              title: `${agent} 已暂停`,
              tone: "warning",
              tag: "已暂停",
              body: [quote, `**原因**：${plain(detail || "Agent 对话轮数到了上限")}`]
                .filter(Boolean)
                .join("\n\n"),
              note: interactive ? `点「继续」再给 ${BUDGET_EXTEND_TURNS} 轮` : "到网页点「继续」",
              ...act(["继续", "continue", "primary"], ignore),
            });
      default:
        return undefined;
    }
  }

  /** 房间消息的卡片：Agent 回复、@ 房主、提问（选项单独列出） */
  private richMessage(connection: StoredConnection, message: ChatMessage, limit: number): ImRich {
    const sender = message.senderName;
    const url = this.cardUrl(connection, message.roomId);
    let body = plain(message.content);
    let options: ImRich["options"];
    let note: string | undefined;
    if (message.kind === "question") {
      // 正文开头是「@提问对象 ❓ 问题」，后面跟（单选）和逐行选项、作答提示：卡片里分开展示
      const lines = body.split("\n");
      const marker = lines.findIndex((line) => /^（(单选|可多选)）$/u.test(line.trim()));
      body = (marker >= 0 ? lines.slice(0, marker) : lines)
        .join("\n")
        .replace(/^(＠\S+\s+)?❓\s*/u, "")
        .replace(/\s*（(点选选项|回复这条消息)[^）]*）\s*$/u, "")
        .trim();
      if (message.question) {
        options = message.question.options.map((option) => ({
          key: option.key,
          label: plain(option.label),
        }));
      }
      note = this.cardsEnabled(connection)
        ? "直接点选作答；也可以回复这张卡片打字"
        : message.question
          ? message.question.multiple
            ? "回复这张卡片作答：选项字母，多选用逗号隔开（如 A,C）；也可以直接回复文字"
            : "回复这张卡片作答：选项字母（如 A）；也可以直接回复文字"
          : "回复这张卡片作答";
    }
    if (body.length > limit) {
      body = `${body.slice(0, limit)}…`;
      note = [note, `正文太长已截断，全文见网页 #${message.seq}`].filter(Boolean).join("；");
    }
    const mentioned = this.mentionsOwner(message, connection);
    const question = message.kind === "question";
    const title = question
      ? `${sender} 有问题问你`
      : message.senderType === "human"
        ? `${sender} 的消息`
        : mentioned
          ? `${sender} 提到了你`
          : `${sender} 的回复`;
    const attachments = (message.attachments ?? []).map((item) => ({
      name: item.name,
      size: formatSize(item.size),
    }));
    return {
      title,
      subtitle: `${this.roomName(message.roomId)} · #${message.seq}`,
      tone: question ? "question" : mentioned ? "mention" : "reply",
      ...(question
        ? { tag: message.question ? (message.question.multiple ? "多选" : "单选") : "待回答" }
        : {}),
      ...(body ? { body } : {}),
      ...(options ? { options } : {}),
      ...(question && this.cardsEnabled(connection)
        ? { choice: { multiple: Boolean(message.question?.multiple) } }
        : {}),
      ...(!question && message.senderType === "agent" && this.cardsEnabled(connection)
        ? { ...this.footerFor(connection), actions: [SWITCH_TARGET_ACTION] }
        : {}),
      ...(note ? { note } : {}),
      ...(attachments.length ? { attachments } : {}),
      ...(url ? { link: { label: `在网页查看 #${message.seq}`, url } } : {}),
      summary: `${sender}：${oneLine(body || attachments[0]?.name || "", 60)}`,
    };
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
        await this.sendItems([item]);
      }
      for (const items of batches.values()) {
        const oldest = Date.parse(items[0]!.createdAt ?? new Date(this.now()).toISOString());
        if (this.now() - oldest < DIGEST_WINDOW_MS) continue;
        const connection = this.deps.store.getConnection(items[0]!.connectionId);
        const driver = connection ? this.deps.drivers[connection.channel] : undefined;
        const limit =
          (items.every((item) => item.rich) ? driver?.richTextLength : undefined) ??
          driver?.maxTextLength ??
          1800;
        for (const group of chunk(items, limit)) await this.sendItems(group);
      }
    } finally {
      this.pumping = false;
    }
  }

  /** 把消息的附件以图片或文件发到同一会话，回复在卡片下面；失败只记日志（卡片里有名字和网页入口） */
  private async forwardFiles(
    transport: ImTransport,
    item: OutboxItem,
    cardExternalId: string | undefined,
  ): Promise<void> {
    if (!transport.sendFile) return;
    const message = this.deps.getMessage(item.messageId!);
    for (const attachment of (message?.attachments ?? []).slice(0, MAX_FORWARDED_FILES)) {
      if (attachment.size > MAX_FORWARDED_FILE_BYTES) continue;
      try {
        const file = await this.deps.readAttachment(attachment.id);
        if (!file) continue;
        await transport.sendFile(
          item.chatId,
          {
            name: file.name,
            mime: file.mime,
            // 飞书图片上限 10 MB，超了按文件发
            kind: file.kind === "image" && file.data.length <= 10 * 1024 * 1024 ? "image" : "file",
            data: file.data,
          },
          cardExternalId ?? item.replyToExternalId,
        );
      } catch (error) {
        this.deps.log("im file forward failed（重新扫码可开通文件权限）", error);
        return;
      }
    }
  }

  /** 一条或多条（合并推送）一起发：有卡片版本就发卡片，否则发纯文本 */
  private async sendItems(items: OutboxItem[]): Promise<void> {
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
    const text = live.map((item) => item.text).join("\n\n———\n\n");
    const rich = live.every((item) => item.rich)
      ? this.forChat(connection, first.chatId, combineRich(live.map((item) => item.rich!)))
      : undefined;
    try {
      const externalId =
        rich && transport.sendRich
          ? await transport.sendRich(first.chatId, rich, text, first.replyToExternalId)
          : await transport.sendText(first.chatId, text, first.replyToExternalId);
      for (const item of live) {
        this.deps.store.markSent(item.id, externalId);
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
      // 单条推送带的附件：图片、文件真的发过去（合并推送里只列名字）
      if (live.length === 1 && first.messageId && !first.eventKey.startsWith("task:")) {
        void this.forwardFiles(transport, first, externalId);
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
const MAX_FORWARDED_FILES = 5;
const MAX_FORWARDED_FILE_BYTES = 20 * 1024 * 1024;
const SWITCH_TARGET_ACTION = {
  label: "切换对象",
  value: { do: "to" },
  style: "default" as const,
};
/** 文字编号菜单的有效期 */
const TEXT_MENU_TTL_MS = 10 * 60_000;
/** 进度卡片 2 秒内最多改一次，避免频繁调接口 */
const TASK_CARD_THROTTLE_MS = 2_000;
/** 卡片上「继续」追加的对话轮数（与网页一致） */
const BUDGET_EXTEND_TURNS = 10;
const TASK_STATUS_TEXT: Record<string, string> = {
  failed: "失败",
  timed_out: "结果未知",
  cancelled: "已停止",
  blocked: "已暂停",
};

/** 提醒卡片被别处处理后的结论 */
function settledLabel(invocation: Invocation): { text: string; ok: boolean } {
  if (invocation.resolution) return { text: "已忽略", ok: false };
  switch (invocation.status) {
    case "queued":
    case "running":
      return { text: "已重新开始", ok: true };
    case "completed":
      return { text: "已完成", ok: true };
    case "cancelled":
      return { text: "已停止", ok: false };
    case "waiting_human":
      return { text: "在等你回答", ok: true };
    default:
      return { text: "状态已变化", ok: false };
  }
}

function oneLine(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

/** 合并推送：多条卡片合成一张，每条一节 */
function combineRich(items: ImRich[]): ImRich {
  if (items.length === 1) return items[0]!;
  const subtitles = [
    ...new Set(items.map((item) => item.subtitle?.split(" · ")[0]).filter(Boolean)),
  ];
  const link = items.find((item) => item.link)?.link;
  return {
    title: `${items.length} 条新消息`,
    ...(subtitles.length ? { subtitle: subtitles.join("、") } : {}),
    tone: "digest",
    sections: items.map((item) => ({
      title: item.title,
      ...(item.subtitle ? { subtitle: item.subtitle } : {}),
      body: [
        item.body ?? "",
        ...(item.options ?? []).map((option) => `**${option.key}**\u3000${option.label}`),
        ...(item.attachments ?? []).map((file) => `📎 ${file.name}（${file.size}）`),
      ]
        .filter(Boolean)
        .join("\n"),
    })),
    ...(link ? { link: { label: "在网页查看", url: link.url } } : {}),
    summary: items.map((item) => item.summary).join("；"),
  };
}

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
