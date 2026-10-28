import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore, agentWorkspaceDir, type AgentState } from "./state-store.js";

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

  it("keeps elevated sessions separate while preserving the legacy read-only key", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "hive-access-state-test-"));
    const identity = {
      serverUrl: "http://localhost:8787",
      roomId: "general",
      username: "agent-a",
      provider: "codex",
    };
    const legacy = new StateStore(directory, identity);
    const readOnly = new StateStore(directory, { ...identity, access: "read-only" });
    const workspace = new StateStore(directory, { ...identity, access: "workspace" });
    const full = new StateStore(directory, { ...identity, access: "full" });

    expect(readOnly.filename).toBe(legacy.filename);
    expect(workspace.filename).not.toBe(readOnly.filename);
    expect(full.filename).not.toBe(workspace.filename);
  });
});

describe("StateStore concurrent saves", () => {
  it("serialises overlapping saves and keeps the last snapshot", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "hive-state-race-"));
    try {
      const identity = { serverUrl: "http://h", roomId: "general", username: "a" };
      const store = new StateStore(directory, identity);
      await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          store.save({ ...identity, lastProcessedSeq: index, processedMessageIds: [] }),
        ),
      );
      expect((await store.load())?.lastProcessedSeq).toBe(19);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("agentWorkspaceDir", () => {
  let directory: string | undefined;
  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("reuses one empty directory per agent identity so provider sessions survive restarts", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "hive-workspace-test-"));
    const identity = { serverUrl: "http://localhost:8787", username: "Agent-A", provider: "omp" };

    const first = agentWorkspaceDir(directory, identity);
    const again = agentWorkspaceDir(directory, { ...identity, username: "agent-a" });
    const other = agentWorkspaceDir(directory, { ...identity, provider: "opencode" });

    expect(again).toBe(first);
    expect(other).not.toBe(first);
    expect(path.dirname(first)).toBe(path.join(directory, "workspaces"));
    expect((await stat(first)).isDirectory()).toBe(true);
    expect(await readdir(first)).toEqual([]);
  });
});
