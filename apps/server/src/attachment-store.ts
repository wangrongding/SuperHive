import { serverText } from "@superhive/protocol";
import { createHash, randomUUID } from "node:crypto";
import { userFs } from "./user-fs.js";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import type Database from "better-sqlite3";
import {
  LIMITS,
  stripUnsafeCharacters,
  type Attachment,
  type AttachmentKind,
} from "@superhive/protocol";
import { HiveError } from "./database.js";

const { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync } = userFs;

/**
 * 附件存储：文件按 SHA-256 内容寻址落在 dir 下，数据库里每次上传一行引用。
 * - 上传者（uploader）：房主与本机 Agent 共用 "admin"，访客按会话区分；未随消息发出前只有上传者能读。
 * - 绑定到消息后按房间权限读；撤回消息时撤销引用，没有任何引用的文件由清理任务删除。
 * - 内容相同只共享磁盘文件，不共享授权：每次上传各有自己的 ID、房间与上传者。
 */

type AttachmentRow = {
  id: string;
  room_id: string;
  uploader: string;
  name: string;
  mime: string;
  kind: AttachmentKind;
  size: number;
  sha256: string;
  blob: string;
  width: number | null;
  height: number | null;
  created_at: string;
  expires_at: string;
  message_id: string | null;
  revoked_at: string | null;
};

export type StoredAttachment = Attachment & {
  roomId: string;
  uploader: string;
  messageId?: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  /** 文件在 Server 所在电脑上的绝对路径 */
  filePath: string;
};

/** 已随消息发出的附件，带上所属消息的发送者与时间 */
export type SentAttachment = Attachment & {
  messageId: string;
  messageSeq: number;
  senderId: string;
  senderName: string;
  senderType: "human" | "agent";
  createdAt: string;
};

export type AttachmentStoreOptions = {
  dir: string;
  roomQuotaBytes?: number;
  pendingQuotaBytes?: number;
  now?: () => number;
};

/** 撤回或清空后再保留一会儿，给正在下载的客户端留出余量 */
const REVOKED_GRACE_MS = 10 * 60_000;
/** 嗅探类型与读取图片尺寸用的文件头长度 */
const HEAD_BYTES = 64 * 1024;

const IMAGE_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

/** 能当文本读取的扩展名对应的展示类型；HTML、SVG 等一律按纯文本提供，不交给浏览器渲染 */
const TEXT_MIME: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  json: "application/json",
  csv: "text/csv",
};

/** 去掉目录、控制字符与首尾的点和空白；超长时保留扩展名 */
export function sanitizeFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  let name = stripUnsafeCharacters(base).replace(/[\u0000-\u001f\u007f]/g, "");
  name = name.replace(/^[\s.]+|[\s.]+$/g, "");
  if (!name) return "attachment";
  const max = LIMITS.maxAttachmentNameLength;
  if (name.length <= max) return name;
  const ext = path.extname(name).slice(0, 20);
  return name.slice(0, max - ext.length) + ext;
}

function extensionOf(name: string): string {
  const ext = path.extname(name).slice(1).toLowerCase();
  return /^[a-z0-9]{1,10}$/.test(ext) ? ext : "";
}

function sniffImage(head: Buffer): string | undefined {
  if (
    head.length >= 8 &&
    head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff)
    return "image/jpeg";
  if (head.length >= 6 && /^GIF8[79]a$/.test(head.subarray(0, 6).toString("latin1"))) {
    return "image/gif";
  }
  if (
    head.length >= 12 &&
    head.subarray(0, 4).toString("latin1") === "RIFF" &&
    head.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  return undefined;
}

/**
 * 常见音视频的文件头：识别出 MIME 后网页才能直接播放。仍按 kind=file 存、下载接口照旧 attachment +
 * sandbox，只是 Content-Type 对了，网页把它包成 blob 交给 <video>/<audio>
 */
export function sniffMedia(head: Buffer): string | undefined {
  // ISO BMFF（mp4 / mov / m4a）：第 4–8 字节是 ftyp，后面是主品牌
  if (head.length >= 12 && head.subarray(4, 8).toString("latin1") === "ftyp") {
    const brand = head.subarray(8, 12).toString("latin1");
    if (brand === "qt  ") return "video/quicktime";
    if (brand === "M4A " || brand === "M4B ") return "audio/mp4";
    return "video/mp4";
  }
  // Matroska / WebM
  if (head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3) return "video/webm";
  if (head.length >= 3 && head.subarray(0, 3).toString("latin1") === "ID3") return "audio/mpeg";
  // MPEG 音频帧同步字（没有 ID3 头的 mp3）
  if (
    head.length >= 2 &&
    head[0] === 0xff &&
    (head[1]! & 0xe0) === 0xe0 &&
    (head[1]! & 0x06) !== 0
  ) {
    return "audio/mpeg";
  }
  if (
    head.length >= 12 &&
    head.subarray(0, 4).toString("latin1") === "RIFF" &&
    head.subarray(8, 12).toString("latin1") === "WAVE"
  ) {
    return "audio/wav";
  }
  if (head.length >= 4 && head.subarray(0, 4).toString("latin1") === "OggS") return "audio/ogg";
  if (head.length >= 4 && head.subarray(0, 4).toString("latin1") === "fLaC") return "audio/flac";
  return undefined;
}

/** 文件头里没有 NUL 且是合法 UTF-8（末尾被截断的多字节字符不算错）即视为文本 */
function looksLikeText(head: Buffer, complete: boolean): boolean {
  if (head.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: !complete });
    return true;
  } catch {
    return false;
  }
}

export function imageSize(
  mime: string,
  head: Buffer,
): { width: number; height: number } | undefined {
  try {
    if (mime === "image/png" && head.length >= 24) {
      return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
    }
    if (mime === "image/gif" && head.length >= 10) {
      return { width: head.readUInt16LE(6), height: head.readUInt16LE(8) };
    }
    if (mime === "image/jpeg") {
      let offset = 2;
      while (offset + 9 < head.length) {
        if (head[offset] !== 0xff) return undefined;
        const marker = head[offset + 1]!;
        const length = head.readUInt16BE(offset + 2);
        // SOF0–SOF15，除去 DHT(C4)、JPG(C8)、DAC(CC)
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: head.readUInt16BE(offset + 5), width: head.readUInt16BE(offset + 7) };
        }
        offset += 2 + length;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function classify(
  name: string,
  head: Buffer,
  complete: boolean,
): { kind: AttachmentKind; mime: string; ext: string } {
  const image = sniffImage(head);
  if (image) return { kind: "image", mime: image, ext: IMAGE_EXT[image]! };
  const ext = extensionOf(name);
  // PDF 先认：不压缩的 PDF 开头一段全是 ASCII，会被当成文本。仍按 kind=file 存，下载照旧 attachment + sandbox
  if (head.subarray(0, 5).toString("latin1") === "%PDF-") {
    return { kind: "file", mime: "application/pdf", ext: ".pdf" };
  }
  if (looksLikeText(head, complete)) {
    return { kind: "text", mime: TEXT_MIME[ext] ?? "text/plain", ext: `.${ext || "txt"}` };
  }
  const media = sniffMedia(head);
  if (media) return { kind: "file", mime: media, ext: ext ? `.${ext}` : ".bin" };
  return { kind: "file", mime: "application/octet-stream", ext: ext ? `.${ext}` : ".bin" };
}

export class AttachmentStore {
  private readonly dir: string;
  private readonly tmpDir: string;
  private readonly now: () => number;
  readonly roomQuotaBytes: number;
  readonly pendingQuotaBytes: number;
  private readonly uploadsByUploader = new Map<string, number[]>();

  constructor(
    private readonly db: Database.Database,
    options: AttachmentStoreOptions,
  ) {
    this.dir = path.resolve(options.dir);
    this.tmpDir = path.join(this.dir, ".tmp");
    this.now = options.now ?? Date.now;
    this.roomQuotaBytes = options.roomQuotaBytes ?? LIMITS.defaultRoomAttachmentQuotaBytes;
    this.pendingQuotaBytes = options.pendingQuotaBytes ?? LIMITS.defaultPendingAttachmentQuotaBytes;
    mkdirSync(this.tmpDir, { recursive: true });
    // 上次进程退出时没写完的临时文件
    for (const entry of readdirSync(this.tmpDir))
      rmSync(path.join(this.tmpDir, entry), { force: true });
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        uploader TEXT NOT NULL,
        name TEXT NOT NULL,
        mime TEXT NOT NULL,
        kind TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        blob TEXT NOT NULL,
        width INTEGER,
        height INTEGER,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        message_id TEXT,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS attachments_room ON attachments(room_id);
      CREATE INDEX IF NOT EXISTS attachments_message ON attachments(message_id);
      CREATE INDEX IF NOT EXISTS attachments_uploader ON attachments(uploader, message_id);
    `);
  }

  /** 每个上传者每分钟的上传次数；超出时拒绝，不排队 */
  checkRate(uploader: string): void {
    const now = this.now();
    const recent = (this.uploadsByUploader.get(uploader) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= LIMITS.maxAttachmentUploadsPerMinute) {
      throw new HiveError("UPLOAD_RATE_LIMIT", serverText("error.attachment.rateLimited"));
    }
    recent.push(now);
    this.uploadsByUploader.set(uploader, recent);
  }

  private roomUsage(roomId: string): number {
    return (
      this.db
        .prepare(
          "SELECT COALESCE(SUM(size), 0) AS total FROM attachments WHERE room_id = ? AND revoked_at IS NULL",
        )
        .get(roomId) as { total: number }
    ).total;
  }

  private pendingUsage(uploader: string): number {
    return (
      this.db
        .prepare(
          "SELECT COALESCE(SUM(size), 0) AS total FROM attachments WHERE uploader = ? AND message_id IS NULL AND revoked_at IS NULL",
        )
        .get(uploader) as { total: number }
    ).total;
  }

  /** 按声明的大小预检配额，避免明知超限还把整个文件收下来；收完后按实际大小再检查一次 */
  checkQuota(roomId: string, uploader: string, size: number): void {
    if (this.roomUsage(roomId) + size > this.roomQuotaBytes) {
      throw new HiveError("ROOM_ATTACHMENT_QUOTA", serverText("error.attachment.roomQuota"));
    }
    if (this.pendingUsage(uploader) + size > this.pendingQuotaBytes) {
      throw new HiveError("PENDING_ATTACHMENT_QUOTA", serverText("error.attachment.pendingQuota"));
    }
  }

  /**
   * 把上传流写进临时文件，同时计算摘要并保留文件头用于嗅探；
   * 超过单文件上限、客户端中途断开或写入失败时删除临时文件并抛错。
   */
  async save(input: {
    roomId: string;
    uploader: string;
    name: string;
    stream: Readable;
    /** 流被 multipart 截断（超过上限）时为 true */
    truncated: () => boolean;
  }): Promise<StoredAttachment> {
    const tmpPath = path.join(this.tmpDir, randomUUID());
    const hash = createHash("sha256");
    const headChunks: Buffer[] = [];
    let headLength = 0;
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > LIMITS.maxAttachmentBytes) {
          callback(new HiveError("ATTACHMENT_TOO_LARGE", serverText("error.attachment.tooLarge")));
          return;
        }
        hash.update(chunk);
        if (headLength < HEAD_BYTES) {
          const part = chunk.subarray(0, HEAD_BYTES - headLength);
          headChunks.push(part);
          headLength += part.length;
        }
        callback(null, chunk);
      },
    });
    try {
      await pipeline(input.stream, meter, createWriteStream(tmpPath, { flags: "wx" }));
      if (input.truncated()) {
        throw new HiveError("ATTACHMENT_TOO_LARGE", serverText("error.attachment.tooLarge"));
      }
      const name = sanitizeFileName(input.name);
      const head = Buffer.concat(headChunks);
      const { kind, mime, ext } = classify(name, head, size <= HEAD_BYTES);
      const dimensions = kind === "image" ? imageSize(mime, head) : undefined;
      const sha256 = hash.digest("hex");
      const blob = `${sha256.slice(0, 2)}/${sha256}${ext}`;
      // 配额检查、写入记录、把文件挪到位，同步完成，清理任务不会在中间删掉这个文件
      this.checkQuota(input.roomId, input.uploader, size);
      const id = randomUUID();
      const createdAt = new Date(this.now()).toISOString();
      const expiresAt = new Date(this.now() + LIMITS.pendingAttachmentTtlMs).toISOString();
      this.db
        .prepare(
          `INSERT INTO attachments(id, room_id, uploader, name, mime, kind, size, sha256, blob,
            width, height, created_at, expires_at)
          VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.roomId,
          input.uploader,
          name,
          mime,
          kind,
          size,
          sha256,
          blob,
          dimensions?.width ?? null,
          dimensions?.height ?? null,
          createdAt,
          expiresAt,
        );
      const target = path.join(this.dir, blob);
      if (existsSync(target)) {
        rmSync(tmpPath, { force: true });
      } else {
        mkdirSync(path.dirname(target), { recursive: true });
        renameSync(tmpPath, target);
      }
      return this.get(id)!;
    } catch (error) {
      rmSync(tmpPath, { force: true });
      throw error;
    }
  }

  get(id: string): StoredAttachment | undefined {
    const row = this.db.prepare("SELECT * FROM attachments WHERE id = ?").get(id) as
      AttachmentRow | undefined;
    return row ? this.map(row) : undefined;
  }

  private map(row: AttachmentRow): StoredAttachment {
    return {
      id: row.id,
      name: row.name,
      mime: row.mime,
      size: row.size,
      kind: row.kind,
      sha256: row.sha256,
      ...(row.width ? { width: row.width } : {}),
      ...(row.height ? { height: row.height } : {}),
      roomId: row.room_id,
      uploader: row.uploader,
      ...(row.message_id ? { messageId: row.message_id } : {}),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
      filePath: path.join(this.dir, row.blob),
    };
  }

  /**
   * 发送前校验待发附件：都属于这个房间和上传者、尚未发出、没有过期；
   * 件数与总量不超过单条消息上限。真正的绑定在写消息的同一个事务里完成（见 bind）。
   */
  claim(ids: string[], owner: { roomId: string; uploader: string }): Attachment[] {
    const unique = [...new Set(ids)];
    if (unique.length > LIMITS.maxAttachmentsPerMessage) {
      throw new HiveError("TOO_MANY_ATTACHMENTS", serverText("error.attachment.tooMany"));
    }
    const now = this.now();
    const attachments = unique.map((id) => {
      const item = this.get(id);
      if (
        !item ||
        item.roomId !== owner.roomId ||
        item.uploader !== owner.uploader ||
        item.revokedAt ||
        item.messageId
      ) {
        throw new HiveError("ATTACHMENT_UNAVAILABLE", serverText("error.attachment.unavailable"));
      }
      if (Date.parse(item.expiresAt) <= now) {
        throw new HiveError("ATTACHMENT_EXPIRED", serverText("error.attachment.expiredReupload"));
      }
      return item;
    });
    const total = attachments.reduce((sum, item) => sum + item.size, 0);
    if (total > LIMITS.maxMessageAttachmentBytes) {
      throw new HiveError("ATTACHMENTS_TOO_LARGE", serverText("error.attachment.totalTooLarge"));
    }
    return attachments.map(publicAttachment);
  }

  /** 在写消息的事务里调用；有一个附件已被别的消息抢先绑定就整体回滚 */
  bind(ids: string[], messageId: string): void {
    const statement = this.db.prepare(
      "UPDATE attachments SET message_id = ? WHERE id = ? AND message_id IS NULL AND revoked_at IS NULL",
    );
    for (const id of ids) {
      if (statement.run(messageId, id).changes !== 1) {
        throw new HiveError("ATTACHMENT_UNAVAILABLE", serverText("error.attachment.sentElsewhere"));
      }
    }
  }

  /**
   * 房间里随消息发出、仍可读的附件（产物面板用）：没撤回、所属消息还在且没撤回。
   * 新消息在前；同一条消息里的附件按上传顺序。只给元数据，不含本机路径。
   */
  listSent(roomId: string): SentAttachment[] {
    const rows = this.db
      .prepare(
        `SELECT a.*, m.seq AS message_seq, m.sender_id, m.sender_name, m.sender_type,
            m.created_at AS sent_at
          FROM attachments a JOIN messages m ON m.id = a.message_id
          WHERE a.room_id = ? AND m.room_id = a.room_id
            AND a.revoked_at IS NULL AND m.deleted_at IS NULL
          ORDER BY m.seq DESC, a.rowid ASC`,
      )
      .all(roomId) as Array<
      AttachmentRow & {
        message_seq: number;
        sender_id: string;
        sender_name: string;
        sender_type: "human" | "agent";
        sent_at: string;
      }
    >;
    return rows.map((row) => ({
      ...publicAttachment(this.map(row)),
      messageId: row.message_id!,
      messageSeq: row.message_seq,
      senderId: row.sender_id,
      senderName: row.sender_name,
      senderType: row.sender_type,
      createdAt: row.sent_at,
    }));
  }

  /** 撤回消息：撤销它引用的附件；文件在没有其他引用后由 sweep 删除 */
  revokeForMessage(messageId: string): void {
    this.db
      .prepare("UPDATE attachments SET revoked_at = ? WHERE message_id = ? AND revoked_at IS NULL")
      .run(new Date(this.now()).toISOString(), messageId);
  }

  /** 上传者移除还没发出的附件 */
  discardPending(id: string, uploader: string): boolean {
    return (
      this.db
        .prepare("DELETE FROM attachments WHERE id = ? AND uploader = ? AND message_id IS NULL")
        .run(id, uploader).changes === 1
    );
  }

  /**
   * 清理：过期未发出的上传、撤回超过宽限期的引用、所属消息已被删除（清空房间、删房间）的引用，
   * 以及没有任何记录引用的文件。
   */
  sweep(): { removedRows: number; removedFiles: number } {
    const now = this.now();
    const nowIso = new Date(now).toISOString();
    const graceIso = new Date(now - REVOKED_GRACE_MS).toISOString();
    const removedRows =
      this.db
        .prepare("DELETE FROM attachments WHERE message_id IS NULL AND expires_at <= ?")
        .run(nowIso).changes +
      this.db
        .prepare("DELETE FROM attachments WHERE revoked_at IS NOT NULL AND revoked_at <= ?")
        .run(graceIso).changes +
      this.db
        .prepare(
          "UPDATE attachments SET revoked_at = ? WHERE revoked_at IS NULL AND message_id IS NOT NULL AND message_id NOT IN (SELECT id FROM messages)",
        )
        .run(nowIso).changes;
    const referenced = new Set(
      (this.db.prepare("SELECT DISTINCT blob FROM attachments").all() as { blob: string }[]).map(
        (row) => row.blob,
      ),
    );
    let removedFiles = 0;
    for (const prefix of readdirSync(this.dir)) {
      if (prefix === ".tmp" || !/^[a-f0-9]{2}$/.test(prefix)) continue;
      for (const file of readdirSync(path.join(this.dir, prefix))) {
        if (referenced.has(`${prefix}/${file}`)) continue;
        rmSync(path.join(this.dir, prefix, file), { force: true });
        removedFiles += 1;
      }
    }
    return { removedRows, removedFiles };
  }
}

export function publicAttachment(item: Attachment): Attachment {
  return {
    id: item.id,
    name: item.name,
    mime: item.mime,
    size: item.size,
    kind: item.kind,
    sha256: item.sha256,
    ...(item.width ? { width: item.width } : {}),
    ...(item.height ? { height: item.height } : {}),
  };
}
