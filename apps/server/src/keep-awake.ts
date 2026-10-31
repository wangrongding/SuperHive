import { spawn, execFile, type ChildProcess } from "node:child_process";
import {
  keepAwakeSettingsSchema,
  type KeepAwakeSettings,
  type KeepAwakeState,
} from "@ai-hive/protocol";

export const DEFAULT_KEEP_AWAKE: KeepAwakeSettings = {
  whenIm: true,
  whenTasks: false,
  onBattery: false,
};

/** 需要保持在线的理由：由 Server 按当前状态算出 */
export type KeepAwakeDemand = { imConnections: number; runningTasks: number };

export type KeepAwakeDeps = {
  platform?: NodeJS.Platform;
  loadSettings(): KeepAwakeSettings | undefined;
  saveSettings(settings: KeepAwakeSettings): void;
  demand(): KeepAwakeDemand;
  onChange?(state: KeepAwakeState): void;
  log?(message: string, detail?: unknown): void;
  /** 测试替身：读电源、起断言进程 */
  readPower?(): Promise<"ac" | "battery" | "unknown">;
  spawnAssertion?(pid: number): ChildProcess;
  now?(): number;
  /** 定时复查间隔；也用来发现「睡眠醒来」 */
  tickMs?: number;
};

const RETRY_MS = [5_000, 30_000, 120_000];

/** macOS：pmset -g batt 第一行写着当前电源 */
async function readMacPower(): Promise<"ac" | "battery" | "unknown"> {
  return new Promise((resolve) => {
    execFile("/usr/bin/pmset", ["-g", "batt"], { timeout: 5_000 }, (error, stdout) => {
      if (error) return resolve("unknown");
      if (stdout.includes("'AC Power'")) return resolve("ac");
      if (stdout.includes("'Battery Power'")) return resolve("battery");
      resolve("unknown");
    });
  });
}

/**
 * 熄屏后保持在线：需要时用系统自带的 caffeinate -i 阻止空闲睡眠（屏幕照常熄灭），不需要时释放。
 * - 最多一个子进程；-w 绑定 Server 进程，Server 被强杀时系统也会自动释放，不留孤儿断言。
 * - 只结束自己起的进程，不碰别的程序的 caffeinate。
 * - 断言进程意外退出：标为失败并退避重试，界面如实显示，不凭开关状态假装生效。
 * - 合盖、手动睡眠、系统强制睡眠拦不住；用电池时默认释放。
 */
export class KeepAwake {
  private settings: KeepAwakeSettings;
  private child: ChildProcess | undefined;
  private power: "ac" | "battery" | "unknown" = "unknown";
  private failure: string | undefined;
  private failures = 0;
  private retryTimer: NodeJS.Timeout | undefined;
  private tickTimer: NodeJS.Timeout | undefined;
  private lastTick = 0;
  private since: string | undefined;
  private lastWakeAt: string | undefined;
  private lastState: string | undefined;
  private closed = false;
  private readonly platform: NodeJS.Platform;

  constructor(private readonly deps: KeepAwakeDeps) {
    this.platform = deps.platform ?? process.platform;
    this.settings = { ...DEFAULT_KEEP_AWAKE, ...(deps.loadSettings() ?? {}) };
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  get supported(): boolean {
    return this.platform === "darwin";
  }

  async start(): Promise<void> {
    if (!this.supported) {
      this.emit();
      return;
    }
    await this.refreshPower();
    this.evaluate();
    const tickMs = this.deps.tickMs ?? 60_000;
    this.lastTick = this.now();
    this.tickTimer = setInterval(() => {
      const now = this.now();
      // 两次复查之间隔了远超间隔的时间：机器刚从睡眠里醒来
      if (now - this.lastTick > tickMs * 3) {
        this.lastWakeAt = new Date(now).toISOString();
        this.deps.log?.("keep-awake: 检测到系统睡眠后醒来");
      }
      this.lastTick = now;
      void this.refreshPower().then(() => this.evaluate());
    }, tickMs);
    this.tickTimer.unref?.();
  }

  private async refreshPower(): Promise<void> {
    this.power = await (this.deps.readPower ?? readMacPower)();
  }

  update(patch: Partial<KeepAwakeSettings>): KeepAwakeState {
    this.settings = keepAwakeSettingsSchema.parse({ ...this.settings, ...patch });
    this.deps.saveSettings(this.settings);
    this.failures = 0;
    this.failure = undefined;
    this.evaluate();
    return this.state();
  }

  /** 条件可能变了（IM 连接、任务、电源、设置）：幂等地申请或释放 */
  evaluate(): void {
    if (this.closed || !this.supported) return;
    const want = this.wanted();
    if (want && !this.child && !this.retryTimer) this.acquire();
    if (!want) this.release();
    this.emit();
  }

  private wanted(): boolean {
    const { reasons } = this.reasons();
    if (!reasons.length) return false;
    if (this.power === "battery" && !this.settings.onBattery) return false;
    return true;
  }

  private reasons(): { reasons: string[] } {
    const demand = this.deps.demand();
    const reasons: string[] = [];
    if (this.settings.whenIm && demand.imConnections > 0) {
      reasons.push(`有 ${demand.imConnections} 个 IM 连接在线`);
    }
    if (this.settings.whenTasks && demand.runningTasks > 0) {
      reasons.push(`有 ${demand.runningTasks} 个 Agent 任务在跑`);
    }
    return { reasons };
  }

  private acquire(): void {
    try {
      const child = (this.deps.spawnAssertion ?? spawnCaffeinate)(process.pid);
      this.child = child;
      this.since = new Date(this.now()).toISOString();
      child.once("error", (error) => this.lost(child, error.message));
      child.once("exit", (code, signal) =>
        this.lost(child, `caffeinate 退出（${signal ?? code}）`),
      );
    } catch (error) {
      this.lost(undefined, error instanceof Error ? error.message : String(error));
    }
  }

  /** 断言进程没了：是我们主动释放的就算了，意外退出就标失败、退避后再试 */
  private lost(child: ChildProcess | undefined, reason: string): void {
    if (child && this.child !== child) return;
    this.child = undefined;
    this.since = undefined;
    if (this.closed) return;
    this.failure = reason;
    this.deps.log?.("keep-awake: 阻止睡眠的进程意外退出", reason);
    const delay = RETRY_MS[Math.min(this.failures, RETRY_MS.length - 1)]!;
    this.failures += 1;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.evaluate();
    }, delay);
    this.retryTimer.unref?.();
    this.emit();
  }

  private release(): void {
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const child = this.child;
    this.child = undefined;
    this.since = undefined;
    this.failure = undefined;
    this.failures = 0;
    if (child && child.exitCode === null) child.kill("SIGTERM");
  }

  state(): KeepAwakeState {
    const { reasons } = this.supported ? this.reasons() : { reasons: [] };
    const status: KeepAwakeState["status"] = !this.supported
      ? "unsupported"
      : !this.settings.whenIm && !this.settings.whenTasks
        ? "disabled"
        : this.child
          ? "active"
          : this.failure
            ? "failed"
            : reasons.length && this.power === "battery" && !this.settings.onBattery
              ? "battery"
              : "idle";
    return {
      ...this.settings,
      supported: this.supported,
      status,
      power: this.power,
      reasons,
      ...(this.failure && status === "failed" ? { detail: this.failure } : {}),
      ...(this.since && status === "active" ? { since: this.since } : {}),
      ...(this.lastWakeAt ? { lastWakeAt: this.lastWakeAt } : {}),
    };
  }

  private emit(): void {
    const state = this.state();
    const key = JSON.stringify({ ...state, since: undefined });
    if (key === this.lastState) return;
    this.lastState = key;
    this.deps.onChange?.(state);
  }

  close(): void {
    this.closed = true;
    clearInterval(this.tickTimer);
    this.release();
  }
}

/** -i 只阻止空闲睡眠（屏幕照常熄灭）；-w 绑定 Server 进程，Server 不在了断言自动解除 */
function spawnCaffeinate(pid: number): ChildProcess {
  return spawn("/usr/bin/caffeinate", ["-i", "-w", String(pid)], { stdio: "ignore" });
}
