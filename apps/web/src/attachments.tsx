import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Attachment, UploadedAttachment } from "@ai-hive/protocol";

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
  return `粘贴图片-${stamp}${index ? `-${index + 1}` : ""}.${ext}`;
}

function uploadError(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: string };
    if (parsed.error) return parsed.error;
  } catch {
    // 非 JSON 响应按状态码说明
  }
  if (status === 413) return "文件太大或空间已满";
  if (status === 401 || status === 403) return "没有上传权限";
  return `上传失败（${status || "网络错误"}）`;
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
        patch(localId, { status: "error", error: "尚未连接 Hive Server" });
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
        patch(localId, { status: "error", error: "网络错误，上传失败" });
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
      if (room <= 0) return `一条消息最多 ${MAX_ATTACHMENTS_PER_MESSAGE} 个附件`;
      let notice: string | undefined;
      const accepted: QueuedAttachment[] = [];
      let total = current.reduce((sum, item) => sum + item.size, 0);
      files.forEach((file, index) => {
        if (accepted.length >= room) {
          notice = `一条消息最多 ${MAX_ATTACHMENTS_PER_MESSAGE} 个附件，多出的没有加入`;
          return;
        }
        if (file.size > MAX_ATTACHMENT_BYTES) {
          notice = `${file.name || "文件"} 超过 20 MB，没有加入`;
          return;
        }
        if (total + file.size > MAX_MESSAGE_ATTACHMENT_BYTES) {
          notice = "一条消息的附件合计不能超过 50 MB";
          return;
        }
        total += file.size;
        const name = nameForPastedFile(file, index);
        const isImage = /^image\/(png|jpeg|gif|webp)$/.test(file.type);
        accepted.push({
          localId: crypto.randomUUID(),
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

function FileGlyph({ kind }: { kind: Attachment["kind"] | "pending" }) {
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
    <ul className="composer-attachments" aria-label="待发送的附件">
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
                    ? `上传中 ${Math.round(item.progress * 100)}%`
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
            <button
              type="button"
              className="composer-attachment-retry"
              onClick={() => onRetry(item.localId)}
              aria-label={`重试上传 ${item.name}`}
              title={`${item.error ?? "上传失败"}，点击重试`}
            >
              重试
            </button>
          )}
          <button
            type="button"
            className="composer-attachment-remove"
            onClick={() => onRemove(item.localId)}
            aria-label={`移除 ${item.name}`}
            title={item.status === "uploading" ? "取消上传" : "移除"}
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}

/* ---------- 消息里的附件：凭 Bearer 取回文件，生成本地 object URL ---------- */

const blobCache = new Map<string, Promise<string>>();

/** 同一附件在页面内只取一次；失败的不缓存，下次再试 */
export function fetchAttachmentUrl(base: string, token: string, id: string): Promise<string> {
  const cached = blobCache.get(id);
  if (cached) return cached;
  const task = fetch(`${base}/api/attachments/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  }).then(async (response) => {
    if (!response.ok) {
      throw new Error(
        response.status === 410 ? "附件已撤回或过期" : `无法读取附件（${response.status}）`,
      );
    }
    return URL.createObjectURL(await response.blob());
  });
  blobCache.set(id, task);
  task.catch(() => blobCache.delete(id));
  return task;
}

function useAttachmentUrl(base: string, token: string | undefined, id: string, enabled: boolean) {
  const [state, setState] = useState<{ url?: string; error?: string }>({});
  useEffect(() => {
    if (!enabled || !token) return;
    let alive = true;
    fetchAttachmentUrl(base, token, id).then(
      (url) => alive && setState({ url }),
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
    <button
      type="button"
      className={`message-image${error ? " failed" : ""}`}
      style={ratio ? { aspectRatio: `${Math.min(Math.max(ratio, 0.5), 3)}` } : undefined}
      onClick={(event) => {
        event.stopPropagation();
        if (url) onOpen(url);
      }}
      disabled={!url}
      aria-label={`查看图片 ${attachment.name}`}
      title={error ?? attachment.name}
    >
      {url ? <img src={url} alt={attachment.name} /> : <span>{error ?? "加载中…"}</span>}
    </button>
  );
}

function FileAttachment({
  attachment,
  base,
  token,
}: {
  attachment: Attachment;
  base: string;
  token: string | undefined;
}) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function download() {
    if (!token || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const url = await fetchAttachmentUrl(base, token, attachment.id);
      const link = document.createElement("a");
      link.href = url;
      link.download = attachment.name;
      link.rel = "noopener";
      link.click();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <button
      type="button"
      className="message-file"
      onClick={(event) => {
        event.stopPropagation();
        void download();
      }}
      title={error ?? `下载 ${attachment.name}`}
      aria-label={`下载 ${attachment.name}`}
    >
      <span className="message-file-icon">
        <FileGlyph kind={attachment.kind} />
      </span>
      <span className="message-file-copy">
        <strong>{attachment.name}</strong>
        <small className={error ? "danger" : undefined}>
          {error ?? (busy ? "下载中…" : `${formatBytes(attachment.size)} · 点击下载`)}
        </small>
      </span>
    </button>
  );
}

function Lightbox({ url, name, onClose }: { url: string; name: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div className="attachment-lightbox" role="dialog" aria-label={name} onClick={onClose}>
      <img src={url} alt={name} onClick={(event) => event.stopPropagation()} />
      <button
        type="button"
        className="attachment-lightbox-close"
        aria-label="关闭"
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
}: {
  attachments: Attachment[];
  base: string;
  token: string | undefined;
}): ReactNode {
  const [open, setOpen] = useState<{ url: string; name: string }>();
  const images = attachments.filter((item) => item.kind === "image");
  const files = attachments.filter((item) => item.kind !== "image");
  const close = useCallback(() => setOpen(undefined), []);
  return (
    <div className="message-attachments">
      {images.length > 0 && (
        <div className={`message-images count-${Math.min(images.length, 3)}`}>
          {images.map((item) => (
            <ImageAttachment
              key={item.id}
              attachment={item}
              base={base}
              token={token}
              onOpen={(url) => setOpen({ url, name: item.name })}
            />
          ))}
        </div>
      )}
      {files.map((item) => (
        <FileAttachment key={item.id} attachment={item} base={base} token={token} />
      ))}
      {open && <Lightbox url={open.url} name={open.name} onClose={close} />}
    </div>
  );
}
