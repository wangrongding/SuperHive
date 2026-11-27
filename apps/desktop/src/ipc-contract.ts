/** 主进程与 preload 共用的 IPC 通道名和数据形状（preload 只引类型和常量，打包时内联） */
export const IPC = {
  terminalCreate: "superhive:terminal:create",
  terminalWrite: "superhive:terminal:write",
  terminalResize: "superhive:terminal:resize",
  terminalKill: "superhive:terminal:kill",
  /** 页面刷新后列出这个页面名下还在跑的终端 */
  terminalList: "superhive:terminal:list",
  /** 接回一个终端，拿到最近的输出用来回放 */
  terminalAttach: "superhive:terminal:attach",
  terminalData: "superhive:terminal:data",
  terminalExit: "superhive:terminal:exit",
  /** 主进程菜单「新建终端」通知页面 */
  terminalNewRequest: "superhive:terminal:new-request",
  /** 主进程菜单「最大化终端」「切换终端位置」通知页面 */
  terminalLayoutRequest: "superhive:terminal:layout-request",
  /** 网页把顶栏高度和主题颜色同步给主进程（overlay 配色、红黄绿按钮位置） */
  titlebarAppearance: "superhive:titlebar:appearance",
  /** 主进程通知页面进出全屏 */
  windowFullscreen: "superhive:window:fullscreen",
  /** preload 同步问主进程：这个页面能不能拿到桌面端能力（答本机 Hive 的地址，或 null） */
  originQuery: "superhive:origin:query",
  /** 网页首屏画好了：主进程收起启动加载画面 */
  appReady: "superhive:app:ready",
  /** 输入框「添加附件」：系统选文件窗口，起始目录是房间工作区 */
  pickFiles: "superhive:files:pick",
  /** 有没有新版（主进程缓存的检查结果，没有就是 null） */
  updateGet: "superhive:update:get",
  /** 打开新版的下载地址或发布页：网页只说打开哪个，地址由主进程自己取 */
  updateOpen: "superhive:update:open",
  /** 「忽略这个版本」 */
  updateDismiss: "superhive:update:dismiss",
  /** 「下载并更新」：网页只给版本号，要下载什么由主进程从检查结果里挑 */
  updateInstall: "superhive:update:install",
  /** 「重启以更新」：先看有没有本机 Agent 在执行任务，有就等人选等它们做完还是立即重启 */
  updateRestart: "superhive:update:restart",
  /** 取消「等任务做完再重启」 */
  updateCancelRestart: "superhive:update:cancel-restart",
  /** 网页「检查更新」：马上查一次，结果交给网页自己显示（不弹系统对话框） */
  updateCheckNow: "superhive:update:check-now",
  /** 主进程查到新版、安装进度变了（或提示该收起）时通知页面 */
  updateChanged: "superhive:update:changed",
  /** 打开过的别人的服务器 */
  remoteList: "superhive:remote:list",
  /** 打开（或切到）别人的服务器：网页只给地址，主进程自己校验 */
  remoteOpen: "superhive:remote:open",
  /** 忘掉一个服务器（关窗口、清掉访客凭证） */
  remoteRemove: "superhive:remote:remove",
  /** 服务器列表或窗口开关变了 */
  remoteChanged: "superhive:remote:changed",
  /** 菜单或 superhive:// 链接让页面弹出「加入别人的房间」/「带 Agent 加入」 */
  joinRequest: "superhive:join:request",
} as const;

export type RemoteServerView = {
  origin: string;
  host: string;
  url: string;
  lastOpenedAt: string;
  /** 窗口现在开着 */
  open: boolean;
};

export type JoinRequest =
  { kind: "room" } | { kind: "agent"; server: string; roomId: string; name: string; token: string };

/**
 * 网页「检查更新」的结果：available=有新版（详情照常从 updateChanged 推过去）；latest=已是最新；
 * failed=没查成（断网、GitHub 限流）；disabled=这个版本不检查更新（开发版）
 */
export type UpdateCheckNowResult = {
  status: "available" | "latest" | "failed" | "disabled";
  currentVersion: string;
};

/** 交给网页的等待状态：waiting=等这些 Agent 做完就重启；timeout=等到上限还没做完，等人再决定 */
export type RestartWait =
  { phase: "waiting"; agents: string[] } | { phase: "timeout"; agents: string[] };

/**
 * 网页「重启以更新」带的选择：check=先看有没有 Agent 在忙（没有就直接重启）；
 * wait=等它们做完再重启（超时后再选一次就是再等一轮）；now=立即重启，中断正在执行的任务
 */
export type RestartChoice = "check" | "wait" | "now";
export const RESTART_CHOICES: readonly RestartChoice[] = ["check", "wait", "now"];

export type RestartResult =
  | { status: "restarting" }
  /** 有 Agent 在忙，没有重启：等人选 wait 或 now */
  | { status: "busy"; agents: string[] }
  | { status: "waiting"; agents: string[] }
  /** 新版本还没准备好（或已经作废），没有可重启的 */
  | { status: "unavailable" };

/** 网页点新版提示里的哪个按钮 */
export type UpdateOpenTarget = "download" | "release";
export const UPDATE_OPEN_TARGETS: readonly UpdateOpenTarget[] = ["download", "release"];

export type TerminalCreateRequest = {
  /** 房间工作区目录；没有或不存在时用用户主目录。允许 ~ 开头 */
  cwd?: string | null;
  cols?: number;
  rows?: number;
};

export type TerminalCreateResult = {
  id: string;
  shell: string;
  cwd: string;
};

export type TerminalExitEvent = { id: string; exitCode: number; signal?: number };

export type TerminalSessionInfo = { id: string; shell: string; cwd: string };

export type TerminalAttachResult = TerminalSessionInfo & {
  /** 最近的输出（最多 REPLAY_BUFFER_CHARS 个字符），接回时先写进终端 */
  replay: string;
};

/** 菜单发给页面的布局操作 */
export type TerminalLayoutAction = "maximize" | "position";
export const TERMINAL_LAYOUT_ACTIONS: readonly TerminalLayoutAction[] = ["maximize", "position"];
