import { readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * 与 packages/superhive/src/windows-command.ts 相同（两个包分别发布，各带一份）。
 * Windows 上把命令名解析成可以直接 spawn 的程序。
 *
 * npm 全局安装的 CLI（claude、codex、copilot…）在 Windows 上是 .cmd 垫片：Node 不能不经 shell
 * 直接运行 .cmd（找不到就报 ENOENT，指名 .cmd 则报 EINVAL）。而经 cmd.exe 运行又会改写参数里的
 * 引号、& % ! 等字符，换行之后的内容会被直接截掉——Agent 的系统提示正好是多行文本。
 * 所以这里读出垫片真正要运行的目标：.exe 直接运行；.js 用 node 运行。都不经过 cmd.exe。
 */

export type ResolvedCommand = { command: string; args: string[] };

type Env = Record<string, string | undefined>;

export type ResolveOptions = {
  platform?: NodeJS.Platform;
  env?: Env;
  /** 运行 .js 目标时用的 node；垫片旁边有 node.exe 时优先用那个 */
  nodePath?: string;
  /** 桌面端自带的 node.exe；默认读环境变量 SUPERHIVE_BUNDLED_NODE（桌面端启动 Server 时设置） */
  bundledNode?: string;
  isElectron?: boolean;
  /** 测试注入 */
  isFile?: (file: string) => boolean;
  readFile?: (file: string) => string;
};

/** 垫片里最后一个 "%dp0%\..." 路径就是要运行的目标（npm cmd-shim 与 pnpm 生成的格式都是这样） */
const SHIM_TARGET = /"%~?dp0%?\\([^"]+)"/gi;

function envValue(env: Env, name: string): string | undefined {
  const key = Object.keys(env).find((item) => item.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

function defaultIsFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** 按 PATH 与 PATHEXT 找到命令对应的文件；已经带路径或扩展名的也按原样检查 */
export function findWindowsCommand(
  command: string,
  env: Env,
  isFile: (file: string) => boolean = defaultIsFile,
): string | undefined {
  const extensions = (envValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean)
    .map((item) => item.toLowerCase());
  const hasExtension = path.win32.extname(command) !== "";
  const candidates = (base: string) =>
    hasExtension
      ? [base, ...extensions.map((ext) => base + ext)]
      : extensions.map((ext) => base + ext);
  if (/[\\/]/.test(command) || path.win32.isAbsolute(command)) {
    return candidates(command).find(isFile);
  }
  const dirs = (envValue(env, "PATH") ?? "").split(";").filter(Boolean);
  for (const dir of dirs) {
    const found = candidates(path.win32.join(dir.replace(/^"|"$/g, ""), command)).find(isFile);
    if (found) return found;
  }
  return undefined;
}

export function resolveCommand(command: string, options: ResolveOptions = {}): ResolvedCommand {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return { command, args: [] };
  const env = options.env ?? process.env;
  const isFile = options.isFile ?? defaultIsFile;
  const found = findWindowsCommand(command, env, isFile);
  if (!found) return { command, args: [] };
  const ext = path.win32.extname(found).toLowerCase();
  if (ext !== ".cmd" && ext !== ".bat") return { command: found, args: [] };

  const shimDir = path.win32.dirname(found);
  let text: string;
  try {
    text = (options.readFile ?? ((file) => readFileSync(file, "utf8")))(found);
  } catch {
    text = "";
  }
  const target = [...text.matchAll(SHIM_TARGET)].at(-1)?.[1];
  if (!target) {
    throw new Error(
      `${found} 不是可识别的 npm 启动脚本，无法安全地直接运行；请改用对应的 .exe，或用 --${path.win32.basename(found, ext)} 指定程序路径。`,
    );
  }
  const resolved = path.win32.join(shimDir, target);
  if (/\.(c|m)?js$/i.test(resolved)) {
    return { command: nodeFor(found, shimDir, env, isFile, options), args: [resolved] };
  }
  return { command: resolved, args: [] };
}

/** 环境变量 SUPERHIVE_BUNDLED_NODE：桌面端自带的 Node（打包进 resources/node） */
export const BUNDLED_NODE_ENV = "SUPERHIVE_BUNDLED_NODE";

/**
 * 运行 npm 垫片背后的 .js 用哪个 node，按顺序：
 * ① 垫片旁边的 node.exe（和这个 CLI 一起装的那份）；② 调用方指定的；③ 桌面端自带的；
 * ④ 不在桌面端里时用当前进程的 node；在桌面端里 process.execPath 是 Electron 本身（RunAsNode 已关，不能跑 JS），
 *    只能去 PATH 找真的 node.exe；⑤ 都没有就报错。
 */
function nodeFor(
  found: string,
  shimDir: string,
  env: Env,
  isFile: (file: string) => boolean,
  options: ResolveOptions,
): string {
  const localNode = path.win32.join(shimDir, "node.exe");
  if (isFile(localNode)) return localNode;
  if (options.nodePath) return options.nodePath;
  const bundled = options.bundledNode ?? envValue(env, BUNDLED_NODE_ENV);
  if (bundled && isFile(bundled)) return bundled;
  const isElectron = options.isElectron ?? Boolean(process.versions.electron);
  if (!isElectron) return process.execPath;
  const onPath = findWindowsCommand(
    "node.exe",
    env,
    (file) => path.win32.extname(file).toLowerCase() === ".exe" && isFile(file),
  );
  if (onPath) return onPath;
  if (bundled) {
    throw new Error(
      `运行 ${found} 需要 Node.js，但桌面端自带的 Node.js 不见了（${bundled}），PATH 里也没有 node.exe；请重新安装 SuperHive 桌面端。`,
    );
  }
  throw new Error(
    `运行 ${found} 需要 Node.js，但没有在启动器目录或 PATH 中找到 node.exe；请安装 Node.js 并重新打开桌面端，或改用该 CLI 的原生 .exe。`,
  );
}

/** spawn 前统一调用：Windows 上换成真正的程序，其他平台原样返回 */
export function commandFor(command: string, args: string[]): ResolvedCommand {
  const resolved = resolveCommand(command);
  return { command: resolved.command, args: [...resolved.args, ...args] };
}

/** Windows 单条命令行（CreateProcess）上限 32767 字符，超出时直接报错，不让进程启动失败得莫名其妙 */
export const WINDOWS_COMMAND_LINE_LIMIT = 32_767;

export function windowsCommandLineLength(command: string, args: string[]): number {
  // 每个参数按最坏情况加上引号与转义的开销估算
  return [command, ...args].reduce(
    (total, item) => total + item.length + (item.match(/["\\]/g)?.length ?? 0) + 3,
    0,
  );
}

export function assertWindowsCommandLine(command: string, args: string[], label: string): void {
  if (process.platform !== "win32") return;
  const length = windowsCommandLineLength(command, args);
  if (length > WINDOWS_COMMAND_LINE_LIMIT) {
    throw new Error(
      `${label} 的启动参数约 ${length} 字符，超过 Windows 命令行上限 ${WINDOWS_COMMAND_LINE_LIMIT}，无法启动；请缩短上下文或开启新话题。`,
    );
  }
}
