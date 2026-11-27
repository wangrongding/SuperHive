import { userFs } from "./user-fs.js";
import { homedir } from "node:os";
import nodePath from "node:path";
import type { AgentAccessMode } from "./responder.js";

const { realpathSync, statSync } = userFs;

export type RoomWorkspace = {
  /** 这个房间里实际使用的工作目录 */
  cwd: string;
  /** 房间设了工作区但没有采用时的原因；写进 Agent 规则，Agent 被问起时能如实说明 */
  note?: string;
};

/** 路径与文件系统操作：默认用本机的；测试里换成 path.win32 和假的文件系统，覆盖 Windows 路径 */
export type WorkspaceFs = {
  path: Pick<
    nodePath.PlatformPath,
    "join" | "relative" | "isAbsolute" | "parse" | "dirname" | "resolve"
  >;
  /** 解析符号链接后的真实路径；不存在时抛错 */
  realpath: (input: string) => string;
  isDirectory: (input: string) => boolean;
  home: string;
};

const localFs: WorkspaceFs = {
  path: nodePath,
  realpath: (input) => realpathSync(input),
  isDirectory: (input) => statSync(input).isDirectory(),
  home: homedir(),
};

function expandHome(input: string, fs: WorkspaceFs): string {
  // Windows 上也认 ~\
  return input === "~" || /^~[\\/]/.test(input) ? fs.path.join(fs.home, input.slice(1)) : input;
}

function realDirectory(input: string, fs: WorkspaceFs): string | undefined {
  try {
    // 先 resolve：Windows 上把正斜杠、结尾的分隔符统一掉
    const resolved = fs.realpath(fs.path.resolve(expandHome(input, fs)));
    return fs.isDirectory(resolved) ? resolved : undefined;
  } catch {
    return undefined;
  }
}

function isInside(root: string, target: string, fs: WorkspaceFs): boolean {
  // path.win32.relative 不分大小写：C:\Code 与 c:\code\proj 视为在里面
  const relative = fs.path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !fs.path.isAbsolute(relative));
}

function isFilesystemRoot(input: string, fs: WorkspaceFs): boolean {
  return fs.path.parse(input).root.toLowerCase() === input.toLowerCase();
}

/**
 * Agent 允许跟随房间切换到的根目录：启动目录、它的上一级（常见的「代码目录」，比如 ~/Coding），
 * 以及 --allow-root 显式追加的目录。上一级是家目录或文件系统根时不算，避免整个家目录被房间设置打开。
 */
export function allowedWorkspaceRoots(
  defaultCwd: string,
  extra: string[] = [],
  fs: WorkspaceFs = localFs,
): string[] {
  const roots = new Set<string>();
  const base = realDirectory(defaultCwd, fs) ?? fs.path.resolve(defaultCwd);
  roots.add(base);
  const parent = fs.path.dirname(base);
  const home = realDirectory(fs.home, fs) ?? fs.home;
  if (parent !== base && parent !== home && !isFilesystemRoot(parent, fs)) roots.add(parent);
  for (const item of extra) {
    const resolved = realDirectory(item, fs);
    if (resolved && !isFilesystemRoot(resolved, fs)) roots.add(resolved);
  }
  return [...roots];
}

/**
 * 决定 Agent 在某个房间里的工作目录。房间工作区按 Agent 所在的这台电脑解析：
 * 目录不存在（比如 Agent 在别的电脑上）或不在允许的根目录内时，留在 Agent 自己的目录并说明原因，
 * 不会因为房间设置扩大可访问的范围。
 *
 * 只读档同样跟随：它能读文件（Claude 的 plan、Codex 的 read-only 沙箱、Copilot 的 plan 等都能读），
 * 不跟随的话「读一下代码」就会去读它自己的启动目录。写操作由各 Provider 的只读档拦住，与目录无关；
 * 只有 Hive 管不了只读的 Provider（readOnlyEnforced=false，目前是 OpenClaw）才不跟随。
 */
export function resolveRoomWorkspace(
  input: {
    roomWorkspace: string | undefined;
    defaultCwd: string;
    allowedRoots: string[];
    access: AgentAccessMode;
    /**
     * 由本机 Hive Server 拉起的 Agent：房间工作区只有房主能设，房主设了就是授权，
     * 不再受启动目录及其上一级的限制（仍要求目录存在、不是文件系统根）
     */
    trusted?: boolean;
    /** 这个 Provider 的只读档确实写不了文件；默认是 */
    readOnlyEnforced?: boolean;
    /** 默认目录是 Agent 专属的空目录（只读档没给 --cwd）：说明里点明，免得模型以为项目在那里 */
    scratchDefault?: boolean;
  },
  fs: WorkspaceFs = localFs,
): RoomWorkspace {
  const { roomWorkspace, defaultCwd } = input;
  if (!roomWorkspace) return { cwd: defaultCwd };
  const stay = input.scratchDefault
    ? `仍在 ${defaultCwd}（这是你专属的空目录，里面没有项目文件，不要在这里找代码）`
    : `仍在 ${defaultCwd}`;
  if (input.access === "read-only" && input.readOnlyEnforced === false) {
    return {
      cwd: defaultCwd,
      note: `房间设置的工作区是 ${roomWorkspace}，但你用的运行时没法限制为只读，所以没有切过去，${stay}。`,
    };
  }
  const resolved = realDirectory(roomWorkspace, fs);
  if (!resolved) {
    return {
      cwd: defaultCwd,
      note: `房间设置的工作区 ${roomWorkspace} 在你所在的电脑上不存在，${stay}。`,
    };
  }
  if (isFilesystemRoot(resolved, fs)) {
    return {
      cwd: defaultCwd,
      note: `房间设置的工作区 ${roomWorkspace} 是文件系统根目录，不能作为工作目录，${stay}。`,
    };
  }
  if (input.trusted) return { cwd: resolved };
  if (!input.allowedRoots.some((root) => isInside(root, resolved, fs))) {
    return {
      cwd: defaultCwd,
      note: `房间设置的工作区 ${roomWorkspace} 不在你允许的目录范围内（${input.allowedRoots.join("、")}），${stay}；需要的话请本机所有者用 --allow-root 加上它。`,
    };
  }
  return { cwd: resolved };
}
