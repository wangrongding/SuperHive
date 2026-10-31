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
  /** 随消息发来的图片、文件（需要再下载） */
  files?: ImInboundFile[];
  /** 既不是文字也不是图片/文件（语音、视频等），目前不支持 */
  unsupported?: boolean;
};

export type ImInboundFile = { key: string; kind: "image" | "file"; name?: string };

/** 人在卡片上点了按钮或提交了表单 */
export type ImAction = {
  /** 被点的那张卡片在平台上的消息 ID */
  externalId: string;
  chatId: string;
  operatorId: string;
  /** 按钮上带的值（我们自己写进卡片的） */
  value: Record<string, string>;
  /** 表单提交时各字段的值 */
  form?: Record<string, unknown>;
};

/** 点击后的即时反馈：弹一句提示，并可把卡片原地换成新内容 */
export type ImActionResult = {
  toast?: { type: "success" | "info" | "warning" | "error"; text: string };
  rich?: ImRich;
};

export type ImTransportEvents = {
  onMessage(message: ImInbound): void;
  /** 卡片交互回调；平台要求几秒内应答，处理必须是同步的轻量操作 */
  onAction?(action: ImAction): ImActionResult | undefined;
  onStatus(status: "connected" | "error", detail?: string): void;
};

/**
 * 与平台无关的富消息：飞书渲染成消息卡片，不支持的渠道照旧发纯文本。
 * 正文是 Markdown（房间消息原样），其余字段都是纯文本。
 */
export type ImRich = {
  /** 卡片标题，例如「rd-claude 的回复」 */
  title: string;
  /** 一行上下文：房间、消息序号 */
  subtitle?: string;
  /** 决定标题栏颜色与图标 */
  tone: "reply" | "mention" | "question" | "warning" | "danger" | "approval" | "digest";
  /** 标题右侧的状态标签 */
  tag?: string;
  /** Markdown 正文 */
  body?: string;
  /** 提问的选项（字母 + 文字），在卡片里单独列出 */
  options?: Array<{ key: string; label: string }>;
  /** 灰色小字说明，例如怎么作答、正文被截断 */
  note?: string;
  attachments?: Array<{ name: string; size: string }>;
  /** 合并推送：每条一节 */
  sections?: Array<{ title: string; subtitle?: string; body: string }>;
  /** 底部按钮：到网页查看 */
  link?: { label: string; url: string };
  /** 可点的操作按钮（重试、批准、忽略…）；value 原样回传 */
  actions?: Array<{
    label: string;
    value: Record<string, string>;
    style?: "primary" | "default" | "danger";
  }>;
  /** 提问可以直接在卡片上作答：单选是一排按钮，多选是勾选框加提交，都能另填「其它」 */
  choice?: { multiple: boolean };
  /** 已经处理完：显示结论、去掉所有按钮 */
  resolved?: { text: string; ok: boolean };
  /** 已选中的选项（作答后高亮） */
  selected?: string[];
  /** 底部一行小字（当前发给谁） */
  footer?: string;
  /** 任务进度：每个 Agent 一行 */
  steps?: Array<{
    label: string;
    state: "queued" | "running" | "waiting" | "done" | "failed";
    detail?: string;
  }>;
  /** 会话列表里的一行预览 */
  summary: string;
};

/** 一条已建立的 IM 连接：收消息、发文字 */
export interface ImTransport {
  start(events: ImTransportEvents): Promise<void>;
  /** 返回平台给新消息的 ID（拿不到时为 undefined） */
  sendText(chatId: string, text: string, replyToExternalId?: string): Promise<string | undefined>;
  /** 原地更新一张已发出的卡片（尽力而为，失败不影响业务） */
  updateRich?(externalId: string, rich: ImRich): Promise<void>;
  /** 给一条消息加表情回应，返回回应 ID（用于之后撤掉） */
  react?(externalId: string, emoji: string): Promise<string | undefined>;
  unreact?(externalId: string, reactionId: string): Promise<void>;
  /** 发图片或文件 */
  sendFile?(
    chatId: string,
    file: { name: string; mime: string; kind: "image" | "file"; data: Buffer },
    replyToExternalId?: string,
  ): Promise<string | undefined>;
  /** 下载入站消息里的图片或文件 */
  download?(externalId: string, file: ImInboundFile): Promise<{ name: string; data: Buffer }>;
  /** 支持富消息的渠道实现；发送失败时应自行退回纯文本 fallback */
  sendRich?(
    chatId: string,
    rich: ImRich,
    fallback: string,
    replyToExternalId?: string,
  ): Promise<string | undefined>;
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
  /** 支持富消息（卡片）时正文的最大字数；不填表示只发纯文本 */
  readonly richTextLength?: number;
  login(callbacks: ImLoginCallbacks): Promise<ImLoginResult>;
  createTransport(input: { config: ImConfig; secret: string; kv: ImKeyValue }): ImTransport;
}
