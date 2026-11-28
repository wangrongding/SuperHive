/**
 * SuperHive 桌面端主进程。
 *
 * 两种运行方式：
 * - 正常打开：起（或连上）本机 Hive，窗口里加载现有的网页界面，并提供内置终端；
 * - `--superhive-cli ...`：Server 拉起本机 Agent 时用。桌面端关掉了 RunAsNode，
 *   Electron 不能被当成任意 Node 用，所以由主进程自己加载随包的 superhive CLI 跑 `join`，
 *   不开窗口、不占 Dock，也不抢单实例锁。只会运行包里的 CLI，不执行任意脚本。
 */
import {
  app,
  autoUpdater,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  net,
  screen,
  session,
  shell,
  utilityProcess,
  WebContentsView,
  webContents as allWebContents,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type WebContents,
  type WebPreferences,
} from "electron";
import { execFile, spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  checkFirewall,
  hostFor,
  resolveLanSetting,
  saveLanSetting,
  type FirewallStatus,
  type LanAccessState,
} from "./lan-access.js";
import {
  discover,
  startServer,
  superhiveHome,
  type ForkServer,
  type OwnedServer,
} from "./hive-server.js";
import {
  IPC,
  RESTART_CHOICES,
  type RestartChoice,
  type RestartResult,
  type TerminalCreateRequest,
  type TerminalLayoutAction,
  type UpdateCheckNowResult,
} from "./ipc-contract.js";
import { imageContextMenu } from "./image-context-menu.js";
import { keychainSwitches } from "./keychain.js";
import { createPickFilesHandler, createWorkspaceLookup, readPickedFiles } from "./file-picker.js";
import { createLocalHiveGet } from "./local-hive.js";
import { busyAgentNames, RestartGate } from "./restart-gate.js";
import { isLoopbackOrigin, isTrustedSender, originAnswer, originOf } from "./ipc-guard.js";
import { loginShellEnv, mergePath, mergeProxyEnv } from "./shell-env.js";
import {
  loadSplashTheme,
  parseSplashAction,
  resolveDark,
  saveSplashTheme,
  SPLASH_BACKGROUND,
  SplashController,
  splashHtml,
  splashUpdateScript,
  splashVariant,
  themeFromAppearance,
  type SplashPhase,
  type SplashTheme,
} from "./splash.js";
import { cliUserDataName } from "./cli-mode.js";
import { handleSquirrelEvent } from "./squirrel.js";
import { TerminalManager, type PtySpawn } from "./terminal-manager.js";
import { langFor, text, type Lang, type TextKey } from "./texts.js";
import {
  defaultAppearance,
  macButtonPosition,
  acceptAppearance,
  overlayOptions,
  titlebarMode,
  titlebarWindowOptions,
  type TitlebarAppearance,
} from "./titlebar.js";
import { TITLEBAR_ARG_PREFIX } from "./titlebar-dom.js";
import {
  isAllowedReleaseUrl,
  loadUpdateCache,
  RELEASE_REPO,
  saveUpdateCache,
  UpdateChecker,
} from "./update-check.js";
import { createMacUpdater } from "./mac-update.js";
import { createWindowsUpdater } from "./win-update.js";
import { UpdateInstaller, type DesktopUpdate, type InstallBackend } from "./update-install.js";
import { loadWindowState, restoreBounds, saveWindowState, MIN_SIZE } from "./window-state.js";
import {
  DEEP_LINK_SCHEME,
  REMOTE_PARTITION,
  deepLinkFromArgv,
  describeRoomLink,
  loadRemoteServers,
  normalizeRemoteUrl,
  parseDeepLink,
  remoteWindowTitle,
  saveRemoteServers,
  upsertRemoteServer,
  type RemoteServer,
} from "./remote-servers.js";
import type { JoinRequest, RemoteServerView } from "./ipc-contract.js";
import { bundledRuntime, bundledRuntimeEnv } from "./bundled-node.js";

const CLI_FLAG = "--superhive-cli";
const DOCS_URL = "https://wangrongding.github.io/SuperHive/";
const ISSUES_URL = "https://github.com/wangrongding/SuperHive/issues";
const RELEASES_URL = `https://github.com/${RELEASE_REPO.owner}/${RELEASE_REPO.name}/releases/`;
/** 启动后等一会儿再查新版，不和本机 Hive 启动、网页加载抢 */
const UPDATE_FIRST_CHECK_DELAY_MS = 20_000;
/** 网页载入完多久还没说「画好了」就直接收起加载画面 */
const READY_FALLBACK_MS = 6_000;
const PREFERRED_PORT = Number.parseInt(process.env.SUPERHIVE_DESKTOP_PORT ?? "", 10) || 8787;

/** 打包后的应用根目录（app.asar 或开发时的 .stage/app） */
const appRoot = __dirname;
const superhiveRoot = path.join(appRoot, "superhive");

// Mac 上不碰钥匙串（ad-hoc 签名每个版本都会弹授权框，见 keychain.ts）；命令行模式也是 Electron 起的，一起加
for (const name of keychainSwitches(process.platform)) app.commandLine.appendSwitch(name);

const cliIndex = process.argv.indexOf(CLI_FLAG);
if (cliIndex >= 0) {
  void runCli(process.argv.slice(cliIndex + 1));
} else if (
  !handleSquirrelEvent({
    platform: process.platform,
    argv: process.argv,
    execPath: process.execPath,
    run: runUpdateExe,
    quit: () => app.quit(),
    // 只删指向这个 exe 的登记（Electron 会核对），别的程序或别处装的 SuperHive 登记的不动
    onUninstall: () => app.removeAsDefaultProtocolClient(DEEP_LINK_SCHEME),
  })
) {
  runApp();
}

/** Windows 安装 / 卸载时跑 Update.exe 建删快捷方式；最多等 10 秒，跑不起来也照样退出 */
function runUpdateExe(command: string, args: string[], done: () => void): void {
  const timer = setTimeout(done, 10_000);
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", () => {
      clearTimeout(timer);
      done();
    });
    child.once("close", () => {
      clearTimeout(timer);
      done();
    });
  } catch {
    clearTimeout(timer);
    done();
  }
}

async function runCli(args: string[]): Promise<void> {
  app.dock?.hide();
  // 命令行模式不画界面：关掉硬件加速；Chromium 的缓存放到单独目录，不和桌面端、别的 Agent 抢
  app.disableHardwareAcceleration();
  app.setPath("userData", path.join(app.getPath("userData"), "cli", cliUserDataName(args)));
  const cli = path.join(superhiveRoot, "dist", "cli.js");
  process.argv = [process.execPath, cli, ...args];
  try {
    await import(pathToFileURL(cli).href);
  } catch (error) {
    console.error("[superhive-desktop] failed to run CLI:", error);
    app.exit(1);
  }
}

/** 本机 Agent 的启动命令：开发时 Electron 要带上应用目录 */
function agentCliCommand(): string[] {
  return app.isPackaged
    ? [process.execPath, CLI_FLAG]
    : [process.execPath, app.getAppPath(), CLI_FLAG];
}

function runApp(): void {
  // 指定了别的数据目录（测试、并排跑第二份）时，Electron 自己的用户目录也跟着分开：
  // 单实例锁、窗口位置都按用户目录算，不然会被正在用的那份桌面端挡住直接退出
  if (process.env.SUPERHIVE_DESKTOP_DATA_DIR) {
    app.setPath("userData", path.join(superhiveHome(), "desktop-user-data"));
  }
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  // 所有渲染进程都进沙箱
  app.enableSandbox();

  let lang: Lang = "en";
  const t = (key: TextKey, params?: Record<string, string>) => text(lang, key, params);

  let mainWindow: BrowserWindow | undefined;
  /** 启动加载画面：主窗口里盖在网页上面的一层 */
  let splash: { view: WebContentsView; controller: SplashController } | undefined;
  /** 网页加载完还没说「画好了」时的兜底计时（老版本网页没有 ready 接口） */
  let readyFallback: NodeJS.Timeout | undefined;
  /** 当前允许拿到终端能力的页面来源（本机 Hive 的回环地址） */
  let allowedOrigin: string | undefined;
  const trustedIds = new Set<number>();
  let owned: OwnedServer | undefined;
  let quitting = false;
  let shutdownDone = false;
  const dataDir = superhiveHome();

  // ---------- 终端 ----------
  let ptySpawn: PtySpawn | undefined;
  const loadPty = (): PtySpawn => {
    if (!ptySpawn) {
      // 原生模块，按需加载：加载失败只影响终端，不影响主界面
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pty = require("node-pty") as { spawn: PtySpawn };
      ptySpawn = pty.spawn.bind(pty);
    }
    return ptySpawn;
  };
  // 输出按一个事件循环批量发送，避免大量输出时 IPC 消息过多
  const pending = new Map<string, { ownerId: number; chunks: string[] }>();
  let flushScheduled = false;
  const flush = () => {
    flushScheduled = false;
    for (const [id, entry] of pending) {
      const contents = allWebContents.fromId(entry.ownerId);
      if (contents && !contents.isDestroyed())
        contents.send(IPC.terminalData, id, entry.chunks.join(""));
    }
    pending.clear();
  };
  const terminals = new TerminalManager({
    spawn: (file, args, options) => loadPty()(file, args, options),
    env: () => process.env,
    sink: {
      data(ownerId, id, data) {
        const entry = pending.get(id) ?? { ownerId, chunks: [] };
        entry.chunks.push(data);
        pending.set(id, entry);
        if (!flushScheduled) {
          flushScheduled = true;
          setTimeout(flush, 5);
        }
      },
      exit(ownerId, id, exitCode, signal) {
        flush();
        const contents = allWebContents.fromId(ownerId);
        if (contents && !contents.isDestroyed())
          contents.send(IPC.terminalExit, { id, exitCode, ...(signal ? { signal } : {}) });
      },
    },
  });

  const trusted = (event: IpcMainEvent | IpcMainInvokeEvent) =>
    isTrustedSender(event, { origin: allowedOrigin, webContentsIds: trustedIds });

  ipcMain.handle(IPC.terminalCreate, (event, request: TerminalCreateRequest) => {
    if (!trusted(event)) throw new Error("Forbidden");
    return terminals.create(event.sender.id, request ?? {});
  });
  ipcMain.on(IPC.terminalWrite, (event, id: unknown, data: unknown) => {
    if (trusted(event)) terminals.write(event.sender.id, id, data);
  });
  ipcMain.on(IPC.terminalResize, (event, id: unknown, cols: unknown, rows: unknown) => {
    if (trusted(event)) terminals.resize(event.sender.id, id, cols, rows);
  });
  ipcMain.on(IPC.terminalKill, (event, id: unknown) => {
    if (trusted(event)) terminals.kill(event.sender.id, id);
  });
  ipcMain.handle(IPC.terminalList, (event) => {
    if (!trusted(event)) throw new Error("Forbidden");
    return terminals.list(event.sender.id);
  });
  ipcMain.handle(IPC.terminalAttach, (event, id: unknown) => {
    if (!trusted(event)) throw new Error("Forbidden");
    const result = terminals.attach(event.sender.id, id);
    // 还没发出去的输出已经包含在回放里，别再发一遍
    if (result) pending.delete(result.id);
    return result ?? null;
  });

  // ---------- 输入框「添加附件」：系统选文件窗口默认打开房间工作区 ----------
  // 网页只给房间 ID；起始目录由主进程自己向本机 Hive 查，选中的文件按上传上限读回去
  const roomWorkspace = createWorkspaceLookup({ origin: () => allowedOrigin, fetch });
  ipcMain.handle(
    IPC.pickFiles,
    createPickFilesHandler<IpcMainInvokeEvent>({
      trusted,
      roomWorkspace,
      home: homedir,
      isDirectory: async (target) => (await stat(target)).isDirectory(),
      title: () => t("pickAttachments"),
      showDialog: (event, { title, defaultPath, multiple }) => {
        const options: Electron.OpenDialogOptions = {
          title,
          defaultPath,
          properties: multiple ? ["openFile", "multiSelections"] : ["openFile"],
        };
        const owner = BrowserWindow.fromWebContents(event.sender);
        return owner ? dialog.showOpenDialog(owner, options) : dialog.showOpenDialog(options);
      },
      readFiles: (paths) =>
        readPickedFiles(paths, {
          stat,
          readFile: async (file) => new Uint8Array(await readFile(file)),
        }),
    }),
  );

  // ---------- 检查新版、应用内更新 ----------
  // 打包后的正式版才查；开发时设 SUPERHIVE_DESKTOP_UPDATE_CHECK=1 也查，设 0 一律不查
  const updateCheckEnabled =
    process.env.SUPERHIVE_DESKTOP_UPDATE_CHECK === "1" ||
    (app.isPackaged && process.env.SUPERHIVE_DESKTOP_UPDATE_CHECK !== "0");
  let updates: UpdateChecker | undefined;
  let updateTimer: NodeJS.Timeout | undefined;
  const updateChecker = (): UpdateChecker => {
    const file = () => path.join(app.getPath("userData"), "desktop-update.json");
    updates ??= new UpdateChecker({
      currentVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      // 和下载一样走 Chromium 的网络栈：跟系统代理设置（Node 自带的 fetch 不认代理）
      fetch: (url, init) => net.fetch(url, init),
      load: () => loadUpdateCache(file()),
      save: (cache) => saveUpdateCache(file(), cache),
    });
    return updates;
  };
  /** 应用内更新只在打包后的正式版上做：开发版没有 .app / Update.exe 可替换 */
  const installBackend = (): InstallBackend | undefined => {
    if (!app.isPackaged) return undefined;
    if (process.platform === "darwin" && process.arch === "arm64") {
      const updatesDir = path.join(app.getPath("userData"), "updates");
      return createMacUpdater({
        exePath: process.execPath,
        pid: process.pid,
        workDir: path.join(updatesDir, "work"),
        logFile: path.join(updatesDir, "install.log"),
        // 走 Chromium 的网络栈：跟系统代理设置，GitHub 跳转到下载服务器也照常跟
        fetch: (url, init) => net.fetch(url, init),
        quit: () => app.quit(),
      });
    }
    if (process.platform === "win32" && process.arch === "x64") {
      return createWindowsUpdater({ execPath: process.execPath, updater: () => autoUpdater });
    }
    return undefined;
  };
  let installer: UpdateInstaller | undefined;
  const updateInstaller = (): UpdateInstaller => {
    installer ??= new UpdateInstaller({ backend: installBackend(), onChange: () => pushUpdate() });
    return installer;
  };
  // 「重启以更新」前先看本机 Agent 有没有在执行任务（口径和网页版更新一致，见 restart-gate.ts）
  const localHive = createLocalHiveGet({ origin: () => owned?.origin, fetch, timeoutMs: 5_000 });
  let gate: RestartGate | undefined;
  const restartGate = (): RestartGate => {
    gate ??= new RestartGate({
      ready: () => installer?.phase === "ready",
      restart: () => installer?.restart() ?? false,
      // 连的是别人起的 Hive（hive start）：退出桌面端不会停掉它，Agent 不受影响
      busyAgents: async () => (owned ? busyAgentNames(await localHive("/api/local/agents")) : []),
      onChange: () => pushUpdate(),
    });
    return gate;
  };
  /** 交给网页的新版信息：检查结果 + 应用内更新的状态（含等 Agent 做完再重启） */
  const updateSnapshot = (): DesktopUpdate | null => {
    const checker = updateChecker();
    const info = checker.current();
    if (!info) return null;
    const install = updateInstaller().view(info.version, checker.installPackage());
    const restart = install.state.phase === "ready" ? gate?.view() : undefined;
    return { ...info, install: restart ? { ...install, restart } : install };
  };
  let lastSentUpdate: string | undefined;
  /** 把当前新版信息和安装进度告诉主窗口里的网页（和上次一样就不发） */
  const pushUpdate = () => {
    const snapshot = updateSnapshot();
    const key = JSON.stringify(snapshot);
    if (key === lastSentUpdate) return;
    const contents = mainWindow?.webContents;
    if (!allowedOrigin || !contents || contents.isDestroyed()) return;
    lastSentUpdate = key;
    contents.send(IPC.updateChanged, snapshot);
  };
  const scheduleUpdateCheck = (delay: number) => {
    clearTimeout(updateTimer);
    updateTimer = setTimeout(() => {
      void updateChecker()
        .check()
        .then(() => pushUpdate())
        .catch(() => undefined)
        .finally(() => scheduleUpdateCheck(updateChecker().msUntilNextCheck() || 60 * 60 * 1000));
    }, delay);
  };
  /** 「下载并更新」：只认当前正在提示的版本，要下载的包由主进程自己从检查结果里挑 */
  const startInstall = (version: unknown): boolean => {
    const checker = updateChecker();
    const info = checker.current();
    if (!info || info.version !== version) return false;
    return updateInstaller().start(checker.installPackage());
  };
  ipcMain.handle(IPC.updateGet, (event) => {
    if (!trusted(event)) throw new Error("Forbidden");
    if (!updateCheckEnabled) return null;
    const snapshot = updateSnapshot();
    lastSentUpdate = JSON.stringify(snapshot);
    return snapshot;
  });
  ipcMain.handle(IPC.updateOpen, (event, target: unknown) => {
    if (!trusted(event) || !updateCheckEnabled) return false;
    // 地址只从主进程自己的检查结果里取，网页传什么都不会被当成地址
    const url = updateChecker().urlFor(target);
    if (!isAllowedReleaseUrl(url)) return false;
    void shell.openExternal(url);
    return true;
  });
  ipcMain.handle(IPC.updateDismiss, (event, version: unknown) => {
    if (!trusted(event) || !updateCheckEnabled) return false;
    const ok = updateChecker().dismiss(version);
    if (ok) pushUpdate();
    return ok;
  });
  ipcMain.handle(IPC.updateInstall, (event, version: unknown) => {
    if (!trusted(event) || !updateCheckEnabled) return false;
    return startInstall(version);
  });
  ipcMain.handle(
    IPC.updateRestart,
    async (event, choice: unknown): Promise<boolean | RestartResult> => {
      if (!trusted(event) || !updateCheckEnabled) return false;
      // 老网页不带选择：有 Agent 在忙时弹系统对话框问（和菜单「检查新版本…」一样）
      if (choice === undefined) {
        void confirmRestart();
        return true;
      }
      if (!RESTART_CHOICES.includes(choice as RestartChoice)) return false;
      return restartGate().request(choice as RestartChoice);
    },
  );
  ipcMain.handle(IPC.updateCancelRestart, (event) => {
    if (!trusted(event) || !updateCheckEnabled) return false;
    return gate?.cancel() ?? false;
  });
  ipcMain.handle(IPC.lanGet, (event): LanAccessState => {
    if (!trusted(event)) throw new Error("Forbidden");
    return lanState();
  });
  ipcMain.handle(IPC.lanSet, async (event, enabled: unknown): Promise<LanAccessState> => {
    if (!trusted(event)) throw new Error("Forbidden");
    if (typeof enabled !== "boolean" || !owned || lanRestarting || enabled === lanEnabled)
      return lanState();
    lanEnabled = enabled;
    saveLanSetting(lanFile(), enabled);
    await relaunchOwned();
    return lanState();
  });
  // 只读查 Windows 防火墙有没有拦这个 exe（Server 是它的 utility 子进程，规则也记在它名下）
  ipcMain.handle(IPC.lanFirewall, async (event): Promise<FirewallStatus | null> => {
    if (!trusted(event)) throw new Error("Forbidden");
    if (lanEnabled !== true) return null;
    return checkFirewall({
      platform: process.platform,
      program: process.execPath,
      run: (script, env) =>
        new Promise((resolve, reject) => {
          execFile(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
            { env: { ...process.env, ...env }, windowsHide: true, timeout: 30_000 },
            (error, stdout) => (error ? reject(error) : resolve(String(stdout))),
          );
        }),
    });
  });
  /** 人主动检查（菜单、网页按钮）：马上查，忽略过的版本重新提示，并把结果推给网页 */
  const manualUpdateCheck = async () => {
    const checker = updateChecker();
    const info = await checker.checkNow().catch(() => null);
    pushUpdate();
    return { checker, info };
  };
  // 网页状态栏「检查更新」：结果由网页在右下角提示，不弹系统对话框
  ipcMain.handle(IPC.updateCheckNow, async (event): Promise<UpdateCheckNowResult> => {
    if (!trusted(event)) throw new Error("Forbidden");
    const currentVersion = app.getVersion();
    if (!updateCheckEnabled) return { status: "disabled", currentVersion };
    const { checker, info } = await manualUpdateCheck();
    return {
      status: info ? "available" : checker.lastCheckFailed ? "failed" : "latest",
      currentVersion,
    };
  });

  const showUpdateBox = (options: Electron.MessageBoxOptions) => {
    const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
    return owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options);
  };
  const agentList = (agents: string[]) =>
    agents.length ? agents.join(lang === "zh" ? "、" : ", ") : t("localAgents");

  /**
   * 系统对话框里的「重启以更新」（菜单「检查新版本…」、老网页）：有本机 Agent 在执行任务时先问，
   * 选项和网页里的卡片一样；已经在等或等超时了，就问接着怎么办。
   */
  async function confirmRestart(): Promise<void> {
    const restarter = restartGate();
    const wait = restarter.view();
    if (wait?.phase === "waiting") {
      const { response } = await showUpdateBox({
        type: "info",
        message: t("updateWaitingTitle"),
        detail: t("updateWaitingDetail", { agents: agentList(wait.agents) }),
        buttons: [t("updateKeepWaiting"), t("updateRestartNow"), t("updateStopWaiting")],
        defaultId: 0,
        cancelId: 0,
      });
      if (response === 1) await restarter.request("now");
      else if (response === 2) restarter.cancel();
      return;
    }
    if (wait?.phase === "timeout") {
      const { response } = await showUpdateBox({
        type: "warning",
        message: t("updateTimeoutTitle"),
        detail: t("updateTimeoutDetail", { agents: agentList(wait.agents) }),
        buttons: [t("updateWaitMore"), t("updateRestartNow"), t("updateLater")],
        defaultId: 0,
        cancelId: 2,
      });
      if (response === 0) await restarter.request("wait");
      else if (response === 1) await restarter.request("now");
      else restarter.cancel();
      return;
    }
    const result = await restarter.request("check");
    if (result.status !== "busy") return;
    const { response } = await showUpdateBox({
      type: "warning",
      message: t("updateBusyTitle"),
      detail: t("updateBusyDetail", { agents: agentList(result.agents) }),
      buttons: [t("updateWaitRestart"), t("updateRestartNow"), t("cancel")],
      defaultId: 0,
      cancelId: 2,
    });
    if (response === 0) {
      // 等待进度在主窗口右下角的卡片里看，可以随时取消
      await restarter.request("wait");
      showMainWindow();
    } else if (response === 1) await restarter.request("now");
  }

  /** 菜单「检查新版本…」：不管上次什么时候查过，马上查一次，并且一定给个答复 */
  async function checkUpdatesNow(): Promise<void> {
    const { checker, info } = await manualUpdateCheck();
    const show = showUpdateBox;
    const current = app.getVersion();
    if (info) {
      const install = updateInstaller().view(info.version, checker.installPackage());
      if (install.state.phase === "ready") {
        // 已经在等 Agent 做完：不再问一遍「重启以更新」，直接问接着怎么办
        if (gate?.view()) {
          await confirmRestart();
          return;
        }
        const { response } = await show({
          type: "info",
          message: t("updateReadyTitle", { version: info.version }),
          detail: t("updateReadyDetail"),
          buttons: [t("updateRestart"), t("updateLater")],
          defaultId: 0,
          cancelId: 1,
        });
        if (response === 0) await confirmRestart();
        return;
      }
      if (install.state.phase === "downloading" || install.state.phase === "verifying") {
        showMainWindow();
        return;
      }
      const { response } = await show({
        type: "info",
        message: t("updateAvailableTitle", { version: info.version }),
        detail: t(install.available ? "updateAvailableInstallDetail" : "updateAvailableDetail", {
          current,
        }),
        buttons: [t(install.available ? "updateInstall" : "updateDownload"), t("updateLater")],
        defaultId: 0,
        cancelId: 1,
      });
      if (response !== 0) return;
      if (install.available && startInstall(info.version)) {
        // 进度在侧栏的「有新版本」入口里看
        showMainWindow();
        return;
      }
      const url = checker.urlFor("download");
      if (isAllowedReleaseUrl(url)) void shell.openExternal(url);
    } else if (checker.lastCheckFailed) {
      const { response } = await show({
        type: "warning",
        message: t("updateFailed"),
        detail: t("updateFailedDetail"),
        buttons: [t("updateOpenReleases"), t("ok")],
        defaultId: 1,
        cancelId: 1,
      });
      if (response === 0) void shell.openExternal(RELEASES_URL);
    } else {
      await show({
        type: "info",
        message: t("updateNone"),
        detail: t("updateNoneDetail", { current }),
        buttons: [t("ok")],
      });
    }
  }

  // preload 问自己能不能拿到桌面端能力：只回答主窗口的顶层框架，而且页面已经在本机 Hive 上
  ipcMain.on(IPC.originQuery, (event) => {
    event.returnValue = originAnswer(event, { origin: allowedOrigin, webContentsIds: trustedIds });
  });
  ipcMain.on(IPC.appReady, (event) => {
    if (!trusted(event)) return;
    splash?.controller.ready();
    mainPageReady = true;
    if (pendingJoin) {
      event.sender.send(IPC.joinRequest, pendingJoin);
      pendingJoin = undefined;
    }
  });

  // ---------- 标题栏 ----------
  const titlebar = titlebarMode(process.platform, process.env);
  let appearance: TitlebarAppearance | undefined;
  /** 上次网页的主题（深 / 浅 / 跟随系统），启动加载画面和窗口底色第一帧就用它 */
  let splashTheme: SplashTheme = "system";
  const splashThemeFile = () => path.join(app.getPath("userData"), "splash-theme.json");
  const prefersDark = () => resolveDark(splashTheme, nativeTheme.shouldUseDarkColors);
  const currentAppearance = () => appearance ?? defaultAppearance(prefersDark());
  /** 把网页的顶栏外观套到窗口上：macOS 挪红黄绿按钮，Windows / Linux 改 overlay 配色和高度 */
  const applyAppearance = (window: BrowserWindow) => {
    if (window.isDestroyed()) return;
    const current = currentAppearance();
    if (titlebar === "mac") {
      window.setWindowButtonPosition(macButtonPosition(current.height));
    } else if (titlebar === "overlay") {
      try {
        window.setTitleBarOverlay(overlayOptions(current, window.isFocused()));
      } catch {
        // 个别 Linux 窗口管理器不支持 overlay：按钮仍是 Electron 自己画的默认样式，不影响使用
      }
    }
  };
  ipcMain.on(IPC.titlebarAppearance, (event, input: unknown) => {
    const parsed = acceptAppearance(event, input, {
      origin: allowedOrigin,
      webContentsIds: trustedIds,
    });
    if (!parsed) return;
    appearance = parsed;
    const theme = themeFromAppearance(parsed.color, nativeTheme.shouldUseDarkColors);
    if (theme !== splashTheme) {
      splashTheme = theme;
      saveSplashTheme(splashThemeFile(), theme);
    }
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window) applyAppearance(window);
  });

  // ---------- 安全：所有 webContents 统一限制 ----------
  /** 这个 webContents 只能待在哪个来源：别人的服务器窗口（及其弹窗）是对方的地址，其余是本机 Hive */
  const homeOrigin = (contents: WebContents): string | undefined =>
    remoteOrigins.get(contents.id) ?? allowedOrigin;
  const sameOriginUrl = (contents: WebContents, url: string): boolean => {
    const home = homeOrigin(contents);
    if (!home) return false;
    if (url.startsWith("blob:")) {
      try {
        return new URL(url).origin === home;
      } catch {
        return false;
      }
    }
    return originOf(url) === home;
  };
  const isDeepLink = (url: string) => url.toLowerCase().startsWith(`${DEEP_LINK_SCHEME}:`);
  const openExternal = (url: string) => {
    if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url);
  };
  const popupPreferences: WebPreferences = {
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webviewTag: false,
    spellcheck: false,
  };
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.on("will-navigate", (event) => {
      if (sameOriginUrl(contents, event.url)) return;
      event.preventDefault();
      // 页面里的 superhive:// 链接（比如别人房间里「用客户端带 Agent 加入」）交给自己处理
      if (isDeepLink(event.url)) handleDeepLink(event.url);
      else openExternal(event.url);
    });
    contents.on("will-redirect", (event) => {
      if (event.isMainFrame && !sameOriginUrl(contents, event.url)) event.preventDefault();
    });
    contents.setWindowOpenHandler(({ url }) => {
      // 同源的新窗口（附件预览、导出）照常打开，但不带 preload，拿不到终端
      if (sameOriginUrl(contents, url)) {
        const remote = remoteOrigins.has(contents.id);
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            autoHideMenuBar: true,
            webPreferences: remote
              ? { ...popupPreferences, partition: REMOTE_PARTITION }
              : popupPreferences,
          },
        };
      }
      if (isDeepLink(url)) handleDeepLink(url);
      else openExternal(url);
      return { action: "deny" };
    });
    // Electron 没有原生右键菜单：网页不接管的图片右击，补上「复制图片」「图片另存为」
    contents.on("context-menu", (_event, params) => {
      const items = imageContextMenu(
        params,
        {
          copyImageAt: (x, y) => contents.copyImageAt(x, y),
          downloadURL: (url) => contents.downloadURL(url),
        },
        { copyImage: t("copyImage"), saveImageAs: t("saveImageAs") },
      );
      if (!items) return;
      const window = BrowserWindow.fromWebContents(contents);
      Menu.buildFromTemplate(items).popup(window ? { window } : {});
    });
    // 别人服务器窗口里弹出的窗口也只能待在对方的地址上
    contents.on("did-create-window", (child) => {
      const origin = remoteOrigins.get(contents.id);
      if (!origin) return;
      const id = child.webContents.id;
      remoteOrigins.set(id, origin);
      child.once("closed", () => remoteOrigins.delete(id));
    });
  });

  const allowedPermissions = new Set([
    "clipboard-read",
    "clipboard-sanitized-write",
    "notifications",
    "fullscreen",
  ]);
  const permissionOk = (permission: string, origin: string | undefined) =>
    allowedPermissions.has(permission) && Boolean(origin) && originOf(origin!) === allowedOrigin;
  /** 别人的服务器只给通知、写剪贴板和全屏；读剪贴板这类不给 */
  const remotePermissions = new Set(["clipboard-sanitized-write", "notifications", "fullscreen"]);
  const remotePermissionOk = (permission: string, origin: string | undefined) => {
    const from = origin ? originOf(origin) : undefined;
    return (
      remotePermissions.has(permission) &&
      Boolean(from) &&
      remoteServers.some((server) => server.origin === from)
    );
  };

  // ---------- 别人的 Hive ----------
  const remoteFile = () => path.join(app.getPath("userData"), "remote-servers.json");
  let remoteServers: RemoteServer[] = [];
  /** 每个外部服务器一个窗口 */
  const remoteWindows = new Map<string, BrowserWindow>();
  /** 外部服务器窗口（含它弹出的窗口）的 webContents → 所属 origin */
  const remoteOrigins = new Map<number, string>();
  /** 本机页面还没准备好时先记下要它弹的「加入」对话框 */
  let pendingJoin: JoinRequest | undefined;
  let mainPageReady = false;

  const remoteViews = (): RemoteServerView[] =>
    remoteServers.map((server) => ({
      origin: server.origin,
      host: new URL(server.origin).host,
      url: server.url,
      lastOpenedAt: server.lastOpenedAt,
      open: Boolean(
        remoteWindows.get(server.origin) && !remoteWindows.get(server.origin)!.isDestroyed(),
      ),
    }));

  function notifyRemoteChanged(): void {
    buildMenu();
    const contents = mainWindow?.webContents;
    if (contents && !contents.isDestroyed()) contents.send(IPC.remoteChanged, remoteViews());
  }

  /** 打开（或切到）别人的服务器窗口；url 带着邀请时在那个窗口里跳过去 */
  function openRemote(target: { origin: string; url: string }): void {
    if (allowedOrigin && target.origin === allowedOrigin) {
      // 其实是本机 Hive 的链接：直接在主窗口里打开
      showMainWindow();
      void mainWindow?.loadURL(target.url).catch(() => undefined);
      return;
    }
    remoteServers = upsertRemoteServer(remoteServers, target, new Date());
    saveRemoteServers(remoteFile(), remoteServers);
    const existing = remoteWindows.get(target.origin);
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      if (target.url !== target.origin && target.url !== `${target.origin}/`)
        void existing.loadURL(target.url).catch(() => undefined);
      notifyRemoteChanged();
      return;
    }
    const window = new BrowserWindow({
      width: 1200,
      height: 800,
      minWidth: MIN_SIZE.width,
      minHeight: MIN_SIZE.height,
      title: remoteWindowTitle(target.origin),
      backgroundColor: backgroundColor(),
      autoHideMenuBar: process.platform !== "darwin",
      // 不给 preload：别人的页面拿不到终端、选文件这些本机能力
      webPreferences: { ...popupPreferences, partition: REMOTE_PARTITION },
    });
    const id = window.webContents.id;
    remoteOrigins.set(id, target.origin);
    remoteWindows.set(target.origin, window);
    window.webContents.on("page-title-updated", (event, title) => {
      event.preventDefault();
      window.setTitle(remoteWindowTitle(target.origin, title));
    });
    window.webContents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      void dialog.showMessageBox(window, {
        type: "warning",
        message: t("remoteFailed", { host: new URL(target.origin).host }),
        detail: `${description} (${code})`,
        buttons: [t("ok")],
      });
    });
    window.on("closed", () => {
      remoteOrigins.delete(id);
      if (remoteWindows.get(target.origin) === window) remoteWindows.delete(target.origin);
      notifyRemoteChanged();
    });
    void window.loadURL(target.url).catch(() => undefined);
    notifyRemoteChanged();
  }

  /** 忘掉一个服务器：关窗口、删列表、清掉这个地址下的访客凭证 */
  async function removeRemote(origin: string): Promise<void> {
    const window = remoteWindows.get(origin);
    if (window && !window.isDestroyed()) window.close();
    remoteServers = remoteServers.filter((server) => server.origin !== origin);
    saveRemoteServers(remoteFile(), remoteServers);
    await session
      .fromPartition(REMOTE_PARTITION)
      .clearStorageData({ origin })
      .catch(() => undefined);
    notifyRemoteChanged();
  }

  /** 让本机页面弹出「加入别人的房间」或「带 Agent 加入」 */
  function sendJoinRequest(request: JoinRequest): void {
    showMainWindow();
    const contents = mainWindow?.webContents;
    if (!mainPageReady || !contents || contents.isDestroyed()) {
      pendingJoin = request;
      return;
    }
    contents.send(IPC.joinRequest, request);
  }

  /** 深链接来自浏览器或别的程序，先让人看清真实的服务器和房间再打开；取消什么都不做 */
  async function confirmRemote(target: { origin: string; url: string }): Promise<void> {
    if (allowedOrigin && target.origin === allowedOrigin) {
      openRemote(target);
      return;
    }
    const info = describeRoomLink(target);
    const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
    if (parent) showMainWindow();
    const options = {
      type: "question" as const,
      title: t("joinConfirmTitle"),
      message: t("joinConfirmMessage", {
        host: info.host,
        room: info.roomId ? `# ${info.roomId}` : t("joinConfirmAnyRoom"),
      }),
      detail: t("joinConfirmDetail", {
        origin: info.origin,
        identity: info.hasInvite ? t("joinConfirmGuest") : t("joinConfirmReturning"),
      }),
      buttons: [t("joinConfirm"), t("cancel")],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    };
    const { response } = parent
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options);
    if (response === 0) openRemote(target);
  }

  let appStarted = false;
  const queuedLinks: string[] = [];
  function handleDeepLink(raw: string): void {
    if (!appStarted) {
      queuedLinks.push(raw);
      return;
    }
    const link = parseDeepLink(raw);
    if (!link) return;
    if (link.kind === "open") void confirmRemote(link);
    else {
      sendJoinRequest({
        kind: "agent",
        server: link.server,
        roomId: link.roomId,
        name: link.name,
        token: link.token,
      });
    }
  }
  // macOS 从浏览器点 superhive:// 链接走 open-url；要在 ready 之前就挂上
  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });

  ipcMain.handle(IPC.remoteList, (event) => {
    if (!trusted(event)) throw new Error("Forbidden");
    return remoteViews();
  });
  ipcMain.handle(IPC.remoteOpen, (event, input: unknown) => {
    if (!trusted(event)) throw new Error("Forbidden");
    const target = typeof input === "string" ? normalizeRemoteUrl(input) : undefined;
    if (!target) return false;
    openRemote(target);
    return true;
  });
  ipcMain.handle(IPC.remoteRemove, async (event, origin: unknown) => {
    if (!trusted(event)) throw new Error("Forbidden");
    if (typeof origin !== "string" || !remoteServers.some((server) => server.origin === origin))
      return false;
    await removeRemote(origin);
    return true;
  });

  // ---------- 窗口 ----------
  const windowStateFile = () => path.join(app.getPath("userData"), "window-state.json");
  const backgroundColor = () => SPLASH_BACKGROUND[prefersDark() ? "dark" : "light"];
  const variant = splashVariant(process.env);
  const logFile = () => path.join(dataDir, "server.log");

  // ---------- 启动加载画面 ----------
  /** 把加载层铺满窗口内容区；窗口改大小、进出全屏时跟着变 */
  const fitSplash = () => {
    if (!splash || !mainWindow || mainWindow.isDestroyed()) return;
    const [width = 0, height = 0] = mainWindow.getContentSize();
    splash.view.setBounds({ x: 0, y: 0, width, height });
  };

  function renderSplash(model: Parameters<typeof splashUpdateScript>[0]): void {
    const contents = splash?.view.webContents;
    if (contents && !contents.isDestroyed())
      void contents.executeJavaScript(splashUpdateScript(model)).catch(() => undefined);
  }

  function removeSplash(): void {
    clearTimeout(readyFallback);
    const current = splash;
    splash = undefined;
    if (!current) return;
    current.controller.dispose();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.contentView.removeChildView(current.view);
      mainWindow.off("resize", fitSplash);
      // 加载层拿掉后焦点交还网页，键盘直接能用
      mainWindow.webContents.focus();
    }
    if (!current.view.webContents.isDestroyed()) current.view.webContents.close();
  }

  /** 在主窗口上盖一层加载动画（已经盖着就从头再来）。窗口要等这一层画出第一帧再显示，不闪白 */
  function showSplash(window: BrowserWindow, phase: SplashPhase): void {
    if (splash) {
      splash.controller.restart(phase);
      renderSplash(splash.controller.model());
      return;
    }
    const view = new WebContentsView({ webPreferences: { ...popupPreferences } });
    // 退场时页面底色渐变成透明，露出下面已经画好的主界面
    view.setBackgroundColor("#00000000");
    const controller = new SplashController({
      lang,
      render: renderSplash,
      done: removeSplash,
    });
    controller.restart(phase);
    splash = { view, controller };
    window.contentView.addChildView(view);
    fitSplash();
    window.on("resize", fitSplash);
    // 按钮经改标题告诉主进程：页面本身没有任何 IPC 能力
    view.webContents.on("page-title-updated", (event, title) => {
      event.preventDefault();
      const action = parseSplashAction(title);
      if (action === "retry") void boot();
      else if (action === "logs") void shell.openPath(dataDir);
      else if (action === "quit") app.quit();
    });
    view.webContents.once("did-finish-load", () => {
      // 载入期间状态可能已经变了（比如很快就出错）：按当前状态再画一次
      if (splash?.view === view) renderSplash(controller.model());
      if (!window.isDestroyed() && !window.isVisible()) window.show();
    });
    const html = splashHtml({ lang, theme: splashTheme, variant, initial: controller.model() });
    void view.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  }

  function failSplash(window: BrowserWindow, detail: string): void {
    if (!splash) showSplash(window, "starting");
    splash!.controller.fail(detail, text(lang, "splashLog", { log: logFile() }));
    if (!window.isVisible()) window.show();
  }

  /** 主窗口：一打开就按上次的位置大小显示加载动画，本机 Hive 好了再在下面加载网页 */
  function createMainWindow(): BrowserWindow {
    const saved = loadWindowState(windowStateFile());
    const bounds = restoreBounds(
      saved,
      screen.getAllDisplays().map((display) => display.workArea),
    );
    const window = new BrowserWindow({
      ...(bounds.x !== undefined && bounds.y !== undefined ? { x: bounds.x, y: bounds.y } : {}),
      width: bounds.width ?? 1280,
      height: bounds.height ?? 820,
      minWidth: MIN_SIZE.width,
      minHeight: MIN_SIZE.height,
      show: false,
      title: "SuperHive",
      backgroundColor: backgroundColor(),
      ...titlebarWindowOptions(titlebar, currentAppearance()),
      webPreferences: {
        preload: path.join(appRoot, "preload.cjs"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        webviewTag: false,
        spellcheck: false,
        additionalArguments: [`${TITLEBAR_ARG_PREFIX}${titlebar}`],
      },
    });
    if (bounds.maximized) window.maximize();
    const contentsId = window.webContents.id;
    trustedIds.add(contentsId);

    let saveTimer: NodeJS.Timeout | undefined;
    const persist = () => {
      if (window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return;
      const normal = window.getNormalBounds();
      saveWindowState(windowStateFile(), { ...normal, maximized: window.isMaximized() });
    };
    const schedulePersist = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(persist, 400);
    };
    window.on("resize", schedulePersist);
    window.on("move", schedulePersist);
    window.on("maximize", schedulePersist);
    window.on("unmaximize", schedulePersist);

    // 全屏时 macOS 的红黄绿按钮会藏起来，网页把给它们让出的位置收回；刷新后也要重新告诉页面
    const sendFullscreen = () => {
      if (!window.isDestroyed())
        window.webContents.send(IPC.windowFullscreen, window.isFullScreen());
    };
    window.on("enter-full-screen", sendFullscreen);
    window.on("leave-full-screen", sendFullscreen);
    window.webContents.on("dom-ready", sendFullscreen);
    // Windows / Linux：失焦时按钮图标变淡，和系统其他窗口一致
    if (titlebar === "overlay") {
      window.on("focus", () => applyAppearance(window));
      window.on("blur", () => applyAppearance(window));
    }

    // 刷新或渲染进程崩溃：终端先留着，新页面在宽限期内接回去（回放最近的输出），没接回的才结束；
    // 窗口销毁时全部结束
    window.webContents.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) {
        terminals.detachOwner(contentsId);
        mainPageReady = false;
      }
    });
    window.webContents.on("render-process-gone", () => terminals.detachOwner(contentsId));
    window.webContents.on("destroyed", () => {
      terminals.disposeOwner(contentsId);
      trustedIds.delete(contentsId);
    });

    window.on("close", (event) => {
      persist();
      // macOS 习惯：关窗口不退出，点 Dock 图标再打开
      if (process.platform === "darwin" && !quitting) {
        event.preventDefault();
        window.hide();
      }
    });
    // 网页载入完一般很快就会说「画好了」；老版本网页没有这个接口，等一会儿也收起加载画面
    window.webContents.on("did-finish-load", () => {
      clearTimeout(readyFallback);
      readyFallback = setTimeout(() => splash?.controller.ready(), READY_FALLBACK_MS);
    });
    window.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
      // -3 是被新的导航顶掉（比如重试时重新加载），不算出错
      if (!isMainFrame || code === -3 || !allowedOrigin || originOf(url) !== allowedOrigin) return;
      failSplash(window, text(lang, "pageFailed", { reason: `${description} (${code})` }));
    });
    window.webContents.on("render-process-gone", (_event, details) => {
      if (splash && !splash.controller.isFinished)
        failSplash(window, text(lang, "pageFailed", { reason: details.reason }));
    });
    return window;
  }

  function showMainWindow(): void {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }

  // ---------- 连接本机 Hive ----------
  const fork: ForkServer = (entry, env, cwd) =>
    new Promise((resolve, reject) => {
      const child = utilityProcess.fork(entry, [], {
        env,
        cwd,
        stdio: "pipe",
        serviceName: "SuperHive Server",
      });
      const onExit = (code: number) => reject(new Error(`Server exited (code ${code})`));
      child.once("exit", onExit);
      child.once("spawn", () => {
        child.removeListener("exit", onExit);
        resolve({
          pid: child.pid,
          kill: () => child.kill(),
          on: (_event, listener) => child.on("exit", listener),
          stdout: child.stdout,
          stderr: child.stderr,
        });
      });
    });

  // ---------- 局域网访问 ----------
  const lanFile = () => path.join(app.getPath("userData"), "lan-access.json");
  /** 存下来的选择；没存过时第一次起 Server 前按开启存下（resolveLanSetting） */
  let lanEnabled: boolean | undefined;
  let lanRestarting = false;
  /** 正在被换掉的 Server：它退出不算「Server 停了」 */
  let replacing: OwnedServer | undefined;
  const lanState = (): LanAccessState => ({
    enabled: lanEnabled === true,
    managed: owned !== undefined || lanRestarting,
    restarting: lanRestarting,
  });
  function pushLan(): void {
    const contents = mainWindow?.webContents;
    if (contents && !contents.isDestroyed()) contents.send(IPC.lanChanged, lanState());
  }

  async function launchOwned(port: number): Promise<OwnedServer> {
    const server = await startServer({
      fork,
      serverEntry: path.join(superhiveRoot, "dist", "server", "index.js"),
      staticDir: path.join(superhiveRoot, "web"),
      dataDir,
      port,
      host: hostFor(lanEnabled === true),
      env: {
        ...process.env,
        ...bundledRuntimeEnv(
          bundledRuntime({
            isPackaged: app.isPackaged,
            resourcesPath: process.resourcesPath,
            appRoot,
            userData: app.getPath("userData"),
            platform: process.platform,
          }),
          process.env,
          process.platform,
        ),
      },
      agentCli: agentCliCommand(),
      launcher: `SuperHive Desktop ${app.getVersion()}`,
      home: homedir(),
    });
    owned = server;
    void server.exited.then((code) => {
      if (owned === server) owned = undefined;
      if (quitting || replacing === server) return;
      // 被 hive stop 停掉或者崩溃：在窗口上盖出错画面，可以重试
      handleServerGone(code);
    });
    return server;
  }

  /**
   * 换监听地址：交接方式重启（本机 Agent 和正在跑的任务不断），端口不变，网页地址也不变，
   * 页面自己重连。起不来时盖出错画面，可以重试。
   */
  async function relaunchOwned(): Promise<void> {
    const server = owned;
    if (!server) return;
    lanRestarting = true;
    replacing = server;
    pushLan();
    try {
      await server.stop({ handover: true });
      await launchOwned(Number(new URL(server.origin).port));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (mainWindow && !mainWindow.isDestroyed()) {
        failSplash(mainWindow, reason);
        showMainWindow();
      }
    } finally {
      replacing = undefined;
      lanRestarting = false;
      pushLan();
    }
  }

  async function connect(onPhase: (phase: SplashPhase) => void): Promise<string> {
    const found = await discover({ dataDir, preferredPort: PREFERRED_PORT });
    if (found.kind === "existing") {
      onPhase("connecting");
      console.log(`[superhive-desktop] ${t("connectedExisting", { origin: found.origin })}`);
      return found.origin;
    }
    onPhase("starting");
    lanEnabled ??= resolveLanSetting(lanFile());
    const server = await launchOwned(found.port);
    return server.origin;
  }

  function handleServerGone(code: number): void {
    if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createMainWindow();
    failSplash(mainWindow, t("serverStopped", { code: String(code) }));
    showMainWindow();
  }

  let booting = false;
  /** 起（或连上）本机 Hive，再在主窗口里加载网页；出错时停在加载画面上，点「重试」再来一遍 */
  async function boot(): Promise<void> {
    if (booting) return;
    booting = true;
    if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createMainWindow();
    const window = mainWindow;
    showSplash(window, "starting");
    try {
      const origin = await connect((phase) => splash?.controller.setPhase(phase));
      if (!isLoopbackOrigin(origin)) throw new Error(`Refusing non-loopback origin ${origin}`);
      if (window.isDestroyed()) return;
      allowedOrigin = origin;
      splash?.controller.setPhase("loading");
      buildMenu();
      // 网页在加载层下面载入；preload 载入时向主进程要地址，换了地址也不用重建窗口
      void window.loadURL(origin).catch(() => undefined);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (!window.isDestroyed()) failSplash(window, reason);
    } finally {
      booting = false;
    }
  }

  // ---------- 菜单 ----------
  function sendNewTerminal(): void {
    showMainWindow();
    const contents: WebContents | undefined = mainWindow?.webContents;
    if (contents && !contents.isDestroyed()) contents.send(IPC.terminalNewRequest);
  }

  function sendTerminalLayout(action: TerminalLayoutAction): void {
    showMainWindow();
    const contents: WebContents | undefined = mainWindow?.webContents;
    if (contents && !contents.isDestroyed()) contents.send(IPC.terminalLayoutRequest, action);
  }

  function buildMenu(): void {
    const isMac = process.platform === "darwin";
    const template: MenuItemConstructorOptions[] = [
      ...(isMac
        ? [
            {
              label: app.name,
              submenu: [
                { role: "about" as const },
                ...(updateCheckEnabled
                  ? [{ label: t("checkForUpdates"), click: () => void checkUpdatesNow() }]
                  : []),
                { type: "separator" as const },
                { role: "services" as const },
                { type: "separator" as const },
                { role: "hide" as const },
                { role: "hideOthers" as const },
                { role: "unhide" as const },
                { type: "separator" as const },
                { role: "quit" as const },
              ],
            },
          ]
        : []),
      {
        label: t("file"),
        submenu: [
          { label: t("newTerminal"), accelerator: "Ctrl+`", click: sendNewTerminal },
          {
            label: t("joinRemote"),
            accelerator: "CmdOrCtrl+Shift+J",
            click: () => sendJoinRequest({ kind: "room" }),
          },
          ...(remoteServers.length
            ? [
                {
                  label: t("remoteServers"),
                  submenu: remoteServers.map((server) => ({
                    label: new URL(server.origin).host,
                    click: () => openRemote(server),
                  })),
                },
              ]
            : []),
          {
            label: t("openInBrowser"),
            enabled: Boolean(allowedOrigin),
            click: () => allowedOrigin && void shell.openExternal(allowedOrigin),
          },
          { type: "separator" },
          isMac ? { role: "close" } : { role: "quit" },
        ],
      },
      { role: "editMenu", label: t("edit") },
      {
        label: t("view"),
        submenu: [
          { role: "reload" },
          { role: "forceReload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          {
            id: "terminal-maximize",
            label: t("toggleTerminalMaximized"),
            accelerator: "CmdOrCtrl+Shift+M",
            click: () => sendTerminalLayout("maximize"),
          },
          {
            id: "terminal-position",
            label: t("toggleTerminalPosition"),
            accelerator: "CmdOrCtrl+Alt+P",
            click: () => sendTerminalLayout("position"),
          },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      { role: "windowMenu", label: t("window") },
      {
        role: "help",
        label: t("help"),
        submenu: [
          {
            label: t("docs"),
            click: () => void shell.openExternal(lang === "zh" ? DOCS_URL : `${DOCS_URL}en/`),
          },
          { label: t("issues"), click: () => void shell.openExternal(ISSUES_URL) },
          { label: t("openLogs"), click: () => void shell.openPath(dataDir) },
          ...(!isMac && updateCheckEnabled
            ? [
                { type: "separator" as const },
                { label: t("checkForUpdates"), click: () => void checkUpdatesNow() },
              ]
            : []),
        ],
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  // ---------- 生命周期 ----------
  app.on("second-instance", (_event, argv) => {
    const link = deepLinkFromArgv(argv);
    if (link) handleDeepLink(link);
    else showMainWindow();
  });
  app.on("activate", () => showMainWindow());
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", (event) => {
    quitting = true;
    if (shutdownDone) return;
    event.preventDefault();
    shutdownDone = true;
    // 新版已经准备好：起替换脚本（Mac），等这个进程退出后换上新版本
    installer?.onQuit();
    gate?.dispose();
    terminals.disposeAll();
    clearTimeout(updateTimer);
    const server = owned;
    owned = undefined;
    void (server ? server.stop().catch(() => undefined) : Promise.resolve()).finally(() =>
      app.quit(),
    );
  });

  void app.whenReady().then(async () => {
    lang = langFor(app.getLocale());
    splashTheme = loadSplashTheme(splashThemeFile());
    app.setAboutPanelOptions({
      applicationName: "SuperHive",
      applicationVersion: app.getVersion(),
      website: DOCS_URL,
    });
    session.defaultSession.setPermissionRequestHandler(
      (contents, permission, callback, details) => {
        callback(permissionOk(permission, details.requestingUrl ?? contents.getURL()));
      },
    );
    session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
      permissionOk(permission, requestingOrigin),
    );
    remoteServers = loadRemoteServers(remoteFile());
    const remoteSession = session.fromPartition(REMOTE_PARTITION);
    remoteSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      callback(remotePermissionOk(permission, details.requestingUrl ?? contents.getURL()));
    });
    remoteSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
      remotePermissionOk(permission, requestingOrigin),
    );
    // 只有装好的正式包才注册 superhive://：开发时跑的 Electron 不能抢走已安装客户端的链接
    if (app.isPackaged && !process.env.SUPERHIVE_DESKTOP_DATA_DIR) {
      app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
    }
    buildMenu();
    // 从访达 / Dock 打开时 PATH 不全、也没有终端里设的代理变量，本机 Agent 和终端都要用到
    const shellEnv = await loginShellEnv();
    if (shellEnv?.PATH) process.env.PATH = mergePath(shellEnv.PATH, process.env.PATH);
    mergeProxyEnv(process.env, shellEnv);
    await boot();
    appStarted = true;
    // 冷启动时带进来的深链接：macOS 在 open-url 里排队，Windows / Linux 在命令行参数里
    const initial = deepLinkFromArgv(process.argv);
    if (initial) queuedLinks.push(initial);
    for (const link of queuedLinks.splice(0)) handleDeepLink(link);
    if (updateCheckEnabled) {
      // 清掉上次下载了但没换上的临时文件（Mac 暂存在 .app 旁边的目录）
      updateInstaller().cleanup();
      scheduleUpdateCheck(UPDATE_FIRST_CHECK_DELAY_MS);
    }
  });
}
