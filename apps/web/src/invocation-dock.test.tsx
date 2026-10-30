// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Invocation } from "@ai-hive/protocol";
import { InvocationDock, dockInvocations } from "./invocation-dock";

const now = Date.parse("2026-10-30T10:00:00Z");
let seq = 0;
function invocation(status: Invocation["status"], extra: Partial<Invocation> = {}): Invocation {
  seq += 1;
  const at = new Date(now - 60_000).toISOString();
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    roomId: "build",
    messageId: `10000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    agentId: "20000000-0000-4000-8000-000000000001",
    agentName: `agent-${seq}`,
    requesterId: "30000000-0000-4000-8000-000000000001",
    requesterName: "rd",
    requesterType: "human",
    status,
    attempts: 1,
    createdAt: at,
    updatedAt: at,
    ...extra,
  } as Invocation;
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("输入框上方的 Agent 状态栏", () => {
  it("只收当前房间进行中的调用，以及最近需要人处理的", () => {
    const old = new Date(now - 2 * 3600_000).toISOString();
    const picked = dockInvocations(
      [
        invocation("running"),
        invocation("waiting_human"),
        invocation("completed"),
        invocation("blocked"),
        invocation("timed_out", { updatedAt: old }),
        invocation("cancelling", { updatedAt: old }),
        invocation("running", { roomId: "general" }),
      ],
      "build",
      now,
    );
    expect(picked.map((item) => item.status)).toEqual(["running", "waiting_human", "blocked"]);
  });

  it("没有调用时不显示；可以收起，收起状态记住", () => {
    const props = {
      participants: [],
      canJumpTo: () => true,
      onJump: () => undefined,
      onRetry: () => undefined,
      onCancel: () => undefined,
      onExtend: () => undefined,
    };
    const { container } = render(<InvocationDock invocations={[]} {...props} />);
    expect(container.textContent).toBe("");
    cleanup();
    const located: string[] = [];
    const running = invocation("running");
    render(
      <InvocationDock invocations={[running]} {...props} onLocate={(id) => located.push(id)} />,
    );
    expect(screen.getByText("1 个执行中")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /定位到原消息/ }));
    expect(located).toEqual([running.messageId]);
    fireEvent.click(screen.getByRole("button", { name: /Agent 状态/ }));
    expect(screen.queryByRole("list", { name: "Agent 调用状态" })).toBeNull();
    expect(localStorage.getItem("ai-hive.invocation-dock.collapsed")).toBe("1");
  });
});
