import { existsSync, renameSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** 改名前的数据目录名，只用于下面的一次性迁移 */
const LEGACY_HOME_NAME = ".ai-hive";

/**
 * 默认数据根目录 ~/.superhive（Server 数据、日志与 Agent 状态都在其下）。
 * 旧目录存在而新目录不存在时原地改名迁移，并在旧位置留一个指向新目录的链接，
 * 让迁移时还在运行的旧版进程继续读写；改名失败就沿用旧目录，不丢数据。
 */
export function superhiveHome(home = homedir()): string {
  const current = path.join(home, ".superhive");
  const legacy = path.join(home, LEGACY_HOME_NAME);
  if (existsSync(current) || !existsSync(legacy)) return current;
  try {
    renameSync(legacy, current);
  } catch {
    return legacy;
  }
  try {
    symlinkSync(current, legacy, "junction");
  } catch {
    // 链接只是给旧进程的过渡，建不了不影响新版本
  }
  return current;
}
