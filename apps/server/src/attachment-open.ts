import { createHash, randomBytes } from "node:crypto";
import { userFs, userFsPromises } from "./user-fs.js";
import path from "node:path";
import { sanitizeFileName } from "./attachment-store.js";

const { createReadStream } = userFs;
const { constants, copyFile, link, lstat, mkdir, rm } = userFsPromises;

/** 磁盘上的文件名：在附件名清理的基础上，再去掉 Windows 不允许的字符 */
function diskName(name: string): string {
  return sanitizeFileName(sanitizeFileName(name).replace(/[<>:"|?*]/g, "_"));
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * 附件按 sha256 存，文件名是一串哈希。打开或在访达里显示前，先在 <filesDir>/<roomId>/ 下放一份原文件名的副本：
 * - 已有同名且内容相同（大小 + sha256）的直接复用；同名但内容不同（别的附件，或者用户改过这份副本）就加「 (2)」这类后缀；
 * - 用写时复制（APFS 等支持时不占额外空间），不支持时退回普通复制。不用硬链接：
 *   有些应用原地保存，硬链接会把改动写回附件库，同一份内容的其他附件也跟着变；
 * - 先复制到临时名再 link 到目标名，目标已存在时 link 失败，并发点两下也不会互相覆盖或读到写了一半的文件。
 */
export async function placeNamedCopy(
  filesDir: string,
  roomId: string,
  item: { name: string; filePath: string; size: number; sha256: string },
): Promise<string> {
  const dir = path.join(filesDir, diskName(roomId));
  await mkdir(dir, { recursive: true });
  const name = diskName(item.name);
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length) || name;
  let temp: string | undefined;
  try {
    for (let n = 1; n <= 1000; n++) {
      const target = path.join(dir, n === 1 ? name : `${stem} (${n})${ext}`);
      const stat = await lstat(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (stat) {
        if (stat.isFile() && stat.size === item.size && (await sha256Of(target)) === item.sha256)
          return target;
        continue;
      }
      if (!temp) {
        temp = path.join(dir, `.${randomBytes(8).toString("hex")}.tmp`);
        await copyFile(item.filePath, temp, constants.COPYFILE_FICLONE);
      }
      try {
        // 不支持硬链接的盘（exFAT 等）退回不覆盖的复制
        await link(temp, target).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "EEXIST") throw error;
          return copyFile(temp!, target, constants.COPYFILE_EXCL);
        });
        return target;
      } catch (error) {
        // 刚被别的请求抢先放了同名文件：回到循环再比一次内容
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          n--;
          continue;
        }
        throw error;
      }
    }
    throw new Error("Too many files with the same name");
  } finally {
    if (temp) await rm(temp, { force: true });
  }
}
