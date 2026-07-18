// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@ai-hive/protocol";
import { buildShareMarkdown, downloadFile, shareFilename } from "./share";

function makeMessage(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    roomId: "general",
    seq: 1,
    senderId: "00000000-0000-4000-8000-000000000002",
    senderName: "Alice",
    senderType: "human",
    content: "你好",
    mentions: [],
    traceId: "00000000-0000-4000-8000-000000000003",
    hopCount: 0,
    createdAt: "2026-07-18T14:00:00.000Z",
    ...overrides,
  };
}

describe("buildShareMarkdown", () => {
  it("按 seq 排序并包含发送者、Agent 标记和原文", () => {
    const markdown = buildShareMarkdown(
      [
        makeMessage({ id: "b", seq: 2, senderName: "bot", senderType: "agent", content: "回复" }),
        makeMessage({ id: "a", seq: 1, content: "提问 **加粗**" }),
      ],
      "general",
    );
    expect(markdown).toContain("# AI Hive · #general 对话分享");
    expect(markdown).toContain("共 2 条消息");
    expect(markdown.indexOf("提问 **加粗**")).toBeLessThan(markdown.indexOf("回复"));
    expect(markdown).toContain("**bot** `AGENT`");
    expect(markdown).toContain("· #1");
    expect(markdown).toContain("· #2");
    expect(markdown).not.toContain("**Alice** `AGENT`");
  });
});

describe("shareFilename", () => {
  it("生成带房间和时间戳的文件名", () => {
    expect(shareFilename("general", "md")).toMatch(/^ai-hive-general-\d{8}-\d{4}\.md$/);
  });
});

describe("downloadFile", () => {
  it("通过临时 a 标签触发下载并清理 DOM", () => {
    const created: string[] = [];
    URL.createObjectURL = (blob: Blob) => {
      created.push(`blob:${blob.size}`);
      return "blob:mock";
    };
    URL.revokeObjectURL = () => undefined;
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    downloadFile("test.md", "内容");
    expect(created).toHaveLength(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(document.querySelector("a[download]")).toBeNull();
    click.mockRestore();
  });
});
