#!/usr/bin/env node
// 构建后自检：dist 产物里引用的外部包必须都声明在本包 dependencies 中。
// build:server 用 --packages=external 打包，apps/server 新增运行依赖而漏改这里时，
// npx superhive 安装后会在启动时抛 MODULE_NOT_FOUND；此脚本把问题拦在构建阶段。
import { builtinModules } from "node:module";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distDir = path.join(pkgRoot, "dist");

async function collectJsFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collectJsFiles(full)));
    else if (entry.isFile() && entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

/** 取裸导入的包名：@scope/name 取前两段，其余取第一段（子路径导入归并到包） */
function packageName(specifier) {
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
}

const importPattern = /(?:from\s*|import\s*\(?\s*|require\s*\(\s*)["']([^"']+)["']/g;
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

const pkg = JSON.parse(await readFile(path.join(pkgRoot, "package.json"), "utf8"));
// better-sqlite3 是可选依赖：只有 Server 用，npx superhive join 在装不上它（下载预编译超时、本机编译失败）时也能跑
const dependencies = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
]);

const files = await collectJsFiles(distDir);
if (files.length === 0) {
  console.error("[check-release-deps] dist 目录为空：请先完成 pnpm build");
  process.exit(1);
}

const missing = new Map();
const found = new Map();
for (const file of files) {
  const code = await readFile(file, "utf8");
  for (const match of code.matchAll(importPattern)) {
    const spec = match[1];
    if (!/^[a-zA-Z@]/.test(spec)) continue; // 相对/绝对路径不涉及安装
    if (builtins.has(spec) || spec.startsWith("node:")) continue;
    const name = packageName(spec);
    if (dependencies.has(name)) {
      found.set(name, (found.get(name) ?? 0) + 1);
      continue;
    }
    if (!missing.has(name)) missing.set(name, new Set());
    missing.get(name).add(path.relative(pkgRoot, file));
  }
}

if (missing.size > 0) {
  console.error(
    "[check-release-deps] dist 中引用了未声明的外部包（补进 dependencies 或 optionalDependencies，版本对齐 apps/server）：",
  );
  for (const [name, refs] of missing) {
    console.error(`  ${name}`);
    for (const ref of refs) console.error(`    ${ref}`);
  }
  process.exit(1);
}

console.log(
  `[check-release-deps] OK：${files.length} 个产物文件，${found.size} 个外部包均已声明在 dependencies`,
);
for (const [name, count] of [...found].sort()) console.log(`  ${name}（引用 ${count} 处）`);

for (const bin of Object.values(pkg.bin ?? {})) {
  if (!existsSync(path.join(pkgRoot, bin))) {
    console.error(`[check-release-deps] bin 入口不存在：${bin}`);
    process.exit(1);
  }
}
