import { describe, expect, it, vi } from "vitest";
import type { CommandRunner } from "./command-runner.js";
import { OpenClawResponder } from "./openclaw-client.js";

describe("OpenClawResponder", () => {
  it("parses Gateway payloads and reuses the explicit session", async () => {
    const runner = vi.fn<CommandRunner>(async () => ({
      stdout: JSON.stringify({
        status: "ok",
        result: { payloads: [{ text: "第一段" }, { text: "第二段" }] },
      }),
      stderr: "",
    }));
    const responder = new OpenClawResponder({
      command: "openclaw",
      cwd: "/workspace",
      local: false,
      agentId: "main",
      model: "openai/gpt-5",
      runner,
    });

    await expect(
      responder.reply({
        instructions: "Hive rules",
        prompt: "Shared context",
        threadId: "openclaw-session-1",
        refreshInstructions: true,
      }),
    ).resolves.toEqual({ text: "第一段\n\n第二段", threadId: "openclaw-session-1" });
    expect(runner).toHaveBeenCalledWith(
      "openclaw",
      [
        "agent",
        "--session-id",
        "openclaw-session-1",
        "--message",
        "Hive rules\n\n---\n\nShared context",
        "--json",
        "--agent",
        "main",
        "--model",
        "openai/gpt-5",
      ],
      { cwd: "/workspace" },
    );
  });

  it("supports embedded output and the --local switch", async () => {
    const runner = vi.fn<CommandRunner>(async () => ({
      stdout: JSON.stringify({
        payloads: [{ text: "embedded reply" }],
        meta: { agentMeta: { sessionId: "embedded-session" } },
      }),
      stderr: "",
    }));
    const responder = new OpenClawResponder({
      command: "openclaw",
      cwd: "/workspace",
      local: true,
      runner,
    });

    await expect(responder.reply({ instructions: "rules", prompt: "context" })).resolves.toEqual({
      text: "embedded reply",
      threadId: "embedded-session",
    });
    expect(runner.mock.calls[0]?.[1]).toContain("--local");
  });

  it("does not repeat the rules inside a resumed session unless asked to refresh", async () => {
    const runner = vi.fn<CommandRunner>(async () => ({
      stdout: JSON.stringify({ payloads: [{ text: "ok" }] }),
      stderr: "",
    }));
    const responder = new OpenClawResponder({
      command: "openclaw",
      cwd: "/w",
      local: true,
      runner,
    });
    await responder.reply({ instructions: "Hive rules", prompt: "delta", threadId: "s1" });
    const args = runner.mock.calls[0]?.[1] ?? [];
    expect(args[args.indexOf("--message") + 1]).toBe("delta");
  });
});
