import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PluginRegistry,
  registerPluginLocalRoutes,
  registerPluginRoomRoutes,
  resolvePluginMcpCommand,
} from "./plugins.js";

const EXAMPLE = path.resolve(import.meta.dirname, "../../../examples/plugins/dice");

let dir: string;
let app: FastifyInstance;
let registry: PluginRegistry;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "hive-plugins-"));
  cpSync(EXAMPLE, path.join(dir, "dice"), { recursive: true });
  registry = new PluginRegistry({ dir, hostVersion: "0.4.8" });
  app = Fastify();
  registerPluginLocalRoutes(app, {
    registry,
    authorizeLocal: (request, reply) => {
      if (request.headers["x-local"] === "1") return true;
      void reply.code(403).send({ code: "LOCAL_ONLY" });
      return false;
    },
  });
  registerPluginRoomRoutes(app, {
    registry,
    authorizeRoom: (request, reply) => {
      const who = request.headers["x-viewer"];
      if (who === "owner" || who === "guest") return who;
      void reply.code(401).send({ code: "UNAUTHORIZED" });
      return undefined;
    },
    frameAncestorOf: () => undefined,
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

const local = { "x-local": "1" };
const owner = { "x-viewer": "owner" };

async function openPanel(headers: Record<string, string> = owner) {
  const response = await app.inject({
    method: "POST",
    url: "/api/rooms/r1/plugins/dice/panels/main/frame",
    headers,
  });
  return response;
}

describe("插件原型", () => {
  it("没批准前房间里看不到，面板也开不了", async () => {
    const list = await app.inject({ url: "/api/rooms/r1/plugins", headers: owner });
    expect(list.json()).toEqual({ plugins: [] });
    expect((await openPanel()).statusCode).toBe(404);
    const locals = await app.inject({ url: "/api/local/plugins", headers: local });
    expect(locals.json().plugins[0]).toMatchObject({ id: "dice", state: "needs-approval" });
  });

  it("只有本机房主能批准", async () => {
    const denied = await app.inject({
      method: "POST",
      url: "/api/local/plugins/dice/grant",
      headers: owner,
    });
    expect(denied.statusCode).toBe(403);
  });

  it("批准后面板带无同源沙箱和禁止联网的 CSP；撤销后已发的地址立即失效", async () => {
    const granted = await app.inject({
      method: "POST",
      url: "/api/local/plugins/dice/grant",
      headers: local,
    });
    expect(granted.json().plugin).toMatchObject({ state: "enabled" });
    const list = await app.inject({ url: "/api/rooms/r1/plugins", headers: owner });
    expect(list.json().plugins[0]).toMatchObject({
      id: "dice",
      permissions: ["members:read", "composer:write"],
      commands: [{ name: "roll" }],
    });

    const { url } = (await openPanel()).json() as { url: string };
    const page = await app.inject({ url });
    expect(page.statusCode).toBe(200);
    const csp = String(page.headers["content-security-policy"]);
    expect(csp).toContain("sandbox allow-scripts allow-forms");
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).toContain("connect-src 'none'");
    // 相对路径的脚本挂在同一个前缀下
    const script = await app.inject({ url: url.replace("panel.html", "sdk.js") });
    expect(script.headers["content-type"]).toContain("text/javascript");

    await app.inject({ method: "DELETE", url: "/api/local/plugins/dice/grant", headers: local });
    expect((await app.inject({ url })).statusCode).toBe(404);
  });

  it("访客默认看不到插件", async () => {
    await app.inject({ method: "POST", url: "/api/local/plugins/dice/grant", headers: local });
    const list = await app.inject({
      url: "/api/rooms/r1/plugins",
      headers: { "x-viewer": "guest" },
    });
    expect(list.json()).toEqual({ plugins: [] });
    expect((await openPanel({ "x-viewer": "guest" })).statusCode).toBe(404);
  });

  it("升级后多申请权限要重新批准", async () => {
    await app.inject({ method: "POST", url: "/api/local/plugins/dice/grant", headers: local });
    const file = path.join(dir, "dice", "superhive-plugin.json");
    const manifest = JSON.parse((await import("node:fs")).readFileSync(file, "utf8")) as Record<
      string,
      unknown
    >;
    writeFileSync(
      file,
      JSON.stringify({
        ...manifest,
        version: "0.2.0",
        permissions: ["room:read", "composer:write"],
      }),
    );
    const locals = await app.inject({ url: "/api/local/plugins", headers: local });
    expect(locals.json().plugins[0]).toMatchObject({ state: "needs-approval" });
    expect((await app.inject({ url: "/api/rooms/r1/plugins", headers: owner })).json()).toEqual({
      plugins: [],
    });
  });

  it("批准记录写盘，重启后还在", async () => {
    await app.inject({ method: "POST", url: "/api/local/plugins/dice/grant", headers: local });
    const again = new PluginRegistry({ dir, hostVersion: "0.4.8" });
    expect(again.enabled("owner").map((plugin) => plugin.id)).toEqual(["dice"]);
  });

  it("房主手动删掉 .grants.json 等于全部撤销，不用重启", async () => {
    await app.inject({ method: "POST", url: "/api/local/plugins/dice/grant", headers: local });
    expect(registry.enabled("owner")).toHaveLength(1);
    rmSync(path.join(dir, ".grants.json"));
    expect(registry.enabled("owner")).toEqual([]);
  });

  it("版本不兼容、id 和目录不一致的插件不加载", () => {
    expect(new PluginRegistry({ dir, hostVersion: "0.3.0" }).list()[0]).toMatchObject({
      state: "invalid",
    });
    mkdirSync(path.join(dir, "other"));
    writeFileSync(
      path.join(dir, "other", "superhive-plugin.json"),
      JSON.stringify({ id: "dice2", name: "x", version: "0.1.0", engines: { superhive: "*" } }),
    );
    expect(registry.list().find((plugin) => plugin.id === "other")).toMatchObject({
      state: "invalid",
    });
  });

  it("面板取文件不能跳出插件目录，软链也不行，未知扩展名不给", async () => {
    await registry.grant("dice");
    writeFileSync(path.join(dir, "secret.js"), "secret");
    symlinkSync(path.join(dir, "secret.js"), path.join(dir, "dice", "link.js"));
    writeFileSync(path.join(dir, "dice", "run.sh"), "echo");
    expect(registry.asset("dice", "../secret.js")).toBeUndefined();
    expect(registry.asset("dice", "link.js")).toBeUndefined();
    expect(registry.asset("dice", "run.sh")).toBeUndefined();
    expect(registry.asset("dice", "panel.js")).toBeDefined();
    const { url } = (await openPanel()).json() as { url: string };
    const escaped = await app.inject({ url: url.replace("panel.html", "..%2F..%2Fsecret.js") });
    expect(escaped.statusCode).toBe(404);
  });
});

describe("插件 MCP 扩展点", () => {
  type Written = Record<string, Record<string, { command: string; args: string[] }>>;
  let written: Written;
  let changes: number;

  beforeEach(() => {
    written = {};
    changes = 0;
    registry = new PluginRegistry({
      dir,
      hostVersion: "0.4.8",
      onChange: () => (changes += 1),
      mcp: {
        put: (provider, entry, server) => {
          if (provider === "copilot") throw new Error("配置读不懂");
          (written[provider] ??= {})[entry] = server;
        },
        remove: (provider, entry) => {
          delete written[provider]?.[entry];
        },
      },
    });
  });

  it("没批准插件前不能确认 MCP", async () => {
    await expect(registry.setMcp("dice", "dice", ["claude"])).rejects.toMatchObject({
      code: "PLUGIN_NOT_APPROVED",
    });
    expect(written).toEqual({});
  });

  it("确认后按插件目录解析成绝对路径写进所选运行时，撤销插件时一并删掉", async () => {
    await registry.grant("dice");
    const plugin = await registry.setMcp("dice", "dice", ["claude", "codex"]);
    const expected = { command: "node", args: [path.join(dir, "dice", "mcp.mjs")] };
    expect(written).toEqual({
      claude: { "plugin-dice-dice": expected },
      codex: { "plugin-dice-dice": expected },
    });
    expect(plugin.mcpServers[0]).toMatchObject({
      name: "dice",
      providers: ["claude", "codex"],
      state: "confirmed",
    });
    // 去掉一个运行时：只删那一个
    await registry.setMcp("dice", "dice", ["claude"]);
    expect(written).toEqual({ claude: { "plugin-dice-dice": expected }, codex: {} });
    await registry.revoke("dice");
    expect(written).toEqual({ claude: {}, codex: {} });
    expect(registry.list()[0]?.mcpServers[0]).toMatchObject({ state: "pending", providers: [] });
    expect(changes).toBe(4);
  });

  it("写某个运行时失败时把这次写进去的撤回，批准记录不变", async () => {
    await registry.grant("dice");
    await expect(registry.setMcp("dice", "dice", ["claude", "copilot"])).rejects.toMatchObject({
      code: "PLUGIN_MCP_WRITE_FAILED",
    });
    expect(written).toEqual({ claude: {} });
    expect(registry.list()[0]?.mcpServers[0]).toMatchObject({ state: "pending" });
  });

  it("清单改了命令要重新确认", async () => {
    await registry.grant("dice");
    await registry.setMcp("dice", "dice", ["claude"]);
    const file = path.join(dir, "dice", "superhive-plugin.json");
    const manifest = JSON.parse(readFileSync(file, "utf8")) as {
      contributes: { mcpServers: Array<{ args: string[] }> };
    };
    manifest.contributes.mcpServers[0]!.args = ["./other.mjs"];
    writeFileSync(file, JSON.stringify(manifest));
    expect(registry.list()[0]?.mcpServers[0]).toMatchObject({ state: "changed" });
  });

  it("命令不能跳出插件目录，也不能写带路径的程序", () => {
    expect(() => resolvePluginMcpCommand(dir, { command: "../evil", args: [] })).toThrow();
    expect(() => resolvePluginMcpCommand(dir, { command: "/bin/sh", args: [] })).toThrow();
    expect(() =>
      resolvePluginMcpCommand(dir, { command: "node", args: ["../../etc/passwd"] }),
    ).toThrow();
    expect(resolvePluginMcpCommand(dir, { command: "./bin/run", args: ["--x"] })).toEqual({
      command: path.join(dir, "bin", "run"),
      args: ["--x"],
    });
  });

  it("接口：只有本机房主能确认，参数不对 400", async () => {
    const routes = Fastify();
    registerPluginLocalRoutes(routes, {
      registry,
      authorizeLocal: (request, reply) => {
        if (request.headers["x-local"] === "1") return true;
        void reply.code(403).send({ code: "LOCAL_ONLY" });
        return false;
      },
    });
    await routes.ready();
    const put = (headers: Record<string, string>, payload: Record<string, unknown>) =>
      routes.inject({ method: "PUT", url: "/api/local/plugins/dice/mcp/dice", headers, payload });
    expect((await put({}, { providers: ["claude"] })).statusCode).toBe(403);
    expect((await put(local, { providers: ["claude"] })).statusCode).toBe(409);
    await registry.grant("dice");
    expect((await put(local, { providers: ["nope"] })).statusCode).toBe(400);
    const ok = await put(local, { providers: ["claude"] });
    expect(ok.statusCode).toBe(200);
    const listed = await routes.inject({ url: "/api/local/plugins", headers: local });
    expect(listed.json().mcpProviders).toContain("claude");
    await routes.close();
  });
});
