import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChatMessage } from "@superhive/protocol";
import { createFrameClock, easeInOutCubic, easeOutQuint } from "./easing";
import type { TimelineEntry } from "./timeline";
import type { RoomScrollPosition } from "./room-cache";

/** 自绘滚动动画单帧最多推进的时间：约两帧，主线程卡顿时动画放慢而不是跳跃 */
const MAX_FRAME_STEP_MS = 32;

/** 消息列表的滚动：贴底、新消息计数、「回到最新」，以及展开更早消息时保持阅读位置 */
export function useMessageScroll({
  messages,
  username,
  timeline,
}: {
  messages: ChatMessage[];
  username: string;
  timeline: TimelineEntry[];
}) {
  const [pendingNewMessages, setPendingNewMessages] = useState(0);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const [shadowHost, setShadowHost] = useState<HTMLDivElement | null>(null);
  const [scrollContentElement, setScrollContentElement] = useState<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messageScrollContentRef = useRef<HTMLDivElement>(null);
  const bottomAnimationRef = useRef(0);
  const detachAnimationCancelRef = useRef<(() => void) | undefined>(undefined);
  const messageListRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const messageCountRef = useRef(0);
  const roomScrollRestoreRef = useRef<RoomScrollPosition | undefined>(undefined);
  const restoreRoomScroll = useCallback((position: RoomScrollPosition | undefined) => {
    cancelAnimationFrame(bottomAnimationRef.current);
    bottomAnimationRef.current = 0;
    detachAnimationCancelRef.current?.();
    roomScrollRestoreRef.current = position;
    messageCountRef.current = 0;
    nearBottomRef.current = position?.nearBottom ?? true;
    earlierScrollAnchorRef.current = undefined;
    setPendingNewMessages(0);
    setShowJumpToBottom(false);
  }, []);
  // 点「显示更早」把更早的消息插到上方：浏览器在贴顶（scrollTop=0，正是按钮的位置）时
  // 不会做滚动锚定，视口会落到插入内容的最顶部、读的位置被顶走。这里在点击瞬间记下
  // 「视口到内容底部的距离」（新消息只往上方插入，底部不动），渲染完成后按该距离恢复
  // scrollTop，正在读的内容保持在原位。jumpToMessage 也会扩大窗口，但它要滚到目标消息，不经过这里。
  const earlierScrollAnchorRef = useRef<number | undefined>(undefined);
  const captureScrollAnchor = () => {
    const list = messageListRef.current;
    earlierScrollAnchorRef.current = list
      ? Math.max(0, list.scrollHeight - list.scrollTop)
      : undefined;
  };
  useLayoutEffect(() => {
    const distance = earlierScrollAnchorRef.current;
    if (distance === undefined) return;
    earlierScrollAnchorRef.current = undefined;
    const list = messageListRef.current;
    if (list && typeof list.scrollTo === "function")
      list.scrollTo({ top: Math.max(0, list.scrollHeight - distance), behavior: "instant" });
  }, [timeline]);

  // 自绘滚动动画：每帧重读底部目标位置，消息异步变高（Markdown 渲染、content-visibility
  // 惰性布局）也能追踪并精确落底；原生 scrollIntoView({behavior:"smooth"}) 的目标在调用
  // 瞬间就固定了，内容随后变高会导致停在半路
  const scrollToBottom = useCallback((animated: boolean) => {
    cancelAnimationFrame(bottomAnimationRef.current);
    bottomAnimationRef.current = 0;
    detachAnimationCancelRef.current?.();
    setShowJumpToBottom(false);
    const list = messageListRef.current;
    if (!list || typeof list.scrollTo !== "function") return;
    nearBottomRef.current = true;
    const reduceMotion = document.documentElement.dataset.reduceMotion === "true";
    if (!animated || reduceMotion) {
      list.scrollTo({ top: list.scrollHeight, behavior: "instant" });
      return;
    }
    const startY = list.scrollTop;
    const initialDistance = Math.abs(list.scrollHeight - list.clientHeight - startY);
    if (initialDistance < 2) return;
    // 时长随距离自适应：短距离（一条新消息）从容一些，长距离（刷新进入）也不至于拖沓；
    // 长距离用慢起步的 ease-in-out——起步柔和可避开首屏渲染高峰，也不会高速冲进未布局区域
    const duration = Math.min(1100, Math.max(550, 260 + initialDistance * 0.45));
    const easing = initialDistance > list.clientHeight * 1.5 ? easeInOutCubic : easeOutQuint;
    // 进度按实际播放过的帧时间累计而不是墙钟：主线程被长任务卡住后，恢复的第一帧不会把
    // 落下的进度一次补上（实测曾冻住 528ms 后一帧跳 1800px），只会让动画放慢
    const clock = createFrameClock(MAX_FRAME_STEP_MS);
    // 用户主动滚动（滚轮/触摸板/触屏）时动画立即让位：既是正确的交互，也避免动画与用户
    // 输入每帧互抢 scrollTop 引发布局风暴（实测该冲突可导致渲染进程崩溃）
    const detach = () => {
      detachAnimationCancelRef.current = undefined;
      list.removeEventListener("wheel", stopForUserInput);
      list.removeEventListener("touchstart", stopForUserInput);
    };
    const stopForUserInput = () => {
      cancelAnimationFrame(bottomAnimationRef.current);
      bottomAnimationRef.current = 0;
      detach();
      nearBottomRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
    };
    detachAnimationCancelRef.current = detach;
    list.addEventListener("wheel", stopForUserInput, { passive: true });
    list.addEventListener("touchstart", stopForUserInput, { passive: true });
    const step = (now: number) => {
      const target = list.scrollHeight - list.clientHeight;
      const progress = Math.min(1, clock(now) / duration);
      const eased = easing(progress);
      list.scrollTo({ top: startY + (target - startY) * eased, behavior: "instant" });
      if (progress < 1) {
        bottomAnimationRef.current = requestAnimationFrame(step);
      } else {
        bottomAnimationRef.current = 0;
        detach();
      }
    };
    bottomAnimationRef.current = requestAnimationFrame(step);
  }, []);

  useLayoutEffect(() => {
    const previousCount = messageCountRef.current;
    messageCountRef.current = messages.length;
    const restored = roomScrollRestoreRef.current;
    if (restored) {
      const list = messageListRef.current;
      if (!list || !scrollContentElement?.isConnected) return;
      roomScrollRestoreRef.current = undefined;
      list.scrollTo({
        top: restored.nearBottom ? list.scrollHeight : restored.scrollTop,
        behavior: "instant",
      });
      setShowJumpToBottom(list.scrollHeight - list.scrollTop - list.clientHeight > 320);
      return;
    }
    const last = messages.at(-1);
    if (!last) return;
    const own = last.senderName.toLocaleLowerCase() === username.toLocaleLowerCase();
    if (nearBottomRef.current || own) {
      setPendingNewMessages(0);
      // 首屏（刷新、切换房间）：在首帧绘制前直接定位到底部，和 Slack / ChatGPT 打开会话一样，
      // 不从顶部播动画——那段动画正好落在启动渲染高峰里，任何长任务都会让它冻住再跳。
      // 随后 Markdown 替换占位导致的高度变化由下方 ResizeObserver 继续贴底
      scrollToBottom(previousCount !== 0);
    } else if (messages.length > previousCount) {
      setPendingNewMessages((current) => current + (messages.length - previousCount));
    }
    return undefined;
  }, [messages, username, scrollToBottom, scrollContentElement]);

  const handleMessageListScroll = useCallback(() => {
    // 动画进行中的 scroll 事件是程序驱动的，不代表用户离开了底部
    if (bottomAnimationRef.current) return;
    const list = messageListRef.current;
    if (!list) return;
    const distance = list.scrollHeight - list.scrollTop - list.clientHeight;
    const nearBottom = distance < 120;
    nearBottomRef.current = nearBottom;
    if (nearBottom) setPendingNewMessages(0);
    setShowJumpToBottom(distance > 320);
  }, []);

  // 读者在底部附近点「展开全文」：内容变高时不能被贴底逻辑拉到底，停在原处继续读。
  // 之后滚回底部时 handleMessageListScroll 会恢复贴底
  const releaseBottomPin = useCallback(() => {
    cancelAnimationFrame(bottomAnimationRef.current);
    bottomAnimationRef.current = 0;
    detachAnimationCancelRef.current?.();
    nearBottomRef.current = false;
  }, []);

  const jumpToLatest = useCallback(() => {
    setPendingNewMessages(0);
    scrollToBottom(true);
  }, [scrollToBottom]);

  // 消息内容异步变高（懒加载的 Markdown 渲染、图片等）时，若用户本就在底部附近则保持贴底。
  // 内容节点在 shadow root 中经 portal 挂载，比首次 commit 晚一拍，因此用 state 驱动附着时机
  useEffect(() => {
    const list = messageListRef.current;
    if (!list || !scrollContentElement || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (bottomAnimationRef.current || !nearBottomRef.current) return;
      const distance = list.scrollHeight - list.scrollTop - list.clientHeight;
      if (distance > 1) {
        list.scrollTo({ top: list.scrollHeight, behavior: "instant" });
      }
    });
    observer.observe(scrollContentElement);
    return () => observer.disconnect();
  }, [scrollContentElement]);

  return {
    pendingNewMessages,
    setPendingNewMessages,
    showJumpToBottom,
    setShowJumpToBottom,
    shadowHost,
    setShadowHost,
    setScrollContentElement,
    messagesEndRef,
    messageScrollContentRef,
    bottomAnimationRef,
    detachAnimationCancelRef,
    messageListRef,
    nearBottomRef,
    messageCountRef,
    captureScrollAnchor,
    scrollToBottom,
    handleMessageListScroll,
    releaseBottomPin,
    jumpToLatest,
    restoreRoomScroll,
  };
}

export type MessageScroll = ReturnType<typeof useMessageScroll>;
