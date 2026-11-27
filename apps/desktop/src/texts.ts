/** 桌面端原生界面（菜单、对话框、启动页）的中英文案；网页里的文案在 apps/web 的 i18n 里 */
const texts = {
  splashStarting: { zh: "正在启动本机 Hive…", en: "Starting the local Hive…" },
  splashConnecting: { zh: "正在连接本机 Hive…", en: "Connecting to the local Hive…" },
  splashLoading: { zh: "正在打开界面…", en: "Opening SuperHive…" },
  splashSlow: {
    zh: "比平时慢一些，第一次启动要准备数据，请稍等",
    en: "Taking longer than usual — the first launch sets up your data",
  },
  splashLog: { zh: "日志：{log}", en: "Log: {log}" },
  serverStopped: {
    zh: "本机 Hive 已停止运行（退出码 {code}）。",
    en: "The local Hive stopped running (exit code {code}).",
  },
  pageFailed: {
    zh: "界面没能加载：{reason}",
    en: "Couldn't load the app: {reason}",
  },
  startFailedTitle: { zh: "SuperHive 没能启动", en: "SuperHive couldn't start" },
  retry: { zh: "重试", en: "Retry" },
  quit: { zh: "退出", en: "Quit" },
  openLogs: { zh: "打开日志目录", en: "Open Log Folder" },
  docs: { zh: "使用文档", en: "Documentation" },
  issues: { zh: "反馈问题", en: "Report an Issue" },
  openInBrowser: { zh: "在浏览器中打开", en: "Open in Browser" },
  copyImage: { zh: "复制图片", en: "Copy Image" },
  saveImageAs: { zh: "图片另存为…", en: "Save Image As…" },
  file: { zh: "文件", en: "File" },
  edit: { zh: "编辑", en: "Edit" },
  view: { zh: "视图", en: "View" },
  window: { zh: "窗口", en: "Window" },
  help: { zh: "帮助", en: "Help" },
  pickAttachments: { zh: "添加附件", en: "Add Attachments" },
  newTerminal: { zh: "新建终端", en: "New Terminal" },
  joinRemote: { zh: "加入别人的房间…", en: "Join Someone Else's Room…" },
  remoteServers: { zh: "别人的服务器", en: "Other Servers" },
  joinConfirmTitle: { zh: "加入别人的房间？", en: "Join someone else's room?" },
  joinConfirmMessage: {
    zh: "要打开 {host} 上的 {room} 吗？",
    en: "Open {room} on {host}?",
  },
  joinConfirmAnyRoom: { zh: "房间", en: "the room" },
  joinConfirmDetail: {
    zh: "服务器：{origin}\n身份：{identity}\n\n会在单独的窗口里打开，对方拿不到这台电脑的终端和文件。只加入你认识的人发来的邀请。",
    en: "Server: {origin}\nAs: {identity}\n\nIt opens in a separate window with no access to this computer's terminals or files. Only join invites from people you know.",
  },
  joinConfirmGuest: {
    zh: "访客（用邀请加入，进去后填你的名字；对方房主可以随时把你移出）",
    en: "Guest (joining with an invite; you'll enter your name next, and the owner can remove you any time)",
  },
  joinConfirmReturning: {
    zh: "之前在这台服务器上用过的身份；没有的话需要邀请",
    en: "Whatever identity you used on this server before; otherwise you'll need an invite",
  },
  joinConfirm: { zh: "加入", en: "Join" },
  cancel: { zh: "取消", en: "Cancel" },
  remoteFailed: {
    zh: "连不上 {host}：对方的 Hive 可能没开，或者不在同一个网络。",
    en: "Couldn't reach {host}. Their Hive may be off or on a different network.",
  },
  toggleTerminalMaximized: { zh: "最大化 / 还原终端", en: "Maximize / Restore Terminal" },
  toggleTerminalPosition: {
    zh: "终端移到右侧 / 底部",
    en: "Move Terminal Right / Bottom",
  },
  checkForUpdates: { zh: "检查新版本…", en: "Check for Updates…" },
  updateAvailableTitle: {
    zh: "有新版本 {version}",
    en: "SuperHive {version} is available",
  },
  updateAvailableDetail: {
    zh: "你现在用的是 {current}。下载安装包后，Mac 上把新的 SuperHive 拖进「应用程序」替换旧的；Windows 上直接运行安装包覆盖安装（会先关掉正在运行的 SuperHive），房间、消息和设置都会保留。",
    en: "You're on {current}. On macOS, drag the new SuperHive into Applications to replace the old one; on Windows, run the installer over the current install (it closes SuperHive first). Your rooms, messages and settings are kept.",
  },
  updateAvailableInstallDetail: {
    zh: "你现在用的是 {current}。可以在后台下载并更新，下载好后点「重启以更新」，也可以等下次退出时自动换上新版本。房间、消息和设置都会保留。",
    en: "You're on {current}. SuperHive can download the update in the background. When it's ready, restart to update, or it's applied the next time you quit. Your rooms, messages and settings are kept.",
  },
  updateInstall: { zh: "下载并更新", en: "Download and Update" },
  updateReadyTitle: { zh: "新版本 {version} 已下载好", en: "SuperHive {version} is ready" },
  updateReadyDetail: {
    zh: "重启后就是新版本；现在不重启的话，下次退出时自动更新。",
    en: "Restart to use the new version. If you don't restart now, it's applied the next time you quit.",
  },
  updateRestart: { zh: "重启以更新", en: "Restart to Update" },
  updateBusyTitle: { zh: "有 Agent 正在执行任务", en: "Agents are running tasks" },
  updateBusyDetail: {
    zh: "{agents} 正在执行任务，现在重启会中断它们。可以等它们做完再自动重启，最多等 30 分钟。",
    en: "{agents} are running tasks. Restarting now interrupts them. SuperHive can restart once they finish, waiting up to 30 minutes.",
  },
  updateWaitRestart: {
    zh: "等任务做完再重启（推荐）",
    en: "Wait for Tasks to Finish (Recommended)",
  },
  updateRestartNow: {
    zh: "立即重启，中断正在执行的任务",
    en: "Restart Now and Interrupt Tasks",
  },
  updateWaitingTitle: { zh: "正在等 Agent 做完再重启", en: "Waiting for agents to finish" },
  updateWaitingDetail: {
    zh: "{agents} 还在执行任务，做完后自动重启。",
    en: "{agents} are still running tasks. SuperHive restarts when they finish.",
  },
  updateKeepWaiting: { zh: "继续等", en: "Keep Waiting" },
  updateStopWaiting: { zh: "取消等待", en: "Stop Waiting" },
  updateTimeoutTitle: {
    zh: "等了 30 分钟，任务还没做完",
    en: "Tasks are still running after 30 minutes",
  },
  updateTimeoutDetail: {
    zh: "{agents} 还在执行任务。可以再等 30 分钟，或者现在重启（会中断它们）。不重启的话，下次退出时换上新版本。",
    en: "{agents} are still running tasks. Wait another 30 minutes, or restart now and interrupt them. If you don't restart, the update is applied the next time you quit.",
  },
  updateWaitMore: { zh: "再等 30 分钟", en: "Wait 30 More Minutes" },
  localAgents: { zh: "本机 Agent", en: "Local agents" },
  updateDownload: { zh: "下载", en: "Download" },
  updateLater: { zh: "以后再说", en: "Later" },
  updateNone: { zh: "已经是最新版本", en: "You're up to date" },
  updateNoneDetail: {
    zh: "SuperHive {current} 是目前最新的正式版。",
    en: "SuperHive {current} is the latest release.",
  },
  updateFailed: { zh: "没能检查新版本", en: "Couldn't check for updates" },
  updateFailedDetail: {
    zh: "连不上 GitHub，稍后再试，或者到发布页查看。",
    en: "Couldn't reach GitHub. Try again later, or check the releases page.",
  },
  updateOpenReleases: { zh: "打开发布页", en: "Open Releases" },
  ok: { zh: "好", en: "OK" },
  connectedExisting: {
    zh: "已连上本机正在运行的 Hive（{origin}）。退出桌面端不会停止它。",
    en: "Connected to the Hive already running on this computer ({origin}). Quitting the app won't stop it.",
  },
} satisfies Record<string, { zh: string; en: string }>;

export type TextKey = keyof typeof texts;
export type Lang = "zh" | "en";

export function langFor(locale: string): Lang {
  return locale.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function text(lang: Lang, key: TextKey, params: Record<string, string> = {}): string {
  return texts[key][lang].replace(/\{(\w+)\}/g, (match, name: string) => params[name] ?? match);
}
