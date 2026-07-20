import { describe, expect, it, vi } from "vitest";
import type { CommandRunner } from "./command-runner.js";
import { CopilotResponder } from "./copilot-client.js";

const hive = {
  serverUrl: "http://localhost:8787",
  roomId: "general",
  username: "copilot-agent",
  token: "test-token",
};

describe("CopilotResponder", () => {
  it("uses a restricted plan session and parses Copilot JSONL", async () => {
    const runner = vi.fn<CommandRunner>(async () => ({
      stdout: [
        "non-json diagnostic",
        JSON.stringify({
          type: "session.start",
          data: { sessionId: "11111111-1111-4111-8111-111111111111" },
        }),
        JSON.stringify({
          type: "assistant.message",
          data: { content: "来自 Copilot 的回复" },
        }),
      ].join("\n"),
      stderr: "",
    }));
    const responder = new CopilotResponder({
      command: "copilot",
      cwd: "/workspace",
      hive,
      model: "gpt-5",
      runner,
    });

    await expect(
      responder.reply({
        instructions: "Hive rules",
        prompt: "Shared context",
        threadId: "00000000-0000-4000-8000-000000000001",
      }),
    ).resolves.toEqual({
      text: "来自 Copilot 的回复",
      threadId: "11111111-1111-4111-8111-111111111111",
    });
    const args = runner.mock.calls[0]?.[1] ?? [];
    expect(args).toContain("--mode");
    expect(args).toContain("plan");
    expect(args).toContain("--deny-tool=write");
    expect(args).toContain("--deny-tool=shell");
    expect(args).toContain("--disable-builtin-mcps");
    expect(args).toContain("--additional-mcp-config");
    expect(args).toContain("--allow-tool=hive");
    expect(args.join(" ")).toContain("X-Hive-Agent-Name");
    expect(args).toContain("--resume=00000000-0000-4000-8000-000000000001");
    expect(args).toContain("gpt-5");
  });

  it("starts a new session with --session-id when there is no prior threadId", async () => {
    const runner = vi.fn<CommandRunner>(async () => ({
      stdout: JSON.stringify({ type: "assistant.message", data: { content: "ok" } }),
      stderr: "",
    }));
    const responder = new CopilotResponder({
      command: "copilot",
      cwd: "/workspace",
      hive,
      runner,
    });

    await responder.reply({ instructions: "rules", prompt: "context" });

    const args = runner.mock.calls[0]?.[1] ?? [];
    expect(args.some((arg) => arg.startsWith("--session-id="))).toBe(true);
    expect(args.some((arg) => arg.startsWith("--resume="))).toBe(false);
  });

  it.each(["workspace", "full"] as const)("maps %s access to Copilot", async (access) => {
    const runner = vi.fn<CommandRunner>(async () => ({
      stdout: JSON.stringify({ type: "assistant.message", data: { content: "ok" } }),
      stderr: "",
    }));
    const responder = new CopilotResponder({
      command: "copilot",
      cwd: "/workspace",
      hive,
      access,
      runner,
    });

    await responder.reply({ instructions: "rules", prompt: "context" });

    const args = runner.mock.calls[0]?.[1] ?? [];
    expect(args[args.indexOf("--mode") + 1]).toBe("interactive");
    if (access === "workspace") {
      expect(args).toContain("--allow-tool=write");
      expect(args).toContain("--allow-tool=shell");
      expect(args).toContain("--no-remote");
      expect(args).toContain("--disallow-temp-dir");
      expect(args).not.toContain("--allow-all");
    } else {
      expect(args).toContain("--allow-all");
      expect(args).not.toContain("--disable-builtin-mcps");
      expect(args).not.toContain("--no-remote");
    }
  });

  it("rejects output without a final assistant message", async () => {
    const responder = new CopilotResponder({
      command: "copilot",
      cwd: "/workspace",
      hive,
      runner: async () => ({ stdout: "{}\n", stderr: "no response" }),
    });
    await expect(responder.reply({ instructions: "rules", prompt: "context" })).rejects.toThrow(
      /没有返回/,
    );
  });
});
