/**
 * 输入框「添加附件」在桌面端的系统选文件窗口：起始目录是当前房间绑定的工作区。
 *
 * 安全边界：
 * - 起始目录只信主进程自己向本机 Hive 查到的房间工作区（要本机凭证的 /api/local 接口），
 *   网页只给房间 ID，不能传路径；查不到、目录不存在或不是目录时退回用户主目录。
 * - 起始目录只用作对话框打开的位置，不读、不列它的内容。
 * - 读回网页的只有用户在对话框里亲手选的文件，而且按上传上限读：单个超过 20 MB、
 *   合计超过 50 MB、超过 10 个的不读内容，只回文件名和大小，由网页照常提示。
 */
import path from "node:path";
import { createLocalHiveGet, type FetchLike } from "./local-hive.js";

/** 与服务端 LIMITS、网页 attachments.tsx 一致：单个 20 MiB、一条消息 10 个、合计 50 MiB */
export const PICK_LIMITS = {
  maxFileBytes: 20 * 1024 * 1024,
  maxFiles: 10,
  maxTotalBytes: 50 * 1024 * 1024,
} as const;

/** 房间 ID 的形状（与 Hive 的房间 ID 规则一致）；别的一律当作没有房间 */
const ROOM_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type PickFilesRequest = { roomId?: string | null; multiple?: boolean };

/** 选中的一个文件：data 不在时表示没读（skipped 说明原因），网页据此提示 */
export type PickedFile = {
  name: string;
  type: string;
  size: number;
  data?: Uint8Array;
  skipped?: "too-large" | "total" | "count";
};

export type PickFilesResult = { canceled: boolean; files: PickedFile[] };

export function normalizePickRequest(input: unknown): { roomId?: string; multiple: boolean } {
  const value = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const roomId =
    typeof value.roomId === "string" && ROOM_ID.test(value.roomId) ? value.roomId : undefined;
  return { ...(roomId ? { roomId } : {}), multiple: value.multiple !== false };
}

export type { FetchLike } from "./local-hive.js";

/** 向本机 Hive 查房间绑定的工作区（要本机凭证的 /api/local 接口，见 local-hive.ts） */
export function createWorkspaceLookup(options: {
  origin: () => string | undefined;
  fetch: FetchLike;
  timeoutMs?: number;
}): (roomId: string) => Promise<string | undefined> {
  const get = createLocalHiveGet(options);
  return async (roomId) => {
    // Hive 没起好、超时、没绑定：退回主目录
    if (!ROOM_ID.test(roomId)) return undefined;
    const body = (await get(`/api/local/rooms/${encodeURIComponent(roomId)}/workspace`)) as
      { workspace?: unknown } | undefined;
    return typeof body?.workspace === "string" && body.workspace ? body.workspace : undefined;
  };
}

/** 工作区路径允许 ~ 开头；只有确实存在的目录才用作起始目录，否则用主目录 */
export async function dialogDefaultPath(options: {
  workspace: string | undefined;
  home: string;
  isDirectory: (target: string) => Promise<boolean>;
}): Promise<string> {
  const raw = options.workspace?.trim();
  if (!raw) return options.home;
  const expanded =
    raw === "~" ? options.home : /^~[\\/]/.test(raw) ? path.join(options.home, raw.slice(2)) : raw;
  if (!path.isAbsolute(expanded)) return options.home;
  try {
    return (await options.isDirectory(expanded)) ? expanded : options.home;
  } catch {
    return options.home;
  }
}

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".heic": "image/heic",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".json": "application/json",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".ts": "text/plain",
  ".tsx": "text/plain",
  ".xml": "application/xml",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".log": "text/plain",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** 和浏览器 <input type=file> 一样按扩展名给类型；认不出的留空，服务端照常按文件名处理 */
export function mimeFor(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? "";
}

/**
 * 按上传上限读用户选中的文件：普通文件才读，超限的只回名字和大小。
 * 一次最多读 10 个、合计 50 MB，所以不会把几百 MB 塞进 IPC。
 */
export async function readPickedFiles(
  paths: readonly string[],
  io: {
    stat: (file: string) => Promise<{ size: number; isFile(): boolean }>;
    readFile: (file: string) => Promise<Uint8Array>;
  },
  limits: { maxFileBytes: number; maxFiles: number; maxTotalBytes: number } = PICK_LIMITS,
): Promise<PickedFile[]> {
  const files: PickedFile[] = [];
  let read = 0;
  let total = 0;
  for (const file of paths) {
    let info: { size: number; isFile(): boolean };
    try {
      info = await io.stat(file);
    } catch {
      continue;
    }
    if (!info.isFile()) continue;
    const base = { name: path.basename(file), type: mimeFor(file), size: info.size };
    if (read >= limits.maxFiles) {
      files.push({ ...base, skipped: "count" });
      continue;
    }
    if (info.size > limits.maxFileBytes) {
      files.push({ ...base, skipped: "too-large" });
      continue;
    }
    if (total + info.size > limits.maxTotalBytes) {
      files.push({ ...base, skipped: "total" });
      continue;
    }
    let data: Uint8Array;
    try {
      data = await io.readFile(file);
    } catch {
      continue;
    }
    // 读的时候文件又变大了：仍按上限处理
    if (data.byteLength > limits.maxFileBytes) {
      files.push({ ...base, size: data.byteLength, skipped: "too-large" });
      continue;
    }
    read += 1;
    total += data.byteLength;
    files.push({ ...base, size: data.byteLength, data });
  }
  return files;
}

export type PickDialog = (options: {
  title: string;
  defaultPath: string;
  multiple: boolean;
}) => Promise<{ canceled: boolean; filePaths: string[] }>;

/**
 * IPC 处理：来源不可信直接拒绝；同一页面同时只开一个对话框；对话框关上时页面已经跳走就什么都不交。
 * 依赖都从外面传进来，主进程接 Electron，测试里替换掉。
 */
export function createPickFilesHandler<E extends { sender: { id: number } }>(deps: {
  trusted: (event: E) => boolean;
  roomWorkspace: (roomId: string) => Promise<string | undefined>;
  home: () => string;
  isDirectory: (target: string) => Promise<boolean>;
  title: () => string;
  showDialog: (event: E, options: Parameters<PickDialog>[0]) => ReturnType<PickDialog>;
  readFiles: (paths: readonly string[]) => Promise<PickedFile[]>;
}): (event: E, input: unknown) => Promise<PickFilesResult> {
  const picking = new Set<number>();
  return async (event, input) => {
    if (!deps.trusted(event)) throw new Error("Forbidden");
    const senderId = event.sender.id;
    if (picking.has(senderId)) return { canceled: true, files: [] };
    picking.add(senderId);
    try {
      const request = normalizePickRequest(input);
      const defaultPath = await dialogDefaultPath({
        workspace: request.roomId ? await deps.roomWorkspace(request.roomId) : undefined,
        home: deps.home(),
        isDirectory: deps.isDirectory,
      });
      const picked = await deps.showDialog(event, {
        title: deps.title(),
        defaultPath,
        multiple: request.multiple,
      });
      if (picked.canceled || !picked.filePaths.length || !deps.trusted(event))
        return { canceled: true, files: [] };
      return { canceled: false, files: await deps.readFiles(picked.filePaths) };
    } finally {
      picking.delete(senderId);
    }
  };
}
