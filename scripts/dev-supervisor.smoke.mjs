// Opt-in real-workspace smoke test. Never edits/restarts the active checkout or its Agents.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import console from "node:console";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { startProcess } from "./dev-supervisor.mjs";

const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hive-live-smoke-"));
let child;
let logs = "";

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
  fs.symlinkSync(
    path.join(root, "packages/protocol"),
    path.join(destination, "@superhive/protocol"),
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

async function waitStatus(state, generation) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.finished) throw new Error("isolated dev process exited unexpectedly");
    try {
      const status = JSON.parse(
        fs.readFileSync(path.join(root, ".superhive-dev/status.json"), "utf8"),
      );
      if (status.state === state && status.generation === generation) return status;
      if (status.state === "failed" && status.generation >= generation && state !== "failed")
        throw new Error(status.error);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await delay(100);
  }
  throw new Error(`timed out waiting for ${state} generation ${generation}`);
}

try {
  for (const file of [
    "package.json",
    "pnpm-workspace.yaml",
    "pnpm-lock.yaml",
    "tsconfig.base.json",
    "scripts/dev.mjs",
    "scripts/dev-process.mjs",
    "scripts/dev-reload.mjs",
    "scripts/dev-supervisor.mjs",
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
    "tsconfig.node.json",
    "public",
  ])
    copy(`apps/web/${file}`);
  // Only the install subcommand is simulated: this smoke copy shares dependency
  // symlinks with the checkout, so a real install here could mutate the live app.
  const realPnpm = execFileSync("which", ["pnpm"], { encoding: "utf8" }).trim();
  const bin = path.join(root, ".superhive-dev/test-bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, "pnpm"),
    `#!${process.execPath}
import fs from 'node:fs'; import cp from 'node:child_process';
const args=process.argv.slice(2);
if(args[0]==='install'){
  const counter='.superhive-dev/install-count';let count=0;try{count=Number(fs.readFileSync(counter,'utf8'))}catch{}
  fs.writeFileSync(counter,String(count+1));
  if(JSON.parse(fs.readFileSync('package.json','utf8')).hiveSmokeFailInstall){console.error('isolated mocked install failure');process.exit(1);}
  fs.appendFileSync('pnpm-lock.yaml','\\n# simulated install lock output '+(count+1)+'\\n');
}else{const result=cp.spawnSync(${JSON.stringify(realPnpm)},args,{stdio:'inherit'});process.exit(result.status??1);}
`,
    { mode: 0o755 },
  );
  const serverPort = await freePort();
  let webPort = await freePort();
  while (webPort === serverPort) webPort = await freePort();
  child = startProcess(process.execPath, [path.join(root, "scripts/dev.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      HIVE_HOST: "127.0.0.1",
      HIVE_PORT: String(serverPort),
      HIVE_DEV_WEB_PORT: String(webPort),
      HIVE_DATABASE: path.join(root, "test.sqlite"),
      HIVE_LOCAL_AGENTS: "0",
      VITE_HIVE_SERVER: `http://127.0.0.1:${serverPort}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
    stopGraceMs: 20_000,
  });
  for (const stream of [child.child.stdout, child.child.stderr])
    stream.on("data", (data) => {
      logs = (logs + data).slice(-50_000);
    });
  await waitStatus("ready", 1);
  const json = (url) => globalThis.fetch(url).then((response) => response.json());
  const healthUrl = `http://127.0.0.1:${serverPort}/health`;
  const statusUrl = `http://127.0.0.1:${webPort}/__hive-dev/status`;
  assert.equal((await json(statusUrl)).generation, 1);
  // Transform the actual app, not only its HTML shell.
  const appResponse = await globalThis.fetch(`http://127.0.0.1:${webPort}/src/App.tsx`);
  assert.equal(appResponse.status, 200);
  let identity = (await json(healthUrl)).instanceId;
  for (const [index, file] of [
    "apps/server/src/index.ts",
    "packages/protocol/src/index.ts",
    "packages/superhive/src/bridge.ts",
  ].entries()) {
    fs.appendFileSync(path.join(root, file), "\n// isolated live-update smoke\n");
    await waitStatus("ready", index + 2);
    const nextIdentity = (await json(healthUrl)).instanceId;
    assert.notEqual(nextIdentity, identity);
    identity = nextIdentity;
    assert.equal((await json(statusUrl)).generation, index + 2);
    console.log(`PASS automatic update: ${file}`);
  }
  const webFile = path.join(root, "apps/web/src/main.tsx");
  fs.appendFileSync(webFile, "\nconsole.debug('isolated-web-hmr-marker');\n");
  const webSource = await globalThis
    .fetch(`http://127.0.0.1:${webPort}/src/main.tsx`)
    .then((response) => response.text());
  assert.match(webSource, /isolated-web-hmr-marker/);
  await delay(1_800);
  assert.equal((await json(statusUrl)).generation, 4);
  console.log("PASS Vite serves latest frontend source without restarting Server");
  const brokenFile = path.join(root, "apps/server/src/index.ts");
  const original = fs.readFileSync(brokenFile, "utf8");
  fs.appendFileSync(brokenFile, "\nconst smokeBroken: string = 123;\n");
  await waitStatus("failed", 5);
  assert.equal((await json(healthUrl)).instanceId, identity);
  assert.equal((await json(statusUrl)).state, "failed");
  fs.writeFileSync(brokenFile, original);
  await waitStatus("ready", 6);
  assert.notEqual((await json(healthUrl)).instanceId, identity);
  console.log("PASS real typecheck failure keeps old Server; save fix recovers automatically");
  fs.appendFileSync(brokenFile, '\nthrow new Error("isolated runtime startup failure");\n');
  await waitStatus("failed", 7);
  assert.equal((await json(statusUrl)).state, "failed");
  fs.writeFileSync(brokenFile, original);
  await waitStatus("ready", 8);
  console.log("PASS runtime startup failure leaves Vite/supervisor alive; save fix recovers");
  let generation = 8;
  const installCount = () => {
    try {
      return Number(fs.readFileSync(path.join(root, ".superhive-dev/install-count"), "utf8"));
    } catch {
      return 0;
    }
  };
  const appendAndReload = async (file, marker) => {
    const previous = (await json(healthUrl)).instanceId;
    fs.appendFileSync(path.join(root, file), marker);
    await waitStatus("ready", ++generation);
    assert.notEqual((await json(healthUrl)).instanceId, previous);
    assert.equal(child.finished, false);
    assert.equal((await json(statusUrl)).generation, generation);
  };
  await appendAndReload(
    "scripts/dev-supervisor.mjs",
    "\nconsole.log('loaded-new-supervisor-smoke');\n",
  );
  assert.match(logs, /loaded-new-supervisor-smoke/);
  await appendAndReload("scripts/dev-process.mjs", "\n// changed imported runtime helper\n");
  assert.equal(installCount(), 0);
  console.log("PASS supervisor and imported helper reload through the same stable launcher");
  const changeManifest = (file, values) => {
    const target = path.join(root, file);
    fs.writeFileSync(
      target,
      JSON.stringify({ ...JSON.parse(fs.readFileSync(target, "utf8")), ...values }, null, 2),
    );
  };
  changeManifest("package.json", { description: "isolated root manifest update" });
  await waitStatus("ready", ++generation);
  changeManifest("apps/web/package.json", { description: "isolated child manifest update" });
  await waitStatus("ready", ++generation);
  await appendAndReload("pnpm-lock.yaml", "\n# isolated manual lock edit\n");
  await appendAndReload("pnpm-workspace.yaml", "\n# isolated workspace edit\n");
  await delay(3_000);
  assert.equal(installCount(), 4);
  assert.equal((await json(statusUrl)).generation, generation);
  console.log(
    "PASS four dependency/config inputs install once each; install-written lock never loops (mock installer)",
  );
  identity = (await json(healthUrl)).instanceId;
  changeManifest("package.json", { hiveSmokeFailInstall: true });
  await waitStatus("failed", generation);
  assert.equal((await json(healthUrl)).instanceId, identity);
  assert.equal((await json(statusUrl)).state, "failed");
  fs.appendFileSync(
    path.join(root, "apps/server/src/index.ts"),
    "\n// source edit after failed dependency install\n",
  );
  const recoveredSource = await waitStatus("failed", ++generation);
  assert.match(recoveredSource.error, /应用服务已更新/);
  assert.match(recoveredSource.error, /安装依赖/);
  assert.notEqual((await json(healthUrl)).instanceId, identity);
  console.log(
    "PASS source builds resume after install failure, without falsely clearing dependency failure",
  );
  changeManifest("package.json", { hiveSmokeFailInstall: false });
  await waitStatus("ready", ++generation);
  assert.equal(installCount(), 6);
  console.log(
    "PASS install failure retains old Server/Vite; manifest correction automatically retries (mock installer)",
  );
  const supervisorPath = path.join(root, "scripts/dev-supervisor.mjs");
  const validSupervisor = fs.readFileSync(supervisorPath, "utf8");
  identity = (await json(healthUrl)).instanceId;
  fs.appendFileSync(supervisorPath, "\nconst = invalid supervisor syntax;\n");
  await waitStatus("failed", generation);
  assert.equal((await json(healthUrl)).instanceId, identity);
  fs.writeFileSync(supervisorPath, validSupervisor);
  await waitStatus("ready", ++generation);
  identity = (await json(healthUrl)).instanceId;
  fs.appendFileSync(supervisorPath, "\nimport { missingSmokeExport } from './dev-process.mjs';\n");
  await waitStatus("failed", generation);
  assert.equal((await json(healthUrl)).instanceId, identity);
  fs.appendFileSync(
    path.join(root, "packages/superhive/src/bridge.ts"),
    "\n// source edit while supervisor import is broken\n",
  );
  const linkFailureSource = await waitStatus("failed", ++generation);
  assert.match(linkFailureSource.error, /应用服务已更新/);
  assert.match(linkFailureSource.error, /模块加载/);
  assert.notEqual((await json(healthUrl)).instanceId, identity);
  fs.writeFileSync(supervisorPath, validSupervisor);
  await waitStatus("ready", ++generation);
  console.log(
    "PASS real import preflight preserves old runtime on missing exports; source builds remain active",
  );
  fs.appendFileSync(
    supervisorPath,
    "\nif(process.argv[1])throw new Error('isolated supervisor boot failure');\n",
  );
  await waitStatus("failed", generation);
  assert.equal(child.finished, false);
  fs.writeFileSync(supervisorPath, validSupervisor);
  await waitStatus("ready", ++generation);
  console.log(
    "PASS malformed supervisor preserves old runtime; boot failure leaves launcher alive and save fix recovers",
  );
  await child.stop();
  for (const url of [healthUrl, statusUrl]) {
    await assert.rejects(globalThis.fetch(url, { signal: globalThis.AbortSignal.timeout(500) }));
  }
  console.log("PASS shutdown collects isolated Server and Vite; current checkout untouched");
} catch (error) {
  console.error("Smoke failed:", error.message);
  // Logs stay in the isolated local directory for debugging, never copied into the room.
  fs.writeFileSync(path.join(root, "smoke.log"), logs, { mode: 0o600 });
  console.error(`Local diagnostics: ${path.join(root, "smoke.log")}`);
  process.exitCode = 1;
} finally {
  await child?.stop();
  if (!process.exitCode) fs.rmSync(root, { recursive: true, force: true });
}
