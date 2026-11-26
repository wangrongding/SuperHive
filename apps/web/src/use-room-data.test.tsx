// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Todo } from "@superhive/protocol";
import { useRoomData } from "./use-room-data";

function todo(roomId: string): Todo {
  const now = "2026-11-26T00:00:00.000Z";
  return {
    id: `${roomId}-todo`,
    roomId,
    title: `${roomId} work`,
    notes: "",
    creatorId: "owner",
    creatorName: "owner",
    creatorType: "human",
    assigneeId: null,
    assigneeName: null,
    sourceMessageId: null,
    sourceMessageSeq: null,
    completed: false,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

describe("room to-do cache", () => {
  it("clears uncached rooms and restores the latest to-dos when returning", () => {
    const { result } = renderHook(() =>
      useRoomData({ base: "http://localhost", authToken: "owner", currentRoomId: "general" }),
    );
    const general = todo("general");
    const other = todo("other");
    const scroll = { scrollTop: 0, nearBottom: true, visibleLimit: 25 };
    act(() => {
      result.current.setTodos(new Map([[general.id, general]]));
      result.current.setMessagesLoaded(true);
    });
    act(() => result.current.activateRoom("other", scroll));
    expect(result.current.todos.size).toBe(0);
    act(() => {
      result.current.setTodos(new Map([[other.id, other]]));
      result.current.setMessagesLoaded(true);
    });
    act(() => result.current.activateRoom("general", scroll));
    expect([...result.current.todos.values()]).toEqual([general]);
    act(() => result.current.setTodos(new Map([[general.id, { ...general, completed: true }]])));
    act(() => result.current.activateRoom("other", scroll));
    expect([...result.current.todos.values()]).toEqual([other]);
    act(() => result.current.activateRoom("general", scroll));
    expect(result.current.todos.get(general.id)?.completed).toBe(true);
  });

  it("discards active and cached to-dos when the connection identity changes", () => {
    const { result, rerender } = renderHook(
      ({ authToken }) =>
        useRoomData({ base: "http://localhost", authToken, currentRoomId: "general" }),
      { initialProps: { authToken: "owner" } },
    );
    const general = todo("general");
    const scroll = { scrollTop: 0, nearBottom: true, visibleLimit: 25 };
    act(() => {
      result.current.setTodos(new Map([[general.id, general]]));
      result.current.setMessagesLoaded(true);
    });
    act(() => result.current.activateRoom("other", scroll));
    rerender({ authToken: "different-user" });
    act(() => result.current.activateRoom("general", scroll));
    expect(result.current.todos.size).toBe(0);
  });
});
