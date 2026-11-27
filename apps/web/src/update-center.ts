/**
 * 右下角的「更新」位置：检查更新的轻提示、下载 / 安装进度卡片共用这一个位置，同一时间只摆一样，
 * 不会叠成两层。状态放在模块里（useSyncExternalStore），侧栏和状态栏两个「有新版本」入口、
 * 状态栏弹层里的「检查更新」按钮和右下角的 UpdateCorner 共用同一份。
 *
 * - 提示（notice）：检查中一直在，有结果后几秒自动消失，也可以点 × 关；有提示时进度卡片先让位。
 * - 进度卡片：确认更新后出现；「—」收起到状态栏，点状态栏里的进度再展开。
 * - 桌面端的更新弹窗只挂一份（UpdateCorner 里），两个入口都只是打开它。
 */
import { useSyncExternalStore } from "react";

export type UpdateNoticeTone = "pending" | "ok" | "info" | "danger";
export type UpdateNotice = { id: number; tone: UpdateNoticeTone; text: string };

export type UpdateCenterState = {
  notice: UpdateNotice | undefined;
  /** 桌面端更新弹窗开着 */
  desktopDialog: boolean;
  /** 进度卡片被「—」收起到状态栏了 */
  cardCollapsed: boolean;
  /** 刚在这个页面里「忽略这个版本」的桌面端版本：等桌面端回话前入口先收起 */
  desktopDismissed: string | undefined;
  /** 网页版（npm）检查更新：NpmUpdateEntry 挂着时才有 */
  npmCheck: (() => Promise<void>) | undefined;
  /** 右下角那个位置的 DOM 节点，网页版的进度卡片 portal 进来 */
  slot: HTMLElement | null;
};

const initial: UpdateCenterState = {
  notice: undefined,
  desktopDialog: false,
  cardCollapsed: false,
  desktopDismissed: undefined,
  npmCheck: undefined,
  slot: null,
};

let state = initial;
let noticeId = 0;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function update(patch: Partial<UpdateCenterState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function updateCenter(): UpdateCenterState {
  return state;
}

export function useUpdateCenter(): UpdateCenterState {
  return useSyncExternalStore(subscribe, updateCenter, updateCenter);
}

/** 结果提示停留多久：出错的多留一会儿，读得完 */
export const NOTICE_MS = { ok: 4_000, info: 6_000, danger: 8_000 } as const;

export function showUpdateNotice(tone: UpdateNoticeTone, text: string): number {
  clearTimeout(noticeTimer);
  const id = (noticeId += 1);
  update({ notice: { id, tone, text } });
  if (tone !== "pending") noticeTimer = setTimeout(() => dismissUpdateNotice(id), NOTICE_MS[tone]);
  return id;
}

/** 关掉提示；给了 id 时只关那一条（自动消失时别把后来的新提示关掉） */
export function dismissUpdateNotice(id?: number) {
  if (!state.notice || (id !== undefined && state.notice.id !== id)) return;
  clearTimeout(noticeTimer);
  update({ notice: undefined });
}

/** 正在检查（提示停在「正在检查更新…」）：再点一次不重复发请求 */
export function updateCheckPending(): boolean {
  return state.notice?.tone === "pending";
}

export function openDesktopUpdateDialog() {
  update({ desktopDialog: true });
}

export function closeDesktopUpdateDialog() {
  if (state.desktopDialog) update({ desktopDialog: false });
}

/** 展开进度卡片（开始更新、点状态栏里的进度、下载完成或失败时） */
export function expandUpdateCard() {
  if (state.cardCollapsed) update({ cardCollapsed: false });
}

export function collapseUpdateCard() {
  if (!state.cardCollapsed) update({ cardCollapsed: true });
}

export function setDesktopDismissed(version: string | undefined) {
  update({ desktopDismissed: version });
}

export function registerNpmUpdateCheck(check: () => Promise<void>): () => void {
  update({ npmCheck: check });
  return () => {
    if (state.npmCheck === check) update({ npmCheck: undefined });
  };
}

export function setUpdateCornerSlot(slot: HTMLElement | null) {
  if (state.slot !== slot) update({ slot });
}

/** 测试之间清空 */
export function resetUpdateCenter() {
  clearTimeout(noticeTimer);
  state = initial;
  for (const listener of listeners) listener();
}
