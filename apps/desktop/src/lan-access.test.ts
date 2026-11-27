import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkFirewall,
  FIREWALL_SCRIPT,
  hostFor,
  legacyLanWanted,
  loadLanSetting,
  parseFirewallResult,
  saveLanSetting,
} from "./lan-access.js";
import { readLanUsage, stopServer, type ServerChild, type ServiceState } from "./hive-server.js";

let dir: string | undefined;
let server: Server | undefined;
afterEach(async () => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
  if (server) await new Promise((resolve) => server!.close(resolve));
  server = undefined;
});

const PROGRAM = "C:\\Users\\rd\\AppData\\Local\\SuperHive\\app-0.5.0\\SuperHive.exe";
const result = (rules: unknown, categories: unknown = [1]) => JSON.stringify({ rules, categories });

describe("局域网访问开关", () => {
  it("关着只听本机，开着听所有网卡", () => {
    expect(hostFor(false)).toBe("127.0.0.1");
    expect(hostFor(true)).toBe("0.0.0.0");
  });

  it("存下来的选择：没存过、文件坏了都是 undefined", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "superhive-lan-"));
    const file = path.join(dir, "lan-access.json");
    expect(loadLanSetting(file)).toBeUndefined();
    saveLanSetting(file, true);
    expect(loadLanSetting(file)).toBe(true);
    saveLanSetting(file, false);
    expect(loadLanSetting(file)).toBe(false);
    writeFileSync(file, "{not json");
    expect(loadLanSetting(file)).toBeUndefined();
    writeFileSync(file, JSON.stringify({ enabled: "yes" }));
    expect(loadLanSetting(file)).toBeUndefined();
  });

  it("老用户：有已登录的其它设备或访客会话就保持开启，查不到也保持开启", () => {
    expect(legacyLanWanted({ ownerDevices: 0, guestSessions: 0 })).toBe(false);
    expect(legacyLanWanted({ ownerDevices: 1, guestSessions: 0 })).toBe(true);
    expect(legacyLanWanted({ ownerDevices: 0, guestSessions: 2 })).toBe(true);
    expect(legacyLanWanted(undefined)).toBe(true);
  });
});

describe("Windows 防火墙只读检查", () => {
  it("当前网络类型上有允许规则、没有拦截：ok", () => {
    // 专用网络（category 1 → profile 2）
    expect(
      parseFirewallResult(result([{ Action: 2, Enabled: 1, Profile: 2 }]), PROGRAM).status,
    ).toBe("ok");
    // Profile 0 = 任意
    expect(
      parseFirewallResult(result([{ Action: 2, Enabled: 1, Profile: 0 }], [0]), PROGRAM).status,
    ).toBe("ok");
    // 只有一条规则时 ConvertTo-Json 可能输出对象而不是数组
    expect(
      parseFirewallResult(result({ Action: 2, Enabled: 1, Profile: 7 }, 1), PROGRAM).status,
    ).toBe("ok");
  });

  it("点了取消留下的拦截规则：blocked，拦截优先于允许", () => {
    const status = parseFirewallResult(
      result(
        [
          { Action: 2, Enabled: 1, Profile: 2 },
          { Action: 4, Enabled: 1, Profile: 4 },
        ],
        [0],
      ),
      PROGRAM,
    );
    expect(status).toEqual({ status: "blocked", program: PROGRAM });
    // 拦截规则只针对公用网络，现在连的是专用网络：不算被拦
    expect(
      parseFirewallResult(
        result(
          [
            { Action: 2, Enabled: 1, Profile: 2 },
            { Action: 4, Enabled: 1, Profile: 4 },
          ],
          [1],
        ),
        PROGRAM,
      ).status,
    ).toBe("ok");
  });

  it("没有规则、规则被停用、只放行了别的网络类型：missing", () => {
    expect(parseFirewallResult(result([]), PROGRAM).status).toBe("missing");
    expect(parseFirewallResult(result(null), PROGRAM).status).toBe("missing");
    expect(
      parseFirewallResult(result([{ Action: 2, Enabled: 2, Profile: 0 }]), PROGRAM).status,
    ).toBe("missing");
    expect(
      parseFirewallResult(result([{ Action: 2, Enabled: 1, Profile: 2 }], [0]), PROGRAM).status,
    ).toBe("missing");
    // 拿不到当前网络类型时三种都要放行
    expect(
      parseFirewallResult(result([{ Action: 2, Enabled: 1, Profile: 2 }], []), PROGRAM).status,
    ).toBe("missing");
  });

  it("rd 的 Windows 上实测的输出：0.4.9 放行了公用网络，0.4.8 被点了取消留下拦截", () => {
    const allowed =
      '{"rules":[{"Profile":4,"Action":2,"Enabled":1},{"Profile":4,"Action":2,"Enabled":1}],"categories":[0]}';
    const blocked =
      '{"rules":[{"Profile":4,"Action":4,"Enabled":1},{"Profile":4,"Action":4,"Enabled":1}],"categories":[0]}';
    expect(parseFirewallResult(allowed, PROGRAM).status).toBe("ok");
    expect(parseFirewallResult(`#< CLIXML\r\n${blocked}\r\n`, PROGRAM).status).toBe("blocked");
  });

  it("输出不是 JSON：unknown", () => {
    expect(parseFirewallResult("Get-NetFirewallRule : Access denied", PROGRAM).status).toBe(
      "unknown",
    );
  });

  it("只在 Windows 上查；路径经环境变量传，不拼进脚本；出错算 unknown", async () => {
    const calls: Array<{ script: string; env: Record<string, string> }> = [];
    const run = async (script: string, env: Record<string, string>) => {
      calls.push({ script, env });
      return result([{ Action: 2, Enabled: 1, Profile: 0 }]);
    };
    expect(await checkFirewall({ platform: "darwin", program: PROGRAM, run })).toBeNull();
    expect(calls).toHaveLength(0);
    expect(await checkFirewall({ platform: "win32", program: PROGRAM, run })).toEqual({
      status: "ok",
      program: PROGRAM,
    });
    expect(calls[0]!.script).toBe(FIREWALL_SCRIPT);
    expect(calls[0]!.script).not.toContain(PROGRAM);
    expect(calls[0]!.env).toEqual({ SUPERHIVE_FIREWALL_PROGRAM: PROGRAM });
    // 只读：脚本里没有任何改规则的命令
    expect(FIREWALL_SCRIPT).not.toMatch(/New-NetFirewallRule|Set-NetFirewallRule|netsh/i);
    expect(
      await checkFirewall({
        platform: "win32",
        program: PROGRAM,
        run: async () => {
          throw new Error("powershell missing");
        },
      }),
    ).toEqual({ status: "unknown", program: PROGRAM });
  });
});

/** 假 Server：记下请求，按路径回答 */
async function fakeHive(
  answer: (request: IncomingMessage, body: string) => { status: number; body?: unknown },
) {
  const requests: Array<{
    url: string;
    method: string;
    headers: IncomingMessage["headers"];
    body: string;
  }> = [];
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      requests.push({
        url: request.url ?? "",
        method: request.method ?? "",
        headers: request.headers,
        body,
      });
      const reply = answer(request, body);
      response.writeHead(reply.status, { "content-type": "application/json" });
      response.end(JSON.stringify(reply.body ?? {}));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { requests, healthUrl: `http://127.0.0.1:${port}/health` };
}

describe("和自己起的 Server 打交道", () => {
  it("问有没有别的设备连进来过：带启动口令；老 Server 没这个接口时是 undefined", async () => {
    const hive = await fakeHive((request) =>
      request.url === "/api/local/lan-usage"
        ? { status: 200, body: { ownerDevices: 1, guestSessions: 0 } }
        : { status: 404 },
    );
    expect(await readLanUsage({ healthUrl: hive.healthUrl, shutdownToken: "secret" })).toEqual({
      ownerDevices: 1,
      guestSessions: 0,
    });
    expect(hive.requests[0]!.headers["x-hive-shutdown"]).toBe("secret");
    expect(await readLanUsage({ healthUrl: hive.healthUrl })).toBeUndefined();
    const old = await fakeHive(() => ({ status: 404 }));
    expect(
      await readLanUsage({ healthUrl: old.healthUrl, shutdownToken: "secret" }),
    ).toBeUndefined();
  });

  it("切换开关时交接重启：关闭请求带 handover，本机 Agent 不下线", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "superhive-lan-stop-"));
    let exit: ((code: number) => void) | undefined;
    const hive = await fakeHive(() => {
      setImmediate(() => exit?.(0));
      return { status: 202, body: { ok: true, handover: true } };
    });
    const exited = new Promise<number>((resolve) => {
      exit = resolve;
    });
    const state = {
      pid: 1,
      instanceId: "a",
      healthUrl: hive.healthUrl,
      publicUrl: "",
      dataDir: dir,
      logPath: "",
      startedAt: "",
      shutdownToken: "secret",
    } satisfies ServiceState;
    let killed = false;
    const child = {
      pid: 1,
      kill: () => {
        killed = true;
      },
      on: () => undefined,
    } as unknown as ServerChild;
    await stopServer({
      state,
      child,
      exited,
      statePath: path.join(dir, "state.json"),
      handover: true,
    });
    expect(killed).toBe(false);
    const request = hive.requests.find((item) => item.url === "/api/local/shutdown")!;
    expect(request.method).toBe("POST");
    expect(request.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(request.body)).toEqual({ handover: true });
  });
});
