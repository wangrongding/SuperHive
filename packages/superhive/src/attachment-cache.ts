import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { MAX_ATTACHMENT_BYTES, type Attachment } from "./hive-protocol.js";

export type AttachmentLocation = { path: string } | { error: string };

/** 缓存目录里的文件名：只保留安全字符，保留扩展名，便于读文件工具按类型打开 */
function cacheFileName(attachment: Attachment): string {
  const ext = path.extname(attachment.name).toLowerCase();
  const base = path
    .basename(attachment.name, ext)
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .replace(/^[._]+/, "")
    .slice(0, 80);
  const safeExt = /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : "";
  return `${base || "attachment"}${safeExt}`;
}

/**
 * 给 Agent 准备附件的本地路径。
 * - 与 Server 同机的房主 Agent：直接用 Server 存的那份（/local-path），不复制第二份；
 * - 其他情况（远程 Bridge、访客的 Agent）：凭 Bearer 下载到本机受控缓存，按 SHA-256 校验后再交出路径。
 * 只缓存同一内容一次；下载失败只影响这一个附件，Agent 仍可改用 hive_attachment_read。
 */
export class AttachmentCache {
  private readonly inflight = new Map<string, Promise<AttachmentLocation>>();

  constructor(
    private readonly options: {
      serverUrl: string;
      token: string;
      dir: string;
      fetch?: typeof fetch;
    },
  ) {}

  locate(attachment: Attachment): Promise<AttachmentLocation> {
    const pending = this.inflight.get(attachment.id);
    if (pending) return pending;
    const task = this.resolve(attachment).finally(() => this.inflight.delete(attachment.id));
    this.inflight.set(attachment.id, task);
    return task;
  }

  private get fetcher(): typeof fetch {
    return this.options.fetch ?? fetch;
  }

  private headers() {
    return { Authorization: `Bearer ${this.options.token}` };
  }

  private async resolve(attachment: Attachment): Promise<AttachmentLocation> {
    try {
      const local = await this.serverLocalPath(attachment);
      if (local) return { path: local };
      return { path: await this.download(attachment) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async serverLocalPath(attachment: Attachment): Promise<string | undefined> {
    const response = await this.fetcher(
      new URL(`/api/attachments/${attachment.id}/local-path`, this.options.serverUrl),
      { headers: this.headers() },
    ).catch(() => undefined);
    if (!response?.ok) return undefined;
    const body = (await response.json().catch(() => undefined)) as
      { path?: unknown; sha256?: unknown } | undefined;
    // 同机才看得见这个路径；经端口转发等方式连接时文件不在这台电脑上，改为下载
    if (typeof body?.path !== "string" || body.sha256 !== attachment.sha256) return undefined;
    if (!existsSync(body.path) || statSync(body.path).size !== attachment.size) return undefined;
    return body.path;
  }

  private async download(attachment: Attachment): Promise<string> {
    const dir = path.join(this.options.dir, attachment.sha256);
    const target = path.join(dir, cacheFileName(attachment));
    if (existsSync(target) && statSync(target).size === attachment.size) return target;
    const response = await this.fetcher(
      new URL(`/api/attachments/${attachment.id}`, this.options.serverUrl),
      { headers: this.headers() },
    );
    if (!response.ok || !response.body) {
      throw new Error(`无法下载附件 ${attachment.name}（${response.status}）`);
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, `.${randomUUID()}.part`);
    const hash = createHash("sha256");
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > MAX_ATTACHMENT_BYTES) {
          callback(new Error("附件超过大小上限"));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
        meter,
        createWriteStream(tmp, { mode: 0o600 }),
      );
      if (hash.digest("hex") !== attachment.sha256) {
        throw new Error(`附件 ${attachment.name} 校验失败，已丢弃`);
      }
      renameSync(tmp, target);
      return target;
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
  }
}
