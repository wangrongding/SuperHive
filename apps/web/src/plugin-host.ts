import {
  pluginMethodPermissions,
  type PluginContext,
  type PluginErrorCode,
  type PluginHostMessage,
  type PluginMethod,
  type PluginSummary,
} from "@superhive/protocol";

/**
 * 插件面板的宿主一侧（原型，见 docs/research/plugin-system.md）。
 * 面板跑在无同源的 sandbox iframe 里，只能 postMessage 过来；这里按 event.source 认出是哪个面板，
 * 每个请求都现查批准过的权限再回答，插件拿到的只有方法的返回值。
 */
export type PluginHostApi = {
  context: () => PluginContext;
  /** 当前查看者能看到的最近消息（已经是网页里有的数据，不额外取） */
  messages: (
    limit: number,
  ) => Array<{ seq: number; sender: string; content: string; createdAt: string }>;
  members: () => Array<{ name: string; type: "human" | "agent"; online: boolean }>;
  /** 往输入框里追加文字；不替人发送 */
  insertIntoComposer: (text: string) => void;
};

const MAX_TEXT = 4000;
const MAX_MESSAGES = 50;

type Frame = Pick<HTMLIFrameElement, "contentWindow">;

export function createPluginHost(options: {
  frame: Frame;
  plugin: PluginSummary;
  api: PluginHostApi;
  /** 测试替换；默认挂在 window 上 */
  target?: Pick<Window, "addEventListener" | "removeEventListener">;
}): {
  dispatchCommand: (name: string, args: string) => void;
  /** 主题、语言、房间变了时告诉面板 */
  dispatchContext: (context: PluginContext) => void;
  dispose: () => void;
} {
  const target = options.target ?? window;
  const granted = new Set(options.plugin.permissions);
  // 面板是不透明源，postMessage 只能发 "*"；只发给这个 iframe 自己的 window
  const post = (message: PluginHostMessage) =>
    options.frame.contentWindow?.postMessage(message, "*");
  const fail = (id: number, code: PluginErrorCode, message: string) =>
    post({ superhive: 1, kind: "error", id, code, message });

  const handle = (method: PluginMethod, params: unknown): unknown => {
    switch (method) {
      case "context.get":
        return options.api.context();
      case "room.messages": {
        const limit = Math.min(
          MAX_MESSAGES,
          Math.max(1, Number((params as { limit?: unknown } | undefined)?.limit) || 20),
        );
        return options.api.messages(limit);
      }
      case "room.members":
        return options.api.members();
      case "composer.insert": {
        const text = (params as { text?: unknown } | undefined)?.text;
        if (typeof text !== "string" || !text.trim() || text.length > MAX_TEXT)
          throw new BadParams("text 要是 1～4000 字的字符串");
        options.api.insertIntoComposer(text);
        return { ok: true };
      }
    }
  };

  const listener = (event: MessageEvent) => {
    if (!options.frame.contentWindow || event.source !== options.frame.contentWindow) return;
    const data = event.data as {
      superhive?: unknown;
      kind?: unknown;
      id?: unknown;
      method?: unknown;
      params?: unknown;
    };
    if (!data || data.superhive !== 1 || data.kind !== "request" || typeof data.id !== "number")
      return;
    const id = data.id;
    const method = data.method;
    if (typeof method !== "string" || !Object.hasOwn(pluginMethodPermissions, method))
      return fail(id, "UNKNOWN_METHOD", `没有方法 ${String(method)}`);
    const needed = pluginMethodPermissions[method as PluginMethod];
    if (needed && !granted.has(needed)) return fail(id, "PERMISSION_DENIED", `需要权限 ${needed}`);
    try {
      post({
        superhive: 1,
        kind: "result",
        id,
        result: handle(method as PluginMethod, data.params),
      });
    } catch (error) {
      if (error instanceof BadParams) fail(id, "BAD_PARAMS", error.message);
      else fail(id, "FAILED", "宿主处理失败");
    }
  };
  target.addEventListener("message", listener as EventListener);
  return {
    dispatchCommand: (name, args) =>
      post({ superhive: 1, kind: "event", event: "command", data: { name, args } }),
    dispatchContext: (context) =>
      post({ superhive: 1, kind: "event", event: "context", data: context }),
    dispose: () => target.removeEventListener("message", listener as EventListener),
  };
}

class BadParams extends Error {}

/** 输入框里的 /命令：只认已启用插件声明过的命令，没认出来就当普通消息 */
export function matchPluginCommand(
  text: string,
  plugins: PluginSummary[],
): { plugin: PluginSummary; panel: string; name: string; args: string } | undefined {
  const match = /^\/([a-z][a-z0-9-]{0,23})(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return undefined;
  for (const plugin of plugins) {
    const command = plugin.commands.find((item) => item.name === match[1]);
    if (command)
      return { plugin, panel: command.panel, name: command.name, args: (match[2] ?? "").trim() };
  }
  return undefined;
}
