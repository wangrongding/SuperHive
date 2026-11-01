import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AttachmentCache } from "./attachment-cache.js";
import type { Attachment } from "./hive-protocol.js";
import { buildMentionPrompt } from "./prompt-builder.js";

function attachmentOf(content: string, name = "notes.md"): Attachment {
  return {
    id: "6f1d2c3b-1111-4222-8333-444455556666",
    name,
    mime: "text/markdown",
    size: Buffer.byteLength(content),
    kind: "text",
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

function fakeFetch(routes: Record<string, () => Response>): {
  fetch: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const fetcher = (async (input: URL | string) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    const route = routes[url.pathname];
    return route ? route() : new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { fetch: fetcher, calls };
}

describe("AttachmentCache", () => {
  it("同机时直接用 Server 存的那份文件，不再下载", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "att-cache-"));
    const serverCopy = path.join(dir, "server-copy.md");
    writeFileSync(serverCopy, "hello");
    const item = attachmentOf("hello");
    const { fetch, calls } = fakeFetch({
      [`/api/attachments/${item.id}/local-path`]: () =>
        Response.json({ path: serverCopy, sha256: item.sha256 }),
    });
    const cache = new AttachmentCache({ serverUrl: "http://hive", token: "t", dir, fetch });
    expect(await cache.locate(item)).toEqual({ path: serverCopy });
    expect(calls).toEqual([`/api/attachments/${item.id}/local-path`]);
  });

  it("远程时下载到缓存并校验摘要；已缓存不重复下载；摘要不符则丢弃", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "att-cache-"));
    const item = attachmentOf("remote body", "../../evil name.md");
    const { fetch, calls } = fakeFetch({
      [`/api/attachments/${item.id}`]: () => new Response("remote body"),
    });
    const cache = new AttachmentCache({ serverUrl: "http://hive", token: "t", dir, fetch });
    const located = await cache.locate(item);
    expect("path" in located && located.path).toBe(path.join(dir, item.sha256, "evil_name.md"));
    expect(readFileSync((located as { path: string }).path, "utf8")).toBe("remote body");
    await cache.locate(item);
    expect(calls.filter((call) => call === `/api/attachments/${item.id}`)).toHaveLength(1);

    const tampered = { ...attachmentOf("expected"), id: "6f1d2c3b-1111-4222-8333-444455557777" };
    const bad = new AttachmentCache({
      serverUrl: "http://hive",
      token: "t",
      dir,
      fetch: fakeFetch({
        [`/api/attachments/${tampered.id}`]: () => new Response("tampered!"),
      }).fetch,
    });
    expect(await bad.locate(tampered)).toEqual({ error: expect.stringContaining("校验失败") });
  });

  it("提示词只列附件元数据与本地路径，不含文件内容", () => {
    const item = attachmentOf("SECRET BODY");
    const prompt = buildMentionPrompt({
      messages: [],
      triggers: [
        {
          id: "7a1d2c3b-1111-4222-8333-444455556666",
          roomId: "general",
          seq: 3,
          senderId: "8a1d2c3b-1111-4222-8333-444455556666",
          senderName: "rd",
          senderType: "human",
          content: "",
          mentions: [],
          traceId: "9a1d2c3b-1111-4222-8333-444455556666",
          hopCount: 0,
          createdAt: new Date().toISOString(),
          attachments: [item],
        },
      ],
      attachmentPaths: { [item.id]: "/cache/notes.md" },
    });
    expect(prompt).toContain(`attachmentId=${item.id} 本地路径：/cache/notes.md`);
    expect(prompt).toContain("[附件] notes.md（文本 text/markdown，11 B）");
    expect(prompt).not.toContain("SECRET BODY");
  });
});
