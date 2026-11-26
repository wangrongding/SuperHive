import { useCallback, useRef, useState } from "react";
import type {
  ChatMessage,
  Invocation,
  Participant,
  TraceStep,
  WhiteboardEntry,
} from "@superhive/protocol";
import { serverError } from "./server-text";
import { upsertWhiteboardEntry } from "./whiteboard";
import { t } from "./i18n";
import type { LoadingPhase } from "./loading-status";

/**
 * 当前房间的数据：成员、消息、调用、白板、定时、权限申请和调用过程，以及连接用到的游标。
 * 换房间时由 App 清空，WebSocket 事件往里合并（见 useRoomConnection）
 */
export function useRoomData({
  base,
  authToken,
  currentRoomId,
}: {
  base: string;
  authToken: string | undefined;
  currentRoomId: string;
}) {
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // 收到房间快照之前为 false：区分"还在加载"和"房间真的是空的"，避免欢迎页闪现
  const [messagesLoaded, setMessagesLoaded] = useState(false);
  const [loadingPhase, setLoadingPhase] = useState<LoadingPhase>("joining");
  const [invocations, setInvocations] = useState<ReadonlyMap<string, Invocation>>(new Map());
  const [whiteboard, setWhiteboard] = useState<ReadonlyMap<string, WhiteboardEntry>>(new Map());
  const whiteboardEpochRef = useRef(0);
  const whiteboardChangesRef = useRef(new Map<string, number>());
  /** 还在等人批的权限申请（提问消息 ID） */
  const [pendingApprovals, setPendingApprovals] = useState<ReadonlySet<string>>(new Set());
  /**
   * 调用的实时过程（房主和获准看过程的访客的页面会收到）。结束后在这个页面里留着，
   * 刷新或切换房间就没了；服务端不保存。
   */
  const [traces, setTraces] = useState<ReadonlyMap<string, TraceStep[]>>(new Map());
  /** 收到过结束标记的调用：同一个调用重试时重新开始记，不和上一次的步骤混在一起 */
  const endedTracesRef = useRef(new Set<string>());
  const socketRef = useRef<WebSocket | undefined>(undefined);
  const retryRef = useRef(0);
  const latestSeqRef = useRef(0);
  const participantStatusRef = useRef(new Map<string, Participant["status"]>());

  const loadWhiteboardHistory = useCallback(async () => {
    const epoch = whiteboardEpochRef.current;
    const changes = new Map(whiteboardChangesRef.current);
    const response = await fetch(
      `${base}/api/rooms/${encodeURIComponent(currentRoomId)}/whiteboard?view=all`,
      {
        headers: { Authorization: `Bearer ${authToken}` },
      },
    );
    if (!response.ok) throw new Error(t("无法加载白板历史。"));
    const payload = (await response.json()) as { entries: WhiteboardEntry[] };
    setWhiteboard((current) => {
      if (whiteboardEpochRef.current !== epoch) return current;
      const next = new Map<string, WhiteboardEntry>();
      for (const [entryId, entry] of current) {
        if (changes.get(entryId) !== whiteboardChangesRef.current.get(entryId))
          next.set(entryId, entry);
      }
      for (const entry of payload.entries) {
        if (
          entry.roomId === currentRoomId &&
          changes.get(entry.id) === whiteboardChangesRef.current.get(entry.id)
        )
          next.set(entry.id, entry);
      }
      return next;
    });
  }, [base, authToken, currentRoomId]);

  async function changeWhiteboardArchive(entries: WhiteboardEntry[], archive: boolean) {
    const epoch = whiteboardEpochRef.current;
    const changes = new Map(whiteboardChangesRef.current);
    const response = await fetch(
      `${base}/api/rooms/${encodeURIComponent(currentRoomId)}/whiteboard/${archive ? "archive" : "restore"}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ entries: entries.map(({ id, updatedAt }) => ({ id, updatedAt })) }),
      },
    );
    if (!response.ok) {
      const failure: unknown = await response.json().catch(() => ({}));
      throw new Error(serverError(failure) ?? t("白板操作失败，请刷新后重试。"));
    }
    const payload = (await response.json()) as { entries: WhiteboardEntry[] };
    if (whiteboardEpochRef.current !== epoch) return;
    const changedDuringRequest = new Set<string>();
    for (const entry of payload.entries) {
      if (changes.get(entry.id) !== whiteboardChangesRef.current.get(entry.id))
        changedDuringRequest.add(entry.id);
      whiteboardChangesRef.current.set(
        entry.id,
        (whiteboardChangesRef.current.get(entry.id) ?? 0) + 1,
      );
    }
    setWhiteboard((current) => {
      if (whiteboardEpochRef.current !== epoch) return current;
      return payload.entries.reduce(
        (next, entry) =>
          changedDuringRequest.has(entry.id) && !next.has(entry.id)
            ? next
            : upsertWhiteboardEntry(next, entry),
        current,
      );
    });
  }

  return {
    participants,
    setParticipants,
    messages,
    setMessages,
    messagesLoaded,
    setMessagesLoaded,
    loadingPhase,
    setLoadingPhase,
    invocations,
    setInvocations,
    whiteboard,
    setWhiteboard,
    whiteboardEpochRef,
    whiteboardChangesRef,
    pendingApprovals,
    setPendingApprovals,
    traces,
    setTraces,
    endedTracesRef,
    socketRef,
    retryRef,
    latestSeqRef,
    participantStatusRef,
    loadWhiteboardHistory,
    changeWhiteboardArchive,
  };
}

export type RoomData = ReturnType<typeof useRoomData>;
