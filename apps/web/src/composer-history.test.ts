import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@superhive/protocol";
import { composerHistory, stepComposerHistory, type HistoryStep } from "./composer-history";

function message(content: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    roomId: "build",
    seq: 1,
    senderId: "00000000-0000-4000-8000-000000000002",
    senderName: "rd",
    senderType: "human",
    content,
    mentions: [],
    traceId: "00000000-0000-4000-8000-000000000003",
    hopCount: 0,
    createdAt: "2026-10-31T00:00:00.000Z",
    ...overrides,
  };
}

function step(overrides: Partial<HistoryStep>): string | undefined {
  const draft = overrides.draft ?? "";
  return stepComposerHistory({
    history: ["最新", "中间", "最早"],
    draft,
    browsing: undefined,
    direction: "older",
    selectionStart: draft.length,
    selectionEnd: draft.length,
    ...overrides,
  });
}

describe("composerHistory", () => {
  it("只取自己手打的消息，最新在前且去重", () => {
    expect(
      composerHistory(
        [
          message("早"),
          message("别人说的", { senderName: "other" }),
          message("同名 Agent", { senderType: "agent" }),
          message("晚"),
          message("早"),
          message("", { deletedAt: "2026-10-31T00:00:00.000Z" }),
          message("开启了新话题", { kind: "topic" }),
          message("选择 A", { answer: { questionMessageId: "q", selected: ["A"] } } as never),
        ],
        "rd",
      ),
    ).toEqual(["早", "晚"]);
  });
});

describe("stepComposerHistory", () => {
  it("空输入框按上进入最新一条，按下不接管", () => {
    expect(step({})).toBe("最新");
    expect(step({ direction: "newer" })).toBeUndefined();
    expect(step({ history: [] })).toBeUndefined();
  });

  it("正在写的内容不被替换", () => {
    expect(step({ draft: "写到一半" })).toBeUndefined();
    expect(step({ draft: "最新改了", browsing: "最新" })).toBeUndefined();
  });

  it("上下翻动，到最早停住，翻过最新回到空", () => {
    expect(step({ draft: "最新", browsing: "最新" })).toBe("中间");
    expect(step({ draft: "最早", browsing: "最早" })).toBe("最早");
    expect(step({ draft: "最早", browsing: "最早", direction: "newer" })).toBe("中间");
    expect(step({ draft: "最新", browsing: "最新", direction: "newer" })).toBe("");
  });

  it("光标在文字中间或有选区时方向键照常移动", () => {
    const multiline = { draft: "最新", browsing: "最新" };
    expect(step({ ...multiline, selectionStart: 1, selectionEnd: 1 })).toBeUndefined();
    expect(step({ ...multiline, selectionStart: 0, selectionEnd: 2 })).toBeUndefined();
    expect(step({ ...multiline, selectionStart: 0, selectionEnd: 0 })).toBe("中间");
  });
});
