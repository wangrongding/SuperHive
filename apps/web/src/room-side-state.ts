import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import type { Attachment, ChatMessage } from "@superhive/protocol";
import type { SidePanelTab } from "./app-storage";

/**
 * 右侧栏按房间记住的东西：当前标签页、停靠的文件预览。
 * 只记标识（附件元数据、来源消息），不保活 iframe；切回房间时重新加载预览。
 * 刷新后也恢复：写进 localStorage，只留最近用过的 MAX_ROOMS 个房间。
 */
export type DockedPreview = {
  roomId: string;
  attachment: Attachment;
  senderId: string;
  seq: number;
  /** 临时放大回弹窗 */
  popped?: boolean;
  /** 切回房间或刷新后恢复出来的：附件读不到（撤回、过期）时静默收起，不报错 */
  restored?: boolean;
};

export type RoomSideState = {
  tab?: SidePanelTab;
  preview?: DockedPreview;
  /** 最近一次改动的时间，超过上限时先丢最久没动的 */
  at: number;
};

export type RoomSideStates = Record<string, RoomSideState>;

export const MAX_ROOMS = 20;
const TABS: readonly SidePanelTab[] = ["members", "whiteboard", "plugins"];

export function roomSideStorageKey(username: string): string {
  return `superhive.room-side.${username.toLocaleLowerCase()}`;
}

function validAttachment(value: unknown): value is Attachment {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    typeof item.name === "string" &&
    typeof item.mime === "string" &&
    typeof item.size === "number" &&
    typeof item.kind === "string" &&
    typeof item.sha256 === "string"
  );
}

/** 读本机记下的：格式不对的条目直接丢掉，读不到就当没有 */
export function loadRoomSideStates(key: string): RoomSideStates {
  let raw: unknown;
  try {
    raw = JSON.parse(localStorage.getItem(key) ?? "{}");
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const states: RoomSideStates = {};
  for (const [roomId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    const state: RoomSideState = { at: typeof entry.at === "number" ? entry.at : 0 };
    if (TABS.includes(entry.tab as SidePanelTab)) state.tab = entry.tab as SidePanelTab;
    const preview = entry.preview as Record<string, unknown> | undefined;
    if (
      preview &&
      validAttachment(preview.attachment) &&
      typeof preview.senderId === "string" &&
      typeof preview.seq === "number"
    ) {
      state.preview = {
        roomId,
        attachment: preview.attachment,
        senderId: preview.senderId,
        seq: preview.seq,
        restored: true,
      };
    }
    if (state.tab || state.preview) states[roomId] = state;
  }
  return pruneRoomSideStates(states);
}

/** 只留最近用过的 MAX_ROOMS 个房间 */
export function pruneRoomSideStates(states: RoomSideStates): RoomSideStates {
  const entries = Object.entries(states);
  if (entries.length <= MAX_ROOMS) return states;
  return Object.fromEntries(entries.sort(([, a], [, b]) => b.at - a.at).slice(0, MAX_ROOMS));
}

export function saveRoomSideStates(key: string, states: RoomSideStates) {
  const stored: Record<string, unknown> = {};
  for (const [roomId, state] of Object.entries(states)) {
    if (!state.tab && !state.preview) continue;
    stored[roomId] = {
      at: state.at,
      ...(state.tab ? { tab: state.tab } : {}),
      // 放大的弹窗不记：切回来只停靠在右侧栏，不突然盖住页面
      ...(state.preview
        ? {
            preview: {
              attachment: state.preview.attachment,
              senderId: state.preview.senderId,
              seq: state.preview.seq,
            },
          }
        : {}),
    };
  }
  try {
    localStorage.setItem(key, JSON.stringify(stored));
  } catch {
    // 存满或被禁用：只在内存里记
  }
}

/** 改一个房间的记录：值没变就原样返回，免得多渲染一次 */
export function updateRoomSide(
  states: RoomSideStates,
  roomId: string,
  patch: Partial<Pick<RoomSideState, "tab" | "preview">>,
  now = Date.now(),
): RoomSideStates {
  const current = states[roomId];
  const next: RoomSideState = { ...current, ...patch, at: now };
  if ("preview" in patch && !patch.preview) delete next.preview;
  if (current && current.tab === next.tab && current.preview === next.preview) return states;
  if (!next.tab && !next.preview) {
    if (!current) return states;
    const rest = { ...states };
    delete rest[roomId];
    return rest;
  }
  return pruneRoomSideStates({ ...states, [roomId]: next });
}

/**
 * 记下的预览还在不在：来源消息已经加载、却被撤回或不再带这个附件，就当它没了。
 * 消息不在已加载范围里时没法判断，先当它在，读附件失败时再收起（见 restored）
 */
export function previewGone(preview: DockedPreview, messages: readonly ChatMessage[]): boolean {
  const source = messages.find(
    (message) => message.roomId === preview.roomId && message.seq === preview.seq,
  );
  if (!source) return false;
  if (source.deletedAt) return true;
  return !source.attachments?.some((item) => item.id === preview.attachment.id);
}

/**
 * 当前房间的右侧栏状态：读写都落在当前房间那一条上，别的房间各记各的。
 * 换用户名时换一份记录（同一个浏览器里登过不同的人）
 */
export function useRoomSide(username: string, currentRoomId: string) {
  const key = roomSideStorageKey(username);
  const [store, setStore] = useState(() => ({ key, states: loadRoomSideStates(key) }));
  const states = store.key === key ? store.states : loadRoomSideStates(key);
  if (store.key !== key) setStore({ key, states });
  const roomIdRef = useRef(currentRoomId);
  roomIdRef.current = currentRoomId;
  const loaded = useRef(store);
  useEffect(() => {
    // 刚读出来的不用回写
    if (loaded.current === store) return;
    saveRoomSideStates(store.key, store.states);
  }, [store]);

  const current = states[currentRoomId];
  const setTab = useCallback((action: SetStateAction<SidePanelTab>) => {
    setStore((value) => {
      const roomId = roomIdRef.current;
      const previous = value.states[roomId]?.tab ?? "members";
      const tab = typeof action === "function" ? action(previous) : action;
      const next = updateRoomSide(value.states, roomId, { tab });
      return next === value.states ? value : { ...value, states: next };
    });
  }, []);
  const setPreview = useCallback((action: SetStateAction<DockedPreview | undefined>) => {
    setStore((value) => {
      const roomId = roomIdRef.current;
      const previous = value.states[roomId]?.preview;
      const preview = typeof action === "function" ? action(previous) : action;
      const next = updateRoomSide(value.states, preview?.roomId ?? roomId, { preview });
      return next === value.states ? value : { ...value, states: next };
    });
  }, []);
  return { tab: current?.tab ?? "members", preview: current?.preview, setTab, setPreview };
}
