// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Invocation, WhiteboardEntry } from "@superhive/protocol";
import { useMessageActions } from "./use-message-actions";

afterEach(cleanup);

function setup() {
  const send = vi.fn();
  const socketRef = { current: { readyState: WebSocket.OPEN, send } as unknown as WebSocket };
  const { result } = renderHook(() =>
    useMessageActions({ socketRef, setError: vi.fn(), authToken: "t", base: "", username: "rd" }),
  );
  return { send, actions: () => result.current };
}

async function answer(name: string, button: string) {
  const dialog = await screen.findByRole("alertdialog", { name });
  fireEvent.click(within(dialog).getByRole("button", { name: button }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
}

describe("消息操作的确认", () => {
  it("停下当前、改做这条：用确认弹窗说明后果，取消不发，确认才发 preempt", async () => {
    const { send, actions } = setup();
    const invocation = { id: "i1", agentName: "worker" } as Invocation;
    let pending!: Promise<void>;
    act(() => {
      pending = actions().preemptInvocation(invocation);
    });
    const dialog = await screen.findByRole("alertdialog", {
      name: "停下 @worker 当前的任务，改做这条？",
    });
    expect(dialog.textContent).toContain("做到一半的改动不会撤回");
    // 危险操作：焦点默认在取消上
    expect(document.activeElement?.textContent).toBe("取消");
    await answer("停下 @worker 当前的任务，改做这条？", "取消");
    await pending;
    expect(send).not.toHaveBeenCalled();

    act(() => {
      pending = actions().preemptInvocation(invocation);
    });
    await answer("停下 @worker 当前的任务，改做这条？", "停下并改做");
    await pending;
    expect(JSON.parse(send.mock.calls[0]![0] as string)).toEqual({
      type: "invocation.preempt",
      invocationId: "i1",
    });
  });

  it("永久删除历史事项要确认", async () => {
    const { send, actions } = setup();
    const entry = { id: "e1", updatedAt: "2026-11-28T00:00:00.000Z" } as WhiteboardEntry;
    let pending!: Promise<void>;
    act(() => {
      pending = actions().removeWhiteboardEntry(entry);
    });
    await answer("永久删除这条历史事项？", "删除");
    await pending;
    expect(JSON.parse(send.mock.calls[0]![0] as string)).toEqual({
      type: "whiteboard.remove",
      entryId: "e1",
      updatedAt: entry.updatedAt,
    });
  });
});
