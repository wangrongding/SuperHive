import { describe, expect, it, vi } from "vitest";
import type { PluginSummary } from "@superhive/protocol";
import { createPluginHost, matchPluginCommand } from "./plugin-host";

const plugin: PluginSummary = {
  id: "dice",
  name: "骰子",
  version: "0.1.0",
  description: "",
  permissions: ["members:read", "composer:write"],
  panels: [{ id: "main", title: "骰子", entry: "panel.html" }],
  commands: [{ name: "roll", description: "掷骰子", panel: "main" }],
};

function setup() {
  const frameWindow = { postMessage: vi.fn() };
  const other = { postMessage: vi.fn() };
  let listener: ((event: MessageEvent) => void) | undefined;
  const target = {
    addEventListener: (_: string, fn: EventListener) => (listener = fn as never),
    removeEventListener: vi.fn(),
  };
  const api = {
    context: () => ({
      roomId: "r1",
      locale: "zh-CN",
      theme: "dark" as const,
      viewer: "owner" as const,
    }),
    messages: vi.fn(() => []),
    members: () => [{ name: "rd", type: "human" as const, online: true }],
    insertIntoComposer: vi.fn(),
  };
  const host = createPluginHost({
    frame: { contentWindow: frameWindow as unknown as Window },
    plugin,
    api,
    target: target as never,
  });
  const send = (data: unknown, source: unknown = frameWindow) =>
    listener!({ data, source } as MessageEvent);
  return { host, send, frameWindow, other, api, target };
}

const request = (id: number, method: string, params?: unknown) => ({
  superhive: 1,
  kind: "request",
  id,
  method,
  params,
});

describe("createPluginHost", () => {
  it("按批准的权限回答", () => {
    const { send, frameWindow, api } = setup();
    send(request(1, "room.members"));
    send(request(2, "composer.insert", { text: "🎲 6" }));
    expect(frameWindow.postMessage).toHaveBeenNthCalledWith(
      1,
      {
        superhive: 1,
        kind: "result",
        id: 1,
        result: [{ name: "rd", type: "human", online: true }],
      },
      "*",
    );
    expect(api.insertIntoComposer).toHaveBeenCalledWith("🎲 6");
  });

  it("没批准的权限、不认识的方法都拒绝", () => {
    const { send, frameWindow, api } = setup();
    send(request(1, "room.messages"));
    send(request(2, "shell.exec"));
    send(request(3, "__proto__"));
    expect(api.messages).not.toHaveBeenCalled();
    expect(frameWindow.postMessage.mock.calls.map(([message]) => message.code)).toEqual([
      "PERMISSION_DENIED",
      "UNKNOWN_METHOD",
      "UNKNOWN_METHOD",
    ]);
  });

  it("不是这个面板发来的消息不理", () => {
    const { send, frameWindow, other } = setup();
    send(request(1, "room.members"), other);
    send(request(2, "room.members"), null);
    expect(frameWindow.postMessage).not.toHaveBeenCalled();
  });

  it("参数不对时回 BAD_PARAMS", () => {
    const { send, frameWindow, api } = setup();
    send(request(1, "composer.insert", { text: "x".repeat(5000) }));
    expect(frameWindow.postMessage.mock.calls[0]![0].code).toBe("BAD_PARAMS");
    expect(api.insertIntoComposer).not.toHaveBeenCalled();
  });
});

describe("matchPluginCommand", () => {
  it("只认插件声明过的命令", () => {
    expect(matchPluginCommand("/roll 2d6", [plugin])).toMatchObject({
      name: "roll",
      args: "2d6",
      panel: "main",
    });
    expect(matchPluginCommand("/unknown", [plugin])).toBeUndefined();
    expect(matchPluginCommand("roll 2d6", [plugin])).toBeUndefined();
  });
});
