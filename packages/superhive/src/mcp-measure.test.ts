import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseCheckInput } from "./mcp-command.js";
import { classifyMcpError, measureMcpServer } from "./mcp-measure.js";

/** 不依赖任何包的最小 stdio MCP：回 initialize 和 tools/list，两个工具 */
const FAKE_SERVER = `
let buffer = "";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id, result: {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "fake", version: "1.0.0" },
      } });
    } else if (message.method === "tools/list") {
      send({ jsonrpc: "2.0", id: message.id, result: { tools: [
        { name: "one", description: "first", inputSchema: { type: "object" } },
        { name: "two", description: "second", inputSchema: { type: "object" } },
      ] } });
    }
  }
});
`;

/** 启动就报错退出的进程，模拟缺依赖的 MCP */
const CRASHING_SERVER = `process.stderr.write("Error: Cannot find module 'left-pad'\\n"); process.exit(1);`;

describe("classifyMcpError", () => {
  it("treats 401 / 403 from a remote server as needing login", () => {
    expect(classifyMcpError("http", new StreamableHTTPError(401, "nope"))).toEqual({
      problem: "auth",
      error: "服务要求登录或密钥（HTTP 401）",
    });
    expect(classifyMcpError("http", new StreamableHTTPError(403, "nope")).problem).toBe("auth");
    expect(classifyMcpError("sse", new UnauthorizedError()).problem).toBe("auth");
  });

  it("turns network error codes into a short reason", () => {
    const error = new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    });
    expect(classifyMcpError("http", error)).toEqual({
      problem: "unreachable",
      error: "连接被拒绝，服务可能没开（ECONNREFUSED）",
    });
    expect(classifyMcpError("http", new StreamableHTTPError(404, "x"))).toEqual({
      problem: "unreachable",
      error: "服务返回了 HTTP 404",
    });
  });

  it("reports local commands as failing to start, with the last stderr line", () => {
    const missing = Object.assign(new Error("spawn npx ENOENT"), { code: "ENOENT" });
    expect(classifyMcpError("stdio", missing)).toEqual({
      problem: "failed",
      error: "找不到要运行的命令",
    });
    expect(
      classifyMcpError("stdio", new Error("Connection closed"), "npm WARN x\nError: boom\n\n"),
    ).toEqual({ problem: "failed", error: "Connection closed：Error: boom" });
  });
});

describe("measureMcpServer", () => {
  let dir: string;
  let http: Server;
  let base: string;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "mcp-measure-"));
    writeFileSync(path.join(dir, "fake.mjs"), FAKE_SERVER);
    writeFileSync(path.join(dir, "crash.mjs"), CRASHING_SERVER);
    http = createServer((request, response) => {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "unauthorized" }));
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => http.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });

  it("counts the tools of a working stdio server", async () => {
    const result = await measureMcpServer({
      name: "fake",
      scope: "user",
      transport: "stdio",
      config: { command: process.execPath, args: [path.join(dir, "fake.mjs")] },
    });
    expect(result).toMatchObject({ ok: true, tools: 2 });
  });

  it("says a stdio server could not start and why", async () => {
    const crashed = await measureMcpServer({
      name: "crash",
      scope: "user",
      transport: "stdio",
      config: { command: process.execPath, args: [path.join(dir, "crash.mjs")] },
    });
    expect(crashed).toMatchObject({ ok: false, problem: "failed" });
    expect(!crashed.ok && crashed.error).toContain("Cannot find module");

    const missing = await measureMcpServer({
      name: "missing",
      scope: "user",
      transport: "stdio",
      config: { command: path.join(dir, "no-such-command") },
    });
    expect(missing).toEqual({ ok: false, problem: "failed", error: "找不到要运行的命令" });
  });

  it("says a remote server needs login when it answers 401", async () => {
    const result = await measureMcpServer({
      name: "remote",
      scope: "user",
      transport: "http",
      config: { url: `${base}/mcp`, headers: { Authorization: "Bearer wrong" } },
    });
    expect(result).toEqual({
      ok: false,
      problem: "auth",
      error: "服务要求登录或密钥（HTTP 401）",
    });
  });

  it("says a remote server is unreachable when nothing listens there", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    const result = await measureMcpServer({
      name: "gone",
      scope: "user",
      transport: "http",
      config: { url: `http://127.0.0.1:${port}/mcp` },
    });
    expect(result).toMatchObject({ ok: false, problem: "unreachable" });
    expect(!result.ok && result.error).toContain("ECONNREFUSED");

    expect(
      await measureMcpServer({
        name: "bad",
        scope: "user",
        transport: "http",
        config: { url: "not a url" },
      }),
    ).toEqual({ ok: false, problem: "unreachable", error: "地址写得不对" });
  });
});

describe("parseCheckInput", () => {
  it("accepts a transport plus config and rejects anything else", () => {
    expect(parseCheckInput('{"transport":"http","config":{"url":"https://x"}}')).toEqual({
      name: "check",
      scope: "user",
      transport: "http",
      config: { url: "https://x" },
    });
    expect(parseCheckInput("nope")).toBeUndefined();
    expect(parseCheckInput('{"transport":"ws","config":{}}')).toBeUndefined();
    expect(parseCheckInput('{"transport":"stdio","config":[]}')).toBeUndefined();
  });
});
