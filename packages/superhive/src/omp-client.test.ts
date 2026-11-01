import { describe, expect, it, vi } from "vitest";
import { createOmpResponder, ompToolArgs } from "./omp-client.js";
import type { StdioTransport } from "./stdio-transport.js";

const hive = {
  serverUrl: "http://localhost:8787",
  roomId: "general",
  username: "omp-agent",
  token: "test-token",
};

describe("omp ACP profile", () => {
  it("maps access modes to tool allowlists", () => {
    expect(ompToolArgs("read-only")).toEqual(["--tools", "read,grep,glob"]);
    expect(ompToolArgs("workspace")).toEqual(["--tools", "read,grep,glob,edit,write,bash"]);
    expect(ompToolArgs("full")).toEqual([]);
  });

  it("starts omp in ACP mode without title generation", async () => {
    const createTransport = vi.fn((): StdioTransport => ({
      write: () => undefined,
      onLine: () => undefined,
      onExit: () => undefined,
      kill: () => undefined,
    }));
    const responder = createOmpResponder(
      { command: "omp", cwd: "/workspace", hive, model: "zhipu-coding-plan/glm-5.3" },
      { createTransport, requestTimeoutMs: 1 },
    );

    await expect(responder.reply({ instructions: "rules", prompt: "hi" })).rejects.toThrow();
    expect(createTransport).toHaveBeenCalledWith(
      "omp",
      [
        "--mode",
        "acp",
        "--cwd",
        "/workspace",
        "--no-title",
        "--tools",
        "read,grep,glob",
        "--model",
        "zhipu-coding-plan/glm-5.3",
      ],
      { cwd: "/workspace" },
    );
  });
});
