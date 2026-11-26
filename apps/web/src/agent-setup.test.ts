import { describe, expect, it } from "vitest";
import { guestAgentCommand } from "./agent-setup";

const base =
  "npx --yes superhive@latest join --server http://10.0.0.2:8787 --room kx001 --name caibao-claude --token abc";

describe("guestAgentCommand", () => {
  it("adds the runtime and --background so closing the terminal keeps it online", () => {
    expect(guestAgentCommand(base, "claude")).toBe(
      "npx --yes superhive@latest join --provider claude --server http://10.0.0.2:8787 --room kx001 --name caibao-claude --token abc --background",
    );
  });

  it("keeps an explicit runtime and doesn't add --background twice", () => {
    const command = `${base} --provider agy --background`;
    expect(guestAgentCommand(command, "claude")).toBe(command);
  });

  it("configures OpenClaw's MCP", () => {
    expect(guestAgentCommand(base, "openclaw")).toContain("--openclaw-configure-mcp --background");
  });
});
