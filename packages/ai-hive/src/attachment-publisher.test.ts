import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AttachmentPublisher,
  describeFailures,
  parseAttachmentDirective,
} from "./attachment-publisher.js";

describe("parseAttachmentDirective", () => {
  it("accepts Windows line endings and file:// URLs", () => {
    const parsed = parseAttachmentDirective(
      "做好了。\r\n\r\n<hive-attachments>\r\nout\\report.md\r\n</hive-attachments>\r\n",
    );
    expect(parsed).toEqual({ text: "做好了。", paths: ["out\\report.md"] });
    const url = process.platform === "win32" ? "file:///C:/repo/out.txt" : "file:///repo/out.txt";
    const expected = process.platform === "win32" ? "C:\\repo\\out.txt" : "/repo/out.txt";
    expect(
      parseAttachmentDirective(`ok\n<hive-attachments>\n${url}\n</hive-attachments>`).paths,
    ).toEqual([expected]);
  });

  it("取出回复末尾的附件声明并从正文去掉", () => {
    const parsed = parseAttachmentDirective(
      "做好了，见附件。\n\n<hive-attachments>\noutput/a.jpg\n- `output/b.png`\nfile:///tmp/c.txt\noutput/a.jpg\n</hive-attachments>\n",
    );
    expect(parsed.text).toBe("做好了，见附件。");
    expect(parsed.paths).toEqual(["output/a.jpg", "output/b.png", "/tmp/c.txt"]);
  });

  it("正文中途提到标记不算声明", () => {
    const text =
      "用法：在回复末尾写 <hive-attachments> 与 </hive-attachments> 包住路径。之后再说别的。";
    expect(parseAttachmentDirective(text)).toEqual({ text, paths: [] });
    const inline = "末尾写 <hive-attachments>a.png</hive-attachments>";
    expect(parseAttachmentDirective(inline).paths).toEqual([]);
  });
});

describe("AttachmentPublisher", () => {
  function setup(access: "read-only" | "workspace" | "full" = "workspace") {
    const base = mkdtempSync(path.join(tmpdir(), "att-pub-"));
    const cwd = path.join(base, "ws");
    mkdirSync(path.join(cwd, "out"), { recursive: true });
    writeFileSync(path.join(cwd, "out", "pic.png"), "png-bytes");
    writeFileSync(path.join(base, "secret.txt"), "top secret");
    symlinkSync(path.join(base, "secret.txt"), path.join(cwd, "link.txt"));
    const uploads: Array<{ url: string; auth: string | null; name: string }> = [];
    const fetcher = (async (input: URL | string, init?: RequestInit) => {
      const form = init?.body as FormData;
      const file = form.get("file") as File;
      uploads.push({
        url: String(input),
        auth: new Headers(init?.headers).get("authorization"),
        name: file.name,
      });
      return Response.json({ id: `id-${uploads.length}` }, { status: 201 });
    }) as typeof fetch;
    const publisher = new AttachmentPublisher({
      serverUrl: "http://hive",
      roomId: "general",
      token: "tok",
      cwd,
      access,
      fetch: fetcher,
    });
    return { publisher, uploads, base, cwd };
  }

  it("上传工作目录内的文件；目录外、符号链接逃逸、不存在的都拒绝", async () => {
    const { publisher, uploads, base, cwd } = setup();
    const result = await publisher.publish([
      "out/pic.png",
      path.join(base, "secret.txt"),
      "link.txt",
      "../secret.txt",
      "missing.png",
      cwd,
    ]);
    expect(result.attachmentIds).toEqual(["id-1"]);
    expect(uploads).toEqual([
      { url: "http://hive/api/rooms/general/attachments", auth: "Bearer tok", name: "pic.png" },
    ]);
    expect(result.failures.map((failure) => failure.reason)).toEqual([
      "只能发布工作目录内的文件",
      "只能发布工作目录内的文件",
      "只能发布工作目录内的文件",
      "文件不存在",
      "不是普通文件",
    ]);
    expect(describeFailures(result.failures)).toContain("secret.txt — 只能发布工作目录内的文件");
  });

  it("只读档一律不发布", async () => {
    const { publisher, uploads } = setup("read-only");
    const result = await publisher.publish(["out/pic.png"]);
    expect(result.attachmentIds).toEqual([]);
    expect(result.failures[0]?.reason).toContain("只读");
    expect(uploads).toEqual([]);
  });
});
