import type { ImChannel } from "@ai-hive/protocol";
import type { ImConfig } from "./im-store.js";

/** 发送目标以它开头时表示「发到这个人的私聊」，后面跟平台上的用户 ID */
export const USER_TARGET = "user:";

/** IM 平台推来的一条消息，已归一成纯文本 */
export type ImInbound = {
  /** 平台给的消息 ID，用于去重和回复引用 */
  externalId: string;
  chatId: string;
  chatType: "p2p" | "group";
  senderId: string;
  text: string;
  /** 这条消息引用回复了哪条 IM 消息（飞书的 parent_id） */
  replyToExternalId?: string;
  /** 不是文字（图片、语音等），目前只支持文字 */
  unsupported?: boolean;
};

export type ImTransportEvents = {
  onMessage(message: ImInbound): void;
  onStatus(status: "connected" | "error", detail?: string): void;
};

/** 一条已建立的 IM 连接：收消息、发文字 */
export interface ImTransport {
  start(events: ImTransportEvents): Promise<void>;
  /** 返回平台给新消息的 ID（拿不到时为 undefined） */
  sendText(chatId: string, text: string, replyToExternalId?: string): Promise<string | undefined>;
  close(): Promise<void>;
}

/** 渠道 SDK 私有状态的加密存取（个人微信 SDK 把登录令牌、轮询游标存在这里） */
export type ImKeyValue = {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key?: string): void;
};

export type ImLoginCallbacks = {
  signal: AbortSignal;
  onQr(url: string, expiresInSeconds?: number): void;
  onScanned(): void;
  /** 平台要求输入手机上显示的配对码 */
  requestCode(isRetry: boolean): Promise<string>;
  /** 扫码登录期间的临时 SDK 状态；成功后整体迁到正式连接下 */
  kv: ImKeyValue;
};

export type ImLoginResult = {
  /** 扫码人在平台上的 ID：只有这个人的消息以房主身份进房间 */
  ownerActorId: string;
  label: string;
  config: ImConfig;
  secret: string;
  /** config 里唯一标识这个机器人 / 账号的字段：同一身份只保留一条连接 */
  identityKey: string;
};

export interface ImChannelDriver {
  readonly channel: ImChannel;
  /** 单条消息的最大字数，超出时截断并附网页链接 */
  readonly maxTextLength: number;
  login(callbacks: ImLoginCallbacks): Promise<ImLoginResult>;
  createTransport(input: { config: ImConfig; secret: string; kv: ImKeyValue }): ImTransport;
}
