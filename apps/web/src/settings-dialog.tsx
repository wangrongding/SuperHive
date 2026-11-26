import { t, LOCALE_OPTIONS, setLocalePreference, type LocalePreference } from "./i18n";
import { Icon } from "./app-icons";
import {
  storedSendShortcutKey,
  storedAutoSaveDraftKey,
  draftStorageKey,
  storedRichComposerKey,
  storedTimeFormatKey,
  messageNotificationOptions,
  storedAttentionSoundKey,
  storedAttentionGroupKey,
  storedNotificationSoundKey,
  storedThemeKey,
  storedDensityKey,
  storedThreadWidthKey,
  storedMessageSizeKey,
  storedReduceMotionKey,
  type SettingsTab,
  type SendShortcut,
  type TimeFormat,
  type MessageNotificationMode,
  type ThemePreference,
  type InterfaceDensity,
  type ThreadWidth,
  type MessageSize,
} from "./app-storage";
import { KeyCombo } from "./key-combo";
import { Button, IconButton } from "./button";
import { SettingsSwitch } from "./settings-switch";
import {
  attentionDeliveryOptions,
  playAttentionTone,
  type AttentionDelivery,
} from "./attention-alerts";
import { playNotificationTone, type BrowserNotificationPermission } from "./browser-notify";
import { HostManageNotice, KeepAwakeSettingsGroup } from "./host-settings";
import { LocalAgentUpdatesGroup } from "./local-agent-updates";
import { NetworkProxySettingsGroup } from "./network-proxy-settings";
import { RemoteJoinsGroup } from "./remote-joins-settings";
import { PluginsSettingsPanel } from "./plugins";
import { AgentRuntimesPanel } from "./agent-runtimes-panel";
import type { RefObject, Dispatch, SetStateAction } from "react";
import type { LocalAgentsState } from "./local-agents";
import type { SelectableAgentProvider } from "./agent-name";

/** 偏好设置弹窗：聊天与输入、通知、外观、这台电脑、Agent 运行时 */
export function SettingsDialog({
  attentionDelivery,
  attentionGroup,
  attentionSound,
  autoSaveDraft,
  closeSettings,
  currentRoomId,
  draft,
  ensureNotificationPermission,
  interfaceDensity,
  local,
  localePreference,
  messageNotifications,
  messageSize,
  notificationPermission,
  notificationSound,
  presenceNotifications,
  reduceMotion,
  richComposer,
  runtimesFocus,
  sendShortcut,
  setAttentionGroup,
  setAttentionSound,
  setAutoSaveDraft,
  setComposerPreview,
  setInterfaceDensity,
  setMessageSize,
  setNotificationSound,
  setReduceMotion,
  setRichComposer,
  setSendShortcut,
  setSettingsTab,
  setThemePreference,
  setThreadWidth,
  setTimeFormat,
  setStatusBarVisible,
  statusBarVisible,
  settingsCloseRef,
  settingsDialogRef,
  settingsTab,
  themePreference,
  threadWidth,
  timeFormat,
  updateAttentionDelivery,
  updateMessageNotifications,
  updatePresenceNotifications,
  username,
  visibleSettingsTabs,
}: {
  attentionDelivery: AttentionDelivery;
  attentionGroup: boolean;
  attentionSound: boolean;
  autoSaveDraft: boolean;
  closeSettings: () => void;
  currentRoomId: string;
  draft: string;
  ensureNotificationPermission: () => Promise<boolean>;
  interfaceDensity: InterfaceDensity;
  local: LocalAgentsState;
  localePreference: LocalePreference;
  messageNotifications: MessageNotificationMode;
  messageSize: MessageSize;
  notificationPermission: BrowserNotificationPermission;
  notificationSound: boolean;
  presenceNotifications: boolean;
  reduceMotion: boolean;
  richComposer: boolean;
  runtimesFocus: SelectableAgentProvider | undefined;
  sendShortcut: SendShortcut;
  setAttentionGroup: Dispatch<SetStateAction<boolean>>;
  setAttentionSound: Dispatch<SetStateAction<boolean>>;
  setAutoSaveDraft: Dispatch<SetStateAction<boolean>>;
  setComposerPreview: Dispatch<SetStateAction<boolean>>;
  setInterfaceDensity: Dispatch<SetStateAction<InterfaceDensity>>;
  setMessageSize: Dispatch<SetStateAction<MessageSize>>;
  setNotificationSound: Dispatch<SetStateAction<boolean>>;
  setReduceMotion: Dispatch<SetStateAction<boolean>>;
  setRichComposer: Dispatch<SetStateAction<boolean>>;
  setSendShortcut: Dispatch<SetStateAction<SendShortcut>>;
  setSettingsTab: Dispatch<SetStateAction<SettingsTab>>;
  setThemePreference: Dispatch<SetStateAction<ThemePreference>>;
  setThreadWidth: Dispatch<SetStateAction<ThreadWidth>>;
  setTimeFormat: Dispatch<SetStateAction<TimeFormat>>;
  setStatusBarVisible: (visible: boolean) => void;
  statusBarVisible: boolean;
  settingsCloseRef: RefObject<HTMLButtonElement | null>;
  settingsDialogRef: RefObject<HTMLDivElement | null>;
  settingsTab: SettingsTab;
  themePreference: ThemePreference;
  threadWidth: ThreadWidth;
  timeFormat: TimeFormat;
  updateAttentionDelivery: (next: AttentionDelivery) => Promise<void>;
  updateMessageNotifications: (mode: MessageNotificationMode) => Promise<void>;
  updatePresenceNotifications: (next: boolean) => Promise<void>;
  username: string;
  visibleSettingsTabs: { id: SettingsTab; label: string; description: string }[];
}) {
  return (
    <div className="settings-dialog-layer">
      <button
        className="settings-dialog-scrim"
        type="button"
        aria-label={t("关闭设置")}
        onClick={closeSettings}
      />
      <div
        ref={settingsDialogRef}
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
      >
        <header className="settings-dialog-header">
          <div>
            <h2 id="settings-dialog-title">{t("偏好设置")}</h2>
          </div>
          <IconButton
            ref={settingsCloseRef}
            className="dialog-close"
            label={t("关闭设置")}
            onClick={closeSettings}
          >
            <Icon name="close" />
          </IconButton>
        </header>
        <div className="settings-dialog-layout">
          <nav className="settings-tabs" aria-label={t("设置分类")} role="tablist">
            {visibleSettingsTabs.map((tab, index) => (
              <button
                type="button"
                role="tab"
                aria-selected={settingsTab === tab.id}
                aria-controls={`settings-panel-${tab.id}`}
                tabIndex={settingsTab === tab.id ? 0 : -1}
                className={settingsTab === tab.id ? "active" : ""}
                onClick={() => setSettingsTab(tab.id)}
                onKeyDown={(event) => {
                  if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(event.key)) {
                    return;
                  }
                  event.preventDefault();
                  const direction =
                    event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1;
                  const nextIndex =
                    (index + direction + visibleSettingsTabs.length) % visibleSettingsTabs.length;
                  setSettingsTab(visibleSettingsTabs[nextIndex]!.id);
                  window.requestAnimationFrame(() => {
                    const tabs =
                      settingsDialogRef.current?.querySelectorAll<HTMLButtonElement>(
                        '[role="tab"]',
                      );
                    tabs?.[nextIndex]?.focus();
                  });
                }}
                key={tab.id}
              >
                <strong>
                  {tab.id === "computer" && local.mode === "device"
                    ? t("Server 所在电脑")
                    : tab.label}
                </strong>
                <small>{tab.description}</small>
              </button>
            ))}
          </nav>

          <div className="settings-dialog-content">
            {settingsTab === "chat" && (
              <section id="settings-panel-chat" role="tabpanel" aria-label={t("聊天与输入")}>
                <div className="settings-panel-heading">
                  <h3>{t("聊天与输入")}</h3>
                  <p>{t("控制消息如何编辑、发送和显示。")}</p>
                </div>

                <div className="settings-group" id="settings-send-shortcut">
                  <div className="settings-section-heading">
                    <div>
                      <h4>{t("发送消息")}</h4>
                      <p>{t("选择在输入框中发送消息的快捷键。")}</p>
                    </div>
                  </div>
                  <div className="shortcut-selector" role="radiogroup" aria-label={t("发送快捷键")}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={sendShortcut === "modifier-enter"}
                      className={sendShortcut === "modifier-enter" ? "active" : ""}
                      onClick={() => {
                        setSendShortcut("modifier-enter");
                        localStorage.setItem(storedSendShortcutKey, "modifier-enter");
                      }}
                    >
                      <span>
                        <strong>{t("组合键发送")}</strong>
                        <small>{t("推荐，Enter 可以安心换行")}</small>
                      </span>
                      <KeyCombo keys={["Mod", "Enter"]} />
                      <i aria-hidden="true">
                        <Icon name="check" size={14} />
                      </i>
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={sendShortcut === "enter"}
                      className={sendShortcut === "enter" ? "active" : ""}
                      onClick={() => {
                        setSendShortcut("enter");
                        localStorage.setItem(storedSendShortcutKey, "enter");
                      }}
                    >
                      <span>
                        <strong>{t("Enter 发送")}</strong>
                        <small>
                          {t("{0} 换行")
                            .split(/(\{0\})/)
                            .map((part, index) =>
                              part === "{0}" ? (
                                <KeyCombo key={index} keys={["Shift", "Enter"]} />
                              ) : (
                                part
                              ),
                            )}
                        </small>
                      </span>
                      <KeyCombo keys={["Enter"]} />
                      <i aria-hidden="true">
                        <Icon name="check" size={14} />
                      </i>
                    </button>
                  </div>
                </div>

                <div className="settings-group divided">
                  <SettingsSwitch
                    checked={autoSaveDraft}
                    label={t("自动保存草稿")}
                    description={t("刷新或重新打开页面后恢复未发送内容")}
                    onChange={(checked) => {
                      setAutoSaveDraft(checked);
                      localStorage.setItem(storedAutoSaveDraftKey, String(checked));
                      if (!checked && username) {
                        localStorage.removeItem(draftStorageKey(username, currentRoomId));
                      } else if (checked && username && draft) {
                        localStorage.setItem(draftStorageKey(username, currentRoomId), draft);
                      }
                    }}
                  />
                  <SettingsSwitch
                    checked={richComposer}
                    label={t("输入框直接显示格式")}
                    description={t(
                      "像飞书一样边写边显示标题、列表、加粗、代码；关掉则是纯文本 Markdown，可手动预览",
                    )}
                    onChange={(checked) => {
                      setRichComposer(checked);
                      setComposerPreview(false);
                      localStorage.setItem(storedRichComposerKey, String(checked));
                    }}
                  />
                  <div className="settings-inline-row">
                    <span>
                      <strong>{t("时间格式")}</strong>
                      <small>{t("消息时间戳的显示方式")}</small>
                    </span>
                    <div className="compact-choice" role="radiogroup" aria-label={t("时间格式")}>
                      {(["system", "24h", "12h"] as const).map((value) => (
                        <button
                          type="button"
                          role="radio"
                          aria-checked={timeFormat === value}
                          className={timeFormat === value ? "active" : ""}
                          onClick={() => {
                            setTimeFormat(value);
                            localStorage.setItem(storedTimeFormatKey, value);
                          }}
                          key={value}
                        >
                          {value === "system"
                            ? t("系统")
                            : value === "24h"
                              ? t("24 小时")
                              : t("12 小时")}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </section>
            )}

            {settingsTab === "notifications" && (
              <section id="settings-panel-notifications" role="tabpanel" aria-label={t("通知")}>
                <div className="settings-panel-heading">
                  <h3>{t("通知")}</h3>
                  <p>{t("只在你需要关注时发出清晰信号。")}</p>
                </div>
                {notificationPermission !== "granted" && notificationPermission !== "default" && (
                  <div className="notification-permission-note" role="status">
                    <Icon name="shield" size={16} />
                    <span>
                      {notificationPermission === "unsupported"
                        ? t("当前浏览器不支持系统通知。")
                        : t("系统通知已被浏览器阻止，请在站点权限中重新允许。")}
                    </span>
                  </div>
                )}
                {notificationPermission === "default" && messageNotifications !== "off" && (
                  <div className="notification-permission-note" role="status">
                    <Icon name="bell" size={16} />
                    <span>{t("浏览器尚未授权通知，当前选项要等授权后才会生效。")}</span>
                    <Button size="sm" onClick={() => void ensureNotificationPermission()}>
                      {t("立即授权")}
                    </Button>
                  </div>
                )}
                <div className="settings-group">
                  <div className="settings-section-heading">
                    <div>
                      <h4>{t("消息通知")}</h4>
                      <p>{t("页面不在前台时，通过系统通知提醒我。")}</p>
                    </div>
                  </div>
                  <div
                    className="shortcut-selector notification-modes"
                    role="radiogroup"
                    aria-label={t("消息通知")}
                  >
                    {messageNotificationOptions.map((option) => (
                      <button
                        type="button"
                        role="radio"
                        aria-checked={messageNotifications === option.id}
                        disabled={notificationPermission === "unsupported" && option.id !== "off"}
                        className={messageNotifications === option.id ? "active" : ""}
                        onClick={() => void updateMessageNotifications(option.id)}
                        key={option.id}
                      >
                        <span>
                          <strong>{option.label}</strong>
                          <small>{option.description}</small>
                        </span>
                        <i aria-hidden="true">
                          <Icon name="check" size={14} />
                        </i>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="settings-group divided">
                  <div className="settings-section-heading">
                    <div>
                      <h4>{t("任务提醒")}</h4>
                      <p>
                        {t(
                          "你发起的任务等你回答、失败、结果未知或做完了，以及等你放行的任务，不管在哪个房间都提醒；正看着那个房间时不打扰。",
                        )}
                      </p>
                    </div>
                  </div>
                  <div
                    className="shortcut-selector notification-modes"
                    role="radiogroup"
                    aria-label={t("任务提醒")}
                  >
                    {attentionDeliveryOptions.map((option) => (
                      <button
                        type="button"
                        role="radio"
                        aria-checked={attentionDelivery === option.id}
                        className={attentionDelivery === option.id ? "active" : ""}
                        onClick={() => void updateAttentionDelivery(option.id)}
                        key={option.id}
                      >
                        <span>
                          <strong>{option.label}</strong>
                          <small>{option.description}</small>
                        </span>
                        <i aria-hidden="true">
                          <Icon name="check" size={14} />
                        </i>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="settings-group divided settings-switch-list">
                  <SettingsSwitch
                    checked={attentionSound}
                    disabled={attentionDelivery === "off"}
                    label={t("任务提醒提示音")}
                    description={t("需要你处理时响两声，做完时响一声")}
                    onChange={(checked) => {
                      setAttentionSound(checked);
                      localStorage.setItem(storedAttentionSoundKey, String(checked));
                      if (checked) playAttentionTone("question");
                    }}
                  />
                  <SettingsSwitch
                    checked={attentionGroup}
                    label={t("侧栏显示「需要你处理」")}
                    description={t(
                      "在房间列表上方列出待处理的任务，点一下直接跳过去；不影响房间顺序",
                    )}
                    onChange={(checked) => {
                      setAttentionGroup(checked);
                      localStorage.setItem(storedAttentionGroupKey, String(checked));
                    }}
                  />
                  <SettingsSwitch
                    checked={notificationSound}
                    label={t("新消息提示音")}
                    description={t("收到其他成员的新消息时播放轻提示音")}
                    onChange={(checked) => {
                      setNotificationSound(checked);
                      localStorage.setItem(storedNotificationSoundKey, String(checked));
                      if (checked) playNotificationTone();
                    }}
                  />
                  <SettingsSwitch
                    checked={presenceNotifications}
                    disabled={notificationPermission === "unsupported"}
                    label={t("Agent 上下线")}
                    description={t("页面不在前台时，提醒 Agent 离线或重新上线")}
                    onChange={(checked) => void updatePresenceNotifications(checked)}
                  />
                </div>
                <p className="settings-local-note">
                  {t("浏览器通知只在页面不处于前台时显示；提示音设置独立生效。")}
                </p>
              </section>
            )}

            {settingsTab === "computer" && (
              <section id="settings-panel-computer" role="tabpanel" aria-label={t("这台电脑")}>
                <div className="settings-panel-heading">
                  <h3>
                    {local.mode === "device"
                      ? t("Server 所在电脑（{0}）", { 0: local.hostLabel ?? "" })
                      : t("这台电脑")}
                  </h3>
                  <p>
                    {local.mode === "device"
                      ? t("运行 Hive Server 的那台电脑的设置，对所有房间生效。")
                      : t("运行 Hive Server 的这台电脑的设置，对所有房间生效。")}
                  </p>
                </div>
                <HostManageNotice local={local} />
                <LocalAgentUpdatesGroup local={local} />
                <RemoteJoinsGroup local={local} />
                <NetworkProxySettingsGroup local={local} />
                <KeepAwakeSettingsGroup local={local} />
              </section>
            )}
            {settingsTab === "runtimes" && local.mode === "local" && (
              <AgentRuntimesPanel local={local} focusTool={runtimesFocus} />
            )}
            {settingsTab === "plugins" && local.mode === "local" && (
              <PluginsSettingsPanel api={local} />
            )}
            {settingsTab === "appearance" && (
              <section id="settings-panel-appearance" role="tabpanel" aria-label={t("外观")}>
                <div className="settings-panel-heading">
                  <h3>{t("外观")}</h3>
                  <p>{t("调整界面气氛与信息密度，不影响其他成员。")}</p>
                </div>

                <div className="settings-group">
                  <div className="settings-section-heading">
                    <div>
                      <h4>{t("界面主题")}</h4>
                      <p>{t("系统主题变化时可以自动跟随。")}</p>
                    </div>
                  </div>
                  <div className="visual-choice-grid" role="radiogroup" aria-label={t("界面主题")}>
                    {(["system", "dark", "light"] as const).map((value) => (
                      <button
                        type="button"
                        role="radio"
                        aria-checked={themePreference === value}
                        className={`${value} ${themePreference === value ? "active" : ""}`}
                        onClick={() => {
                          setThemePreference(value);
                          localStorage.setItem(storedThemeKey, value);
                        }}
                        key={value}
                      >
                        <i aria-hidden="true">
                          <span />
                        </i>
                        <strong>
                          {value === "system"
                            ? t("跟随系统")
                            : value === "dark"
                              ? t("深色")
                              : t("浅色")}
                        </strong>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="settings-group divided settings-switch-list">
                  <div className="settings-inline-row">
                    <span>
                      <strong>{t("界面语言")}</strong>
                      <small>{t("只影响你自己看到的界面，聊天内容不翻译")}</small>
                    </span>
                    <div className="compact-choice" role="radiogroup" aria-label={t("界面语言")}>
                      {LOCALE_OPTIONS.map((option) => (
                        <button
                          type="button"
                          role="radio"
                          aria-checked={localePreference === option.value}
                          className={localePreference === option.value ? "active" : ""}
                          onClick={() => setLocalePreference(option.value)}
                          key={option.value}
                        >
                          {option.value === "system" ? t(option.label) : option.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="settings-inline-row">
                    <span>
                      <strong>{t("界面密度")}</strong>
                      <small>{t("控制成员和消息之间的留白")}</small>
                    </span>
                    <div className="compact-choice" role="radiogroup" aria-label={t("界面密度")}>
                      {(["comfortable", "compact"] as const).map((value) => (
                        <button
                          type="button"
                          role="radio"
                          aria-checked={interfaceDensity === value}
                          className={interfaceDensity === value ? "active" : ""}
                          onClick={() => {
                            setInterfaceDensity(value);
                            localStorage.setItem(storedDensityKey, value);
                          }}
                          key={value}
                        >
                          {value === "comfortable" ? t("舒适") : t("紧凑")}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="settings-inline-row">
                    <span>
                      <strong>{t("消息区宽度")}</strong>
                      <small>{t("宽屏下消息和输入框能用多宽；手机上不受影响")}</small>
                    </span>
                    <div className="compact-choice" role="radiogroup" aria-label={t("消息区宽度")}>
                      {(["standard", "wide", "full"] as const).map((value) => (
                        <button
                          type="button"
                          role="radio"
                          aria-checked={threadWidth === value}
                          className={threadWidth === value ? "active" : ""}
                          onClick={() => {
                            setThreadWidth(value);
                            localStorage.setItem(storedThreadWidthKey, value);
                          }}
                          key={value}
                        >
                          {value === "standard"
                            ? t("标准宽度")
                            : value === "wide"
                              ? t("加宽")
                              : t("铺满")}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="settings-inline-row">
                    <span>
                      <strong>{t("消息字号")}</strong>
                      <small>{t("只调整消息正文和输入文字")}</small>
                    </span>
                    <div className="compact-choice" role="radiogroup" aria-label={t("消息字号")}>
                      {(["small", "standard", "large"] as const).map((value) => (
                        <button
                          type="button"
                          role="radio"
                          aria-checked={messageSize === value}
                          className={messageSize === value ? "active" : ""}
                          onClick={() => {
                            setMessageSize(value);
                            localStorage.setItem(storedMessageSizeKey, value);
                          }}
                          key={value}
                        >
                          {value === "small" ? t("小") : value === "standard" ? t("标准") : t("大")}
                        </button>
                      ))}
                    </div>
                  </div>
                  <SettingsSwitch
                    checked={reduceMotion}
                    label={t("减少动态效果")}
                    description={t("关闭浮层、状态和界面的过渡动画")}
                    onChange={(checked) => {
                      setReduceMotion(checked);
                      localStorage.setItem(storedReduceMotionKey, String(checked));
                    }}
                  />
                  <SettingsSwitch
                    checked={statusBarVisible}
                    label={t("显示底部状态栏")}
                    description={t(
                      "窗口最下面一条：连接、Agent 和常用开关，点开直接改；窄屏上不显示",
                    )}
                    onChange={setStatusBarVisible}
                  />
                </div>
              </section>
            )}

            <p className="settings-local-note settings-persistence-note">
              {t("所有偏好即时生效，并且只保存在当前浏览器中。")}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
