import { describe, expect, it } from "vitest";
import {
  artifactCategory,
  artifactGroupKey,
  artifactsQuerySchema,
  matchesArtifactFilter,
  roomWorkspaceSchema,
  isMentioned,
  parseMentions,
  stripUnsafeCharacters,
  whiteboardArchiveRequestSchema,
  whiteboardRemovedEventSchema,
  roomClearRequestSchema,
  metaResponseSchema,
} from "./index.js";

describe("feedback metadata wire compatibility", () => {
  const meta = {
    name: "SuperHive",
    roomId: "general",
    httpUrl: "https://example.com",
    wsUrl: "wss://example.com/ws",
    mcpUrl: "https://example.com/mcp",
  };
  it("accepts older metadata and strips unexpected diagnostic fields", () => {
    expect(metaResponseSchema.parse(meta)).toEqual(meta);
    expect(
      metaResponseSchema.parse({
        ...meta,
        feedback: {
          version: "0.4.8",
          commit: "abcdef0123456789",
          runMode: "source",
          token: "private",
        },
      }).feedback,
    ).toEqual({ version: "0.4.8", commit: "abcdef0123456789", runMode: "source" });
    expect(
      metaResponseSchema.safeParse({ ...meta, feedback: { version: "0.4.8", runMode: "unknown" } })
        .success,
    ).toBe(false);
  });
});

describe("whiteboard lifecycle wire compatibility", () => {
  const entry = { id: "00000000-0000-4000-8000-000000000001", updatedAt: "2026-11-16T00:00:00Z" };
  it("requires bounded, unique versioned selections", () => {
    expect(whiteboardArchiveRequestSchema.safeParse({ entries: [entry] }).success).toBe(true);
    for (const entries of [
      [],
      [entry, entry],
      [{ id: entry.id }],
      Array.from({ length: 201 }, () => entry),
    ]) {
      expect(whiteboardArchiveRequestSchema.safeParse({ entries }).success).toBe(false);
    }
  });
  it("still accepts legacy removal events without archive metadata", () => {
    expect(
      whiteboardRemovedEventSchema.parse({
        type: "whiteboard.removed",
        roomId: "general",
        entryId: entry.id,
      }),
    ).toEqual({ type: "whiteboard.removed", roomId: "general", entryId: entry.id });
  });
  it("defaults room clears to archive and validates optional complete-board versions", () => {
    expect(roomClearRequestSchema.parse({ username: " Alice " })).toEqual({
      username: "Alice",
      whiteboard: "archive",
    });
    expect(roomClearRequestSchema.safeParse({ username: "Alice", entries: [] }).success).toBe(true);
    expect(
      roomClearRequestSchema.safeParse({ username: "Alice", whiteboard: "keep" }).success,
    ).toBe(true);
    for (const input of [
      { username: "Alice", whiteboard: "delete" },
      { username: "Alice", entries: [entry, entry] },
      { username: "Alice", entries: [{ id: entry.id }] },
      { username: "Alice", whiteboard: "keep", entries: [] },
    ])
      expect(roomClearRequestSchema.safeParse(input).success).toBe(false);
  });
});

describe("mentions", () => {
  it("parses unicode names, de-duplicates case-insensitively, and ignores @all semantics", () => {
    expect(parseMentions("hi @frontend-agent @小王 and @Frontend-Agent")).toEqual([
      "frontend-agent",
      "小王",
    ]);
  });

  it("matches an exact username", () => {
    expect(isMentioned("hello @agent-a", "agent-a")).toBe(true);
    expect(isMentioned("hello @agent-ab", "agent-a")).toBe(false);
  });
});

describe("stripUnsafeCharacters", () => {
  it("removes control and bidi characters but keeps newlines, tabs and emoji joiners", () => {
    expect(stripUnsafeCharacters("a\u0000b\u001bc‮d⁦e\r\nf\tg")).toBe("abcde\nf\tg");
    expect(stripUnsafeCharacters("\u{1F469}‍\u{1F4BB} ok")).toBe("\u{1F469}‍\u{1F4BB} ok");
    expect(stripUnsafeCharacters("x y")).toBe("x\ny");
  });
});

describe("parseMentions 跳过代码", () => {
  it("行内代码与代码块里的提及不算，邮箱也不算", () => {
    expect(parseMentions("示例：正文开头写了 `@rd`，真正找 @alice")).toEqual(["alice"]);
    expect(parseMentions("``用 `@rd` 举例``")).toEqual([]);
    expect(parseMentions("```text\n@rd-codex 看下\n```\n@bob 你来")).toEqual(["bob"]);
    expect(parseMentions("~~~\n@rd\n")).toEqual([]);
    expect(parseMentions("未闭合的 ` 反引号 @carol")).toEqual(["carol"]);
    expect(parseMentions("邮件 me@example.com 与中文后直接@小明")).toEqual(["小明"]);
  });
});

describe("roomWorkspaceSchema", () => {
  it("accepts POSIX, home, Windows drive and UNC absolute paths, rejects relative ones", () => {
    for (const ok of [
      "/srv/app",
      "~",
      "~/code",
      "~\\code",
      "C:\\Users\\me\\code",
      "d:/work",
      "\\\\server\\share\\x",
    ]) {
      expect(roomWorkspaceSchema.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of ["code", "C:code", "./x", "\\\\"]) {
      expect(roomWorkspaceSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe("isResumableUnknown", () => {
  it("only lets a human continue unknowns the agent confirmed it no longer runs", async () => {
    const { isResumableUnknown } = await import("./index.js");
    const unknown = (key: string) => ({ status: "timed_out", detailText: { key } });
    expect(isResumableUnknown(unknown("bridge.crashedMidTurn"))).toBe(true);
    expect(isResumableUnknown(unknown("invocation.unacknowledged"))).toBe(true);
    for (const key of [
      "bridge.crashedRuntimeAlive",
      "bridge.alreadyEnded",
      "bridge.cancelNotPersisted",
      "bridge.steerEndRace",
      "invocation.stale",
    ])
      expect(isResumableUnknown(unknown(key)), key).toBe(false);
    expect(isResumableUnknown({ status: "failed", detailText: { key: "bridge.uncertain" } })).toBe(
      false,
    );
  });
});

describe("room artifacts", () => {
  const file = (
    name: string,
    kind: "image" | "text" | "file" = "file",
    mime = "application/octet-stream",
  ) => artifactCategory({ name, kind, mime });

  it("sorts attachments into image / document / code / data / archive / media / other", () => {
    expect(file("shot.png", "image", "image/png")).toBe("image");
    expect(file("report.pdf", "file", "application/pdf")).toBe("document");
    expect(file("README.md", "text", "text/markdown")).toBe("document");
    expect(file("page.html", "text", "text/plain")).toBe("document");
    expect(file("App.TSX", "text", "text/plain")).toBe("code");
    expect(file("Dockerfile", "text", "text/plain")).toBe("code");
    expect(file("diagram.svg", "text", "text/plain")).toBe("code");
    expect(file("rows.csv", "text", "text/csv")).toBe("data");
    expect(file("dist.tar.gz")).toBe("archive");
    expect(file("clip", "file", "video/mp4")).toBe("media");
    expect(file("notes", "text", "text/plain")).toBe("document");
    expect(file("blob.bin")).toBe("other");
  });

  it("filters, groups names case-insensitively per sender and validates queries", () => {
    expect(matchesArtifactFilter("code", "file")).toBe(true);
    expect(matchesArtifactFilter("image", "file")).toBe(false);
    expect(matchesArtifactFilter("image", "all")).toBe(true);
    expect(artifactGroupKey("a", "Report.MD")).toBe(artifactGroupKey("a", "report.md"));
    expect(artifactGroupKey("a", "report.md")).not.toBe(artifactGroupKey("b", "report.md"));
    expect(artifactsQuerySchema.parse({})).toEqual({ type: "all", q: "", limit: 60 });
    expect(artifactsQuerySchema.safeParse({ limit: "500" }).success).toBe(false);
    expect(artifactsQuerySchema.safeParse({ cursor: "1;drop" }).success).toBe(false);
  });
});
