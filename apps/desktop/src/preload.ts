/**
 * 预加载脚本：沙箱里运行，只经 contextBridge 暴露一个很窄的 window.superhiveDesktop。
 * 只有页面来源是主进程告诉我们的本机 Hive 地址时才暴露；跳到别的地方（本来也会被拦下）什么都拿不到。
 * 地址在页面加载时同步问主进程（窗口在本机 Hive 起好之前就建出来显示加载动画，建窗口时还不知道地址）；
 * 主进程只回答自己的主窗口顶层框架，别的一律回 null。IPC 每次还会再按 senderFrame 校验一次，这里只是第一道。
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  IPC,
  RESTART_CHOICES,
  TERMINAL_LAYOUT_ACTIONS,
  UPDATE_OPEN_TARGETS,
  type TerminalAttachResult,
  type TerminalCreateRequest,
  type TerminalCreateResult,
  type TerminalExitEvent,
  type TerminalLayoutAction,
  type TerminalSessionInfo,
  type UpdateCheckNowResult,
  type UpdateOpenTarget,
  type JoinRequest,
  type RemoteServerView,
  type RestartChoice,
  type RestartResult,
} from "./ipc-contract.js";
import type { DesktopUpdate } from "./update-install.js";
import type { PickFilesRequest, PickFilesResult } from "./file-picker.js";
import { applyDesktopMarks, parseTitlebarArg, setFullscreenMark } from "./titlebar-dom.js";

function queryOrigin(): string | undefined {
  if (window.top !== window) return undefined;
  try {
    const value: unknown = ipcRenderer.sendSync(IPC.originQuery);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

const allowedOrigin = queryOrigin();

if (allowedOrigin && window.location.origin === allowedOrigin && window.top === window) {
  const titlebarMode = parseTitlebarArg(process.argv);
  let fullscreen = false;
  // 标记尽早打上（preload 跑在文档解析之前，html 元素可能还没有），免得页面先按普通网页排一遍再跳
  const mark = () => {
    const root = document.documentElement;
    if (root)
      applyDesktopMarks(root, { platform: process.platform, mode: titlebarMode, fullscreen });
    return Boolean(root);
  };
  if (!mark()) document.addEventListener("readystatechange", mark, { once: true });
  ipcRenderer.on(IPC.windowFullscreen, (_event: IpcRendererEvent, value: unknown) => {
    fullscreen = value === true;
    if (document.documentElement) setFullscreenMark(document.documentElement, fullscreen);
  });

  const api = {
    /** 网页用来判断能力的版本号，接口有不兼容的变化时加 1 */
    version: 1,
    platform: process.platform,
    /** 网页首屏画好了，收起桌面端的启动加载画面（重复调用无害） */
    ready: (): void => {
      ipcRenderer.send(IPC.appReady);
    },
    files: {
      /**
       * 打开系统选文件窗口，起始目录是这个房间绑定的工作区（主进程自己查，网页只给房间 ID）。
       * 按上传上限读回选中的文件；超限的只有名字和大小（skipped 说明原因）。
       */
      pick: (request: PickFilesRequest): Promise<PickFilesResult> =>
        ipcRenderer.invoke(IPC.pickFiles, {
          roomId: typeof request?.roomId === "string" ? request.roomId : null,
          multiple: request?.multiple !== false,
        }),
    },
    updates: {
      /** 主进程缓存的检查结果：有要提示的新版时是版本信息，否则 null（页面拿不到任何链接） */
      get: (): Promise<DesktopUpdate | null> => ipcRenderer.invoke(IPC.updateGet),
      /** 打开下载地址或发布页；地址由主进程从检查结果里取，只会是 github.com 上本仓库的 Release */
      open: (target: UpdateOpenTarget): Promise<boolean> =>
        ipcRenderer.invoke(
          IPC.updateOpen,
          UPDATE_OPEN_TARGETS.includes(target) ? target : "release",
        ),
      /** 「忽略这个版本」 */
      dismiss: (version: string): Promise<boolean> =>
        ipcRenderer.invoke(IPC.updateDismiss, String(version)),
      /** 「下载并更新」：在后台下载、校验、准备好新版本，进度从 onChange 推过来 */
      install: (version: string): Promise<boolean> =>
        ipcRenderer.invoke(IPC.updateInstall, String(version)),
      /**
       * 「重启以更新」：check 先看有没有本机 Agent 在执行任务（有就不重启，返回名单等人选），
       * wait 等它们做完再重启，now 立即重启。不传（老网页）时有 Agent 在忙由桌面端弹系统对话框问
       */
      restart: (choice?: RestartChoice): Promise<boolean | RestartResult> =>
        ipcRenderer.invoke(
          IPC.updateRestart,
          ...(choice !== undefined && RESTART_CHOICES.includes(choice) ? [choice] : []),
        ),
      /** 取消「等任务做完再重启」 */
      cancelRestart: (): Promise<boolean> => ipcRenderer.invoke(IPC.updateCancelRestart),
      /** 「检查更新」：马上查一次；有新版时详情照常从 onChange 推过来 */
      checkNow: (): Promise<UpdateCheckNowResult> => ipcRenderer.invoke(IPC.updateCheckNow),
      onChange: (listener: (info: DesktopUpdate | null) => void): (() => void) => {
        const handler = (_event: IpcRendererEvent, info: DesktopUpdate | null) => listener(info);
        ipcRenderer.on(IPC.updateChanged, handler);
        return () => ipcRenderer.removeListener(IPC.updateChanged, handler);
      },
    },
    remote: {
      /** 打开过的别人的服务器（最近打开的在前） */
      list: (): Promise<RemoteServerView[]> => ipcRenderer.invoke(IPC.remoteList),
      /** 在单独的窗口里打开别人的邀请链接或服务器地址；地址不对时返回 false */
      open: (url: string): Promise<boolean> => ipcRenderer.invoke(IPC.remoteOpen, String(url)),
      /** 忘掉这个服务器：关窗口、从列表删掉、清掉在它那里的访客身份 */
      remove: (origin: string): Promise<boolean> =>
        ipcRenderer.invoke(IPC.remoteRemove, String(origin)),
      onChange: (listener: (servers: RemoteServerView[]) => void): (() => void) => {
        const handler = (_event: IpcRendererEvent, servers: RemoteServerView[]) =>
          listener(servers);
        ipcRenderer.on(IPC.remoteChanged, handler);
        return () => ipcRenderer.removeListener(IPC.remoteChanged, handler);
      },
      /** 菜单「加入别人的房间」或 superhive:// 链接要页面弹出对应的对话框 */
      onJoinRequest: (listener: (request: JoinRequest) => void): (() => void) => {
        const handler = (_event: IpcRendererEvent, request: JoinRequest) => listener(request);
        ipcRenderer.on(IPC.joinRequest, handler);
        return () => ipcRenderer.removeListener(IPC.joinRequest, handler);
      },
    },
    titlebar: {
      /** "mac"：红黄绿按钮在左上；"overlay"：系统按钮在右上；"native"：系统标题栏 */
      mode: titlebarMode,
      setAppearance: (appearance: {
        height: number;
        color: string;
        symbolColor: string;
        inactiveSymbolColor: string;
        scrim?: string;
      }): void => {
        ipcRenderer.send(IPC.titlebarAppearance, {
          height: Number(appearance?.height),
          color: String(appearance?.color),
          symbolColor: String(appearance?.symbolColor),
          inactiveSymbolColor: String(appearance?.inactiveSymbolColor),
          ...(appearance?.scrim === undefined ? {} : { scrim: String(appearance.scrim) }),
        });
      },
    },
    terminal: {
      create: (request: TerminalCreateRequest): Promise<TerminalCreateResult> =>
        ipcRenderer.invoke(IPC.terminalCreate, {
          cwd: typeof request?.cwd === "string" ? request.cwd : null,
          cols: Number(request?.cols) || undefined,
          rows: Number(request?.rows) || undefined,
        }),
      write: (id: string, data: string): void => {
        ipcRenderer.send(IPC.terminalWrite, String(id), String(data));
      },
      resize: (id: string, cols: number, rows: number): void => {
        ipcRenderer.send(IPC.terminalResize, String(id), Number(cols), Number(rows));
      },
      kill: (id: string): void => {
        ipcRenderer.send(IPC.terminalKill, String(id));
      },
      /** 页面刷新后：这个窗口里还在跑的终端 */
      list: (): Promise<TerminalSessionInfo[]> => ipcRenderer.invoke(IPC.terminalList),
      /** 接回一个终端，拿到最近的输出用来回放；终端已经没了时是 null */
      attach: (id: string): Promise<TerminalAttachResult | null> =>
        ipcRenderer.invoke(IPC.terminalAttach, String(id)),
      onData: (listener: (id: string, data: string) => void): (() => void) => {
        const handler = (_event: IpcRendererEvent, id: string, data: string) => listener(id, data);
        ipcRenderer.on(IPC.terminalData, handler);
        return () => ipcRenderer.removeListener(IPC.terminalData, handler);
      },
      onExit: (listener: (event: TerminalExitEvent) => void): (() => void) => {
        const handler = (_event: IpcRendererEvent, payload: TerminalExitEvent) => listener(payload);
        ipcRenderer.on(IPC.terminalExit, handler);
        return () => ipcRenderer.removeListener(IPC.terminalExit, handler);
      },
      /** 菜单里的「新建终端」 */
      onNewRequest: (listener: () => void): (() => void) => {
        const handler = () => listener();
        ipcRenderer.on(IPC.terminalNewRequest, handler);
        return () => ipcRenderer.removeListener(IPC.terminalNewRequest, handler);
      },
      /** 菜单里的「最大化 / 还原终端」「终端移到右侧 / 底部」 */
      onLayoutRequest: (listener: (action: TerminalLayoutAction) => void): (() => void) => {
        const handler = (_event: IpcRendererEvent, action: unknown) => {
          if (TERMINAL_LAYOUT_ACTIONS.includes(action as TerminalLayoutAction))
            listener(action as TerminalLayoutAction);
        };
        ipcRenderer.on(IPC.terminalLayoutRequest, handler);
        return () => ipcRenderer.removeListener(IPC.terminalLayoutRequest, handler);
      },
    },
  };
  contextBridge.exposeInMainWorld("superhiveDesktop", Object.freeze(api));
}
