// @vitest-environment jsdom

import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
});

describe("to-do panel", () => {
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
    fireEvent.click(screen.getByLabelText("编辑待办"));
    fireEvent.change(screen.getByLabelText("待办标题", { selector: ".todo-edit input" }), {
      target: { value: "Updated" },
    });
    fireEvent.change(screen.getByLabelText("负责人"), { target: { value: "agent" } });
    fireEvent.click(screen.getByText("保存"));
    await waitFor(() =>
      expect(api.update).toHaveBeenCalledWith("a", {
        title: "Updated",
        notes: "Check all paths",
        assigneeId: "agent",
      }),
    );
    await waitFor(() => expect(screen.queryByText("保存")).toBeNull());
    fireEvent.click(screen.getByText("删除"));
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
    expect(screen.getAllByText("由 owner 添加")).toHaveLength(2);
    fireEvent.click(screen.getByText("查看来源消息 #12"));
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
    fireEvent.click(screen.getByText("交给 Agent"));
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
  });
});
