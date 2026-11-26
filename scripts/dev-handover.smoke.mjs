// Opt-in isolated smoke test: a local Agent keeps running its task across dev Server restarts.
// Copies this checkout into a temp dir, runs pnpm dev there on free ports with its own database and HOME,
// and drives a real `hive join` (echo provider that waits HIVE_ECHO_DELAY_MS before replying).
// Never touches the active checkout, port 8787 or real Agents.
import assert from "node:assert/strict";
import console from "node:console";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startProcess } from "./dev-supervisor.mjs";

const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hive-handover-smoke-"));
const TASK_MS = 25_000;
const TOKEN = randomUUID();
let dev;
let logs = "";
const started = [];
const agentPids = new Set();
let lastAgent;

function copy(relative) {
  const destination = path.join(root, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(path.join(checkout, relative), destination, { recursive: true });
}

function dependencies(pkg) {
  const source = path.join(checkout, pkg, "node_modules");
  const destination = path.join(root, pkg, "node_modules");
  fs.mkdirSync(destination, { recursive: true });
  for (const name of fs.readdirSync(source)) {
    if (name === "@superhive") continue;
    fs.symlinkSync(path.join(source, name), path.join(destination, name));
  }
  fs.mkdirSync(path.join(destination, "@superhive"), { recursive: true });
  for (const target of ["protocol", "superhive"])
    if (fs.existsSync(path.join(source, "@superhive", target)))
      fs.symlinkSync(
        path.join(root, "packages", target),
        path.join(destination, "@superhive", target),
        "dir",
      );
}

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

function readStatus() {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, ".superhive-dev/status.json"), "utf8"));
  } catch {
    return undefined;
  }
}

async function waitReady(generation, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (dev.finished) throw new Error("isolated dev process exited unexpectedly");
    const status = readStatus();
    if (status?.state === "ready" && status.generation >= generation) return status;
    if (status?.state === "failed" && status.generation >= generation)
      throw new Error(status.error);
    await delay(200);
  }
  throw new Error(`timed out waiting for ready generation ${generation}`);
}

const serverPort = await freePort();
let webPort = await freePort();
while (webPort === serverPort) webPort = await freePort();
const base = `http://127.0.0.1:${serverPort}`;
const home = path.join(root, "home");
const require = createRequire(path.join(checkout, "apps/server/package.json"));

function startDev(label) {
  const child = startProcess(process.execPath, [path.join(root, "scripts/dev.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      HOME: home,
      HIVE_HOST: "127.0.0.1",
      HIVE_PORT: String(serverPort),
      HIVE_DEV_WEB_PORT: String(webPort),
      HIVE_DATABASE: path.join(root, "data/test.sqlite"),
      HIVE_TOKEN: TOKEN,
      HIVE_WORKTREE_DEPS: "0",
      // 本机 Agent 用 echo 替身：真实的 hive join，只是回复前先等一阵，模拟跑到一半的任务
      HIVE_LOCAL_AGENT_CLI: JSON.stringify([
        process.execPath,
        "--import",
        pathToFileURL(require.resolve("tsx")).href,
        path.join(root, "packages/superhive/src/echo.ts"),
      ]),
      HIVE_ECHO_DELAY_MS: String(TASK_MS),
      VITE_HIVE_SERVER: base,
    },
    stdio: ["ignore", "pipe", "pipe"],
    stopGraceMs: 20_000,
  });
  started.push(child);
  for (const stream of [child.child.stdout, child.child.stderr])
    stream.on("data", (data) => {
      logs = (logs + `[${label}] ${data}`).slice(-80_000);
    });
  return child;
}

async function api(method, url, body, owner) {
  const response = await globalThis.fetch(`${base}${url}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(owner ? { "x-hive-owner": owner } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

/** 以人的身份进房间：发消息、收到 Agent 的回复 */
async function human() {
  const socket = new globalThis.WebSocket(`ws://127.0.0.1:${serverPort}/ws`);
  const messages = [];
  const invocations = new Map();
  socket.addEventListener("message", (event) => {
    const data = JSON.parse(String(event.data));
    if (data.type === "message.created") messages.push(data.message);
    if (data.type === "invocation.updated") invocations.set(data.invocation.id, data.invocation);
    if (data.type === "room.snapshot") {
      messages.push(...data.messages);
      for (const invocation of data.invocations) invocations.set(invocation.id, invocation);
    }
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.send(
    JSON.stringify({
      type: "participant.join",
      username: "smoke-human",
      participantType: "human",
      roomId: "general",
      token: TOKEN,
    }),
  );
  return {
    messages,
    invocations,
    send(content) {
      socket.send(JSON.stringify({ type: "message.send", clientMessageId: randomUUID(), content }));
    },
    close() {
      socket.close();
    },
  };
}

/** 本机房主令牌每个 Server 进程各不相同：换代后要重新拿 */
async function ownerToken() {
  return (await api("GET", "/api/local/session")).body.ownerToken;
}

async function agentPid() {
  const { body } = await api("GET", "/api/local/agents", undefined, await ownerToken());
  const agent = body.agents.find((item) => item.name === "smoke-echo");
  lastAgent = agent;
  return agent?.status === "running" ? agent.pid : undefined;
}

async function untilValue(read, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read().catch(() => undefined);
    if (value) return value;
    await delay(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** 让 Agent 开始一轮任务，等它真的开始跑；返回等回复的函数 */
async function startTask(tag) {
  const room = await untilValue(() => human(), 30_000, "human join");
  await delay(500);
  room.send(`@smoke-echo ${tag}`);
  // 调用进入执行中（Agent 已经在等那 25 秒）
  await untilValue(
    async () =>
      [...room.invocations.values()].some(
        (item) => item.agentName === "smoke-echo" && item.status === "running",
      ),
    30_000,
    `${tag} running`,
  );
  room.close();
  // 回复要在新 Server 上看到：每次重新进房间拿快照
  return (timeoutMs) =>
    untilValue(
      async () => {
        const next = await human();
        await delay(1_000);
        next.close();
        const reply = next.messages.find(
          (message) => message.senderName === "smoke-echo" && message.content.includes(tag),
        );
        const invocation = [...next.invocations.values()].find(
          (item) => item.agentName === "smoke-echo" && item.status !== "completed",
        );
        // 没落定的调用不能是「结果未知」那几种
        if (invocation)
          assert.ok(["queued", "running"].includes(invocation.status), invocation.status);
        return reply;
      },
      timeoutMs,
      `${tag} reply`,
    );
}

try {
  for (const file of [
    "package.json",
    "pnpm-workspace.yaml",
    "pnpm-lock.yaml",
    "tsconfig.base.json",
    "scripts",
  ])
    copy(file);
  fs.symlinkSync(path.join(checkout, "node_modules"), path.join(root, "node_modules"), "dir");
  for (const pkg of ["packages/protocol", "packages/superhive", "apps/server", "apps/web"]) {
    for (const file of ["package.json", "tsconfig.json", "src"]) copy(`${pkg}/${file}`);
    dependencies(pkg);
  }
  for (const file of [
    "index.html",
    "vite.config.ts",
    "dev-status-plugin.ts",
    "favicon-plugin.ts",
    "pptx-preview-plugin.ts",
    "tsconfig.node.json",
    "public",
  ])
    if (fs.existsSync(path.join(checkout, "apps/web", file))) copy(`apps/web/${file}`);
  fs.mkdirSync(home, { recursive: true });

  dev = startDev("dev#1");
  await waitReady(1);
  const session = await api("GET", "/api/local/session");
  const owner = session.body.ownerToken;
  assert.ok(owner, "local session gives the owner token");
  const created = await api(
    "POST",
    "/api/local/agents",
    { provider: "codex", name: "smoke-echo", access: "read-only" },
    owner,
  );
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const pid = await untilValue(() => agentPid(), 60_000, "agent online");
  await delay(5_000); // 等 Agent 进房间
  agentPids.add(pid);
  console.log(`agent smoke-echo running, pid ${pid}`);

  // 1. 任务进行中改 Server 代码：supervisor 换代
  let waitReply = await startTask("task-code-change");
  const generation = readStatus().generation;
  fs.appendFileSync(path.join(root, "apps/server/src/index.ts"), "\n// handover smoke edit\n");
  await waitReady(generation + 1);
  assert.equal(
    await untilValue(() => agentPid(), 15_000, "adopted agent"),
    pid,
    "new Server adopted the same Agent process",
  );
  const first = await waitReply(TASK_MS + 60_000);
  assert.match(first.content, /Echo from smoke-echo/);
  assert.equal(await agentPid(), pid);
  console.log("PASS server code change mid-task: Agent adopted by pid, reply delivered");

  // 2. 任务进行中停掉 pnpm dev（Ctrl+C 发给整个前台进程组），再重新 pnpm dev
  waitReply = await startTask("task-dev-restart");
  process.kill(-dev.child.pid, "SIGINT");
  await dev.exited;
  assert.ok(isAlive(pid), "Agent keeps running while pnpm dev is down");
  await delay(3_000);
  dev = startDev("dev#2");
  await waitReady(readStatus().generation + 1);
  assert.equal(
    await untilValue(() => agentPid(), 30_000, "adopted agent"),
    pid,
    "restarted pnpm dev adopted the same Agent process",
  );
  const second = await waitReply(TASK_MS + 60_000);
  assert.match(second.content, /Echo from smoke-echo/);
  console.log("PASS pnpm dev stop + restart mid-task: Agent adopted by pid, reply delivered");

  // 3. 停掉 pnpm dev 后不再启动：Agent 先留着等接管（宽限期 2 分钟后自己离线，这里不等）
  process.kill(-dev.child.pid, "SIGINT");
  await dev.exited;
  await delay(1_000);
  assert.ok(isAlive(pid), "Agent waits for a successor instead of being killed with pnpm dev");
  console.log("PASS all handover scenarios");
} catch (error) {
  console.error(logs.slice(-20_000));
  console.error("last agent view:", JSON.stringify(lastAgent));
  throw error;
} finally {
  for (const child of started) await child.stop().catch(() => undefined);
  // 交接留下的 echo Agent 只结束这次冒烟自己记下的 pid
  for (const target of agentPids) if (isAlive(target)) process.kill(target, "SIGTERM");
  await delay(500);
  fs.rmSync(root, { recursive: true, force: true });
}

function isAlive(target) {
  try {
    process.kill(target, 0);
    return true;
  } catch {
    return false;
  }
}
