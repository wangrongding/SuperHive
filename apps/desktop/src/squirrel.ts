/**
 * Windows 安装包（Squirrel.Windows）在安装、更新、卸载时会带着 `--squirrel-*` 参数把应用拉起一次，
 * 应用要在这时建 / 删开始菜单和桌面快捷方式然后马上退出，不能把整个界面和 Hive 起起来。
 * `--squirrel-firstrun` 是装完第一次正常打开，照常启动。
 *
 * 快捷方式交给安装目录上一级的 Update.exe 去建：`Update.exe --createShortcut=SuperHive.exe`。
 */
import path from "node:path";

export type SquirrelEvent = "install" | "updated" | "uninstall" | "obsolete";

/** 只看第一个参数：Squirrel 拉起时总是把事件放在 argv[1] */
export function squirrelEvent(argv: readonly string[]): SquirrelEvent | undefined {
  switch (argv[1]) {
    case "--squirrel-install":
      return "install";
    case "--squirrel-updated":
      return "updated";
    case "--squirrel-uninstall":
      return "uninstall";
    case "--squirrel-obsolete":
      return "obsolete";
    default:
      return undefined;
  }
}

/** 这次要让 Update.exe 做什么；obsolete（被新版本替换掉的旧版本）什么都不做直接退 */
export function updateExeArgs(event: SquirrelEvent, execPath: string): string[] | undefined {
  const exe = path.win32.basename(execPath);
  if (event === "install" || event === "updated") return [`--createShortcut=${exe}`];
  if (event === "uninstall") return [`--removeShortcut=${exe}`];
  return undefined;
}

export function updateExePath(execPath: string): string {
  return path.win32.resolve(path.win32.dirname(execPath), "..", "Update.exe");
}

export interface SquirrelDeps {
  platform: NodeJS.Platform;
  argv: readonly string[];
  execPath: string;
  /** 跑 Update.exe，结束（或失败）后回调 */
  run: (command: string, args: string[], done: () => void) => void;
  quit: () => void;
  /**
   * 卸载时先做的清理：正式包启动时把 superhive:// 登记到这个版本的 exe（HKCU\Software\Classes），
   * 卸载不删的话链接会指向已经删掉的程序。出错不影响卸载
   */
  onUninstall?: () => void;
}

/** 是 Squirrel 事件就处理掉并返回 true（调用方不要再启动应用），否则返回 false */
export function handleSquirrelEvent(deps: SquirrelDeps): boolean {
  if (deps.platform !== "win32") return false;
  const event = squirrelEvent(deps.argv);
  if (!event) return false;
  if (event === "uninstall") {
    try {
      deps.onUninstall?.();
    } catch {
      // 清理失败也照常删快捷方式、退出，不能挡住卸载
    }
  }
  const args = updateExeArgs(event, deps.execPath);
  if (!args) {
    deps.quit();
    return true;
  }
  let finished = false;
  deps.run(updateExePath(deps.execPath), args, () => {
    if (finished) return;
    finished = true;
    deps.quit();
  });
  return true;
}
