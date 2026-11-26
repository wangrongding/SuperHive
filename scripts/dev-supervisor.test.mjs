import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { adoptProcess } from "./dev-process.mjs";
import {
  DevError,
  DevSupervisor,
  SOURCE_ROOTS,
  findOrphanServer,
  isWatchedFile,
  publicError,
  readGeneration,
  serverRestartDelay,
  startProcess,
  waitForHealth,
  watchWorkspace,
  writeStatus,
} from "./dev-supervisor.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function until(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail("condition did not become true");
    await delay(5);
  }
}

function fakeServer(ready = async () => {}) {
  const exit = deferred();
  return {
    stopped: false,
    exited: exit.promise,
    crash: exit.resolve,
    ready,
    async stop() {
      this.stopped = true;
      exit.resolve({ code: 0 });
    },
  };
}

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hive-dev-test-"));
  const statuses = [];
  const servers = [];
  const supervisor = new DevSupervisor({
    statusPath: path.join(root, ".superhive-dev/status.json"),
    debounceMs: 20,
    build: async () => ({}),
    startServer: async () => {
      const server = fakeServer();
      servers.push(server);
      return server;
    },
    ...overrides,
  });
  supervisor.on("status", (status) => statuses.push(status));
  t.after(async () => {
    await supervisor.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const ready = (generation) =>
    until(() => statuses.some((s) => s.state === "ready" && s.generation === generation));
  return { root, supervisor, statuses, servers, ready };
}

test("source allowlist excludes Vite-only changes and generated/runtime data", () => {
  for (const file of [
    "apps/server/src/app.ts",
    "packages/protocol/src/index.ts",
    "packages/superhive/src/bridge.ts",
    "tsconfig.base.json",
    "apps/server/tsconfig.json",
    "packages\\superhive\\src\\bridge.ts",
  ])
    assert.equal(isWatchedFile(file), true, file);
  for (const file of [
    "apps/web/src/App.tsx",
    ".superhive-dev/status.json",
    "apps/server/data/hive.sqlite",
    "packages/protocol/dist/index.js",
    "packages/protocol/.superhive-dev/build/index.d.ts",
    "packages/superhive/src/node_modules/x.js",
    "apps/server/src/logs/x.json",
    "README.md",
    "packages/superhive/package.json",
  ])
    assert.equal(isWatchedFile(file), false, file);
});

test("atomic status contract persists generations across supervisor restarts", async (t) => {
  const f = fixture(t);
  const statusPath = f.supervisor.statusPath;
  assert.equal(readGeneration(statusPath), 0);
  writeStatus(statusPath, { generation: 7, state: "ready", updatedAt: "now" });
  assert.equal(readGeneration(statusPath), 7);
  assert.deepEqual(fs.readdirSync(path.dirname(statusPath)), ["status.json"]);
  const resumed = new DevSupervisor({
    statusPath,
    build: async () => ({}),
    startServer: async () => fakeServer(),
    debounceMs: 1,
  });
  t.after(() => resumed.close());
  resumed.changed(["initial-start"], { immediate: true });
  await until(() => JSON.parse(fs.readFileSync(statusPath, "utf8")).state === "ready");
  assert.equal(readGeneration(statusPath), 8);
});

test("coalesces a save burst into one build and one ready generation", async (t) => {
  let builds = 0;
  const f = fixture(t, {
    build: async () => {
      builds += 1;
      return {};
    },
  });
  f.supervisor.changed(["a.ts"]);
  f.supervisor.changed(["b.ts", "a.ts"]);
  f.supervisor.changed(["c.ts"]);
  await f.ready(1);
  assert.equal(builds, 1);
  assert.equal(f.servers.length, 1);
  assert.deepEqual(f.statuses.at(-1).changedFiles, ["a.ts", "b.ts", "c.ts"]);
});

test("edits during a build are serialized and obsolete builds are never published", async (t) => {
  const gate = deferred();
  let builds = 0;
  let publishes = 0;
  let disposals = 0;
  const f = fixture(t, {
    build: async () => {
      builds += 1;
      if (builds === 1) await gate.promise;
      return {
        publish() {
          publishes += 1;
        },
        dispose() {
          disposals += 1;
        },
      };
    },
  });
  f.supervisor.changed(["a.ts"], { immediate: true });
  await until(() => builds === 1);
  f.supervisor.changed(["b.ts"]);
  await delay(35); // Debounce expires while the build still owns the queue.
  assert.equal(builds, 1);
  gate.resolve();
  await f.ready(2);
  assert.equal(builds, 2);
  assert.equal(publishes, 1);
  assert.equal(disposals, 2);
  assert.equal(
    f.statuses.some((s) => s.generation === 1 && s.state === "ready"),
    false,
  );
});

test("ready is gated on health, including edits received during startup", async (t) => {
  const gate = deferred();
  let launches = 0;
  const f = fixture(t, {
    startServer: async () => {
      launches += 1;
      return fakeServer(launches === 1 ? () => gate.promise : async () => {});
    },
  });
  f.supervisor.changed(["a.ts"], { immediate: true });
  await until(() => launches === 1);
  assert.equal(
    f.statuses.some((s) => s.state === "ready"),
    false,
  );
  f.supervisor.changed(["b.ts"]);
  gate.resolve();
  await f.ready(2);
  assert.equal(
    f.statuses.some((s) => s.generation === 1 && s.state === "ready"),
    false,
  );
});

test("failed checks leave the previous process alive; fixes recover without manual retry", async (t) => {
  let bad = false;
  const f = fixture(t, {
    build: async () => {
      if (bad) throw new DevError("检查 server 失败；请看本机终端。");
      return {};
    },
  });
  f.supervisor.changed(["start"], { immediate: true });
  await f.ready(1);
  bad = true;
  f.supervisor.changed(["broken.ts"], { immediate: true });
  await until(() => f.statuses.at(-1).state === "failed");
  assert.equal(f.servers[0].stopped, false);
  assert.equal(f.servers.length, 1);
  bad = false;
  f.supervisor.changed(["fixed.ts"], { immediate: true });
  await f.ready(3);
  assert.equal(f.servers[0].stopped, true);
  assert.equal(f.servers.length, 2);
});

test("startup health failures stop the broken replacement and retry automatically", async (t) => {
  const failed = fakeServer(async () => {
    throw new DevError("健康检查失败");
  });
  let launches = 0;
  const context = fixture(t, {
    restartDelay: () => 5,
    startServer: async () => (++launches === 1 ? failed : fakeServer()),
  });
  context.supervisor.changed(["broken.ts"], { immediate: true });
  await until(() => failed.stopped);
  await context.ready(1);
  assert.equal(launches, 2);
  context.supervisor.changed(["fixed.ts"], { immediate: true });
  await context.ready(2);
});

test("unexpected exits reuse the published build without a source edit or new generation", async (t) => {
  let builds = 0;
  const context = fixture(t, {
    restartDelay: () => 5,
    build: async () => {
      builds += 1;
      return {};
    },
  });
  context.supervisor.changed(["start"], { immediate: true });
  await context.ready(1);
  context.servers[0].crash({ code: 1 });
  await until(() => context.servers.length === 2 && context.statuses.at(-1).state === "ready");
  assert.equal(builds, 1);
  assert.equal(context.supervisor.generation, 1);
  assert.equal(
    context.statuses.some((status) => status.restartAttempt === 1),
    true,
  );
  context.supervisor.changed(["fix"], { immediate: true });
  await context.ready(2);
});

test("restart backoff grows from one second to a thirty-second cap", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 100].map(serverRestartDelay),
    [1_000, 2_000, 5_000, 10_000, 30_000, 30_000, 30_000],
  );
});

test("five crashes in a minute stop retries with an actionable failure; edits recover", async (t) => {
  const context = fixture(t, { restartDelay: () => 5 });
  context.supervisor.changed(["start"], { immediate: true });
  await context.ready(1);
  for (let index = 0; index < 5; index += 1) {
    context.servers[index].crash({ signal: "SIGTERM" });
    if (index < 4)
      await until(
        () => context.servers.length === index + 2 && context.statuses.at(-1).state === "ready",
      );
  }
  await until(() => context.statuses.at(-1).restartStopped);
  assert.match(context.statuses.at(-1).error, /60 秒内连续失败 5 次.*信号 SIGTERM/);
  await delay(30);
  assert.equal(context.servers.length, 5);
  context.supervisor.changed(["fixed.ts"], { immediate: true });
  await context.ready(2);
  assert.equal(context.servers.length, 6);
});

test("launch exceptions also obey the crash limit instead of becoming an unhandled rejection", async (t) => {
  let launches = 0;
  const context = fixture(t, {
    restartDelay: () => 5,
    startServer: async () => {
      launches += 1;
      throw new DevError("无法拉起 Server");
    },
  });
  context.supervisor.changed(["start"], { immediate: true });
  await until(() => context.statuses.at(-1).restartStopped);
  assert.equal(launches, 5);
  assert.match(context.statuses.at(-1).error, /无法拉起 Server/);
});

test("an exit before health is counted only once and never publishes ready", async (t) => {
  const gate = deferred();
  const failed = fakeServer(() => gate.promise);
  const context = fixture(t, {
    restartDelay: () => 5,
    startServer: async () => failed,
  });
  context.supervisor.changed(["start"], { immediate: true });
  await until(() => context.supervisor.server === failed);
  failed.crash({ code: 1 });
  await until(() => context.supervisor.server === undefined);
  gate.reject(new DevError("已退出"));
  await until(() => context.statuses.at(-1).restartStopped);
  assert.equal(context.supervisor.crashes.length, 5);
  assert.equal(
    context.statuses.some((status) => status.state === "ready"),
    false,
  );
});

test("a stable interval resets the crash window and retry delay", async (t) => {
  const context = fixture(t, { restartDelay: () => 1, crashWindowMs: 30 });
  context.supervisor.changed(["start"], { immediate: true });
  await context.ready(1);
  context.servers[0].crash({ code: 1 });
  await until(() => context.servers.length === 2 && context.statuses.at(-1).state === "ready");
  await delay(40);
  context.servers[1].crash({ code: 1 });
  await until(() => context.servers.length === 3 && context.statuses.at(-1).state === "ready");
  assert.equal(context.supervisor.crashes.length, 1);
  assert.equal(context.supervisor.restartAttempt, 1);
});

test("edits cancel a scheduled restart and rebuild first, with no extra launch", async (t) => {
  const context = fixture(t, { restartDelay: () => 50 });
  context.supervisor.changed(["start"], { immediate: true });
  await context.ready(1);
  context.servers[0].crash({ code: 1 });
  await until(() => context.statuses.at(-1).restartAttempt === 1);
  context.supervisor.changed(["fixed.ts"], { immediate: true });
  await context.ready(2);
  await delay(65);
  assert.equal(context.servers.length, 2);
});

test("recovery retains a failed source build instead of claiming the bad generation is ready", async (t) => {
  let bad = false;
  const context = fixture(t, {
    restartDelay: () => 5,
    build: async () => {
      if (bad) throw new DevError("最新代码检查失败");
      return {};
    },
  });
  context.supervisor.changed(["start"], { immediate: true });
  await context.ready(1);
  bad = true;
  context.supervisor.changed(["broken.ts"], { immediate: true });
  await until(() => context.statuses.at(-1).state === "failed");
  context.servers[0].crash({ code: 1 });
  await until(() => context.servers.length === 2 && context.statuses.at(-1).state === "failed");
  assert.equal(context.supervisor.runtimeGeneration, 1);
  assert.equal(context.statuses.at(-1).generation, 2);
  assert.equal(context.statuses.at(-1).error, "最新代码检查失败");
});

test("edits during automatic recovery wait for health before rebuilding", async (t) => {
  const gate = deferred();
  let launches = 0;
  let builds = 0;
  const context = fixture(t, {
    restartDelay: () => 5,
    build: async () => {
      builds += 1;
      return {};
    },
    startServer: async () => {
      launches += 1;
      return fakeServer(launches === 2 ? () => gate.promise : async () => {});
    },
  });
  context.supervisor.changed(["start"], { immediate: true });
  await context.ready(1);
  context.supervisor.server.crash({ code: 1 });
  await until(() => launches === 2);
  context.supervisor.changed(["edited.ts"], { immediate: true });
  await delay(30);
  assert.equal(builds, 1);
  gate.resolve();
  await context.ready(2);
  assert.equal(builds, 2);
  assert.equal(launches, 3);
});

test("pause and shutdown cancel retries; only resume can restart a paused server", async (t) => {
  const context = fixture(t, { restartDelay: () => 20 });
  context.supervisor.changed(["start"], { immediate: true });
  await context.ready(1);
  context.servers[0].crash({ code: 1 });
  await until(() => context.statuses.at(-1).restartAttempt === 1);
  await context.supervisor.pause();
  await delay(30);
  assert.equal(context.servers.length, 1);
  context.supervisor.resume();
  await until(() => context.servers.length === 2);
  await context.supervisor.active;
  context.servers[1].crash({ code: 1 });
  await until(() => context.statuses.at(-1).restartAttempt === 2);
  await context.supervisor.close();
  await delay(30);
  assert.equal(context.servers.length, 2);
});

test("shutdown cancels checks and never restarts a server afterwards", async (t) => {
  let cancelled = false;
  const f = fixture(t, {
    build: ({ signal }) =>
      new Promise((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            cancelled = true;
            resolve({});
          },
          { once: true },
        );
      }),
  });
  f.supervisor.changed(["start"], { immediate: true });
  await until(() => f.statuses.at(-1).state === "building");
  await f.supervisor.close();
  assert.equal(cancelled, true);
  assert.equal(f.servers.length, 0);
  f.supervisor.changed(["ignored"]);
  await delay(30);
  assert.equal(f.supervisor.generation, 1);
});

test("public error summaries never include raw exception contents", () => {
  assert.doesNotMatch(publicError(new Error("private mock credential")), /private mock credential/);
  assert.equal(publicError(new DevError("编译失败")), "编译失败");
});

test("the dev loader uses cached JavaScript while keeping original source URLs and dependencies", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hive-dev-loader-"));
  const sourceDir = path.join(root, "src");
  const outputDir = path.join(root, "compiled");
  fs.mkdirSync(sourceDir);
  fs.mkdirSync(outputDir);
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  fs.writeFileSync(path.join(sourceDir, "index.ts"), 'throw new Error("unvalidated source");');
  fs.writeFileSync(path.join(sourceDir, "helper.ts"), 'throw new Error("unvalidated helper");');
  fs.writeFileSync(path.join(outputDir, "helper.js"), 'export const value = "cached";');
  fs.writeFileSync(
    path.join(outputDir, "index.js"),
    'import {value} from "./helper.js"; import path from "node:path"; console.log(JSON.stringify({value,dirname:import.meta.dirname,base:path.basename(import.meta.dirname)}));',
  );
  const server = startProcess(
    process.execPath,
    [
      "--import",
      new URL("./dev-server-runtime.mjs", import.meta.url).href,
      path.join(sourceDir, "index.ts"),
    ],
    {
      cwd: root,
      env: { ...process.env, HIVE_DEV_SERVER_SOURCE: sourceDir, HIVE_DEV_SERVER_OUTPUT: outputDir },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  t.after(async () => {
    await server.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  let stdout = "";
  let stderr = "";
  server.child.stdout.on("data", (data) => (stdout += data));
  server.child.stderr.on("data", (data) => (stderr += data));
  assert.equal((await server.exited).code, 0, stderr);
  const result = JSON.parse(stdout);
  assert.equal(result.value, "cached");
  assert.equal(fs.realpathSync(result.dirname), fs.realpathSync(sourceDir));
  assert.equal(result.base, "src");
});

test("workspace watchers see atomic saves and ignore output/status churn", async (t) => {
  const f = fixture(t);
  for (const dir of SOURCE_ROOTS) fs.mkdirSync(path.join(f.root, dir), { recursive: true });
  const events = [];
  const stop = watchWorkspace(
    f.root,
    (files) => events.push(...files),
    (error) => {
      throw error;
    },
  );
  t.after(stop);
  fs.writeFileSync(path.join(f.root, "apps/server/src/new.tmp"), "export {};");
  fs.renameSync(
    path.join(f.root, "apps/server/src/new.tmp"),
    path.join(f.root, "apps/server/src/new.ts"),
  );
  await until(() => events.includes("apps/server/src/new.ts"));
  events.length = 0;
  // Save/rename notifications can be duplicated or contain unchanged content.
  fs.writeFileSync(path.join(f.root, "apps/server/src/new.ts"), "export {};");
  await delay(80);
  assert.deepEqual(events, []);
  fs.mkdirSync(path.join(f.root, "packages/protocol/dist"));
  fs.writeFileSync(path.join(f.root, "packages/protocol/dist/index.js"), "export {};");
  writeStatus(f.supervisor.statusPath, { generation: 0, state: "pending", updatedAt: "now" });
  await delay(80);
  assert.deepEqual(events, []);
});

test("health checks require the new instance rather than any listener on the port", async (t) => {
  let identity = "old";
  const listener = http.createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ status: "ok", instanceId: identity }));
  });
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => listener.close(resolve)));
  const url = `http://127.0.0.1:${listener.address().port}/health`;
  const options = { signal: new globalThis.AbortController().signal, timeoutMs: 200 };
  await assert.rejects(waitForHealth(url, "new", { finished: false }, options), /健康检查/);
  identity = "new";
  await waitForHealth(url, "new", { finished: false }, options);
});

test("managed child startup errors settle and stopping is idempotent", async () => {
  const missing = startProcess("/definitely/no/hive-test-executable", []);
  await missing.exited;
  assert.ok(missing.spawnError);
  await Promise.all([missing.stop(), missing.stop()]);
});

test(
  "managed processes that ignore TERM are killed after a bounded grace period",
  { skip: process.platform === "win32" },
  async () => {
    const child = startProcess(
      process.execPath,
      ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); console.log('started');"],
      {
        stdio: ["ignore", "pipe", "ignore"],
        stopGraceMs: 30,
      },
    );
    await new Promise((resolve) => child.child.stdout.once("data", resolve));
    await child.stop();
    const result = await child.exited;
    assert.equal(result.signal, "SIGKILL");
  },
);

test(
  "real file-watch -> process restart -> generation health, with failure and recovery",
  { timeout: 15_000 },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hive-dev-e2e-"));
    for (const dir of SOURCE_ROOTS) fs.mkdirSync(path.join(root, dir), { recursive: true });
    const files = {
      server: "apps/server/src/app.json",
      bridge: "packages/superhive/src/bridge.json",
      protocol: "packages/protocol/src/index.json",
    };
    for (const file of Object.values(files)) fs.writeFileSync(path.join(root, file), "0");
    const probe = http.createServer();
    await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    let launches = 0;
    const statuses = [];
    const supervisor = new DevSupervisor({
      statusPath: path.join(root, ".superhive-dev/status.json"),
      debounceMs: 25,
      build: async () => {
        try {
          const values = Object.fromEntries(
            Object.entries(files).map(([key, file]) => [
              key,
              JSON.parse(fs.readFileSync(path.join(root, file), "utf8")),
            ]),
          );
          return {
            publish() {
              fs.writeFileSync(path.join(root, "runtime.json"), JSON.stringify(values));
            },
          };
        } catch {
          throw new DevError("fixture 编译失败");
        }
      },
      startServer: async ({ generation }) => {
        launches += 1;
        const instanceId = `generation-${generation}`;
        const code = `const http=require('node:http'),fs=require('node:fs'); const values=JSON.parse(fs.readFileSync('runtime.json','utf8')); http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({status:'ok',instanceId:${JSON.stringify(instanceId)},...values}));}).listen(${port},'127.0.0.1');`;
        const server = startProcess(process.execPath, ["-e", code], { cwd: root, stdio: "ignore" });
        server.ready = (options) =>
          waitForHealth(`http://127.0.0.1:${port}/health`, instanceId, server, options);
        return server;
      },
    });
    supervisor.on("status", (status) => statuses.push(status));
    const stopWatching = watchWorkspace(
      root,
      (changed) => supervisor.changed(changed),
      (error) => {
        throw error;
      },
    );
    t.after(async () => {
      stopWatching();
      await supervisor.close();
      fs.rmSync(root, { recursive: true, force: true });
    });
    const ready = (generation) =>
      until(() => statuses.some((s) => s.generation === generation && s.state === "ready"), 5_000);
    const state = () =>
      globalThis.fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json());
    supervisor.changed(["initial"], { immediate: true });
    await ready(1);
    let generation = 1;
    for (const [key, file] of Object.entries(files)) {
      fs.writeFileSync(path.join(root, file), "1");
      await ready(++generation);
      assert.equal((await state())[key], 1);
    }
    fs.writeFileSync(path.join(root, files.protocol), "invalid-json");
    await until(() => statuses.at(-1).state === "failed");
    assert.equal(launches, 4);
    assert.equal((await state()).instanceId, "generation-4");
    fs.writeFileSync(path.join(root, files.protocol), "2");
    await ready(6);
    assert.equal((await state()).protocol, 2);
    assert.equal(launches, 5);
  },
);

test("a code update leaves a handover marker so local Agents survive; a real stop removes it", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hive-dev-handover-"));
  const handoverPath = path.join(root, ".superhive-dev/agent-handover");
  const seenAtStop = [];
  const supervisor = new DevSupervisor({
    statusPath: path.join(root, ".superhive-dev/status.json"),
    handoverPath,
    debounceMs: 20,
    build: async () => ({}),
    startServer: async () => {
      const server = fakeServer();
      const stop = server.stop.bind(server);
      server.stop = async () => {
        seenAtStop.push(fs.existsSync(handoverPath));
        await stop();
      };
      return server;
    },
  });
  const statuses = [];
  supervisor.on("status", (status) => statuses.push(status));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  supervisor.changed(["initial-start"], { immediate: true });
  await until(() => statuses.some((s) => s.state === "ready"));
  supervisor.changed(["apps/server/src/app.ts"]);
  await until(() => statuses.filter((s) => s.state === "ready").length === 2);
  // 换代：停旧 Server 时标记已写好
  assert.deepEqual(seenAtStop, [true]);
  await supervisor.close();
  // 真正停止：标记已删除，本机 Agent 随 Server 一起结束
  assert.deepEqual(seenAtStop, [true, false]);
  assert.equal(fs.existsSync(handoverPath), false);
});

test("stopping pnpm dev hands local Agents over by default; only an explicit full stop takes them down", async (t) => {
  for (const [options, expected] of [
    [{ handover: true }, true],
    [{}, false],
  ]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hive-dev-stop-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const handoverPath = path.join(root, ".superhive-dev/agent-handover");
    const seenAtStop = [];
    const supervisor = new DevSupervisor({
      statusPath: path.join(root, ".superhive-dev/status.json"),
      handoverPath,
      debounceMs: 20,
      build: async () => ({}),
      startServer: async () => {
        const server = fakeServer();
        const stop = server.stop.bind(server);
        server.stop = async () => {
          seenAtStop.push(fs.existsSync(handoverPath));
          fs.rmSync(handoverPath, { force: true }); // 真 Server 退出时用掉标记
          await stop();
        };
        return server;
      },
    });
    const statuses = [];
    supervisor.on("status", (status) => statuses.push(status));
    supervisor.changed(["initial-start"], { immediate: true });
    await until(() => statuses.some((s) => s.state === "ready"));
    await supervisor.close(options);
    // 交接标记在 Server 退出那一刻决定本机 Agent 留不留
    assert.deepEqual(seenAtStop, [expected]);
  }
});

test("failed replacements and automatic retries stop by handover, keeping the adopted Agents", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hive-dev-failed-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const handoverPath = path.join(root, ".superhive-dev/agent-handover");
  const seenAtStop = [];
  let launches = 0;
  const supervisor = new DevSupervisor({
    statusPath: path.join(root, ".superhive-dev/status.json"),
    handoverPath,
    debounceMs: 20,
    restartDelay: () => 5,
    build: async () => ({}),
    startServer: async () => {
      launches += 1;
      const server = fakeServer(
        launches === 2 || launches === 3
          ? async () => Promise.reject(new DevError("health timeout"))
          : undefined,
      );
      const stop = server.stop.bind(server);
      server.stop = async () => {
        seenAtStop.push(fs.existsSync(handoverPath));
        fs.rmSync(handoverPath, { force: true }); // 真 Server 退出时用掉标记
        await stop();
      };
      return server;
    },
  });
  const statuses = [];
  supervisor.on("status", (status) => statuses.push(status));
  t.after(() => supervisor.close());
  supervisor.changed(["initial-start"], { immediate: true });
  await until(() => statuses.some((s) => s.state === "ready"));
  supervisor.changed(["apps/server/src/app.ts"]);
  await until(() => statuses.some((status) => status.state === "ready" && status.generation === 2));
  assert.equal(launches, 4);
  assert.deepEqual(seenAtStop, [true, true, true]);
  assert.ok(statuses.some((status) => status.restartAttempt === 2));
});

test("a supervisor without its Server reclaims the old generation by handover instead of failing on the busy port", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hive-dev-reclaim-"));
  const handoverPath = path.join(root, ".superhive-dev/agent-handover");
  const events = [];
  const orphan = fakeServer();
  orphan.stop = async () => {
    events.push(["stop-orphan", fs.existsSync(handoverPath)]);
  };
  let reclaims = 0;
  const supervisor = new DevSupervisor({
    statusPath: path.join(root, ".superhive-dev/status.json"),
    handoverPath,
    debounceMs: 20,
    build: async () => ({}),
    // 上一代 supervisor 意外退出，Server 还占着端口：只有手上没有 Server 时才去找
    reclaim: async () => (reclaims++ === 0 ? orphan : undefined),
    startServer: async () => {
      events.push(["start"]);
      return fakeServer();
    },
  });
  const statuses = [];
  supervisor.on("status", (status) => statuses.push(status));
  t.after(async () => {
    await supervisor.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  supervisor.changed(["initial-start"], { immediate: true });
  await until(() => statuses.some((s) => s.state === "ready"));
  // 交接标记写好后才停旧 Server，停完才起新的
  assert.deepEqual(events, [["stop-orphan", true], ["start"]]);
  supervisor.changed(["apps/server/src/app.ts"]);
  await until(() => statuses.filter((s) => s.state === "ready").length === 2);
  assert.equal(reclaims, 1);
});

test("a port held by something other than our old Server fails with its reason and starts nothing", async (t) => {
  let starts = 0;
  const f = fixture(t, {
    reclaim: async () => {
      throw new DevError("端口 8787 被其他程序占用（不是 Hive Server）");
    },
    startServer: async () => {
      starts += 1;
      return fakeServer();
    },
  });
  f.supervisor.changed(["initial-start"], { immediate: true });
  await until(() => f.statuses.some((s) => s.state === "failed"));
  assert.match(f.statuses.at(-1).error, /不是 Hive Server/);
  assert.equal(starts, 0);
});

test("only this checkout's unmanaged Hive Server is reclaimed from a busy port", async (t) => {
  let body = { status: "ok", pid: 4242, instanceId: "old" };
  const listener = http.createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(typeof body === "string" ? body : JSON.stringify(body));
  });
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => listener.close(resolve)));
  const port = listener.address().port;
  const entry = "/repo/apps/server/src/index.ts";
  let command = `node --import tsx ${entry}`;
  let managed = false;
  const find = () =>
    findOrphanServer({
      port,
      host: "127.0.0.1",
      healthUrl: `http://127.0.0.1:${port}/health`,
      entry,
      inspect: async (pid) => (pid === 4242 ? { ppid: 1, pgid: 4242, command } : undefined),
      isUnmanaged: async () => !managed,
    });
  const orphan = await find();
  assert.equal(orphan.pid, 4242);
  assert.equal(orphan.adopted, true);
  managed = true;
  await assert.rejects(find(), /另一个 pnpm dev/);
  managed = false;
  command = "node /elsewhere/apps/server/src/index.ts";
  await assert.rejects(find(), /另一个 Hive Server/);
  body = "<html>not hive</html>";
  await assert.rejects(find(), /不是 Hive Server/);
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const freePort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  assert.equal(
    await findOrphanServer({
      port: freePort,
      host: "127.0.0.1",
      healthUrl: `http://127.0.0.1:${freePort}/health`,
      entry,
    }),
    undefined,
  );
});

test(
  "adopted orphans are stopped with their process group, and never once they are not ours",
  { skip: process.platform === "win32" },
  async (t) => {
    const spawnOrphan = async () => {
      const child = startProcess(
        process.execPath,
        ["-e", "setInterval(()=>{},1000); console.log('started');"],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      await new Promise((resolve) => child.child.stdout.once("data", resolve));
      return child;
    };
    const ours = await spawnOrphan();
    t.after(() => ours.stop());
    const adopted = adoptProcess(ours.child.pid, { isOwn: async () => true, pollMs: 10 });
    await adopted.stop();
    assert.equal(adopted.finished, true);
    assert.equal((await ours.exited).signal, "SIGTERM");
    // pid 已经不是我们的（被复用、或核对失败）：不发任何信号
    const theirs = await spawnOrphan();
    t.after(() => theirs.stop());
    const refused = adoptProcess(theirs.child.pid, { isOwn: async () => false, pollMs: 10 });
    await refused.stop();
    assert.equal(theirs.finished, false);
  },
);
