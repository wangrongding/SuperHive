import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { AgentAccessMode } from "./responder.js";

export type RoomWorkspace = {
  /** 这个房间里实际使用的工作目录 */
  cwd: string;
  /** 房间设了工作区但没有采用时的原因；写进 Agent 规则，Agent 被问起时能如实说明 */
  note?: string;
};

function expandHome(input: string): string {
  // Windows 上也认 ~\
  return input === "~" || /^~[\\/]/.test(input) ? path.join(homedir(), input.slice(1)) : input;
}

function realDirectory(input: string): string | undefined {
  try {
    const resolved = realpathSync(expandHome(input));
    return statSync(resolved).isDirectory() ? resolved : undefined;
  } catch {
    return undefined;
  }
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Agent 允许跟随房间切换到的根目录：启动目录、它的上一级（常见的「代码目录」，比如 ~/Coding），
 * 以及 --allow-root 显式追加的目录。上一级是家目录或文件系统根时不算，避免整个家目录被房间设置打开。
 */
export function allowedWorkspaceRoots(defaultCwd: string, extra: string[] = []): string[] {
  const roots = new Set<string>();
  const base = realDirectory(defaultCwd) ?? path.resolve(defaultCwd);
  roots.add(base);
  const parent = path.dirname(base);
  const home = realDirectory(homedir()) ?? homedir();
  if (parent !== base && parent !== home && path.parse(parent).root !== parent) roots.add(parent);
  for (const item of extra) {
    const resolved = realDirectory(item);
    if (resolved && path.parse(resolved).root !== resolved) roots.add(resolved);
  }
  return [...roots];
}

/**
 * 决定 Agent 在某个房间里的工作目录。房间工作区按 Agent 所在的这台电脑解析：
 * 只读档不跟随（它不读写本机文件）；目录不存在（比如 Agent 在别的电脑上）或不在允许的根目录内时，
 * 留在 Agent 自己的目录并说明原因，不会因为房间设置扩大可访问的范围。
 */
export function resolveRoomWorkspace(input: {
  roomWorkspace: string | undefined;
  defaultCwd: string;
  allowedRoots: string[];
  access: AgentAccessMode;
}): RoomWorkspace {
  const { roomWorkspace, defaultCwd } = input;
  if (!roomWorkspace) return { cwd: defaultCwd };
  if (input.access === "read-only") {
    return {
      cwd: defaultCwd,
      note: `房间设置的工作区是 ${roomWorkspace}，你是只读权限，不读写本机文件，仍在 ${defaultCwd}。`,
    };
  }
  const resolved = realDirectory(roomWorkspace);
  if (!resolved || !existsSync(resolved)) {
    return {
      cwd: defaultCwd,
      note: `房间设置的工作区 ${roomWorkspace} 在你所在的电脑上不存在，仍在 ${defaultCwd} 工作。`,
    };
  }
  if (!input.allowedRoots.some((root) => isInside(root, resolved))) {
    return {
      cwd: defaultCwd,
      note: `房间设置的工作区 ${roomWorkspace} 不在你允许的目录范围内（${input.allowedRoots.join("、")}），仍在 ${defaultCwd} 工作；需要的话请本机所有者用 --allow-root 加上它。`,
    };
  }
  return { cwd: resolved };
}
