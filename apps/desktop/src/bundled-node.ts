import { existsSync } from "node:fs";
import path from "node:path";

/**
 * 桌面端自带的 Node 运行时（打包时放进 resources/node，见 scripts/node-runtime.mjs）怎么交给 Agent：
 *
 * - SUPERHIVE_BUNDLED_NODE：node 本体的绝对路径。Windows 上解析 npm 的 .cmd 垫片时，
 *   垫片旁边没有 node.exe 就用它，再不行才找 PATH（windows-command.ts）。
 * - SUPERHIVE_AGENT_CLIS_DIR：一键安装 CLI 用自带 npm 时的全局前缀（<userData>/agent-clis），
 *   不需要管理员权限，也不往系统目录里装东西。
 * - PATH：把 agent-clis 的命令目录和自带 Node 所在目录追加到**末尾**——用户自己装的 node / CLI 排在前面，
 *   照样优先；没装的时候 `#!/usr/bin/env node` 脚本也能找到 node。
 *
 * 只交给 Server（再由它传给本机 Agent），不改桌面端自己、内置终端和系统的环境变量。
 */

export type BundledRuntime = {
  /** node 本体；运行时目录缺了（开发时跳过了下载）为 undefined */
  node: string | undefined;
  agentClisDir: string;
};

export function bundledNodeBinary(dir: string, platform: NodeJS.Platform): string {
  return platform === "win32"
    ? path.win32.join(dir, "node.exe")
    : path.posix.join(dir, "bin", "node");
}

/** npm 全局前缀放命令的目录：Windows 直接放在前缀里，其余平台在 bin/ */
export function agentClisBin(prefix: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? prefix : path.posix.join(prefix, "bin");
}

/**
 * 运行时目录：打包后在 resources/node；开发时 scripts/stage.mjs 放在 .stage/node（应用目录 .stage/app 的旁边）
 */
export function bundledRuntime(options: {
  isPackaged: boolean;
  resourcesPath: string;
  appRoot: string;
  userData: string;
  platform: NodeJS.Platform;
  exists?: (file: string) => boolean;
}): BundledRuntime {
  const exists = options.exists ?? existsSync;
  const dir = options.isPackaged
    ? path.join(options.resourcesPath, "node")
    : path.join(options.appRoot, "..", "node");
  const node = bundledNodeBinary(dir, options.platform);
  return {
    node: exists(node) ? node : undefined,
    agentClisDir: path.join(options.userData, "agent-clis"),
  };
}

/** 往 PATH 末尾追加目录（已经有的不再加，Windows 上不分大小写） */
export function appendPath(current: string, dirs: string[], platform: NodeJS.Platform): string {
  const delimiter = platform === "win32" ? ";" : ":";
  const norm = (dir: string) =>
    platform === "win32" ? dir.toLowerCase().replace(/\\+$/, "") : dir;
  const parts = current.split(delimiter).filter(Boolean);
  const seen = new Set(parts.map(norm));
  for (const dir of dirs) {
    if (!dir || seen.has(norm(dir))) continue;
    seen.add(norm(dir));
    parts.push(dir);
  }
  return parts.join(delimiter);
}

/**
 * 给 Server 的环境变量补丁。Windows 的环境变量名不分大小写，PATH 常写作 Path：沿用已有的那个键，
 * 不然子进程里会同时出现 Path 和 PATH，谁生效说不准。
 */
export function bundledRuntimeEnv(
  runtime: BundledRuntime,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Record<string, string> {
  const pathKey =
    platform === "win32"
      ? (Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "Path")
      : "PATH";
  const dirs = [agentClisBin(runtime.agentClisDir, platform)];
  if (runtime.node)
    dirs.push((platform === "win32" ? path.win32 : path.posix).dirname(runtime.node));
  return {
    SUPERHIVE_AGENT_CLIS_DIR: runtime.agentClisDir,
    ...(runtime.node ? { SUPERHIVE_BUNDLED_NODE: runtime.node } : {}),
    [pathKey]: appendPath(env[pathKey] ?? "", dirs, platform),
  };
}
