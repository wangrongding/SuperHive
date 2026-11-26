import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp, type BuildAppOptions } from "./app.js";
import { HiveDatabase } from "./database.js";
import {
  checkCwd,
  cliOption,
  joinArgumentName,
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

const cli = { command: "/usr/bin/node", args: ["/opt/superhive/dist/cli.js"] };
const probe = async (command: string) =>
  command === "opencode"
    ? { installed: true, version: "1.19.4" }
    : { installed: false, version: null };

describe("CLI arguments for the desktop app on Windows", () => {
  it("passes every string option as one --key=value argument", () => {
    expect(cliOption("server", "http://127.0.0.1:8787")).toBe("--server=http://127.0.0.1:8787");
    expect(cliOption("cwd", "C:\\Users\\a b")).toBe("--cwd=C:\\Users\\a b");
  });

  it("reads the agent name from both new and old join command lines", () => {
    expect(joinArgumentName(["cli.js", "join", "--server=http://x", "--name=rd-a"])).toBe("rd-a");
    expect(joinArgumentName(["cli.js", "join", "--server", "http://x", "--name", "rd-b"])).toBe(
      "rd-b",
    );
    expect(joinArgumentName(["cli.js", "join"])).toBeUndefined();
  });
});

describe("local agent routes", () => {
  let closeApp: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await closeApp?.();
    closeApp = undefined;
  });

  async function setup(
    extra: Partial<LocalAgentSupervisorOptions> & {
      publicUrl?: string | (() => string);
      networkProxy?: BuildAppOptions["networkProxy"];
    } = {},
  ) {
    const spawner = fakeSpawner();
    const { publicUrl, networkProxy, ...agentOptions } = extra;
    const app = await buildApp({
      databasePath: ":memory:",
      token: "join-token",
      staticDir: "/definitely-not-present",
      ...(publicUrl ? { publicUrl } : {}),
      ...(networkProxy !== undefined ? { networkProxy } : {}),
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

  it("builds the QR link from the current network address, not the one at startup", async () => {
    // 启动时连着手机热点，之后换到了 Wi-Fi
    let address = "172.20.10.6";
    const { app, owner } = await setup({ publicUrl: () => `http://${address}:8787` });
    const pair = async () =>
      new URL(
        (
          await app.inject({
            method: "POST",
            url: "/api/local/owner-devices/pair",
            headers: owner,
            payload: { origin: "http://localhost:5188" },
          })
        ).json().url as string,
      ).host;
    expect(await pair()).toBe("172.20.10.6:8787");
    address = "192.168.1.110";
    expect(await pair()).toBe("192.168.1.110:8787");
  });

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

  it("lets a logged-in owner device view the host, and manage it only after approval", async () => {
    const { app, owner, spawner } = await setup();
    const remote = { remoteAddress: "10.0.0.20" };
    const pair = (
      await app.inject({
        method: "POST",
        url: "/api/local/owner-devices/pair",
        headers: owner,
        payload: { origin: "http://10.0.0.8:8787" },
      })
    ).json() as { url: string };
    const ticket = new URL(pair.url).searchParams.get("login")!;
    const { token } = (
      await app.inject({
        method: "POST",
        url: "/api/owner-login",
        payload: { ticket, deviceName: "iPad" },
        ...remote,
      })
    ).json() as { token: string };
    const device = { authorization: `Bearer ${token}` };
    const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, extra = {}) =>
      app.inject({ method, url, headers: device, ...remote, ...extra });

    // 设备模式：不下发进程凭证
    const session = (await call("GET", "/api/local/session")).json();
    expect(session).toMatchObject({ enabled: true, mode: "device", manageUntil: null });
    expect(session.ownerToken).toBeUndefined();
    expect(JSON.stringify(session)).not.toContain(owner["x-hive-owner"]);

    // 只读直接可用
    expect((await call("GET", "/api/local/agents")).statusCode).toBe(200);
    expect((await call("GET", "/api/local/directories")).statusCode).toBe(200);
    expect((await call("GET", "/api/local/owner-devices")).statusCode).toBe(200);
    // 凭据类只限本机
    expect((await call("GET", "/api/local/owner-token")).json().code).toBe("LOCAL_ONLY");
    expect((await call("POST", "/api/local/owner-devices/pair")).json().code).toBe("LOCAL_ONLY");
    expect((await call("GET", "/api/local/approvals")).json().code).toBe("LOCAL_ONLY");
    expect((await call("GET", "/api/local/slow-ops")).json().code).toBe("LOCAL_ONLY");
    // 管理要先获批；测量会起进程，也算管理
    const directory = mkdtempSync(path.join(tmpdir(), "hive-device-"));
    const workspace = { provider: "omp", name: "rd-omp", access: "workspace", cwd: directory };
    expect((await call("POST", "/api/local/agents", { payload: workspace })).json().code).toBe(
      "MANAGE_REQUIRED",
    );
    expect(
      (await call("POST", "/api/local/mcp/measure", { payload: { provider: "claude" } })).json()
        .code,
    ).toBe("MANAGE_REQUIRED");
    expect(spawner.spawn).not.toHaveBeenCalled();

    // 申请 → 本机批准 → 12 小时内可管理
    expect(
      (
        await call("POST", "/api/local/rooms/general/clear", {
          payload: { username: "rd", whiteboard: "keep" },
        })
      ).json().code,
    ).toBe("MANAGE_REQUIRED");
    const request = (await call("POST", "/api/local/manage-request")).json();
    expect(request).toMatchObject({
      approval: { kind: "manage", status: "pending" },
      delivered: 0,
    });
    // 设备不能自己批准
    expect(
      (
        await call("POST", `/api/local/approvals/${request.approval.id}/decision`, {
          payload: { allow: true },
        })
      ).json().code,
    ).toBe("LOCAL_ONLY");
    const pending = (
      await app.inject({ method: "GET", url: "/api/local/approvals", headers: owner })
    ).json();
    expect(pending.approvals.map((item: { id: string }) => item.id)).toEqual([request.approval.id]);
    await app.inject({
      method: "POST",
      url: `/api/local/approvals/${request.approval.id}/decision`,
      headers: owner,
      payload: { allow: true },
    });
    expect((await call("GET", `/api/local/approvals/${request.approval.id}`)).json()).toMatchObject(
      { approval: { status: "approved" } },
    );
    expect((await call("GET", "/api/local/session")).json().manageUntil).toEqual(
      expect.any(String),
    );
    expect(
      (
        await call("POST", "/api/local/rooms/general/clear", { payload: { username: "absent" } })
      ).json().code,
    ).toBe("NOT_A_MEMBER");
    expect((await call("POST", "/api/local/agents", { payload: workspace })).statusCode).toBe(201);

    // 完全权限每次都要单独批准，批准单绑定这台设备和这次的参数、只能用一次
    const full = { provider: "omp", name: "rd-full", access: "full", cwd: directory };
    const first = (await call("POST", "/api/local/agents", { payload: full })).json();
    expect(first.code).toBe("APPROVAL_REQUIRED");
    await app.inject({
      method: "POST",
      url: `/api/local/approvals/${first.approval.id}/decision`,
      headers: owner,
      payload: { allow: true },
    });
    const withApproval = (payload: object) =>
      app.inject({
        method: "POST",
        url: "/api/local/agents",
        headers: { ...device, "x-hive-approval": first.approval.id },
        payload,
        ...remote,
      });
    expect((await withApproval({ ...full, name: "rd-other" })).json().code).toBe(
      "APPROVAL_REQUIRED",
    );
    expect((await withApproval(full)).statusCode).toBe(201);
    expect((await withApproval({ ...full, name: "rd-full2" })).json().code).toBe(
      "APPROVAL_REQUIRED",
    );

    // 总令牌、远程地址上的本机凭证都不行
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/local/agents",
          headers: { authorization: "Bearer join-token" },
          ...remote,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/local/agents",
          headers: { ...device, "x-hive-owner": "guess" },
          ...remote,
        })
      ).statusCode,
    ).toBe(403);

    // 重启也绑定配置：获批后改了 MCP，旧批准单不算数
    const claude = (
      await app.inject({
        method: "POST",
        url: "/api/local/agents",
        headers: owner,
        payload: { provider: "claude", name: "rd-claude", access: "full", cwd: directory },
      })
    ).json().agent as { id: string };
    const restart = (await call("POST", `/api/local/agents/${claude.id}/restart`)).json();
    expect(restart.code).toBe("APPROVAL_REQUIRED");
    await app.inject({
      method: "POST",
      url: `/api/local/approvals/${restart.approval.id}/decision`,
      headers: owner,
      payload: { allow: true },
    });
    expect(
      (
        await call("PUT", `/api/local/agents/${claude.id}/settings`, {
          payload: { mcpDisabled: ["something"] },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/local/agents/${claude.id}/restart`,
          headers: { ...device, "x-hive-approval": restart.approval.id },
          ...remote,
        })
      ).json().code,
    ).toBe("APPROVAL_REQUIRED");

    // 退出后立即失效
    await call("DELETE", `/api/local/owner-devices/${session.deviceId}`);
    expect((await call("GET", "/api/local/agents")).json().code).toBe("DEVICE_SESSION_INVALID");
    expect((await call("GET", "/api/local/session")).json().enabled).toBe(false);
    // 失效的设备令牌不能退回去按本机身份放行：本机请求带着它也拿不到本机凭证
    const stale = await app.inject({ method: "GET", url: "/api/local/session", headers: device });
    expect(stale.json()).toMatchObject({ enabled: false });
    expect(JSON.stringify(stale.json())).not.toContain(owner["x-hive-owner"]);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/local/agents",
          headers: { ...device, ...owner },
        })
      ).json().code,
    ).toBe("DEVICE_SESSION_INVALID");
  });

  it("drops an owner device's WebSocket once its session expires, like HTTP", async () => {
    let now = Date.now();
    const app = await buildApp({
      databasePath: ":memory:",
      token: "join-token",
      staticDir: "/definitely-not-present",
      now: () => now,
      accessSweepMs: 30,
      localAgents: { cli, serverUrl: "http://127.0.0.1:8787", spawn: fakeSpawner().spawn, probe },
    });
    closeApp = () => app.close();
    const { ownerToken } = (await app.inject({ method: "GET", url: "/api/local/session" })).json();
    const pair = (
      await app.inject({
        method: "POST",
        url: "/api/local/owner-devices/pair",
        headers: { "x-hive-owner": ownerToken },
        payload: { origin: "http://10.0.0.8:8787" },
      })
    ).json() as { url: string };
    const { token } = (
      await app.inject({
        method: "POST",
        url: "/api/owner-login",
        payload: { ticket: new URL(pair.url).searchParams.get("login"), deviceName: "iPad" },
        remoteAddress: "10.0.0.20",
      })
    ).json() as { token: string };
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as { port: number }).port;
    const { default: WebSocket } = await import("ws");
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const events: Array<{ type: string; code?: string }> = [];
    socket.on("message", (raw) => events.push(JSON.parse(raw.toString())));
    await new Promise((resolve) => socket.once("open", resolve));
    socket.send(
      JSON.stringify({
        type: "participant.join",
        username: "rd",
        participantType: "human",
        roomId: "general",
        token,
      }),
    );
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === "room.snapshot")).toBe(true),
    );
    const closed = new Promise<number>((resolve) => socket.once("close", resolve));
    now += 31 * 24 * 60 * 60_000;
    expect(await closed).toBe(4401);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "SESSION_REVOKED" });
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
      reasonText: { key: "error.local.proxied" },
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
      reason: "本机 Agent 已在服务端关闭。",
      reasonText: { key: "error.localAgent.disabled" },
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
      removedAgents: [],
      // 自动更新默认开；这里的 CLI 路径不存在，判断不出当前版本，所以不带 currentVersion
      autoUpdate: true,
    });
  });

  it("applies the network proxy setting to agents started afterwards", async () => {
    const { app, owner, spawner } = await setup({
      networkProxy: {
        env: () => ({ PATH: "/bin" }),
        readSystem: () => ({
          https: "http://127.0.0.1:7890",
          http: "http://127.0.0.1:7890",
          bypass: [".local"],
        }),
      },
    });
    const state = await app.inject({
      method: "GET",
      url: "/api/local/network-proxy",
      headers: owner,
    });
    expect(state.json()).toMatchObject({
      mode: "system",
      effective: { source: "system", url: "http://127.0.0.1:7890" },
    });
    const start = (name: string) =>
      app.inject({
        method: "POST",
        url: "/api/local/agents",
        headers: owner,
        payload: { provider: "agy", name, access: "read-only" },
      });
    expect((await start("rd-agy")).statusCode).toBe(201);
    expect(spawner.children[0]!.env).toMatchObject({
      HTTPS_PROXY: "http://127.0.0.1:7890",
      http_proxy: "http://127.0.0.1:7890",
      NO_PROXY: ".local,localhost,127.0.0.1,::1,[::1]",
      HIVE_AGENT_TOKEN: "join-token",
    });

    const bad = await app.inject({
      method: "PUT",
      url: "/api/local/network-proxy",
      headers: owner,
      payload: { mode: "manual", url: "127.0.0.1" },
    });
    expect(bad.statusCode).toBe(400);
    const manual = await app.inject({
      method: "PUT",
      url: "/api/local/network-proxy",
      headers: owner,
      payload: { mode: "manual", url: "socks5://u:pw@127.0.0.1:7891" },
    });
    expect(manual.statusCode).toBe(200);
    expect(manual.json()).toMatchObject({ mode: "manual", url: "socks5://***:***@127.0.0.1:7891" });
    expect((await start("rd-agy2")).statusCode).toBe(201);
    expect(spawner.children[1]!.env).toMatchObject({
      HTTPS_PROXY: "socks5://u:pw@127.0.0.1:7891",
      ALL_PROXY: "socks5://u:pw@127.0.0.1:7891",
    });
    const logs = await app.inject({
      method: "GET",
      url: `/api/local/agents/${(await app.inject({ method: "GET", url: "/api/local/agents", headers: owner })).json().agents.find((agent: { name: string }) => agent.name === "rd-agy2").id}/logs`,
      headers: owner,
    });
    expect(logs.json().lines).toContain("[hive] 网络代理：socks5://***:***@127.0.0.1:7891");
    expect(JSON.stringify(logs.json())).not.toContain("pw@");

    await app.inject({
      method: "PUT",
      url: "/api/local/network-proxy",
      headers: owner,
      payload: { mode: "none" },
    });
    expect((await start("rd-agy3")).statusCode).toBe(201);
    const third = spawner.spawn.mock.calls[2]![2];
    expect(third.env).not.toHaveProperty("HTTPS_PROXY");
    expect(third.unsetEnv).toEqual(expect.arrayContaining(["HTTPS_PROXY", "no_proxy"]));
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
      "/opt/superhive/dist/cli.js",
      "join",
      // 一律 --key=value：Windows 上 Electron 见到「网址参数后面跟开关」会直接退出
      "--server=http://127.0.0.1:8787",
      "--name=rd-opencode",
      "--provider=opencode",
      "--access=read-only",
      "--model=p/m",
      "--trust-room-workspace",
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
      const file = args
        .find((arg) => arg.startsWith("--agent-settings="))!
        .slice("--agent-settings=".length);
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
    const file = args
      .find((arg) => arg.startsWith("--agent-settings="))!
      .slice("--agent-settings=".length);
    expect(file).toBe(path.join(settingsDir, `${id}.json`));
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ mcpDisabled: [] });

    const measured = await app.inject({
      method: "POST",
      url: `/api/local/agents/${id}/mcp/measure`,
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
    // 其他 provider 也有设置文件（模型从这里读），只是没有 MCP 可勾选
    expect(spawner.children[1]!.args.some((arg) => arg.startsWith("--agent-settings="))).toBe(true);
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

  it("keeps the model in the settings file so a change applies on the next turn without a restart", async () => {
    const settingsDir = mkdtempSync(path.join(tmpdir(), "hive-agent-settings-"));
    const listModels = vi.fn(async () => ({
      source: "runtime" as const,
      models: [{ id: "zhipu/glm-5", label: "GLM-5" }, { id: "opencode/big-pickle" }],
      efforts: [],
    }));
    const { app, owner, spawner } = await setup({ settingsDir, listModels });
    const created = await app.inject({
      method: "POST",
      url: "/api/local/agents",
      headers: owner,
      payload: {
        provider: "opencode",
        name: "rd-opencode",
        access: "read-only",
        model: "zhipu/glm-5",
      },
    });
    const id = created.json().agent.id as string;
    const args = spawner.children[0]!.args;
    // 模型只从设置文件读：改回默认时才能真的回到默认
    expect(args).not.toContain("--model");
    const file = args
      .find((arg) => arg.startsWith("--agent-settings="))!
      .slice("--agent-settings=".length);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      mcpDisabled: [],
      model: "zhipu/glm-5",
    });

    const changed = await app.inject({
      method: "PUT",
      url: `/api/local/agents/${id}/settings`,
      headers: owner,
      payload: { model: " opencode/big-pickle " },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().agent.model).toBe("opencode/big-pickle");
    expect(JSON.parse(readFileSync(file, "utf8")).model).toBe("opencode/big-pickle");
    expect(spawner.children).toHaveLength(1);

    const cleared = await app.inject({
      method: "PUT",
      url: `/api/local/agents/${id}/settings`,
      headers: owner,
      payload: { model: null },
    });
    expect(cleared.json().agent.model).toBeNull();
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ mcpDisabled: [] });
    // 存进库里：重启 Server 后照旧
    const listedAgents = await app.inject({
      method: "GET",
      url: "/api/local/agents",
      headers: owner,
    });
    expect(listedAgents.json().agents[0].model).toBeNull();

    const models = await app.inject({
      method: "GET",
      url: `/api/local/agents/${id}/models`,
      headers: owner,
    });
    expect(models.json()).toEqual({
      source: "runtime",
      models: [{ id: "zhipu/glm-5", label: "GLM-5" }, { id: "opencode/big-pickle" }],
      efforts: [],
    });
    // opencode 不支持切换思考强度：不让设
    const effort = await app.inject({
      method: "PUT",
      url: `/api/local/agents/${id}/settings`,
      headers: owner,
      payload: { effort: "high" },
    });
    expect(effort.statusCode).toBe(400);
    expect(effort.json().code).toBe("LOCAL_AGENT_EFFORT_UNSUPPORTED");
    // 10 分钟内用缓存，refresh=1 重新拉
    await app.inject({ method: "GET", url: `/api/local/agents/${id}/models`, headers: owner });
    expect(listModels).toHaveBeenCalledTimes(1);
    await app.inject({
      method: "GET",
      url: `/api/local/agents/${id}/models?refresh=1`,
      headers: owner,
    });
    expect(listModels).toHaveBeenCalledTimes(2);
    expect(listModels).toHaveBeenCalledWith("opencode");
    // 不带房主凭证拿不到
    const anonymous = await app.inject({ method: "GET", url: `/api/local/agents/${id}/models` });
    expect(anonymous.statusCode).toBeGreaterThanOrEqual(400);
    rmSync(settingsDir, { recursive: true, force: true });
  });

  it("keeps Claude's compaction window and cache TTL in the settings file", async () => {
    const settingsDir = mkdtempSync(path.join(tmpdir(), "hive-agent-settings-"));
    const { app, owner, spawner } = await setup({ settingsDir });
    const created = await app.inject({
      method: "POST",
      url: "/api/local/agents",
      headers: owner,
      payload: { provider: "claude", name: "rd-claude", access: "read-only" },
    });
    const id = created.json().agent.id as string;
    // 没设过：null（Bridge 按默认 40 万），设置文件里也不写
    expect(created.json().agent).toMatchObject({ compactWindow: null, cacheTtl: null });
    const file = spawner.children[0]!.args.find((arg) =>
      arg.startsWith("--agent-settings="),
    )!.slice("--agent-settings=".length);
    const put = (payload: object) =>
      app.inject({
        method: "PUT",
        url: `/api/local/agents/${id}/settings`,
        headers: owner,
        payload,
      });
    const changed = await put({ compactWindow: 400_000, cacheTtl: "1h" });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().agent).toMatchObject({ compactWindow: 400_000, cacheTtl: "1h" });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      mcpDisabled: [],
      compactWindow: 400_000,
      cacheTtl: "1h",
    });
    // 只改一项，另一项保留；不重启进程
    expect((await put({ compactWindow: "auto" })).json().agent).toMatchObject({
      compactWindow: "auto",
      cacheTtl: "1h",
    });
    expect(spawner.children).toHaveLength(1);
    // Claude Code 不接受的值一律拒绝
    for (const payload of [
      { compactWindow: 50_000 },
      { compactWindow: "200k" },
      { cacheTtl: "10m" },
    ]) {
      expect((await put(payload)).statusCode).toBe(400);
    }
    const cleared = await put({ compactWindow: null, cacheTtl: null });
    expect(cleared.json().agent).toMatchObject({ compactWindow: null, cacheTtl: null });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ mcpDisabled: [] });
    const listed = await app.inject({ method: "GET", url: "/api/local/agents", headers: owner });
    expect(listed.json().agents[0]).toMatchObject({ compactWindow: null, cacheTtl: null });
    // 别的运行时没有这两项
    const codex = await app.inject({
      method: "POST",
      url: "/api/local/agents",
      headers: owner,
      payload: { provider: "codex", name: "rd-codex", access: "read-only" },
    });
    const rejected = await app.inject({
      method: "PUT",
      url: `/api/local/agents/${codex.json().agent.id as string}/settings`,
      headers: owner,
      payload: { cacheTtl: "1h" },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().code).toBe("LOCAL_AGENT_CONTEXT_UNSUPPORTED");
    rmSync(settingsDir, { recursive: true, force: true });
  });

  it("keeps the reasoning effort in the settings file and applies it on the next turn", async () => {
    const settingsDir = mkdtempSync(path.join(tmpdir(), "hive-agent-settings-"));
    const { app, owner, spawner } = await setup({ settingsDir });
    const created = await app.inject({
      method: "POST",
      url: "/api/local/agents",
      headers: owner,
      payload: { provider: "claude", name: "rd-claude", access: "read-only" },
    });
    const id = created.json().agent.id as string;
    expect(created.json().agent.effort).toBeNull();
    const file = spawner.children[0]!.args.find((arg) =>
      arg.startsWith("--agent-settings="),
    )!.slice("--agent-settings=".length);
    const changed = await app.inject({
      method: "PUT",
      url: `/api/local/agents/${id}/settings`,
      headers: owner,
      payload: { model: "opus", effort: "xhigh" },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().agent).toMatchObject({ model: "opus", effort: "xhigh" });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      mcpDisabled: [],
      model: "opus",
      effort: "xhigh",
    });
    // 改强度不重启进程
    expect(spawner.children).toHaveLength(1);
    // 不是档位名的一律拒绝（防止写进命令行参数）
    const bad = await app.inject({
      method: "PUT",
      url: `/api/local/agents/${id}/settings`,
      headers: owner,
      payload: { effort: "--dangerously-skip-permissions" },
    });
    expect(bad.statusCode).toBe(400);
    const cleared = await app.inject({
      method: "PUT",
      url: `/api/local/agents/${id}/settings`,
      headers: owner,
      payload: { effort: null },
    });
    expect(cleared.json().agent.effort).toBeNull();
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ mcpDisabled: [], model: "opus" });
    const listed = await app.inject({ method: "GET", url: "/api/local/agents", headers: owner });
    expect(listed.json().agents[0].effort).toBeNull();
    rmSync(settingsDir, { recursive: true, force: true });
  });

  it("reports why the model list could not be fetched instead of failing", async () => {
    const { app, owner } = await setup({
      listModels: async () => {
        throw new Error("spawn hive ENOENT");
      },
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/local/agents",
      headers: owner,
      payload: { provider: "codex", name: "rd-codex", access: "read-only" },
    });
    const models = await app.inject({
      method: "GET",
      url: `/api/local/agents/${created.json().agent.id}/models`,
      headers: owner,
    });
    expect(models.statusCode).toBe(200);
    // 拉不到模型也照样给出 Codex 能选的思考强度
    expect(models.json()).toEqual({
      source: "preset",
      models: [],
      efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
      error: "spawn hive ENOENT",
    });
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
    expect(listMcp.mock.calls[0]![0]).toEqual([
      "mcp",
      "list",
      "--provider=claude",
      `--cwd=${homedir()}`,
      "--json",
    ]);
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
    const file = args
      .find((arg) => arg.startsWith("--agent-settings="))!
      .slice("--agent-settings=".length);
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
      expect(spawner.children[0]!.args).toContain(`--cwd=${realpathSync(directory)}`);
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
        expect.arrayContaining(["--access=full", `--cwd=${realpathSync(directory)}`]),
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

  it("stores Claude's context settings so they survive a server restart", () => {
    const database = new HiveDatabase(":memory:");
    const { supervisor } = supervisorWith(database);
    const agent = supervisor.create({ provider: "claude", name: "rd-claude", access: "read-only" });
    supervisor.updateSettings(agent.id, { compactWindow: 600_000, cacheTtl: "5m" });
    expect(database.listLocalAgents()[0]).toMatchObject({ compactWindow: 600_000, cacheTtl: "5m" });
    supervisor.updateSettings(agent.id, { compactWindow: "auto" });
    expect(database.listLocalAgents()[0]).toMatchObject({ compactWindow: "auto", cacheTtl: "5m" });
    supervisor.updateSettings(agent.id, { compactWindow: null, cacheTtl: null });
    expect(database.listLocalAgents()[0]).toMatchObject({ compactWindow: null, cacheTtl: null });
  });

  it("records the pid once a Windows background launch reports it", async () => {
    const database = new HiveDatabase(":memory:");
    let reportPid!: (pid: number | undefined) => void;
    const late = new FakeChild(0, "node", [], {});
    const handle: ChildHandle = {
      get pid() {
        return undefined;
      },
      pidReady: new Promise((resolve) => (reportPid = resolve)),
      onOutput: (listener) => late.onOutput(listener),
      onExit: (listener) => late.onExit(listener),
      kill: (signal) => late.kill(signal),
    };
    const { supervisor } = supervisorWith(database, { spawn: vi.fn<SpawnAgent>(() => handle) });
    const agent = supervisor.create({ provider: "omp", name: "rd-omp", access: "read-only" });
    expect(supervisor.get(agent.id).pid).toBeNull();
    expect(database.listLocalAgents()[0]?.pid).toBeNull();
    reportPid(4321);
    await Promise.resolve();
    await Promise.resolve();
    expect(supervisor.get(agent.id).pid).toBe(4321);
    expect(database.listLocalAgents()[0]?.pid).toBe(4321);
  });

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
    ).toThrow("已被其他成员使用");
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
    expect(second.spawner.children.map((child) => joinArgumentName(child.args))).toEqual([
      "rd-omp",
    ]);
    expect(second.supervisor.get(stopped.id).status).toBe("stopped");
    expect(second.supervisor.get(running.id).status).toBe("starting");
    database.close();
  });

  it("moves an agent off a desktop install directory to home, and only borrows home for a missing one", () => {
    const database = new HiveDatabase(":memory:");
    const home = mkdtempSync(path.join(tmpdir(), "hive-home-"));
    try {
      // 早先桌面端把安装目录当默认工作目录：升级后旧的 app-<版本> 被删，路径还在配置里
      const installed = database.createLocalAgent({
        provider: "omp",
        name: "old-install",
        access: "workspace",
        cwd: path.join(home, "AppData", "Local", "SuperHive", "app-0.4.4"),
        model: null,
      });
      const missing = database.createLocalAgent({
        provider: "omp",
        name: "unplugged",
        access: "workspace",
        cwd: path.join(home, "external-drive", "project"),
        model: null,
      });
      const fine = database.createLocalAgent({
        provider: "omp",
        name: "fine",
        access: "workspace",
        cwd: home,
        model: null,
      });
      const log = vi.fn();
      const { supervisor, spawner, timers } = supervisorWith(database, { home: () => home, log });
      supervisor.start();
      while (spawner.children.length < 3) timers.fireNext();

      const cwdOf = (name: string) =>
        spawner.children
          .find((child) => joinArgumentName(child.args) === name)
          ?.args.find((arg) => arg.startsWith("--cwd="));
      expect(cwdOf("old-install")).toBe(`--cwd=${home}`);
      expect(cwdOf("unplugged")).toBe(`--cwd=${home}`);
      expect(cwdOf("fine")).toBe(`--cwd=${home}`);

      const stored = new Map(database.listLocalAgents().map((agent) => [agent.name, agent.cwd]));
      // 安装目录本来就不该是工作目录：配置一并改掉；不存在的目录可能只是外接盘没插上：配置保留
      expect(stored.get("old-install")).toBe(home);
      expect(stored.get("unplugged")).toBe(path.join(home, "external-drive", "project"));

      expect(supervisor.get(installed.id)).toMatchObject({
        cwd: home,
        cwdFallback: { reason: "installDir", to: home },
      });
      expect(supervisor.get(missing.id)).toMatchObject({
        cwd: path.join(home, "external-drive", "project"),
        cwdFallback: { reason: "missing", to: home },
      });
      expect(supervisor.get(fine.id).cwdFallback).toBeUndefined();
      expect(supervisor.logs(installed.id).join("\n")).toContain("桌面端的安装目录");
      expect(supervisor.logs(missing.id).join("\n")).toContain("不存在");
      expect(log).toHaveBeenCalledWith(expect.stringContaining("old-install"));
    } finally {
      database.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("checks working directories by shape for install folders and by existence otherwise", () => {
    const home = "/Users/someone";
    expect(checkCwd(null, home)).toBeUndefined();
    expect(checkCwd(tmpdir(), home)).toBeUndefined();
    expect(checkCwd("C:\\Users\\zphz\\AppData\\Local\\SuperHive\\app-0.4.4", home)).toEqual({
      reason: "installDir",
      from: "C:\\Users\\zphz\\AppData\\Local\\SuperHive\\app-0.4.4",
      to: home,
    });
    expect(checkCwd("/Applications/SuperHive.app/Contents/Resources", home)?.reason).toBe(
      "installDir",
    );
    expect(checkCwd(path.join(tmpdir(), "definitely-not-here-0f3a"), home)?.reason).toBe("missing");
  });

  it("staggers restored launches, and stopping or starting cancels the queued one", async () => {
    const database = new HiveDatabase(":memory:");
    const first = supervisorWith(database);
    const ids = ["a", "b", "c", "d"].map(
      (name) => first.supervisor.create({ provider: "omp", name, access: "read-only" }).id,
    );
    await first.supervisor.shutdown();

    const second = supervisorWith(database);
    second.supervisor.start();
    const names = () => second.spawner.children.map((child) => joinArgumentName(child.args));
    // 第一个立即启动，其余排队，排队中也显示「启动中」
    expect(names()).toEqual(["a"]);
    expect(second.timers.timers.map((timer) => timer.ms)).toEqual([2_000, 4_000, 6_000]);
    expect(second.supervisor.get(ids[1]!).status).toBe("starting");
    expect(second.supervisor.logs(ids[1]!).join("\n")).toContain("2 秒后启动");

    // 排队中手动停止：不再启动；手动启动：立即启动，不再等
    await second.supervisor.stop(ids[1]!);
    second.supervisor.startAgent(ids[3]!);
    expect(names()).toEqual(["a", "d"]);
    expect(
      second.timers.timers.filter((timer) => !timer.cancelled).map((timer) => timer.ms),
    ).toEqual([4_000]);
    second.timers.fireNext();
    expect(names()).toEqual(["a", "d", "c"]);
    expect(second.supervisor.get(ids[1]!).status).toBe("stopped");
    database.close();
  });

  it("refuses settings changes while restarting, and the guard can stop a changed config from launching", async () => {
    const database = new HiveDatabase(":memory:");
    const spawner = fakeSpawner({ exitOnTerm: false });
    const supervisor = new LocalAgentSupervisor({
      database,
      cli,
      serverUrl: "http://127.0.0.1:8787",
      joinToken: "join-token",
      isAgentOnline: () => false,
      isNameInUse: () => false,
      spawn: spawner.spawn,
      probe,
      setTimer: manualTimers().setTimer,
      settingsDir: mkdtempSync(path.join(tmpdir(), "hive-settings-")),
    });
    const directory = mkdtempSync(path.join(tmpdir(), "hive-restart-"));
    const agent = supervisor.create({
      provider: "claude",
      name: "rd-claude",
      access: "full",
      cwd: directory,
    });
    // 等旧进程退出期间改 MCP：拒绝，新进程用的仍是批准时的配置
    const restarting = supervisor.restart(agent.id, (current) => current.mcpDisabled.length === 0);
    expect(() => supervisor.updateSettings(agent.id, { mcpDisabled: ["x"] })).toThrow(
      expect.objectContaining({ code: "LOCAL_AGENT_BUSY" }),
    );
    spawner.children[0]!.exit(0);
    expect((await restarting).mcpDisabled).toEqual([]);
    expect(spawner.children).toHaveLength(2);

    // 配置和批准时不一致：停下，不启动
    supervisor.updateSettings(agent.id, { mcpDisabled: ["x"] });
    const guarded = supervisor.restart(agent.id, (current) => current.mcpDisabled.length === 0);
    spawner.children[1]!.exit(0);
    await expect(guarded).rejects.toMatchObject({ code: "LOCAL_AGENT_CONFIG_CHANGED" });
    expect(spawner.children).toHaveLength(2);
    expect(supervisor.list()[0]!.status).toBe("stopped");
    await supervisor.shutdown();
    database.close();
  });

  it("ends an untracked leftover process of the same agent on launch, stop and remove", async () => {
    const database = new HiveDatabase(":memory:");
    const spawner = fakeSpawner();
    const timers = manualTimers();
    const settingsDir = mkdtempSync(path.join(tmpdir(), "hive-settings-"));
    let strays = [424242];
    const killed: Array<[number, string]> = [];
    const shutdowns: string[] = [];
    const supervisor = new LocalAgentSupervisor({
      database,
      cli,
      serverUrl: "http://127.0.0.1:8787",
      joinToken: "join-token",
      isAgentOnline: () => false,
      isNameInUse: () => false,
      requestShutdown: (name) => {
        shutdowns.push(name);
        return true;
      },
      spawn: spawner.spawn,
      probe,
      setTimer: timers.setTimer,
      settingsDir,
      findStrays: (file) => {
        expect(file.startsWith(settingsDir)).toBe(true);
        return strays;
      },
      killStray: (pid, signal) => killed.push([pid, signal]),
    });
    const agent = supervisor.create({
      provider: "claude",
      name: "rd-claude4",
      access: "full",
      cwd: mkdtempSync(path.join(tmpdir(), "hive-stray-")),
    });
    // 启动前先请占着名字的旧进程退出
    expect(killed).toEqual([[424242, "SIGTERM"]]);
    expect(spawner.children).toHaveLength(1);
    // 删除：自己的进程结束后，再结束旧进程、请同名连接下线，宽限期后还在就 SIGKILL（假 pid 早已不在，不再补刀）
    killed.length = 0;
    strays = [424243];
    const removing = supervisor.remove(agent.id);
    await vi.waitFor(() => expect(killed).toEqual([[424243, "SIGTERM"]]));
    expect(shutdowns).toEqual(["rd-claude4"]);
    timers.fireNext();
    await removing;
    expect(supervisor.list()).toEqual([]);
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
