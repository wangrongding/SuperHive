import { useCallback, useEffect, useRef, useState } from "react";
import type { MetaResponse, ReadState, ReadStateUpdate } from "@superhive/protocol";
import { readSeqStorageKey } from "./app-storage";

/** 上次打开「定时任务」面板的时间：之后才失败、错过的才在入口上醒目提示 */
export const schedulesSeenKey = "superhive.schedules-seen-at";

/** 两边逐个房间取较大的已读位置 */
export function mergeReadSeqs(
  current: Readonly<Record<string, number>>,
  incoming: Readonly<Record<string, number>>,
): Record<string, number> {
  let next: Record<string, number> | undefined;
  for (const [roomId, seq] of Object.entries(incoming)) {
    if (!(seq > (current[roomId] ?? 0))) continue;
    next ??= { ...current };
    next[roomId] = seq;
  }
  return next ?? (current as Record<string, number>);
}

/** local 里比 server 新的那些房间：升级前只记在这台设备上的已读，要写回 Server */
export function readSeqsAhead(
  local: Readonly<Record<string, number>>,
  server: Readonly<Record<string, number>>,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(local).filter(([roomId, seq]) => seq > 0 && seq > (server[roomId] ?? 0)),
  );
}

function storedSeq(roomId: string): number {
  try {
    const value = Number(localStorage.getItem(readSeqStorageKey(roomId)) ?? "0");
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

/** 本地那份只当离线缓存：只往大了写 */
function storeSeqs(positions: Readonly<Record<string, number>>): void {
  try {
    for (const [roomId, seq] of Object.entries(positions)) {
      if (seq > storedSeq(roomId)) localStorage.setItem(readSeqStorageKey(roomId), String(seq));
    }
  } catch {
    // 存不下只影响离线时的显示，Server 上那份照常
  }
}

function storedSchedulesSeenAt(): string {
  try {
    return localStorage.getItem(schedulesSeenKey) ?? "";
  } catch {
    return "";
  }
}

function laterTime(a: string, b: string | undefined): string {
  return b && b > a ? b : a;
}

/** 两次要写的合成一次：各房间取较大值，时间取较晚的 */
export function mergeReadStateUpdates(a: ReadStateUpdate, b: ReadStateUpdate): ReadStateUpdate {
  const rooms = a.rooms || b.rooms ? mergeReadSeqs(a.rooms ?? {}, b.rooms ?? {}) : undefined;
  const schedulesSeenAt =
    a.schedulesSeenAt || b.schedulesSeenAt
      ? laterTime(a.schedulesSeenAt ?? "", b.schedulesSeenAt)
      : undefined;
  return { ...(rooms ? { rooms } : {}), ...(schedulesSeenAt ? { schedulesSeenAt } : {}) };
}

/**
 * 已读状态：存在 Server 上、跟着人走（换设备、换客户端都一样），本地 localStorage 留一份离线缓存。
 * - 读到哪了只进不退：本地先更新，合并后写回 Server；Server 再推给这个人的其他网页
 * - 每次拉房间列表（打开页面、重连）都和 Server 对一次：两边取较大值，本地更新的写回去
 */
export function useReadState({
  base,
  authToken,
  meta,
}: {
  base: string;
  authToken: string | undefined;
  meta: MetaResponse | undefined;
}) {
  const [readSeqs, setReadSeqs] = useState<Record<string, number>>({});
  const [schedulesSeenAt, setSchedulesSeenAt] = useState(storedSchedulesSeenAt);
  const readSeqsRef = useRef(readSeqs);
  readSeqsRef.current = readSeqs;
  const schedulesSeenRef = useRef(schedulesSeenAt);
  schedulesSeenRef.current = schedulesSeenAt;
  const pendingRef = useRef<ReadStateUpdate>({});
  const timerRef = useRef<number | undefined>(undefined);
  const connectionRef = useRef({ base, authToken, ready: Boolean(meta) });
  connectionRef.current = { base, authToken, ready: Boolean(meta) };

  /** Server 或其他设备给的状态：并进来，不再写回 */
  const apply = useCallback((state: Partial<ReadState>) => {
    if (state.rooms && Object.keys(state.rooms).length > 0) {
      const rooms = state.rooms;
      storeSeqs(rooms);
      setReadSeqs((current) => mergeReadSeqs(current, rooms));
    }
    if (state.schedulesSeenAt && state.schedulesSeenAt > schedulesSeenRef.current) {
      const at = state.schedulesSeenAt;
      try {
        localStorage.setItem(schedulesSeenKey, at);
      } catch {
        // 存不下就只在本页生效
      }
      setSchedulesSeenAt((current) => laterTime(current, at));
    }
  }, []);

  const flush = useCallback(async () => {
    window.clearTimeout(timerRef.current);
    timerRef.current = undefined;
    const update = pendingRef.current;
    if (!update.rooms && !update.schedulesSeenAt) return;
    const { base, authToken, ready } = connectionRef.current;
    if (!ready || !authToken) return;
    pendingRef.current = {};
    try {
      const response = await fetch(`${base}/api/read-state`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
        body: JSON.stringify(update),
        // 关页面时也要写出去
        keepalive: true,
      });
      if (!response.ok) throw new Error(String(response.status));
    } catch {
      // 没写上：留着，下次再写或重连对齐时一起补上（本地已经更新，显示不受影响）
      pendingRef.current = mergeReadStateUpdates(update, pendingRef.current);
    }
  }, []);

  /** 攒一下再写：一直看着房间时每条新消息都会推进已读位置 */
  const queue = useCallback(
    (update: ReadStateUpdate, schedule = true) => {
      pendingRef.current = mergeReadStateUpdates(pendingRef.current, update);
      if (!schedule) return;
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => void flush(), 400);
    },
    [flush],
  );

  /** 这台设备上读了：本地马上更新，再写回 Server */
  const advance = useCallback(
    (rooms: Readonly<Record<string, number>>) => {
      const ahead = readSeqsAhead(rooms, readSeqsRef.current);
      if (Object.keys(ahead).length === 0) return;
      storeSeqs(ahead);
      readSeqsRef.current = mergeReadSeqs(readSeqsRef.current, ahead);
      setReadSeqs((current) => mergeReadSeqs(current, ahead));
      queue({ rooms: ahead });
    },
    [queue],
  );

  const markSchedulesSeen = useCallback(() => {
    const at = new Date().toISOString();
    try {
      localStorage.setItem(schedulesSeenKey, at);
    } catch {
      // 存不下就只在本页生效
    }
    setSchedulesSeenAt(at);
    queue({ schedulesSeenAt: at });
  }, [queue]);

  /**
   * 和 Server 对一次：Server 的并进来；本地（含升级前只存在 localStorage 里的）更新的写回去。
   * roomIds：现在能看到的房间，用来读本地缓存
   */
  const sync = useCallback(
    async (roomIds: readonly string[]) => {
      const { base, authToken, ready } = connectionRef.current;
      if (!ready || !authToken) return;
      const local: Record<string, number> = { ...readSeqsRef.current };
      for (const roomId of roomIds) {
        const stored = storedSeq(roomId);
        if (stored > (local[roomId] ?? 0)) local[roomId] = stored;
      }
      // 先按本地显示，免得等 Server 时一闪而过一排未读
      setReadSeqs((current) => mergeReadSeqs(current, local));
      const response = await fetch(`${base}/api/read-state`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!response.ok) return;
      const server = (await response.json()) as ReadState;
      apply(server);
      const ahead = readSeqsAhead(local, server.rooms);
      const localSeen = schedulesSeenRef.current;
      const update: ReadStateUpdate = {
        ...(Object.keys(ahead).length > 0 ? { rooms: ahead } : {}),
        ...(localSeen && localSeen > (server.schedulesSeenAt ?? "")
          ? { schedulesSeenAt: localSeen }
          : {}),
      };
      if (update.rooms || update.schedulesSeenAt) {
        queue(update, false);
        await flush();
      } else if (pendingRef.current.rooms || pendingRef.current.schedulesSeenAt) {
        // 之前没写上的
        await flush();
      }
    },
    [apply, flush, queue],
  );

  // 关页面、切走前把攒着的写出去
  useEffect(() => {
    const leave = () => {
      if (document.visibilityState === "hidden") void flush();
    };
    document.addEventListener("visibilitychange", leave);
    window.addEventListener("pagehide", leave);
    return () => {
      document.removeEventListener("visibilitychange", leave);
      window.removeEventListener("pagehide", leave);
      window.clearTimeout(timerRef.current);
    };
  }, [flush]);

  return { readSeqs, schedulesSeenAt, apply, advance, markSchedulesSeen, sync };
}

export type ReadStateApi = ReturnType<typeof useReadState>;
