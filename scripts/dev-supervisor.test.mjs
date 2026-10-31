import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  DevError,
  DevSupervisor,
  SOURCE_ROOTS,
  isWatchedFile,
  publicError,
  readGeneration,
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
    statusPath: path.join(root, ".ai-hive-dev/status.json"),
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
    "packages/ai-hive/src/bridge.ts",
    "tsconfig.base.json",
    "apps/server/tsconfig.json",
    "packages\\ai-hive\\src\\bridge.ts",
  ])
    assert.equal(isWatchedFile(file), true, file);
  for (const file of [
    "apps/web/src/App.tsx",
    ".ai-hive-dev/status.json",
    "apps/server/data/hive.sqlite",
    "packages/protocol/dist/index.js",
    "packages/protocol/.ai-hive-dev/build/index.d.ts",
    "packages/ai-hive/src/node_modules/x.js",
    "apps/server/src/logs/x.json",
    "README.md",
    "packages/ai-hive/package.json",
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

test("startup failures stop the broken replacement and do not stop the watcher", async (t) => {
  const failed = fakeServer(async () => {
    throw new DevError("健康检查失败");
  });
  let launches = 0;
  const f = fixture(t, { startServer: async () => (++launches === 1 ? failed : fakeServer()) });
  f.supervisor.changed(["broken.ts"], { immediate: true });
  await until(() => failed.stopped);
  assert.equal(f.statuses.at(-1).state, "failed");
  f.supervisor.changed(["fixed.ts"], { immediate: true });
  await f.ready(2);
});

test("unexpected server exit revokes ready without entering a crash loop", async (t) => {
  const f = fixture(t);
  f.supervisor.changed(["start"], { immediate: true });
  await f.ready(1);
  f.servers[0].crash({ code: 1 });
  await until(() => f.statuses.at(-1).state === "failed");
  await delay(50);
  assert.equal(f.servers.length, 1);
  f.supervisor.changed(["fix"], { immediate: true });
  await f.ready(2);
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
      bridge: "packages/ai-hive/src/bridge.json",
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
      statusPath: path.join(root, ".ai-hive-dev/status.json"),
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
  const handoverPath = path.join(root, ".ai-hive-dev/agent-handover");
  const seenAtStop = [];
  const supervisor = new DevSupervisor({
    statusPath: path.join(root, ".ai-hive-dev/status.json"),
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
