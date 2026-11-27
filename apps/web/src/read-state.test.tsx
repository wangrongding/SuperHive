// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { MetaResponse } from "@superhive/protocol";
import {
  mergeReadSeqs,
  mergeReadStateUpdates,
  readSeqsAhead,
  schedulesSeenKey,
  useReadState,
} from "./read-state";

const meta = { joinToken: "token" } as MetaResponse;

function stubServer(initial: { rooms: Record<string, number>; schedulesSeenAt?: string }) {
  const server = { state: initial, writes: [] as unknown[], failWrites: false };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        if (server.failWrites) return new Response("{}", { status: 503 });
        const body = JSON.parse(String(init.body)) as {
          rooms?: Record<string, number>;
          schedulesSeenAt?: string;
        };
        server.writes.push(body);
        server.state = {
          rooms: mergeReadSeqs(server.state.rooms, body.rooms ?? {}),
          ...(body.schedulesSeenAt ? { schedulesSeenAt: body.schedulesSeenAt } : {}),
        };
        return new Response(JSON.stringify(body));
      }
      return new Response(JSON.stringify(server.state));
    }),
  );
  return server;
}

const render = () => renderHook(() => useReadState({ base: "", authToken: "token", meta }));

describe("合并已读位置", () => {
  it("逐个房间取较大值，没变时返回原对象", () => {
    const current = { a: 3, b: 5 };
    expect(mergeReadSeqs(current, { a: 2, b: 5 })).toBe(current);
    expect(mergeReadSeqs(current, { a: 4, c: 1 })).toEqual({ a: 4, b: 5, c: 1 });
    expect(readSeqsAhead({ a: 4, b: 5, c: 0 }, { a: 3, b: 6 })).toEqual({ a: 4 });
    expect(
      mergeReadStateUpdates(
        { rooms: { a: 2 }, schedulesSeenAt: "2026-11-28T00:00:01.000Z" },
        { rooms: { a: 1, b: 1 }, schedulesSeenAt: "2026-11-28T00:00:00.000Z" },
      ),
    ).toEqual({ rooms: { a: 2, b: 1 }, schedulesSeenAt: "2026-11-28T00:00:01.000Z" });
  });
});

describe("useReadState", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("首次对齐：两边取较大值，本地更新的写回 Server", async () => {
    localStorage.setItem("superhive.read-seq.a", "7");
    localStorage.setItem("superhive.read-seq.b", "1");
    localStorage.setItem(schedulesSeenKey, "2026-11-28T00:00:05.000Z");
    const server = stubServer({
      rooms: { b: 9, c: 3 },
      schedulesSeenAt: "2026-11-28T00:00:01.000Z",
    });
    const { result } = render();
    await act(() => result.current.sync(["a", "b", "c"]));
    expect(result.current.readSeqs).toEqual({ a: 7, b: 9, c: 3 });
    expect(server.writes).toEqual([
      { rooms: { a: 7 }, schedulesSeenAt: "2026-11-28T00:00:05.000Z" },
    ]);
    // Server 上更大的也写进本地缓存，离线时照样显示已读
    expect(localStorage.getItem("superhive.read-seq.b")).toBe("9");
    expect(localStorage.getItem("superhive.read-seq.c")).toBe("3");
  });

  it("这台设备读了：只进不退，攒一下再写，一次写完", async () => {
    const server = stubServer({ rooms: {} });
    const { result } = render();
    act(() => result.current.advance({ a: 3 }));
    act(() => result.current.advance({ a: 5 }));
    act(() => result.current.advance({ a: 4 }));
    act(() => result.current.advance({ b: 2 }));
    expect(result.current.readSeqs).toEqual({ a: 5, b: 2 });
    expect(server.writes).toEqual([]);
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(server.writes).toEqual([{ rooms: { a: 5, b: 2 } }]);
    // 没往前走的不再写
    act(() => result.current.advance({ a: 5 }));
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(server.writes).toHaveLength(1);
  });

  it("其他设备推过来的并进来、不写回；旧的不会把已读倒回去", async () => {
    const server = stubServer({ rooms: {} });
    const { result } = render();
    act(() => result.current.advance({ a: 8 }));
    act(() => result.current.apply({ rooms: { a: 6, b: 4 } }));
    expect(result.current.readSeqs).toEqual({ a: 8, b: 4 });
    expect(localStorage.getItem("superhive.read-seq.b")).toBe("4");
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(server.writes).toEqual([{ rooms: { a: 8 } }]);
  });

  it("没写上的留着，下次对齐时补上", async () => {
    const server = stubServer({ rooms: {} });
    server.failWrites = true;
    const { result } = render();
    act(() => result.current.advance({ a: 2 }));
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(server.writes).toEqual([]);
    server.failWrites = false;
    await act(() => result.current.sync(["a"]));
    await waitFor(() => expect(server.writes).toEqual([{ rooms: { a: 2 } }]));
  });

  it("打开定时任务面板的时间也写回 Server，推来更晚的跟着更新", async () => {
    const server = stubServer({ rooms: {} });
    const { result } = render();
    act(() => result.current.markSchedulesSeen());
    const seenAt = result.current.schedulesSeenAt;
    expect(seenAt).not.toBe("");
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(server.writes).toEqual([{ schedulesSeenAt: seenAt }]);
    act(() => result.current.apply({ rooms: {}, schedulesSeenAt: "2000-01-01T00:00:00.000Z" }));
    expect(result.current.schedulesSeenAt).toBe(seenAt);
    act(() => result.current.apply({ rooms: {}, schedulesSeenAt: "2999-01-01T00:00:00.000Z" }));
    expect(result.current.schedulesSeenAt).toBe("2999-01-01T00:00:00.000Z");
    expect(localStorage.getItem(schedulesSeenKey)).toBe("2999-01-01T00:00:00.000Z");
  });
});
