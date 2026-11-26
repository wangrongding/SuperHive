#!/usr/bin/env node
/**
 * 把桌面端组装成一个独立的 Electron 应用目录 .stage/app：
 *
 *   main.cjs / preload.cjs   主进程和预加载脚本（esbuild 打包）
 *   superhive/               随包的 superhive CLI、Server 构建产物、网页和协作说明（和 npm 包同一份）
 *   node_modules/            运行时依赖，用 npm 单独装、再按 Electron 的 ABI 重新编译原生模块
 *
 * 为什么不直接用仓库的 node_modules：better-sqlite3 要按 Electron 的 ABI 编译，
 * 在 pnpm 共享的依赖里改编译会让 server 的测试（跑在系统 Node 上）全部挂掉；
 * 而且仓库用的 better-sqlite3 12.x 在 Electron 45 的 V8 上编译不过，桌面端换成走 N-API 的 13.x。
 * 所以运行时依赖在这里另装一份，版本钉成仓库里实际装的版本（覆盖项见 package.json）。
 *
 * 用法：node scripts/stage.mjs [--rebuild]   --rebuild 强制重新构建 superhive 包
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(desktopDir, "../..");
const superhiveDir = path.join(repoRoot, "packages/superhive");
const stageDir = path.join(desktopDir, ".stage/app");
const forceRebuild = process.argv.includes("--rebuild");
const require = createRequire(import.meta.url);

const desktopPkg = JSON.parse(readFileSync(path.join(desktopDir, "package.json"), "utf8"));
const superhivePkg = JSON.parse(readFileSync(path.join(superhiveDir, "package.json"), "utf8"));
const electronVersion = JSON.parse(
  readFileSync(require.resolve("electron/package.json"), "utf8"),
).version;

function run(command, args, options = {}) {
  console.log(`[stage] ${command} ${args.join(" ")}`);
  // Windows 上 pnpm / npm 是 .cmd，execFileSync 不走 shell 找不到（spawnSync pnpm ENOENT）；
  // 这里的参数都是固定的、没有空格，走 shell 不会被拆开
  execFileSync(command, args, {
    stdio: "inherit",
    ...(process.platform === "win32" ? { shell: true } : {}),
    ...options,
  });
}

// 1. superhive 包：CLI、打包后的 Server、网页、skills
const distReady =
  existsSync(path.join(superhiveDir, "dist/cli.js")) &&
  existsSync(path.join(superhiveDir, "dist/server/index.js")) &&
  existsSync(path.join(superhiveDir, "web/index.html")) &&
  existsSync(path.join(superhiveDir, "skills"));
if (forceRebuild || !distReady) {
  run("pnpm", ["--filter", "superhive", "build"], { cwd: repoRoot });
}

mkdirSync(stageDir, { recursive: true });
const stagedSuperhive = path.join(stageDir, "superhive");
rmSync(stagedSuperhive, { recursive: true, force: true });
mkdirSync(stagedSuperhive, { recursive: true });
for (const entry of ["dist", "web", "skills", "package.json", "README.md", "LICENSE"]) {
  const from = path.join(superhiveDir, entry);
  if (existsSync(from))
    cpSync(from, path.join(stagedSuperhive, entry), {
      recursive: true,
      // 不带 source map 和类型声明
      filter: (file) => !/\.(map|d\.ts)$/.test(file),
    });
}

// 2. 主进程和 preload
await build({
  entryPoints: { main: path.join(desktopDir, "src/main.ts") },
  outdir: stageDir,
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron", "node-pty"],
  sourcemap: "inline",
  logLevel: "warning",
});
await build({
  entryPoints: { preload: path.join(desktopDir, "src/preload.ts") },
  outdir: stageDir,
  outExtension: { ".js": ".cjs" },
  bundle: true,
  // 沙箱里的 preload 只能 require electron 等少数模块，其余必须打进来
  platform: "node",
  format: "cjs",
  target: "chrome140",
  external: ["electron"],
  logLevel: "warning",
});
cpSync(path.join(desktopDir, "forge.config.cjs"), path.join(stageDir, "forge.config.cjs"));
cpSync(
  path.join(desktopDir, "scripts/prune-natives.cjs"),
  path.join(stageDir, "prune-natives.cjs"),
);

// 3. 运行时依赖：superhive 的 dependencies + node-pty，版本钉成仓库里实际装的
function installedVersion(name, fromDir) {
  const localRequire = createRequire(path.join(fromDir, "package.json"));
  let dir = path.dirname(localRequire.resolve(name));
  // 找到这个包自己的 package.json（入口可能在子目录里）
  while (dir !== path.dirname(dir)) {
    const candidate = path.join(dir, "package.json");
    if (existsSync(candidate)) {
      const pkg = JSON.parse(readFileSync(candidate, "utf8"));
      if (pkg.name === name) return pkg.version;
    }
    dir = path.dirname(dir);
  }
  throw new Error(`cannot find installed version of ${name}`);
}
const dependencies = {};
// npm 包里 better-sqlite3 是可选依赖（npx superhive join 用不到它）；桌面端自带 Server，必须装上
const superhiveDeps = { ...superhivePkg.optionalDependencies, ...superhivePkg.dependencies };
for (const name of Object.keys(superhiveDeps).sort()) {
  try {
    dependencies[name] = installedVersion(name, path.join(repoRoot, "apps/server"));
  } catch {
    dependencies[name] = superhiveDeps[name];
  }
}
dependencies["node-pty"] = desktopPkg.dependencies["node-pty"];
// 只在桌面端这一份里换的版本（见 package.json 的 superhiveDesktop.dependencyOverrides）
Object.assign(dependencies, desktopPkg.superhiveDesktop?.dependencyOverrides ?? {});

const stagePkg = {
  name: "superhive-desktop",
  productName: desktopPkg.productName,
  version: desktopPkg.version,
  description: desktopPkg.description,
  author: desktopPkg.author,
  license: desktopPkg.license,
  main: "main.cjs",
  dependencies,
  // Forge 靠它确定 Electron 版本；运行时依赖里没有 electron
  devDependencies: { electron: electronVersion },
  // 让 Forge 认这个目录为项目根（否则它会往上找到 apps/desktop，把整个目录打进去）
  config: { forge: "./forge.config.cjs" },
};
writeFileSync(path.join(stageDir, "package.json"), `${JSON.stringify(stagePkg, null, 2)}\n`);

const depsKey = createHash("sha256")
  .update(JSON.stringify({ dependencies, electronVersion, arch: process.arch }))
  .digest("hex");
const depsKeyFile = path.join(stageDir, "node_modules/.superhive-deps");
const depsCurrent = existsSync(depsKeyFile) && readFileSync(depsKeyFile, "utf8").trim() === depsKey;
if (!depsCurrent) {
  rmSync(path.join(stageDir, "node_modules"), { recursive: true, force: true });
  rmSync(path.join(stageDir, "package-lock.json"), { force: true });
  run(
    "npm",
    ["install", "--omit=dev", "--no-audit", "--no-fund", "--no-package-lock", "--ignore-scripts"],
    { cwd: stageDir },
  );
  // 原生模块：better-sqlite3 13 和 node-pty 都是 N-API，自带 macOS / Windows 预编译包，和 Electron 版本无关；
  // node-pty 没有 Linux 预编译包，Linux 上按 Electron 编一次
  if (process.platform === "linux") {
    const { rebuild } = await import("@electron/rebuild");
    console.log(`[stage] rebuilding node-pty for Electron ${electronVersion}`);
    await rebuild({
      buildPath: stageDir,
      electronVersion,
      arch: process.arch,
      onlyModules: ["node-pty"],
      force: true,
    });
  }
  writeFileSync(depsKeyFile, `${depsKey}\n`);
}
// 装依赖时跳过了安装脚本，node-pty 的 spawn-helper 没被加上可执行权限（否则 posix_spawnp failed）
const ptyPrebuilds = path.join(stageDir, "node_modules/node-pty/prebuilds");
if (existsSync(ptyPrebuilds)) {
  for (const platformDir of readdirSync(ptyPrebuilds)) {
    const helper = path.join(ptyPrebuilds, platformDir, "spawn-helper");
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
}
console.log(`[stage] ready: ${stageDir} (Electron ${electronVersion})`);
