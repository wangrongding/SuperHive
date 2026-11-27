/**
 * 「重启以更新」前先看本机 Agent 有没有在执行任务：桌面端退出时会停掉自己起的 Hive Server，
 * 正在执行的任务会被打断。口径和网页版（npm）更新一致（packages/superhive 的 web-update.ts、
 * restart-handover.ts 的 readLocalAgents / waitForIdle）：
 * - 忙闲看 Server 的 /api/local/agents 里每个 Agent 的 busy：在运行、并且在任一房间有排队、执行中、
 *   停止中的调用（提问后本轮没结束也算），和 hive update 直接读数据库是同一条查询；
 * - 有在忙的：人选「等任务做完再重启（推荐）」或「立即重启，中断正在执行的任务」；
 * - 等待时每 2 秒查一次，查不到当作还在忙；全部空闲就重启；最多等 30 分钟，到时间停下来等人再决定，
 *   不自己硬重启。等待期间可以取消；不重启的话照旧在下次退出时换上新版本。
 */
import type { RestartChoice, RestartResult, RestartWait } from "./ipc-contract.js";

/** 和网页版更新等 Agent 做完的上限一致（web-update.ts 的 waitForIdle timeoutMs） */
export const RESTART_WAIT_TIMEOUT_MS = 30 * 60_000;
/** 和 waitForIdle 的默认间隔一致 */
export const RESTART_WAIT_INTERVAL_MS = 2_000;

/** /api/local/agents 的返回里挑出正在执行任务的 Agent 名字；形状不对返回 undefined（不知道） */
export function busyAgentNames(body: unknown): string[] | undefined {
  const agents = (body as { agents?: unknown } | null | undefined)?.agents;
  if (!Array.isArray(agents)) return undefined;
  return agents.flatMap((agent: unknown) => {
    const value = agent as { name?: unknown; busy?: unknown } | null;
    return value && value.busy === true && typeof value.name === "string" ? [value.name] : [];
  });
}

export type RestartGateOptions = {
  /** 新版本已经准备好，可以重启 */
  ready: () => boolean;
  /** 真正重启（Mac 起替换脚本后退出，Windows 交给 Squirrel）；没能重启返回 false */
  restart: () => boolean;
  /** 正在执行任务的本机 Agent；查不到返回 undefined */
  busyAgents: () => Promise<string[] | undefined>;
  /** 等待状态变了：把新的状态推给网页 */
  onChange: () => void;
  timeoutMs?: number;
  intervalMs?: number;
  now?: () => number;
};

export class RestartGate {
  private wait: RestartWait | undefined;
  private deadline = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** 每次开始等、取消、重启都换一代：还在路上的查询回来时发现换代了就丢掉 */
  private generation = 0;
  private readonly now: () => number;

  constructor(private readonly options: RestartGateOptions) {
    this.now = options.now ?? Date.now;
  }

  /** 网页看到的等待状态；新版本不在准备好的状态时没有 */
  view(): RestartWait | undefined {
    if (!this.wait || !this.options.ready()) return undefined;
    return { phase: this.wait.phase, agents: [...this.wait.agents] };
  }

  async request(choice: RestartChoice): Promise<RestartResult> {
    if (!this.options.ready()) {
      this.stop();
      return { status: "unavailable" };
    }
    if (choice === "now") return this.restartNow();
    // 已经在等了：再点「重启以更新」或「等任务做完」都接着等
    const waiting = this.waitingResult();
    if (waiting) return waiting;
    const generation = ++this.generation;
    const busy = await this.readBusy();
    // 查的时候被取消、立即重启或另一次请求抢先了：以那边为准
    if (generation !== this.generation) return this.waitingResult() ?? { status: "unavailable" };
    if (!this.options.ready()) {
      this.stop();
      return { status: "unavailable" };
    }
    if (choice === "check") {
      // 查不到（本机 Hive 没回话）就照旧直接重启：退出时也没有能打断的任务
      if (!busy?.length) return this.restartNow();
      return { status: "busy", agents: busy };
    }
    if (busy && busy.length === 0) return this.restartNow();
    // 查不到当作还在忙（和 waitForIdle 一样），名单等下一次查到再补上
    const agents = busy ?? (this.wait ? this.wait.agents : []);
    this.wait = { phase: "waiting", agents };
    this.deadline = this.now() + (this.options.timeoutMs ?? RESTART_WAIT_TIMEOUT_MS);
    this.schedule(generation);
    this.options.onChange();
    return { status: "waiting", agents: [...agents] };
  }

  /** 取消等待（含超时后「以后再说」）：回到「已下载好」，下次退出时照旧换上新版本 */
  cancel(): boolean {
    if (!this.wait) return false;
    this.stop();
    this.options.onChange();
    return true;
  }

  /** 应用退出时调：停掉还在跑的定时查询 */
  dispose(): void {
    this.generation += 1;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private waitingResult(): RestartResult | undefined {
    const wait = this.wait;
    return wait?.phase === "waiting" ? { status: "waiting", agents: [...wait.agents] } : undefined;
  }

  private restartNow(): RestartResult {
    const changed = Boolean(this.wait);
    this.stop();
    const ok = this.options.restart();
    if (changed) this.options.onChange();
    return ok ? { status: "restarting" } : { status: "unavailable" };
  }

  private stop(): void {
    this.dispose();
    this.wait = undefined;
  }

  private schedule(generation: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => void this.poll(generation),
      this.options.intervalMs ?? RESTART_WAIT_INTERVAL_MS,
    );
  }

  private async poll(generation: number): Promise<void> {
    const busy = await this.readBusy();
    const wait = this.wait;
    if (generation !== this.generation || wait?.phase !== "waiting") return;
    // 新版本作废了（又查到更新的版本等）：不再替它重启
    if (!this.options.ready()) {
      this.stop();
      this.options.onChange();
      return;
    }
    if (busy && busy.length === 0) {
      this.restartNow();
      return;
    }
    const agents = busy ?? wait.agents;
    if (this.now() >= this.deadline) {
      this.wait = { phase: "timeout", agents };
      this.timer = undefined;
      this.options.onChange();
      return;
    }
    if (agents.join("\n") !== wait.agents.join("\n")) {
      this.wait = { phase: "waiting", agents };
      this.options.onChange();
    }
    this.schedule(generation);
  }

  private async readBusy(): Promise<string[] | undefined> {
    try {
      return await this.options.busyAgents();
    } catch {
      return undefined;
    }
  }
}
