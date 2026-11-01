import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { HiveDatabase } from "./database.js";
import {
  LocalAgentSupervisor,
  type ChildHandle,
  type LocalAgentSupervisorOptions,
  type SpawnAgent,
} from "./local-agents.js";

class FakeChild implements ChildHandle {
  readonly pid: number;
  readonly signals: NodeJS.Signals[] = [];
  private outputListeners: Array<(chunk: string) => void> = [];
  private exitListeners: Array<(code: number | null, error?: Error) => void> = [];
  exited = false;

  constructor(
    pid: number,
    readonly command: string,
    readonly args: string[],
    readonly env: Record<string, string>,
    /** 收到 SIGTERM 时是否立即退出；false 模拟卡死的进程 */
    private readonly exitOnTerm = true,
  ) {
    this.pid = pid;
  }
  onOutput(listener: (chunk: string) => void) {
    this.outputListeners.push(listener);
  }
  onExit(listener: (code: number | null, error?: Error) => void) {
    this.exitListeners.push(listener);
  }
  released = false;
  release() {
    this.released = true;
  }
  kill(signal: NodeJS.Signals) {
    this.signals.push(signal);
    if (signal === "SIGKILL" || this.exitOnTerm) this.exit(signal === "SIGKILL" ? null : 0);
  }
  print(text: string) {
    for (const listener of this.outputListeners) listener(text);
  }
  exit(code: number | null, error?: Error) {
    if (this.exited) return;
    this.exited = true;
    for (const listener of this.exitListeners) listener(code, error);
  }
}

function fakeSpawner(options: { exitOnTerm?: boolean } = {}) {
  const children: FakeChild[] = [];
  const spawn = vi.fn<SpawnAgent>((command, args, spawnOptions) => {
    const child = new FakeChild(
      1000 + children.length,
      command,
      args,
      spawnOptions.env,
      options.exitOnTerm ?? true,
    );
    children.push(child);
    return child;
  });
  return { spawn, children };
}

/** 手动推进的定时器，测试决定何时触发 */
function manualTimers() {
  const timers: Array<{ callback: () => void; ms: number; cancelled: boolean }> = [];
  return {
    timers,
    setTimer: (callback: () => void, ms: number) => {
      const timer = { callback, ms, cancelled: false };
      timers.push(timer);
      return { cancel: () => (timer.cancelled = true) };
    },
    fireNext(ms?: number) {
      const timer = timers.find(
        (candidate) => !candidate.cancelled && (ms === undefined || candidate.ms === ms),
      );
      if (!timer) throw new Error("no pending timer");
      timer.cancelled = true;
      timer.callback();
      return timer.ms;
    },
  };
}

const cli = { command: "/usr/bin/node", args: ["/opt/ai-hive/dist/cli.js"] };
const probe = async (command: string) =>
  command === "opencode"
    ? { installed: true, version: "1.19.4" }
    : { installed: false, version: null };

describe("local agent routes", () => {
  let closeApp: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await closeApp?.();
    closeApp = undefined;
  });

  async function setup(extra: Partial<LocalAgentSupervisorOptions> & { publicUrl?: string } = {}) {
    const spawner = fakeSpawner();
    const { publicUrl, ...agentOptions } = extra;
    const app = await buildApp({
      databasePath: ":memory:",
      token: "join-token",
      staticDir: "/definitely-not-present",
      ...(publicUrl ? { publicUrl } : {}),
      localAgents: {
        cli,
        serverUrl: "http://127.0.0.1:8787",
        spawn: spawner.spawn,
        probe,
        ...agentOptions,
      },
    });
    closeApp = () => app.close();
    const session = (await app.inject({ method: "GET", url: "/api/local/session" })).json() as {
      enabled: boolean;
      ownerToken?: string;
    };
    const owner = { "x-hive-owner": session.ownerToken ?? "" };
    return { app, spawner, session, owner };
  }

  it("logs the owner in on another device with a one-time QR ticket, without handing out the join token", async () => {
    const { app, owner } = await setup({ publicUrl: "http://10.0.0.8:8787" });
    const remote = { remoteAddress: "10.0.0.20" };
    // 页面开在 localhost 上：二维码里换成服务公布的地址
    const pair = (
      await app.inject({
        method: "POST",
        url: "/api/local/owner-devices/pair",
        headers: owner,
        payload: { origin: "http://localhost:5188" },
      })
    ).json() as { url: string; qrDataUrl: string };
    expect(pair.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    const ticket = new URL(pair.url).searchParams.get("login")!;
    expect(ticket).toMatch(/^hop_/);
    // 别的电脑上没登录：不是房主
    expect((await app.inject({ method: "GET", url: "/api/access", ...remote })).json()).toEqual({
      role: "none",
      reason: "no_invite",
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/owner-login",
      payload: { ticket, deviceName: "iPhone · Safari" },
      ...remote,
    });
    const { token } = login.json() as { token: string };
    expect(token).toMatch(/^hod_/);
    // 票只能用一次
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/owner-login",
          payload: { ticket, deviceName: "again" },
          ...remote,
        })
      ).statusCode,
    ).toBe(401);
    const auth = { authorization: `Bearer ${token}` };
    // 是房主，但拿到的是自己的设备令牌，不是总令牌
    expect(
      (await app.inject({ method: "GET", url: "/api/access", headers: auth, ...remote })).json(),
    ).toEqual({ role: "owner", joinToken: token });
    const meta = (
      await app.inject({ method: "GET", url: "/api/meta", headers: auth, ...remote })
    ).json() as Record<string, unknown>;
    expect(meta.joinToken).toBe(token);
    expect(JSON.stringify(meta)).not.toContain("join-token");
    expect(
      (await app.inject({ method: "GET", url: "/api/rooms", headers: auth, ...remote })).statusCode,
    ).toBe(200);
    // 本机列出设备、退出登录后令牌失效
    const devices = (
      await app.inject({ method: "GET", url: "/api/local/owner-devices", headers: owner })
    ).json() as { devices: Array<{ id: string; name: string }> };
    expect(devices.devices.map((device) => device.name)).toEqual(["iPhone · Safari"]);
    await app.inject({
      method: "DELETE",
      url: `/api/local/owner-devices/${devices.devices[0]!.id}`,
      headers: owner,
    });
    expect(
      (await app.inject({ method: "GET", url: "/api/rooms", headers: auth, ...remote })).statusCode,
    ).toBe(401);
    // 总令牌只给本机房主
    expect(
      (await app.inject({ method: "GET", url: "/api/local/owner-token", headers: owner })).json(),
    ).toEqual({ token: "join-token" });
    expect(
      (await app.inject({ method: "GET", url: "/api/local/owner-token", ...remote })).statusCode,
    ).toBe(403);
  });

  it("hands the owner token only to requests from this machine", async () => {
    const { app, session } = await setup();
    expect(session.enabled).toBe(true);
    expect(session.ownerToken).toMatch(/^[0-9a-f]{64}$/);

    const proxied = await app.inject({
      method: "GET",
      url: "/api/local/session",
      headers: { "x-forwarded-for": "203.0.113.5" },
    });
    expect(proxied.json()).toEqual({
      enabled: false,
      reason: "经过代理转发的请求不能使用本机 Agent",
    });
    const remote = await app.inject({
      method: "GET",
      url: "/api/local/session",
      remoteAddress: "203.0.113.5",
    });
    expect(remote.json()).toMatchObject({ enabled: false });
  });

  it("is disabled when the server was started without local agents", async () => {
    const app = await buildApp({ databasePath: ":memory:", staticDir: "/definitely-not-present" });
    closeApp = () => app.close();
    expect((await app.inject({ method: "GET", url: "/api/local/session" })).json()).toEqual({
      enabled: false,
      reason: "本机 Agent 已在服务端关闭",
    });
    expect((await app.inject({ method: "GET", url: "/api/local/agents" })).statusCode).toBe(404);
  });

  it("requires both the owner token and a local request; the join token is not enough", async () => {
    const { app, owner } = await setup();
    const withJoinToken = await app.inject({
      method: "GET",
      url: "/api/local/agents",
      headers: { authorization: "Bearer join-token", "x-hive-owner": "join-token" },
    });
    expect(withJoinToken.statusCode).toBe(401);
    const fromElsewhere = await app.inject({
      method: "GET",
      url: "/api/local/agents",
      headers: owner,
      remoteAddress: "203.0.113.5",
    });
    expect(fromElsewhere.statusCode).toBe(403);
    const crossSite = await app.inject({
      method: "POST",
      url: "/api/local/agents",
      headers: { ...owner, origin: "https://evil.example" },
      payload: { provider: "opencode", name: "rd-opencode", access: "read-only" },
    });
    expect(crossSite.statusCode).toBe(403);
    expect(
      (await app.inject({ method: "GET", url: "/api/local/agents", headers: owner })).json(),
    ).toEqual({
      agents: [],
    });
  });

  it("launches the CLI with the token in the environment, not in argv", async () => {
    const { app, owner, spawner } = await setup();
    const response = await app.inject({
      method: "POST",
      url: "/api/local/agents",
      headers: owner,
      payload: { provider: "opencode", name: "rd-opencode", access: "read-only", model: "p/m" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().agent).toMatchObject({
      provider: "opencode",
      name: "rd-opencode",
      access: "read-only",
      status: "starting",
      cwd: null,
      model: "p/m",
    });
    const child = spawner.children[0]!;
    expect(child.command).toBe("/usr/bin/node");
    expect(child.args).toEqual([
      "/opt/ai-hive/dist/cli.js",
      "join",
      "--server",
      "http://127.0.0.1:8787",
      "--name",
      "rd-opencode",
      "--provider",
      "opencode",
      "--access",
      "read-only",
      "--model",
      "p/m",
    ]);
    expect(child.args.join(" ")).not.toContain("join-token");
    expect(child.env).toEqual({
      HIVE_AGENT_TOKEN: "join-token",
      HIVE_SUPERVISOR_PID: String(process.pid),
    });

    child.print("[hive] 已加入 #general\n[hive] 正在处理");
    const logs = await app.inject({
      method: "GET",
      url: `/api/local/agents/${response.json().agent.id}/logs`,
      headers: owner,
    });
    expect(logs.json().lines).toEqual([
      "[hive] 启动 rd-opencode（opencode · read-only）",
      "[hive] 已加入 #general",
      "[hive] 正在处理",
    ]);
  });

  it("passes an agent settings file and applies MCP selections without a restart", async () => {
    const settingsDir = mkdtempSync(path.join(tmpdir(), "hive-agent-settings-"));
    const listMcp = vi.fn(async (args: string[]) => {
      const file = args[args.indexOf("--agent-settings") + 1]!;
      const disabled = (JSON.parse(readFileSync(file, "utf8")) as { mcpDisabled: string[] })
        .mcpDisabled;
      return `${JSON.stringify({
        servers: [
          {
            name: "rea",
            scope: "user",
            transport: "stdio",
            enabled: !disabled.includes("rea"),
            configurable: true,
            ...(args.includes("--measure")
              ? { measurement: { ok: true, tools: 207, tokens: 350_000 } }
              : {}),
          },
        ],
      })}\n`;
    });
    const { app, owner, spawner } = await setup({ settingsDir, listMcp });
    const created = await app.inject({
      method: "POST",
      url: "/api/local/agents",
      headers: owner,
      payload: { provider: "claude", name: "rd-claude", access: "read-only" },
    });
    const id = created.json().agent.id as string;
    const args = spawner.children[0]!.args;
    const file = args[args.indexOf("--agent-settings") + 1]!;
    expect(file).toBe(path.join(settingsDir, `${id}.json`));
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ mcpDisabled: [] });

    const measured = await app.inject({
      method: "GET",
      url: `/api/local/agents/${id}/mcp?measure=1`,
      headers: owner,
    });
    expect(measured.json()).toMatchObject({
      supported: true,
      baselineTokens: 40_000,
      servers: [{ name: "rea", enabled: true, measurement: { tokens: 350_000 } }],
    });

    const updated = await app.inject({
      method: "PUT",
      url: `/api/local/agents/${id}/settings`,
      headers: owner,
      payload: { mcpDisabled: ["rea", "rea"] },
    });
    expect(updated.json().agent.mcpDisabled).toEqual(["rea"]);
    expect(updated.json().agent.settingsPendingRestart).toBeUndefined();
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ mcpDisabled: ["rea"] });
    // 改设置不重启进程
    expect(spawner.children).toHaveLength(1);
    // 不重新估算时沿用上次的估算值，启用状态取最新
    const listed = await app.inject({
      method: "GET",
      url: `/api/local/agents/${id}/mcp`,
      headers: owner,
    });
    expect(listed.json().servers[0]).toMatchObject({
      enabled: false,
      measurement: { tokens: 350_000 },
    });
    expect(listMcp).toHaveBeenCalledTimes(2);

    const other = await app.inject({
      method: "POST",
      url: "/api/local/agents",
      headers: owner,
      payload: { provider: "opencode", name: "rd-opencode", access: "read-only" },
    });
    expect(spawner.children[1]!.args).not.toContain("--agent-settings");
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/local/agents/${other.json().agent.id}/mcp`,
          headers: owner,
        })
      ).json(),
    ).toEqual({ supported: false, servers: [], baselineTokens: null });
    rmSync(settingsDir, { recursive: true, force: true });
  });

  it("previews MCP servers before launch and starts the agent with the unchecked ones off", async () => {
    const settingsDir = mkdtempSync(path.join(tmpdir(), "hive-agent-settings-"));
    const listMcp = vi.fn<(args: string[]) => Promise<string>>(async () =>
      JSON.stringify({
        servers: [
          { name: "rea", scope: "user", transport: "stdio", enabled: true, configurable: true },
        ],
      }),
    );
    const { app, owner, spawner } = await setup({ settingsDir, listMcp });
    const preview = await app.inject({
      method: "GET",
      url: "/api/local/mcp?provider=claude",
      headers: owner,
    });
    expect(preview.json()).toMatchObject({ supported: true, servers: [{ name: "rea" }] });
    expect(listMcp.mock.calls[0]![0]).not.toContain("--agent-settings");
    expect(
      (await app.inject({ method: "GET", url: "/api/local/mcp?provider=nope", headers: owner }))
        .statusCode,
    ).toBe(400);

    const created = await app.inject({
      method: "POST",
      url: "/api/local/agents",
      headers: owner,
      payload: { provider: "claude", name: "rd-claude", access: "read-only", mcpDisabled: ["rea"] },
    });
    expect(created.json().agent.mcpDisabled).toEqual(["rea"]);
    const args = spawner.children[0]!.args;
    const file = args[args.indexOf("--agent-settings") + 1]!;
    // 第一次启动就按选择加载，不需要接入后再改一次
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ mcpDisabled: ["rea"] });
    rmSync(settingsDir, { recursive: true, force: true });
  });

  it("validates access, working directory and name before starting anything", async () => {
    const { app, owner, spawner } = await setup();
    const post = (payload: object) =>
      app.inject({ method: "POST", url: "/api/local/agents", headers: owner, payload });

    // 完全访问与工作区一样必须给出工作目录
    expect((await post({ provider: "omp", name: "a", access: "full" })).json().code).toBe(
      "LOCAL_AGENT_CWD_REQUIRED",
    );
    expect((await post({ provider: "omp", name: "a", access: "workspace" })).json().code).toBe(
      "LOCAL_AGENT_CWD_REQUIRED",
    );
    expect(
      (await post({ provider: "omp", name: "a", access: "workspace", cwd: "relative/dir" })).json()
        .code,
    ).toBe("LOCAL_AGENT_CWD_INVALID");
    expect(
      (await post({ provider: "omp", name: "a", access: "workspace", cwd: "/" })).json().code,
    ).toBe("LOCAL_AGENT_CWD_INVALID");
    expect((await post({ provider: "bogus", name: "a", access: "read-only" })).statusCode).toBe(
      400,
    );
    expect(spawner.spawn).not.toHaveBeenCalled();

    const directory = mkdtempSync(path.join(tmpdir(), "hive-local-agent-"));
    try {
      const workspace = await post({
        provider: "omp",
        name: "rd-omp",
        access: "workspace",
        cwd: directory,
      });
      expect(workspace.statusCode).toBe(201);
      expect(workspace.json().agent.cwd).toBe(realpathSync(directory));
      expect(spawner.children[0]!.args).toContain("--cwd");
      const duplicate = await post({ provider: "opencode", name: "RD-OMP", access: "read-only" });
      expect(duplicate.statusCode).toBe(409);
      // 手输的 ~ 会被展开
      const tilde = await post({
        provider: "claude",
        name: "rd-home",
        access: "workspace",
        cwd: "~",
      });
      expect(tilde.json().agent.cwd).toBe(realpathSync(homedir()));

      const full = await post({
        provider: "codex",
        name: "rd-codex",
        access: "full",
        cwd: directory,
      });
      expect(full.statusCode).toBe(201);
      expect(full.json().agent).toMatchObject({ access: "full", cwd: realpathSync(directory) });
      expect(spawner.children.at(-1)!.args).toEqual(
        expect.arrayContaining(["--access", "full", "--cwd", realpathSync(directory)]),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("browses local directories for the working-directory picker", async () => {
    const { app, owner } = await setup();
    const listing = (
      await app.inject({ method: "GET", url: "/api/local/directories", headers: owner })
    ).json() as { path: string; defaults: { launch: string; home: string } };
    expect(listing.path).toBe(listing.defaults.launch);

    const missing = await app.inject({
      method: "GET",
      url: "/api/local/directories?path=%2Fdefinitely-not-here",
      headers: owner,
    });
    expect(missing.statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/local/directories?path=relative",
          headers: owner,
        })
      ).statusCode,
    ).toBe(400);
    // 和其他本机接口一样需要房主凭证
    expect((await app.inject({ method: "GET", url: "/api/local/directories" })).statusCode).toBe(
      401,
    );
  });

  it("reports installed provider CLIs", async () => {
    const { app, owner } = await setup();
    const providers = (
      await app.inject({ method: "GET", url: "/api/local/providers", headers: owner })
    ).json().providers as Array<{ provider: string; installed: boolean; version: string | null }>;
    expect(providers.find((item) => item.provider === "opencode")).toMatchObject({
      installed: true,
      version: "1.19.4",
    });
    expect(providers.find((item) => item.provider === "codex")?.installed).toBe(false);
  });

  it("stops, starts and removes agents, and terminates them when the server closes", async () => {
    const { app, owner, spawner } = await setup();
    const id = (
      await app.inject({
        method: "POST",
        url: "/api/local/agents",
        headers: owner,
        payload: { provider: "opencode", name: "rd-opencode", access: "read-only" },
      })
    ).json().agent.id as string;

    const stopped = await app.inject({
      method: "POST",
      url: `/api/local/agents/${id}/stop`,
      headers: owner,
    });
    expect(stopped.json().agent.status).toBe("stopped");
    expect(spawner.children[0]!.signals).toEqual(["SIGTERM"]);

    await app.inject({ method: "POST", url: `/api/local/agents/${id}/start`, headers: owner });
    expect(spawner.children).toHaveLength(2);

    await app.close();
    closeApp = undefined;
    expect(spawner.children[1]!.signals).toEqual(["SIGTERM"]);
  });
});

describe("LocalAgentSupervisor", () => {
  function supervisorWith(
    database: HiveDatabase,
    extra: Partial<LocalAgentSupervisorOptions> = {},
  ) {
    const spawner = fakeSpawner();
    const timers = manualTimers();
    let now = 1_000_000;
    const supervisor = new LocalAgentSupervisor({
      database,
      cli,
      serverUrl: "http://127.0.0.1:8787",
      joinToken: "join-token",
      isAgentOnline: () => false,
      isNameInUse: () => false,
      spawn: spawner.spawn,
      probe,
      setTimer: timers.setTimer,
      now: () => now,
      ...extra,
    });
    return { supervisor, spawner, timers, advance: (ms: number) => (now += ms) };
  }

  it("hands its agents over to the next Server and the next Server adopts them by pid", () => {
    const database = new HiveDatabase(":memory:");
    const first = supervisorWith(database);
    const agent = first.supervisor.create({ provider: "omp", name: "rd-omp", access: "read-only" });
    const child = first.spawner.children[0]!;
    // 换代：只停止跟踪，不结束进程；进程号留在库里
    first.supervisor.detach();
    expect(child.signals).toEqual([]);
    expect(child.released).toBe(true);
    expect(database.listLocalAgents()[0]?.pid).toBe(child.pid);

    const adopted = new FakeChild(child.pid, "node", [], {});
    const adopt = vi.fn(() => adopted);
    const second = supervisorWith(database, { adopt });
    second.supervisor.start();
    expect(adopt).toHaveBeenCalledWith(child.pid, { name: "rd-omp" });
    expect(second.spawner.spawn).not.toHaveBeenCalled();
    expect(second.supervisor.get(agent.id).pid).toBe(child.pid);
    expect(second.supervisor.logs(agent.id).join("\n")).toContain("接管仍在运行的 rd-omp");

    // 接管来的进程退出后照常按崩溃处理并重启
    adopted.exit(1);
    expect(second.supervisor.get(agent.id).status).toBe("restarting");
    second.timers.fireNext();
    expect(second.spawner.spawn).toHaveBeenCalledTimes(1);
    database.close();
  });

  it("starts a fresh process when the recorded one is gone, and stops a leftover that should not run", () => {
    const database = new HiveDatabase(":memory:");
    const first = supervisorWith(database);
    const running = first.supervisor.create({ provider: "omp", name: "a", access: "read-only" });
    const stopped = first.supervisor.create({ provider: "omp", name: "b", access: "read-only" });
    first.supervisor.detach();
    database.setLocalAgentAutostart(stopped.id, false);

    const leftover = new FakeChild(1001, "node", [], {});
    const second = supervisorWith(database, {
      adopt: (pid) => (pid === 1001 ? leftover : undefined),
    });
    second.supervisor.start();
    // a 的旧进程已经不在：另起一个，并清掉旧进程号
    expect(second.spawner.spawn).toHaveBeenCalledTimes(1);
    expect(second.supervisor.get(running.id).pid).toBe(second.spawner.children[0]!.pid);
    // b 已被手动停止：留下的进程结束掉
    expect(leftover.signals).toEqual(["SIGTERM"]);
    expect(second.supervisor.get(stopped.id).status).toBe("stopped");
    database.close();
  });

  it("restarts with exponential backoff and stops after repeated crashes", () => {
    const database = new HiveDatabase(":memory:");
    const { supervisor, spawner, timers, advance } = supervisorWith(database);
    const agent = supervisor.create({ provider: "omp", name: "rd-omp", access: "read-only" });

    const delays: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      spawner.children.at(-1)!.print("Error: 未登录，请先运行 omp 配置模型\n");
      spawner.children.at(-1)!.exit(1);
      expect(supervisor.get(agent.id).status).toBe("restarting");
      advance(1_000);
      delays.push(timers.fireNext());
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(supervisor.get(agent.id).restarts).toBe(4);

    spawner.children.at(-1)!.exit(1);
    const crashed = supervisor.get(agent.id);
    expect(crashed.status).toBe("crashed");
    expect(crashed.lastExitCode).toBe(1);
    expect(crashed.lastError).toContain("未登录");
    expect(spawner.children).toHaveLength(5);
    database.close();
  });

  it("resets the backoff after the agent ran stably", () => {
    const database = new HiveDatabase(":memory:");
    const { supervisor, spawner, timers, advance } = supervisorWith(database);
    supervisor.create({ provider: "omp", name: "rd-omp", access: "read-only" });
    spawner.children.at(-1)!.exit(1);
    advance(1_000);
    expect(timers.fireNext()).toBe(1_000);
    advance(5 * 60_000);
    spawner.children.at(-1)!.exit(1);
    expect(timers.fireNext()).toBe(1_000);
    database.close();
  });

  it("reports running once the agent is online, and refuses names used by online members", () => {
    const database = new HiveDatabase(":memory:");
    let online = false;
    const { supervisor } = supervisorWith(database, {
      isAgentOnline: () => online,
      isNameInUse: (name) => name === "Alice",
    });
    const agent = supervisor.create({ provider: "omp", name: "rd-omp", access: "read-only" });
    expect(supervisor.get(agent.id).status).toBe("starting");
    online = true;
    expect(supervisor.get(agent.id).status).toBe("running");
    expect(() =>
      supervisor.create({ provider: "omp", name: "Alice", access: "read-only" }),
    ).toThrow("已被在线成员使用");
    database.close();
  });

  it("restores saved agents on start but keeps manually stopped ones stopped", async () => {
    const database = new HiveDatabase(":memory:");
    const first = supervisorWith(database);
    const running = first.supervisor.create({
      provider: "omp",
      name: "rd-omp",
      access: "read-only",
    });
    const stopped = first.supervisor.create({
      provider: "opencode",
      name: "rd-oc",
      access: "read-only",
    });
    await first.supervisor.stop(stopped.id);
    await first.supervisor.shutdown();

    const second = supervisorWith(database);
    second.supervisor.start();
    expect(
      second.spawner.children.map((child) => child.args[child.args.indexOf("--name") + 1]),
    ).toEqual(["rd-omp"]);
    expect(second.supervisor.get(stopped.id).status).toBe("stopped");
    expect(second.supervisor.get(running.id).status).toBe("starting");
    database.close();
  });

  it("escalates to SIGKILL when an agent ignores SIGTERM", async () => {
    const database = new HiveDatabase(":memory:");
    const spawner = fakeSpawner({ exitOnTerm: false });
    const timers = manualTimers();
    const supervisor = new LocalAgentSupervisor({
      database,
      cli,
      serverUrl: "http://127.0.0.1:8787",
      joinToken: "join-token",
      isAgentOnline: () => false,
      isNameInUse: () => false,
      spawn: spawner.spawn,
      probe,
      setTimer: timers.setTimer,
    });
    supervisor.create({ provider: "omp", name: "rd-omp", access: "read-only" });
    const shutdown = supervisor.shutdown();
    expect(spawner.children[0]!.signals).toEqual(["SIGTERM"]);
    expect(timers.fireNext(5_000)).toBe(5_000);
    await shutdown;
    expect(spawner.children[0]!.signals).toEqual(["SIGTERM", "SIGKILL"]);
    database.close();
  });
});
