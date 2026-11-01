import { openAsBlob } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_ATTACHMENT_BYTES } from "./hive-protocol.js";
import type { AgentAccessMode } from "./responder.js";

/**
 * Agent 在最终回复末尾显式声明要随回复发出的文件：开始和结束标记各占一行，中间每行一个路径。
 * 只认回复结尾的这一段，正文里顺带提到标记（例如解释用法）不会被当成声明。
 */
const directivePattern =
  /(?:^|\r?\n)[ \t]*<hive-attachments>[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*<\/hive-attachments>[ \t]*$/i;
const MAX_PUBLISHED = 10;

export type AttachmentDirective = { text: string; paths: string[] };

/** file:// 链接按 URL 规则还原成本机路径（Windows 的 file:///C:/x 是 C:\x，不是 /C:/x） */
function fromFileUrl(value: string): string {
  if (!/^file:\/\//i.test(value)) return value;
  try {
    return fileURLToPath(value);
  } catch {
    return value.replace(/^file:\/\//i, "");
  }
}

/** 取出回复里的附件声明并从正文中去掉；没有声明时原样返回 */
export function parseAttachmentDirective(text: string): AttachmentDirective {
  const paths: string[] = [];
  const stripped = text.trimEnd().replace(directivePattern, (_match, body: string) => {
    for (const line of body.split(/\r?\n/)) {
      const value = fromFileUrl(
        line
          .trim()
          .replace(/^[-*]\s+/, "")
          .replace(/^`(.*)`$/, "$1")
          .trim(),
      );
      if (value && !paths.includes(value)) paths.push(value);
    }
    return "";
  });
  return paths.length ? { text: stripped.trim(), paths } : { text, paths };
}

export type PublishFailure = { path: string; reason: string };
export type PublishResult = { attachmentIds: string[]; failures: PublishFailure[] };

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * 把 Agent 声明的本机文件上传为房间附件。文件读取和上传都发生在 Agent 所在的机器上（本 Bridge），
 * Server 从不按传入的路径读盘。能读到文件不等于获准公开：
 * - 只读档一律不发布；
 * - 其它档位只允许工作目录（cwd）内的普通文件，按真实路径判断，符号链接逃出 cwd 也拒绝。
 */
export class AttachmentPublisher {
  constructor(
    private readonly options: {
      serverUrl: string;
      roomId: string;
      token: string;
      cwd: string;
      access: AgentAccessMode;
      fetch?: typeof fetch;
    },
  ) {}

  async publish(paths: string[]): Promise<PublishResult> {
    const attachmentIds: string[] = [];
    const failures: PublishFailure[] = [];
    for (const [index, raw] of paths.entries()) {
      if (index >= MAX_PUBLISHED) {
        failures.push({ path: raw, reason: `一条回复最多 ${MAX_PUBLISHED} 个附件` });
        continue;
      }
      try {
        attachmentIds.push(await this.publishOne(raw));
      } catch (error) {
        failures.push({
          path: raw,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { attachmentIds, failures };
  }

  private async publishOne(raw: string): Promise<string> {
    if (this.options.access === "read-only") {
      throw new Error("只读权限的 Agent 不能发布本机文件");
    }
    const root = await realpath(this.options.cwd);
    const resolved = await realpath(path.resolve(root, raw)).catch(() => {
      throw new Error("文件不存在");
    });
    if (!isInside(root, resolved)) throw new Error("只能发布工作目录内的文件");
    const info = await stat(resolved);
    if (!info.isFile()) throw new Error("不是普通文件");
    if (info.size > MAX_ATTACHMENT_BYTES) throw new Error("超过 20 MB");
    const form = new FormData();
    form.append("file", await openAsBlob(resolved), path.basename(resolved));
    const response = await (this.options.fetch ?? fetch)(
      new URL(
        `/api/rooms/${encodeURIComponent(this.options.roomId)}/attachments`,
        this.options.serverUrl,
      ),
      { method: "POST", headers: { Authorization: `Bearer ${this.options.token}` }, body: form },
    );
    const body = (await response.json().catch(() => ({}))) as { id?: string; error?: string };
    if (response.status !== 201 || !body.id) {
      throw new Error(body.error ?? `上传失败（${response.status}）`);
    }
    return body.id;
  }
}

/** 没能发出的附件写进回复末尾，人和 Agent 都能看到原因 */
export function describeFailures(failures: PublishFailure[]): string {
  if (failures.length === 0) return "";
  return `\n\n（以下附件没有发出：${failures
    .map((failure) => `${path.basename(failure.path)} — ${failure.reason}`)
    .join("；")}）`;
}
