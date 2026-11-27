/**
 * 桌面端（Electron）经 preload 暴露的能力。只在 SuperHive 桌面端、并且页面是本机 Hive 时才有；
 * 浏览器里打开（包括局域网、远程访问）时 window.superhiveDesktop 不存在，终端入口完全不出现。
 */
export type DesktopTerminalCreateResult = { id: string; shell: string; cwd: string };
export type DesktopTerminalExit = { id: string; exitCode: number; signal?: number };
export type DesktopTerminalSession = { id: string; shell: string; cwd: string };
export type DesktopTerminalAttach = DesktopTerminalSession & { replay: string };
export type DesktopTerminalLayoutAction = "maximize" | "position";

export type DesktopTerminalApi = {
  create(request: {
    cwd?: string | null;
    cols?: number;
    rows?: number;
  }): Promise<DesktopTerminalCreateResult>;
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  kill(id: string): void;
  onData(listener: (id: string, data: string) => void): () => void;
  onExit(listener: (event: DesktopTerminalExit) => void): () => void;
  onNewRequest(listener: () => void): () => void;
  /** 页面刷新后这个窗口里还在跑的终端（老版本桌面端没有，刷新就会结束终端） */
  list?(): Promise<DesktopTerminalSession[]>;
  /** 接回一个终端，拿到最近的输出用来回放；已经没了时是 null */
  attach?(id: string): Promise<DesktopTerminalAttach | null>;
  /** 菜单「最大化 / 还原终端」「终端移到右侧 / 底部」（老版本桌面端没有） */
  onLayoutRequest?(listener: (action: DesktopTerminalLayoutAction) => void): () => void;
};

export type DesktopTitlebarAppearance = {
  height: number;
  color: string;
  symbolColor: string;
  inactiveSymbolColor: string;
  /** 弹窗遮罩盖住右上角时那块的颜色（只在 Windows / Linux 的弹窗打开时有）；老版本桌面端不认，照常用 color */
  scrim?: string;
};

/** 系统标题栏去掉后，网页把顶栏高度和主题颜色同步给窗口（老版本桌面端没有这一项） */
export type DesktopTitlebarApi = {
  mode: "mac" | "overlay" | "native";
  setAppearance(appearance: DesktopTitlebarAppearance): void;
};

/** 系统选文件窗口选中的一个文件；data 不在时表示超出上传上限没读，skipped 说明原因 */
export type DesktopPickedFile = {
  name: string;
  type: string;
  size: number;
  data?: Uint8Array;
  skipped?: "too-large" | "total" | "count";
};

/** 输入框「添加附件」：系统选文件窗口默认打开房间工作区（起始目录由桌面端自己向 Hive 查，网页只给房间 ID） */
export type DesktopFilesApi = {
  pick(request: {
    roomId?: string | null;
    multiple?: boolean;
  }): Promise<{ canceled: boolean; files: DesktopPickedFile[] }>;
};

/** 桌面端查到的新版（只有展示用的信息，没有链接） */
export type DesktopUpdateInfo = {
  version: string;
  currentVersion: string;
  publishedAt?: string;
  /** 发布说明摘要，一条里中英文用「 / 」隔开 */
  notes: string[];
  assetName: string;
  assetSize: number;
  /** 应用内更新的状态（老版本桌面端没有，只能下载安装包） */
  install?: DesktopInstallView;
};

/** 不能直接更新 / 更新失败的原因 */
export type DesktopInstallFailure =
  | "no-package"
  | "not-installed"
  | "translocated"
  | "read-only"
  | "not-writable"
  | "network"
  | "checksum"
  | "bad-package"
  | "unknown";

export type DesktopInstallState =
  | { phase: "idle" }
  /** total 为 0 表示不知道总大小（Windows 不报进度） */
  | { phase: "downloading"; received: number; total: number }
  | { phase: "verifying" }
  | { phase: "ready" }
  | { phase: "failed"; reason: DesktopInstallFailure };

/**
 * 已下载好、点了「重启以更新」但有本机 Agent 在执行任务：waiting=在等它们做完，做完自动重启；
 * timeout=等到 30 分钟上限还没做完，等人再决定（老版本桌面端没有这一项）
 */
export type DesktopRestartWait =
  { phase: "waiting"; agents: string[] } | { phase: "timeout"; agents: string[] };

export type DesktopInstallView = {
  available: boolean;
  reason?: DesktopInstallFailure;
  size: number;
  state: DesktopInstallState;
  restart?: DesktopRestartWait;
};

/**
 * 「重启以更新」带的选择：check=先看有没有本机 Agent 在执行任务，没有就直接重启；
 * wait=等它们做完再重启（超时后再选一次是再等一轮）；now=立即重启，中断正在执行的任务
 */
export type DesktopRestartChoice = "check" | "wait" | "now";

/** busy=有 Agent 在忙、没有重启，等人选；unavailable=新版本还没准备好 */
export type DesktopRestartResult =
  | { status: "restarting" }
  | { status: "busy"; agents: string[] }
  | { status: "waiting"; agents: string[] }
  | { status: "unavailable" };

/** 「检查更新」的结果：有新版时详情照常从 onChange 推过来 */
export type DesktopUpdateCheckResult = {
  /** available=有新版；latest=已是最新；failed=没查成（断网、限流）；disabled=这个版本不检查（开发版） */
  status: "available" | "latest" | "failed" | "disabled";
  currentVersion: string;
};

/** 新版提示：打开下载地址或发布页时网页只说打开哪个，地址由桌面端自己取 */
export type DesktopUpdatesApi = {
  get(): Promise<DesktopUpdateInfo | null>;
  open(target: "download" | "release"): Promise<boolean>;
  dismiss(version: string): Promise<boolean>;
  onChange(listener: (info: DesktopUpdateInfo | null) => void): () => void;
  /** 「下载并更新」（老版本桌面端没有） */
  install?(version: string): Promise<boolean>;
  /** 「重启以更新」（老版本桌面端没有；也不认选择，直接重启并返回 true） */
  restart?(choice?: DesktopRestartChoice): Promise<boolean | DesktopRestartResult>;
  /** 取消「等任务做完再重启」（老版本桌面端没有） */
  cancelRestart?(): Promise<boolean>;
  /** 状态栏「检查更新」：马上查一次，不弹系统对话框（老版本桌面端没有，不显示这个按钮） */
  checkNow?(): Promise<DesktopUpdateCheckResult>;
};

/** 客户端里打开过的别人的服务器 */
export type DesktopRemoteServer = {
  origin: string;
  host: string;
  url: string;
  lastOpenedAt: string;
  /** 窗口现在开着 */
  open: boolean;
};

/** 菜单「加入别人的房间」或 superhive:// 链接让页面弹出的对话框 */
export type DesktopJoinRequest =
  { kind: "room" } | { kind: "agent"; server: string; roomId: string; name: string; token: string };

/** 别人的服务器：每个开一个单独的窗口，拿不到本机能力（老版本桌面端没有） */
export type DesktopRemoteApi = {
  list(): Promise<DesktopRemoteServer[]>;
  open(url: string): Promise<boolean>;
  remove(origin: string): Promise<boolean>;
  onChange(listener: (servers: DesktopRemoteServer[]) => void): () => void;
  onJoinRequest(listener: (request: DesktopJoinRequest) => void): () => void;
};

export type DesktopBridge = {
  version: number;
  platform: string;
  terminal: DesktopTerminalApi;
  titlebar?: DesktopTitlebarApi;
  /** 网页首屏画好了，桌面端收起启动加载画面（老版本桌面端没有这一项） */
  ready?: () => void;
  /** 选附件（老版本桌面端没有这一项，照旧用 <input type=file>） */
  files?: DesktopFilesApi;
  /** 检查新版（老版本桌面端没有这一项，不显示新版提示） */
  updates?: DesktopUpdatesApi;
  /** 加入别人的房间（老版本桌面端没有这一项，只能在浏览器里打开邀请链接） */
  remote?: DesktopRemoteApi;
};

declare global {
  interface Window {
    superhiveDesktop?: unknown;
  }
}

const TERMINAL_METHODS = [
  "create",
  "write",
  "resize",
  "kill",
  "onData",
  "onExit",
  "onNewRequest",
] as const;

const UPDATE_METHODS = ["get", "open", "dismiss", "onChange"] as const;
const REMOTE_METHODS = ["list", "open", "remove", "onChange", "onJoinRequest"] as const;

/** 读取并校验桌面端能力；形状不对（版本不兼容、被别的脚本冒充）就当作不在桌面端 */
export function desktopBridge(
  source: unknown = globalThis.window?.superhiveDesktop,
): DesktopBridge | undefined {
  if (!source || typeof source !== "object") return undefined;
  const value = source as Partial<DesktopBridge>;
  if (value.version !== 1 || typeof value.platform !== "string") return undefined;
  const terminal = value.terminal as Partial<DesktopTerminalApi> | undefined;
  if (!terminal || TERMINAL_METHODS.some((name) => typeof terminal[name] !== "function")) {
    return undefined;
  }
  // 新加的可选能力形状不对就只去掉那一项（reattach 要 list 和 attach 都在）
  const optional = ["list", "attach", "onLayoutRequest"] as const;
  if (optional.some((name) => name in terminal && typeof terminal[name] !== "function")) {
    const cleaned: Partial<DesktopTerminalApi> = { ...terminal };
    for (const name of optional) if (typeof cleaned[name] !== "function") delete cleaned[name];
    return desktopBridge({ ...value, terminal: cleaned });
  }
  const files = value.files as Partial<DesktopFilesApi> | undefined;
  if (files !== undefined && (!files || typeof files.pick !== "function")) {
    // 选附件接口形状不对只丢掉这一项，退回网页自己的选文件
    return desktopBridge({ ...value, files: undefined });
  }
  const updates = value.updates as Partial<DesktopUpdatesApi> | undefined;
  if (
    updates !== undefined &&
    (!updates || UPDATE_METHODS.some((name) => typeof updates[name] !== "function"))
  ) {
    // 新版提示接口形状不对只丢掉这一项
    return desktopBridge({ ...value, updates: undefined });
  }
  if (
    updates &&
    (["install", "restart"] as const).some(
      (name) => name in updates && typeof updates[name] !== "function",
    )
  ) {
    // 应用内更新的两个方法形状不对：只去掉它们，退回下载安装包
    const cleaned: Partial<DesktopUpdatesApi> = { ...updates };
    delete cleaned.install;
    delete cleaned.restart;
    return desktopBridge({ ...value, updates: cleaned });
  }
  if (updates && "checkNow" in updates && typeof updates.checkNow !== "function") {
    // 检查更新的方法形状不对：只去掉它，不显示「检查更新」按钮
    const cleaned: Partial<DesktopUpdatesApi> = { ...updates };
    delete cleaned.checkNow;
    return desktopBridge({ ...value, updates: cleaned });
  }
  if (updates && "cancelRestart" in updates && typeof updates.cancelRestart !== "function") {
    // 取消等待的方法形状不对：只去掉它，等待时不给「取消等待」
    const cleaned: Partial<DesktopUpdatesApi> = { ...updates };
    delete cleaned.cancelRestart;
    return desktopBridge({ ...value, updates: cleaned });
  }
  const remote = value.remote as Partial<DesktopRemoteApi> | undefined;
  if (
    remote !== undefined &&
    (!remote || REMOTE_METHODS.some((name) => typeof remote[name] !== "function"))
  ) {
    return desktopBridge({ ...value, remote: undefined });
  }
  const titlebar = value.titlebar as Partial<DesktopTitlebarApi> | undefined;
  if (titlebar !== undefined && (!titlebar || typeof titlebar.setAppearance !== "function")) {
    // 标题栏接口形状不对只丢掉这一项，终端照常可用
    return { ...value, titlebar: undefined } as DesktopBridge;
  }
  return value as DesktopBridge;
}
