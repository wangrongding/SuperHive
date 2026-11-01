import { describe, expect, it, vi } from "vitest";
import {
  createOpenCodeResponder,
  openCodeConfigContent,
  openCodePermission,
} from "./opencode-client.js";
import type { StdioTransport } from "./stdio-transport.js";

const hive = {
  serverUrl: "http://localhost:8787",
  roomId: "general",
  username: "opencode-agent",
  token: "test-token",
};

describe("OpenCode ACP profile", () => {
  it("removes write, shell and network tools in read-only mode", () => {
    expect(openCodePermission("read-only")).toEqual({
      edit: "deny",
      bash: "deny",
      webfetch: "deny",
      websearch: "deny",
      task: "deny",
      external_directory: "deny",
      doom_loop: "deny",
    });
  });

  it("keeps workspace file tools inside cwd and allows everything in full mode", () => {
    expect(openCodePermission("workspace")).toMatchObject({
      edit: "allow",
      bash: "allow",
      external_directory: "deny",
    });
    expect(openCodePermission("full")).toBe("allow");
  });

  it("layers the permission and model on top of inherited inline config", () => {
    expect(
      JSON.parse(
        openCodeConfigContent(
          "read-only",
          "zhipu-coding/glm-5.3",
          JSON.stringify({ theme: "x", permission: "allow" }),
        ),
      ),
    ).toEqual({
      theme: "x",
      permission: openCodePermission("read-only"),
      model: "zhipu-coding/glm-5.3",
    });
    expect(JSON.parse(openCodeConfigContent("full", undefined, "not json"))).toEqual({
      permission: "allow",
    });
  });

  it("starts `opencode acp` in cwd with the inline config", async () => {
    const createTransport = vi.fn((): StdioTransport => ({
      write: () => undefined,
      onLine: () => undefined,
      onExit: () => undefined,
      kill: () => undefined,
    }));
    const responder = createOpenCodeResponder(
      { command: "opencode", cwd: "/workspace", hive, access: "workspace", model: "p/m" },
      { createTransport, requestTimeoutMs: 1 },
    );

    await expect(responder.reply({ instructions: "rules", prompt: "hi" })).rejects.toThrow();
    const [command, args, options] = createTransport.mock.calls[0] as unknown as [
      string,
      string[],
      { cwd: string; env: Record<string, string> },
    ];
    expect(command).toBe("opencode");
    expect(args).toEqual(["acp", "--cwd", "/workspace"]);
    expect(options.cwd).toBe("/workspace");
    expect(JSON.parse(options.env.OPENCODE_CONFIG_CONTENT!)).toMatchObject({
      model: "p/m",
      permission: { external_directory: "deny" },
    });
  });
});
