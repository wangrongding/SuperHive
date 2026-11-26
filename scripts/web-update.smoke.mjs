import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { findChrome, initialStorage, launchChrome } from "./screenshot.mjs";

const execute = promisify(execFile);
const checkout = path.resolve(import.meta.dirname, "..");
const output = path.join(checkout, "output/web-npm-update");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hive-web-update-smoke-"));
const dataDir = path.join(root, "data");
const prefix = path.join(root, "prefix");
const packageRoot = path.join(prefix, "lib/node_modules/superhive");
const cli = path.join(packageRoot, "dist/cli.js");
const token = randomUUID();
const ownedPids = new Set();
const packages = new Map();
let latest = "0.4.9";
let chrome;
let socket;
let registry;
let environment;
let base;
let notes = [];
fs.mkdirSync(output, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

async function until(read, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value) return value;
    } catch {
      await delay(50);
    }
    await delay(250);
  }
  throw new Error(`Timed out: ${label}`);
}

function state() {
  const value = JSON.parse(fs.readFileSync(path.join(dataDir, "server.json"), "utf8"));
  assert.equal(value.dataDir, dataDir);
  ownedPids.add(value.pid);
  return value;
}

async function api(route, payload, method = payload ? "POST" : "GET") {
  const session = await fetch(`${base}/api/local/session`).then((response) => response.json());
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "x-hive-owner": session.ownerToken,
      "content-type": "application/json",
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  const body = await response.json();
  assert.ok(response.ok, `${route}: ${JSON.stringify(body)}`);
  return body;
}

function copyPackage(destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const relative of ["dist", "web", "package.json", "skills", "README.md", "LICENSE"])
    if (fs.existsSync(path.join(checkout, "packages/superhive", relative)))
      fs.cpSync(
        path.join(checkout, "packages/superhive", relative),
        path.join(destination, relative),
        { recursive: true },
      );
}

async function pack(version, broken = false) {
  const directory = path.join(root, `pack-${version}`);
  copyPackage(directory);
  const metadata = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
  metadata.version = version;
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify(metadata));
  if (broken)
    fs.writeFileSync(
      path.join(directory, "dist/server/index.js"),
      'throw new Error("Intentional isolated smoke startup failure");\n',
    );
  const result = await execute("npm", ["pack", "--ignore-scripts", "--json"], {
    cwd: directory,
    env: environment,
    maxBuffer: 1024 * 1024,
  });
  const filename = JSON.parse(result.stdout)[0].filename;
  const bytes = fs.readFileSync(path.join(directory, filename));
  packages.set(version, {
    metadata,
    bytes,
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  });
}

async function screenshot(name, width = 1500, theme = "light", locale = "zh-CN") {
  const { cdp } = chrome;
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height: width < 500 ? 844 : 940,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.evaluate(
    `localStorage.setItem('superhive.theme', ${JSON.stringify(theme)}); localStorage.setItem('superhive.locale', ${JSON.stringify(locale)}); location.reload();`,
  );
  await until(
    () => cdp.evaluate("Boolean(document.querySelector('.npm-update-entry'))"),
    30_000,
    "update entry",
  );
  await cdp.evaluate("document.querySelector('.npm-update-entry').click()");
  await until(
    () =>
      cdp.evaluate(
        "Boolean(document.querySelector('.npm-update-dialog')) && !document.querySelector('.npm-update-dialog').innerText.includes('正在检查更新') && !document.querySelector('.npm-update-dialog').innerText.includes('Checking for updates')",
      ),
    30_000,
    "update dialog",
  );
  await delay(300);
  const image = await cdp.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(output, name), Buffer.from(image.data, "base64"));
}

async function startViaBrowser(target) {
  await chrome.cdp.evaluate(
    `document.querySelector('.npm-update-dialog .app-dialog-close')?.click();`,
  );
  await chrome.cdp.evaluate("document.querySelector('.npm-update-entry').click()");
  await until(
    () =>
      chrome.cdp.evaluate(
        "[...document.querySelectorAll('.npm-update-dialog button')].some(button => /更新并重启|Update and restart/.test(button.textContent) && !button.disabled)",
      ),
    30_000,
    "enabled update action",
  );
  await chrome.cdp.evaluate(
    "[...document.querySelectorAll('.npm-update-dialog button')].find(button => /更新并重启|Update and restart/.test(button.textContent)).click()",
  );
  const job = await until(
    async () => {
      const current = JSON.parse(fs.readFileSync(path.join(dataDir, "web-update.json"), "utf8"));
      if (current.workerPid) ownedPids.add(current.workerPid);
      return current.target === target ? current : undefined;
    },
    30_000,
    "update worker",
  );
  if (target === "0.4.9") {
    await until(
      () =>
        chrome.cdp.evaluate(
          "/Installing the new version|正在安装新版本/.test(document.querySelector('.npm-update-dialog')?.innerText ?? '')",
        ),
      15_000,
      "visible installation progress",
    );
    await chrome.cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1500,
      height: 940,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const image = await chrome.cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(output, "04-updating.png"), Buffer.from(image.data, "base64"));
  }
  return until(
    async () => {
      try {
        state();
      } catch {
        await delay(50);
      }
      const current = JSON.parse(fs.readFileSync(path.join(dataDir, "web-update.json"), "utf8"));
      return current.id === job.id && ["completed", "failed"].includes(current.phase)
        ? current
        : undefined;
    },
    600_000,
    `update ${target}`,
  );
}

async function advertise(version) {
  latest = version;
  fs.rmSync(path.join(dataDir, "update-check.json"), { force: true });
  await api("/api/local/update");
  await chrome.cdp.evaluate("sessionStorage.clear(); location.reload()");
  await until(
    () =>
      chrome.cdp.evaluate(
        `document.querySelector('.npm-update-entry')?.textContent.includes(${JSON.stringify(version)})`,
      ),
    30_000,
    `advertise ${version}`,
  );
}

try {
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  environment = {
    ...process.env,
    HOME: home,
    SUPERHIVE_HOME: home,
    HIVE_NO_OPEN: "1",
    HIVE_IM_WECHAT: "0",
    HIVE_WORKTREE_DEPS: "0",
    HIVE_ECHO_DELAY_MS: "120000",
    HIVE_LOCAL_AGENT_CLI: JSON.stringify([
      process.execPath,
      path.join(packageRoot, "dist/echo.js"),
    ]),
  };
  for (const name of [
    "HIVE_TOKEN",
    "HIVE_DATABASE",
    "HIVE_STATIC_DIR",
    "HIVE_INSTANCE_ID",
    "HIVE_SHUTDOWN_TOKEN",
    "HIVE_SANDBOX",
    "HIVE_HANDOVER_FILE",
    "HIVE_LOCAL_AGENTS",
    "HIVE_HOST",
    "HIVE_PORT",
    "HIVE_PUBLIC_URL",
    "HIVE_WEB_URL",
    "HIVE_DEV_WEB_PORT",
  ])
    delete environment[name];
  copyPackage(packageRoot);
  fs.symlinkSync(
    path.join(checkout, "packages/superhive/node_modules"),
    path.join(packageRoot, "node_modules"),
    "dir",
  );
  registry = http.createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/-/package/superhive/dist-tags") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ latest }));
      return;
    }
    if (url.pathname === "/superhive") {
      const versions = Object.fromEntries(
        [...packages].map(([version, value]) => [
          version,
          {
            ...value.metadata,
            dist: {
              tarball: `${environment.npm_config_registry}tarball/${version}`,
              integrity: value.integrity,
            },
          },
        ]),
      );
      versions["0.4.10"] = {
        ...packages.get("0.4.9").metadata,
        version: "0.4.10",
        dist: { tarball: `${environment.npm_config_registry}missing` },
      };
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ name: "superhive", "dist-tags": { latest }, versions }));
      return;
    }
    if (url.pathname.startsWith("/tarball/")) {
      const value = packages.get(url.pathname.split("/").at(-1));
      response.end(value.bytes);
      return;
    }
    if (url.pathname === "/missing") {
      response.writeHead(404);
      response.end("Intentional isolated install failure");
      return;
    }
    response.writeHead(302, { location: `https://registry.npmjs.org${request.url}` });
    response.end();
  });
  await new Promise((resolve) => registry.listen(0, "127.0.0.1", resolve));
  environment.npm_config_registry = `http://127.0.0.1:${registry.address().port}/`;
  environment.npm_config_cache = path.join(output, "npm-cache");
  await pack("0.4.9");
  await pack("0.4.11", true);
  await execute(
    "npm",
    [
      "install",
      "-g",
      "--prefix",
      path.join(root, "warm-prefix"),
      "superhive@0.4.9",
      "--no-audit",
      "--no-fund",
    ],
    { env: environment, timeout: 600_000, maxBuffer: 1024 * 1024 },
  );
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  await execute(
    process.execPath,
    [
      cli,
      "start",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--data-dir",
      dataDir,
      "--token",
      token,
      "--no-open",
    ],
    { env: environment, timeout: 60_000 },
  );
  const previousPid = state().pid;
  await api("/api/local/agents/auto-update", { enabled: false }, "PUT");
  const created = await api("/api/local/agents", {
    provider: "codex",
    name: "update-echo",
    access: "read-only",
  });
  const agentPid = await until(
    async () => {
      const agent = (await api("/api/local/agents")).agents.find(
        (item) => item.id === created.agent.id,
      );
      return agent?.status === "running" ? agent.pid : undefined;
    },
    60_000,
    "echo Agent",
  );
  ownedPids.add(agentPid);
  await delay(3_000);
  const invocations = new Map();
  const messages = [];
  socket = new WebSocket(`${base.replace("http", "ws")}/ws`);
  socket.addEventListener("message", (event) => {
    const value = JSON.parse(String(event.data));
    if (value.type === "invocation.updated") invocations.set(value.invocation.id, value.invocation);
    if (value.type === "message.created") messages.push(value.message);
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.send(
    JSON.stringify({
      type: "participant.join",
      username: "smoke-owner",
      participantType: "human",
      roomId: "general",
      token,
    }),
  );
  chrome = await launchChrome(findChrome());
  await chrome.cdp.send("Browser.setPermission", {
    permission: { name: "notifications" },
    setting: "denied",
  });
  await chrome.cdp.send("Page.enable");
  await chrome.cdp.send("Runtime.enable");
  const storage = initialStorage({
    user: "smoke-owner",
    theme: "light",
    locale: "zh-CN",
    room: "general",
  });
  await chrome.cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `if(location.origin === ${JSON.stringify(base)}) { for (const [key,value] of Object.entries(${JSON.stringify(storage)})) { if(!localStorage.getItem(key)) localStorage.setItem(key,value); } }`,
  });
  await chrome.cdp.send("Page.navigate", { url: base });
  await screenshot("01-update-light.png");
  await screenshot("02-update-dark.png", 1500, "dark");
  await screenshot("03-update-en-mobile.png", 390, "light", "en");
  socket.send(
    JSON.stringify({
      type: "message.send",
      clientMessageId: randomUUID(),
      content: "@update-echo verify-update-handover",
    }),
  );
  const running = await until(
    () =>
      [...invocations.values()].find(
        (item) => item.agentName === "update-echo" && item.status === "running",
      ),
    30_000,
    "busy task",
  );
  assert.equal((await api("/api/local/update")).info.canHandover, true);
  const completed = await startViaBrowser("0.4.9");
  assert.equal(completed.phase, "completed", JSON.stringify(completed));
  assert.equal(
    (await api("/api/rooms/general/invocations")).invocations.find((item) => item.id === running.id)
      ?.status,
    "running",
    "the task is still running on the new Server",
  );
  assert.notEqual(state().pid, previousPid);
  assert.equal(
    (await api("/api/local/agents")).agents.find((item) => item.id === created.agent.id).pid,
    agentPid,
  );
  await until(
    async () =>
      (await fetch(`${base}/health`).then((response) => response.json())).version === "0.4.9",
    30_000,
    "new Server version",
  );
  await until(
    () =>
      chrome.cdp.evaluate(
        "document.querySelector('.status-connection')?.textContent.includes('0.4.9')",
      ),
    30_000,
    "browser auto-reconnected with new version",
  );
  const updatedImage = await chrome.cdp.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(output, "05-updated.png"), Buffer.from(updatedImage.data, "base64"));
  const task = await until(
    async () =>
      (await api("/api/rooms/general/invocations")).invocations?.find(
        (item) => item.id === running.id && item.status === "completed",
      ),
    180_000,
    "task continued after handover",
  );
  assert.ok(task.failure == null);
  notes.push(
    "Browser click installed a real locally packed 0.4.9 tarball, replaced the Server PID, reconnected automatically, and preserved the busy echo Agent PID and task completion.",
  );
  await advertise("0.4.10");
  const unchangedPid = state().pid;
  const installFailed = await startViaBrowser("0.4.10");
  assert.equal(installFailed.phase, "failed");
  assert.equal(state().pid, unchangedPid);
  assert.equal(
    (await fetch(`${base}/health`).then((response) => response.json())).version,
    "0.4.9",
  );
  await screenshot("06-install-failed.png");
  notes.push(
    "A registry tarball 404 failed installation without replacing the running Server PID or version.",
  );
  await advertise("0.4.11");
  const restartFailed = await startViaBrowser("0.4.11");
  assert.equal(restartFailed.phase, "failed");
  assert.equal(restartFailed.rolledBack, true, JSON.stringify(restartFailed));
  assert.equal(
    (await fetch(`${base}/health`).then((response) => response.json())).version,
    "0.4.9",
  );
  assert.equal(
    (await api("/api/local/agents")).agents.find((item) => item.id === created.agent.id).pid,
    agentPid,
  );
  await until(
    async () =>
      (await api("/api/rooms/general/participants")).participants.some(
        (item) => item.username === "update-echo" && item.status === "online",
      ),
    60_000,
    "echo Agent reconnected after rollback",
  );
  assert.equal(
    (await api("/api/local/agents")).agents.find((item) => item.id === created.agent.id).pid,
    agentPid,
    "rollback reconnects the original Agent rather than replacing its process",
  );
  await screenshot("07-rollback.png");
  notes.push(
    "A real 0.4.11 tarball with a failing Server restored package 0.4.9 and restarted it; the same echo Agent process survived rollback and reconnected.",
  );
  const foregroundPort = await freePort();
  const foregroundBase = `http://127.0.0.1:${foregroundPort}`;
  const foregroundFd = fs.openSync(path.join(root, "foreground.log"), "a");
  const foreground = spawn(
    process.execPath,
    [
      cli,
      "start",
      "--foreground",
      "--host",
      "127.0.0.1",
      "--port",
      String(foregroundPort),
      "--data-dir",
      path.join(root, "foreground-data"),
      "--no-local-agents",
      "--no-open",
    ],
    { env: environment, stdio: ["ignore", foregroundFd, foregroundFd] },
  );
  fs.closeSync(foregroundFd);
  ownedPids.add(foreground.pid);
  try {
    await until(
      async () => (await fetch(`${foregroundBase}/health`)).ok,
      30_000,
      "foreground Server",
    );
    const session = await fetch(`${foregroundBase}/api/local/update/session`).then((response) =>
      response.json(),
    );
    const response = await fetch(`${foregroundBase}/api/local/update`, {
      headers: { "x-hive-owner": session.ownerToken },
    });
    const info = (await response.json()).info;
    assert.equal(info.canUpdate, false);
    assert.equal(info.blocker, "external");
    const rejected = await fetch(`${foregroundBase}/api/local/update`, {
      method: "POST",
      headers: { "x-hive-owner": session.ownerToken, "content-type": "application/json" },
      body: JSON.stringify({ target: "0.4.11" }),
    });
    assert.equal(rejected.status, 409);
    notes.push(
      "A real foreground Server with local Agents disabled exposes update information but rejects in-browser installation as externally managed.",
    );
  } finally {
    foreground.kill();
  }
  assert.doesNotMatch(
    fs.readFileSync(path.join(dataDir, "server.log"), "utf8"),
    /(?:0\.0\.0\.0|127\.0\.0\.1|localhost):8787\b/,
  );
  notes.push("The final run's Server log contains no fallback to the real/default port 8787.");
  console.log(notes.join("\n"));
} catch (error) {
  notes.push(`FAILED: ${error.message}`);
  for (const filename of ["web-update.log", "server.log"])
    if (fs.existsSync(path.join(dataDir, filename)))
      fs.copyFileSync(path.join(dataDir, filename), path.join(output, filename));
  throw error;
} finally {
  socket?.close();
  await chrome?.close();
  if (environment && fs.existsSync(cli)) {
    try {
      await execute(process.execPath, [cli, "stop", "--data-dir", dataDir], {
        env: environment,
        timeout: 30_000,
      });
    } catch {
      notes.push("Cleanup used recorded test PIDs.");
    }
  }
  for (const pid of ownedPids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      continue;
    }
  }
  await new Promise((resolve) => (registry ? registry.close(resolve) : resolve()));
  fs.writeFileSync(
    path.join(output, "smoke.md"),
    `# Isolated npm web-update smoke\n\n${notes.map((note) => `- ${note}`).join("\n")}\n\nOnly temporary prefixes, data, HOME, registry, ports, and test PIDs were used. No port 8787 or real Agent was touched.\n`,
  );
  fs.rmSync(root, { recursive: true, force: true });
}
