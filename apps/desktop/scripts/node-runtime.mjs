/**
 * 桌面端自带的 Node 运行时（含 npm / npx），只给本机 Agent 跑和安装 npm 装的 CLI 用：
 * 不进系统 PATH、不改用户环境变量，路径由桌面端经环境变量交给 Server 和 Agent（见 src/bundled-node.ts）。
 *
 * 为什么不用 Electron 自己当 Node：那要打开 RunAsNode fuse，任何程序都能借我们的 exe 跑任意脚本；
 * Electron 里也没有 npm。
 *
 * 版本固定；每个平台压缩包的 SHA-256 抄自官方 SHASUMS256.txt 写死在这里。下载后先和写死的值比，
 * 再和当场从 nodejs.org 拉的 SHASUMS256.txt 比，两处都对得上才解压；任何一处不对就中止打包。
 * 升级 Node：改 version，把新版 SHASUMS256.txt 里对应几行抄进 sha256。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const NODE_RUNTIME = {
  version: "24.22.3",
  // https://nodejs.org/dist/v24.22.3/SHASUMS256.txt
  sha256: {
    "darwin-arm64": "ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd",
    "darwin-x64": "977614af0504c81045e7fd85596dbca0e5f951b96681516dadafedcca8c447f7",
    "linux-arm64": "261af2af250dfd7e9f25cf151d1b2713a0adf8f10a9ad116c4947f68627affe8",
    "linux-x64": "061ec3e3062115705b56b51fa9cc330ab50d34b6969387d4e4b1a50c6809acc2",
    "win-arm64": "b3cc74a295b39d4f273271e96f58c06dd2b35757ca12abec64c7d0598b434f14",
    "win-x64": "e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f",
  },
};

const DIST = "https://nodejs.org/dist";
const STAMP = ".superhive-node";

/** 官方压缩包的名字：node-v24.22.3-darwin-arm64.tar.gz / node-v24.22.3-win-x64.zip */
export function nodeArchive(platform, arch, version = NODE_RUNTIME.version) {
  const os = platform === "win32" ? "win" : platform;
  if (!["darwin", "linux", "win"].includes(os)) throw new Error(`no Node build for ${platform}`);
  const target = `${os}-${arch}`;
  const base = `node-v${version}-${target}`;
  const file = `${base}${os === "win" ? ".zip" : ".tar.gz"}`;
  return { target, base, file, url: `${DIST}/v${version}/${file}` };
}

/** SHASUMS256.txt → 文件名到哈希 */
export function parseShasums(text) {
  const sums = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(\S+)$/i.exec(line.trim());
    if (match) sums.set(match[2], match[1].toLowerCase());
  }
  return sums;
}

/** 三方对账：写死的、官方清单上的、实际下载的，有一处不一致就抛错 */
export function verifyArchive({ file, actual, pinned, shasums }) {
  if (!pinned) throw new Error(`[node] no pinned SHA-256 for ${file}; add it to NODE_RUNTIME`);
  const official = parseShasums(shasums).get(file);
  if (!official) throw new Error(`[node] ${file} is not listed in the official SHASUMS256.txt`);
  if (official !== pinned.toLowerCase()) {
    throw new Error(`[node] pinned SHA-256 of ${file} does not match SHASUMS256.txt (${official})`);
  }
  if (actual.toLowerCase() !== official) {
    throw new Error(`[node] SHA-256 mismatch for ${file}: expected ${official}, got ${actual}`);
  }
}

export function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * 优先用 curl（macOS、Windows 10+、CI 镜像都自带，断了会自己重试）：本机实测 Node 的 fetch
 * 拉这 50MB 时中途断过（undici terminated / ETIMEDOUT）。没有 curl 再退回 fetch。
 */
async function defaultDownload(url, dest) {
  try {
    execFileSync("curl", ["-fsSL", "--retry", "3", "--connect-timeout", "30", "-o", dest, url], {
      stdio: "inherit",
    });
    return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!response.ok || !response.body) throw new Error(`[node] GET ${url}: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(dest));
}

async function defaultFetchText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`[node] GET ${url}: HTTP ${response.status}`);
  return response.text();
}

function defaultExtract(archive, dir) {
  // macOS / Windows 10+ 自带的 tar（bsdtar）都能解 .tar.gz 和 .zip。Windows 上点名 System32 里那个：
  // PATH 里可能先排着 Git 带的 GNU tar，它解不了 zip
  const systemTar =
    process.platform === "win32"
      ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
      : undefined;
  const tar = systemTar && existsSync(systemTar) ? systemTar : "tar";
  execFileSync(tar, ["-xf", archive, "-C", dir], { stdio: "inherit" });
}

/**
 * 只留跑 CLI 和 npm 要用的：node、npm、npx。头文件、man、文档、corepack 都不要（体积也小一截）。
 * Windows 的目录是平的（node.exe、npm.cmd、node_modules/npm），其余平台是 bin/、lib/node_modules/。
 */
export function pruneRuntime(dir, platform) {
  const drop =
    platform === "win32"
      ? [
          "corepack",
          "corepack.cmd",
          "install_tools.bat",
          "nodevars.bat",
          "node_etw_provider.man",
          "CHANGELOG.md",
          "README.md",
          "node_modules/corepack",
        ]
      : [
          "include",
          "share",
          "CHANGELOG.md",
          "README.md",
          "bin/corepack",
          "lib/node_modules/corepack",
        ];
  for (const item of drop) rmSync(path.join(dir, item), { recursive: true, force: true });
  if (platform !== "win32") replaceBinLinks(dir);
}

/**
 * 官方包里 bin/npm、bin/npx 是指向 ../lib/node_modules/npm/bin/*-cli.js 的软链。Electron 打包复制
 * extraResource 时会把它们改成指向构建目录的绝对路径，装到别的电脑上就断了，codesign 也会拒绝
 * （invalid destination for symbolic link in bundle）。换成同样效果的小脚本：用同目录的 node 跑 npm。
 */
function replaceBinLinks(dir) {
  for (const [name, cli] of [
    ["npm", "npm-cli.js"],
    ["npx", "npx-cli.js"],
  ]) {
    const file = path.join(dir, "bin", name);
    rmSync(file, { force: true });
    writeFileSync(
      file,
      `#!/bin/sh\n# SuperHive 自带 Node 的 ${name}：用同目录的 node 运行 npm 自带的 ${cli}\nbin=$(cd "$(dirname "$0")" && pwd)\nexec "$bin/node" "$bin/../lib/node_modules/npm/bin/${cli}" "$@"\n`,
      { mode: 0o755 },
    );
  }
}

/** 运行时里 node 本体的位置 */
export function nodeBinary(dir, platform) {
  return platform === "win32" ? path.join(dir, "node.exe") : path.join(dir, "bin", "node");
}

/**
 * 保证 destDir 里是校验过的、指定版本的 Node。已经是这个版本就不动；缓存里的压缩包哈希对不上会重新下载。
 * 校验不过时抛错，destDir 保持原样（不会留下一份没校验过的运行时）。
 */
export async function ensureNodeRuntime({
  platform = process.platform,
  arch = process.arch,
  cacheDir,
  destDir,
  runtime = NODE_RUNTIME,
  download = defaultDownload,
  fetchText = defaultFetchText,
  extract = defaultExtract,
  log = (line) => console.log(line),
}) {
  const archive = nodeArchive(platform, arch, runtime.version);
  const stamp = `${runtime.version} ${archive.target}`;
  const stampFile = path.join(destDir, STAMP);
  if (
    existsSync(stampFile) &&
    readFileSync(stampFile, "utf8").trim() === stamp &&
    existsSync(nodeBinary(destDir, platform))
  ) {
    return { dir: destDir, version: runtime.version, cached: true };
  }
  const pinned = runtime.sha256[archive.target];
  if (!pinned)
    throw new Error(`[node] no pinned SHA-256 for ${archive.file}; add it to NODE_RUNTIME`);

  mkdirSync(cacheDir, { recursive: true });
  const shasums = await fetchText(`${DIST}/v${runtime.version}/SHASUMS256.txt`);
  const cached = path.join(cacheDir, archive.file);
  if (existsSync(cached) && sha256File(cached) !== pinned.toLowerCase()) rmSync(cached);
  if (!existsSync(cached)) {
    log(`[node] downloading ${archive.url}`);
    const partial = `${cached}.partial`;
    rmSync(partial, { force: true });
    // 网络偶尔中途断开（实测 undici 报 terminated / ETIMEDOUT）：最多试三次
    for (let attempt = 1; ; attempt += 1) {
      try {
        await download(archive.url, partial);
        break;
      } catch (error) {
        rmSync(partial, { force: true });
        if (attempt >= 3) throw error;
        log(`[node] download failed (${error.message ?? error}), retrying ${attempt + 1}/3`);
      }
    }
    renameSync(partial, cached);
  }
  try {
    verifyArchive({ file: archive.file, actual: sha256File(cached), pinned, shasums });
  } catch (error) {
    rmSync(cached, { force: true });
    throw error;
  }

  // 解压到缓存里单独的空目录，整理好再换到 destDir
  const work = path.join(cacheDir, `extract-${archive.base}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  extract(cached, work);
  const root = path.join(work, archive.base);
  if (!existsSync(nodeBinary(root, platform))) {
    const found = readdirSync(work).join(", ");
    rmSync(work, { recursive: true, force: true });
    throw new Error(`[node] ${archive.file} did not contain ${archive.base}/ (found: ${found})`);
  }
  pruneRuntime(root, platform);
  writeFileSync(path.join(root, STAMP), `${stamp}\n`);
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(path.dirname(destDir), { recursive: true });
  renameSync(root, destDir);
  rmSync(work, { recursive: true, force: true });
  log(`[node] ready: ${destDir} (Node ${runtime.version} ${archive.target})`);
  return { dir: destDir, version: runtime.version, cached: false };
}
