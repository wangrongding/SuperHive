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
  ServerText,
  WireServerText,
} from "@superhive/protocol";
import { renderServerText, serverText, zhText } from "@superhive/protocol";
import { HiveError, type CreateMessageInput } from "../database.js";
import type { WorktreeCleanupBatch } from "../worktrees.js";
import {
  publicConnection,
  type ImStore,
  type OutboxCheck,
  type OutboxItem,
  type StoredConnection,
} from "./im-store.js";
import { OPTION_FIELD_PREFIX, OTHER_FIELD } from "./feishu-card.js";
import { applyChoice, matchAgents, resolveAliases } from "./im-routing.js";
import { decideImDelivery } from "./im-policy.js";
import {
  imLocaleOf,
  imText,
  parseImLocale,
  type ImLocale,
  renderImMessage,
  type ImMessage,
  type ImTextKey,
  type ImTextParams,
} from "./im-texts.js";
import type { ImScope } from "@superhive/protocol";
import {
  USER_TARGET,
  type ImChannelDriver,
  type ImInbound,
  type ImAction,
  type ImActionResult,
  type ImKeyValue,
  type ImRich,
  type ImTransport,
  ImTextError,
} from "./types.js";

export type ImHubDeps = {
  requestWorktreeCleanup?: (batchId: string, ownerName: string) => boolean;
  store: ImStore;
  drivers: Partial<Record<ImChannel, ImChannelDriver>>;
  getRoom(
    roomId: string,
  ): { id: string; name: string; archivedAt?: string | undefined } | undefined;
  listRoomIds(): string[];
  findParticipant(roomId: string, username: string): Participant | undefined;
  /** 这个成员是不是经邀请链接进来的访客（同名不等于房主本人） */
  isGuest?(participant: Participant): boolean;
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
  /** 卡片上的「停止」：与网页上的停止同一套校验 */
  cancel(owner: Participant, invocationId: string): void;
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
  /**
   * 卡片上批准或拒绝其他设备管理 Server 所在电脑；实现方核对这个连接和操作人是否登记为可批准。
   * 返回给点按钮的人看的结果
   */
  decideHostApproval?(
    connectionId: string,
    actorId: string,
    approvalId: string,
    allow: boolean,
  ): { ok: boolean; key: ImTextKey };
  /** 由本机房主发起的扫码：连接建好后登记为可批准其他设备管理这台电脑 */
  markHostApprover?(connectionId: string, actorId: string): void;
  log(message: string, detail?: unknown): void;
  now?: () => number;
};

type LoginSession = {
  view: ImLoginView;
  abort: AbortController;
  codeWaiter?: ((code: string) => void) | undefined;
  ownerName: string;
  /** 本机房主发起的扫码 */
  hostApprover?: boolean;
  /** 新连接的语言：房主发起扫码时网页的语言 */
  locale?: ImLocale;
};

const MAX_ATTEMPTS = 8;
/** 推送暂停期间，待发的往后放这么久（收到你的消息就立刻补发，不用等到点） */
const HELD_POSTPONE_MS = 7 * 24 * 60 * 60_000;
/** 连接报错时说明「要重新扫码」的那几种 */
const RELOGIN_KEYS = new Set(["error.im.wechatExpired", "error.im.wechatSignedOut"]);
/** 「全部 Agent 消息」档的合并窗口 */
export const DIGEST_WINDOW_MS = 3 * 60_000;
const LOGIN_TTL_MS = 10 * 60_000;
const LEVELS: readonly ImDeliveryLevel[] = ["mine", "im", "agents", "all"];

function levelName(locale: ImLocale, level: ImDeliveryLevel): string {
  return imText(locale, `im.level.${level}.name`);
}

/** 档位的完整说明，如「与我相关（默认）：给你的最终结果……」 */
function levelText(locale: ImLocale, level: ImDeliveryLevel): string {
  return imText(locale, "im.level.full", {
    name: `${levelName(locale, level)}${level === "mine" ? imText(locale, "im.level.default") : ""}`,
    desc: imText(locale, `im.level.${level}.desc`),
  });
}

function describe(error: unknown, locale: ImLocale = "zh-CN"): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const value = error as { message?: unknown; msg?: unknown; code?: unknown };
    const text = value.message ?? value.msg;
    if (typeof text === "string" && text) return text;
    if (value.code !== undefined)
      return imText(locale, "im.error.code", { code: String(value.code) });
  }
  return String(error);
}

/** 错误的结构化文案（服务端自己的提示）；平台、网络原样返回的错误没有 */
function errorTextOf(error: unknown): ServerText | undefined {
  if (error instanceof ImTextError) return error.text;
  if (error instanceof HiveError) return error.text;
  return undefined;
}

/** 扫码会话的失败原因：中文给旧网页，errorText 给网页按语言显示 */
function loginError(error: unknown): Pick<ImLoginView, "error" | "errorText"> {
  const text = errorTextOf(error);
  return { error: describe(error), ...(text ? { errorText: text } : {}) };
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

  /** 这个连接用的语言：扫码时跟随房主网页的语言，之后用 /lang 或控制面板切换 */
  private localeOf(connection: StoredConnection): ImLocale {
    return imLocaleOf(connection.config.locale);
  }

  private t(connection: StoredConnection, key: ImTextKey, params?: ImTextParams): string {
    return imText(this.localeOf(connection), key, params);
  }

  /** 服务端给的结构化文案（调用状态说明、代发的系统消息）按连接的语言渲染；没有或不认识时用中文原文 */
  private serverText(
    connection: StoredConnection,
    text: WireServerText | undefined,
    fallback: string,
  ): string {
    return renderServerText(text, this.localeOf(connection)) ?? fallback;
  }

  /**
   * 推到 IM 的正文：服务端代发的消息（回执、定时任务……）有结构化文案时按连接语言渲染；
   * 提问的问题和选项是 Agent 写的，仍从原文里取（再按连接语言重排提示），人和 Agent 写的照原文
   */
  private messageText(connection: StoredConnection, message: ChatMessage): string {
    if (message.kind === "question") return message.content;
    return this.serverText(connection, message.text, message.content);
  }

  setLocale(id: string, locale: ImLocale): ImConnection {
    return this.view(this.setLocaleOf(this.require(id), locale));
  }

  private setLocaleOf(connection: StoredConnection, locale: ImLocale): StoredConnection {
    const updated =
      this.deps.store.update(connection.id, { config: { ...connection.config, locale } }) ??
      connection;
    this.deps.onConnectionsChanged(connection.roomId);
    return updated;
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

  /** 房主的全部连接：连接不再属于某个房间，房间只是「默认发到哪」 */
  listAll(): ImConnection[] {
    return this.deps.store.listConnections().map((connection) => this.view(connection));
  }

  /** 网页上改默认房间：和 /room 同一套校验（房间存在、没归档、房主本人在里面） */
  setRoom(id: string, roomId: string): ImConnection {
    const connection = this.require(id);
    const room = this.deps.getRoom(roomId);
    if (!room || room.archivedAt) {
      throw new HiveError("ROOM_NOT_FOUND", serverText("error.im.roomNotFound"));
    }
    if (!this.ownerOf(connection, room.id)) {
      throw new HiveError("NOT_A_MEMBER", serverText("error.im.notRoomMember"));
    }
    this.switchRoom(connection, room.id);
    return this.view(this.require(id));
  }

  /** 连接状态说明的结构化文案：只在内存里（状态说明本来就是暂时的，重启后会重新连接、重新报） */
  private readonly detailTexts = new Map<string, ServerText>();

  private view(connection: StoredConnection): ImConnection {
    const view = publicConnection(connection, this.deps.store.deliveryStats(connection.id));
    const text = this.detailTexts.get(connection.id);
    const detailText = text && connection.detail === zhText(text) ? text : undefined;
    const held = this.heldSince(connection);
    const attention: ImConnection["attention"] =
      connection.status === "error" && detailText && RELOGIN_KEYS.has(detailText.key)
        ? "relogin"
        : held
          ? "needs_message"
          : connection.status === "connected" &&
              view.delivery.lastStatus &&
              view.delivery.lastStatus !== "sent"
            ? "push_failing"
            : undefined;
    return {
      ...view,
      roomName: this.roomName(connection.roomId),
      ...(detailText ? { detailText } : {}),
      ...(attention ? { attention } : {}),
      ...(held ? { heldSince: held } : {}),
    };
  }

  /* ---------- 个人微信：要你先发一条消息才能继续推 ---------- */

  /**
   * 个人微信（iLink）只能在你给机器人发过消息之后推送：没收到过消息时 SDK 报 NoContextError；
   * 发过一阵之后服务端返回「prepare failed」（实测在你最后一次发消息后推了 10 条，第 11 条起全部失败）。
   * 这两种都不是重试能好的，暂停这个连接的推送、等你下一条消息到了再补发，不悄悄重试 8 次再放弃。
   */
  private needsUserMessage(connection: StoredConnection, error: unknown): boolean {
    if (connection.channel !== "wechat") return false;
    const value = error as { name?: unknown; code?: unknown; message?: unknown } | undefined;
    return (
      value?.name === "NoContextError" ||
      value?.code === "NO_CONTEXT" ||
      (typeof value?.message === "string" && /prepare failed/i.test(value.message))
    );
  }

  private heldSince(connection: StoredConnection): string | undefined {
    return this.deps.store.kvGet(connection.id, "held:needsMessage");
  }

  /** 暂停推送：待发的都往后放，不占发送队列；用别的 IM 提醒一次（微信这边已经发不出去了） */
  private hold(connection: StoredConnection, error: unknown): void {
    if (!this.heldSince(connection)) {
      this.deps.store.kvSet(connection.id, "held:needsMessage", new Date(this.now()).toISOString());
      this.deps.log("im push held until the owner sends a message", describe(error));
      this.notifyOwner(
        { key: "im.held.otherChannel", params: { label: connection.label } },
        (other) => other.id !== connection.id && other.ownerName === connection.ownerName,
      );
    }
    this.deps.store.postponePending(connection.id, this.now() + HELD_POSTPONE_MS);
    this.deps.onConnectionsChanged(connection.roomId);
  }

  /**
   * 你发来了消息：恢复推送，把暂停期间攒下的合成一条补发。
   * 合成一条而不是逐条补发：微信每收到你一条消息后能推的条数有限，逐条补发会很快又被卡住。
   * 已经过时的（问题已回答、任务状态已变）不再补；放不下的只给条数，到网页看。
   */
  private async release(connection: StoredConnection, chatId: string): Promise<void> {
    if (!this.heldSince(connection)) return;
    this.deps.store.kvDelete(connection.id, "held:needsMessage");
    const transport = this.transports.get(connection.id);
    const driver = this.deps.drivers[connection.channel];
    const items = this.deps.store.pendingFor(connection.id).filter((item) => {
      if (this.stillRelevant(item)) return true;
      this.deps.store.markSkipped(item.id);
      return false;
    });
    this.deps.onConnectionsChanged(connection.roomId);
    if (!transport || !items.length) return;
    const limit = driver?.maxTextLength ?? 1800;
    const separator = "\n\n———\n\n";
    const header = this.t(connection, "im.held.caughtUp", { count: items.length });
    // 从最新的往前放，放不下的较早几条只在开头说一声
    const kept: OutboxItem[] = [];
    let length = header.length + 80;
    for (const item of [...items].reverse()) {
      const next = length + item.text.length + separator.length;
      if (kept.length && next > limit) break;
      kept.unshift(item);
      length = next;
    }
    const dropped = items.length - kept.length;
    const text = this.clip(
      connection,
      [
        header,
        ...(dropped ? [this.t(connection, "im.held.older", { count: dropped })] : []),
        kept.map((item) => item.text).join(separator),
      ].join("\n\n"),
      connection.roomId,
      limit,
    );
    try {
      await transport.sendText(chatId, text);
      for (const item of items) {
        if (kept.includes(item)) this.deps.store.markSent(item.id);
        else this.deps.store.markSkipped(item.id);
      }
    } catch (error) {
      if (this.needsUserMessage(connection, error)) this.hold(connection, error);
      else this.deps.log("im catch-up failed", error);
    } finally {
      this.deps.onConnectionsChanged(connection.roomId);
    }
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
    // 还没到点的任务卡片刷新不再发：Server 关了以后数据库也关了
    for (const timer of this.taskTimers.values()) clearTimeout(timer);
    this.taskTimers.clear();
    for (const login of this.logins.values()) login.abort.abort();
    await Promise.allSettled([...this.transports.values()].map((transport) => transport.close()));
    this.transports.clear();
  }

  /* ---------- 扫码连接 ---------- */

  startLogin(
    roomId: string,
    channel: ImChannel,
    ownerName: string,
    options: { hostApprover?: boolean; locale?: ImLocale } = {},
  ): ImLoginView {
    const driver = this.deps.drivers[channel];
    if (!driver) throw new HiveError("IM_DISABLED", serverText("error.im.channelDisabled"));
    const owner = this.deps.findParticipant(roomId, ownerName);
    if (!owner || owner.type !== "human") {
      throw new HiveError("NOT_A_MEMBER", serverText("error.im.notMember"));
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
      ...(options.hostApprover ? { hostApprover: true } : {}),
      ...(options.locale ? { locale: options.locale } : {}),
    };
    this.logins.set(id, login);
    void this.runLogin(login, driver);
    const timer = setTimeout(() => {
      if (this.isOpen(login))
        this.finishLogin(login, {
          status: "failed",
          ...loginError(new ImTextError(serverText("error.im.loginTimeout"))),
        });
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
      throw new HiveError("IM_NO_CODE", serverText("error.im.noCodeNeeded"));
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
        ...(login.locale ? { locale: login.locale } : {}),
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
            if (!this.isOpen(login))
              return reject(new ImTextError(serverText("error.im.cancelled")));
            login.codeWaiter = resolve;
            this.updateLogin(login, {
              status: "need_code",
              ...(isRetry ? loginError(new ImTextError(serverText("error.im.wrongCode"))) : {}),
            });
            login.abort.signal.addEventListener(
              "abort",
              () => reject(new ImTextError(serverText("error.im.cancelled"))),
              {
                once: true,
              },
            );
          }),
      });
      if (!this.isOpen(login)) {
        this.deps.store.kvDelete(namespace);
        return;
      }
      this.updateLogin(login, { status: "connecting" });
      const connection = this.saveConnection(login, driver, result);
      if (login.hostApprover) this.deps.markHostApprover?.(connection.id, connection.ownerActorId);
      this.deps.store.kvMove(namespace, connection.id);
      this.finishLogin(login, { status: "succeeded", connectionId: connection.id });
      this.deps.onConnectionsChanged(connection.roomId);
      void this.connect(connection);
    } catch (error) {
      this.deps.store.kvDelete(namespace);
      if (!this.isOpen(login)) return;
      this.finishLogin(login, {
        status: login.abort.signal.aborted ? "cancelled" : "failed",
        ...loginError(error),
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
        throw new ImTextError(serverText("error.im.takenByOther"));
      }
      void this.disconnectTransport(existing.id);
      this.deps.store.updateSecret(existing.id, result.secret);
      this.deps.store.kvDelete(existing.id);
      // 重新扫码保留之前选的语言
      const locale = existing.config.locale ?? login.locale;
      const moved = this.deps.store.update(existing.id, {
        roomId: login.view.roomId,
        ownerName: login.ownerName,
        label: result.label,
        config: { ...result.config, ...(locale ? { locale } : {}) },
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
      config: { ...result.config, ...(login.locale ? { locale: login.locale } : {}) },
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

  private setStatus(
    id: string,
    status: ImConnection["status"],
    detailInput?: string | ServerText,
  ): void {
    const detail = typeof detailInput === "object" ? zhText(detailInput) : detailInput;
    if (typeof detailInput === "object") this.detailTexts.set(id, detailInput);
    else this.detailTexts.delete(id);
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
      this.setStatus(connection.id, "error", serverText("error.im.channelOff"));
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
      this.setStatus(connection.id, "error", errorTextOf(error) ?? describe(error));
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
            const current = this.deps.store.getConnection(connection.id) ?? connection;
            return {
              toast: {
                type: "error",
                text: this.t(current, "im.action.failed", {
                  error: describe(error, this.localeOf(current)),
                }),
              },
            };
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
        this.setStatus(connection.id, "error", errorTextOf(error) ?? describe(error));
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
    if (!connection) throw new HiveError("IM_NOT_FOUND", serverText("error.im.connectionNotFound"));
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
    let connection = this.deps.store.getConnection(connectionId);
    if (!connection || connection.status === "paused") return;
    if (!this.deps.store.claimInbound(connection.id, message.externalId)) return;
    if (message.senderId !== connection.ownerActorId) {
      // 群里其他人 @ 机器人不回应；私聊提示一次即可
      if (message.chatType === "p2p") {
        this.reply(
          connection,
          message.chatId,
          this.t(connection, "im.inbound.notOwner"),
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
        this.t(
          connection,
          files.length || message.files?.length
            ? "im.inbound.unsupportedFiles"
            : "im.inbound.unsupportedText",
        ),
        message.externalId,
      );
      return;
    }
    this.deps.store.touchInbound(connection.id, message.chatId);
    // 个人微信等你发消息才能继续推：这条就是，先把攒下的补上
    if (this.heldSince(connection)) void this.release(connection, message.chatId);
    // 记下会话是私聊还是群：带房主登录票的链接只发到私聊
    this.deps.store.kvSet(connection.id, `chatType:${message.chatId}`, message.chatType);
    const text = message.text.trim();
    if (text.startsWith("/") && !files.length) {
      this.handleCommand(connection, message, text);
      return;
    }
    // 只发「菜单」两个字：弹出控制面板（不当成消息发进房间）
    if (!files.length && /^(菜单|menu|控制面板)$/i.test(text)) {
      this.handleCommand(connection, message, "/menu");
      return;
    }
    // 回复（引用）了其他房间推来的卡片：这条消息发到那张卡片所在的房间，不用先切房间
    if (message.replyToExternalId) {
      connection = this.scopedToCard(connection, message.replyToExternalId);
    }
    const owner = this.ownerOf(connection);
    if (!owner) {
      this.reply(
        connection,
        message.chatId,
        this.t(connection, "im.inbound.ownerMissing", {
          room: connection.roomId,
          owner: connection.ownerName,
        }),
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
        this.t(connection, "im.inbound.postFailed", {
          error: describe(error, this.localeOf(connection)),
        }),
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
          this.t(connection, "im.inbound.fileFailure", {
            name:
              file.name ??
              this.t(connection, file.kind === "image" ? "im.file.image" : "im.file.file"),
            error: describe(error, this.localeOf(connection)),
          }),
        );
      }
    }
    if (!downloaded.length && !text) {
      this.reply(
        connection,
        message.chatId,
        this.t(connection, "im.inbound.filesFailed", {
          failures: failures.join(this.t(connection, "im.sep.clause")),
        }),
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
        this.t(connection, "im.inbound.postFailed", {
          error: describe(error, this.localeOf(connection)),
        }),
        message.externalId,
      );
      return;
    }
    if (failures.length) {
      this.reply(
        connection,
        message.chatId,
        this.t(connection, "im.inbound.someFilesFailed", {
          failures: failures.join(this.t(connection, "im.sep.clause")),
        }),
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
        this.t(connection, "im.inbound.posted", { room: this.roomName(connection.roomId) }),
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
    const help = this.t(connection, "im.help.text");
    switch (command?.toLowerCase()) {
      case "/":
      case "/menu":
      case "/m":
        if (this.richCapable(connection)) {
          this.enqueueCard(
            connection,
            message.chatId,
            "menu",
            message.externalId,
            this.menuCard(connection),
          );
          return;
        }
        return say(help);
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
        return say(help);
      case "/worktree": {
        const accepted =
          args[0] === "clean" &&
          Boolean(args[1]) &&
          this.deps.requestWorktreeCleanup?.(args[1]!, connection.ownerName);
        return say(this.t(connection, accepted ? "im.worktree.queued" : "im.worktree.unavailable"));
      }
      case "/status":
        return say(
          this.t(connection, "im.command.status", {
            label: connection.label,
            room: this.roomName(connection.roomId),
            owner: connection.ownerName,
          }),
        );
      case "/scope":
      case "/范围": {
        const arg = args.join(" ").trim().toLowerCase();
        const scopeName = (scope: ImScope) =>
          this.t(connection, scope === "all" ? "im.scope.all" : "im.scope.current");
        if (!arg) {
          return say(
            this.t(connection, "im.scope.status", { scope: scopeName(this.scopeOf(connection)) }),
          );
        }
        const scope: ImScope | undefined = ["all", "所有", "全部", "所有房间"].includes(arg)
          ? "all"
          : ["current", "当前", "当前房间", "仅当前房间", "this"].includes(arg)
            ? "current"
            : undefined;
        if (!scope) return say(this.t(connection, "im.scope.invalid"));
        this.setScopeOf(connection, scope);
        return say(this.t(connection, "im.scope.switched", { scope: scopeName(scope) }));
      }
      case "/lang":
      case "/language":
      case "/语言": {
        const arg = args.join(" ").trim();
        if (!arg) return say(this.t(connection, "im.lang.current"));
        const locale = parseImLocale(arg);
        if (!locale) return say(this.t(connection, "im.lang.invalid"));
        const current = this.setLocaleOf(connection, locale);
        return say(this.t(current, "im.lang.switched"));
      }
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
              this.t(connection, "im.room.current", { room: this.roomName(connection.roomId) }),
              ...rooms.map(
                (room, index) =>
                  `${index + 1}. ${room.name}${room.id === connection.roomId ? this.t(connection, "im.room.currentMark") : ""}`,
              ),
              this.t(connection, "im.room.textHint"),
            ].join("\n"),
          );
        }
        const failure = this.switchRoom(connection, target);
        return say(failure ?? this.roomSwitchedText(connection));
      }
      case "/to": {
        const arg = args.join(" ").trim();
        if (arg) {
          if (["off", "none", "nobody", "0", "无", "不指定", "取消"].includes(arg.toLowerCase())) {
            this.setTarget(connection, undefined);
            return say(this.t(connection, "im.to.cleared"));
          }
          const hits = matchAgents(
            arg.replace(/^@/, ""),
            this.agentNames(connection.roomId),
            "loose",
          );
          if (hits.length !== 1) {
            return say(
              hits.length
                ? this.t(connection, "im.to.ambiguous", {
                    names: hits.join(this.t(connection, "im.sep.list")),
                  })
                : this.t(connection, "im.to.notFound", { name: arg }),
            );
          }
          this.setTarget(connection, hits[0]);
          return say(this.t(connection, "im.to.set", { name: hits[0]! }));
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
            this.t(connection, "im.to.current", {
              name: current ?? this.t(connection, "im.nobody"),
            }),
            ...agents.map((agent, index) => `${index + 1}. ${agent}`),
            this.t(connection, "im.to.none"),
            this.t(connection, "im.to.textHint"),
          ].join("\n"),
        );
      }
      case "/web": {
        if (message.chatType !== "p2p") {
          return say(this.t(connection, "im.web.privateOnly"));
        }
        const url = this.cardUrl(connection, connection.roomId);
        if (!url) return say(this.t(connection, "im.web.noUrl"));
        if (this.richCapable(connection)) {
          this.enqueueCard(connection, message.chatId, "web", message.externalId, {
            title: this.t(connection, "im.web.title"),
            subtitle: this.roomName(connection.roomId),
            tone: "reply",
            body: this.t(connection, "im.web.body"),
            note: this.t(connection, "im.web.note"),
            link: { label: this.t(connection, "im.web.button"), url },
            summary: this.t(connection, "im.web.title"),
          });
          return;
        }
        return say(this.t(connection, "im.web.text", { url }));
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
        if (!agents.length) return say(this.t(connection, "im.who.none"));
        const icon = { online: "🟢", busy: "🔄", offline: "⚪" } as const;
        return say(
          [
            this.t(connection, "im.who.header", { room: this.roomName(connection.roomId) }),
            ...agents.map(
              (agent) =>
                `${icon[agent.status]} ${this.t(connection, `im.status.${agent.status}`)}\u3000${agent.username}`,
            ),
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
              this.t(connection, "im.level.current", {
                level: levelText(this.localeOf(connection), connection.level ?? "mine"),
              }),
              this.t(connection, "im.level.hint"),
            ].join("\n"),
          );
        }
        if (!LEVELS.includes(target)) return say(this.t(connection, "im.level.invalid"));
        this.deps.store.setLevel(connection.id, target);
        this.deps.onConnectionsChanged(connection.roomId);
        return say(
          this.t(connection, "im.level.switched", {
            level: levelText(this.localeOf(connection), target),
          }),
        );
      }
      case "/cards": {
        const on = args[0]?.toLowerCase() !== "off";
        if (!this.deps.drivers[connection.channel]?.richTextLength) {
          return say(this.t(connection, "im.cards.unsupported"));
        }
        this.deps.store.update(connection.id, {
          config: { ...connection.config, cardCallbacks: on ? "1" : "0" },
        });
        return say(this.t(connection, on ? "im.cards.on" : "im.cards.off"));
      }
      default:
        return say(
          `${this.t(connection, "im.command.unknown", { command: command ?? "" })}\n${help}`,
        );
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
      const statusKey = TASK_STATUS_TEXT[task.status];
      const status = statusKey ? this.t(connection, statusKey) : task.status;
      const detail =
        state === "queued"
          ? this.t(connection, task.receivedAt ? "im.task.queuedDelivered" : "im.task.queued")
          : state === "running"
            ? (task.progress ?? this.t(connection, "im.task.running"))
            : state === "waiting"
              ? this.t(connection, "im.task.waiting")
              : state === "done"
                ? reply
                  ? this.t(connection, "im.task.replied", { seq: reply.seq })
                  : this.t(connection, "im.task.done")
                : task.detail
                  ? this.t(connection, "im.task.withDetail", {
                      status,
                      detail: oneLine(
                        this.serverText(connection, task.detailText, task.detail),
                        60,
                      ),
                    })
                  : status;
      return { label: task.agentName, state, detail };
    });
    const agents = tasks.map((task) => task.agentName).join(this.t(connection, "im.sep.list"));
    const finished = steps.every((step) => step.state === "done" || step.state === "failed");
    const failed = steps.some((step) => step.state === "failed");
    const url = this.cardUrl(connection, message.roomId);
    return {
      title: this.t(connection, "im.task.title", { agents }),
      room: this.roomName(message.roomId),
      subtitle: `#${message.seq}`,
      tone: "reply",
      tag: this.t(
        connection,
        finished ? (failed ? "im.task.tag.partial" : "im.task.tag.done") : "im.task.tag.running",
      ),
      body: `> ${plain(oneLine(message.content, 120))}`,
      steps,
      ...(finished && !failed
        ? { resolved: { text: this.t(connection, "im.resolved.done"), ok: true } }
        : {}),
      note: this.t(connection, finished ? "im.task.note.finished" : "im.task.note.running"),
      ...this.footerFor(connection),
      ...(this.cardsEnabled(connection)
        ? {
            actions: [
              // 还有在跑或排队的：可以直接停
              ...(finished
                ? []
                : [
                    {
                      label: this.t(connection, "im.button.stop"),
                      value: { do: "stop", message: message.id },
                      style: "danger" as const,
                    },
                  ]),
              {
                label: this.t(connection, "im.button.switchAgent"),
                value: { do: "to" },
                style: "default" as const,
              },
              {
                label: this.t(connection, "im.button.menu"),
                value: { do: "menu" },
                style: "default" as const,
              },
            ],
          }
        : {}),
      ...(url ? { link: { label: this.t(connection, "im.link.view"), url } } : {}),
      summary: this.t(connection, "im.task.title", { agents }),
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
        roomId: connection.roomId,
      }),
    );
    const prompt = this.t(connection, "im.pick.prompt", { token, count: candidates.length });
    if (this.cardsEnabled(connection)) {
      this.enqueueCard(connection, message.chatId, `pick:${id}`, message.externalId, {
        title: prompt,
        subtitle: this.roomName(connection.roomId),
        tone: "question",
        tag: this.t(connection, "im.pick.tag"),
        body: `> ${plain(oneLine(text, 120))}`,
        actions: candidates.map((agent, index) => ({
          label: agent,
          value: { do: "pick", agent, id },
          style: index === 0 ? "primary" : "default",
        })),
        note: this.t(connection, "im.pick.note"),
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
        this.t(connection, "im.pick.textHint"),
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
    if (!raw) return { ok: false, reason: this.t(connection, "im.pick.alreadySent") };
    const pending = JSON.parse(raw) as {
      text: string;
      token: string;
      externalId: string;
      chatId: string;
      chatType: "p2p" | "group";
      senderId: string;
      /** 挂起时要发去的房间（回复了其他房间的卡片时不是当前房间） */
      roomId?: string;
    };
    if (pending.roomId && pending.roomId !== connection.roomId) {
      const scoped = { ...connection, roomId: pending.roomId };
      owner = this.ownerOf(scoped) ?? owner;
      connection = scoped;
    }
    if (!this.agentNames(connection.roomId).includes(agent)) {
      return { ok: false, reason: this.t(connection, "im.pick.notInRoom", { name: agent }) };
    }
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
      return { ok: false, reason: describe(error, this.localeOf(connection)) };
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

  private agentPicker(
    connection: StoredConnection,
    title = this.t(connection, "im.agents.title"),
  ): ImRich {
    const current = this.targetOf(connection);
    const agents = this.deps
      .participants(connection.roomId)
      .filter((participant) => participant.type === "agent");
    const currentName = current ?? this.t(connection, "im.nobody");
    return {
      title,
      subtitle: this.roomName(connection.roomId),
      tone: "reply",
      tag: this.t(connection, "im.agents.current", { name: currentName }),
      ...(agents.length ? {} : { body: this.t(connection, "im.who.none") }),
      actions: [
        ...agents.map((agent) => ({
          label: `${agent.username} · ${this.t(connection, `im.status.${agent.status}`)}`,
          value: { do: "target", agent: agent.username },
          style: agent.username === current ? ("primary" as const) : ("default" as const),
        })),
        {
          label: this.t(connection, "im.agents.nobody"),
          value: { do: "target", agent: "" },
          style: current ? ("default" as const) : ("primary" as const),
        },
      ],
      note: this.t(connection, "im.agents.note"),
      summary: this.t(connection, "im.agents.summary", { title, name: currentName }),
    };
  }

  private memberRooms(connection: StoredConnection): Array<{ id: string; name: string }> {
    return this.deps
      .listRoomIds()
      .filter((id) => Boolean(this.ownerOf(connection, id)))
      .map((id) => ({ id, name: this.roomName(id) }));
  }

  private roomPicker(connection: StoredConnection): ImRich {
    const rooms = this.memberRooms(connection);
    return {
      title: this.t(connection, "im.rooms.title"),
      subtitle: this.t(connection, "im.rooms.current", { room: this.roomName(connection.roomId) }),
      tone: "reply",
      tag: this.t(connection, "im.rooms.count", { count: rooms.length }),
      actions: rooms.map((room) => {
        const online = this.deps
          .participants(room.id)
          .filter((participant) => participant.status !== "offline").length;
        const tasks = this.deps.roomTasks(room.id);
        const extra = [
          this.t(connection, "im.rooms.online", { count: online }),
          ...(tasks.running
            ? [this.t(connection, "im.rooms.running", { count: tasks.running })]
            : []),
          ...(tasks.waiting
            ? [this.t(connection, "im.rooms.waiting", { count: tasks.waiting })]
            : []),
        ].join(" · ");
        return {
          label: `${room.id === connection.roomId ? "● " : ""}${room.name} · ${extra}`,
          value: { do: "room", room: room.id },
          style: room.id === connection.roomId ? ("primary" as const) : ("default" as const),
        };
      }),
      note: this.t(connection, "im.rooms.note"),
      summary: this.t(connection, "im.rooms.summary", { room: this.roomName(connection.roomId) }),
    };
  }

  /** 切换房间；返回失败原因 */
  private switchRoom(connection: StoredConnection, roomId: string): string | undefined {
    const room = this.deps.getRoom(roomId);
    if (!room || room.archivedAt) return this.t(connection, "im.room.notFound", { room: roomId });
    if (!this.ownerOf(connection, room.id)) {
      return this.t(connection, "im.room.notMember", { room: room.name });
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
      say(
        item
          ? this.t(connection, "im.to.set", { name: item })
          : this.t(connection, "im.to.cleared"),
      );
    } else {
      const result = this.sendPending(connection, owner, menu.id!, item);
      if (!result.ok) say(result.reason);
    }
    return true;
  }

  private roomSwitchedText(connection: StoredConnection): string {
    const current = this.deps.store.getConnection(connection.id) ?? connection;
    const target = this.targetOf(current);
    return `${this.t(current, "im.room.switched", { room: this.roomName(current.roomId) })}${
      target
        ? this.t(current, "im.room.switchedTarget", { name: target })
        : this.t(current, "im.room.switchedNoTarget")
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
  private forChat(connection: StoredConnection, chatId: string, card: ImRich): ImRich {
    // 卡片里固定的字（提交按钮、附件标题）按连接的语言画
    const rich: ImRich = { ...card, locale: this.localeOf(connection) };
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

  /** Agent 回复卡片底部的快捷按钮：接着问它、换对象、换房间、打开控制面板 */
  private replyActions(
    connection: StoredConnection,
    agent: string,
  ): NonNullable<ImRich["actions"]> {
    return [
      {
        label: this.t(connection, "im.button.follow"),
        value: { do: "follow", agent },
        style: "primary",
      },
      { label: this.t(connection, "im.button.switchAgent"), value: { do: "to" }, style: "default" },
      {
        label: this.t(connection, "im.button.switchRoom"),
        value: { do: "room" },
        style: "default",
      },
      { label: this.t(connection, "im.button.menu"), value: { do: "menu" }, style: "default" },
    ];
  }

  /** 控制面板：当前房间、对象、档位和忙闲一览，常用操作都在按钮上，不用记命令 */
  private menuCard(connection: StoredConnection): ImRich {
    const target = this.targetOf(connection);
    const agents = this.deps
      .participants(connection.roomId)
      .filter((participant) => participant.type === "agent");
    const busy = agents.filter((agent) => agent.status === "busy").length;
    const tasks = this.deps.roomTasks(connection.roomId);
    const url = this.cardUrl(connection, connection.roomId);
    const buttons = this.cardsEnabled(connection);
    const t = (key: ImTextKey, params?: ImTextParams) => this.t(connection, key, params);
    const other = this.localeOf(connection) === "en" ? "zh-CN" : "en";
    return {
      title: t("im.menu.title"),
      room: this.roomName(connection.roomId),
      tone: "reply",
      body: [
        target ? t("im.menu.target", { name: target }) : t("im.menu.noTarget"),
        t("im.menu.level", {
          level: levelText(this.localeOf(connection), connection.level ?? "mine"),
        }),
        t("im.menu.scope", {
          scope: t(this.scopeOf(connection) === "all" ? "im.scope.all" : "im.scope.current"),
        }),
        t("im.menu.agents", {
          count: agents.length,
          state: busy ? t("im.menu.busy", { count: busy }) : t("im.menu.idle"),
        }) +
          (tasks.running || tasks.waiting
            ? t("im.menu.tasks", { count: tasks.running }) +
              (tasks.waiting ? t("im.menu.waiting", { count: tasks.waiting }) : "")
            : ""),
      ].join("\n"),
      ...(buttons
        ? {
            actions: [
              { label: t("im.button.pickAgent"), value: { do: "to" }, style: "primary" },
              { label: t("im.button.switchRoom"), value: { do: "room" }, style: "default" },
              { label: t("im.button.who"), value: { do: "who" }, style: "default" },
              { label: t("im.button.level"), value: { do: "level" }, style: "default" },
              { label: t("im.button.help"), value: { do: "help" }, style: "default" },
              this.scopeOf(connection) === "all"
                ? {
                    label: t("im.button.scopeCurrent"),
                    value: { do: "scope", scope: "current" },
                    style: "default",
                  }
                : {
                    label: t("im.button.scopeAll"),
                    value: { do: "scope", scope: "all" },
                    style: "default",
                  },
              {
                label: t("im.button.otherLanguage"),
                value: { do: "lang", locale: other },
                style: "default",
              },
            ],
          }
        : { note: t("im.menu.commands") }),
      ...(url ? { link: { label: t("im.link.open"), url } } : {}),
      summary: t("im.menu.summary", { room: this.roomName(connection.roomId) }),
    };
  }

  /** 常用操作按钮（需要卡片回调） */
  private quickActions(connection: StoredConnection): Pick<ImRich, "actions"> {
    if (!this.cardsEnabled(connection)) return {};
    const t = (key: ImTextKey) => this.t(connection, key);
    return {
      actions: [
        { label: t("im.button.pickAgent"), value: { do: "to" }, style: "primary" },
        { label: t("im.button.switchRoom"), value: { do: "room" }, style: "default" },
        { label: t("im.button.who"), value: { do: "who" }, style: "default" },
        { label: t("im.button.level"), value: { do: "level" }, style: "default" },
      ],
    };
  }

  private helpCard(connection: StoredConnection): ImRich {
    const target = this.targetOf(connection);
    const buttons = this.cardsEnabled(connection);
    const t = (key: ImTextKey, params?: ImTextParams) => this.t(connection, key, params);
    return {
      title: t("im.helpCard.title"),
      subtitle: t("im.helpCard.subtitle", {
        room: this.roomName(connection.roomId),
        name: target ?? t("im.helpCard.noTarget"),
      }),
      tone: "reply",
      tag: t(buttons ? "im.helpCard.tag.buttons" : "im.helpCard.tag.text"),
      sections: [
        {
          title: t("im.helpCard.send.title"),
          body: [
            t("im.helpCard.send.basic"),
            target
              ? t("im.helpCard.send.target", { name: target })
              : t("im.helpCard.send.noTarget"),
            t("im.helpCard.send.alias"),
            t("im.helpCard.send.reply"),
          ].join("\n"),
        },
        {
          title: t("im.helpCard.answer.title"),
          body: t(buttons ? "im.helpCard.answer.buttons" : "im.helpCard.answer.text"),
        },
        {
          title: t("im.helpCard.commands.title"),
          body: [
            t("im.helpCard.commands.body"),
            ...(buttons ? [] : [t("im.helpCard.commands.cards")]),
          ].join("\n"),
        },
        { title: t("im.helpCard.menu.title"), body: t("im.helpCard.menu.body") },
      ],
      ...(buttons ? {} : { note: t("im.helpCard.note") }),
      ...this.quickActions(connection),
      summary: t("im.helpCard.title"),
    };
  }

  private whoCard(connection: StoredConnection): ImRich {
    const agents = this.deps
      .participants(connection.roomId)
      .filter((participant) => participant.type === "agent");
    const target = this.targetOf(connection);
    const order = { busy: 0, online: 1, offline: 2 } as const;
    const icon = { online: "🟢", busy: "🔄", offline: "⚪" } as const;
    const busy = agents.filter((agent) => agent.status === "busy").length;
    return {
      title: this.t(connection, "im.whoCard.title"),
      subtitle: this.roomName(connection.roomId),
      tone: "reply",
      tag: busy
        ? this.t(connection, "im.whoCard.busy", { count: busy })
        : this.t(connection, "im.whoCard.idle"),
      body: agents.length
        ? [...agents]
            .sort(
              (a, b) => order[a.status] - order[b.status] || a.username.localeCompare(b.username),
            )
            .map(
              (agent) =>
                // 正文会转义尖括号，这里只用 Markdown，不用 <font>
                `${icon[agent.status]} **${agent.username}**\u3000${this.t(connection, `im.status.${agent.status}`)}${
                  agent.username === target ? this.t(connection, "im.whoCard.target") : ""
                }`,
            )
            .join("\n")
        : this.t(connection, "im.who.none"),
      ...(this.cardsEnabled(connection)
        ? {
            actions: [
              {
                label: this.t(connection, "im.button.pickAgent"),
                value: { do: "to" },
                style: "primary" as const,
              },
            ],
          }
        : {}),
      summary: this.t(connection, "im.whoCard.summary", { count: busy }),
    };
  }

  private levelCard(connection: StoredConnection): ImRich {
    const current = connection.level ?? "mine";
    const locale = this.localeOf(connection);
    return {
      title: this.t(connection, "im.levelCard.title"),
      subtitle: this.roomName(connection.roomId),
      tone: "reply",
      tag: this.t(connection, "im.levelCard.current", { name: levelName(locale, current) }),
      body: LEVELS.map(
        (level) =>
          `${level === current ? "✅" : "▫️"} **${levelName(locale, level)}**\n${imText(locale, `im.level.${level}.desc`)}`,
      ).join("\n"),
      ...(this.cardsEnabled(connection)
        ? {
            actions: LEVELS.map((level) => ({
              label: levelName(locale, level),
              value: { do: "level", level },
              style: level === current ? ("primary" as const) : ("default" as const),
            })),
          }
        : { note: this.t(connection, "im.level.hint") }),
      summary: this.t(connection, "im.levelCard.summary", { name: levelName(locale, current) }),
    };
  }

  /** 回复、进度卡片底部：当前发给谁，旁边一个「切换」 */
  private footerFor(connection: StoredConnection): Pick<ImRich, "footer"> {
    if (!this.cardsEnabled(connection)) return {};
    return {
      footer: this.t(connection, "im.footer", {
        room: this.roomName(connection.roomId),
        name: this.targetOf(connection) ?? this.t(connection, "im.nobody"),
      }),
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
        resolved: settledLabel(this.localeOf(connection), invocation),
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
            ...selected.map((key) =>
              this.t(connection, "im.answer.option", {
                key,
                label: question.question?.options.find((item) => item.key === key)?.label ?? "",
              }),
            ),
            ...(answer.other
              ? [this.t(connection, "im.answer.other", { text: answer.other })]
              : []),
          ].join(this.t(connection, "im.sep.clause"))
        : plain(oneLine(answer.content, 200));
    const by = "selected" in answer ? answer.by : answer.senderName;
    return {
      ...base,
      selected,
      resolved: { text: this.t(connection, "im.resolved.answered"), ok: true },
      note: this.t(connection, "im.answer.note", { by, text }),
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
    if (!connection)
      return { toast: { type: "warning", text: imText("zh-CN", "im.toast.paused") } };
    const t = (key: ImTextKey, params?: ImTextParams) => this.t(connection, key, params);
    if (connection.status === "paused") {
      return { toast: { type: "warning", text: t("im.toast.paused") } };
    }
    if (action.operatorId !== connection.ownerActorId) {
      return { toast: { type: "error", text: t("im.toast.notOwner") } };
    }
    // 作答、重试、停止这些作用在卡片所在的房间（可能不是当前房间），用那个房间里的房主身份
    const scoped = this.scopedToCard(connection, action.externalId);
    const owner = this.ownerOf(scoped);
    if (!owner) {
      return {
        toast: { type: "error", text: t("im.toast.ownerMissing", { owner: connection.ownerName }) },
      };
    }
    const op = action.value.do;
    if (op === "worktree_cleanup") {
      const accepted =
        this.deps.requestWorktreeCleanup?.(action.value.batch ?? "", connection.ownerName) ?? false;
      const text = t(accepted ? "im.worktree.queued" : "im.worktree.unavailable");
      const delivery = this.deps.store.deliveryByExternal(connection.id, action.externalId);
      return {
        toast: { type: accepted ? "info" : "error", text },
        ...(delivery?.rich ? { rich: { ...delivery.rich, resolved: { text, ok: accepted } } } : {}),
      };
    }
    if (op === "goto") return this.gotoFromCard(connection, action);
    if (op === "answer" || op === "answer_form") return this.answerFromCard(scoped, owner, action);
    if (op === "retry" || op === "dismiss" || op === "continue") {
      return this.invocationFromCard(connection, owner, action, op);
    }
    if (op === "host_approval") {
      const decided = this.deps.decideHostApproval?.(
        connection.id,
        action.operatorId,
        action.value.id ?? "",
        action.value.decision === "allow",
      ) ?? { ok: false, key: "im.host.unsupported" };
      const text = t(decided.key);
      const delivery = this.deps.store.deliveryByExternal(connection.id, action.externalId);
      const base = delivery?.rich;
      const rich: ImRich | undefined = base
        ? { ...base, resolved: { text, ok: decided.ok } }
        : undefined;
      if (delivery && rich) this.deps.store.setRich(delivery.id, rich);
      return {
        toast: { type: decided.ok ? "success" : "info", text },
        ...(rich ? { rich } : {}),
      };
    }
    if (op === "target") {
      const agent = action.value.agent ?? "";
      if (agent && !this.agentNames(connection.roomId).includes(agent)) {
        return { toast: { type: "error", text: t("im.pick.notInRoom", { name: agent }) } };
      }
      this.setTarget(connection, agent || undefined);
      return {
        toast: {
          type: "success",
          text: agent ? t("im.to.setShort", { name: agent }) : t("im.to.clearedShort"),
        },
        rich: this.agentPicker(connection),
      };
    }
    if (op === "room" && !action.value.room) {
      this.enqueueCard(connection, action.chatId, "room", undefined, this.roomPicker(connection));
      return { toast: { type: "info", text: t("im.toast.roomCard") } };
    }
    if (op === "who") {
      this.enqueueCard(connection, action.chatId, "who", undefined, this.whoCard(connection));
      return { toast: { type: "info", text: t("im.toast.whoCard") } };
    }
    if (op === "level") {
      const level = action.value.level as ImDeliveryLevel | undefined;
      if (!level) {
        this.enqueueCard(connection, action.chatId, "level", undefined, this.levelCard(connection));
        return { toast: { type: "info", text: t("im.toast.levelCard") } };
      }
      if (!LEVELS.includes(level)) return { toast: { type: "error", text: t("im.toast.noLevel") } };
      this.deps.store.setLevel(connection.id, level);
      this.deps.onConnectionsChanged(connection.roomId);
      const current = this.deps.store.getConnection(connection.id) ?? connection;
      return {
        toast: { type: "success", text: this.t(current, "im.toast.levelSwitched") },
        rich: this.levelCard(current),
      };
    }
    if (op === "scope") {
      const scope = action.value.scope === "current" ? "current" : "all";
      const current = this.setScopeOf(connection, scope);
      return {
        toast: {
          type: "success",
          text: this.t(current, "im.scope.switched", {
            scope: this.t(current, scope === "all" ? "im.scope.all" : "im.scope.current"),
          }),
        },
        rich: this.menuCard(current),
      };
    }
    if (op === "lang") {
      const locale = parseImLocale(action.value.locale ?? "");
      if (!locale) return { toast: { type: "error", text: t("im.lang.invalid") } };
      const current = this.setLocaleOf(connection, locale);
      // 被点的是控制面板：原地换成新语言的面板
      return {
        toast: { type: "success", text: this.t(current, "im.toast.languageSwitched") },
        rich: this.menuCard(current),
      };
    }
    if (op === "room") {
      const failure = this.switchRoom(connection, action.value.room ?? "");
      if (failure) return { toast: { type: "error", text: failure } };
      const current = this.deps.store.getConnection(connection.id) ?? connection;
      const switched = this.t(current, "im.room.switchedShort", {
        room: this.roomName(current.roomId),
      });
      return {
        toast: { type: "success", text: switched },
        // 卡片原地变成新房间的对象选择
        rich: this.agentPicker(current, switched),
      };
    }
    if (op === "follow") {
      const agent = action.value.agent ?? "";
      // 其他房间的回复卡片上点「继续问它」：先切到那个房间
      if (scoped.roomId !== connection.roomId && !this.switchRoom(connection, scoped.roomId)) {
        const current = this.deps.store.getConnection(connection.id) ?? connection;
        if (this.agentNames(current.roomId).includes(agent)) {
          this.setTarget(current, agent);
          return {
            toast: {
              type: "success",
              text: this.t(current, "im.toast.followSwitched", {
                room: this.roomName(current.roomId),
                name: agent,
              }),
            },
          };
        }
      }
      if (!this.agentNames(connection.roomId).includes(agent)) {
        return {
          toast: {
            type: "error",
            text: t("im.toast.followElsewhere", {
              agent,
              room: this.roomName(connection.roomId),
            }),
          },
        };
      }
      this.setTarget(connection, agent);
      return { toast: { type: "success", text: t("im.to.setShort", { name: agent }) } };
    }
    if (op === "menu") {
      this.enqueueCard(connection, action.chatId, "menu", undefined, this.menuCard(connection));
      return { toast: { type: "info", text: t("im.toast.menuCard") } };
    }
    if (op === "help") {
      this.enqueueCard(connection, action.chatId, "help", undefined, this.helpCard(connection));
      return { toast: { type: "info", text: t("im.toast.helpCard") } };
    }
    if (op === "stop") {
      const tasks = this.deps
        .invocationsFor(action.value.message ?? "")
        .filter((task) => ["queued", "running", "waiting_human", "blocked"].includes(task.status));
      if (!tasks.length) return { toast: { type: "info", text: t("im.toast.allFinished") } };
      let failed = 0;
      for (const task of tasks) {
        try {
          this.deps.cancel(owner, task.id);
        } catch {
          failed += 1;
        }
      }
      return {
        toast: failed
          ? {
              type: "warning",
              text: t("im.toast.stopPartial", { ok: tasks.length - failed, failed }),
            }
          : { type: "success", text: t("im.toast.stopped", { count: tasks.length }) },
      };
    }
    if (op === "to") {
      this.enqueueCard(connection, action.chatId, "to", undefined, this.agentPicker(connection));
      return { toast: { type: "info", text: t("im.toast.pickerCard") } };
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
          ...(base
            ? { rich: { ...base, resolved: { text: t("im.pick.handled"), ok: false } } }
            : {}),
        };
      }
      const rich: ImRich | undefined = base
        ? {
            ...base,
            resolved: { text: t("im.pick.sentTo", { name: action.value.agent ?? "" }), ok: true },
          }
        : undefined;
      if (delivery && rich) this.deps.store.setRich(delivery.id, rich);
      return { toast: { type: "success", text: t("im.pick.sent") }, ...(rich ? { rich } : {}) };
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
      return { toast: { type: "error", text: this.t(connection, "im.toast.noQuestion") } };
    }
    if (!this.deps.isWaiting(question.id)) {
      const driver = this.deps.drivers[connection.channel];
      return {
        toast: { type: "info", text: this.t(connection, "im.toast.answered") },
        rich: {
          ...this.richMessage(connection, question, driver?.richTextLength ?? 4000),
          resolved: { text: this.t(connection, "im.resolved.closed"), ok: false },
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
      return { toast: { type: "warning", text: this.t(connection, "im.toast.pickFirst") } };
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
      return { toast: { type: "error", text: describe(error, this.localeOf(connection)) } };
    } finally {
      this.posting = undefined;
      this.answeringFromCard = undefined;
    }
    return {
      toast: { type: "success", text: this.t(connection, "im.toast.submitted") },
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
      return { toast: { type: "error", text: this.t(connection, "im.toast.noTask") } };
    }
    // 已处理过（重复点击、飞书超时重投同一回调，或已在网页上处理）：不再执行，
    // 尤其「继续」每执行一次都会再追加轮数
    if (delivery.rich.resolved) {
      return {
        toast: { type: "info", text: this.t(connection, "im.toast.taskHandled") },
        rich: delivery.rich,
      };
    }
    const kind =
      op === "dismiss"
        ? "dismiss"
        : op === "continue"
          ? "continue"
          : delivery.rich.tone === "approval"
            ? "approve"
            : "retry";
    const params = { turns: BUDGET_EXTEND_TURNS, owner: owner.username };
    const label = this.t(connection, RESOLVED_LABEL[kind], params);
    try {
      if (op === "retry") this.deps.retry(owner, check.id);
      else if (op === "dismiss") this.deps.dismiss(owner, check.id);
      else this.deps.extendBudget(owner, BUDGET_EXTEND_TURNS);
    } catch (error) {
      return { toast: { type: "error", text: describe(error, this.localeOf(connection)) } };
    }
    const rich: ImRich = {
      ...delivery.rich,
      resolved: { text: label, ok: op !== "dismiss" },
      note: this.t(connection, `im.byOwner.${kind}`, params),
    };
    this.deps.store.setRich(delivery.id, rich);
    return { toast: { type: "success", text: label }, rich };
  }

  /** 房主在某个房间里的成员身份（默认当前房间）；其他房间的事要按那个房间算 */
  private ownerOf(
    connection: StoredConnection,
    roomId = connection.roomId,
  ): Participant | undefined {
    const owner = this.deps.findParticipant(roomId, connection.ownerName);
    // 名字只在各个房间里各自查重：房主没进过的房间里，访客也可以叫这个名字。访客不是房主本人，
    // 不能拿来收那个房间的推送、以它的身份发言或点按钮
    if (owner?.type !== "human" || this.deps.isGuest?.(owner)) return undefined;
    return owner;
  }

  /* ---------- 接收所有房间 ---------- */

  /** 接收范围：默认所有房间（房主所在的、没归档的）；可以改成只收当前房间 */
  private scopeOf(connection: StoredConnection): ImScope {
    return connection.config.scope === "current" ? "current" : "all";
  }

  setScope(id: string, scope: ImScope): ImConnection {
    return this.view(this.setScopeOf(this.require(id), scope));
  }

  setCrossRoomAll(id: string, crossRoomAll: boolean): ImConnection {
    const connection = this.require(id);
    const updated =
      this.deps.store.update(id, {
        config: { ...connection.config, crossRoomAll: String(crossRoomAll) },
      }) ?? connection;
    this.deps.onConnectionsChanged(connection.roomId);
    return this.view(updated);
  }

  private setScopeOf(connection: StoredConnection, scope: ImScope): StoredConnection {
    const updated =
      this.deps.store.update(connection.id, { config: { ...connection.config, scope } }) ??
      connection;
    this.deps.onConnectionsChanged(connection.roomId);
    return updated;
  }

  private liveRoom(roomId: string): boolean {
    const room = this.deps.getRoom(roomId);
    return Boolean(room && !room.archivedAt);
  }

  /**
   * 这个房间里发生的事和哪些连接有关。
   * - all：绑定在这个房间的，加上房主也在这个房间里的（不管接收范围）。用来更新已经推出去的卡片：
   *   回复其他房间卡片派出的任务、在那边作答的提问，进度和结论都要回到原来那张卡片上。
   * - push：要推新消息的。绑定在这个房间的，加上「接收所有房间」的；房间已归档的不推；
   *   同一个 IM 账号接了几个连接时只推一次（优先绑定在这个房间的）。
   */
  private connectionsFor(roomId: string): { all: StoredConnection[]; push: StoredConnection[] } {
    const all = this.deps.store
      .listConnections()
      .filter(
        (connection) =>
          connection.status !== "paused" &&
          (connection.roomId === roomId || Boolean(this.ownerOf(connection, roomId))),
      );
    if (!this.liveRoom(roomId)) return { all, push: [] };
    const ordered = [
      ...all.filter((connection) => connection.roomId === roomId),
      ...all.filter(
        (connection) => connection.roomId !== roomId && this.scopeOf(connection) === "all",
      ),
    ];
    const seen = new Set<string>();
    const push = ordered.filter((connection) => {
      const key = `${connection.channel}:${connection.ownerActorId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { all, push };
  }

  /** 一张已推出的卡片属于哪个房间：消息卡片、进度卡片、提醒卡片都能对上 */
  private roomOfCard(connection: StoredConnection, externalId: string): string | undefined {
    const messageId = this.deps.store.messageForExternal(connection.id, externalId);
    const message = messageId ? this.deps.getMessage(messageId) : undefined;
    if (message) return message.roomId;
    const delivery = this.deps.store.deliveryByExternal(connection.id, externalId);
    if (!delivery) return undefined;
    if (delivery.messageId) return this.deps.getMessage(delivery.messageId)?.roomId;
    if (delivery.eventKey.startsWith("task:")) {
      return this.deps.getMessage(delivery.eventKey.slice("task:".length))?.roomId;
    }
    if (delivery.check?.kind === "invocation") {
      return this.deps.getInvocation(delivery.check.id)?.roomId;
    }
    if (delivery.check?.kind === "question") {
      return this.deps.getMessage(delivery.check.messageId)?.roomId;
    }
    return undefined;
  }

  /**
   * 卡片在其他房间时，返回一个「临时站在那个房间」的连接视图（不改连接本身）：
   * 引用回复、作答、重试、停止都落在卡片所在的房间
   */
  private scopedToCard(connection: StoredConnection, externalId: string): StoredConnection {
    const roomId = this.roomOfCard(connection, externalId);
    if (!roomId || roomId === connection.roomId || !this.liveRoom(roomId)) return connection;
    return this.ownerOf(connection, roomId) ? { ...connection, roomId } : connection;
  }

  /** 推到 IM 的东西不在当前房间：卡片标上「#房间名」、换成橙色，底部加「切到 #房间 继续」；文字前面加 [#房间名] */
  private markOtherRoom(
    connection: StoredConnection,
    roomId: string,
    item: { text: string; rich?: ImRich | undefined },
  ): { text: string; rich?: ImRich } {
    if (roomId === connection.roomId) {
      return { text: item.text, ...(item.rich ? { rich: item.rich } : {}) };
    }
    const name = this.roomName(roomId);
    const text = `${this.t(connection, "im.otherRoom.prefix", { room: name })} ${item.text}`;
    if (!item.rich) return { text };
    const goto = {
      label: this.t(connection, "im.button.gotoRoom", { room: name }),
      value: { do: "goto", room: roomId },
      style: "default" as const,
    };
    return {
      text,
      rich: {
        ...item.rich,
        otherRoom: { id: roomId, name },
        ...(this.cardsEnabled(connection)
          ? { actions: [...(item.rich.actions ?? []), goto] }
          : {
              note: [item.rich.note, this.t(connection, "im.otherRoom.textHint", { room: roomId })]
                .filter(Boolean)
                .join(this.t(connection, "im.sep.clause")),
            }),
      },
    };
  }

  /** 卡片上点「切到 #房间 继续」：连接的当前房间切过去，卡片保留内容、去掉这个按钮并注明已切换 */
  private gotoFromCard(connection: StoredConnection, action: ImAction): ImActionResult {
    const roomId = action.value.room ?? "";
    const failure = this.switchRoom(connection, roomId);
    if (failure) return { toast: { type: "error", text: failure } };
    const current = this.deps.store.getConnection(connection.id) ?? connection;
    const text = this.roomSwitchedText(current);
    const delivery = this.deps.store.deliveryByExternal(connection.id, action.externalId);
    const base = delivery?.rich;
    if (!delivery || !base) return { toast: { type: "success", text } };
    const rich: ImRich = {
      ...base,
      actions: (base.actions ?? []).filter((item) => item.value.do !== "goto"),
      footer: text,
    };
    this.deps.store.setRich(delivery.id, rich);
    return { toast: { type: "success", text }, rich };
  }

  /** 这条 Agent 消息所在的任务是不是房主自己派的（沿委派链找到源头的人） */
  private isOwnersTask(connection: StoredConnection, message: ChatMessage): boolean {
    const owner = this.ownerOf(connection, message.roomId);
    if (!owner || !message.parentMessageId) return false;
    const invocation = this.deps
      .invocationsFor(message.parentMessageId)
      .find((item) => item.agentId === message.senderId);
    return Boolean(invocation && this.rootRequesterId(invocation) === owner.id);
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
      ...this.markOtherRoom(connection, message.roomId, {
        text: this.format(connection, message, driver?.maxTextLength ?? 1800),
        rich: driver?.richTextLength
          ? this.richMessage(connection, message, driver.richTextLength)
          : undefined,
      }),
      ...(options.batch ? { batch: true } : {}),
      ...(options.check ? { check: options.check } : {}),
    });
    // 同一条消息已作为合并项排队：现在要求立即发（例如它就是房主任务的最终结果）
    if (!created && !options.batch) this.deps.store.promote(connection.id, eventKey);
  }

  /* ---------- 其他设备管理 Server 所在电脑：通知与批准 ---------- */

  /** 每个房主 IM 账号一个连接（同一账号接了几个房间只推一次） */
  private ownerConnections(filter?: (connection: StoredConnection) => boolean) {
    const seen = new Set<string>();
    return this.deps.store.listConnections().filter((connection) => {
      if (connection.status === "paused" || (filter && !filter(connection))) return false;
      const key = `${connection.channel}:${connection.ownerActorId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  notifyWorktreeCleanup(batch: WorktreeCleanupBatch): void {
    if (batch.state === "expired") return;
    for (const connection of this.ownerConnections(
      (item) => item.ownerName === batch.ownerName && Boolean(this.ownerOf(item)),
    )) {
      const t = (key: ImTextKey, params?: ImTextParams) => this.t(connection, key, params);
      const complete = batch.state === "completed";
      const count = complete
        ? (batch.results ?? []).filter((item) => item.removed).length
        : batch.items.length;
      const title = t(complete ? "im.worktree.completed" : "im.worktree.ready", { count });
      const body = complete
        ? (batch.results ?? [])
            .map(
              (item) =>
                `${item.path}: ${item.removed ? t("im.worktree.removed") : t("im.worktree.retained")}${item.error ? ` — ${item.error}` : ""}`,
            )
            .join("\n")
        : batch.items.map((item) => `${item.branch}\n${item.path}`).join("\n\n");
      const rich: ImRich = {
        title,
        tone: "reply",
        body,
        summary: title,
        note: t("im.worktree.safety"),
        ...(!complete && this.cardsEnabled(connection)
          ? {
              actions: [
                {
                  label: t("im.worktree.cleanAll"),
                  value: { do: "worktree_cleanup", batch: batch.id },
                  style: "primary" as const,
                },
              ],
            }
          : {}),
      };
      const url =
        this.deps.loginUrl?.(connection.id, batch.roomId) ?? this.deps.webUrl(batch.roomId);
      if (url) rich.link = { label: t("im.worktree.open"), url };
      const text = `${title}\n\n${body}\n\n${t("im.worktree.safety")}${!complete && !this.cardsEnabled(connection) ? `\n${t("im.worktree.command", { batch: batch.id })}` : ""}`;
      this.deps.store.enqueue({
        connectionId: connection.id,
        eventKey: `worktree:${batch.id}:${batch.state}`,
        chatId: `${USER_TARGET}${connection.ownerActorId}`,
        text,
        rich,
      });
    }
    this.schedulePump();
  }

  /** 推一条文字到房主私聊（安全提醒等，不挂在任何房间消息上）；按每个连接的语言渲染 */
  notifyOwner(
    text: ImMessage | string,
    filter?: (connection: StoredConnection) => boolean,
  ): number {
    const targets = this.ownerConnections(filter);
    for (const connection of targets) {
      this.deps.store.enqueue({
        connectionId: connection.id,
        eventKey: `notice:${randomUUID()}`,
        chatId: `${USER_TARGET}${connection.ownerActorId}`,
        text: plain(renderImMessage(this.localeOf(connection), text)),
      });
    }
    if (targets.length) this.schedulePump();
    return targets.length;
  }

  /**
   * 把批准卡推到可批准的连接（只推开了卡片回调的；文字渠道点不了按钮，只提醒到本机批准）。
   * 返回推出批准卡的数量
   */
  requestHostApproval(
    approval: { id: string; summary: string; expiresAt: string },
    approvers: (connection: StoredConnection) => boolean,
    /** 按连接语言渲染的申请说明；没有时用 summary 原文 */
    summaryText?: ImMessage,
  ): number {
    const targets = this.ownerConnections(
      (connection) => approvers(connection) && this.cardsEnabled(connection),
    );
    for (const connection of targets) {
      const t = (key: ImTextKey, params?: ImTextParams) => this.t(connection, key, params);
      const summary = plain(
        summaryText ? renderImMessage(this.localeOf(connection), summaryText) : approval.summary,
      );
      const rich: ImRich = {
        title: t("im.host.title"),
        tone: "approval",
        tag: t("im.host.tag"),
        body: summary,
        note: t("im.host.note"),
        actions: [
          {
            label: t("im.button.allow"),
            value: { do: "host_approval", id: approval.id, decision: "allow" },
            style: "primary",
          },
          {
            label: t("im.button.deny"),
            value: { do: "host_approval", id: approval.id, decision: "deny" },
            style: "danger",
          },
        ],
        summary: t("im.host.summary", { summary }),
      };
      this.deps.store.enqueue({
        connectionId: connection.id,
        eventKey: `host-approval:${approval.id}`,
        chatId: `${USER_TARGET}${connection.ownerActorId}`,
        text: rich.summary,
        rich,
      });
    }
    if (targets.length) this.schedulePump();
    return targets.length;
  }

  /** 房间里有新消息：按每个连接的档位决定推不推 */
  onMessageCreated(message: ChatMessage): void {
    const { all, push } = this.connectionsFor(message.roomId);
    for (const connection of all) {
      // 提问被回答了：推出去的提问卡片改成已回答（卡片上点的由回调自己更新）
      if (
        (message.answer || message.replyToMessageId) &&
        message.senderType === "human" &&
        this.answeringFromCard !== connection.id
      ) {
        this.settleQuestion(connection, message);
      }
    }
    for (const connection of push) {
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
    const owner = this.ownerOf(connection, message.roomId);
    const parent = message.parentMessageId
      ? this.deps.getMessage(message.parentMessageId)
      : undefined;
    return decideImDelivery(connection, message, {
      ownerId: owner?.id,
      mentionsOwner: this.mentionsOwner(message, connection),
      ownersTask: this.isOwnersTask(connection, message),
      fromIm: Boolean(this.originOf(message, connection.id)),
      mentionsAgent: message.mentions.some(
        (name) => this.deps.findParticipant(message.roomId, name)?.type === "agent",
      ),
      parentSenderType: parent?.senderType,
    });
  }

  /**
   * 调用状态变化：房主任务的最终结果，以及需要房主知道或处理的状态（失败、结果未知、被拦下、等批准）。
   * 这些往往没有对应的聊天消息，只看新消息会漏掉。
   */
  onInvocationUpdated(invocation: Invocation): void {
    const { all, push } = this.connectionsFor(invocation.roomId);
    for (const connection of all) {
      // 飞书派的任务：进度卡片、处理中/完成表情；已发出的提醒卡片随状态改成已处理
      this.trackTask(connection, invocation);
      this.settleNotices(connection, invocation);
    }
    for (const connection of push) {
      if (connection.level === "im") continue;
      const owner = this.ownerOf(connection, invocation.roomId);
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
      const notice = this.statusNotice(connection, invocation);
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
        ...this.markOtherRoom(connection, invocation.roomId, {
          rich,
          text: this.clip(
            connection,
            `${this.roomName(invocation.roomId)} - ${invocation.agentName}\n${notice}`,
            invocation.roomId,
            driver?.maxTextLength ?? 1800,
          ),
        }),
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

  private statusNotice(connection: StoredConnection, invocation: Invocation): string | undefined {
    const t = (key: ImTextKey, params?: ImTextParams) => this.t(connection, key, params);
    const trigger = this.deps.getMessage(invocation.messageId);
    const ref = trigger ? `#${trigger.seq}` : t("im.notice.thisTask");
    const detail = invocation.detail
      ? plain(
          this.serverText(connection, invocation.detailText, invocation.detail).replace(
            /\s+/g,
            " ",
          ),
        )
      : "";
    switch (invocation.status) {
      case "failed":
        return t("im.notice.failed", {
          ref,
          detail: detail ? t("im.notice.detail", { detail }) : "",
        });
      case "timed_out":
        return t("im.notice.timedOut", { ref });
      case "blocked":
        return invocation.blockReason === "guest_approval"
          ? t("im.notice.guest", {
              guest: plain(invocation.requesterName),
              agent: invocation.agentName,
              ref,
            })
          : t("im.notice.paused", { ref, reason: detail || t("im.notice.turnLimit") });
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
    const t = (key: ImTextKey, params?: ImTextParams) => this.t(connection, key, params);
    const ref = trigger ? `#${trigger.seq}` : t("im.notice.thisTask");
    const detail = invocation.detail
      ? this.serverText(connection, invocation.detailText, invocation.detail)
          .replace(/\s+/g, " ")
          .trim()
      : "";
    const agent = invocation.agentName;
    const url = this.cardUrl(connection, invocation.roomId);
    const subtitle = trigger ? `#${trigger.seq}` : "";
    const room = this.roomName(invocation.roomId);
    const quote = trigger ? `> ${plain(oneLine(trigger.content, 120))}` : "";
    const act = (
      ...items: Array<[ImTextKey, string, "primary" | "default" | "danger"]>
    ): Pick<ImRich, "actions"> =>
      interactive
        ? {
            actions: items.map(([label, op, style]) => ({
              label: t(label),
              value: { do: op },
              style,
            })),
          }
        : {};
    const ignore: [ImTextKey, string, "default"] = ["im.button.dismiss", "dismiss", "default"];
    const base = (rich: Omit<ImRich, "subtitle" | "link" | "summary">): ImRich => ({
      ...rich,
      room,
      ...(subtitle ? { subtitle } : {}),
      summary: `${rich.title}${detail ? t("im.notice.detail", { detail }) : ""}`,
      ...(url ? { link: { label: t("im.link.handle", { ref }), url } } : {}),
    });
    switch (invocation.status) {
      case "failed":
        return base({
          title: t("im.notice.failedTitle", { agent }),
          tone: "danger",
          tag: t("im.task.failed"),
          body: [quote, detail ? t("im.notice.reason", { detail: plain(detail) }) : ""]
            .filter(Boolean)
            .join("\n\n"),
          note: interactive ? t("im.notice.failedNote") : t("im.notice.failedNoteText", { ref }),
          ...act(["im.button.retry", "retry", "primary"], ignore),
        });
      case "timed_out":
        return base({
          title: t("im.notice.timedOutTitle", { agent }),
          tone: "warning",
          tag: t("im.task.timedOut"),
          body: quote,
          note: t("im.notice.timedOutNote"),
          ...act(ignore),
        });
      case "blocked":
        return invocation.blockReason === "guest_approval"
          ? base({
              title: t("im.notice.guestTitle"),
              tone: "approval",
              tag: t("im.host.tag"),
              body: [
                t("im.notice.guestBody", { guest: plain(invocation.requesterName), agent }),
                quote,
              ]
                .filter(Boolean)
                .join("\n\n"),
              note: t(interactive ? "im.notice.guestNote" : "im.notice.guestNoteText"),
              ...act(["im.button.approve", "retry", "primary"], ignore),
            })
          : base({
              title: t("im.notice.pausedTitle", { agent }),
              tone: "warning",
              tag: t("im.task.blocked"),
              body: [
                quote,
                t("im.notice.reason", { detail: plain(detail || t("im.notice.turnLimit")) }),
              ]
                .filter(Boolean)
                .join("\n\n"),
              note: interactive
                ? t("im.notice.pausedNote", { turns: BUDGET_EXTEND_TURNS })
                : t("im.notice.pausedNoteText"),
              ...act(["im.button.continue", "continue", "primary"], ignore),
            });
      default:
        return undefined;
    }
  }

  /** 房间消息的卡片：Agent 回复、@ 房主、提问（选项单独列出） */
  private richMessage(connection: StoredConnection, message: ChatMessage, limit: number): ImRich {
    const t = (key: ImTextKey, params?: ImTextParams) => this.t(connection, key, params);
    const sender = message.senderName;
    const url = this.cardUrl(connection, message.roomId);
    let body = plain(this.messageText(connection, message));
    let options: ImRich["options"];
    let note: string | undefined;
    if (message.kind === "question") {
      // 正文开头是「@提问对象 ❓ 问题」，后面跟（单选）和逐行选项、作答提示：卡片里分开展示
      body = questionText(body);
      if (message.question) {
        options = message.question.options.map((option) => ({
          key: option.key,
          label: plain(option.label),
        }));
      }
      note = t(
        this.cardsEnabled(connection)
          ? "im.question.cards"
          : message.question
            ? message.question.multiple
              ? "im.question.multiple"
              : "im.question.single"
            : "im.question.open",
      );
    }
    if (body.length > limit) {
      body = `${body.slice(0, limit)}…`;
      note = [note, t("im.message.truncated", { seq: message.seq })]
        .filter(Boolean)
        .join(t("im.sep.clause"));
    }
    const mentioned = this.mentionsOwner(message, connection);
    const question = message.kind === "question";
    const title = t(
      question
        ? message.approval
          ? "im.message.approval"
          : "im.message.question"
        : message.kind === "progress"
          ? "im.message.progress"
          : message.senderType === "human"
            ? "im.message.human"
            : mentioned
              ? "im.message.mention"
              : "im.message.reply",
      { sender },
    );
    const attachments = (message.attachments ?? []).map((item) => ({
      name: item.name,
      size: formatSize(item.size),
    }));
    return {
      title,
      room: this.roomName(message.roomId),
      subtitle: `#${message.seq} · ${clock(message.createdAt)}`,
      tone: question ? "question" : mentioned ? "mention" : "reply",
      ...(question
        ? {
            tag: t(
              message.question
                ? message.question.multiple
                  ? "im.message.tag.multiple"
                  : "im.message.tag.single"
                : "im.message.tag.open",
            ),
          }
        : message.kind === "progress"
          ? { tag: t("im.message.tag.progress") }
          : {}),
      ...(body ? { body } : {}),
      ...(options ? { options } : {}),
      ...(question && this.cardsEnabled(connection)
        ? { choice: { multiple: Boolean(message.question?.multiple) } }
        : {}),
      ...(!question && message.senderType === "agent" && this.cardsEnabled(connection)
        ? { ...this.footerFor(connection), actions: this.replyActions(connection, sender) }
        : {}),
      ...(note ? { note } : {}),
      ...(attachments.length ? { attachments } : {}),
      ...(url ? { link: { label: t("im.link.view"), url } } : {}),
      summary: t("im.message.summary", {
        sender,
        text: oneLine(body || attachments[0]?.name || "", 60),
      }),
    };
  }

  private formatAttachments(connection: StoredConnection, message: ChatMessage): string[] {
    const t = (key: ImTextKey, params?: ImTextParams) => this.t(connection, key, params);
    const attachments = message.attachments ?? [];
    if (!attachments.length) return [];
    const url = this.deps.webUrl(message.roomId);
    return [
      t("im.message.attachments", { count: attachments.length }),
      ...attachments.map((item) =>
        t("im.message.attachment", { name: item.name, size: formatSize(item.size) }),
      ),
      t("im.message.attachmentsLink", { seq: message.seq }) +
        (url ? `${t("im.sep.label")}${url}` : ""),
    ];
  }

  /** 消息顶部统一标注「房间名 - 发送者」 */
  private format(connection: StoredConnection, message: ChatMessage, limit: number): string {
    const t = (key: ImTextKey) => this.t(connection, key);
    const header = `${this.roomName(message.roomId)} - ${message.senderName}`;
    let body = plain(this.messageText(connection, message));
    if (message.kind === "question") {
      const hint = t(
        message.question
          ? message.question.multiple
            ? "im.question.hintMultiple"
            : "im.question.hintSingle"
          : "im.question.hintOpen",
      );
      body =
        message.question && this.localeOf(connection) !== "zh-CN"
          ? // 正文里的「（单选）」、作答提示是中文：按连接的语言重新排一遍，只保留问题和选项原文
            [
              `❓ ${questionText(body)}`,
              t(message.question.multiple ? "im.question.textMultiple" : "im.question.textSingle"),
              ...message.question.options.map((option) => `${option.key}. ${plain(option.label)}`),
              hint,
            ].join("\n")
          : body.replace(/（(点选选项|回复这条消息)[^）]*）\s*$/u, hint);
    }
    const extra = this.formatAttachments(connection, message);
    const tail = extra.length ? `\n\n${extra.join("\n")}` : "";
    const head = body ? `${header}\n${body}` : header;
    return this.clip(connection, head, message.roomId, limit - tail.length, message.seq) + tail;
  }

  private clip(
    connection: StoredConnection,
    text: string,
    roomId: string,
    limit: number,
    seq?: number,
  ): string {
    if (text.length <= limit) return text;
    const url = this.deps.webUrl(roomId);
    const where = `${seq ? ` #${seq}` : ""}${url ? `${this.t(connection, "im.sep.label")}${url}` : ""}`;
    const suffix = `\n${this.t(connection, "im.message.clipped", { where })}`;
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
        const roomId = item.messageId ? this.deps.getMessage(item.messageId)?.roomId : undefined;
        const key = `${item.connectionId}\u0000${item.chatId}\u0000${roomId ?? ""}`;
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
    // 推送暂停中（个人微信等你发消息）：不发、不算失败，等你的消息到了一起补
    if (this.heldSince(connection)) {
      this.deps.store.postponePending(connection.id, this.now() + HELD_POSTPONE_MS);
      return;
    }
    const live = items.filter((item) => {
      if (this.stillRelevant(item)) return true;
      this.deps.store.markSkipped(item.id);
      return false;
    });
    if (!live.length) return;
    const text = live.map((item) => item.text).join("\n\n———\n\n");
    const rich = live.every((item) => item.rich)
      ? this.forChat(
          connection,
          first.chatId,
          combineRich(
            this.localeOf(connection),
            live.map((item) => item.rich!),
          ),
        )
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
      if (this.needsUserMessage(connection, error)) {
        this.hold(connection, error);
        return;
      }
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
/** 文字编号菜单的有效期 */
const TEXT_MENU_TTL_MS = 10 * 60_000;
/** 进度卡片 2 秒内最多改一次，避免频繁调接口 */
const TASK_CARD_THROTTLE_MS = 2_000;
/** 卡片上「继续」追加的对话轮数（与网页一致） */
const BUDGET_EXTEND_TURNS = 10;
const TASK_STATUS_TEXT: Partial<Record<Invocation["status"], ImTextKey>> = {
  failed: "im.task.failed",
  timed_out: "im.task.timedOut",
  cancelled: "im.task.cancelled",
  blocked: "im.task.blocked",
};
/** 卡片上点了重试 / 忽略 / 继续 / 批准之后的结论 */
const RESOLVED_LABEL = {
  dismiss: "im.resolved.dismissed",
  continue: "im.resolved.extended",
  approve: "im.resolved.approved",
  retry: "im.resolved.retried",
} as const satisfies Record<string, ImTextKey>;

/** 提问正文开头是「@提问对象 ❓ 问题」，后面跟（单选）和逐行选项、作答提示：只取问题本身 */
function questionText(body: string): string {
  const lines = body.split("\n");
  const marker = lines.findIndex((line) => /^（(单选|可多选)）$/u.test(line.trim()));
  return (marker >= 0 ? lines.slice(0, marker) : lines)
    .join("\n")
    .replace(/^(＠\S+\s+)?❓\s*/u, "")
    .replace(/\s*（(点选选项|回复这条消息)[^）]*）\s*$/u, "")
    .trim();
}

/** 提醒卡片被别处处理后的结论 */
function settledLabel(locale: ImLocale, invocation: Invocation): { text: string; ok: boolean } {
  const label = (key: ImTextKey, ok: boolean) => ({ text: imText(locale, key), ok });
  if (invocation.resolution) return label("im.resolved.dismissed", false);
  switch (invocation.status) {
    case "queued":
    case "running":
      return label("im.resolved.restarted", true);
    case "completed":
      return label("im.resolved.done", true);
    case "cancelled":
      return label("im.resolved.stopped", false);
    case "waiting_human":
      return label("im.resolved.waiting", true);
    default:
      return label("im.resolved.changed", false);
  }
}

/** 卡片上的发送时间：今天只显示时分 */
function clock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return date.toDateString() === new Date().toDateString()
    ? time
    : `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

function oneLine(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

/** 合并推送：多条卡片合成一张，每条一节 */
function combineRich(locale: ImLocale, items: ImRich[]): ImRich {
  if (items.length === 1) return items[0]!;
  const rooms = [...new Set(items.map((item) => item.room).filter(Boolean))] as string[];
  const link = items.find((item) => item.link)?.link;
  const otherRoom = items[0]!.otherRoom;
  const actions = items[0]!.actions?.filter((action) => action.value.do === "goto");
  return {
    title: imText(locale, "im.digest.title", { count: items.length }),
    ...(rooms.length ? { room: rooms.join(imText(locale, "im.sep.list")) } : {}),
    tone: "digest",
    ...(otherRoom ? { otherRoom } : {}),
    ...(actions?.length ? { actions } : {}),
    sections: items.map((item) => ({
      title: rooms.length > 1 && item.room ? `${item.room}｜${item.title}` : item.title,
      ...(item.subtitle ? { subtitle: item.subtitle } : {}),
      body: [
        item.body ?? "",
        ...(item.options ?? []).map((option) => `**${option.key}**\u3000${option.label}`),
        ...(item.attachments ?? []).map(
          (file) =>
            `📎 ${imText(locale, "im.message.attachment", { name: file.name, size: file.size }).replace(/^· /, "")}`,
        ),
      ]
        .filter(Boolean)
        .join("\n"),
    })),
    ...(link ? { link: { label: imText(locale, "im.link.viewAll"), url: link.url } } : {}),
    summary: items.map((item) => item.summary).join(imText(locale, "im.sep.clause")),
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
