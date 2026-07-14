import { describe, expect, it, vi } from "vitest";
import { ClaudeCodeResponder } from "./claude-client.js";
import type { CommandRunner } from "./command-runner.js";

const hive = {
  serverUrl: "http://localhost:8787",
  roomId: "general",
  username: "claude-agent",
  token: "test-token",
};

describe("ClaudeCodeResponder", () => {
  it("runs Claude Code in read-only print mode and resumes its session", async () => {
    const runner = vi.fn<CommandRunner>(async () => ({
      stdout: JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "来自 Claude 的回复",
        session_id: "11111111-1111-4111-8111-111111111111",
      }),
      stderr: "",
    }));
    const responder = new ClaudeCodeResponder({
      command: "claude",
      cwd: "/workspace",
      hive,
      model: "sonnet",
      runner,
    });

    await expect(
      responder.reply({
        instructions: "Hive rules",
        prompt: "Shared context",
        threadId: "00000000-0000-4000-8000-000000000001",
      }),
    ).resolves.toEqual({
      text: "来自 Claude 的回复",
      threadId: "11111111-1111-4111-8111-111111111111",
    });
    const args = runner.mock.calls[0]?.[1] ?? [];
    expect(args).toContain("--permission-mode");
    expect(args).toContain("plan");
    expect(args).toContain("--mcp-config");
    expect(args.join(" ")).toContain("hive_message_send");
    expect(args.join(" ")).toContain("X-Hive-Agent-Name");
    expect(args).toContain("sonnet");
    expect(args).toContain("00000000-0000-4000-8000-000000000001");
    expect(args).not.toContain("Shared context");
    expect(runner.mock.calls[0]?.[2]).toMatchObject({ input: "Shared context" });
  });

  it("rejects malformed or empty Claude Code results", async () => {
    const malformed = new ClaudeCodeResponder({
      command: "claude",
      cwd: "/workspace",
      hive,
      runner: async () => ({ stdout: "not-json", stderr: "" }),
    });
    await expect(malformed.reply({ instructions: "rules", prompt: "context" })).rejects.toThrow(
      /无法解析/,
    );

    const empty = new ClaudeCodeResponder({
      command: "claude",
      cwd: "/workspace",
      hive,
      runner: async () => ({
        stdout: JSON.stringify({ is_error: true, subtype: "error", result: "" }),
        stderr: "",
      }),
    });
    await expect(empty.reply({ instructions: "rules", prompt: "context" })).rejects.toThrow(
      /没有返回/,
    );
  });
});
