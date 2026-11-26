import { localized, t } from "./i18n";

export const storedUsernameKey = "superhive.username";
export const storedRoomKey = "superhive.room";
export const storedSendShortcutKey = "superhive.send-shortcut";
export const storedAutoSaveDraftKey = "superhive.auto-save-draft";
export const storedRichComposerKey = "superhive.rich-composer";
export const storedTimeFormatKey = "superhive.time-format";
export const storedMessageNotificationsKey = "superhive.notify-messages";
export const storedNotificationPromptDismissedKey = "superhive.notify-prompt-dismissed";
export const storedNotificationSoundKey = "superhive.notification-sound";
export const storedPresenceNotificationsKey = "superhive.notify-agent-presence";
export const storedThemeKey = "superhive.theme";
export const storedDensityKey = "superhive.density";
export const storedThreadWidthKey = "superhive.thread-width";
export const storedMessageSizeKey = "superhive.message-size";
export const storedMembersCollapsedKey = "superhive.members-collapsed";
export const storedRoomsCollapsedKey = "superhive.rooms-collapsed";
export const storedReduceMotionKey = "superhive.reduce-motion";
export const storedAttentionDeliveryKey = "superhive.attention-delivery";
export const storedAttentionSoundKey = "superhive.attention-sound";
export const storedAttentionGroupKey = "superhive.attention-group";
/** 窗口底部的状态栏：默认显示，可在「外观」或状态栏自己的菜单里关掉 */
export const storedStatusBarKey = "superhive.status-bar";
export type MessageNotificationMode = "off" | "mentions" | "all";
export type SendShortcut = "modifier-enter" | "enter";
export type SettingsTab =
  "chat" | "notifications" | "appearance" | "computer" | "runtimes" | "plugins";
export type TimeFormat = "system" | "24h" | "12h";
export type ThemePreference = "system" | "dark" | "light";
export type InterfaceDensity = "comfortable" | "compact";

/** 消息区宽度：标准约 768px、宽约 1040px（默认）、铺满随窗口（上限约 1600px） */
export type ThreadWidth = "standard" | "wide" | "full";

export type MessageSize = "small" | "standard" | "large";
export type MobilePanel = "members" | "rooms";
/** plugins 只在当前房间有可用插件面板时出现 */
export type SidePanelTab = "members" | "whiteboard" | "plugins" | "todos";
export const sidePanelTabs: SidePanelTab[] = ["members", "whiteboard", "todos"];
export const messageNotificationModes = ["off", "mentions", "all"] as const;

export const messageNotificationOptions: Array<{
  id: MessageNotificationMode;
  label: string;
  description: string;
}> = localized(() => [
  { id: "off", label: t("关闭通知"), description: t("不弹系统通知，提示音不受影响") },
  { id: "mentions", label: t("@ 我时通知"), description: t("只有消息里提到我才提醒") },
  { id: "all", label: t("当前房间任意消息"), description: t("所在房间的每条新消息都提醒") },
]);

export const settingsTabs: Array<{ id: SettingsTab; label: string; description: string }> =
  localized(() => [
    { id: "chat", label: t("聊天与输入"), description: t("发送、草稿与时间") },
    { id: "notifications", label: t("通知"), description: t("提及、声音与状态") },
    { id: "appearance", label: t("外观"), description: t("语言、主题、密度与字号") },
    {
      id: "computer",
      label: t("这台电脑"),
      description: t("本机 Agent、网络代理、熄屏后保持在线"),
    },
    { id: "runtimes", label: t("Agent 运行时"), description: t("CLI 升级与配置") },
    { id: "plugins", label: t("插件"), description: t("面板、/ 命令与 MCP 工具") },
  ]);

export function storedSendShortcut(): SendShortcut {
  return localStorage.getItem(storedSendShortcutKey) === "enter" ? "enter" : "modifier-enter";
}

export function storedBoolean(key: string, fallback: boolean): boolean {
  const value = localStorage.getItem(key);
  return value === null ? fallback : value === "true";
}

export function storedChoice<T extends string>(key: string, choices: readonly T[], fallback: T): T {
  const value = localStorage.getItem(key);
  return choices.includes(value as T) ? (value as T) : fallback;
}

export function storedMessageNotificationMode(): MessageNotificationMode {
  return storedChoice(storedMessageNotificationsKey, messageNotificationModes, "mentions");
}

export function draftStorageKey(username: string, roomId: string): string {
  return `superhive.draft.${username.toLocaleLowerCase()}.${roomId}`;
}

export function readSeqStorageKey(roomId: string): string {
  return `superhive.read-seq.${roomId}`;
}
