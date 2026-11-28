// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WhiteboardEntry } from "@superhive/protocol";
import { WhiteboardPanel, upsertWhiteboardEntry } from "./whiteboard";

const entry = (key: string, extra: Partial<WhiteboardEntry> = {}): WhiteboardEntry => ({
  id: key,
  key,
  roomId: "general",
  slot: "ready",
  summary: `Summary ${key}`,
  unblocks: [],
  authorId: "author",
  authorName: "helper",
  createdAt: "2026-11-16T00:00:00Z",
  updatedAt: "2026-11-16T00:00:00Z",
  ...extra,
});
const asMap = (entries: WhiteboardEntry[]) => new Map(entries.map((entry) => [entry.id, entry]));
const props = () => ({
  canManage: true,
  onRemove: vi.fn(),
  onArchive: vi.fn(async () => {}),
  loadHistory: vi.fn(async () => {}),
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("WhiteboardPanel lifecycle", () => {
  it("puts legacy and tagged directory records in a closed group, separate from tasks", async () => {
    const user = userEvent.setup();
    const active = entry("worktree:active", { slot: "in_progress", archiveProtected: true });
    const cleaned = entry("worktree:cleaned", { slot: "milestone", branch: "feat/old" });
    const tagged = entry("tagged", { kind: "task_directory" });
    render(
      <WhiteboardPanel {...props()} entries={asMap([active, cleaned, tagged, entry("task")])} />,
    );
    const group = screen.getByText("任务目录").closest("details")!;
    expect(group.open).toBe(false);
    expect(screen.getAllByRole("heading").map((heading) => heading.textContent)).toEqual([
      "已就绪1",
    ]);
    await user.click(screen.getByText("任务目录"));
    expect(group.open).toBe(true);
    expect(within(group).getByText(active.summary)).toBeTruthy();
    expect(within(group).getByText(cleaned.summary)).toBeTruthy();
    expect(within(group).getByText("feat/old")).toBeTruthy();
    expect(
      (
        within(group).getByRole("checkbox", {
          name: "选择事项：worktree:active",
        }) as HTMLInputElement
      ).disabled,
    ).toBe(true);
    await user.click(screen.getByText("任务目录"));
    expect(group.open).toBe(false);
  });

  it("does not bulk-select directory records even when cleaned or archived", async () => {
    const user = userEvent.setup();
    const callbacks = props();
    const task = entry("task");
    const directory = entry("worktree:cleaned", { slot: "milestone" });
    const { rerender } = render(
      <WhiteboardPanel {...callbacks} entries={asMap([task, directory])} />,
    );
    await user.click(screen.getByRole("button", { name: "选择可归档事项" }));
    await user.click(screen.getByRole("button", { name: "归档所选 (1)" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "归档" }),
    );
    expect(callbacks.onArchive).toHaveBeenCalledWith([task], true);
    const archivedTask = { ...task, archivedAt: "2026-11-16T00:01:00Z" };
    const archivedDirectory = { ...directory, archivedAt: "2026-11-16T00:01:00Z" };
    rerender(<WhiteboardPanel {...callbacks} entries={asMap([archivedTask, archivedDirectory])} />);
    await user.click(screen.getByRole("button", { name: "历史归档" }));
    await user.click(screen.getByRole("button", { name: "选择历史事项" }));
    await user.click(screen.getByRole("button", { name: "恢复所选 (1)" }));
    expect(callbacks.onArchive).toHaveBeenLastCalledWith([archivedTask], false);
  });

  it("keeps directory history in its separate group and permits restoring eligible entries", async () => {
    const user = userEvent.setup();
    const callbacks = props();
    const directory = entry("worktree:history", {
      slot: "milestone",
      archivedAt: "2026-11-16T00:01:00Z",
    });
    render(<WhiteboardPanel {...callbacks} entries={asMap([directory])} />);
    expect(screen.queryByText("任务目录")).toBeNull();
    await user.click(screen.getByRole("button", { name: "历史归档" }));
    await waitFor(() => expect(callbacks.loadHistory).toHaveBeenCalled());
    const group = screen.getByText("任务目录").closest("details")!;
    expect(group.open).toBe(false);
    expect(screen.queryByRole("heading", { name: /里程碑/ })).toBeNull();
    await user.click(screen.getByText("任务目录"));
    await user.click(within(group).getByRole("button", { name: "恢复事项：worktree:history" }));
    expect(callbacks.onArchive).toHaveBeenCalledWith([directory], false);
  });

  it("keeps an opened directory group open across updates and applies the slot filter", async () => {
    const user = userEvent.setup();
    const callbacks = props();
    const active = entry("worktree:active", { slot: "in_progress" });
    const { rerender } = render(<WhiteboardPanel {...callbacks} entries={asMap([active])} />);
    await user.click(screen.getByText("任务目录"));
    rerender(<WhiteboardPanel {...callbacks} entries={asMap([active, entry("worktree:new")])} />);
    expect(screen.getByText("任务目录").closest("details")!.open).toBe(true);
    await user.selectOptions(screen.getByRole("combobox", { name: "状态筛选" }), "in_progress");
    expect(screen.getByText(active.summary)).toBeTruthy();
    expect(screen.queryByText("Summary worktree:new")).toBeNull();
  });

  it("defaults to current items, filters slots and disables protected selections", async () => {
    const user = userEvent.setup();
    render(
      <WhiteboardPanel
        {...props()}
        entries={asMap([
          entry("ready"),
          entry("blocked", { slot: "blocked" }),
          entry("active", { slot: "in_progress" }),
          entry("claimed", { archiveProtected: true }),
          entry("history", { archivedAt: "2026-11-16T00:01:00Z" }),
        ])}
      />,
    );
    expect(screen.queryByText("Summary history")).toBeNull();
    // 只有仍占用工作区的不能选；进行中、阻塞的旧条目房主可以手动勾选归档
    expect(
      (screen.getByRole("checkbox", { name: "选择事项：claimed" }) as HTMLInputElement).disabled,
    ).toBe(true);
    for (const key of ["blocked", "active"])
      expect(
        (screen.getByRole("checkbox", { name: `选择事项：${key}` }) as HTMLInputElement).disabled,
      ).toBe(false);
    await user.selectOptions(screen.getByRole("combobox", { name: "状态筛选" }), "blocked");
    expect(screen.getByText("Summary blocked")).toBeTruthy();
    expect(screen.queryByText("Summary ready")).toBeNull();
  });

  it("archives only eligible selected items after confirmation", async () => {
    const user = userEvent.setup();
    const callbacks = props();
    const ready = entry("ready");
    const milestone = entry("milestone", { slot: "milestone" });
    render(
      <WhiteboardPanel
        {...callbacks}
        entries={asMap([
          ready,
          milestone,
          entry("active", { slot: "in_progress" }),
          entry("claimed", { archiveProtected: true }),
        ])}
      />,
    );
    const pick = screen.getByRole("button", { name: "选择可归档事项" });
    // 「哪些不能归档」的说明不单独占行，挂在按钮上：悬停提示 + 读屏描述
    expect(pick.hasAttribute("title")).toBe(false);
    const description = document.getElementById(pick.getAttribute("aria-describedby")!);
    expect(description?.textContent).toBe("仍占用工作区的事项不可归档；每次最多选择 200 条。");
    expect(screen.queryByRole("group", { name: "批量操作" })).toBeNull();
    await user.click(pick);
    expect(screen.getByText("已选择 2 条")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "归档所选 (2)" }));
    const dialog = await screen.findByRole("alertdialog", { name: "归档所选 2 条事项？" });
    expect(callbacks.onArchive).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "归档" }));
    expect(callbacks.onArchive).toHaveBeenCalledWith([ready, milestone], true);
    // 没有选中时批量条整条收起
    await waitFor(() => expect(screen.queryByRole("group", { name: "批量操作" })).toBeNull());
  });

  it("loads history and restores a selected batch without deleting it", async () => {
    const user = userEvent.setup();
    const callbacks = props();
    const archived = entry("history", { archivedAt: "2026-11-16T00:01:00Z" });
    render(<WhiteboardPanel {...callbacks} entries={asMap([archived])} />);
    expect(screen.getByText("白板还是空的")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "历史归档" }));
    await waitFor(() => expect(callbacks.loadHistory).toHaveBeenCalledOnce());
    expect(screen.getByText("Summary history")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "选择历史事项" }));
    await user.click(screen.getByRole("button", { name: "恢复所选 (1)" }));
    expect(callbacks.onArchive).toHaveBeenCalledWith([archived], false);
    expect(callbacks.onRemove).not.toHaveBeenCalled();
  });

  it("hides management controls from guests", async () => {
    const user = userEvent.setup();
    render(
      <WhiteboardPanel
        {...props()}
        canManage={false}
        entries={asMap([entry("ready"), entry("history", { archivedAt: "2026-11-16T00:01:00Z" })])}
      />,
    );
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "选择可归档事项" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "历史归档" }));
    expect(screen.queryByRole("button", { name: "恢复事项：history" })).toBeNull();
    expect(screen.queryByRole("button", { name: "从白板移除：Summary history" })).toBeNull();
  });

  it("clears stale selections and ignores older snapshots", async () => {
    const user = userEvent.setup();
    const callbacks = props();
    const previous = entry("ready");
    const entries = asMap([previous]);
    const { rerender } = render(<WhiteboardPanel {...callbacks} entries={entries} />);
    await user.click(screen.getByRole("checkbox", { name: "选择事项：ready" }));
    const changed = { ...previous, updatedAt: "2026-11-16T00:02:00Z", slot: "blocked" as const };
    const current = upsertWhiteboardEntry(entries, changed);
    rerender(<WhiteboardPanel {...callbacks} entries={current} />);
    // 没有选中时批量条整条收起
    await waitFor(() => expect(screen.queryByRole("group", { name: "批量操作" })).toBeNull());
    expect(upsertWhiteboardEntry(current, previous)).toBe(current);
  });

  it("cancels archives and displays failed operations without hiding their entries", async () => {
    const user = userEvent.setup();
    const callbacks = props();
    callbacks.onArchive.mockRejectedValue(new Error("conflict"));
    render(<WhiteboardPanel {...callbacks} entries={asMap([entry("ready")])} />);
    await user.click(screen.getByRole("button", { name: "归档事项：ready" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "取消" }),
    );
    expect(callbacks.onArchive).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "归档事项：ready" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "归档" }),
    );
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("conflict"));
    expect(screen.getByText("Summary ready")).toBeTruthy();
  });

  it("reports history loading failures and allows an explicit retry", async () => {
    const user = userEvent.setup();
    const callbacks = props();
    callbacks.loadHistory.mockRejectedValueOnce(new Error("unavailable"));
    render(<WhiteboardPanel {...callbacks} entries={asMap([])} />);
    await user.click(screen.getByRole("button", { name: "历史归档" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("unavailable"));
    await user.click(screen.getByRole("button", { name: "刷新历史" }));
    await waitFor(() => expect(callbacks.loadHistory).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});
