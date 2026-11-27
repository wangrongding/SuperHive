import { userFs } from "./user-fs.js";
import path from "node:path";

const { existsSync, readFileSync, statSync } = userFs;

/**
 * 目录所在 git 仓库的当前分支（直接读 .git/HEAD，不起 git 进程）。
 * 支持 worktree / submodule 的 `.git` 文件；分离 HEAD 时返回短提交号；不在仓库里返回 undefined。
 */
export function gitBranch(dir: string): string | undefined {
  let current = path.resolve(dir);
  for (;;) {
    const dotGit = path.join(current, ".git");
    if (existsSync(dotGit)) return headOf(dotGit, current);
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function headOf(dotGit: string, root: string): string | undefined {
  try {
    let gitDir = dotGit;
    if (statSync(dotGit).isFile()) {
      const pointer = readFileSync(dotGit, "utf8")
        .match(/^gitdir:\s*(.+)$/m)?.[1]
        ?.trim();
      if (!pointer) return undefined;
      gitDir = path.resolve(root, pointer);
    }
    const head = readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
    const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/)?.[1];
    if (ref) return ref;
    return /^[0-9a-f]{7,}$/i.test(head) ? head.slice(0, 7) : undefined;
  } catch {
    return undefined;
  }
}
