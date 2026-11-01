import * as lark from "@larksuiteoapi/node-sdk";
import type { ImConfig } from "./im-store.js";
import { CARD_ACTION_KEY, FEISHU_CARD_BODY_LIMIT, renderFeishuCard } from "./feishu-card.js";
import { Readable } from "node:stream";
import {
  USER_TARGET,
  type ImChannelDriver,
  type ImAction,
  type ImInbound,
  type ImInboundFile,
  type ImRich,
  type ImLoginCallbacks,
  type ImLoginResult,
  type ImTransport,
  type ImTransportEvents,
} from "./types.js";

/**
 * 飞书（含 Lark）：扫码时由官方 SDK 的 registerApp 引导创建或选择一个企业自建应用，
 * 返回应用凭据和扫码人的 open_id；之后用 WSClient 长连接收消息，本机不需要公网回调地址。
 * 参考 Zwork 的接入（apps/electron/src/main/im/feishu），只申请收发消息所需的最少权限。
 */
const ADDONS: lark.AppAddons = {
  scopes: {
    tenant: [
      "im:message.p2p_msg:readonly",
      "im:message.group_at_msg:readonly",
      "im:message:send_as_bot",
      "im:message:readonly",
      "im:chat:read",
      // 卡片原地更新、处理中/完成的表情回应、收发图片和文件
      "im:message:update",
      "im:message.reactions:write_only",
      "im:resource",
    ],
  },
  events: { items: { tenant: ["im.message.receive_v1", "application.bot.menu_v6"] } },
  // 卡片上的按钮回调经同一条长连接送达
  callbacks: { items: ["card.action.trigger"] },
};

/** 扫码时申请了卡片回调的连接在配置里带这个标记；旧连接要重新扫码（或在后台开通后用 /cards on） */
export const CARD_CALLBACKS_CONFIG = "cardCallbacks";

function sdkDomain(domain: string | undefined): lark.Domain {
  return domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;
}

type PostNode = { tag?: string; text?: string; user_name?: string; href?: string };

/** 富文本（post）里的文字按行拼起来；图片等节点忽略 */
function postText(content: unknown): string {
  const body = content as {
    title?: string;
    content?: PostNode[][];
    zh_cn?: { title?: string; content?: PostNode[][] };
  };
  const post = body.content ? body : (body.zh_cn ?? Object.values(body)[0]);
  const rows = (post as { content?: PostNode[][] } | undefined)?.content ?? [];
  const lines = rows.map((row) =>
    row
      .map((node) =>
        node.tag === "text" || node.tag === "a"
          ? (node.text ?? "")
          : node.tag === "at"
            ? `@${node.user_name ?? ""}`
            : "",
      )
      .join(""),
  );
  const title = (post as { title?: string } | undefined)?.title;
  return [title, ...lines].filter(Boolean).join("\n");
}

type ReceiveEvent = Parameters<NonNullable<lark.EventHandles["im.message.receive_v1"]>>[0];

/** 把飞书消息事件归一成纯文本；机器人自己的 @ 去掉，提到的其他人换成 @名字 */
export function normalizeFeishuMessage(
  event: ReceiveEvent,
  botOpenId: string | undefined,
): ImInbound | undefined {
  const message = event.message;
  const senderId = event.sender?.sender_id?.open_id;
  if (!message?.message_id || !message.chat_id || !senderId) return undefined;
  let text = "";
  let unsupported = false;
  const files: ImInboundFile[] = [];
  try {
    const content = JSON.parse(message.content) as {
      text?: string;
      image_key?: string;
      file_key?: string;
      file_name?: string;
    };
    if (message.message_type === "text") text = content.text ?? "";
    else if (message.message_type === "post") {
      text = postText(content);
      files.push(...postImages(content));
    } else if (message.message_type === "image" && content.image_key) {
      files.push({ key: content.image_key, kind: "image" });
    } else if (message.message_type === "file" && content.file_key) {
      files.push({
        key: content.file_key,
        kind: "file",
        ...(content.file_name ? { name: content.file_name } : {}),
      });
    } else unsupported = true;
  } catch {
    unsupported = true;
  }
  for (const mention of message.mentions ?? []) {
    const isBot = botOpenId ? mention.id?.open_id === botOpenId : true;
    text = text.split(mention.key).join(isBot ? "" : `@${mention.name}`);
  }
  return {
    externalId: message.message_id,
    chatId: message.chat_id,
    chatType: message.chat_type === "p2p" ? "p2p" : "group",
    senderId,
    text: text.trim(),
    ...(message.parent_id ? { replyToExternalId: message.parent_id } : {}),
    ...(files.length ? { files: files.slice(0, 10) } : {}),
    ...(unsupported ? { unsupported } : {}),
  };
}

/** 富文本里插的图片 */
function postImages(content: unknown): ImInboundFile[] {
  const body = content as { content?: PostNode[][]; zh_cn?: { content?: PostNode[][] } };
  const post = body.content ? body : (body.zh_cn ?? Object.values(body as object)[0]);
  const rows = (post as { content?: Array<Array<PostNode & { image_key?: string }>> } | undefined)
    ?.content;
  return (rows ?? [])
    .flat()
    .filter((node) => node.tag === "img" && node.image_key)
    .map((node) => ({ key: node.image_key!, kind: "image" as const }));
}

type CardActionEvent = {
  context?: { open_message_id?: string; open_chat_id?: string };
  open_message_id?: string;
  open_chat_id?: string;
  operator?: { open_id?: string };
  action?: { value?: unknown; form_value?: unknown; name?: string; tag?: string };
};

/** 卡片回调归一：只认带我们标记的按钮 / 表单 */
export function normalizeCardAction(event: CardActionEvent): ImAction | undefined {
  const externalId = event.context?.open_message_id ?? event.open_message_id;
  const chatId = event.context?.open_chat_id ?? event.open_chat_id;
  const operatorId = event.operator?.open_id;
  if (!externalId || !chatId || !operatorId) return undefined;
  const raw = event.action?.value;
  const value: Record<string, string> = {};
  if (raw && typeof raw === "object") {
    for (const [key, item] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof item === "string") value[key] = item.slice(0, 200);
    }
  }
  const form =
    event.action?.form_value && typeof event.action.form_value === "object"
      ? (event.action.form_value as Record<string, unknown>)
      : undefined;
  // 表单里的提交按钮没有 value，靠表单字段识别
  if (!value[CARD_ACTION_KEY] && !form) return undefined;
  if (form && !value.do) value.do = "answer_form";
  return { externalId, chatId, operatorId, value, ...(form ? { form } : {}) };
}

class FeishuTransport implements ImTransport {
  private readonly client: lark.Client;
  private socket: lark.WSClient | undefined;
  private botOpenId: string | undefined;

  constructor(
    private readonly config: ImConfig,
    private readonly appSecret: string,
  ) {
    this.client = new lark.Client({
      appId: config.appId!,
      appSecret,
      domain: sdkDomain(config.domain),
      loggerLevel: lark.LoggerLevel.error,
    });
  }

  async start(events: ImTransportEvents): Promise<void> {
    this.botOpenId = await this.fetchBotOpenId();
    const dispatcher = new lark.EventDispatcher({}).register({
      "im.message.receive_v1": (data) => {
        const inbound = normalizeFeishuMessage(data, this.botOpenId);
        // 平台要求 3 秒内确认：这里只把事件交出去，入库与派发都是同步的轻量操作
        if (inbound) events.onMessage(inbound);
      },
      // 机器人菜单（在开发者后台配置，事件 key 写命令名，如 who、level、room、status、help）：当作对应命令处理
      "application.bot.menu_v6": (data: {
        event_key?: string;
        timestamp?: number | string;
        operator?: { operator_id?: { open_id?: string } };
      }) => {
        const openId = data.operator?.operator_id?.open_id;
        const key = data.event_key?.trim().replace(/^\//, "");
        if (!openId || !key || !/^[a-z]+$/i.test(key)) return;
        events.onMessage({
          externalId: `menu:${key}:${String(data.timestamp ?? Date.now())}`,
          chatId: `${USER_TARGET}${openId}`,
          chatType: "p2p",
          senderId: openId,
          text: `/${key}`,
        });
      },
      // 返回值就是给飞书的应答：弹提示，并把卡片原地换成处理后的样子
      "card.action.trigger": (data: CardActionEvent) => {
        const action = normalizeCardAction(data);
        const result = action ? events.onAction?.(action) : undefined;
        if (!result) return undefined;
        return {
          ...(result.toast
            ? { toast: { type: result.toast.type, content: result.toast.text } }
            : {}),
          ...(result.rich ? { card: { type: "raw", data: renderFeishuCard(result.rich) } } : {}),
        };
      },
    } as Record<string, (data: never) => unknown>);
    this.socket = new lark.WSClient({
      appId: this.config.appId!,
      appSecret: this.appSecret,
      domain: sdkDomain(this.config.domain),
      loggerLevel: lark.LoggerLevel.error,
      source: "superhive",
      onReady: () => events.onStatus("connected"),
      onReconnected: () => events.onStatus("connected"),
      onError: (error) => events.onStatus("error", error.message),
    });
    await this.socket.start({ eventDispatcher: dispatcher });
  }

  private async fetchBotOpenId(): Promise<string | undefined> {
    try {
      const result = (await this.client.request({
        method: "GET",
        url: "/open-apis/bot/v3/info",
      })) as { bot?: { open_id?: string } };
      return result.bot?.open_id;
    } catch {
      return undefined;
    }
  }

  async sendText(chatId: string, text: string, replyTo?: string): Promise<string | undefined> {
    return this.send(chatId, "text", JSON.stringify({ text }), replyTo);
  }

  /** 发消息卡片；卡片被拒（客户端或格式不支持等）时退回纯文本，消息不丢 */
  async sendRich(
    chatId: string,
    rich: ImRich,
    fallback: string,
    replyTo?: string,
  ): Promise<string | undefined> {
    try {
      return await this.send(
        chatId,
        "interactive",
        JSON.stringify(renderFeishuCard(rich)),
        replyTo,
      );
    } catch (error) {
      console.warn(
        `[im] 飞书卡片发送失败，已改发文字：${error instanceof Error ? error.message : String(error)}`,
      );
      return this.sendText(chatId, fallback, replyTo);
    }
  }

  private async send(
    chatId: string,
    msgType: "text" | "interactive" | "image" | "file",
    content: string,
    replyTo?: string,
  ): Promise<string | undefined> {
    // 菜单点击等没有原消息可引用
    if (replyTo && !replyTo.startsWith("menu:")) {
      try {
        const result = await this.client.im.message.reply({
          path: { message_id: replyTo },
          data: { msg_type: msgType, content },
        });
        if (result.code === 0) return result.data?.message_id;
      } catch {
        // 原消息被撤回等情况下退回到直接发到会话；内容本身有问题时下面会再报错
      }
    }
    // user: 前缀表示发到这个人的私聊：按 open_id 直接发，不要求对方先在私聊里说过话
    const toUser = chatId.startsWith(USER_TARGET);
    const result = await this.client.im.message.create({
      params: { receive_id_type: toUser ? "open_id" : "chat_id" },
      data: {
        receive_id: toUser ? chatId.slice(USER_TARGET.length) : chatId,
        msg_type: msgType,
        content,
      },
    });
    if (result.code !== 0) throw new Error(result.msg || `飞书返回错误 ${result.code}`);
    return result.data?.message_id;
  }

  async updateRich(externalId: string, rich: ImRich): Promise<void> {
    const result = await this.client.im.message.patch({
      path: { message_id: externalId },
      data: { content: JSON.stringify(renderFeishuCard(rich)) },
    });
    if (result.code !== 0) throw new Error(result.msg || `飞书返回错误 ${result.code}`);
  }

  async react(externalId: string, emoji: string): Promise<string | undefined> {
    const result = await this.client.im.messageReaction.create({
      path: { message_id: externalId },
      data: { reaction_type: { emoji_type: emoji } },
    });
    if (result.code !== 0) throw new Error(result.msg || `飞书返回错误 ${result.code}`);
    return result.data?.reaction_id;
  }

  async unreact(externalId: string, reactionId: string): Promise<void> {
    await this.client.im.messageReaction.delete({
      path: { message_id: externalId, reaction_id: reactionId },
    });
  }

  async sendFile(
    chatId: string,
    file: { name: string; mime: string; kind: "image" | "file"; data: Buffer },
    replyTo?: string,
  ): Promise<string | undefined> {
    if (file.kind === "image") {
      const uploaded = (await this.client.im.image.create({
        data: { image_type: "message", image: file.data },
      })) as { image_key?: string; data?: { image_key?: string } } | null;
      const key = uploaded?.image_key ?? uploaded?.data?.image_key;
      if (!key) throw new Error("飞书图片上传没有返回 image_key");
      return this.send(chatId, "image", JSON.stringify({ image_key: key }), replyTo);
    }
    const uploaded = (await this.client.im.file.create({
      data: {
        file_type: feishuFileType(file.name),
        file_name: file.name,
        // 上传用流的 path 作为文件名
        file: Object.assign(Readable.from(file.data), { path: file.name }) as unknown as Buffer,
      },
    })) as { file_key?: string; data?: { file_key?: string } } | null;
    const key = uploaded?.file_key ?? uploaded?.data?.file_key;
    if (!key) throw new Error("飞书文件上传没有返回 file_key");
    return this.send(chatId, "file", JSON.stringify({ file_key: key }), replyTo);
  }

  async download(externalId: string, file: ImInboundFile): Promise<{ name: string; data: Buffer }> {
    const resource = await this.client.im.messageResource.get({
      params: { type: file.kind === "image" ? "image" : "file" },
      path: { message_id: externalId, file_key: file.key },
    });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of resource.getReadableStream()) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      size += buffer.length;
      if (size > 20 * 1024 * 1024) throw new Error("文件超过 20 MiB");
      chunks.push(buffer);
    }
    return {
      name: file.name ?? (file.kind === "image" ? `飞书图片-${file.key.slice(-8)}.png` : file.key),
      data: Buffer.concat(chunks),
    };
  }

  async close(): Promise<void> {
    this.socket?.close({ force: true });
    this.socket = undefined;
  }
}

async function botName(
  appId: string,
  appSecret: string,
  domain: string,
): Promise<string | undefined> {
  try {
    const client = new lark.Client({
      appId,
      appSecret,
      domain: sdkDomain(domain),
      loggerLevel: lark.LoggerLevel.error,
    });
    const result = (await client.request({ method: "GET", url: "/open-apis/bot/v3/info" })) as {
      bot?: { app_name?: string };
    };
    return result.bot?.app_name;
  } catch {
    return undefined;
  }
}

/** 飞书文件上传要求的类型：常见办公格式按扩展名，其余一律 stream */
function feishuFileType(name: string): "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream" {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (ext === "pdf") return "pdf";
  if (ext === "doc" || ext === "docx") return "doc";
  if (ext === "xls" || ext === "xlsx" || ext === "csv") return "xls";
  if (ext === "ppt" || ext === "pptx") return "ppt";
  if (ext === "mp4") return "mp4";
  if (ext === "opus") return "opus";
  return "stream";
}

export const feishuDriver: ImChannelDriver = {
  channel: "feishu",
  maxTextLength: 4000,
  richTextLength: FEISHU_CARD_BODY_LIMIT,
  async login(callbacks: ImLoginCallbacks): Promise<ImLoginResult> {
    let domain = "feishu";
    const result = await lark.registerApp({
      source: "superhive",
      signal: callbacks.signal,
      addons: ADDONS,
      appPreset: { name: "SuperHive 助手", desc: "把飞书消息转进 SuperHive 房间" },
      onQRCodeReady: (info) => callbacks.onQr(info.url, info.expireIn),
      onStatusChange: (info) => {
        if (info.status === "domain_switched") domain = "lark";
      },
    });
    const ownerActorId = result.user_info?.open_id;
    if (!ownerActorId) throw new Error("没有拿到扫码人的身份，请重试。");
    if (result.user_info?.tenant_brand === "lark") domain = "lark";
    const name = await botName(result.client_id, result.client_secret, domain);
    return {
      ownerActorId,
      label: name ?? "飞书机器人",
      config: { appId: result.client_id, domain, [CARD_CALLBACKS_CONFIG]: "1" },
      secret: result.client_secret,
      identityKey: "appId",
    };
  },
  createTransport({ config, secret }) {
    return new FeishuTransport(config, secret);
  },
};
