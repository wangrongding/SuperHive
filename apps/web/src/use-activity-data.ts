import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";
import type { ChatMessage, Invocation, MetaResponse, UsageSummary } from "@superhive/protocol";
import { localizeServerPayload } from "./server-text";
import { isInFlight, needsAttention } from "./activity";
import type { useAttention } from "./attention-alerts";
import { t } from "./i18n";
import type { ReadStateApi } from "./read-state";
import type { GlobalEvents } from "./use-room-connection";
import { useSchedules } from "./use-schedules";

/** 跨房间的数据：提及我的消息、各房间的 Agent 任务、搜索与用量；随全局事件更新 */
export function useActivityData({
  base,
  meta,
  authToken,
  username,
  currentRoomId,
  readState,
  attentionRef,
  globalEventsRef,
}: {
  base: string;
  meta: MetaResponse | undefined;
  authToken: string | undefined;
  username: string;
  currentRoomId: string;
  readState: ReadStateApi;
  attentionRef: RefObject<ReturnType<typeof useAttention> | undefined>;
  globalEventsRef: RefObject<GlobalEvents>;
}) {
  const [mentionMessages, setMentionMessages] = useState<ChatMessage[]>([]);
  const [activeInvocations, setActiveInvocations] = useState<ReadonlyMap<string, Invocation>>(
    new Map(),
  );
  const [invocationMessages, setInvocationMessages] = useState<ReadonlyMap<string, ChatMessage>>(
    new Map(),
  );
  const [onlineInvocationIds, setOnlineInvocationIds] = useState<ReadonlySet<string>>(new Set());
  const { readSeqs, advance: advanceReadSeqs, apply: applyReadState } = readState;
  const schedules = useSchedules({
    base,
    meta,
    authToken,
    username,
    seenAt: readState.schedulesSeenAt,
    markSeen: readState.markSchedulesSeen,
  });
  const { onInvocation: onScheduleInvocation, onSchedule, refresh: refreshSchedules } = schedules;

  const authorizedJson = useCallback(
    async <T>(path: string): Promise<T> => {
      if (!meta || !authToken) throw new Error(t("尚未连接 Hive Server。"));
      const response = await fetch(`${base}${path}`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!response.ok) throw new Error(t("请求失败 ({0})", { 0: response.status }));
      return localizeServerPayload((await response.json()) as T);
    },
    [base, meta],
  );

  const loadUsage = useCallback(
    (roomId: string, days: number, alertTokens: number) =>
      authorizedJson<UsageSummary>(
        `/api/rooms/${encodeURIComponent(roomId)}/usage?days=${days}&alert=${Math.round(alertTokens)}`,
      ),
    [authorizedJson],
  );

  const refreshMentions = useCallback(async () => {
    if (!username) return;
    const payload = await authorizedJson<{ messages: ChatMessage[] }>(
      `/api/mentions?username=${encodeURIComponent(username)}`,
    );
    setMentionMessages(payload.messages);
  }, [authorizedJson, username]);

  const refreshTasks = useCallback(async () => {
    const payload = await authorizedJson<{
      invocations: Invocation[];
      messages: ChatMessage[];
      onlineInvocationIds?: string[];
    }>("/api/invocations");
    setOnlineInvocationIds(new Set(payload.onlineInvocationIds ?? []));
    attentionRef.current?.seed(payload.invocations);
    setActiveInvocations(
      new Map(payload.invocations.map((invocation) => [invocation.id, invocation])),
    );
    setInvocationMessages(new Map(payload.messages.map((message) => [message.id, message])));
  }, [authorizedJson]);

  const searchMessages = useCallback(
    async (query: string) =>
      (
        await authorizedJson<{ messages: ChatMessage[] }>(
          `/api/search?q=${encodeURIComponent(query)}`,
        )
      ).messages,
    [authorizedJson],
  );

  // 跨房间数据随全局事件更新：调用状态直接合并，新的提及合并拉取（同一秒内多次活动只查一次）
  useEffect(() => {
    let mentionTimer: number | undefined;
    let taskTimer: number | undefined;
    const debounced = (timer: number | undefined, run: () => Promise<void>, delay: number) => {
      window.clearTimeout(timer);
      return window.setTimeout(() => void run().catch(() => undefined), delay);
    };
    globalEventsRef.current = {
      onInvocation: (invocation) => {
        setActiveInvocations((current) => {
          const next = new Map(current);
          if (isInFlight(invocation) || needsAttention(invocation))
            next.set(invocation.id, invocation);
          else next.delete(invocation.id);
          return next;
        });
        taskTimer = debounced(taskTimer, refreshTasks, 1_000);
        onScheduleInvocation(invocation);
      },
      onSchedule,
      onReadState: (state) => {
        applyReadState(state);
        // 别的设备上看过这些房间：那里「完成未看」的任务也算看过了
        attentionRef.current?.markRoomsSeen(Object.keys(state.rooms));
      },
      onRoomActivity: () => {
        mentionTimer = debounced(mentionTimer, refreshMentions, 800);
      },
      onSnapshot: () => {
        void refreshMentions().catch(() => undefined);
        void refreshTasks().catch(() => undefined);
        void refreshSchedules().catch(() => undefined);
      },
    };
    return () => {
      window.clearTimeout(mentionTimer);
      window.clearTimeout(taskTimer);
    };
  }, [
    applyReadState,
    onSchedule,
    onScheduleInvocation,
    refreshMentions,
    refreshSchedules,
    refreshTasks,
  ]);

  const unreadMentionCount = useMemo(
    () =>
      mentionMessages.filter(
        (message) =>
          message.roomId !== currentRoomId && message.seq > (readSeqs[message.roomId] ?? 0),
      ).length,
    [currentRoomId, mentionMessages, readSeqs],
  );
  /**
   * 在跑的任务（转圈）：Agent 离线、还没送达的排队任务不算——它在等 Agent 上线，
   * 停掉的 Agent 名下这种任务会一直留着，转圈看着像卡住了。消息下的状态写着「等待上线」
   */
  const spinning = useCallback(
    (invocation: Invocation) =>
      isInFlight(invocation) &&
      !(
        invocation.status === "queued" &&
        !invocation.receivedAt &&
        !onlineInvocationIds.has(invocation.id)
      ),
    [onlineInvocationIds],
  );
  const taskCounts = useMemo(() => {
    let attention = 0;
    let inFlight = 0;
    for (const invocation of activeInvocations.values()) {
      if (needsAttention(invocation)) attention += 1;
      else if (spinning(invocation)) inFlight += 1;
    }
    return { attention, inFlight };
  }, [activeInvocations, spinning]);
  /** 每个房间正在跑、需要处理的任务数：房间列表右侧据此显示状态 */
  const roomTaskCounts = useMemo(() => {
    const counts = new Map<string, { attention: number; inFlight: number }>();
    for (const invocation of activeInvocations.values()) {
      const entry = counts.get(invocation.roomId) ?? { attention: 0, inFlight: 0 };
      if (needsAttention(invocation)) entry.attention += 1;
      else if (spinning(invocation)) entry.inFlight += 1;
      counts.set(invocation.roomId, entry);
    }
    return counts;
  }, [activeInvocations, spinning]);

  function markMentionsRead() {
    const rooms: Record<string, number> = {};
    for (const message of mentionMessages) {
      if (message.seq > (rooms[message.roomId] ?? 0)) rooms[message.roomId] = message.seq;
    }
    advanceReadSeqs(rooms);
  }

  return {
    mentionMessages,
    activeInvocations,
    setActiveInvocations,
    invocationMessages,
    setInvocationMessages,
    onlineInvocationIds,
    loadUsage,
    refreshMentions,
    refreshTasks,
    searchMessages,
    unreadMentionCount,
    taskCounts,
    roomTaskCounts,
    markMentionsRead,
    schedules,
  };
}
