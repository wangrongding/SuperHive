import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { replaceAndRestart, updateBlocker, webRestartArgs } from "./web-update.js";
import type { ServiceState } from "./service.js";

describe("web update eligibility", () => {
  const valid = {
    install: { kind: "npm" as const, prefix: "/mine" },
    managed: true,
    writable: true,
    desktop: false,
    external: false,
  };
  it("only replaces writable npm globals managed by this Hive instance", () => {
    expect(updateBlocker(valid)).toBeNull();
    expect(updateBlocker({ ...valid, desktop: true })).toBe("desktop");
    expect(updateBlocker({ ...valid, install: { kind: "source" } })).toBe("source");
    expect(updateBlocker({ ...valid, install: { kind: "npx" } })).toBe("npx");
    expect(updateBlocker({ ...valid, install: { kind: "pnpm" } })).toBe("installer");
    expect(updateBlocker({ ...valid, managed: false })).toBe("external");
    expect(updateBlocker({ ...valid, external: true })).toBe("external");
    expect(updateBlocker({ ...valid, writable: false })).toBe("permissions");
  });
});

describe("rollback startup configuration", () => {
  const state: ServiceState = {
    pid: 1,
    instanceId: "test",
    healthUrl: "http://127.0.0.1:54321/health",
    publicUrl: "https://hive.example.com",
    dataDir: "/isolated",
    logPath: "/isolated/server.log",
    startedAt: "2026-11-26",
    startOptions: {
      host: "127.0.0.1",
      port: 54321,
      publicUrl: "https://hive.example.com",
      localAgents: false,
    },
  };
  it("pins both restart attempts to the original options even if a failed start deletes server.json", () => {
    expect(webRestartArgs(state, "/isolated")).toEqual([
      "restart",
      "--data-dir",
      "/isolated",
      "--host",
      "127.0.0.1",
      "--port",
      "54321",
      "--public-url",
      "https://hive.example.com",
      "--no-local-agents",
      "--wait",
    ]);
    expect(webRestartArgs(state, "/isolated", "now")).toContain("--force");
  });
  it("recovers the listening port from a legacy health URL rather than using the default port", () => {
    const legacy = { ...state };
    delete legacy.startOptions;
    const args = webRestartArgs(legacy, "/isolated");
    expect(args).toContain("54321");
    expect(args).not.toContain("8787");
    expect(args).toContain("--local-agents");
  });
});

describe("staged package replacement", () => {
  function setup() {
    const root = mkdtempSync(path.join(tmpdir(), "hive-web-update-test-"));
    const packageRoot = path.join(root, "superhive");
    const candidate = path.join(root, "candidate");
    mkdirSync(packageRoot);
    mkdirSync(candidate);
    writeFileSync(path.join(packageRoot, "version"), "old");
    writeFileSync(path.join(candidate, "version"), "new");
    return { root, packageRoot, candidate, backup: path.join(root, "backup") };
  }
  it("keeps the old package until the staged package is ready, then restarts", async () => {
    const options = setup();
    const restart = vi.fn(async () => {
      expect(readFileSync(path.join(options.packageRoot, "version"), "utf8")).toBe("new");
    });
    const rollbackRestart = vi.fn(async () => undefined);
    try {
      await replaceAndRestart({ ...options, restart, rollbackRestart, phase: vi.fn() });
      expect(restart).toHaveBeenCalledOnce();
      expect(rollbackRestart).not.toHaveBeenCalled();
      expect(readFileSync(path.join(options.packageRoot, "version"), "utf8")).toBe("new");
    } finally {
      rmSync(options.root, { recursive: true, force: true });
    }
  });
  it("restores and restarts the old package when the new Server fails", async () => {
    const options = setup();
    const phase = vi.fn();
    const rollbackRestart = vi.fn(async () => {
      expect(readFileSync(path.join(options.packageRoot, "version"), "utf8")).toBe("old");
    });
    try {
      await expect(
        replaceAndRestart({
          ...options,
          phase,
          restart: async () => {
            throw new Error("new server failed");
          },
          rollbackRestart,
        }),
      ).rejects.toThrow("new server failed");
      expect(phase.mock.calls.flat()).toEqual(["restarting", "rolling_back"]);
      expect(rollbackRestart).toHaveBeenCalledOnce();
    } finally {
      rmSync(options.root, { recursive: true, force: true });
    }
  });
  it("restores the package without stopping the Server if replacement fails", async () => {
    const options = setup();
    const restart = vi.fn(async () => undefined);
    try {
      await expect(
        replaceAndRestart({
          ...options,
          candidate: path.join(options.root, "missing"),
          restart,
          rollbackRestart: restart,
          phase: vi.fn(),
        }),
      ).rejects.toThrow();
      expect(restart).not.toHaveBeenCalled();
      expect(readFileSync(path.join(options.packageRoot, "version"), "utf8")).toBe("old");
    } finally {
      rmSync(options.root, { recursive: true, force: true });
    }
  });
});
