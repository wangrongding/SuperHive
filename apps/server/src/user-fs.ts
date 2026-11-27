import * as nodeFs from "node:fs";
import { createRequire } from "node:module";

type Fs = typeof nodeFs;

/**
 * 读写「用户的文件」（工作区、浏览的目录、worktree、附件）统一从这里拿 fs。
 *
 * 桌面端的 Server / CLI 是从 app.asar 里由 Electron 加载的，Electron 的 asar 补丁对它们生效：
 * 普通 fs 碰到路径里的 `*.asar` 会把它当成目录、打开后一直占着，用户在 Windows 上删不掉也
 * 覆盖不了，直到客户端退出（Orca #10063 同类）。Electron 下改用 original-fs（不带 asar 补丁），
 * 其它情况就是 node:fs。
 *
 * Server 自己的资源（app.asar 里的代码、网页构建产物）必须继续用 node:fs，不要从这里拿。
 */
export function pickUserFs(
  versions: NodeJS.ProcessVersions = process.versions,
  load: (id: string) => unknown = createRequire(import.meta.url),
): Fs {
  if (!versions.electron) return nodeFs;
  try {
    return load("original-fs") as Fs;
  } catch {
    return nodeFs;
  }
}

export const userFs: Fs = pickUserFs();
export const userFsPromises: Fs["promises"] = userFs.promises;
