import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DevError, runCheck, startProcess, writeStatus } from "./dev-process.mjs";
import {
  SelfReload,
  changedInputs,
  reloadSnapshot,
  requiresInstall,
  watchReloadInputs,
  verifySupervisorImports,
} from "./dev-reload.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function until(predicate, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail("reload condition timed out");
    await delay(5);
  }
}
function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hive-self-reload-"));
  // Windows 上目录还被刚结束的子进程占着时删除会 EBUSY，稍等重试
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  return root;
}
function put(root, file, contents) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), contents);
}
function fixture(t, overrides = {}) {
  const states = [];
  let installs = 0;
  let restarts = 0;
  let acknowledgements = 0;
  const supervisor = {
    async pause() {
      this.paused = true;
    },
    resume() {
      this.paused = false;
    },
    setControlFailure(files, error) {
      this.status("failed", files, error);
    },
    status(state, files, error) {
      states.push({ state, files, error });
    },
  };
  const reloader = new SelfReload({
    supervisor,
    debounceMs: 10,
    install: async () => {
      installs += 1;
    },
    checkScripts: async () => {},
    restart: async () => {
      restarts += 1;
    },
    acknowledgeInstallLock: () => {
      acknowledgements += 1;
    },
    ...overrides,
  });
  t.after(() => reloader.stop());
  return {
    reloader,
    supervisor: reloader.supervisor,
    states,
    get installs() {
      return installs;
    },
    get restarts() {
      return restarts;
    },
    get acknowledgements() {
      return acknowledgements;
    },
  };
}

test("control snapshot includes imports, all package manifests, lock and workspace config", (t) => {
  const root = directory(t);
  const before = reloadSnapshot(root);
  const changed = [
    "scripts/dev-supervisor.mjs",
    "scripts/helpers/dependency-check.mjs",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "apps/new/package.json",
    "packages/nested/pkg/package.json",
  ];
  for (const file of changed) put(root, file, "first");
  for (const file of [
    "scripts/dev.mjs",
    "scripts/dev-reload.test.mjs",
    "scripts/dev-supervisor.smoke.mjs",
    "packages/demo/node_modules/x/package.json",
    ".ai-hive-dev/status.json",
  ])
    put(root, file, "ignored");
  const after = reloadSnapshot(root);
  assert.deepEqual(changedInputs(before, after), changed.sort());
  fs.rmSync(path.join(root, "scripts/helpers/dependency-check.mjs"));
  assert.deepEqual(changedInputs(after, reloadSnapshot(root)), [
    "scripts/helpers/dependency-check.mjs",
  ]);
  assert.equal(requiresInstall("scripts/dev-process.mjs"), false);
  assert.equal(requiresInstall("apps/web/package.json"), true);
});

test("content polling ignores identical saves and acknowledges install lock output only", (t) => {
  const root = directory(t);
  put(root, "package.json", "original");
  put(root, "pnpm-lock.yaml", "old lock");
  const changes = [];
  const watcher = watchReloadInputs(
    root,
    (files) => changes.push(files),
    (error) => {
      throw error;
    },
    { intervalMs: 100_000 },
  );
  t.after(() => watcher.close());
  put(root, "package.json", "original");
  watcher.poll();
  assert.deepEqual(changes, []);
  put(root, "pnpm-lock.yaml", "installer output");
  put(root, "package.json", "user edit during install");
  watcher.acknowledgeInstallLock();
  watcher.poll();
  assert.deepEqual(changes, [["package.json"]]);
  put(root, "pnpm-lock.yaml", "later real user edit");
  watcher.poll();
  assert.deepEqual(changes.at(-1), ["pnpm-lock.yaml"]);
});

test("script-only burst requests a single handoff and does not install", async (t) => {
  const f = fixture(t);
  f.reloader.changed(["scripts/dev-supervisor.mjs"]);
  f.reloader.changed(["scripts/dev-process.mjs"]);
  await until(() => f.restarts === 1);
  assert.equal(f.installs, 0);
  assert.deepEqual(
    f.states.map((s) => s.state),
    ["pending", "pending", "building", "restarting"],
  );
  await delay(40);
  assert.equal(f.restarts, 1);
});

test("install completes before handoff, and its lockfile rewrite cannot loop", async (t) => {
  const gate = deferred();
  const sequence = [];
  const f = fixture(t, {
    install: async () => {
      sequence.push("install");
      await gate.promise;
      sequence.push("installed");
    },
    checkScripts: async () => {
      sequence.push("check");
    },
    restart: async () => {
      sequence.push("restart");
    },
  });
  f.reloader.changed(["package.json", "pnpm-lock.yaml"]);
  await until(() => f.reloader.installing);
  f.reloader.changed(["pnpm-lock.yaml"]);
  assert.equal(sequence.includes("restart"), false);
  gate.resolve();
  await until(() => sequence.includes("restart"));
  await delay(50);
  assert.deepEqual(sequence, ["install", "installed", "check", "restart"]);
  assert.equal(f.acknowledgements, 1);
});

test("package changes during installation are retained and serialized into a new install", async (t) => {
  const gate = deferred();
  let installs = 0;
  const f = fixture(t, {
    install: async () => {
      if (++installs === 1) await gate.promise;
    },
  });
  f.reloader.changed(["package.json"]);
  await until(() => installs === 1);
  f.reloader.changed(["apps/web/package.json"]);
  await delay(20);
  assert.equal(installs, 1);
  gate.resolve();
  await until(() => f.restarts === 1);
  assert.equal(installs, 2);
});

test("helper edits during installation do not install again", async (t) => {
  const gate = deferred();
  let installs = 0;
  const f = fixture(t, {
    install: async () => {
      installs += 1;
      await gate.promise;
    },
  });
  f.reloader.changed(["pnpm-workspace.yaml"]);
  await until(() => installs === 1);
  f.reloader.changed(["scripts/helpers/reload.mjs"]);
  gate.resolve();
  await until(() => f.restarts === 1);
  assert.equal(installs, 1);
});

test("failed installs do not hand off; a real correction retries without a timer loop", async (t) => {
  let fail = true;
  let attempts = 0;
  const f = fixture(t, {
    install: async () => {
      attempts += 1;
      if (fail) throw new DevError("pnpm install failed");
    },
  });
  f.reloader.changed(["package.json"]);
  await until(() => f.states.at(-1).state === "failed");
  await delay(50);
  assert.equal(attempts, 1);
  assert.equal(f.restarts, 0);
  fail = false;
  f.reloader.changed(["package.json"]);
  await until(() => f.restarts === 1);
  assert.equal(attempts, 2);
});

test("syntax validation failure retains the old supervisor until the script is fixed", async (t) => {
  let fail = true;
  const f = fixture(t, {
    checkScripts: async () => {
      if (fail) throw new DevError("invalid supervisor syntax");
    },
  });
  f.reloader.changed(["scripts/dev-supervisor.mjs"]);
  await until(() => f.states.at(-1).state === "failed");
  assert.equal(f.restarts, 0);
  fail = false;
  f.reloader.changed(["scripts/dev-supervisor.mjs"]);
  await until(() => f.restarts === 1);
});

test("shutdown cancels an in-flight install without requesting restart", async (t) => {
  let cancelled = false;
  const f = fixture(t, {
    install: ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            cancelled = true;
            reject(new DevError("cancelled"));
          },
          { once: true },
        );
      }),
  });
  f.reloader.changed(["package.json"]);
  await until(() => f.reloader.installing);
  await f.reloader.stop();
  assert.equal(cancelled, true);
  assert.equal(f.restarts, 0);
});

test(
  "real offline pnpm install works in a dependency-free isolated project",
  { timeout: 20_000 },
  async (t) => {
    const root = directory(t);
    put(
      root,
      "package.json",
      JSON.stringify({ name: "hive-dev-install-test", version: "1.0.0", private: true }),
    );
    await runCheck(
      process.platform === "win32" ? "pnpm.cmd" : "pnpm",
      ["install", "--offline", "--ignore-scripts", "--no-frozen-lockfile"],
      "isolated install",
      {
        cwd: root,
        signal: new globalThis.AbortController().signal,
        env: { ...process.env, CI: "1" },
        timeoutMs: 10_000,
      },
    );
    assert.ok(fs.existsSync(path.join(root, "pnpm-lock.yaml")));
  },
);

function launcherFixture(t, supervisor) {
  const root = directory(t);
  put(root, "package.json", JSON.stringify({ private: true, type: "module" }));
  put(
    root,
    "scripts/dev.mjs",
    fs.readFileSync(fileURLToPath(new globalThis.URL("./dev.mjs", import.meta.url)), "utf8"),
  );
  put(root, "scripts/dev-supervisor.mjs", supervisor);
  return root;
}

test(
  "stable launcher honors reserved exit code and forwards shutdown",
  { timeout: 10_000 },
  async (t) => {
    const root = launcherFixture(
      t,
      `import fs from 'node:fs';
    fs.mkdirSync('.ai-hive-dev',{recursive:true});
    let count=0;try{count=Number(fs.readFileSync('.ai-hive-dev/count','utf8'))}catch{}
    fs.writeFileSync('.ai-hive-dev/count',String(++count));
    if(count<3)process.exit(75);else setInterval(()=>{},1000);`,
    );
    const processHandle = startProcess(process.execPath, [path.join(root, "scripts/dev.mjs")], {
      cwd: root,
      stdio: "ignore",
    });
    t.after(() => processHandle.stop());
    const count = () => {
      try {
        return Number(fs.readFileSync(path.join(root, ".ai-hive-dev/count"), "utf8"));
      } catch {
        return 0;
      }
    };
    await until(() => count() === 3);
    await delay(100);
    assert.equal(count(), 3);
    await processHandle.stop();
    assert.equal(processHandle.finished, true);
  },
);

test(
  "launcher stays alive after broken supervisor startup and retries only after a fix",
  { timeout: 10_000 },
  async (t) => {
    const root = launcherFixture(t, "const = broken syntax;");
    const statusPath = path.join(root, ".ai-hive-dev/status.json");
    writeStatus(statusPath, { generation: 41, state: "restarting", updatedAt: "now" });
    const processHandle = startProcess(process.execPath, [path.join(root, "scripts/dev.mjs")], {
      cwd: root,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let errors = "";
    processHandle.child.stderr.on("data", (data) => {
      errors += data;
    });
    t.after(() => processHandle.stop());
    const status = () => JSON.parse(fs.readFileSync(statusPath, "utf8"));
    await until(() => status().state === "failed");
    // 状态文件先于 stderr 写完（Windows 上管道输出明显更慢）：等这次失败的输出停下来再开始数
    let settled = errors.length;
    for (;;) {
      await delay(300);
      if (errors.length === settled) break;
      settled = errors.length;
    }
    const length = errors.length;
    await delay(650);
    assert.equal(errors.length, length);
    assert.equal(processHandle.finished, false);
    put(
      root,
      "scripts/dev-supervisor.mjs",
      `import fs from 'node:fs';
    const p='.ai-hive-dev/status.json';const old=JSON.parse(fs.readFileSync(p,'utf8'));
    fs.writeFileSync(p,JSON.stringify({...old,generation:old.generation+1,state:'ready'}));setInterval(()=>{},1000);`,
    );
    // 重新拉起 supervisor 要冷启动 node，Windows 上比 macOS 慢得多
    await until(() => status().state === "ready", 20_000);
    assert.equal(status().generation, 42);
    // 先结束启动器再删临时目录：Windows 上进程的工作目录不能删除
    await processHandle.stop();
  },
);

test("end-of-install refresh catches edits before the next polling tick", async (t) => {
  const root = directory(t);
  put(root, "package.json", "root-before");
  put(root, "apps/web/package.json", "child-before");
  let installs = 0;
  let watcher;
  const f = fixture(t, {
    install: async () => {
      if (++installs === 1) put(root, "apps/web/package.json", "edited-while-install-ended");
    },
    acknowledgeInstallLock: () => watcher.acknowledgeInstallLock(),
    refreshInputs: () => watcher.poll(),
  });
  watcher = watchReloadInputs(
    root,
    (files) => f.reloader.changed(files),
    (error) => {
      throw error;
    },
    { intervalMs: 100_000 },
  );
  t.after(() => watcher.close());
  put(root, "package.json", "root-after");
  watcher.poll();
  await until(() => f.restarts === 1);
  assert.equal(installs, 2);
});

test("self-reload waits for an in-flight source check and does not publish it", async (t) => {
  const { DevSupervisor } = await import("./dev-supervisor.mjs");
  const root = directory(t);
  const gate = deferred();
  let building = false;
  let published = false;
  const source = new DevSupervisor({
    statusPath: path.join(root, ".ai-hive-dev/status.json"),
    debounceMs: 1,
    build: async () => {
      building = true;
      await gate.promise;
      return {
        publish() {
          published = true;
        },
      };
    },
    startServer: async () => {
      assert.fail("obsolete source build must not start a server");
    },
  });
  t.after(() => source.close());
  const f = fixture(t, { supervisor: source });
  source.changed(["apps/server/src/index.ts"], { immediate: true });
  await until(() => building);
  f.reloader.changed(["package.json"]);
  await delay(30);
  assert.equal(f.installs, 0);
  gate.resolve();
  await until(() => f.restarts === 1);
  assert.equal(published, false);
  assert.equal(f.installs, 1);
});

test(
  "post-exit group cleanup EPERM does not turn successful shutdown into a failed handoff",
  { skip: process.platform === "win32" },
  async (t) => {
    const handle = startProcess(
      process.execPath,
      ["-e", "console.log('ready');setInterval(()=>{},1000)"],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    await new Promise((resolve) => handle.child.stdout.once("data", resolve));
    const original = process.kill.bind(process);
    t.mock.method(process, "kill", (pid, signal) => {
      if (pid === -handle.child.pid && signal === "SIGKILL" && handle.finished)
        throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
      return original(pid, signal);
    });
    await assert.doesNotReject(handle.stop());
    assert.equal(handle.finished, true);
  },
);

test(
  "permission errors stopping a live process are not swallowed",
  { skip: process.platform === "win32" },
  async (t) => {
    const handle = startProcess(
      process.execPath,
      ["-e", "console.log('ready');setInterval(()=>{},1000)"],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    await new Promise((resolve) => handle.child.stdout.once("data", resolve));
    const original = process.kill.bind(process);
    const mock = t.mock.method(process, "kill", (pid, signal) => {
      if (pid === -handle.child.pid && signal === "SIGTERM")
        throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
      return original(pid, signal);
    });
    try {
      await assert.rejects(handle.stop(), { code: "EPERM" });
    } finally {
      mock.mock.restore();
      original(-handle.child.pid, "SIGKILL");
      await handle.exited;
    }
  },
);

for (const failure of ["install", "checkScripts"]) {
  test(`${failure} failure resumes real source builds without clearing the control failure`, async (t) => {
    const { DevSupervisor } = await import("./dev-supervisor.mjs");
    const root = directory(t);
    const statuses = [];
    let builds = 0;
    let starts = 0;
    const source = new DevSupervisor({
      statusPath: path.join(root, ".ai-hive-dev/status.json"),
      debounceMs: 1,
      build: async () => {
        builds += 1;
        return {};
      },
      startServer: async () => {
        starts += 1;
        const exit = deferred();
        return { exited: exit.promise, ready: async () => {}, stop: async () => exit.resolve() };
      },
    });
    source.on("status", (status) => statuses.push(status));
    t.after(() => source.close());
    const f = fixture(t, {
      supervisor: source,
      [failure]: async () => {
        throw new DevError(`${failure} remains unresolved`);
      },
    });
    f.reloader.changed([failure === "install" ? "package.json" : "scripts/dev-supervisor.mjs"]);
    await until(() => source.controlFailure && !source.paused);
    source.changed(["apps/server/src/index.ts"]);
    await until(() => starts === 1 && statuses.at(-1).error?.includes("应用服务已更新"));
    assert.equal(builds, 1);
    assert.ok(statuses.some((status) => status.state === "building"));
    assert.equal(statuses.at(-1).state, "failed");
    assert.match(statuses.at(-1).error, /remains unresolved/);
    assert.equal(
      statuses.some((status) => status.state === "ready"),
      false,
    );
    assert.equal(source.paused, false);
    assert.equal(f.restarts, 0);
  });
}

test("source edits queued during a failed install resume immediately afterwards", async (t) => {
  const { DevSupervisor } = await import("./dev-supervisor.mjs");
  const root = directory(t);
  const gate = deferred();
  let builds = 0;
  const source = new DevSupervisor({
    statusPath: path.join(root, ".ai-hive-dev/status.json"),
    debounceMs: 10_000,
    build: async () => {
      builds += 1;
      throw new DevError("source also broken");
    },
    startServer: async () => {
      assert.fail("broken source should not run");
    },
  });
  t.after(() => source.close());
  const f = fixture(t, {
    supervisor: source,
    install: async () => {
      await gate.promise;
      throw new DevError("offline install");
    },
  });
  f.reloader.changed(["package.json"]);
  await until(() => f.reloader.installing);
  source.changed(["packages/ai-hive/src/bridge.ts"]);
  assert.equal(builds, 0);
  gate.resolve();
  await until(() => builds === 1);
  await until(() => !source.active);
  const status = JSON.parse(fs.readFileSync(source.statusPath, "utf8"));
  assert.match(status.error, /source also broken/);
  assert.match(status.error, /offline install/);
  assert.equal(source.paused, false);
});

test("superseded control updates retain the pause until the replacement update settles", async (t) => {
  const gate = deferred();
  let checks = 0;
  const f = fixture(t, {
    checkScripts: async () => {
      if (++checks === 1) await gate.promise;
      else throw new DevError("replacement invalid");
    },
  });
  f.reloader.changed(["scripts/dev-supervisor.mjs"]);
  await until(() => checks === 1);
  f.reloader.changed(["scripts/dev-process.mjs"]);
  assert.equal(f.supervisor.paused, true);
  gate.resolve();
  await until(() => f.states.at(-1).state === "failed");
  assert.equal(f.supervisor.paused, false);
  assert.equal(f.restarts, 0);
});

test("module preflight rejects missing exports despite valid syntax and passes once fixed", async (t) => {
  const root = directory(t);
  put(root, "scripts/helper.mjs", "export const renamed = 1;");
  put(
    root,
    "scripts/dev-supervisor.mjs",
    "import { expected } from './helper.mjs'; export const result = expected;",
  );
  const options = { signal: new globalThis.AbortController().signal };
  await runCheck(
    process.execPath,
    ["--check", "scripts/dev-supervisor.mjs"],
    "syntax-only fixture",
    { cwd: root, ...options },
  );
  await assert.rejects(verifySupervisorImports(root, options), /模块加载/);
  put(root, "scripts/helper.mjs", "export const expected = 1;");
  await verifySupervisorImports(root, options);
});

test("import preflight respects the CLI main guard and cannot run forever", async (t) => {
  const root = directory(t);
  put(
    root,
    "scripts/dev-supervisor.mjs",
    "import fs from 'node:fs';if(process.argv[1])fs.writeFileSync('should-not-run','bad');",
  );
  const options = { signal: new globalThis.AbortController().signal };
  await verifySupervisorImports(root, options);
  assert.equal(fs.existsSync(path.join(root, "should-not-run")), false);
  put(root, "scripts/dev-supervisor.mjs", "await new Promise(()=>{setInterval(()=>{},1000)});");
  await assert.rejects(verifySupervisorImports(root, { ...options, timeoutMs: 50 }), /模块加载/);
});
