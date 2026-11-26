// @vitest-environment jsdom

import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  todoInputSchema,
  type Todo,
  type Participant,
  type ChatMessage,
} from "@superhive/protocol";
import { TodoPanel } from "./todos";
import { todoApi, todoFromMessage } from "./todo-api";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const now = "2026-11-26T00:00:00.000Z";
const todo: Todo = {
  ...todoInputSchema.parse({ title: "Write tests", notes: "Check all paths" }),
  id: "a",
  roomId: "general",
  creatorId: "human",
  creatorName: "owner",
  creatorType: "human",
  assigneeName: null,
  sourceMessageSeq: null,
  completed: false,
  createdAt: now,
  updatedAt: now,
  completedAt: null,
};
const agent: Participant = {
  id: "agent",
  username: "worker",
  roomId: "general",
  type: "agent",
  status: "online",
  joinedAt: now,
  lastSeenAt: now,
};
const actions = () => ({
  add: vi.fn().mockResolvedValue(undefined),
  update: vi.fn().mockResolvedValue(undefined),
  remove: vi.fn().mockResolvedValue(undefined),
  handoff: vi.fn().mockResolvedValue(undefined),
  move: vi.fn().mockResolvedValue(undefined),
});

function openAction(label: string) {
  fireEvent.click(screen.getByRole("button", { name: "待办操作：Write tests" }));
  fireEvent.click(screen.getByRole("menuitem", { name: label }));
}

describe("to-do panel", () => {
  it("uses persisted order and keeps keyboard focus when a row moves", async () => {
    const user = userEvent.setup();
    const api = actions();
    const first = { ...todo, id: "first", title: "First", sortOrder: 0 };
    const second = { ...todo, id: "second", title: "Second", sortOrder: 1 };
    const props = { members: [agent], canManage: true, actions: api, onLocate: vi.fn() };
    const { container, rerender } = render(<TodoPanel {...props} todos={[second, first]} />);
    expect(
      [...container.querySelectorAll(".todo-title")].map((element) => element.textContent),
    ).toEqual(["First", "Second"]);
    const button = screen.getByRole("button", { name: "上移待办：Second" });
    button.focus();
    await user.keyboard("{Enter}");
    expect(api.move).toHaveBeenCalledWith("second", "up");
    rerender(
      <TodoPanel
        {...props}
        todos={[
          { ...first, sortOrder: 1 },
          { ...second, sortOrder: 0 },
        ]}
      />,
    );
    expect(
      [...container.querySelectorAll(".todo-title")].map((element) => element.textContent),
    ).toEqual(["Second", "First"]);
    expect(document.activeElement).toBe(button);
    expect(button.hasAttribute("disabled")).toBe(true);
    rerender(<TodoPanel {...props} canManage={false} todos={[first, second]} />);
    expect(screen.queryByRole("button", { name: /上移待办/ })).toBeNull();
  });

  it("reuses the edit handoff identity after an uncertain dispatch and does not dispatch metadata edits", async () => {
    const api = actions();
    api.handoff.mockRejectedValueOnce(new Error("network"));
    const props = { members: [agent], canManage: true, actions: api, onLocate: vi.fn() };
    const { rerender } = render(<TodoPanel {...props} todos={[todo]} />);
    openAction("编辑待办");
    fireEvent.change(screen.getByLabelText("负责人"), { target: { value: "agent" } });
    fireEvent.click(screen.getByText("保存并派给 Agent"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("network"));
    const identity = api.handoff.mock.calls[0]?.[2];
    rerender(
      <TodoPanel {...props} todos={[{ ...todo, assigneeId: "agent", assigneeName: "worker" }]} />,
    );
    fireEvent.click(screen.getByText("保存并派给 Agent"));
    await waitFor(() => expect(api.handoff).toHaveBeenCalledTimes(2));
    expect(api.handoff.mock.calls[1]?.[2]).toBe(identity);
    await waitFor(() => expect(screen.queryByText("保存并派给 Agent")).toBeNull());
    openAction("编辑待办");
    fireEvent.change(screen.getByLabelText("待办标题", { selector: ".todo-edit input" }), {
      target: { value: "Only rename" },
    });
    fireEvent.click(screen.getByText("保存"));
    await waitFor(() => expect(screen.queryByText("保存")).toBeNull());
    expect(api.handoff).toHaveBeenCalledTimes(2);
  });

  it("quick-adds trimmed titles and clears the input only after success", async () => {
    const api = actions();
    render(<TodoPanel todos={[]} members={[agent]} canManage actions={api} onLocate={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("待办标题"), { target: { value: " later " } });
    fireEvent.click(screen.getByText("添加"));
    await waitFor(() =>
      expect(api.add).toHaveBeenCalledWith({
        title: "later",
        notes: "",
        assigneeId: null,
        sourceMessageId: null,
      }),
    );
    await waitFor(() =>
      expect((screen.getByLabelText("待办标题") as HTMLInputElement).value).toBe(""),
    );
  });

  it("completes, edits, assigns and deletes with explicit confirmation", async () => {
    const api = actions();
    render(
      <TodoPanel todos={[todo]} members={[agent]} canManage actions={api} onLocate={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => expect(api.update).toHaveBeenCalledWith("a", { completed: true }));
    openAction("编辑待办");
    fireEvent.change(screen.getByLabelText("待办标题", { selector: ".todo-edit input" }), {
      target: { value: "Updated" },
    });
    fireEvent.change(screen.getByLabelText("负责人"), { target: { value: "agent" } });
    fireEvent.click(screen.getByText("保存并派给 Agent"));
    await waitFor(() =>
      expect(api.update).toHaveBeenCalledWith("a", {
        title: "Updated",
        notes: "Check all paths",
        assigneeId: null,
      }),
    );
    await waitFor(() => expect(api.handoff).toHaveBeenCalledWith("a", "agent", expect.any(String)));
    await waitFor(() => expect(screen.queryByText("保存并派给 Agent")).toBeNull());
    openAction("删除");
    expect(api.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("确认删除"));
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith("a"));
  });

  it("keeps completed items collapsed and shows creators and source navigation", () => {
    const locate = vi.fn();
    const { container } = render(
      <TodoPanel
        todos={[
          { ...todo, sourceMessageId: "source", sourceMessageSeq: 12 },
          { ...todo, id: "done", title: "Done", completed: true },
        ]}
        members={[]}
        canManage={false}
        actions={actions()}
        onLocate={locate}
      />,
    );
    expect(container.querySelector("details")?.open).toBe(false);
    expect(screen.getAllByLabelText("由 owner 添加")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "查看来源消息 #12" }));
    expect(locate).toHaveBeenCalledWith(expect.objectContaining({ sourceMessageId: "source" }));
    expect(screen.queryByText("添加")).toBeNull();
    expect(
      (screen.getAllByRole("checkbox", { hidden: true })[0] as HTMLInputElement).disabled,
    ).toBe(true);
  });

  it("sends to the chosen agent and reuses the message id after a failed request", async () => {
    const api = actions();
    api.handoff.mockRejectedValueOnce(new Error("network"));
    render(
      <TodoPanel todos={[todo]} members={[agent]} canManage actions={api} onLocate={vi.fn()} />,
    );
    openAction("交给 Agent");
    fireEvent.change(screen.getByLabelText("选择 Agent"), { target: { value: "agent" } });
    fireEvent.click(screen.getByText("发送任务"));
    await screen.findByText("network");
    fireEvent.click(screen.getByText("发送任务"));
    await waitFor(() => expect(api.handoff).toHaveBeenCalledTimes(2));
    expect(api.handoff.mock.calls[0]).toEqual(api.handoff.mock.calls[1]);
  });

  it("preserves quick input on errors", async () => {
    const api = actions();
    api.add.mockRejectedValue(new Error("failed"));
    render(<TodoPanel todos={[]} members={[]} canManage actions={api} onLocate={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("待办标题"), { target: { value: "later" } });
    fireEvent.click(screen.getByText("添加"));
    await screen.findByRole("alert");
    expect((screen.getByLabelText("待办标题") as HTMLInputElement).value).toBe("later");
  });

  it("keeps actions in a reachable menu and restores focus after cancelling deletion", async () => {
    const user = userEvent.setup();
    const api = actions();
    const { container } = render(
      <TodoPanel
        todos={[{ ...todo, sourceMessageId: "source", sourceMessageSeq: 12 }]}
        members={[agent]}
        canManage
        actions={api}
        onLocate={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
    expect(screen.queryByRole("button", { name: "交给 Agent" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "查看来源消息 #12" }).closest(".todo-meta"),
    ).toBeTruthy();
    expect(container.querySelector(".todo-meta")?.textContent).toContain("负责人：未指派");
    const trigger = screen.getByRole("button", { name: "待办操作：Write tests" });
    trigger.focus();
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(screen.getByRole("menu"));
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    await user.click(trigger);
    await user.click(screen.getByRole("menuitem", { name: "删除" }));
    expect(screen.getByRole("dialog", { name: "删除这条待办？" })).toBeTruthy();
    expect(api.remove).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(trigger);
    expect(api.remove).not.toHaveBeenCalled();
  });
});

describe("to-do API", () => {
  it("summarizes source messages without copying the full body", () => {
    const input = todoFromMessage({
      id: "source",
      seq: 4,
      content: "**Hello** " + "x".repeat(220),
    } as ChatMessage);
    expect(input.title).toHaveLength(200);
    expect(input.title).toMatch(/^Hello /);
    expect(input.sourceMessageId).toBe("source");
    expect(input.notes).toBe("");
  });
  it("scopes HTTP calls and uses the user's identity for dispatch", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetcher);
    const api = todoApi("http://localhost", "token", "some room", "owner");
    await api.handoff("todo", "worker", "stable-id");
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "http://localhost/api/rooms/some%20room/todos/todo/handoff",
    );
    expect(JSON.parse(fetcher.mock.calls[0]?.[1].body)).toMatchObject({
      username: "owner",
      agentId: "worker",
      clientMessageId: "stable-id",
    });
    await api.remove("todo");
    expect(fetcher.mock.calls[1]?.[1].headers["Content-Type"]).toBeUndefined();
    await api.move("todo", "up");
    expect(fetcher.mock.calls[2]?.[0]).toBe(
      "http://localhost/api/rooms/some%20room/todos/todo/move",
    );
    expect(JSON.parse(fetcher.mock.calls[2]?.[1].body)).toEqual({ direction: "up" });
  });
});
