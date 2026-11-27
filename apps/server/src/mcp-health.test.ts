import { describe, expect, it } from "vitest";
import { McpHealthStore, mcpFingerprint, toHealth } from "./mcp-health.js";

describe("McpHealthStore", () => {
  it("survives a restart through the persistence and ignores garbage", () => {
    let saved: string | undefined;
    const persistence = { read: () => saved, write: (value: string) => void (saved = value) };
    const store = new McpHealthStore(persistence);
    const print = mcpFingerprint({ transport: "http", config: { url: "https://a" } });
    store.set("a", print, toHealth({ ok: false, problem: "auth", error: "401" }, 5));
    const again = new McpHealthStore(persistence);
    expect(again.get("a", [print])).toEqual({
      ok: false,
      problem: "auth",
      reason: "401",
      checkedAt: 5,
    });
    expect(again.get("a", ["other"])).toBeUndefined();
    saved = "{not json";
    expect(new McpHealthStore(persistence).has("a")).toBe(false);
  });

  it("gives the same fingerprint regardless of key order and treats unclassified failures as failing to start", () => {
    expect(mcpFingerprint({ transport: "stdio", config: { command: "x", args: ["1"] } })).toBe(
      mcpFingerprint({ config: { args: ["1"], command: "x" }, transport: "stdio" }),
    );
    expect(toHealth({ ok: false, error: "x".repeat(400) }, 1)).toMatchObject({
      problem: "failed",
      reason: "x".repeat(300),
    });
  });
});
