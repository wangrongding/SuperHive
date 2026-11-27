import { serverText } from "@superhive/protocol";
import { userFs } from "./user-fs.js";
import { homedir } from "node:os";
import path from "node:path";
import type { LocalDirectoryListing } from "@superhive/protocol";
import { HiveError } from "./database.js";

const { readdirSync, realpathSync, statSync } = userFs;

/**
 * 本机目录浏览：浏览器的文件选择器拿不到真实路径（File System Access API 只给目录名），
 * 所以"点击选择工作目录"由本机 Server 列目录，前端只负责展示。
 * 仅对通过本机校验和房主凭证的请求开放（见 local-routes.ts）。
 */

/** 单次最多返回的子目录数量，避免 node_modules 这类巨大目录拖垮响应 */
const MAX_ENTRIES = 500;

/** 把 ~ 或 ~/foo 展开成绝对路径，方便手输 */
export function expandHome(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "~") return homedir();
  // Windows 上也认 ~\
  if (/^~[\\/]/.test(trimmed)) return path.join(homedir(), trimmed.slice(2));
  return trimmed;
}

/**
 * 是不是桌面端的安装目录（或在它里面）。这种目录不能拿来当工作目录：
 * - Windows（Squirrel）：%LOCALAPPDATA%\SuperHive\app-<版本>，每次升级换一个新目录，旧的过一两个版本被删掉；
 * - Mac：*.app/Contents/...，应用包里的东西，升级时整个替换。
 * 只看路径形状，不看目录在不在：升级后旧版本目录已经没了也要认得出来。
 */
export function isDesktopInstallDirectory(target: string): boolean {
  const segments = target.split(/[\\/]+/).filter(Boolean);
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index]!;
    const next = segments[index + 1]!;
    if (/\.app$/i.test(segment) && next.toLowerCase() === "contents") return true;
    if (segment.toLowerCase() === "superhive" && /^app-\d/i.test(next)) return true;
  }
  return false;
}

/** 当不了默认工作目录的：文件系统根（Mac 上双击打开的 .app，cwd 就是 /）和桌面端安装目录 */
export function isUnfitWorkingDirectory(target: string): boolean {
  return path.parse(target).root === target || isDesktopInstallDirectory(target);
}

/**
 * 启动 Hive 服务时所在的目录：工作目录的默认值。
 * 开发模式下 pnpm 会把 cwd 设到 apps/server，由 index.ts 用 HIVE_LAUNCH_DIR 指回仓库根目录；
 * 桌面端把 HIVE_LAUNCH_DIR 设成主目录。万一还是落在根目录或安装目录（老桌面端、被别的程序拉起），退回主目录。
 */
export function launchDirectory(): string {
  const launch = realpathSyncSafe(process.env.HIVE_LAUNCH_DIR?.trim() || process.cwd());
  return isUnfitWorkingDirectory(launch) ? homeDirectory() : launch;
}

/** 主目录（解析软链后的真实路径） */
export function homeDirectory(): string {
  return realpathSyncSafe(homedir());
}

export function listDirectories(target?: string): LocalDirectoryListing {
  const launch = launchDirectory();
  const requested = target?.trim() ? expandHome(target) : launch;
  if (!path.isAbsolute(requested)) {
    throw new HiveError("LOCAL_DIRECTORY_INVALID", serverText("error.directory.absolute"));
  }
  let resolved: string;
  try {
    resolved = realpathSync(requested);
    if (!statSync(resolved).isDirectory()) {
      throw new HiveError(
        "LOCAL_DIRECTORY_INVALID",
        serverText("error.directory.notDirectory", { path: requested }),
      );
    }
  } catch (error) {
    if (error instanceof HiveError) throw error;
    throw new HiveError(
      "LOCAL_DIRECTORY_NOT_FOUND",
      serverText("error.directory.missing", { path: requested }),
    );
  }

  let entries: LocalDirectoryListing["entries"] = [];
  let truncated = false;
  try {
    const children = readdirSync(resolved, { withFileTypes: true })
      // 隐藏目录（.git、.cache 等）不列出；需要时仍可手输完整路径
      .filter((entry) => !entry.name.startsWith(".") && isDirectoryEntry(resolved, entry))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
    truncated = children.length > MAX_ENTRIES;
    entries = children
      .slice(0, MAX_ENTRIES)
      .map((name) => ({ name, path: path.join(resolved, name) }));
  } catch {
    // 没有读取权限：仍然返回当前目录本身，让调用方可以选中它或往上走
    truncated = false;
  }

  const parent = path.dirname(resolved);
  return {
    path: resolved,
    parent: parent === resolved ? null : parent,
    entries,
    truncated,
    defaults: { launch, home: homeDirectory() },
  };
}

function isDirectoryEntry(
  parent: string,
  entry: { name: string; isDirectory(): boolean; isSymbolicLink(): boolean },
): boolean {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return statSync(path.join(parent, entry.name)).isDirectory();
  } catch {
    return false;
  }
}

function realpathSyncSafe(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return target;
  }
}
