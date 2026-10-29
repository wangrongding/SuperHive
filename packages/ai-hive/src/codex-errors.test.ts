import { describe, expect, it } from "vitest";
import { codexStartupFailure } from "./codex-errors.js";
import { AgentNonRetryableError } from "./responder.js";
describe("Codex safe startup diagnostics", () => {
  it.each([
    "Error: stdin is not a terminal",
    "ERROR: TERM is set to dumb. interactive TUI not a TTY",
  ])("explains stdio startup rejection without leaking stderr: %s", (stderr) => {
    const error = codexStartupFailure(
      "mcp-server initialize",
      Object.assign(new Error("Connection closed"), { code: -32000 }),
      stderr + " Bearer TOP_SECRET",
    );
    expect(error).toBeInstanceOf(AgentNonRetryableError);
    expect(error.message).toContain("交互终端");
    expect(error.message).not.toContain("TOP_SECRET");
  });
  it("retains the stage and safe RPC code but not arbitrary payloads", () => {
    const e = codexStartupFailure(
      "app-server initialize",
      Object.assign(new Error("credential SECRET"), { code: -32602 }),
    );
    expect(e.message).toContain("initialize");
    expect(e.message).toContain("-32602");
    expect(e.message).not.toContain("SECRET");
  });
});
