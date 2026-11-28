import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { HiveDatabase } from "./database.js";
import { renderImMessage } from "./im/im-texts.js";
import {
  adoptedLaunch,
  cliOption,
  LocalAgentSupervisor,
  type ChildHandle,
  type SpawnAgent,
} from "./local-agents.js";

/** 收到 SIGTERM 就退出的假进程 */
class FakeChild implements ChildHandle {
  readonly signals: NodeJS.Signals[] = [];
  private exitListeners: Array<(code: number | null) => void> = [];
  constructor(
    readonly pid: number,
    readonly args: string[],
  ) {}
  onOutput() {}
  onExit(listener: (code: number | null) => void) {
    this.exitListeners.push(listener);
  }
  kill(signal: NodeJS.Signals) {
    this.signals.push(signal);
    for (const listener of this.exitListeners) listener(0);
    this.exitListeners = [];
  }
}

const cli = { command: "/usr/bin/node", args: ["/opt/superhive/dist/cli.js"] };
const probe = async () => ({ installed: true, version: null });

function setup() {
  const database = new HiveDatabase(":memory:");
  const children: FakeChild[] = [];
  const spawn = vi.fn<SpawnAgent>((_command, args) => {
    const child = new FakeChild(4000 + children.length, args);
    children.push(child);
    return child;
  });
  const busy = new Set<string>();
  const supervisor = new LocalAgentSupervisor({
    database,
    cli,
    serverUrl: "http://127.0.0.1:8787",
    joinToken: "join-token",
    isAgentOnline: () => true,
    isNameInUse: () => false,
    spawn,
    probe,
    setTimer: () => ({ cancel: () => undefined }),
    busyAgentNames: () => busy,
  });
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "hive-access-")));
  const accessOf = (child: FakeChild | undefined) =>
    child?.args.find((arg) => arg.startsWith("--access="));
  const cwdOf = (child: FakeChild | undefined) =>
    child?.args.find((arg) => arg.startsWith("--cwd="));
  return { database, supervisor, children, busy, directory, accessOf, cwdOf };
}

describe("changing a local agent's access after it joined", () => {
  it("saves the new access and restarts an idle agent with it right away", async () => {
    const { database, supervisor, children, directory, accessOf, cwdOf } = setup();
    const agent = supervisor.create({ provider: "claude", name: "rd-a", access: "read-only" });
    await vi.waitFor(() => expect(children).toHaveLength(1));
    expect(accessOf(children[0])).toBe("--access=read-only");

    const updated = supervisor.updateSettings(agent.id, { access: "full", cwd: directory });
    expect(updated).toMatchObject({ access: "full", cwd: directory });
    await vi.waitFor(() => expect(children).toHaveLength(2));
    expect(children[0]!.signals).toContain("SIGTERM");
    expect(accessOf(children[1])).toBe("--access=full");
    expect(cwdOf(children[1])).toBe(cliOption("cwd", directory));
    expect(supervisor.get(agent.id).accessPendingRestart).toBeUndefined();
    // 存进了库：Server 重启后照样按新权限
    expect(database.listLocalAgents()[0]).toMatchObject({ access: "full", cwd: directory });
    await supervisor.shutdown();
    database.close();
  });

  it("waits for a busy agent to finish its turn before restarting with the new access", async () => {
    const { database, supervisor, children, busy, directory, accessOf } = setup();
    const agent = supervisor.create({
      provider: "codex",
      name: "rd-b",
      access: "workspace",
      cwd: directory,
    });
    await vi.waitFor(() => expect(children).toHaveLength(1));
    busy.add("rd-b");

    const updated = supervisor.updateSettings(agent.id, { access: "full" });
    // 不打断这一轮：还是原来的进程，标出新权限待生效
    expect(updated).toMatchObject({
      access: "full",
      cwd: directory,
      accessPendingRestart: true,
      restartWhenIdle: true,
    });
    expect(children).toHaveLength(1);
    expect(children[0]!.signals).toEqual([]);

    busy.clear();
    await supervisor.checkUpdates();
    await vi.waitFor(() => expect(children).toHaveLength(2));
    expect(accessOf(children[1])).toBe("--access=full");
    expect(supervisor.get(agent.id).accessPendingRestart).toBeUndefined();
    expect(supervisor.get(agent.id).restartWhenIdle).toBeUndefined();
    await supervisor.shutdown();
    database.close();
  });

  it("does not restart when the access is changed back before the turn ends", async () => {
    const { database, supervisor, children, busy, directory } = setup();
    const agent = supervisor.create({
      provider: "claude",
      name: "rd-c",
      access: "workspace",
      cwd: directory,
    });
    await vi.waitFor(() => expect(children).toHaveLength(1));
    busy.add("rd-c");
    supervisor.updateSettings(agent.id, { access: "full" });
    const back = supervisor.updateSettings(agent.id, { access: "workspace" });
    expect(back.accessPendingRestart).toBeUndefined();
    expect(back.restartWhenIdle).toBeUndefined();
    busy.clear();
    await supervisor.checkUpdates();
    expect(children).toHaveLength(1);
    await supervisor.shutdown();
    database.close();
  });

  it("needs a usable working directory for writable access and changes nothing otherwise", async () => {
    const { database, supervisor, children } = setup();
    const agent = supervisor.create({ provider: "claude", name: "rd-d", access: "read-only" });
    await vi.waitFor(() => expect(children).toHaveLength(1));
    expect(() => supervisor.updateSettings(agent.id, { access: "workspace" })).toThrow(
      expect.objectContaining({ code: "LOCAL_AGENT_CWD_REQUIRED" }),
    );
    expect(() =>
      supervisor.updateSettings(agent.id, {
        access: "full",
        cwd: "/definitely/not/here",
        model: "opus",
      }),
    ).toThrow(expect.objectContaining({ code: "LOCAL_AGENT_CWD_INVALID" }));
    expect(() => supervisor.updateSettings(agent.id, { access: "full", cwd: "/" })).toThrow(
      expect.objectContaining({ code: "LOCAL_AGENT_CWD_INVALID" }),
    );
    // 一起带的模型也没存
    expect(supervisor.get(agent.id)).toMatchObject({ access: "read-only", cwd: null, model: null });
    expect(children).toHaveLength(1);
    await supervisor.shutdown();
    database.close();
  });

  it("keeps the working directory when going read-only, and a stopped agent uses the new access on its next start", async () => {
    const { database, supervisor, children, directory, accessOf, cwdOf } = setup();
    const agent = supervisor.create({
      provider: "claude",
      name: "rd-e",
      access: "full",
      cwd: directory,
    });
    await vi.waitFor(() => expect(children).toHaveLength(1));
    await supervisor.stop(agent.id);

    const updated = supervisor.updateSettings(agent.id, { access: "read-only" });
    expect(updated).toMatchObject({ access: "read-only", cwd: directory, status: "stopped" });
    expect(updated.accessPendingRestart).toBeUndefined();
    expect(children).toHaveLength(1);

    supervisor.startAgent(agent.id);
    await vi.waitFor(() => expect(children).toHaveLength(2));
    expect(accessOf(children[1])).toBe("--access=read-only");
    expect(cwdOf(children[1])).toBe(cliOption("cwd", directory));
    await supervisor.shutdown();
    database.close();
  });

  it("refuses to change access while the agent is restarting", async () => {
    const { database, supervisor, children, directory } = setup();
    const agent = supervisor.create({ provider: "claude", name: "rd-f", access: "read-only" });
    await vi.waitFor(() => expect(children).toHaveLength(1));
    const restarting = supervisor.restart(agent.id);
    expect(() => supervisor.updateSettings(agent.id, { access: "full", cwd: directory })).toThrow(
      expect.objectContaining({ code: "LOCAL_AGENT_BUSY" }),
    );
    await restarting;
    expect(supervisor.get(agent.id).access).toBe("read-only");
    await supervisor.shutdown();
    database.close();
  });
});

describe("adoptedLaunch", () => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "hive-adopt-")));
  const line = (...args: string[]) => ["node", "cli.js", "join", ...args].join(" ");

  it("reads the access and working directory a leftover process was started with", () => {
    const config = { access: "full" as const, cwd: directory };
    expect(
      adoptedLaunch(config, line(cliOption("access", "full"), cliOption("cwd", directory))),
    ).toEqual({ access: "full", cwd: directory });
    // 上一个 Server 改了权限还没重启：按命令行里的旧权限算
    expect(
      adoptedLaunch(config, line(cliOption("access", "read-only"), cliOption("cwd", directory))),
    ).toEqual({ access: "read-only", cwd: directory });
    // 目录不一样：只知道不一样
    expect(
      adoptedLaunch(config, line(cliOption("access", "full"), cliOption("cwd", "/tmp/other"))),
    ).toEqual({ access: "full", cwd: undefined });
    expect(
      adoptedLaunch({ access: "read-only", cwd: null }, line(cliOption("cwd", directory))),
    ).toMatchObject({ cwd: undefined });
  });

  it("treats an unreadable command line or an unusable directory as unchanged", () => {
    expect(adoptedLaunch({ access: "workspace", cwd: directory }, undefined)).toEqual({
      access: "workspace",
      cwd: directory,
    });
    // 配置里的目录不在了：本来就会退回主目录启动，不拿目录比
    expect(
      adoptedLaunch(
        { access: "full", cwd: "/definitely/not/here" },
        line(cliOption("access", "full"), cliOption("cwd", "/Users/me")),
      ),
    ).toEqual({ access: "full", cwd: "/definitely/not/here" });
  });
});

describe("access change over the settings route", () => {
  it("changes access through PUT /settings and rejects a writable level without a directory", async () => {
    const children: FakeChild[] = [];
    const app = await buildApp({
      databasePath: ":memory:",
      token: "join-token",
      staticDir: "/definitely-not-present",
      localAgents: {
        cli,
        serverUrl: "http://127.0.0.1:8787",
        spawn: (_command, args) => {
          const child = new FakeChild(5000 + children.length, args);
          children.push(child);
          return child;
        },
        probe,
      },
    });
    try {
      const session = (await app.inject({ method: "GET", url: "/api/local/session" })).json() as {
        ownerToken: string;
      };
      const owner = { "x-hive-owner": session.ownerToken };
      const created = (
        await app.inject({
          method: "POST",
          url: "/api/local/agents",
          headers: owner,
          payload: { provider: "claude", name: "rd-g", access: "read-only" },
        })
      ).json() as { agent: { id: string } };
      const put = (payload: object, headers: Record<string, string> = owner) =>
        app.inject({
          method: "PUT",
          url: `/api/local/agents/${created.agent.id}/settings`,
          headers,
          payload,
        });
      const missing = await put({ access: "workspace" });
      expect(missing.statusCode).toBe(400);
      expect(missing.json().code).toBe("LOCAL_AGENT_CWD_REQUIRED");
      // 不是房主：不让改
      expect((await put({ access: "full", cwd: tmpdir() }, {})).statusCode).toBeGreaterThanOrEqual(
        400,
      );
      const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "hive-route-")));
      const changed = await put({ access: "full", cwd: directory });
      expect(changed.statusCode).toBe(200);
      expect(changed.json().agent).toMatchObject({ access: "full", cwd: directory });
    } finally {
      await app.close();
    }
  });

  it("renders the audit line for an access change", () => {
    expect(
      renderImMessage("zh-CN", {
        key: "im.audit.accessChanged",
        params: { name: "rd-a", access: { key: "im.access.full" }, cwd: "/w" },
      }),
    ).toBe("把本机 Agent rd-a 的权限改成了完全访问，工作目录 /w");
    expect(
      renderImMessage("en", {
        key: "im.audit.accessChangedReadOnly",
        params: { name: "rd-a", access: { key: "im.access.read-only" } },
      }),
    ).toBe("set the access of local agent rd-a to read-only");
  });
});
