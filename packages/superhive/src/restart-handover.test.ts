import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  handoverBlocker,
  parseBusyChoice,
  readLocalAgents,
  waitForIdle,
  type HandoverCheck,
} from "./restart-handover.js";
import { restartArgsFor } from "./update.js";

const base: HandoverCheck = {
  serverSupports: true,
  canAskShutdown: true,
  previous: { host: "0.0.0.0", port: 8787, localAgentsOff: false },
  next: { host: "0.0.0.0", port: 8787, localAgentsOff: false },
  tokenChanged: false,
};

describe("handoverBlocker", () => {
  it("hands over when the running Server supports it and nothing the Agents depend on changes", () => {
    expect(handoverBlocker(base)).toBeUndefined();
  });

  it("refuses for an old Server, a changed address or token, or local Agents being turned off", () => {
    expect(handoverBlocker({ ...base, serverSupports: false })).toMatch(/旧版本/);
    expect(handoverBlocker({ ...base, canAskShutdown: false })).toMatch(/旧版本/);
    expect(handoverBlocker({ ...base, next: { ...base.next, port: 8788 } })).toMatch(/端口/);
    expect(handoverBlocker({ ...base, next: { ...base.next, host: "127.0.0.1" } })).toMatch(
      /监听地址/,
    );
    expect(handoverBlocker({ ...base, tokenChanged: true })).toMatch(/Join Token/);
    expect(handoverBlocker({ ...base, next: { ...base.next, localAgentsOff: true } })).toMatch(
      /关闭了本机 Agent/,
    );
  });
});

describe("parseBusyChoice", () => {
  it("defaults to waiting; only an explicit f / y restarts now", () => {
    expect(parseBusyChoice("")).toBe("wait");
    expect(parseBusyChoice(" W ")).toBe("wait");
    expect(parseBusyChoice("f")).toBe("now");
    expect(parseBusyChoice("yes")).toBe("now");
    expect(parseBusyChoice("n")).toBe("cancel");
    expect(parseBusyChoice("什么")).toBe("cancel");
  });
});

describe("waitForIdle", () => {
  it("polls until every Agent is idle, logging only when the busy list changes", async () => {
    const answers: Array<string[] | undefined> = [["a", "b"], ["a", "b"], undefined, ["a"], []];
    const lines: string[] = [];
    let clock = 0;
    const still = await waitForIdle(() => answers.shift(), {
      timeoutMs: 60_000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      log: (line) => lines.push(line),
    });
    expect(still).toEqual([]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("a、b");
    expect(lines[1]).toContain("等待 a 手上");
  });

  it("gives up after the timeout and returns who is still busy", async () => {
    let clock = 0;
    const still = await waitForIdle(() => ["slow"], {
      timeoutMs: 10_000,
      intervalMs: 2_000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      log: () => undefined,
    });
    expect(still).toEqual(["slow"]);
    expect(clock).toBe(10_000);
  });
});

describe("readLocalAgents", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("reads running local Agents and which of them have unfinished invocations", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hive-restart-"));
    dirs.push(dir);
    const file = path.join(dir, "hive.sqlite");
    type Db = { exec(sql: string): void; close(): void };
    const Database = createRequire(import.meta.url)("better-sqlite3") as new (file: string) => Db;
    const db = new Database(file);
    db.exec(`
      CREATE TABLE local_agents (name TEXT NOT NULL, pid INTEGER);
      CREATE TABLE invocations (agent_name TEXT NOT NULL, status TEXT NOT NULL, finished_at TEXT);
      INSERT INTO local_agents VALUES ('Worker', 101), ('idle', 102), ('stopped', NULL);
      INSERT INTO invocations VALUES ('worker', 'running', NULL), ('idle', 'completed', 'x'),
        ('stopped', 'queued', NULL), ('remote', 'running', NULL);
    `);
    db.close();
    expect(readLocalAgents(file)).toEqual({
      running: [
        { name: "Worker", pid: 101 },
        { name: "idle", pid: 102 },
      ],
      busy: ["Worker"],
    });
  });

  it("returns undefined when the database is missing instead of creating it", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hive-restart-"));
    dirs.push(dir);
    expect(readLocalAgents(path.join(dir, "missing.sqlite"))).toBeUndefined();
  });
});

describe("restartArgsFor", () => {
  it("passes --wait / --force-restart from hive update through to hive restart", () => {
    expect(restartArgsFor({})).toEqual(["restart"]);
    expect(restartArgsFor({ wait: true })).toEqual(["restart", "--wait"]);
    expect(restartArgsFor({ "force-restart": true, wait: true })).toEqual(["restart", "--force"]);
  });
});
