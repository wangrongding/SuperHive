import * as lark from "@larksuiteoapi/node-sdk";
import type { ImConfig } from "./im-store.js";
import type {
  ImChannelDriver,
  ImInbound,
  ImLoginCallbacks,
  ImLoginResult,
  ImTransport,
  ImTransportEvents,
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
    ],
  },
  events: { items: { tenant: ["im.message.receive_v1"] } },
};

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
  try {
    const content = JSON.parse(message.content) as { text?: string };
    if (message.message_type === "text") text = content.text ?? "";
    else if (message.message_type === "post") text = postText(content);
    else unsupported = true;
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
    ...(unsupported ? { unsupported } : {}),
  };
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
    });
    this.socket = new lark.WSClient({
      appId: this.config.appId!,
      appSecret: this.appSecret,
      domain: sdkDomain(this.config.domain),
      loggerLevel: lark.LoggerLevel.error,
      source: "ai-hive",
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
    const content = JSON.stringify({ text });
    if (replyTo) {
      const result = await this.client.im.message.reply({
        path: { message_id: replyTo },
        data: { msg_type: "text", content },
      });
      if (result.code === 0) return result.data?.message_id;
      // 原消息被撤回等情况下退回到直接发到会话
    }
    const result = await this.client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: chatId, msg_type: "text", content },
    });
    if (result.code !== 0) throw new Error(result.msg || `飞书返回错误 ${result.code}`);
    return result.data?.message_id;
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

export const feishuDriver: ImChannelDriver = {
  channel: "feishu",
  maxTextLength: 4000,
  async login(callbacks: ImLoginCallbacks): Promise<ImLoginResult> {
    let domain = "feishu";
    const result = await lark.registerApp({
      source: "ai-hive",
      signal: callbacks.signal,
      addons: ADDONS,
      appPreset: { name: "AI Hive 助手", desc: "把飞书消息转进 AI Hive 房间" },
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
      config: { appId: result.client_id, domain },
      secret: result.client_secret,
      identityKey: "appId",
    };
  },
  createTransport({ config, secret }) {
    return new FeishuTransport(config, secret);
  },
};
