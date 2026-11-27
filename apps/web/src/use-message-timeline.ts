import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type { ChatMessage, Invocation, MessagesResponse, MetaResponse } from "@superhive/protocol";
import { attentionKind, attentionTarget, unloadedQuestion } from "./attention";
import { localizeServerPayload } from "./server-text";
import type { ProgressTarget } from "./progress";
import { t } from "./i18n";
import { mergeMessages, buildTimeline, type TimelineEntry } from "./timeline";
import type { MessageScroll } from "./use-message-scroll";

/** 跳转时短暂高亮的「另一头」：消息和调用（状态条、过程卡）各一组 */
export type FlashTargets = {
  messageIds: ReadonlySet<string>;
  invocationIds: ReadonlySet<string>;
};
const EMPTY_FLASH: FlashTargets = { messageIds: new Set(), invocationIds: new Set() };

/** 消息列表的渲染窗口：只挂载当前话题里最近的一段，更早的按需展开 */
export function useMessageWindow({ messages }: { messages: ChatMessage[] }) {
  // 渲染窗口：只挂载最近的一段消息，重房间切换时的同步提交成本与内存尖峰被限定为常量；
  // 更早的消息按需点击展开（数据仍全量在 messages 中，仅渲染被窗口化）
  const [visibleLimit, setVisibleLimit] = useState(25);
  // 默认只显示当前话题（最近一条话题分隔之后）；更早的话题折叠，按需展开。
  // 展开状态绑定到分隔消息本身：开启新话题或切换房间后自动重新折叠
  const [expandedTopicId, setExpandedTopicId] = useState<string>();
  const currentTopic = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]!.kind === "topic") return { index, id: messages[index]!.id };
    }
    return undefined;
  }, [messages]);
  const earlierTopicCount =
    currentTopic && expandedTopicId !== currentTopic.id ? currentTopic.index : 0;
  const topicMessages = useMemo(
    () => (earlierTopicCount > 0 ? messages.slice(earlierTopicCount) : messages),
    [messages, earlierTopicCount],
  );
  const hiddenCount = Math.max(0, topicMessages.length - visibleLimit);
  const timeline = useMemo(
    () => buildTimeline(hiddenCount > 0 ? topicMessages.slice(-visibleLimit) : topicMessages),
    [topicMessages, visibleLimit, hiddenCount],
  );

  return {
    visibleLimit,
    setVisibleLimit,
    expandedTopicId,
    setExpandedTopicId,
    currentTopic,
    earlierTopicCount,
    hiddenCount,
    timeline,
  };
}

/** 跳到某条消息：扩大渲染窗口、补拉还没载入的更早消息、切房间后再定位，滚过去并短暂高亮 */
export function useMessageJump({
  messages,
  messagesLoaded,
  setMessages,
  meta,
  authToken,
  base,
  currentRoomId,
  currentRoomIdRef,
  currentTopic,
  visibleLimit,
  setVisibleLimit,
  setExpandedTopicId,
  setOpenMachineIds,
  closeMobilePanel,
  setError,
  setGotoNotice,
  scroll,
  timeline,
}: {
  messages: ChatMessage[];
  messagesLoaded: boolean;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  meta: MetaResponse | undefined;
  authToken: string | undefined;
  base: string;
  currentRoomId: string;
  currentRoomIdRef: RefObject<string>;
  currentTopic: { index: number; id: string } | undefined;
  visibleLimit: number;
  setVisibleLimit: Dispatch<SetStateAction<number>>;
  setExpandedTopicId: Dispatch<SetStateAction<string | undefined>>;
  setOpenMachineIds: Dispatch<SetStateAction<ReadonlySet<string>>>;
  closeMobilePanel: (restoreFocus?: boolean) => void;
  setError: Dispatch<SetStateAction<string | undefined>>;
  setGotoNotice: Dispatch<SetStateAction<string | undefined>>;
  scroll: MessageScroll;
  timeline: TimelineEntry[];
}) {
  const { messageListRef, bottomAnimationRef, detachAnimationCancelRef, nearBottomRef } = scroll;
  const [highlightedMessageId, setHighlightedMessageId] = useState<string>();
  const [pendingJumpId, setPendingJumpId] = useState<string>();
  /** 产物面板「定位到消息」：目标消息还没载入时先补拉，载入后再跳 */
  const [pendingLocate, setPendingLocate] = useState<string>();
  // 切换房间后待定位的消息（在新房间快照到达后再滚动过去）；带序号的不在最近记录里时先补拉
  const [crossRoomJump, setCrossRoomJump] = useState<{
    roomId: string;
    messageId: string;
    messageSeq?: number;
  }>();
  const setCrossRoomJumpId = (messageId: string | undefined, roomId = currentRoomId) =>
    setCrossRoomJump(messageId ? { roomId, messageId } : undefined);
  const [attentionJump, setAttentionJump] = useState<{
    invocation: Invocation;
    triggerSeq?: number;
  }>();
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  function locateAttention(invocation: Invocation, triggerSeq?: number) {
    if (window.matchMedia?.("(max-width: 1100px)").matches) closeMobilePanel(false);
    setAttentionJump({ invocation, ...(triggerSeq === undefined ? {} : { triggerSeq }) });
  }

  useEffect(() => {
    if (
      !attentionJump ||
      attentionJump.invocation.roomId !== currentRoomId ||
      !messagesLoaded ||
      !meta ||
      !authToken
    )
      return;
    let cancelled = false;
    const { invocation, triggerSeq } = attentionJump;
    const valid = () => !cancelled && currentRoomIdRef.current === invocation.roomId;
    const request = async (query: string) => {
      const response = await fetch(
        `${base}/api/rooms/${encodeURIComponent(invocation.roomId)}/messages?${query}`,
        {
          headers: { Authorization: `Bearer ${authToken}` },
        },
      );
      if (response.status === 404) return undefined;
      if (!response.ok) throw new Error(t("消息加载失败 ({0})", { 0: response.status }));
      return localizeServerPayload((await response.json()) as MessagesResponse);
    };
    const resolve = async () => {
      const loaded: ChatMessage[] = [];
      let historyComplete = true;
      const initial = attentionTarget(invocation, messagesRef.current);
      let target = messagesRef.current.find(
        (message) => message.id === initial.messageId && !message.deletedAt,
      );
      const question = attentionKind(invocation) === "question";
      if (question && initial.messageId === invocation.messageId) target = undefined;
      // 调用上记下了提问（新服务端）：没载入就从提问那条起往后补拉到已载入的最早一条
      // （和 locateMessage 一样连续补，不在列表里留空档），不用从触发消息往后一页页找
      const pending = question ? unloadedQuestion(invocation, messagesRef.current) : undefined;
      if (!target && pending) {
        const earliest = messagesRef.current[0]?.seq ?? Number.MAX_SAFE_INTEGER;
        let afterSeq = pending.messageSeq - 1;
        for (
          let page = 0;
          page < 10 && (page === 0 || afterSeq + 1 < earliest) && valid();
          page += 1
        ) {
          const result = await request(`afterSeq=${afterSeq}&limit=500`);
          if (!result?.messages.length) break;
          loaded.push(...result.messages);
          afterSeq = result.messages.at(-1)!.seq;
        }
        target = loaded.find((message) => message.id === pending.messageId && !message.deletedAt);
      } else if (!target && !question) {
        const result = await request(`messageId=${encodeURIComponent(initial.messageId)}&limit=1`);
        loaded.push(...(result?.messages ?? []));
        target = loaded.find((message) => message.id === initial.messageId && !message.deletedAt);
      }
      if (!target && !pending) {
        const trigger = messagesRef.current.find((message) => message.id === invocation.messageId);
        let afterSeq = trigger?.seq ?? triggerSeq;
        let page = await request(
          afterSeq === undefined
            ? `messageId=${encodeURIComponent(invocation.messageId)}&limit=500`
            : `afterSeq=${afterSeq - 1}&limit=500`,
        );
        for (let count = 0; page && count < 10 && valid(); count += 1) {
          loaded.push(...page.messages);
          afterSeq = page.messages.at(-1)?.seq;
          if (
            attentionKind(invocation) !== "question" ||
            afterSeq === undefined ||
            afterSeq >= page.latestSeq
          )
            break;
          if (count < 9) page = await request(`afterSeq=${afterSeq}&limit=500`);
          else historyComplete = false;
        }
      }
      if (!valid()) return;
      const combined = mergeMessages(loaded, messagesRef.current);
      const resolved = attentionTarget(invocation, combined);
      const messageId = historyComplete ? resolved.messageId : invocation.messageId;
      target =
        combined.find((message) => message.id === messageId && !message.deletedAt) ??
        combined.find((message) => message.id === invocation.messageId);
      setAttentionJump(undefined);
      if (!target) {
        setGotoNotice(t("这条消息已经不在了，可能被撤回或房间被清空。"));
        return;
      }
      setMessages(combined);
      setPendingLocate(target.id);
    };
    void resolve().catch((reason: unknown) => {
      if (!valid()) return;
      setAttentionJump(undefined);
      setError(reason instanceof Error ? reason.message : String(reason));
      const trigger = messagesRef.current.find((message) => message.id === invocation.messageId);
      if (trigger) setPendingLocate(trigger.id);
    });
    return () => {
      cancelled = true;
    };
  }, [attentionJump, currentRoomId, messagesLoaded, meta, authToken]);
  /**
   * 跳转时另一头也闪一下：从过程卡跳到原消息时闪卡片，从状态条跳到过程卡时闪状态条，
   * 从回复跳回原问题时闪回复。和目标的高亮同时开始、同样 2.2 秒
   */
  const [flash, setFlash] = useState<FlashTargets>(EMPTY_FLASH);
  const flashTimerRef = useRef(0);
  function flashOrigin(targets: { messageIds?: string[]; invocationIds?: string[] }) {
    window.clearTimeout(flashTimerRef.current);
    setFlash({
      messageIds: new Set(targets.messageIds),
      invocationIds: new Set(targets.invocationIds),
    });
    flashTimerRef.current = window.setTimeout(() => setFlash(EMPTY_FLASH), 2200);
  }
  useEffect(() => () => window.clearTimeout(flashTimerRef.current), []);

  // 点击已完成的调用跳到 Agent 回复：等目标消息挂载（可能需要先扩大渲染窗口）后再滚动并短暂高亮
  useEffect(() => {
    if (!pendingJumpId) return;
    const list = messageListRef.current;
    const root = list?.shadowRoot ?? list;
    const target = root?.querySelector<HTMLElement>(`[data-message-id="${pendingJumpId}"]`);
    if (!target) return;
    setPendingJumpId(undefined);
    cancelAnimationFrame(bottomAnimationRef.current);
    bottomAnimationRef.current = 0;
    detachAnimationCancelRef.current?.();
    nearBottomRef.current = false;
    const reduce =
      document.documentElement.dataset.reduceMotion === "true" ||
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    (target.querySelector<HTMLElement>(".question-options") ?? target).scrollIntoView({
      block: "center",
      behavior: reduce ? "auto" : "smooth",
    });
    setHighlightedMessageId(pendingJumpId);
  }, [pendingJumpId, timeline]);

  useEffect(() => {
    if (!highlightedMessageId) return;
    const list = messageListRef.current;
    const root = list?.shadowRoot ?? list;
    const target = root?.querySelector<HTMLElement>(`[data-message-id="${highlightedMessageId}"]`);
    const options = target?.querySelector<HTMLElement>(".question-options");
    const align = () => options?.scrollIntoView({ block: "center", behavior: "auto" });
    let observer: ResizeObserver | undefined;
    let frame = 0;
    const stop = () => {
      observer?.disconnect();
      cancelAnimationFrame(frame);
    };
    if (options && target) {
      align();
      if (typeof ResizeObserver !== "undefined") {
        observer = new ResizeObserver(() => {
          cancelAnimationFrame(frame);
          frame = requestAnimationFrame(align);
        });
        observer.observe(target);
        if (target.parentElement) observer.observe(target.parentElement);
      }
      list?.addEventListener("wheel", stop, { passive: true });
      list?.addEventListener("touchstart", stop, { passive: true });
      list?.addEventListener("pointerdown", stop);
      document.addEventListener("keydown", stop);
    }
    const timer = window.setTimeout(() => setHighlightedMessageId(undefined), 2200);
    return () => {
      window.clearTimeout(timer);
      stop();
      list?.removeEventListener("wheel", stop);
      list?.removeEventListener("touchstart", stop);
      list?.removeEventListener("pointerdown", stop);
      document.removeEventListener("keydown", stop);
    };
  }, [highlightedMessageId]);

  // 切到目标房间并拿到快照后再定位；不在最近加载的记录里时给出提示
  useEffect(() => {
    if (!crossRoomJump || crossRoomJump.roomId !== currentRoomId || !messagesLoaded) return;
    setCrossRoomJump(undefined);
    const { messageId, messageSeq } = crossRoomJump;
    if (messages.some((message) => message.id === messageId)) {
      jumpToMessage(messageId);
    } else if (messageSeq !== undefined) {
      void locateMessage({ messageId, messageSeq });
    } else {
      setError(t("这条消息较早，不在最近加载的记录里。"));
    }
  }, [crossRoomJump, messages, messagesLoaded, currentRoomId]);

  // 补拉的消息合进来之后再跳
  useEffect(() => {
    if (!pendingLocate || !messages.some((message) => message.id === pendingLocate)) return;
    setPendingLocate(undefined);
    jumpToMessage(pendingLocate);
  });

  function jumpToMessage(messageId: string) {
    const index = messages.findIndex((message) => message.id === messageId);
    if (index < 0) return;
    setOpenMachineIds((current) => new Set(current).add(messageId));
    if (currentTopic && index < currentTopic.index) setExpandedTopicId(currentTopic.id);
    const needed = messages.length - index;
    if (needed > visibleLimit) setVisibleLimit(needed + 10);
    setPendingJumpId(messageId);
  }

  /**
   * 跳到对话流底部某次调用的「思考中」过程卡：卡片一直挂在列表末尾，不受渲染窗口影响。
   * 找不到卡片（已经结束收起）时返回 false，由调用方决定退回到哪里
   */
  function jumpToProcess(invocationId: string, origin?: { invocationIds?: string[] }): boolean {
    const list = messageListRef.current;
    const root = list?.shadowRoot ?? list;
    const card = root?.querySelector<HTMLElement>(
      `.thinking-card[data-invocation-id="${invocationId}"]`,
    );
    if (!card) return false;
    cancelAnimationFrame(bottomAnimationRef.current);
    bottomAnimationRef.current = 0;
    detachAnimationCancelRef.current?.();
    const reduce =
      document.documentElement.dataset.reduceMotion === "true" ||
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    card.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
    flashOrigin({ invocationIds: [invocationId, ...(origin?.invocationIds ?? [])] });
    return true;
  }

  /**
   * 定位到产物所在的消息：已经载入的直接跳；更早的先从这条起往后补拉到已载入的最早一条，再跳。
   * 窄屏下先收起抽屉，让聊天流露出来。
   */
  /** 「进展」里点一条：有消息 ID 按 ID 找，只有序号（摘要里写的 #1234）按序号找 */
  function locateProgress(target: ProgressTarget) {
    if (target.invocation) {
      locateAttention(target.invocation);
      return;
    }
    const loaded = messages.find((message) =>
      target.messageId ? message.id === target.messageId : message.seq === target.messageSeq,
    );
    if (loaded) void locateMessage({ messageId: loaded.id, messageSeq: loaded.seq });
    else if (target.messageSeq !== undefined)
      void locateMessage({ messageId: target.messageId, messageSeq: target.messageSeq });
  }

  /** messageId 省略时按序号定位 */
  async function locateMessage(target: { messageId?: string | undefined; messageSeq: number }) {
    if (window.matchMedia?.("(max-width: 1100px)").matches) closeMobilePanel(false);
    const matches = (message: ChatMessage) =>
      target.messageId ? message.id === target.messageId : message.seq === target.messageSeq;
    const present = messages.find(matches);
    if (present) {
      jumpToMessage(present.id);
      return;
    }
    if (!meta || !authToken) return;
    const roomId = currentRoomId;
    const earliest = messages[0]?.seq ?? Number.MAX_SAFE_INTEGER;
    const loaded: ChatMessage[] = [];
    try {
      let afterSeq = target.messageSeq - 1;
      // 一次最多 500 条，最多补 10 次；再早的提示去搜索
      for (let page = 0; page < 10 && afterSeq + 1 < earliest; page += 1) {
        const response = await fetch(
          `${base}/api/rooms/${encodeURIComponent(roomId)}/messages?afterSeq=${afterSeq}&limit=500`,
          { headers: { Authorization: `Bearer ${authToken}` } },
        );
        if (!response.ok) throw new Error(t("消息加载失败 ({0})", { 0: response.status }));
        const payload = localizeServerPayload((await response.json()) as MessagesResponse);
        if (payload.messages.length === 0) break;
        loaded.push(...payload.messages);
        afterSeq = payload.messages.at(-1)!.seq;
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return;
    }
    if (roomId !== currentRoomIdRef.current) return;
    const found = loaded.find(matches);
    if (!found) {
      setGotoNotice(t("这条消息已经不在了，可能被撤回或房间被清空。"));
      return;
    }
    setMessages((current) => mergeMessages(current, loaded));
    setPendingLocate(found.id);
  }

  return {
    highlightedMessageId,
    setHighlightedMessageId,
    pendingJumpId,
    setPendingJumpId,
    setCrossRoomJumpId,
    setCrossRoomJump,
    jumpToMessage,
    jumpToProcess,
    flash,
    flashOrigin,
    locateProgress,
    locateAttention,
    locateMessage,
  };
}
