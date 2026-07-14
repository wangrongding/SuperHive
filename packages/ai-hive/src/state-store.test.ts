import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore, type AgentState } from "./state-store.js";

describe("StateStore", () => {
  let directory: string | undefined;
  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("persists thread, cursor, and processed mention ids", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "hive-state-test-"));
    const identity = { serverUrl: "http://localhost:8787", roomId: "general", username: "agent-a" };
    const store = new StateStore(directory, identity);
    const state: AgentState = {
      ...identity,
      threadId: "thread-1",
      lastProcessedSeq: 42,
      processedMessageIds: ["message-1"],
    };
    await store.save(state);
    expect(await store.load()).toEqual(state);
  });

  it("keeps state separate when the same identity uses different providers", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "hive-provider-state-test-"));
    const identity = { serverUrl: "http://localhost:8787", roomId: "general", username: "agent-a" };
    const codex = new StateStore(directory, { ...identity, provider: "codex" });
    const claude = new StateStore(directory, { ...identity, provider: "claude" });

    expect(codex.filename).not.toBe(claude.filename);
  });
});
