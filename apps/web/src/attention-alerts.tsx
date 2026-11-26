import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage, Invocation } from "@superhive/protocol";
import {
  attentionByRoom,
  attentionLabels,
  attentionTarget,
  attentionTransition,
  collectAttention,
  concernsMe,
  type AttentionItem,
  type AttentionKind,
  type AttentionTarget,
} from "./attention";
import { localized, t } from "./i18n";
import type { IncidentAttentionItem } from "./incidents-panel";
import "./styles/attention.css";
import { Tooltip } from "./tooltip";
import { Button, IconButton } from "./button";
import { Icon } from "./app-icons";

/**
 * 「需要你处理」的提醒：跨房间、按调用状态提醒（不只是当前房间的新消息）。
 * - system：页面在前台时页面内提示，不在前台时弹系统通知（没授权就退回页面内提示）
 * - page：只在页面内提示。已经连着飞书/微信的，选这个可以避免手机和电脑重复提醒
 * - off：不提醒，侧栏标记照常显示
 */
export type AttentionDelivery = "system" | "page" | "off";

export const attentionDeliveryOptions = localized(
  (): Array<{ id: AttentionDelivery; label: string; description: string }> => [
    {
      id: "system",
      label: t("系统通知"),
      description: t("页面不在前台时弹系统通知，在前台时页面内提示"),
    },
    {
      id: "page",
      label: t("只在页面内"),
      description: t("不弹系统通知；已连飞书或微信时选这个，免得重复提醒"),
    },
    { id: "off", label: t("关闭"), description: t("不提醒，侧栏标记照常显示") },
  ],
);

export type AttentionPreferences = {
  delivery: AttentionDelivery;
  sound: boolean;
};

export type AttentionToast = {
  id: string;
  kind: AttentionKind;
  invocation: Invocation;
};

const unseenLimit = 30;
const unseenMaxAgeMs = 3 * 24 * 60 * 60 * 1000;
/** 页面内提示不自己消失，只按条数封顶：最多留这么多条，同时只摆出最新的几条 */
const toastLimit = 20;
const visibleToasts = 3;

function unseenStorageKey(username: string): string {
  return `superhive.attention-unseen.${username.toLocaleLowerCase()}`;
}

function loadUnseen(username: string): Map<string, Invocation> {
  try {
    const raw = JSON.parse(localStorage.getItem(unseenStorageKey(username)) ?? "[]") as unknown;
    if (!Array.isArray(raw)) return new Map();
    const cutoff = Date.now() - unseenMaxAgeMs;
    return new Map(
      (raw as Invocation[])
        .filter(
          (item) =>
            item &&
            typeof item.id === "string" &&
            typeof item.roomId === "string" &&
            Date.parse(item.finishedAt ?? item.updatedAt) > cutoff,
        )
        .slice(-unseenLimit)
        .map((item) => [item.id, item]),
    );
  } catch {
    return new Map();
  }
}

function saveUnseen(username: string, unseen: ReadonlyMap<string, Invocation>): void {
  try {
    localStorage.setItem(unseenStorageKey(username), JSON.stringify([...unseen.values()]));
  } catch {
    // 存不了只影响刷新后是否还记得「完成未看」
  }
}

// 和消息提示音分开：需要处理是两声上扬，完成是一声低音，听声音就能分清
let toneContext: AudioContext | undefined;
export function playAttentionTone(kind: AttentionKind): void {
  const AudioContextConstructor =
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).AudioContext ??
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextConstructor) return;
  try {
    toneContext ??= new AudioContextConstructor();
    const context = toneContext;
    if (context.state === "suspended") void context.resume().catch(() => undefined);
    const notes = kind === "unseen" ? [523] : [660, 880];
    notes.forEach((frequency, index) => {
      const start = context.currentTime + index * 0.14;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.08, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.13);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.14);
      oscillator.addEventListener("ended", () => {
        oscillator.disconnect();
        gain.disconnect();
      });
    });
  } catch {
    // 页面还没收到过用户操作时，浏览器可能不让放声音
  }
}

export function attentionTitle(kind: AttentionKind, invocation: Invocation): string {
  switch (kind) {
    case "question":
      return t("{0} 在等你回答", { 0: invocation.agentName });
    case "approval":
      return t("{0} 的任务等你放行", { 0: invocation.agentName });
    case "decide":
      return t("{0} 的任务中途中断，等你决定是否继续", { 0: invocation.agentName });
    case "failed":
      return t("{0} 的任务失败了", { 0: invocation.agentName });
    case "unknown":
      return t("{0} 的任务结果未知", { 0: invocation.agentName });
    case "unseen":
      return t("{0} 做完了", { 0: invocation.agentName });
  }
}

function attentionBody(invocation: Invocation, roomName: string): string {
  const detail = invocation.detail ?? invocation.progress;
  return detail ? `# ${roomName} · ${detail}` : `# ${roomName}`;
}

export function useAttention({
  username,
  isOwner,
  currentRoomId,
  activeInvocations,
  messages = [],
  preferences,
  roomName,
  onOpen,
}: {
  username: string;
  isOwner: boolean;
  currentRoomId: string;
  /** 进行中和需要处理的调用（跨房间） */
  activeInvocations: ReadonlyMap<string, Invocation>;
  messages?: readonly ChatMessage[];
  preferences: AttentionPreferences;
  roomName: (roomId: string) => string;
  onOpen: (item: AttentionTarget) => void;
}) {
  const [unseen, setUnseen] = useState(() => loadUnseen(username));
  const [toasts, setToasts] = useState<AttentionToast[]>([]);
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  const knownRef = useRef(new Map<string, Invocation>());
  const latest = useRef({
    username,
    isOwner,
    currentRoomId,
    preferences,
    roomName,
    onOpen,
    activeInvocations,
    messages,
  });
  latest.current = {
    username,
    isOwner,
    currentRoomId,
    preferences,
    roomName,
    onOpen,
    activeInvocations,
    messages,
  };

  useEffect(() => setUnseen(loadUnseen(username)), [username]);
  useEffect(() => {
    if (username) saveUnseen(username, unseen);
  }, [unseen, username]);

  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  // 人回到页面、而且正看着这个房间：这个房间的「完成未看」就算看过了
  useEffect(() => {
    if (!visible) return;
    setUnseen((current) => {
      if (![...current.values()].some((item) => item.roomId === currentRoomId)) return current;
      return new Map([...current].filter(([, item]) => item.roomId !== currentRoomId));
    });
    // 已经回到那个房间：它的提示也算看过了，不用再手动关
    setToasts((current) =>
      current.some((toast) => toast.invocation.roomId === currentRoomId)
        ? current.filter((toast) => toast.invocation.roomId !== currentRoomId)
        : current,
    );
  }, [currentRoomId, visible]);

  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const dismissAllToasts = useCallback(() => setToasts([]), []);

  const open = useCallback((invocation: Invocation) => {
    setToasts((current) => current.filter((toast) => toast.invocation.id !== invocation.id));
    setUnseen((current) => {
      if (!current.has(invocation.id)) return current;
      const next = new Map(current);
      next.delete(invocation.id);
      return next;
    });
    const current =
      latest.current.activeInvocations.get(invocation.id) ??
      knownRef.current.get(invocation.id) ??
      invocation;
    latest.current.onOpen(attentionTarget(current, latest.current.messages));
  }, []);

  const alert = useCallback(
    (kind: AttentionKind, invocation: Invocation) => {
      const { preferences, currentRoomId, roomName } = latest.current;
      if (preferences.delivery === "off") return;
      const pageVisible = document.visibilityState === "visible";
      // 正看着这个房间：状态行上就能看到，不再另外打扰
      if (pageVisible && invocation.roomId === currentRoomId) return;
      if (preferences.sound) playAttentionTone(kind);
      const title = attentionTitle(kind, invocation);
      const body = attentionBody(invocation, roomName(invocation.roomId));
      if (
        !pageVisible &&
        preferences.delivery === "system" &&
        "Notification" in window &&
        Notification.permission === "granted"
      ) {
        try {
          // 每条任务一个 tag：不同任务的通知不会互相顶掉，同一任务的新状态替换旧的
          const notification = new Notification(title, {
            body,
            tag: `superhive-attention-${invocation.id}`,
          });
          notification.onclick = () => {
            window.focus();
            open(invocation);
            notification.close();
          };
          return;
        } catch {
          // 系统通知不可用时退回页面内提示
        }
      }
      setToasts((current) =>
        [
          ...current.filter((toast) => toast.invocation.id !== invocation.id),
          { id: `${invocation.id}:${kind}:${invocation.updatedAt}`, kind, invocation },
        ].slice(-toastLimit),
      );
    },
    [open],
  );

  /** 快照：只记下当前状态，不提醒（不知道这些是不是刚发生的） */
  const seed = useCallback((invocations: Iterable<Invocation>) => {
    for (const invocation of invocations) knownRef.current.set(invocation.id, invocation);
  }, []);

  /** 收到一条调用的新状态：新进入需要处理或刚做完、而且和我有关时提醒 */
  const observe = useCallback(
    (invocation: Invocation) => {
      const previous = knownRef.current.get(invocation.id);
      knownRef.current.set(invocation.id, invocation);
      const { username, isOwner, currentRoomId } = latest.current;
      if (invocation.status !== "completed") {
        setUnseen((current) => {
          if (!current.has(invocation.id)) return current;
          const next = new Map(current);
          next.delete(invocation.id);
          return next;
        });
      }
      const kind = attentionTransition(previous, invocation);
      // 提示说的状态已经过去了（比如失败后被重试、等回答的已经答了）：收起那条提示
      if (!kind && previous && previous.status !== invocation.status) {
        setToasts((current) =>
          current.some((toast) => toast.invocation.id === invocation.id)
            ? current.filter((toast) => toast.invocation.id !== invocation.id)
            : current,
        );
      }
      if (!kind || !concernsMe(invocation, { username, isOwner })) return;
      if (kind === "unseen") {
        if (document.visibilityState === "visible" && invocation.roomId === currentRoomId) return;
        setUnseen((current) => {
          const next = new Map(current);
          next.set(invocation.id, invocation);
          while (next.size > unseenLimit) next.delete(next.keys().next().value!);
          return next;
        });
      }
      alert(kind, invocation);
    },
    [alert],
  );

  const items = useMemo(
    () => collectAttention(activeInvocations.values(), unseen.values(), messages),
    [activeInvocations, unseen, messages],
  );
  const byRoom = useMemo(() => attentionByRoom(items), [items]);
  /** 每个房间「完成未看」的条数：侧栏在没有更急的事时显示 */
  const unseenByRoom = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of unseen.values()) counts.set(item.roomId, (counts.get(item.roomId) ?? 0) + 1);
    return counts;
  }, [unseen]);

  return {
    items,
    byRoom,
    unseenByRoom,
    observe,
    seed,
    open,
    toasts,
    dismissToast,
    dismissAllToasts,
  };
}

const toastIcons: Record<AttentionKind, string> = {
  question: "?",
  approval: "!",
  decide: "↻",
  failed: "×",
  unknown: "?",
  unseen: "✓",
};

/**
 * 页面内提示：右下角，点整条提示跳到对应任务。不会自己消失——不点就一直留着，
 * 点开、点 ×、点「全部关闭」或回到那个房间时才收起；同时只摆最新三条，更早的折成「还有 n 条」
 */
export function AttentionToasts({
  toasts,
  roomName,
  onOpen,
  onDismiss,
  onDismissAll,
}: {
  toasts: readonly AttentionToast[];
  roomName: (roomId: string) => string;
  onOpen: (invocation: Invocation) => void;
  onDismiss: (id: string) => void;
  onDismissAll: () => void;
}) {
  const shown = toasts.slice(-visibleToasts);
  const hidden = toasts.length - shown.length;
  return (
    <div className="attention-toasts" role="region" aria-label={t("任务提醒")} aria-live="polite">
      {toasts.length > 1 && (
        <div className="attention-toasts-bar">
          <span>{hidden > 0 ? t("还有 {0} 条", { 0: hidden }) : ""}</span>
          <Button size="sm" onClick={onDismissAll}>
            {t("全部关闭")}
          </Button>
        </div>
      )}
      {shown.map((toast) => (
        <AttentionToastItem
          key={toast.id}
          toast={toast}
          roomName={roomName}
          onOpen={onOpen}
          onDismiss={onDismiss}
        />
      ))}
    </div>
  );
}

function AttentionToastItem({
  toast,
  roomName,
  onOpen,
  onDismiss,
}: {
  toast: AttentionToast;
  roomName: (roomId: string) => string;
  onOpen: (invocation: Invocation) => void;
  onDismiss: (id: string) => void;
}) {
  return (
    <div className={`attention-toast ${toast.kind}`} role="status">
      {/* 整条提示都能点：跳到对应任务；只有右边的 × 是关闭 */}
      <Tooltip content={t("跳到这条任务")}>
        <button
          type="button"
          className="attention-toast-open"
          onClick={() => onOpen(toast.invocation)}
        >
          <span className="attention-toast-icon" aria-hidden="true">
            {toastIcons[toast.kind]}
          </span>
          <span className="attention-toast-text">
            <strong>{attentionTitle(toast.kind, toast.invocation)}</strong>
            <span>{attentionBody(toast.invocation, roomName(toast.invocation.roomId))}</span>
          </span>
        </button>
      </Tooltip>
      <IconButton
        size="sm"
        className="attention-toast-close"
        label={t("关闭提醒")}
        onClick={() => onDismiss(toast.id)}
      >
        <Icon name="close" size={14} />
      </IconButton>
    </div>
  );
}

/**
 * 侧栏「需要处理」分组：按最急的排在前面，手动拖好的房间顺序不受影响。
 * 本机房主还会看到升级给人的故障单和待批准的规则提议，排在任务后面。
 */
export function AttentionRoomGroup({
  items,
  incidents = [],
  roomName,
  onOpen,
  onOpenIncident,
}: {
  items: readonly AttentionItem[];
  incidents?: readonly IncidentAttentionItem[];
  roomName: (roomId: string) => string;
  onOpen: (invocation: Invocation) => void;
  onOpenIncident?: (item: IncidentAttentionItem) => void;
}) {
  const total = items.length + incidents.length;
  if (total === 0) return null;
  const shown = items.slice(0, 5);
  const shownIncidents = incidents.slice(0, Math.max(0, 5 - shown.length));
  return (
    <section className="attention-group" aria-label={t("需要你处理")}>
      <div className="attention-group-heading">
        <span>{t("需要你处理")}</span>
        <span className="panel-meta">{total}</span>
      </div>
      <ul>
        {shown.map((item) => (
          <li key={item.invocation.id}>
            <Tooltip content={attentionTitle(item.kind, item.invocation)}>
              <button
                type="button"
                className={`attention-row ${item.kind}`}
                onClick={() => onOpen(item.invocation)}
              >
                <span className="attention-kind">{attentionLabels[item.kind]}</span>
                <span className="attention-row-text">
                  {item.invocation.agentName} · # {roomName(item.roomId)}
                </span>
              </button>
            </Tooltip>
          </li>
        ))}
        {shownIncidents.map((item) => (
          <li key={item.id}>
            <Tooltip content={item.title}>
              <button
                type="button"
                className={`attention-row ${item.kind === "incident" ? "escalated-incident" : "rule-proposal"}`}
                onClick={() => onOpenIncident?.(item)}
              >
                <span className="attention-kind">
                  {item.kind === "incident" ? t("故障单") : t("规则提议")}
                </span>
                <span className="attention-row-text">{item.title}</span>
              </button>
            </Tooltip>
          </li>
        ))}
      </ul>
      {total > shown.length + shownIncidents.length && (
        <p className="attention-more">
          {t("还有 {0} 条", { 0: total - shown.length - shownIncidents.length })}
        </p>
      )}
    </section>
  );
}
