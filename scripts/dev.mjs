// Stable, dependency-free bootstrap. Keep mutable development logic in the supervisor.
import { spawn } from "node:child_process";
import console from "node:console";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const RESTART_EXIT_CODE = 75;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ignored = new Set([
  "node_modules",
  ".git",
  "dist",
  "coverage",
  "data",
  "logs",
  ".ai-hive-dev",
]);
let stopping = false;
let child;

// Only used after an unexpected supervisor failure; unchanged code is never retried in a loop.
function revision() {
  const hash = createHash("sha256");
  const add = (file) => {
    try {
      hash.update(file).update(fs.readFileSync(path.join(root, file)));
    } catch {
      hash.update(`missing:${file}`);
    }
  };
  const walk = (directory) => {
    if (!fs.existsSync(path.join(root, directory))) return;
    for (const entry of fs
      .readdirSync(path.join(root, directory), { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (ignored.has(entry.name)) continue;
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && /\.(?:[cm]?[jt]sx?|json|ya?ml)$/.test(file)) add(file);
    }
  };
  for (const file of [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.base.json",
  ])
    add(file);
  for (const directory of ["scripts", "apps", "packages"]) walk(directory);
  return hash.digest("hex");
}

function recordFailure() {
  const statusPath = path.join(root, ".ai-hive-dev/status.json");
  let generation = 0;
  try {
    const previous = JSON.parse(fs.readFileSync(statusPath, "utf8")).generation;
    if (Number.isSafeInteger(previous) && previous >= 0) generation = previous;
  } catch {
    /* first startup */
  }
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  const temporary = `${statusPath}.${process.pid}.tmp`;
  fs.writeFileSync(
    temporary,
    JSON.stringify({
      generation,
      state: "failed",
      updatedAt: new Date().toISOString(),
      error: "开发 supervisor 启动失败；修改代码或配置后会自动重试，详细诊断见本机 dev 终端。",
    }),
    { mode: 0o600 },
  );
  fs.renameSync(temporary, statusPath);
}

async function launch() {
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => {
      stopping = true;
      child?.kill(signal);
    });
  while (!stopping) {
    const before = revision();
    const code = await new Promise((resolve) => {
      child = spawn(process.execPath, [path.join(root, "scripts/dev-supervisor.mjs")], {
        cwd: root,
        stdio: "inherit",
        env: { ...process.env, HIVE_DEV_LAUNCHER_PID: String(process.pid) },
      });
      child.once("error", () => resolve(1));
      child.once("exit", (code, signal) => resolve(signal ? 1 : code));
    });
    child = undefined;
    if (stopping || code === 0) break;
    if (code === RESTART_EXIT_CODE) continue;
    recordFailure();
    console.error(
      "[dev] supervisor 已退出；启动器保留，等待代码/配置修正，不会反复重启同一份坏代码。",
    );
    while (!stopping && revision() === before) await delay(500);
  }
}

launch().catch(() => {
  console.error("[dev] 启动器失败，请检查本机目录权限后重新运行 pnpm dev。");
  process.exitCode = 1;
});
