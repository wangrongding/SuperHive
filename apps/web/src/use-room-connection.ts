import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { sortParticipantsByLastSeen } from "@superhive/protocol";
import type {
  Invocation,
  MessagesResponse,
  MetaResponse,
  RoomSummary,
  Schedule,
  ServerEvent,
} from "@superhive/protocol";
import { localizeServerPayload } from "./server-text";
import { upsertInvocation } from "./invocations";
import { upsertWhiteboardEntry } from "./whiteboard";
import { isLiveInvocation, mergeTraceSteps } from "./live-trace";
import type { useAttention } from "./attention-alerts";
import type { useSlowOps } from "./slow-ops";
import { resolveWebSocketUrl } from "./server-url";
import { t } from "./i18n";
import type { MessageNotificationMode } from "./app-storage";
import { showBrowserNotification, playNotificationTone } from "./browser-notify";
import { agentProviderLabel } from "./agent-setup";
import { mergeMessages } from "./timeline";
import type { RoomData } from "./use-room-data";

/** 跨房间的全局事件交给 App 处理：Agent 任务、提及 */
export type GlobalEvents = {
  onInvocation: (invocation: Invocation) => void;
  /** 定时任务跨房间推送：左侧「定时任务」面板合并 */
  onSchedule: (schedule: Schedule) => void;
  onRoomActivity: () => void;
  onSnapshot: () => void;
};

/**
 * 当前房间的 WebSocket 连接：加入房间、收快照和增量事件合并进 useRoomData 的状态，
 * 断线后退避重连，重连后补拉断线期间的消息；另外每 15 秒发一次心跳
 */
export function useRoomConnection({
  meta,
  username,
  authToken,
  base,
  currentRoomId,
  room,
  refreshRooms,
  switchRoom,
  upsertRoom,
  setRooms,
  onAccessLost,
  setConnectionState,
  setError,
  setArtifactsEpoch,
  setPendingNewMessages,
  setRecallCandidateId,
  setWorktreeNotices,
  worktreeNoticeVersion,
  setPendingAnswers,
  notificationPreferencesRef,
  slowOpsRef,
  setIncidentAttention,
  attentionRef,
  globalEventsRef,
}: {
  meta: MetaResponse | undefined;
  username: string;
  authToken: string | undefined;
  base: string;
  currentRoomId: string;
  room: RoomData;
  refreshRooms: () => Promise<void>;
  switchRoom: (roomId: string) => void;
  upsertRoom: (room: RoomSummary) => void;
  setRooms: Dispatch<SetStateAction<RoomSummary[]>>;
  onAccessLost: ((reason: "expired" | "revoked") => void) | undefined;
  setConnectionState: Dispatch<SetStateAction<"connecting" | "online" | "offline">>;
  setError: Dispatch<SetStateAction<string | undefined>>;
  setArtifactsEpoch: Dispatch<SetStateAction<number>>;
  setPendingNewMessages: Dispatch<SetStateAction<number>>;
  setRecallCandidateId: Dispatch<SetStateAction<string | undefined>>;
  setWorktreeNotices: Dispatch<SetStateAction<Map<string, { batchId: string; count: number }>>>;
  worktreeNoticeVersion: RefObject<number>;
  setPendingAnswers: Dispatch<SetStateAction<ReadonlyMap<string, string>>>;
  notificationPreferencesRef: RefObject<{
    messageNotifications: MessageNotificationMode;
    notificationSound: boolean;
    presenceNotifications: boolean;
  }>;
  slowOpsRef: RefObject<ReturnType<typeof useSlowOps> | undefined>;
  /** 需要房主处理的故障单和规则提议数（只推给这台电脑上的房主页面） */
  setIncidentAttention: (attention: number) => void;
  attentionRef: RefObject<ReturnType<typeof useAttention> | undefined>;
  globalEventsRef: RefObject<GlobalEvents>;
}) {
  const {
    setParticipants,
    setMessages,
    setMessagesLoaded,
    setLoadingPhase,
    setInvocations,
    setWhiteboard,
    whiteboardEpochRef,
    whiteboardChangesRef,
    setPendingApprovals,
    setTraces,
    endedTracesRef,
    socketRef,
    retryRef,
    latestSeqRef,
    participantStatusRef,
  } = room;
  const reconnectTimerRef = useRef<number | undefined>(undefined);
  const recalledInvocationsRef = useRef(new Set<string>());

  const catchUp = useCallback(
    async (afterSeq: number) => {
      if (!meta || !authToken || afterSeq <= 0) return;
      const response = await fetch(
        `${base}/api/rooms/${encodeURIComponent(currentRoomId)}/messages?afterSeq=${afterSeq}`,
        { headers: { Authorization: `Bearer ${authToken}` } },
      );
      if (!response.ok) throw new Error(t("增量消息拉取失败 ({0})", { 0: response.status }));
      const payload = localizeServerPayload((await response.json()) as MessagesResponse);
      setMessages((current) => mergeMessages(current, payload.messages));
      latestSeqRef.current = Math.max(latestSeqRef.current, payload.latestSeq);
    },
    [authToken, base, currentRoomId, meta],
  );

  useEffect(() => {
    if (!meta || !username || !authToken) return;
    let cancelled = false;
    let reconnectAllowed = true;
    let snapshotTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      if (cancelled) return;
      setConnectionState("connecting");
      setLoadingPhase("joining");
      const socket = new WebSocket(
        resolveWebSocketUrl({
          serverBase: base,
          development: import.meta.env.DEV,
          advertisedUrl: meta.wsUrl,
        }),
      );
      socketRef.current = socket;
      snapshotTimer = setTimeout(() => socket.close(), 10_000);
      socket.addEventListener("open", () => {
        if (cancelled) return;
        setLoadingPhase("messages");
        socket.send(
          JSON.stringify({
            type: "participant.join",
            username,
            participantType: "human",
            roomId: currentRoomId,
            token: authToken,
          }),
        );
      });
      socket.addEventListener("message", (rawEvent) => {
        const event = localizeServerPayload(JSON.parse(String(rawEvent.data)) as ServerEvent);
        if (event.type === "room.snapshot") {
          clearTimeout(snapshotTimer);
          recalledInvocationsRef.current = new Set(
            (event.invocations ?? []).filter((item) => item.messageRecalled).map((item) => item.id),
          );
          const beforeReconnect = latestSeqRef.current;
          participantStatusRef.current = new Map(
            event.participants.map((participant) => [participant.id, participant.status]),
          );
          setParticipants(sortParticipantsByLastSeen(event.participants));
          setMessages((current) => mergeMessages(current, event.messages));
          setMessagesLoaded(true);
          // 快照里的调用与白板是服务端当前全集，直接替换（重连期间的变化也一并对齐）
          setInvocations(
            new Map((event.invocations ?? []).map((invocation) => [invocation.id, invocation])),
          );
          setWhiteboard(new Map((event.whiteboard ?? []).map((entry) => [entry.id, entry])));
          whiteboardEpochRef.current += 1;
          whiteboardChangesRef.current.clear();
          setPendingApprovals(new Set(event.approvals ?? []));
          // 断线期间可能有新附件或撤回
          setArtifactsEpoch((current) => current + 1);
          // 重连后服务端会重新补发执行中调用的过程；已经结束的留着汇总
          {
            const live = new Set(
              (event.invocations ?? [])
                .filter((invocation) => isLiveInvocation(invocation))
                .filter((invocation) => !invocation.messageRecalled)
                .map((invocation) => invocation.id),
            );
            setTraces(
              (current) =>
                new Map(
                  [...current].filter(
                    ([invocationId]) =>
                      !live.has(invocationId) && !recalledInvocationsRef.current.has(invocationId),
                  ),
                ),
            );
          }
          latestSeqRef.current = Math.max(latestSeqRef.current, event.latestSeq);
          retryRef.current = 0;
          setConnectionState("online");
          setError(undefined);
          void refreshRooms().catch(() => undefined);
          globalEventsRef.current.onSnapshot();
          if (beforeReconnect > 0)
            void catchUp(beforeReconnect).catch((reason: unknown) => setError(String(reason)));
        } else if (event.type === "room.cleared") {
          if (event.message.roomId !== currentRoomId) return;
          if (event.whiteboardArchived) {
            whiteboardEpochRef.current += 1;
            setWhiteboard(
              (current) => new Map([...current].filter(([, entry]) => entry.archivedAt)),
            );
          }
          // 房主清空了房间：本地的消息和调用记录一并丢弃，只留清空后的话题分隔
          setMessages([event.message]);
          setArtifactsEpoch((current) => current + 1);
          setInvocations(new Map());
          setPendingNewMessages(0);
          setRecallCandidateId(undefined);
          latestSeqRef.current = Math.max(latestSeqRef.current, event.message.seq);
        } else if (event.type === "message.deleted") {
          if (event.message.roomId !== currentRoomId) return;
          setMessages((current) => mergeMessages(current, [event.message]));
          setArtifactsEpoch((current) => current + 1);
          setRecallCandidateId((current) => (current === event.message.id ? undefined : current));
        } else if (event.type === "message.created") {
          if (event.message.roomId !== currentRoomId) return;
          setMessages((current) => mergeMessages(current, [event.message]));
          if (event.message.attachments?.length) setArtifactsEpoch((current) => current + 1);
          // 新的权限申请：等人批，选项可点
          if (event.message.approval) {
            const approvalId = event.message.id;
            setPendingApprovals((current) => new Set(current).add(approvalId));
          }
          latestSeqRef.current = Math.max(latestSeqRef.current, event.message.seq);
          socket.send(JSON.stringify({ type: "message.ack", seq: event.message.seq }));
          if (event.message.senderName.toLocaleLowerCase() !== username.toLocaleLowerCase()) {
            const preferences = notificationPreferencesRef.current;
            if (preferences.notificationSound) playNotificationTone();
            const mentioned = event.message.mentions.some(
              (mention) => mention.toLocaleLowerCase() === username.toLocaleLowerCase(),
            );
            const shouldNotify =
              preferences.messageNotifications === "all" ||
              (preferences.messageNotifications === "mentions" && mentioned);
            if (shouldNotify && document.visibilityState !== "visible") {
              showBrowserNotification(
                mentioned
                  ? t("{0} 在 SuperHive 提到了你", { 0: event.message.senderName })
                  : `${event.message.senderName} · # ${event.message.roomId}`,
                event.message.content.slice(0, 180) ||
                  (event.message.attachments?.length
                    ? t("[{0} 个附件]", { 0: event.message.attachments.length })
                    : ""),
              );
            }
          }
        } else if (event.type === "slow-op.snapshot") {
          slowOpsRef.current?.receiveSnapshot(event);
        } else if (event.type === "slow-op.recorded") {
          slowOpsRef.current?.receive(event.operation);
        } else if (event.type === "incidents.changed") {
          setIncidentAttention(event.attention);
        } else if (event.type === "worktree.cleanup") {
          worktreeNoticeVersion.current++;
          setWorktreeNotices((current) => {
            const next = new Map(current);
            if (event.state === "available")
              next.set(event.roomId, { batchId: event.batchId, count: event.count });
            else if (next.get(event.roomId)?.batchId === event.batchId) next.delete(event.roomId);
            return next;
          });
        } else if (event.type === "invocation.updated") {
          attentionRef.current?.observe(event.invocation);
          globalEventsRef.current.onInvocation(event.invocation);
          if (event.invocation.roomId !== currentRoomId) return;
          if (event.invocation.messageRecalled) {
            recalledInvocationsRef.current.add(event.invocation.id);
            endedTracesRef.current.delete(event.invocation.id);
            setTraces((current) => {
              const next = new Map(current);
              next.delete(event.invocation.id);
              return next;
            });
          }
          setInvocations((current) => upsertInvocation(current, event.invocation));
        } else if (event.type === "whiteboard.updated") {
          if (event.entry.roomId !== currentRoomId) return;
          whiteboardChangesRef.current.set(
            event.entry.id,
            (whiteboardChangesRef.current.get(event.entry.id) ?? 0) + 1,
          );
          setWhiteboard((current) => upsertWhiteboardEntry(current, event.entry));
        } else if (event.type === "invocation.trace") {
          if (event.roomId !== currentRoomId) return;
          if (recalledInvocationsRef.current.has(event.invocationId)) return;
          const ended = endedTracesRef.current;
          const restarted = !event.ended && ended.delete(event.invocationId);
          if (event.ended) ended.add(event.invocationId);
          setTraces((current) => {
            const next = new Map(current);
            const previous = restarted ? [] : (current.get(event.invocationId) ?? []);
            const steps = mergeTraceSteps(previous, event.steps);
            if (steps.length) next.set(event.invocationId, steps);
            else next.delete(event.invocationId);
            // 结束后的汇总只留最近 50 个，页面开久了也不会越攒越多
            for (const invocationId of next.keys()) {
              if (next.size <= 50) break;
              if (ended.has(invocationId)) next.delete(invocationId);
            }
            return next;
          });
        } else if (event.type === "approval.updated") {
          if (event.roomId !== currentRoomId) return;
          setPendingApprovals((current) => {
            if (!current.has(event.messageId)) return current;
            const next = new Set(current);
            next.delete(event.messageId);
            return next;
          });
        } else if (event.type === "schedule.updated") {
          globalEventsRef.current.onSchedule(event.schedule);
        } else if (event.type === "whiteboard.removed") {
          if (event.roomId !== currentRoomId) return;
          whiteboardChangesRef.current.set(
            event.entryId,
            (whiteboardChangesRef.current.get(event.entryId) ?? 0) + 1,
          );
          setWhiteboard((current) => {
            if (event.archivedEntry) return upsertWhiteboardEntry(current, event.archivedEntry);
            if (!current.has(event.entryId)) return current;
            const next = new Map(current);
            next.delete(event.entryId);
            return next;
          });
        } else if (event.type === "presence.changed") {
          const previousStatus = participantStatusRef.current.get(event.participant.id);
          participantStatusRef.current.set(event.participant.id, event.participant.status);
          setParticipants((current) => {
            const byId = new Map(current.map((participant) => [participant.id, participant]));
            byId.set(event.participant.id, event.participant);
            return sortParticipantsByLastSeen([...byId.values()]);
          });
          if (
            notificationPreferencesRef.current.presenceNotifications &&
            document.visibilityState !== "visible" &&
            event.participant.type === "agent" &&
            event.participant.username.toLocaleLowerCase() !== username.toLocaleLowerCase() &&
            (event.participant.status === "offline" ||
              (event.participant.status === "online" && previousStatus === "offline"))
          ) {
            showBrowserNotification(
              `${event.participant.username} ${event.participant.status === "online" ? t("已上线") : t("已离线")}`,
              `#${event.participant.roomId} · ${agentProviderLabel(event.participant.provider)}`,
            );
          }
        } else if (event.type === "rooms.changed") {
          upsertRoom(event.room);
          if (event.room.id === currentRoomId && event.room.archivedAt) {
            setError(t("房间 # {0} 已被归档，已切换回默认房间。", { 0: event.room.name }));
            switchRoom("general");
          }
        } else if (event.type === "room.activity") {
          globalEventsRef.current.onRoomActivity();
          setRooms((current) =>
            current.map((room) =>
              room.id === event.roomId
                ? {
                    ...room,
                    latestSeq: event.latestSeq,
                    onlineCount: event.onlineCount,
                    ...(event.lastActivityAt ? { lastActivityAt: event.lastActivityAt } : {}),
                  }
                : room,
            ),
          );
        } else if (event.type === "error") {
          if (event.code === "SESSION_EXPIRED" || event.code === "SESSION_REVOKED") {
            // 访问到期或被房主移除：不再重连，回到入口页给出原因
            reconnectAllowed = false;
            socket.close();
            onAccessLost?.(event.code === "SESSION_EXPIRED" ? "expired" : "revoked");
          } else if (event.code === "USERNAME_TAKEN") {
            reconnectAllowed = false;
            setConnectionState("offline");
            setError(
              t("用户名 {0} 已被同名 Agent 或其他身份占用，请点击右上角“退出”后更换用户名。", {
                0: username,
              }),
            );
            socket.close();
          } else if (event.code === "ROOM_ARCHIVED") {
            reconnectAllowed = false;
            setError(t("房间 # {0} 已归档，无法加入，已切换回默认房间。", { 0: currentRoomId }));
            socket.close();
            switchRoom("general");
          } else if (event.text) {
            // 新服务端：说明已经是结构化文案、按当前语言显示，比按错误码猜更准确
            if (
              event.code === "INVALID_ANSWER" ||
              event.code === "QUESTION_CLOSED" ||
              event.code === "QUESTION_NOT_FOUND" ||
              event.code === "ANSWER_FAILED"
            ) {
              setPendingAnswers(new Map());
            }
            setError(event.message);
          } else if (event.code === "FORBIDDEN") {
            // 旧服务端只发英文说明，按错误码给出中文提示
            setError(t("只能撤回自己发送的消息。"));
          } else if (event.code === "MESSAGE_NOT_FOUND" || event.code === "DELETE_FAILED") {
            setError(t("撤回失败：消息不存在或已被处理。"));
          } else if (event.code === "INVOCATION_NOT_RETRYABLE") {
            setError(t("这次调用当前无法重试：它可能已在进行中，或触发消息已被撤回。"));
          } else if (event.code === "INVOCATION_NOT_FOUND") {
            setError(t("找不到这次调用，它可能属于其他房间或已被清理。"));
          } else if (
            event.code === "INVALID_ANSWER" ||
            event.code === "QUESTION_CLOSED" ||
            event.code === "QUESTION_NOT_FOUND" ||
            event.code === "ANSWER_FAILED"
          ) {
            // 点选没被接受：放开选项让人重选，选择与输入保留在表单里
            setPendingAnswers(new Map());
            setError(event.message);
          } else {
            setError(event.message);
          }
        }
      });
      socket.addEventListener("close", () => {
        clearTimeout(snapshotTimer);
        if (cancelled || !reconnectAllowed) return;
        setConnectionState("offline");
        const wait = Math.min(10_000, 500 * 2 ** retryRef.current++);
        reconnectTimerRef.current = window.setTimeout(connect, wait);
      });
      socket.addEventListener("error", () => socket.close());
    };

    connect();
    const heartbeat = window.setInterval(() => {
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({ type: "presence.heartbeat" }));
      }
    }, 15_000);

    return () => {
      cancelled = true;
      clearTimeout(snapshotTimer);
      window.clearInterval(heartbeat);
      window.clearTimeout(reconnectTimerRef.current);
      socketRef.current?.close();
    };
  }, [base, catchUp, currentRoomId, meta, refreshRooms, switchRoom, upsertRoom, username]);
}
