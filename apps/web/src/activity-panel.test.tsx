// @vitest-environment jsdom

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
