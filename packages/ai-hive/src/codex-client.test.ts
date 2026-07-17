import { describe, expect, it, vi } from "vitest";
import { CodexMcpResponder, isMissingCodexThread } from "./codex-client.js";

const options = {
  command: "codex",
  cwd: "/workspace",
  hive: {
    serverUrl: "http://localhost:8787",
    roomId: "general",
    username: "codex-agent",
    token: "test-token",
  },
};

const tools = [
  { name: "codex-reply" },
  {
    name: "codex",
    inputSchema: {
      properties: {
        prompt: {},
        cwd: {},
        sandbox: {},
        "approval-policy": {},
        "developer-instructions": {},
      },
    },
  },
];

describe("CodexMcpResponder", () => {
  it.each([
    ["read-only", "read-only", "untrusted"],
    ["workspace", "workspace-write", "never"],
    ["full", "danger-full-access", "never"],
  ] as const)(
    "maps %s access to the Codex sandbox",
    async (access, expectedSandbox, expectedApproval) => {
      const callTool = vi.fn(async () => ({
        structuredContent: { content: "ok", threadId: `thread-${access}` },
      }));
      const responder = new CodexMcpResponder(
        { ...options, access },
        { client: { callTool }, tools },
      );

      await responder.reply({ instructions: "Hive rules", prompt: "Shared context" });

      expect(callTool).toHaveBeenCalledWith({
        name: "codex",
        arguments: expect.objectContaining({
          cwd: "/workspace",
          sandbox: expectedSandbox,
          "approval-policy": expectedApproval,
        }),
      });
    },
  );

  it("starts a new thread when a persisted MCP thread is no longer available", async () => {
    const callTool = vi.fn(async (request: { name: string }) => {
      if (request.name === "codex-reply") {
        throw new Error("Session not found for thread_id: 019f60d7-840b-7871-9880-8445c382d278");
      }
      return {
        structuredContent: {
          content: "已使用新会话恢复",
          threadId: "019f612f-1111-7111-8111-111111111111",
        },
      };
    });
    const log = vi.fn();
    const responder = new CodexMcpResponder(options, {
      client: { callTool },
      tools,
      log,
    });

    await expect(
      responder.reply({
        instructions: "Hive rules",
        prompt: "Shared context",
        threadId: "019f60d7-840b-7871-9880-8445c382d278",
      }),
    ).resolves.toEqual({
      text: "已使用新会话恢复",
      threadId: "019f612f-1111-7111-8111-111111111111",
    });
    expect(callTool.mock.calls.map(([request]) => request.name)).toEqual(["codex-reply", "codex"]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("自动创建新会话"));
  });

  it("does not hide unrelated Codex reply failures", async () => {
    const callTool = vi.fn(async () => {
      throw new Error("HTTP 502");
    });
    const responder = new CodexMcpResponder(options, {
      client: { callTool },
      tools,
    });

    await expect(
      responder.reply({
        instructions: "Hive rules",
        prompt: "Shared context",
        threadId: "old-thread",
      }),
    ).rejects.toThrow("HTTP 502");
    expect(callTool).toHaveBeenCalledTimes(1);
  });
});

describe("isMissingCodexThread", () => {
  it("recognizes nested MCP errors", () => {
    expect(
      isMissingCodexThread(
        new Error("MCP call failed", {
          cause: new Error("Session not found for thread_id: old-thread"),
        }),
      ),
    ).toBe(true);
  });
});
