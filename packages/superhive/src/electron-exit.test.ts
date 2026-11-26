import { describe, expect, it } from "vitest";
import { shouldExitAfterCommand } from "./electron-exit.js";

describe("shouldExitAfterCommand", () => {
  it("never forces an exit under plain node", () => {
    expect(shouldExitAfterCommand({ command: "mcp", failed: false, electron: false })).toBe(false);
    expect(shouldExitAfterCommand({ command: "join", failed: true, electron: false })).toBe(false);
  });

  it("exits after one-shot commands under Electron but keeps a running join", () => {
    for (const command of ["mcp", "models", "--version", "--help", undefined]) {
      expect(shouldExitAfterCommand({ command, failed: false, electron: true })).toBe(true);
    }
    expect(shouldExitAfterCommand({ command: "join", failed: false, electron: true })).toBe(false);
  });

  it("exits when any command fails under Electron, including join", () => {
    expect(shouldExitAfterCommand({ command: "join", failed: true, electron: true })).toBe(true);
  });
});

describe("shouldExitAfterCommand with --background", () => {
  it("exits once join has handed off to the background process", () => {
    expect(
      shouldExitAfterCommand({ command: "join", failed: false, electron: true, background: true }),
    ).toBe(true);
  });
});
