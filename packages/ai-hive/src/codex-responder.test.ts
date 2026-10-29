import { describe, expect, it, vi } from "vitest";
import { CodexAppServerUnsupportedError } from "./codex-app-server-client.js";
import { CodexResponder } from "./codex-responder.js";
import type { AgentResponder } from "./responder.js";

const hive = { serverUrl: "http://hive", roomId: "general", username: "agent", token: "t" };

describe("CodexResponder", () => {
  it("never silently falls back, even after an explicit unsupported response", async () => {
    const error = new CodexAppServerUnsupportedError("initialize unsupported");
    const appServer: AgentResponder = {
      reply: vi.fn(async () => {
        throw error;
      }),
    };
    const mcp = vi.fn();
    const responder = new CodexResponder({ command: "codex", cwd: "/w", hive }, { appServer, mcp });
    for (let i = 0; i < 2; i++)
      await expect(responder.reply({ instructions: "i", prompt: "p" })).rejects.toBe(error);
    expect(mcp).not.toHaveBeenCalled();
  });

  it("uses MCP only when explicitly selected", async () => {
    const mcp: AgentResponder = { reply: vi.fn(async () => ({ text: "legacy" })) };
    const appServer: AgentResponder = { reply: vi.fn() };
    const responder = new CodexResponder(
      { command: "codex", cwd: "/w", hive, transport: "mcp" },
      { appServer, mcp: () => mcp },
    );
    await expect(responder.reply({ instructions: "i", prompt: "p" })).resolves.toEqual({
      text: "legacy",
    });
    expect(appServer.reply).not.toHaveBeenCalled();
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
