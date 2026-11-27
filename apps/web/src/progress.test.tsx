// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, Invocation, WhiteboardEntry } from "@superhive/protocol";
import { ProgressPanel, activeCount, buildProgress, progressHeadline } from "./progress";

const agentId = "00000000-0000-4000-8000-000000000002";

function entry(overrides: Partial<WhiteboardEntry>): WhiteboardEntry {
  return {
    id: crypto.randomUUID(),
    roomId: "build",
    key: "task",
    slot: "in_progress",
    summary: "做登录页",
    unblocks: [],
    authorId: agentId,
    authorName: "helper",
    createdAt: "2026-11-20T00:00:00.000Z",
    updatedAt: "2026-11-20T00:00:00.000Z",
    ...overrides,
  };
}

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: crypto.randomUUID(),
    roomId: "build",
    seq: 1,
    senderId: agentId,
    senderName: "helper",
    senderType: "agent",
    content: "hello",
    mentions: [],
    traceId: crypto.randomUUID(),
    hopCount: 0,
    createdAt: "2026-11-20T00:00:00.000Z",
    ...overrides,
  };
}

function invocation(overrides: Partial<Invocation>): Invocation {
  return {
    id: crypto.randomUUID(),
    roomId: "build",
    messageId: crypto.randomUUID(),
    agentId,
    agentName: "helper",
    requesterName: "rd",
    requesterType: "human",
    status: "running",
    attempts: 1,
    createdAt: "2026-11-20T00:00:00.000Z",
    updatedAt: "2026-11-20T00:00:00.000Z",
    ...overrides,
  };
}

describe("progressHeadline", () => {
  it("keeps only the first plain sentence", () => {
    expect(progressHeadline("右侧栏改成进展视图。基于 main 2436b96，web431 通过")).toBe(
      "右侧栏改成进展视图",
    );
    expect(progressHeadline("#4003 已实现精简公开回执；19 文件已暂存")).toBe("已实现精简公开回执");
    expect(progressHeadline("#3484房主授权将文档改造优化提交")).toBe("房主授权将文档改造优化提交");
    expect(progressHeadline("6a72f0a 已提交，待 review：任务目录列状态不再抢写锁")).toBe(
      "已提交，待 review：任务目录列状态不再抢写锁",
    );
  });

  it("truncates long legacy summaries", () => {
    const headline = progressHeadline("很".repeat(100));
    expect([...headline]).toHaveLength(60);
    expect(headline.endsWith("…")).toBe(true);
  });
});

describe("buildProgress", () => {
  it("distinguishes queued and stopping tasks and excludes recalled processes", () => {
    const groups = buildProgress({
      roomId: "build",
      entries: [],
      messages: [],
      invocations: [
        invocation({ status: "queued" }),
        invocation({ status: "cancelling" }),
        invocation({ status: "running", messageRecalled: true }),
      ],
    });
    expect(groups.doing.map((item) => item.title)).toEqual([
      "helper 的任务正在排队",
      "helper 的任务正在停止",
    ]);
  });

  it("separates attention, running work, ready work and milestones", () => {
    const trigger = message({ seq: 10, senderType: "human", senderName: "rd" });
    const question = message({
      seq: 11,
      kind: "question",
      parentMessageId: trigger.id,
      content:
        "@rd ❓ 要不要顺手清掉旧条目？两条都已合入\n（直接回复这条消息即可把答案交给 helper）",
      text: {
        key: "question.ask",
        params: { asker: "@rd ", question: "要不要顺手清掉旧条目？两条都已合入" },
      },
    });
    const groups = buildProgress({
      roomId: "build",
      entries: [
        entry({ key: "a", slot: "in_progress", summary: "在做 A" }),
        entry({ key: "b", slot: "ready", summary: "B 做完了" }),
        entry({ key: "c", slot: "blocked", summary: "C 卡住了" }),
        entry({
          key: "d",
          slot: "milestone",
          summary: "D 合入了",
          mergedAt: "2026-11-20T01:00:00.000Z",
        }),
        entry({
          key: "e",
          slot: "milestone",
          summary: "归档的",
          archivedAt: "2026-11-20T01:00:00.000Z",
        }),
        entry({ key: "worktree:x", slot: "in_progress", summary: "目录登记" }),
      ],
      invocations: [
        invocation({ status: "waiting_human", messageId: trigger.id }),
        invocation({ status: "blocked" }),
        invocation({ status: "running" }),
        invocation({ status: "waiting_human", roomId: "other" }),
      ],
      messages: [trigger, question],
    });
    expect(groups.attention.map((item) => item.title)).toEqual([
      "helper 在问：要不要顺手清掉旧条目？",
      "helper 的任务被拦下，等你放行",
    ]);
    expect(groups.attention[0]!.target).toMatchObject({ messageId: question.id, messageSeq: 11 });
    expect(groups.attention[0]!.badge?.label).toBe("等你回答 · 提问 #11");
    expect(groups.doing.map((item) => [item.title, item.badge?.label])).toEqual([
      ["helper 正在处理", undefined],
      ["在做 A", undefined],
      ["C 卡住了", "卡住了"],
    ]);
    expect(groups.ready.map((item) => [item.title, item.badge?.label])).toEqual([
      ["B 做完了", "做完待验收"],
    ]);
    expect(groups.done.map((item) => [item.title, item.badge?.label])).toEqual([
      ["D 合入了", "已合入"],
    ]);
  });

  it("points a waiting question at the recorded question even when it is not loaded", () => {
    const recorded = invocation({
      status: "waiting_human",
      questionMessageId: "00000000-0000-4000-8000-0000000000aa",
      questionSeq: 42,
    });
    const legacy = invocation({ status: "waiting_human" });
    const groups = buildProgress({
      roomId: "build",
      entries: [],
      invocations: [recorded, legacy],
      messages: [],
    });
    expect(groups.attention.map((item) => [item.target, item.badge?.label])).toEqual([
      [
        expect.objectContaining({
          messageId: "00000000-0000-4000-8000-0000000000aa",
          messageSeq: 42,
        }),
        "等你回答 · 提问 #42",
      ],
      // 旧调用没有记下提问、提问又没载入：退回触发消息，跳转时再按旧办法往后找
      [expect.objectContaining({ messageId: legacy.messageId }), "等你回答"],
    ]);
  });

  it("links entries to their source message, a #seq in the summary, or the author's last message", () => {
    const sourceId = crypto.randomUUID();
    const said = message({ seq: 7, createdAt: "2026-11-19T23:59:00.000Z" });
    const later = message({ seq: 8, createdAt: "2026-11-20T03:00:00.000Z" });
    const groups = buildProgress({
      roomId: "build",
      entries: [
        entry({
          key: "a",
          messageId: sourceId,
          messageSeq: 5,
          updatedAt: "2026-11-20T00:03:00.000Z",
        }),
        entry({ key: "b", summary: "#4003 回执精简", updatedAt: "2026-11-20T00:02:00.000Z" }),
        entry({ key: "c", summary: "旧条目", updatedAt: "2026-11-20T00:01:00.000Z" }),
        entry({ key: "d", summary: "别人的", authorId: crypto.randomUUID() }),
      ],
      invocations: [],
      messages: [said, later],
    });
    expect(groups.doing.map((item) => item.target)).toEqual([
      { messageId: sourceId, messageSeq: 5 },
      { messageSeq: 4003 },
      { messageId: said.id, messageSeq: 7 },
      undefined,
    ]);
  });
});

describe("stale doing items", () => {
  afterEach(cleanup);

  const now = Date.parse("2026-11-20T12:00:00.000Z");
  const build = () =>
    buildProgress({
      roomId: "build",
      entries: [
        entry({ key: "old", summary: "三天前的", updatedAt: "2026-11-17T11:00:00.000Z" }),
        entry({
          key: "edge",
          slot: "blocked",
          summary: "刚好一天",
          updatedAt: "2026-11-19T12:00:00.000Z",
        }),
        entry({
          key: "older-ready",
          slot: "ready",
          summary: "两天前做完",
          updatedAt: "2026-11-18T10:00:00.000Z",
        }),
        entry({ key: "fresh", summary: "刚登记", updatedAt: "2026-11-20T11:00:00.000Z" }),
        entry({
          key: "done",
          slot: "milestone",
          summary: "很早完成",
          updatedAt: "2026-11-10T00:00:00.000Z",
        }),
      ],
      invocations: [],
      messages: [],
      now,
    });

  it("marks doing items older than a day stale, sorts them last and leaves them out of the count", () => {
    const groups = build();
    expect(groups.doing.map((item) => [item.title, !!item.stale])).toEqual([
      ["刚登记", false],
      ["刚好一天", false],
      ["三天前的", true],
    ]);
    expect(groups.done[0]!.stale).toBeUndefined();
    expect(groups.ready[0]!.stale).toBe(true);
    expect(activeCount(groups.doing)).toBe(2);
  });

  it("greys out stale rows with how long they have been quiet", () => {
    vi.useFakeTimers({ now, toFake: ["Date"] });
    try {
      render(<ProgressPanel groups={build()} onLocate={() => undefined} board={null} />);
    } finally {
      vi.useRealTimers();
    }
    const doing = screen.getByRole("region", { name: /进行中/ });
    expect(within(doing).getByText("2").className).toBe("progress-count");
    const stale = within(doing).getByText("三天前的").closest("li")!;
    expect(stale.dataset.stale).toBe("true");
    expect(within(stale).getByText("3 天没更新")).toBeTruthy();
    expect(stale.querySelector<HTMLElement>(".progress-row")!.title).toContain(
      "超过 1 天没有更新，可能已经没人在做",
    );
    expect(
      within(screen.getByRole("region", { name: /已就绪/ }))
        .getByText("两天前做完")
        .closest("li")!.textContent,
    ).toContain("2 天没更新");
    const fresh = within(doing).getByText("刚登记").closest("li")!;
    expect(fresh.dataset.stale).toBeUndefined();
    expect(fresh.textContent).not.toContain("没更新");
  });
});

describe("ProgressPanel", () => {
  afterEach(cleanup);

  it("places to-dos between attention and running work in the same panel", () => {
    const groups = buildProgress({ roomId: "build", entries: [], invocations: [], messages: [] });
    render(
      <ProgressPanel
        groups={groups}
        onLocate={vi.fn()}
        board={null}
        todos={<section aria-label="待办分区">future work</section>}
      />,
    );
    expect(
      screen
        .getAllByRole("region")
        .map(
          (element) =>
            element.getAttribute("aria-labelledby") ?? element.getAttribute("aria-label"),
        ),
    ).toEqual([
      "progress-attention",
      "待办分区",
      "progress-doing",
      "progress-ready",
      "progress-done",
    ]);
  });

  it("jumps to the chat on click and keeps the raw board folded", async () => {
    const user = userEvent.setup();
    const onLocate = vi.fn();
    const groups = buildProgress({
      roomId: "build",
      entries: [
        entry({ summary: "做登录页。细节 web431", messageId: crypto.randomUUID(), messageSeq: 3 }),
      ],
      invocations: [],
      messages: [],
    });
    render(<ProgressPanel groups={groups} onLocate={onLocate} board={<p>raw board</p>} />);
    expect(screen.getByText("没有要你处理的事")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /做登录页/ }));
    expect(onLocate).toHaveBeenCalledWith(groups.doing[0]!.target);
    const details = screen.getByText("Agent 白板（原文）").closest("details")!;
    expect(details.open).toBe(false);
    expect(within(details).getByText("raw board")).toBeTruthy();
  });

  it("shows only the latest completed items until expanded", async () => {
    const user = userEvent.setup();
    const groups = buildProgress({
      roomId: "build",
      entries: Array.from({ length: 10 }, (_, index) =>
        entry({
          key: `done-${index}`,
          slot: "milestone",
          summary: `完成 ${index}`,
          updatedAt: `2026-11-20T00:0${index}:00.000Z`,
        }),
      ),
      invocations: [],
      messages: [],
    });
    render(<ProgressPanel groups={groups} onLocate={() => undefined} board={null} />);
    const done = screen.getByRole("region", { name: /里程碑/ });
    expect(within(done).getAllByRole("listitem")).toHaveLength(8);
    expect(within(done).queryByText("完成 0")).toBeNull();
    await user.click(within(done).getByRole("button", { name: "显示全部 10 条" }));
    expect(within(done).getAllByRole("listitem")).toHaveLength(10);
  });
});
