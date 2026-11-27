// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import type { ChatMessage, Invocation, Participant } from "@superhive/protocol";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityPanel } from "./activity";

afterEach(cleanup);

const agent = (id: string, status: Participant["status"] = "online") =>
  ({ id, username: id, status, type: "agent" }) as Participant;

function setup(
  participants: Participant[],
  invocations: Invocation[],
  onOpenTask?: (invocation: Invocation) => void,
) {
  const message = {
    id: "m1",
    roomId: "build",
    seq: 1,
    senderId: "rd",
    senderName: "rd",
    senderType: "human",
    content: "@busy 做一下",
    mentions: [],
    createdAt: "2026-11-24T12:00:00.000Z",
  } as unknown as ChatMessage;
  const onOpenMessage = vi.fn();
  const onClose = vi.fn();
  render(
    <ActivityPanel
      view="tasks"
      rooms={[{ id: "build", name: "build" } as never]}
      mentions={[]}
      readSeqs={{}}
      invocations={invocations}
      invocationMessages={new Map([["m1", message]])}
      isAgentOnline={() => true}
      participants={participants}
      search={async () => []}
      onOpenMessage={onOpenMessage}
      onOpenTask={onOpenTask}
      onMarkMentionsRead={() => undefined}
      onClose={onClose}
    />,
  );
  return { onOpenMessage, onClose };
}

describe("ActivityPanel · Agent 任务", () => {
  const busy = {
    id: "i1",
    agentId: "busy",
    status: "running",
    messageId: "m1",
    roomId: "build",
    updatedAt: "2026-11-24T12:00:00.000Z",
    createdAt: "2026-11-24T12:00:00.000Z",
  } as unknown as Invocation;
  const many = [
    agent("busy"),
    ...Array.from({ length: 9 }, (_, i) => agent(`idle${i}`)),
    ...Array.from({ length: 12 }, (_, i) => agent(`off${i}`, "offline")),
  ];

  it("任务列表在前，成员状态只列有事的 Agent，空闲、离线收成一行，点开才列出", () => {
    const { onOpenMessage } = setup(many, [busy]);
    const dialog = screen.getByRole("dialog", { name: "Agent 任务" });
    const sections = within(dialog).getAllByRole("region");
    expect(sections.map((section) => section.getAttribute("aria-label"))).toEqual([
      "进行中",
      "成员状态",
    ]);

    const members = within(dialog).getByRole("region", { name: "成员状态" });
    expect(within(members).queryByText("@idle0")).toBeNull();
    const more = within(members).getByRole("button", { name: /另有 9 个空闲、12 个离线/ });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect(within(members).getByText("@idle0")).toBeTruthy();
    expect(within(members).getByText("@off11")).toBeTruthy();

    // 点有事的 Agent 仍然跳到它正在处理的消息
    fireEvent.click(within(members).getByRole("button", { name: /@busy 工作中，跳到当前任务/ }));
    expect(onOpenMessage).toHaveBeenCalledWith(expect.objectContaining({ id: "m1" }));
  });

  it("没有 Agent 在忙时写明，并只给汇总行", () => {
    setup([agent("a"), agent("b", "offline")], []);
    const members = screen.getByRole("region", { name: "成员状态" });
    expect(within(members).getByText("没有 Agent 在忙")).toBeTruthy();
    expect(within(members).getByRole("button", { name: /1 个空闲、1 个离线/ })).toBeTruthy();
  });

  it("opens the exact waiting invocation from task results and runtime rows", () => {
    const waiting = { ...busy, status: "waiting_human" } as Invocation;
    const other = { ...waiting, id: "i2", agentId: "other", agentName: "other" };
    const onOpenTask = vi.fn();
    const { onOpenMessage } = setup([agent("busy"), agent("other")], [waiting, other], onOpenTask);
    const section = screen.getByRole("region", { name: "等你回答" });
    fireEvent.click(within(section).getAllByRole("option")[1]!);
    expect(onOpenTask).toHaveBeenLastCalledWith(other);
    const members = screen.getByRole("region", { name: "成员状态" });
    fireEvent.click(within(members).getByRole("button", { name: /@busy 等你回答，跳到当前任务/ }));
    expect(onOpenTask).toHaveBeenLastCalledWith(waiting);
    expect(onOpenMessage).not.toHaveBeenCalled();
  });
});

describe("ActivityPanel · 数据更新时不动滚动位置（#7370）", () => {
  const message = (id: string) =>
    ({
      id,
      roomId: "build",
      seq: 1,
      senderId: "rd",
      senderName: "rd",
      senderType: "human",
      content: `@a 任务 ${id}`,
      mentions: [],
      createdAt: "2026-11-24T12:00:00.000Z",
    }) as unknown as ChatMessage;
  const running = (id: string, minute: number, progress: string) =>
    ({
      id,
      agentId: "a",
      agentName: "a",
      status: "running",
      progress,
      messageId: `m-${id}`,
      roomId: "build",
      createdAt: "2026-11-24T12:00:00.000Z",
      updatedAt: `2026-11-24T12:${String(minute).padStart(2, "0")}:00.000Z`,
    }) as unknown as Invocation;

  it("进行中的调用换了进度、重新排序、跑完离开列表：内容区不重挂、不抢焦点、scrollTop 不变", () => {
    const ids = Array.from({ length: 8 }, (_, i) => `i${i}`);
    const messages = new Map(ids.map((id) => [`m-${id}`, message(`m-${id}`)]));
    const panel = (invocations: Invocation[]) => (
      <ActivityPanel
        view="tasks"
        rooms={[{ id: "build", name: "build" } as never]}
        mentions={[]}
        readSeqs={{}}
        invocations={invocations}
        invocationMessages={messages}
        isAgentOnline={() => true}
        participants={[agent("a")]}
        search={async () => []}
        onOpenMessage={() => undefined}
        onMarkMentionsRead={() => undefined}
        onClose={() => undefined}
      />
    );
    const first = ids.map((id, i) => running(id, i, "读代码"));
    const { rerender } = render(panel(first));
    const body = document.getElementById("activity-results")!;
    const rows = () =>
      within(screen.getByRole("region", { name: "进行中" }))
        .getAllByRole("option")
        .map((option) => option.textContent ?? "");
    expect(rows()[0]).toContain("任务 m-i7");
    body.scrollTop = 640;

    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    // 排在最后的一条有了新进度，挪到最前面；另一条跑完离开列表
    rerender(panel([...first.slice(1, 7), running("i0", 30, "跑测试 · 第 3 步")]));
    expect(rows()[0]).toContain("跑测试 · 第 3 步");
    expect(rows()).toHaveLength(7);
    expect(document.getElementById("activity-results")).toBe(body);
    expect(body.scrollTop).toBe(640);
    expect(focus).not.toHaveBeenCalled();
    focus.mockRestore();
  });

  it("切换视图时放回焦点用 preventScroll", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    setup([agent("busy")], []);
    expect(focus).toHaveBeenCalled();
    for (const [options] of focus.mock.calls) expect(options).toEqual({ preventScroll: true });
    focus.mockRestore();
  });

  it("按最近更新重新排序的列表不当滚动锚点", () => {
    // jsdom 不做滚动锚定：浏览器里会跟着被挪到最前面的那一项把内容区滚回顶部，只能锁住样式
    const styles = path.join(import.meta.dirname, "styles");
    const rule = (file: string, selector: string) => {
      const css = readFileSync(path.join(styles, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(^|\\})\\s*${escaped}\\s*\\{[^}]*overflow-anchor:\\s*none`).test(css);
    };
    expect(rule("activity.css", ".activity-tasks-main > section:not(.usage-section)")).toBe(true);
    expect(rule("activity.css", ".agent-runtime-list")).toBe(true);
    expect(rule("incidents.css", ".incident-list")).toBe(true);
    expect(rule("slow-ops.css", ".slow-ops")).toBe(true);
  });
});
