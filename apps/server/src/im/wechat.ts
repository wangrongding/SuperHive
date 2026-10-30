import { WeChatBot, type Credentials, type IncomingMessage } from "@wechatbot/wechatbot";
import type { ImConfig } from "./im-store.js";
import type {
  ImChannelDriver,
  ImInbound,
  ImKeyValue,
  ImLoginCallbacks,
  ImLoginResult,
  ImTransport,
  ImTransportEvents,
} from "./types.js";

/**
 * 个人微信：经 @wechatbot/wechatbot@2.2.0 走腾讯 iLink 通道（ilinkai.weixin.qq.com），
 * 扫码登录后长轮询收消息。这不是公开文档化的开放平台能力，有平台政策、封号和隐私风险，
 * 因此默认不显示、房主确认风险后才能启用，HIVE_IM_WECHAT=0 可整体关闭（参考 Zwork ADR-0090）。
 * 凭据只经加密存储，不用 SDK 默认的明文 ~/.wechatbot；只接受登录账号本人在私聊里发的文字。
 */
export const WECHAT_AUTHORITY_HOSTS = ["ilinkai.weixin.qq.com"];

function checkAuthority(value: unknown): void {
  if (typeof value !== "string") throw new Error("微信服务地址无效");
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !WECHAT_AUTHORITY_HOSTS.includes(url.hostname)
  ) {
    throw new Error(`拒绝未知的微信服务地址：${url.hostname}`);
  }
}

/** SDK 的存储接口落到加密的键值表上 */
function storageOf(kv: ImKeyValue) {
  return {
    async get<T>(key: string): Promise<T | undefined> {
      const raw = kv.get(key);
      return raw === undefined ? undefined : (JSON.parse(raw) as T);
    },
    async set<T>(key: string, value: T): Promise<void> {
      kv.set(key, JSON.stringify(value));
    },
    async delete(key: string): Promise<void> {
      kv.delete(key);
    },
    async has(key: string): Promise<boolean> {
      return kv.get(key) !== undefined;
    },
    async clear(): Promise<void> {
      kv.delete();
    },
  };
}

type PrivateApi = {
  api?: Record<string, (...args: unknown[]) => Promise<unknown>>;
  poller?: {
    listenerCount(event: string): number;
    removeAllListeners(event: string): unknown;
    on(event: string, listener: () => void): unknown;
  };
};

/**
 * SDK 的扫码请求不可取消，且会跟随服务端给的 redirect_host：包一层，取消时立即中止，
 * 并只允许跳到白名单里的地址。依赖 2.2.0 的私有结构，版本变化时直接失败而不是静默放行。
 */
function guardQrLogin(bot: WeChatBot, signal: AbortSignal): void {
  const api = (bot as unknown as PrivateApi).api;
  for (const method of ["getQrCode", "pollQrStatus"]) {
    const original = api?.[method];
    if (!api || typeof original !== "function") throw new Error("微信 SDK 版本不匹配");
    api[method] = async (...args: unknown[]) => {
      checkAuthority(args[0]);
      if (signal.aborted) throw new Error("已取消");
      const result = await new Promise<unknown>((resolve, reject) => {
        const abort = () => reject(new Error("已取消"));
        signal.addEventListener("abort", abort, { once: true });
        original
          .apply(api, args)
          .then(resolve, reject)
          .finally(() => {
            signal.removeEventListener("abort", abort);
          });
      });
      const redirect = (result as { redirect_host?: unknown } | undefined)?.redirect_host;
      if (redirect !== undefined && !WECHAT_AUTHORITY_HOSTS.includes(String(redirect))) {
        throw new Error("拒绝未知的微信跳转地址");
      }
      return result;
    };
  }
}

function newBot(kv: ImKeyValue): WeChatBot {
  return new WeChatBot({ storage: storageOf(kv), logLevel: "silent", botAgent: "AIHive/0.1" });
}

function messageId(message: IncomingMessage): string | undefined {
  const id = message.raw.message_id;
  if (typeof id === "number" && Number.isFinite(id) && id > 0) return String(id);
  const clientId = message.raw.client_id?.trim();
  return clientId || undefined;
}

/** 只取真正的文字项：SDK 的 text 会把图片、文件拼成占位文字，不能当作房主说的话 */
export function normalizeWeChatMessage(message: IncomingMessage): ImInbound | undefined {
  const externalId = messageId(message);
  const senderId = message.userId?.trim();
  if (!externalId || !senderId) return undefined;
  const groupId = message.raw.group_id?.trim();
  const text = (message.raw.item_list ?? [])
    .filter((item) => item.type === 1 && typeof item.text_item?.text === "string")
    .map((item) => item.text_item!.text!)
    .join("\n")
    .trim();
  return {
    externalId,
    chatId: groupId || senderId,
    chatType: groupId ? "group" : "p2p",
    senderId,
    text,
    ...(text ? {} : { unsupported: true }),
  };
}

class WeChatTransport implements ImTransport {
  private readonly bot: WeChatBot;
  private stopped = false;

  constructor(kv: ImKeyValue) {
    this.bot = newBot(kv);
  }

  async start(events: ImTransportEvents): Promise<void> {
    if (!(await this.bot.storage.has("credentials"))) {
      throw new Error("微信登录已失效，请重新扫码。");
    }
    // 只恢复已保存的登录，不在后台自己弹二维码
    const credentials = await this.bot.login({
      callbacks: {
        onVerifyCode: async () => {
          throw new Error("微信登录已失效，请重新扫码。");
        },
      },
    });
    checkAuthority(credentials.baseUrl);
    this.bot.onMessage((message) => {
      const inbound = normalizeWeChatMessage(message);
      if (inbound) events.onMessage(inbound);
    });
    // SDK 默认在会话过期时清掉登录并自动重新扫码；改成直接停下，由房主在网页上重新连接
    const poller = (this.bot as unknown as PrivateApi).poller;
    if (!poller || poller.listenerCount("session:expired") !== 1) {
      throw new Error("微信 SDK 版本不匹配");
    }
    poller.removeAllListeners("session:expired");
    poller.on("session:expired", () => {
      this.bot.stop();
      events.onStatus("error", "微信登录已过期，请重新扫码连接。");
    });
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (!settled) {
          settled = true;
          fn();
        }
      };
      this.bot.once("poll:start", () => finish(resolve));
      this.bot.once("error", (error: unknown) =>
        finish(() => reject(error instanceof Error ? error : new Error(String(error)))),
      );
      this.bot.start().then(
        () => {
          if (!this.stopped) events.onStatus("error", "微信消息轮询已停止。");
          finish(resolve);
        },
        (error: unknown) => {
          if (!this.stopped)
            events.onStatus("error", error instanceof Error ? error.message : String(error));
          finish(() => reject(error instanceof Error ? error : new Error(String(error))));
        },
      );
    });
    events.onStatus("connected");
  }

  async sendText(chatId: string, text: string): Promise<string | undefined> {
    checkAuthority(this.bot.getCredentials()?.baseUrl);
    await this.bot.send(chatId, text);
    return undefined;
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.bot.stop();
  }
}

export const wechatDriver: ImChannelDriver = {
  channel: "wechat",
  // 个人微信只有纯文本，单条不宜太长
  maxTextLength: 1800,
  async login(callbacks: ImLoginCallbacks): Promise<ImLoginResult> {
    const bot = newBot(callbacks.kv);
    guardQrLogin(bot, callbacks.signal);
    const credentials: Credentials = await bot.login({
      force: true,
      callbacks: {
        onQrUrl: (url) => callbacks.onQr(url),
        onScanned: () => callbacks.onScanned(),
        onVerifyCode: (isRetry) => callbacks.requestCode(isRetry),
      },
    });
    checkAuthority(credentials.baseUrl);
    if (!credentials.userId) throw new Error("没有拿到扫码人的身份，请重试。");
    return {
      ownerActorId: credentials.userId,
      label: "个人微信",
      config: { accountId: credentials.accountId } satisfies ImConfig,
      secret: "",
      identityKey: "accountId",
    };
  },
  createTransport({ kv }) {
    return new WeChatTransport(kv);
  },
};
