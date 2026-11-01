import { readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { LocalDirectoryListing } from "@superhive/protocol";
import { HiveError } from "./database.js";

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
 * 启动 Hive 服务时所在的目录：工作目录的默认值。
 * 开发模式下 pnpm 会把 cwd 设到 apps/server，由 index.ts 用 HIVE_LAUNCH_DIR 指回仓库根目录。
 */
export function launchDirectory(): string {
  const launch = process.env.HIVE_LAUNCH_DIR?.trim() || process.cwd();
  return realpathSyncSafe(launch);
}

export function listDirectories(target?: string): LocalDirectoryListing {
  const launch = launchDirectory();
  const requested = target?.trim() ? expandHome(target) : launch;
  if (!path.isAbsolute(requested)) {
    throw new HiveError("LOCAL_DIRECTORY_INVALID", "目录需要是绝对路径。");
  }
  let resolved: string;
  try {
    resolved = realpathSync(requested);
    if (!statSync(resolved).isDirectory()) {
      throw new HiveError("LOCAL_DIRECTORY_INVALID", `${requested} 不是目录。`);
    }
  } catch (error) {
    if (error instanceof HiveError) throw error;
    throw new HiveError("LOCAL_DIRECTORY_NOT_FOUND", `找不到目录 ${requested}。`);
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
    defaults: { launch, home: realpathSyncSafe(homedir()) },
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
