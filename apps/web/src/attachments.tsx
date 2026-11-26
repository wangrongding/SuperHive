import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { serverError } from "./server-text";
import { createPortal } from "react-dom";
import {
  canOpenWithDefaultApp,
  type Attachment,
  type UploadedAttachment,
} from "@superhive/protocol";
import { t } from "./i18n";
import { createClientMessageId } from "./client-id";
import { OfficePreview } from "./office-preview/office-preview";
import { officeKind } from "./office-preview/office-kind";
import { Tooltip } from "./tooltip";
import { Button, IconButton } from "./button";

// 预览 Markdown 时才用到渲染器，和消息里的共用同一个 chunk
const PreviewMarkdown = lazy(() =>
  import("./message-markdown").then((module) => ({ default: module.MessageMarkdown })),
);

/** 与服务端 LIMITS 一致：单个 20 MiB、一条消息 10 个、合计 50 MiB */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
export const MAX_MESSAGE_ATTACHMENT_BYTES = 50 * 1024 * 1024;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export type QueuedAttachment = {
  localId: string;
  file: File;
  name: string;
  size: number;
  status: "uploading" | "done" | "error";
  /** 0–1 */
  progress: number;
  attachment?: UploadedAttachment;
  error?: string;
  /** 本地图片预览（object URL），不经服务器 */
  previewUrl?: string;
};

/** 剪贴板截图没有有意义的文件名，统一起一个带时间的名字 */
export function nameForPastedFile(file: File, index: number): string {
  if (file.name && file.name !== "image.png") return file.name;
  const ext = file.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
  return t("粘贴图片-{0}{1}.{2}", { 0: stamp, 1: index ? `-${index + 1}` : "", 2: ext });
}

function uploadError(status: number, body: string): string {
  try {
    const message = serverError(JSON.parse(body));
    if (message) return message;
  } catch {
    // 非 JSON 响应按状态码说明
  }
  if (status === 413) return t("文件太大或空间已满");
  if (status === 401 || status === 403) return t("没有上传权限");
  return t("上传失败（{0}）", { 0: status || t("网络错误") });
}

/**
 * 粘贴、拖拽与选择文件共用的上传队列：每个文件立即用 multipart 上传，带进度；
 * 可移除（上传中则取消，已上传则通知服务端删除）与重试。发送时只交出已上传完成的附件 ID。
 */
export function useAttachmentQueue(options: {
  base: string;
  token: string | undefined;
  roomId: string;
}) {
  const { base, token, roomId } = options;
  const [items, setItems] = useState<QueuedAttachment[]>([]);
  const requests = useRef(new Map<string, XMLHttpRequest>());
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const patch = useCallback((localId: string, update: Partial<QueuedAttachment>) => {
    setItems((current) =>
      current.map((item) => (item.localId === localId ? { ...item, ...update } : item)),
    );
  }, []);

  const start = useCallback(
    (localId: string, file: File, name: string) => {
      if (!token) {
        patch(localId, { status: "error", error: t("尚未连接 Hive Server") });
        return;
      }
      const request = new XMLHttpRequest();
      requests.current.set(localId, request);
      request.open("POST", `${base}/api/rooms/${encodeURIComponent(roomId)}/attachments`);
      // 凭证只放在请求头里，不进 URL
      request.setRequestHeader("Authorization", `Bearer ${token}`);
      request.upload.onprogress = (event) => {
        if (event.lengthComputable) patch(localId, { progress: event.loaded / event.total });
      };
      request.onload = () => {
        requests.current.delete(localId);
        if (request.status === 201) {
          patch(localId, {
            status: "done",
            progress: 1,
            attachment: JSON.parse(request.responseText) as UploadedAttachment,
          });
        } else {
          patch(localId, {
            status: "error",
            error: uploadError(request.status, request.responseText),
          });
        }
      };
      request.onerror = () => {
        requests.current.delete(localId);
        patch(localId, { status: "error", error: t("网络错误，上传失败") });
      };
      const form = new FormData();
      form.append("file", file, name);
      request.send(form);
    },
    [base, patch, roomId, token],
  );

  const add = useCallback(
    (files: File[]): string | undefined => {
      const current = itemsRef.current;
      const room = MAX_ATTACHMENTS_PER_MESSAGE - current.length;
      if (room <= 0) return t("一条消息最多 {0} 个附件", { 0: MAX_ATTACHMENTS_PER_MESSAGE });
      let notice: string | undefined;
      const accepted: QueuedAttachment[] = [];
      let total = current.reduce((sum, item) => sum + item.size, 0);
      files.forEach((file, index) => {
        if (accepted.length >= room) {
          notice = t("一条消息最多 {0} 个附件，多出的没有加入", { 0: MAX_ATTACHMENTS_PER_MESSAGE });
          return;
        }
        if (file.size > MAX_ATTACHMENT_BYTES) {
          notice = t("{0} 超过 20 MB，没有加入", { 0: file.name || t("这个文件") });
          return;
        }
        if (total + file.size > MAX_MESSAGE_ATTACHMENT_BYTES) {
          notice = t("一条消息的附件合计不能超过 50 MB");
          return;
        }
        total += file.size;
        const name = nameForPastedFile(file, index);
        const isImage = /^image\/(png|jpeg|gif|webp)$/.test(file.type);
        accepted.push({
          localId: createClientMessageId(),
          file,
          name,
          size: file.size,
          status: "uploading",
          progress: 0,
          ...(isImage ? { previewUrl: URL.createObjectURL(file) } : {}),
        });
      });
      if (accepted.length) {
        setItems((existing) => [...existing, ...accepted]);
        for (const item of accepted) start(item.localId, item.file, item.name);
      }
      return notice;
    },
    [start],
  );

  const remove = useCallback(
    (localId: string) => {
      const item = itemsRef.current.find((entry) => entry.localId === localId);
      if (!item) return;
      requests.current.get(localId)?.abort();
      requests.current.delete(localId);
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      if (item.attachment && token) {
        void fetch(`${base}/api/attachments/${item.attachment.id}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => undefined);
      }
      setItems((current) => current.filter((entry) => entry.localId !== localId));
    },
    [base, token],
  );

  const retry = useCallback(
    (localId: string) => {
      const item = itemsRef.current.find((entry) => entry.localId === localId);
      if (!item || item.status !== "error") return;
      patch(localId, { status: "uploading", progress: 0, error: undefined });
      start(localId, item.file, item.name);
    },
    [patch, start],
  );

  /** 发出后清空队列；预览留给已发出的消息无用，一并释放 */
  const clear = useCallback(() => {
    for (const item of itemsRef.current) {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      requests.current.get(item.localId)?.abort();
    }
    requests.current.clear();
    setItems([]);
  }, []);

  // 切换房间：待发附件属于原来的房间，丢弃并通知服务端
  const roomRef = useRef(roomId);
  useEffect(() => {
    if (roomRef.current === roomId) return;
    roomRef.current = roomId;
    for (const item of itemsRef.current) remove(item.localId);
  }, [remove, roomId]);

  useEffect(
    () => () => {
      for (const request of requests.current.values()) request.abort();
    },
    [],
  );

  return {
    items,
    add,
    remove,
    retry,
    clear,
    uploading: items.some((item) => item.status === "uploading"),
    failed: items.some((item) => item.status === "error"),
    readyIds: items.flatMap((item) => (item.attachment ? [item.attachment.id] : [])),
  };
}

export function FileGlyph({ kind }: { kind: Attachment["kind"] | "pending" }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      {kind === "text" && <path d="M9 13h6M9 17h4" />}
    </svg>
  );
}

export function PaperclipIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m21.4 11.1-8.5 8.5a5.5 5.5 0 0 1-7.8-7.8l8.5-8.5a3.7 3.7 0 0 1 5.2 5.2l-8.5 8.5a1.8 1.8 0 0 1-2.6-2.6l7.8-7.8" />
    </svg>
  );
}

/** 输入框上方的待发附件：缩略图或文件卡片、上传进度、移除与重试 */
export function ComposerAttachments({
  items,
  onRemove,
  onRetry,
}: {
  items: QueuedAttachment[];
  onRemove: (localId: string) => void;
  onRetry: (localId: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <ul className="composer-attachments" aria-label={t("待发送的附件")}>
      {items.map((item) => (
        <li
          key={item.localId}
          className={`composer-attachment ${item.status}${item.previewUrl ? " image" : ""}`}
          title={item.error ?? item.name}
        >
          {item.previewUrl ? (
            <img src={item.previewUrl} alt={item.name} />
          ) : (
            <span className="composer-attachment-icon">
              <FileGlyph kind={item.attachment?.kind ?? "pending"} />
            </span>
          )}
          {!item.previewUrl && (
            <span className="composer-attachment-copy">
              <strong>{item.name}</strong>
              <small>
                {item.status === "error"
                  ? item.error
                  : item.status === "uploading"
                    ? t("上传中 {0}%", { 0: Math.round(item.progress * 100) })
                    : formatBytes(item.size)}
              </small>
            </span>
          )}
          {item.status === "uploading" && (
            <span className="composer-attachment-progress" aria-hidden="true">
              <span style={{ width: `${Math.max(4, item.progress * 100)}%` }} />
            </span>
          )}
          {item.status === "error" && (
            <Tooltip content={t("{0}，点击重试", { 0: item.error ?? t("上传失败") })}>
              <Button
                size="sm"
                className="composer-attachment-retry"
                onClick={() => onRetry(item.localId)}
                aria-label={t("重试上传 {0}", { 0: item.name })}
              >
                {t("重试")}
              </Button>
            </Tooltip>
          )}
          <Tooltip content={item.status === "uploading" ? t("取消上传") : t("移除")}>
            <button
              type="button"
              className="composer-attachment-remove"
              onClick={() => onRemove(item.localId)}
              aria-label={t("移除 {0}", { 0: item.name })}
            >
              ×
            </button>
          </Tooltip>
        </li>
      ))}
    </ul>
  );
}

/* ---------- 消息里的附件：凭 Bearer 取回文件，生成本地 object URL ---------- */

const blobCache = new Map<string, Promise<{ url: string; blob: Blob }>>();

/** 同一附件在页面内只取一次；失败的不缓存，下次再试 */
export function fetchAttachmentUrl(base: string, token: string, id: string): Promise<string> {
  return fetchAttachment(base, token, id).then((loaded) => loaded.url);
}

export function fetchAttachmentBlob(base: string, token: string, id: string): Promise<Blob> {
  return fetchAttachment(base, token, id).then((loaded) => loaded.blob);
}

/**
 * 连同文件内容一起给出：预览要读正文、换 MIME 时直接用这份 Blob。不能再 fetch(blob:) 一遍，
 * 生产环境网页的 CSP connect-src 不含 blob:，会被拦下
 */
function fetchAttachment(
  base: string,
  token: string,
  id: string,
): Promise<{ url: string; blob: Blob }> {
  const cached = blobCache.get(id);
  if (cached) return cached;
  const task = fetch(`${base}/api/attachments/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  }).then(async (response) => {
    if (!response.ok) {
      throw new Error(
        response.status === 410
          ? t("附件已撤回或过期")
          : t("无法读取附件（{0}）", { 0: response.status }),
      );
    }
    const blob = await response.blob();
    return { url: URL.createObjectURL(blob), blob };
  });
  blobCache.set(id, task);
  task.catch(() => blobCache.delete(id));
  return task;
}

export function useAttachmentUrl(
  base: string,
  token: string | undefined,
  id: string,
  enabled: boolean,
) {
  const [state, setState] = useState<{ url?: string; blob?: Blob; error?: string }>({});
  useEffect(() => {
    if (!enabled || !token) return;
    let alive = true;
    fetchAttachment(base, token, id).then(
      ({ url, blob }) => alive && setState({ url, blob }),
      (error: unknown) =>
        alive && setState({ error: error instanceof Error ? error.message : String(error) }),
    );
    return () => {
      alive = false;
    };
  }, [base, enabled, id, token]);
  return state;
}

function ImageAttachment({
  attachment,
  base,
  token,
  onOpen,
}: {
  attachment: Attachment;
  base: string;
  token: string | undefined;
  onOpen: (url: string) => void;
}) {
  const { url, error } = useAttachmentUrl(base, token, attachment.id, true);
  const ratio =
    attachment.width && attachment.height ? attachment.width / attachment.height : undefined;
  return (
    <Tooltip content={error ?? attachment.name}>
      <button
        type="button"
        className={`message-image${error ? " failed" : ""}`}
        style={ratio ? { aspectRatio: `${Math.min(Math.max(ratio, 0.5), 3)}` } : undefined}
        onClick={(event) => {
          event.stopPropagation();
          if (url) onOpen(url);
        }}
        disabled={!url}
        aria-label={t("查看图片 {0}", { 0: attachment.name })}
      >
        {url ? <img src={url} alt={attachment.name} /> : <span>{error ?? t("加载中…")}</span>}
      </button>
    </Tooltip>
  );
}

const VIDEO_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
};
const AUDIO_TYPES: Record<string, string> = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  flac: "audio/flac",
};

/**
 * 音视频附件的播放类型：优先用服务端识别出的 MIME；早先上传的文件服务端只记成 application/octet-stream，
 * 按扩展名补上（播放器靠它判断能不能放）
 */
export function mediaType(
  attachment: Attachment,
): { kind: "video" | "audio"; type: string } | undefined {
  if (attachment.mime.startsWith("video/")) return { kind: "video", type: attachment.mime };
  if (attachment.mime.startsWith("audio/")) return { kind: "audio", type: attachment.mime };
  const ext = /\.([a-z0-9]+)$/i.exec(attachment.name)?.[1]?.toLowerCase() ?? "";
  if (VIDEO_TYPES[ext]) return { kind: "video", type: VIDEO_TYPES[ext] };
  if (AUDIO_TYPES[ext]) return { kind: "audio", type: AUDIO_TYPES[ext] };
  return undefined;
}

/** PDF：服务端按文件头识别；早先上传的只记成 application/octet-stream，按扩展名补上 */
function isPdf(attachment: Attachment): boolean {
  return (
    attachment.mime === "application/pdf" ||
    (attachment.kind === "file" && /\.pdf$/i.test(attachment.name))
  );
}

/** 页面内能预览的：网页（HTML）、文本类（含代码、Markdown）、PDF、音视频、Office 文档；其他照旧下载 */
export function previewKind(
  attachment: Attachment,
): "html" | "markdown" | "text" | "pdf" | "video" | "audio" | "office" | undefined {
  if (isPdf(attachment)) return "pdf";
  const media = mediaType(attachment);
  if (media) return media.kind;
  if (officeKind(attachment.name)) return "office";
  if (attachment.kind !== "text") return undefined;
  if (/\.html?$/i.test(attachment.name)) return "html";
  return /\.(md|markdown|mdx)$/i.test(attachment.name) ? "markdown" : "text";
}

/**
 * HTML 附件的预览地址：凭登录换一个几分钟内有效的 token。预览页由服务端带 CSP sandbox 返回，
 * 是不透明源，读不到这个网页的 localStorage、发请求也带不上凭证；绝不能用同源的 blob 或 srcdoc 打开
 */
async function fetchHtmlPreviewUrl(base: string, token: string, id: string): Promise<string> {
  const response = await fetch(`${base}/api/attachments/${id}/preview`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(
      response.status === 410
        ? t("附件已撤回或过期")
        : t("无法读取附件（{0}）", { 0: response.status }),
    );
  }
  const { url } = (await response.json()) as { url: string };
  return `${base}${url}`;
}

/** iframe 也加一道 sandbox：和服务端 CSP 一样，允许脚本、弹窗、表单，但不给同源 */
const HTML_PREVIEW_SANDBOX = "allow-scripts allow-popups allow-forms allow-modals";

const PREVIEW_MAXIMIZED_KEY = "superhive.preview-maximized";

function loadPreviewMaximized(): boolean {
  try {
    return localStorage.getItem(PREVIEW_MAXIMIZED_KEY) === "1";
  } catch {
    return false;
  }
}

function savePreviewMaximized(value: boolean) {
  try {
    if (value) localStorage.setItem(PREVIEW_MAXIMIZED_KEY, "1");
    else localStorage.removeItem(PREVIEW_MAXIMIZED_KEY);
  } catch {
    // 存不了就只在这次生效
  }
}

const PREVIEW_DOCKED_KEY = "superhive.preview-docked";

/**
 * 上次是不是在右侧栏看的：点过「在右侧栏打开」就记住，之后点文件直接停到右侧栏；
 * 在侧栏里点「放大成弹窗」改回弹窗。关掉预览不算改选择
 */
export function loadPreviewDocked(): boolean {
  try {
    return localStorage.getItem(PREVIEW_DOCKED_KEY) === "1";
  } catch {
    return false;
  }
}

function savePreviewDocked(value: boolean) {
  try {
    if (value) localStorage.setItem(PREVIEW_DOCKED_KEY, "1");
    else localStorage.removeItem(PREVIEW_DOCKED_KEY);
  } catch {
    // 存不了就只在这次生效
  }
}

/** 读出 Blob 里的文字；老一些的环境里 Blob 没有 text()，退回 FileReader */
function readBlobText(blob: Blob): Promise<string> {
  if (typeof blob.text === "function") return blob.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsText(blob);
  });
}

/** 文本预览最多显示这么多字，再长的请下载看全文 */
const PREVIEW_TEXT_LIMIT = 200_000;

export async function downloadAttachment(base: string, token: string, attachment: Attachment) {
  const url = await fetchAttachmentUrl(base, token, attachment.id);
  const link = document.createElement("a");
  link.href = url;
  link.download = attachment.name;
  link.rel = "noopener";
  link.click();
}

export type LocalOpenMode = "open" | "reveal";

/**
 * 页面开在 Server 那台电脑上的本机房主：附件本来就在这台电脑上，可以直接用本机应用打开，或在访达里显示
 * （Server 先按原文件名放一份副本，看到的不是哈希名）。远程设备和访客不提供，只能下载。
 */
export const AttachmentLocalOpenContext = createContext<
  ((attachment: Attachment, mode: LocalOpenMode) => Promise<void>) | undefined
>(undefined);

export function revealInFolderLabel(): string {
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  if (/Mac/i.test(platform)) return t("在访达中显示");
  if (/Win/i.test(platform)) return t("在资源管理器中显示");
  return t("在文件夹中显示");
}

/**
 * 本机打开 / 在文件夹中显示；没有本机能力时为 undefined。
 * 程序、脚本这类直接打开会运行代码的，canOpen 为 false，只给「在文件夹中显示」（Server 同样拒绝）
 */
export function useLocalOpen(onError: (attachment: Attachment, message: string) => void) {
  const action = useContext(AttachmentLocalOpenContext);
  return useMemo(
    () =>
      action && {
        canOpen: (attachment: Attachment) => canOpenWithDefaultApp(attachment.name),
        run: (attachment: Attachment, mode: LocalOpenMode) => {
          action(attachment, mode).catch((cause: unknown) =>
            onError(attachment, cause instanceof Error ? cause.message : String(cause)),
          );
        },
      },
    [action, onError],
  );
}

export function OpenLocallyIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
      <path
        d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function RevealInFolderIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
      <path
        d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 代码按扩展名高亮：包成一个足够长的代码围栏交给 Markdown 渲染器 */
function codeFence(name: string, text: string): string {
  const language = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${language}\n${text}\n${fence}`;
}

/**
 * 文件预览：默认是盖住页面的弹窗；docked 时改成对话区右边的一栏，对话和输入框照常能用，
 * 可以一边看文件一边让 Agent 改。弹窗顶部的「在右侧栏打开」由 onDock 提供，
 * 侧栏顶部的「放大回弹窗」由 onUndock 提供；notice 放在标题后面（例如「有新版本」）
 */
export function FilePreview({
  attachment,
  base,
  token,
  onClose,
  docked = false,
  onDock,
  onUndock,
  notice,
}: {
  attachment: Attachment;
  base: string;
  token: string | undefined;
  onClose: () => void;
  docked?: boolean;
  onDock?: () => void;
  onUndock?: () => void;
  notice?: ReactNode;
}) {
  const kind = previewKind(attachment)!;
  // Office 文档由 OfficePreview 自己取（超过大小上限就不下载）
  const { url, blob, error } = useAttachmentUrl(base, token, attachment.id, kind !== "office");
  // HTML 默认看渲染后的页面，可以切回源码
  const [htmlView, setHtmlView] = useState<"page" | "source">("page");
  // 放大：铺满窗口，选择记在本机，下次打开预览照旧
  const [maximized, setMaximized] = useState(loadPreviewMaximized);
  const toggleMaximized = useCallback(() => {
    setMaximized((current) => {
      savePreviewMaximized(!current);
      return !current;
    });
  }, []);
  const [pageUrl, setPageUrl] = useState<{ url?: string; error?: string }>({});
  useEffect(() => {
    if (kind !== "html" || !token) return;
    let alive = true;
    fetchHtmlPreviewUrl(base, token, attachment.id).then(
      (value) => alive && setPageUrl({ url: value }),
      (cause: unknown) =>
        alive && setPageUrl({ error: cause instanceof Error ? cause.message : String(cause) }),
    );
    return () => {
      alive = false;
    };
  }, [attachment.id, base, kind, token]);
  // 新窗口打开：先同步开窗（避免被拦截），拿到新的预览链接后再跳过去，并切断和本页的联系
  function openInNewWindow() {
    if (!token) return;
    const opened = window.open("", "_blank");
    if (opened) opened.opener = null;
    fetchHtmlPreviewUrl(base, token, attachment.id).then(
      (value) => {
        if (opened) opened.location.href = value;
        else window.open(value, "_blank", "noopener");
      },
      (cause: unknown) => {
        opened?.close();
        setDownloadError(cause instanceof Error ? cause.message : String(cause));
      },
    );
  }
  const [text, setText] = useState<{ value: string; clipped: boolean }>();
  const [downloadError, setDownloadError] = useState<string>();
  const localOpen = useLocalOpen(
    useCallback((_: Attachment, message: string) => setDownloadError(message), []),
  );
  const closeRef = useRef<HTMLButtonElement>(null);

  // 音视频、PDF：按正确的 MIME 重新包一层 blob 再交给播放器 / PDF 查看器（Safari 不认
  // application/octet-stream；PDF 不是这个类型 iframe 会变成下载）
  const [mediaUrl, setMediaUrl] = useState<string>();
  useEffect(() => {
    const media = kind === "pdf" ? { type: "application/pdf" } : mediaType(attachment);
    if (!url || !blob || !media) return;
    if (blob.type === media.type) {
      setMediaUrl(url);
      return;
    }
    const created = URL.createObjectURL(new Blob([blob], { type: media.type }));
    setMediaUrl(created);
    return () => URL.revokeObjectURL(created);
  }, [attachment, blob, kind, url]);

  useEffect(() => {
    if (!blob || kind === "pdf" || kind === "video" || kind === "audio" || kind === "office")
      return;
    let alive = true;
    void readBlobText(blob).then((value) => {
      if (!alive) return;
      setText({
        value: value.length > PREVIEW_TEXT_LIMIT ? value.slice(0, PREVIEW_TEXT_LIMIT) : value,
        clipped: value.length > PREVIEW_TEXT_LIMIT,
      });
    });
    return () => {
      alive = false;
    };
  }, [blob, kind]);

  useEffect(() => {
    // 停靠在侧栏时不抢焦点、不接管 Esc：输入框里按 Esc 不该把侧栏关掉
    if (docked) return;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // 幻灯片全屏放映时 Esc 只退出全屏，不连预览一起关
      if (document.fullscreenElement) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [docked, onClose]);

  function startDownload() {
    if (!token) return;
    setDownloadError(undefined);
    downloadAttachment(base, token, attachment).catch((cause: unknown) =>
      setDownloadError(cause instanceof Error ? cause.message : String(cause)),
    );
  }

  const body = error ? (
    <p className="file-preview-status danger">{error}</p>
  ) : kind === "office" ? (
    token ? (
      <OfficePreview
        name={attachment.name}
        size={attachment.size}
        source={attachment.id}
        load={() => fetchAttachmentBlob(base, token, attachment.id)}
        download={
          <Button size="sm" onClick={startDownload}>
            {t("下载")}
          </Button>
        }
      />
    ) : (
      <p className="file-preview-status">{t("加载中…")}</p>
    )
  ) : kind === "html" && htmlView === "page" ? (
    pageUrl.error ? (
      <p className="file-preview-status danger">{pageUrl.error}</p>
    ) : pageUrl.url ? (
      <iframe
        className="file-preview-page"
        src={pageUrl.url}
        sandbox={HTML_PREVIEW_SANDBOX}
        referrerPolicy="no-referrer"
        title={attachment.name}
      />
    ) : (
      <p className="file-preview-status">{t("加载中…")}</p>
    )
  ) : kind === "video" || kind === "audio" ? (
    mediaUrl ? (
      kind === "video" ? (
        <video
          className="file-preview-video"
          src={mediaUrl}
          controls
          autoPlay
          playsInline
          aria-label={attachment.name}
        />
      ) : (
        <div className="file-preview-audio">
          <audio src={mediaUrl} controls autoPlay aria-label={attachment.name} />
        </div>
      )
    ) : (
      <p className="file-preview-status">{t("加载中…")}</p>
    )
  ) : kind === "pdf" ? (
    mediaUrl ? (
      <iframe className="file-preview-pdf" src={mediaUrl} title={attachment.name} />
    ) : (
      <p className="file-preview-status">{t("加载中…")}</p>
    )
  ) : text === undefined ? (
    <p className="file-preview-status">{t("加载中…")}</p>
  ) : (
    <div className={`file-preview-text${kind === "markdown" ? " markdown" : ""}`}>
      <Suspense fallback={<pre>{text.value}</pre>}>
        <PreviewMarkdown
          content={kind === "markdown" ? text.value : codeFence(attachment.name, text.value)}
        />
      </Suspense>
      {text.clipped && (
        <p className="file-preview-status">
          {t("文件较长，只显示前 {0} 字；完整内容请下载查看。", {
            0: PREVIEW_TEXT_LIMIT.toLocaleString(),
          })}
        </p>
      )}
    </div>
  );

  const panel = (
    <div className="file-preview" onClick={(event) => event.stopPropagation()}>
      <header className="file-preview-header">
        <span className="message-file-icon">
          <FileGlyph kind={attachment.kind} />
        </span>
        <span className="file-preview-title">
          <strong title={attachment.name}>{attachment.name}</strong>
          <small className={downloadError ? "danger" : undefined}>
            {downloadError ?? formatBytes(attachment.size)}
          </small>
        </span>
        {notice}
        {kind === "html" && (
          <>
            <div className="file-preview-views" role="radiogroup" aria-label={t("预览方式")}>
              {(["page", "source"] as const).map((view) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={htmlView === view}
                  className={htmlView === view ? "active" : ""}
                  onClick={() => setHtmlView(view)}
                  key={view}
                >
                  {view === "page" ? t("页面") : t("源码")}
                </button>
              ))}
            </div>
            <Button size="sm" onClick={openInNewWindow}>
              {t("新窗口打开")}
            </Button>
          </>
        )}
        <Button size="sm" onClick={startDownload}>
          {t("下载")}
        </Button>
        {localOpen?.canOpen(attachment) && (
          <IconButton
            size="sm"
            className="file-preview-size"
            label={t("用本机应用打开")}
            onClick={() => {
              setDownloadError(undefined);
              localOpen.run(attachment, "open");
            }}
          >
            <OpenLocallyIcon />
          </IconButton>
        )}
        {localOpen && (
          <IconButton
            size="sm"
            className="file-preview-size"
            label={revealInFolderLabel()}
            onClick={() => {
              setDownloadError(undefined);
              localOpen.run(attachment, "reveal");
            }}
          >
            <RevealInFolderIcon />
          </IconButton>
        )}
        {onDock && !docked && (
          <IconButton
            size="sm"
            className="file-preview-size"
            label={t("在右侧栏打开")}
            tooltip={t("在右侧栏打开：一边看一边发消息")}
            onClick={() => {
              savePreviewDocked(true);
              onDock();
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <path d="M14 4v16" />
            </svg>
          </IconButton>
        )}
        {docked ? (
          onUndock && (
            <IconButton
              size="sm"
              className="file-preview-size"
              label={t("放大成弹窗")}
              onClick={() => {
                savePreviewDocked(false);
                onUndock();
              }}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
              </svg>
            </IconButton>
          )
        ) : (
          <IconButton
            size="sm"
            className="file-preview-size"
            label={maximized ? t("还原大小") : t("放大预览")}
            aria-pressed={maximized}
            onClick={toggleMaximized}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              {maximized ? (
                <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
              ) : (
                <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
              )}
            </svg>
          </IconButton>
        )}
        <IconButton
          ref={closeRef}
          size="sm"
          className="file-preview-close"
          label={docked ? t("关闭侧栏预览") : t("关闭")}
          onClick={onClose}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </IconButton>
      </header>
      <div className="file-preview-body">{body}</div>
    </div>
  );

  // 停靠时外面那一栏（宽度、拖拽手柄）由页面布局提供
  if (docked) return panel;

  return createPortal(
    <div
      className={`file-preview-backdrop${maximized ? " maximized" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={t("预览 {0}", { 0: attachment.name })}
      onClick={onClose}
    >
      {panel}
    </div>,
    document.body,
  );
}

function FileAttachment({
  attachment,
  base,
  token,
  onDock,
}: {
  attachment: Attachment;
  base: string;
  token: string | undefined;
  onDock?: (attachment: Attachment) => void;
}) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const previewable = previewKind(attachment) !== undefined;
  const closePreview = useCallback(() => setPreviewing(false), []);
  async function download() {
    if (!token || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await downloadAttachment(base, token, attachment);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  const label = previewable
    ? t("预览 {0}", { 0: attachment.name })
    : t("下载 {0}", { 0: attachment.name });
  return (
    <>
      <Tooltip content={error ?? label}>
        <button
          type="button"
          className="message-file"
          onClick={(event) => {
            event.stopPropagation();
            if (!previewable) void download();
            else if (onDock && loadPreviewDocked()) onDock(attachment);
            else setPreviewing(true);
          }}
          aria-label={label}
        >
          <span className="message-file-icon">
            <FileGlyph kind={attachment.kind} />
          </span>
          <span className="message-file-copy">
            <strong>{attachment.name}</strong>
            <small className={error ? "danger" : undefined}>
              {error ??
                (busy
                  ? t("下载中…")
                  : previewable
                    ? t("{0} · 点击预览", { 0: formatBytes(attachment.size) })
                    : t("{0} · 点击下载", { 0: formatBytes(attachment.size) }))}
            </small>
          </span>
        </button>
      </Tooltip>
      {previewing && (
        <FilePreview
          attachment={attachment}
          base={base}
          token={token}
          onClose={closePreview}
          onDock={
            onDock &&
            (() => {
              setPreviewing(false);
              onDock(attachment);
            })
          }
        />
      )}
    </>
  );
}

/** 100% = 整张放进可视区；还能再缩小一点看全貌 */
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 8;
const clampZoom = (value: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));

/**
 * 滚轮 / 触控板一次事件该缩放多少：按滚动量连续缩放，而不是每个事件固定乘一个倍数。
 * 触控板双指捏合（浏览器发成带 ctrlKey 的 wheel）一秒能来几十个小事件，固定倍数会缩放得飞快；
 * 鼠标滚轮一格 deltaY 约 100，缩放约 1.2 倍。单个事件最多缩放 1.25 倍，避免大跨度滚动跳太多。
 */
export function wheelZoomFactor(event: Pick<WheelEvent, "deltaY" | "deltaMode" | "ctrlKey">) {
  // deltaMode 1 = 按行、2 = 按页（Firefox 鼠标滚轮），折算成像素
  const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1);
  const rate = event.ctrlKey ? 0.006 : 0.0018;
  const step = Math.max(-0.22, Math.min(0.22, -pixels * rate));
  return Math.exp(step);
}

/**
 * 图片查看器：同一条消息（或产物面板里）的多张图用 ← → 切换；滚轮 / 触控板捏合（以指针为中心、按滚动量平滑缩放）、+ / -、双击缩放，放大后可拖动，0 复位；Esc 关闭。
 */
export function Lightbox({
  images,
  index,
  base,
  token,
  onIndex,
  onClose,
  actions,
  src,
}: {
  images: Attachment[];
  index: number;
  base: string;
  token: string | undefined;
  onIndex: (index: number) => void;
  onClose: () => void;
  /** 工具栏右侧的额外按钮（产物面板放「下载」「定位到消息」） */
  actions?: (current: Attachment) => ReactNode;
  /** 直接给出图片地址（工作区面板的临时链接），不按附件 id 去取 */
  src?: string;
}) {
  const current = images[index]!;
  const fetched = useAttachmentUrl(base, token, current.id, !src);
  const url = src ?? fetched.url;
  const error = src ? undefined : fetched.error;
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | undefined>(undefined);
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [wheeling, setWheeling] = useState(false);
  const wheelTimer = useRef<number | undefined>(undefined);
  // 捏合时一帧会来好几个 wheel 事件，按最新值累乘，不用等重新渲染
  const view = useRef({ zoom, offset });
  view.current = { zoom, offset };
  const count = images.length;
  const go = useCallback(
    (step: number) => {
      if (count < 2) return;
      onIndex((index + step + count) % count);
    },
    [count, index, onIndex],
  );
  const zoomTo = useCallback((next: number) => {
    const value = clampZoom(next);
    setZoom(value);
    if (value <= 1) setOffset({ x: 0, y: 0 });
  }, []);

  // 滚轮 / 捏合缩放：以指针所在位置为中心，按滚动量平滑缩放。要拦住浏览器自己的页面缩放，
  // 得用非 passive 的原生监听（React 的 onWheel 是 passive，preventDefault 无效）
  useEffect(() => {
    const stage = rootRef.current;
    if (!stage || !url) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const { zoom: from, offset: was } = view.current;
      const to = clampZoom(from * wheelZoomFactor(event));
      if (to === from) return;
      // 连续滚动 / 捏合时每个事件直接到位，不走过渡动画，否则动画追着新目标跑会一顿一顿的
      setWheeling(true);
      window.clearTimeout(wheelTimer.current);
      wheelTimer.current = window.setTimeout(() => setWheeling(false), 150);
      // 图片在舞台里居中，没平移没缩放时的中心就是舞台中心。不读图片自己的位置：快速捏合时
      // 一帧里连来好几个事件，图片还没按上一次的结果重绘（或还在过渡动画里），读到的是旧位置，会抖
      const rect = stageRef.current?.getBoundingClientRect();
      const cx = rect ? rect.left + rect.width / 2 : event.clientX;
      const cy = rect ? rect.top + rect.height / 2 : event.clientY;
      const px = event.clientX - cx;
      const py = event.clientY - cy;
      const ratio = to / from;
      // 放大：指针下的那一点缩放后仍在指针下。缩小：平移量随缩放连续收回，到 100% 正好回到居中，
      // 不会在跨过 100% 那一下突然跳回中间
      const next =
        to <= 1
          ? { x: 0, y: 0 }
          : ratio < 1 && from > 1
            ? { x: (was.x * (to - 1)) / (from - 1), y: (was.y * (to - 1)) / (from - 1) }
            : { x: px - (px - was.x) * ratio, y: py - (py - was.y) * ratio };
      view.current = { zoom: to, offset: next };
      setZoom(to);
      setOffset(next);
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      stage.removeEventListener("wheel", onWheel);
      window.clearTimeout(wheelTimer.current);
    };
  }, [url]);

  // 换图时复位缩放；相邻的图预先取回，切换不用等
  useEffect(() => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
    if (!token || count < 2 || src) return;
    for (const step of [1, -1]) {
      void fetchAttachmentUrl(base, token, images[(index + step + count) % count]!.id).catch(
        () => undefined,
      );
    }
  }, [base, count, images, index, token, src]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      else if (event.key === "ArrowRight") go(1);
      else if (event.key === "ArrowLeft") go(-1);
      else if (event.key === "+" || event.key === "=") zoomTo(zoom * 1.5);
      else if (event.key === "-" || event.key === "_") zoomTo(zoom / 1.5);
      else if (event.key === "0") zoomTo(1);
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [go, onClose, zoom, zoomTo]);

  return createPortal(
    <div
      ref={rootRef}
      className="attachment-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={current.name}
      onClick={onClose}
    >
      <div className="attachment-lightbox-stage" ref={stageRef}>
        {url ? (
          <img
            src={url}
            alt={current.name}
            draggable={false}
            className={
              [zoom > 1 && "zoomed", wheeling && "wheeling"].filter(Boolean).join(" ") || undefined
            }
            style={{
              transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
            }}
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={() => zoomTo(zoom > 1 ? 1 : 2.5)}
            onPointerDown={(event) => {
              if (zoom <= 1) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              drag.current = {
                x: event.clientX,
                y: event.clientY,
                ox: offset.x,
                oy: offset.y,
              };
            }}
            onPointerMove={(event) => {
              const start = drag.current;
              if (!start) return;
              setOffset({
                x: start.ox + event.clientX - start.x,
                y: start.oy + event.clientY - start.y,
              });
            }}
            onPointerUp={() => {
              drag.current = undefined;
            }}
          />
        ) : (
          <span className="attachment-lightbox-status">{error ?? t("加载中…")}</span>
        )}
      </div>
      {count > 1 && (
        <>
          <Tooltip content={t("上一张")} shortcut={["←"]}>
            <button
              type="button"
              className="attachment-lightbox-nav prev"
              aria-label={t("上一张")}
              onClick={(event) => {
                event.stopPropagation();
                go(-1);
              }}
            >
              ‹
            </button>
          </Tooltip>
          <Tooltip content={t("下一张")} shortcut={["→"]}>
            <button
              type="button"
              className="attachment-lightbox-nav next"
              aria-label={t("下一张")}
              onClick={(event) => {
                event.stopPropagation();
                go(1);
              }}
            >
              ›
            </button>
          </Tooltip>
        </>
      )}
      <div className="attachment-lightbox-toolbar" onClick={(event) => event.stopPropagation()}>
        {count > 1 && (
          <span className="attachment-lightbox-count">
            {index + 1} / {count}
          </span>
        )}
        <span className="attachment-lightbox-name" title={current.name}>
          {current.name}
        </span>
        <Tooltip content={t("缩小")} shortcut={["-"]}>
          <button
            type="button"
            className="attachment-lightbox-step"
            aria-label={t("缩小")}
            disabled={zoom <= MIN_ZOOM}
            onClick={() => zoomTo(zoom / 1.5)}
          >
            −
          </button>
        </Tooltip>
        <Tooltip content={t("复位缩放")} shortcut={["0"]}>
          <button
            type="button"
            className="attachment-lightbox-zoom"
            aria-label={t("复位缩放")}
            onClick={() => zoomTo(1)}
          >
            {Math.round(zoom * 100)}%
          </button>
        </Tooltip>
        <Tooltip content={t("放大")} shortcut={["+"]}>
          <button
            type="button"
            className="attachment-lightbox-step"
            aria-label={t("放大")}
            disabled={zoom >= MAX_ZOOM}
            onClick={() => zoomTo(zoom * 1.5)}
          >
            +
          </button>
        </Tooltip>
        {actions?.(current)}
      </div>
      <button
        type="button"
        className="attachment-lightbox-close"
        aria-label={t("关闭")}
        onClick={onClose}
      >
        ×
      </button>
    </div>,
    document.body,
  );
}

export function MessageAttachments({
  attachments,
  base,
  token,
  onDock,
}: {
  attachments: Attachment[];
  base: string;
  token: string | undefined;
  /** 给了就在文件预览顶部显示「在右侧栏打开」 */
  onDock?: (attachment: Attachment) => void;
}): ReactNode {
  const [open, setOpen] = useState<number>();
  const images = attachments.filter((item) => item.kind === "image");
  const files = attachments.filter((item) => item.kind !== "image");
  const close = useCallback(() => setOpen(undefined), []);
  return (
    <div className="message-attachments">
      {images.length > 0 && (
        <div className={`message-images count-${Math.min(images.length, 3)}`}>
          {images.map((item, index) => (
            <ImageAttachment
              key={item.id}
              attachment={item}
              base={base}
              token={token}
              onOpen={() => setOpen(index)}
            />
          ))}
        </div>
      )}
      {files.map((item) => (
        <FileAttachment key={item.id} attachment={item} base={base} token={token} onDock={onDock} />
      ))}
      {open !== undefined && images[open] && (
        <Lightbox
          images={images}
          index={open}
          base={base}
          token={token}
          onIndex={setOpen}
          onClose={close}
        />
      )}
    </div>
  );
}
