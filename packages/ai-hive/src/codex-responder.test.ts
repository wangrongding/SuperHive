import { describe, expect, it, vi } from "vitest";
import { CodexAppServerUnsupportedError } from "./codex-app-server-client.js";
import { CodexResponder } from "./codex-responder.js";
import type { AgentResponder } from "./responder.js";

const hive = { serverUrl: "http://hive", roomId: "general", username: "agent", token: "t" };

describe("CodexResponder", () => {
  it("falls back to mcp-server once when app-server is unsupported", async () => {
    const appServer: AgentResponder = {
      reply: vi.fn(async () => {
        throw new CodexAppServerUnsupportedError("unrecognized subcommand 'app-server'");
      }),
      steer: vi.fn(async () => true),
      close: vi.fn(async () => undefined),
    };
    const mcp: AgentResponder = { reply: vi.fn(async () => ({ text: "via mcp", threadId: "t1" })) };
    const log = vi.fn();
    const responder = new CodexResponder(
      { command: "codex", cwd: "/w", hive, log },
      { appServer, mcp: () => mcp },
    );
    await expect(responder.reply({ instructions: "i", prompt: "p" })).resolves.toEqual({
      text: "via mcp",
      threadId: "t1",
    });
    await responder.reply({ instructions: "i", prompt: "p2" });
    expect(appServer.reply).toHaveBeenCalledTimes(1);
    expect(mcp.reply).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("回退到 codex mcp-server"));
    // mcp-server 不支持插入消息
    await expect(responder.steer("x")).resolves.toBe(false);
  });

  it("does not hide real app-server errors behind a fallback", async () => {
    const appServer: AgentResponder = {
      reply: vi.fn(async () => {
        throw new Error("model overloaded");
      }),
    };
    const mcp = vi.fn();
    const responder = new CodexResponder(
      { command: "codex", cwd: "/w", hive },
      { appServer, mcp: mcp as unknown as () => AgentResponder },
    );
    await expect(responder.reply({ instructions: "i", prompt: "p" })).rejects.toThrow(
      "model overloaded",
    );
    expect(mcp).not.toHaveBeenCalled();
  });
});
