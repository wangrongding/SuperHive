/**
 * 应用内更新：用户在「有新版本」弹窗里点「下载并更新」后，在后台下载、校验、准备好新版本，
 * 然后提示「重启以更新」。不点也行，下次退出时生效。任何一步失败都只是退回「打开下载页」，
 * 当前已安装的版本不受影响。
 *
 * 这里只管状态和流程，平台相关的事交给 InstallBackend：
 * - Windows：Electron autoUpdater（Squirrel.Windows），见 win-update.ts；
 * - Mac：自己下载 zip、校验 sha256、解压核对后暂存，退出时由独立脚本替换 .app，见 mac-update.ts。
 */
import type { RestartWait } from "./ipc-contract.js";
import type { InstallPackage, UpdateInfo } from "./update-check.js";

/** 不能直接更新 / 更新失败的原因，网页按它显示说明（不带任何路径和地址） */
export type InstallFailure =
  /** Release 里没有本平台的更新包（比如老版本没传 zip / nupkg） */
  | "no-package"
  /** 开发版、不是装出来的（Windows 没有 Update.exe，Mac 不在 .app 里） */
  | "not-installed"
  /** Mac 从「下载」里直接打开，系统把它放在只读的临时位置（App Translocation） */
  | "translocated"
  /** 在只读的磁盘或 dmg 里运行 */
  | "read-only"
  /** 所在目录没有写权限 */
  | "not-writable"
  /** 下载失败、断网 */
  | "network"
  /** 下载的文件 sha256 或大小对不上 */
  | "checksum"
  /** 压缩包里不是我们的应用，或版本号对不上 */
  | "bad-package"
  | "unknown";

export const INSTALL_FAILURES: readonly InstallFailure[] = [
  "no-package",
  "not-installed",
  "translocated",
  "read-only",
  "not-writable",
  "network",
  "checksum",
  "bad-package",
  "unknown",
];

export class InstallError extends Error {
  constructor(
    readonly reason: InstallFailure,
    message: string = reason,
  ) {
    super(message);
  }
}

export type InstallState =
  | { phase: "idle" }
  /** total 为 0 表示不知道总大小（Windows 的 Squirrel 不报进度） */
  | { phase: "downloading"; received: number; total: number }
  | { phase: "verifying" }
  | { phase: "ready" }
  | { phase: "failed"; reason: InstallFailure };

/** 交给网页的安装状态 */
export type InstallView = {
  /** 能不能在应用里直接更新；不能时 reason 说明原因，网页只给「下载」 */
  available: boolean;
  reason?: InstallFailure;
  /** 要下载多大（字节） */
  size: number;
  state: InstallState;
  /** 已下载好、点了「重启以更新」但有 Agent 在执行任务：在等它们做完（见 restart-gate.ts） */
  restart?: RestartWait;
};

/** 交给网页的完整新版信息 */
export type DesktopUpdate = UpdateInfo & { install: InstallView };

export type InstallProgress = (received: number, total: number) => void;

export interface InstallBackend {
  /** 当前安装位置能不能直接更新；能返回 undefined */
  unavailableReason(): InstallFailure | undefined;
  /** 下载并准备好新版本；失败抛 InstallError（别的异常按 unknown 处理） */
  prepare(
    pkg: InstallPackage,
    hooks: { progress: InstallProgress; verifying: () => void },
  ): Promise<void>;
  /** 准备好后用户点「重启以更新」 */
  restartNow(): void;
  /** 准备好了但没点重启，应用正常退出时让更新生效 */
  applyOnQuit(): void;
  /** 应用启动时清掉上次没用上的临时文件 */
  cleanup?(): void;
}

export type UpdateInstallerOptions = {
  backend: InstallBackend | undefined;
  /** 状态变了（进度至多每 throttleMs 一次） */
  onChange: () => void;
  now?: () => number;
  throttleMs?: number;
};

export class UpdateInstaller {
  private state: InstallState = { phase: "idle" };
  /** 当前状态对应的版本：查到更新的版本以后，旧版本的状态作废 */
  private version: string | undefined;
  private lastProgressAt = 0;
  private readonly now: () => number;

  constructor(private readonly options: UpdateInstallerOptions) {
    this.now = options.now ?? Date.now;
  }

  get phase(): InstallState["phase"] {
    return this.state.phase;
  }

  /** 网页看到的状态；pkg 是检查器给出的当前新版的包（没有就是 Release 里缺文件） */
  view(version: string, pkg: InstallPackage | undefined): InstallView {
    const backend = this.options.backend;
    const state = this.version === version ? this.state : { phase: "idle" as const };
    const reason = !backend
      ? "not-installed"
      : !pkg
        ? "no-package"
        : (backend.unavailableReason() ?? undefined);
    // 已经在下或已经准备好了，就算位置后来出了问题也照实显示
    if (reason && state.phase === "idle") {
      return { available: false, reason, size: pkg?.size ?? 0, state };
    }
    return { available: !reason, size: pkg?.size ?? 0, state };
  }

  /** 「下载并更新」：只在空闲或上次失败时开始；正在下 / 已就绪时什么都不做 */
  start(pkg: InstallPackage | undefined): boolean {
    const backend = this.options.backend;
    if (!backend || !pkg) return false;
    if (this.version === pkg.version && ["downloading", "verifying", "ready"].includes(this.phase))
      return false;
    if (this.version !== pkg.version && this.busy()) return false;
    if (backend.unavailableReason()) return false;
    this.version = pkg.version;
    // Squirrel 不报进度：总大小记 0，网页显示「正在后台下载」
    this.set({ phase: "downloading", received: 0, total: pkg.kind === "mac-zip" ? pkg.size : 0 });
    void backend
      .prepare(pkg, {
        progress: (received, total) => {
          if (this.version !== pkg.version || this.state.phase !== "downloading") return;
          const now = this.now();
          const done = total > 0 && received >= total;
          this.state = { phase: "downloading", received, total };
          if (!done && now - this.lastProgressAt < (this.options.throttleMs ?? 250)) return;
          this.lastProgressAt = now;
          this.options.onChange();
        },
        verifying: () => {
          if (this.version === pkg.version) this.set({ phase: "verifying" });
        },
      })
      .then(
        () => {
          if (this.version === pkg.version) this.set({ phase: "ready" });
        },
        (error: unknown) => {
          if (this.version !== pkg.version) return;
          const reason = error instanceof InstallError ? error.reason : "unknown";
          this.set({ phase: "failed", reason });
        },
      );
    return true;
  }

  /** 「重启以更新」 */
  restart(): boolean {
    if (this.phase !== "ready" || !this.options.backend) return false;
    this.options.backend.restartNow();
    return true;
  }

  /** 应用退出时调：准备好了就让更新在这次退出后生效 */
  onQuit(): void {
    if (this.phase === "ready") this.options.backend?.applyOnQuit();
  }

  /** 启动时调：清掉上次没换上的临时文件 */
  cleanup(): void {
    if (this.phase !== "idle") return;
    try {
      this.options.backend?.cleanup?.();
    } catch {
      /* 清不掉不影响使用 */
    }
  }

  private busy(): boolean {
    return this.phase === "downloading" || this.phase === "verifying";
  }

  private set(state: InstallState): void {
    this.state = state;
    this.options.onChange();
  }
}
