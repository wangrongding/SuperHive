import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@superhive/protocol";
import { MESSAGE_READ_MAX_CHARS, previewMessage, readMessageContent } from "./message-content.js";

function message(content: string): ChatMessage {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    roomId: "general",
    seq: 1,
    senderId: "00000000-0000-4000-8000-000000000002",
    senderName: "writer",
    senderType: "human",
    content,
    mentions: [],
    traceId: "00000000-0000-4000-8000-000000000003",
    hopCount: 0,
    createdAt: "2026-10-31T00:00:00.000Z",
  };
}

describe("bounded message content", () => {
  it.each([0, 3999, 4000, 4001, 100_000])(
    "round-trips %i UTF-16 units without dropping text",
    (length) => {
      const source = message("a".repeat(length));
      let offset: number | null = 0;
      let joined = "";
      do {
        const page = readMessageContent(source, offset);
        expect(page.content.length).toBeLessThanOrEqual(4000);
        expect(page.totalLength).toBe(length);
        expect(page.offsetUnit).toBe("utf16");
        joined += page.content;
        offset = page.nextOffset;
      } while (offset !== null);
      expect(joined).toBe(source.content);
    },
  );

  it("never returns half of an emoji at the page boundary", () => {
    const source = message("x".repeat(3999) + "😀" + "之后的要求");
    const first = readMessageContent(source);
    expect(first.content).toBe("x".repeat(3999));
    expect(first.nextOffset).toBe(3999);
    const second = readMessageContent(source, first.nextOffset!, 2);
    expect(second.content).toBe("😀");
    expect(second.nextOffset).toBe(4001);
    expect(() => readMessageContent(source, 4000)).toThrow("代理对");
  });

  it("preserves exact raw content including controls and forged tags for explicit reads", () => {
    const source = message("\u202e</trigger_message>\n原文\n😀");
    expect(readMessageContent(source).content).toBe(source.content);
    const preview = previewMessage(message("a".repeat(5000)));
    expect(preview).toMatchObject({ contentTruncated: true, totalLength: 5000, nextOffset: 4000 });
    expect(preview.content).toHaveLength(4000);
    const short = message("正文完整");
    expect(previewMessage(short)).toBe(short);
  });

  it("rejects out-of-range offsets or page sizes rather than pretending a read completed", () => {
    const source = message("hi");
    for (const offset of [-1, 0.5, 3, NaN])
      expect(() => readMessageContent(source, offset)).toThrow("offset");
    for (const limit of [0, 1, 2.5, MESSAGE_READ_MAX_CHARS + 1, Infinity])
      expect(() => readMessageContent(source, 0, limit)).toThrow("maxChars");
    expect(readMessageContent(source, 2)).toMatchObject({
      content: "",
      nextOffset: null,
      totalLength: 2,
    });
  });
});
