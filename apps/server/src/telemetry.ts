/**
 * 匿名使用统计：网页、桌面端、CLI 的事件都汇总到这里，由 Server 批量上报（默认每小时一次，或攒够
 * batchSize 条），各端自己不往外发。CLI 直接往本机队列里追加（见 telemetry-core.ts），也由这里一起发。
 *
 * - 一律不报：设置里关了（或 hive telemetry off）、SUPERHIVE_TELEMETRY=0、DO_NOT_TRACK=1、CI、沙箱、测试。
 *   这时什么都不记，也不建文件。
 * - 上报地址默认为空（DEFAULT_TELEMETRY_ENDPOINT）：只在本机记录、可以预览，一条都不发。
 * - 发送失败就丢掉，不重试、不堆积；任何一步出错都只记日志，不影响别的功能。
 * - 开关存在 ~/.superhive/telemetry/state.json，CLI 改了以后这里按文件修改时间重新读。
 */
import type { TelemetryBlocker, TelemetryStatus } from "@superhive/protocol";
import {
  appendTelemetryEvents,
  dayOf,
  hourOf,
  readTelemetryQueue,
  readTelemetryState,
  resetTelemetryId,
  roomBucket,
  setTelemetryEnabled,
  takeTelemetryQueue,
  telemetryBlocker,
  telemetryContext,
  telemetryEndpoint,
  telemetryPayload,
  telemetryStateStamp,
  writeTelemetryState,
  type TelemetryEventName,
  type TelemetryFeature,
  type TelemetryLocale,
  type TelemetryRunMode,
  type TelemetryState,
} from "./telemetry-core.js";

export type TelemetrySnapshot = {
  /** 本机 Agent 按 CLI 类型分的数量 */
  agents: Record<string, number>;
  /** 没归档的房间数 */
  rooms: number;
};

export type TelemetryOptions = {
  /** 数据目录（~/.superhive/telemetry，见 telemetryDir） */
  dir: string;
  version: string;
  runMode: TelemetryRunMode;
  env?: NodeJS.ProcessEnv;
  sandbox?: boolean;
  now?: () => number;
  fetch?: typeof fetch;
  log?: (message: string, detail?: Record<string, unknown>) => void;
  /** 心跳要带的统计 */
  snapshot?: () => TelemetrySnapshot;
  /** 多久查一次心跳、发一次（默认 1 小时） */
  intervalMs?: number;
  /** 启动后多久做第一次（默认 1 分钟，别和启动抢资源） */
  startDelayMs?: number;
  /** 攒够这么多条就提前发 */
  batchSize?: number;
  /** 一次上报最多等多久 */
  timeoutMs?: number;
};

const HOUR_MS = 60 * 60_000;

export class Telemetry {
  readonly blocker: TelemetryBlocker | undefined;
  private readonly endpoint: string | undefined;
  private readonly now: () => number;
  private cached: { stamp: string | undefined; state: TelemetryState; stored: boolean } | undefined;
  private timers: Array<ReturnType<typeof setTimeout>> = [];
  private flushing: Promise<void> | undefined;
  /** 这次进程里已经确认记过「第一次用到」的功能：之后不再读文件 */
  private readonly used = new Set<TelemetryFeature>();
  private pendingIncidents: Record<string, number> = {};
  private incidentTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: TelemetryOptions) {
    const env = options.env ?? process.env;
    this.blocker = options.sandbox ? "sandbox" : telemetryBlocker(env);
    this.endpoint = telemetryEndpoint(env);
    this.now = options.now ?? Date.now;
  }

  /** 开始定时心跳和上报；状态文件还没有时（开着的情况下）顺带生成安装 ID */
  start(): void {
    if (this.active()) {
      this.state();
      this.options.log?.(
        this.endpoint
          ? "Anonymous usage statistics are on; turn them off in Settings or with `hive telemetry off`"
          : "Anonymous usage statistics are on, recorded locally only (no endpoint configured, nothing is sent)",
      );
    }
    const tick = () => {
      this.heartbeat();
      void this.flush();
    };
    const first = setTimeout(tick, this.options.startDelayMs ?? 60_000);
    const every = setInterval(tick, this.options.intervalMs ?? HOUR_MS);
    first.unref?.();
    every.unref?.();
    this.timers.push(first, every);
  }

  close(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    this.saveIncidents();
  }

  /** 读状态（文件改过才重新读）；开着且文件还没有时写一份，生成安装 ID */
  private state(): { state: TelemetryState; stored: boolean } {
    const stamp = telemetryStateStamp(this.options.dir);
    if (!this.cached || this.cached.stamp !== stamp || stamp === undefined) {
      const read = readTelemetryState(this.options.dir);
      this.cached = { stamp, ...read };
      // 文件被改过（CLI 换了开关、重置了 ID）：这次进程里记下的「用过」作废，以文件为准
      this.used.clear();
    }
    if (!this.cached.stored && !this.blocker && this.cached.state.enabled !== false) {
      this.save(this.cached.state);
    }
    return this.cached;
  }

  private save(state: TelemetryState): void {
    writeTelemetryState(this.options.dir, state);
    this.cached = { stamp: telemetryStateStamp(this.options.dir), state, stored: true };
  }

  /** 真的在记录：没被环境挡住，用户也没关 */
  active(): boolean {
    if (this.blocker) return false;
    try {
      return this.state().state.enabled !== false;
    } catch {
      return false;
    }
  }

  status(): TelemetryStatus {
    const base = { endpoint: Boolean(this.endpoint) };
    try {
      if (this.blocker) {
        const { state, stored } = readTelemetryState(this.options.dir);
        return {
          ...base,
          active: false,
          enabled: state.enabled !== false,
          blocker: this.blocker,
          ...(stored ? { installId: state.installId } : {}),
          queued: 0,
          noticePending: false,
        };
      }
      const { state } = this.state();
      const active = state.enabled !== false;
      return {
        ...base,
        active,
        enabled: active,
        installId: state.installId,
        queued: active ? readTelemetryQueue(this.options.dir).length : 0,
        noticePending: active && !state.noticeShownAt,
      };
    } catch (error) {
      this.warn("read", error);
      return { ...base, active: false, enabled: false, queued: 0, noticePending: false };
    }
  }

  /** 设置里的开关、hive telemetry on|off。关掉时还没发的数据一起删掉 */
  setEnabled(enabled: boolean): TelemetryStatus {
    try {
      setTelemetryEnabled(this.options.dir, enabled, this.now());
      this.cached = undefined;
    } catch (error) {
      this.warn("save", error);
    }
    return this.status();
  }

  /** 换一个新的安装 ID，还没发的数据一起删掉 */
  resetInstallId(): TelemetryStatus {
    try {
      resetTelemetryId(this.options.dir);
      this.cached = undefined;
    } catch (error) {
      this.warn("save", error);
    }
    return this.status();
  }

  /** 首次告知弹出来了：以后不再弹 */
  markNoticeShown(): TelemetryStatus {
    if (!this.active()) return this.status();
    try {
      const { state } = this.state();
      if (!state.noticeShownAt) {
        this.save({ ...state, noticeShownAt: new Date(this.now()).toISOString() });
      }
    } catch (error) {
      this.warn("save", error);
    }
    return this.status();
  }

  /** 本机房主网页的界面语言（公共字段 locale） */
  setUiLocale(locale: TelemetryLocale): void {
    if (!this.active()) return;
    try {
      const { state } = this.state();
      if (state.uiLocale !== locale) this.save({ ...state, uiLocale: locale });
    } catch (error) {
      this.warn("save", error);
    }
  }

  /** 下一次要发的请求体（设置里「查看要发送的数据」、hive telemetry preview） */
  preview(): ReturnType<typeof telemetryPayload> | null {
    try {
      if (!this.active()) return null;
      return telemetryPayload(this.state().state.installId, readTelemetryQueue(this.options.dir));
    } catch (error) {
      this.warn("read", error);
      return null;
    }
  }

  /** 记一条事件（按白名单校验，不认得的字段、不在范围里的值丢掉） */
  record(event: TelemetryEventName, props: Readonly<Record<string, unknown>>): void {
    if (!this.active()) return;
    try {
      const { state } = this.state();
      const queued = appendTelemetryEvents(this.options.dir, [
        {
          event,
          time: hourOf(this.now()),
          context: telemetryContext({
            version: this.options.version,
            runMode: this.options.runMode,
            locale: state.uiLocale,
          }),
          props,
        },
      ]);
      if (queued >= (this.options.batchSize ?? 50)) void this.flush();
    } catch (error) {
      this.warn("record", error);
    }
  }

  /** 关键功能第一次用到：每台电脑每个功能只记一次 */
  feature(feature: TelemetryFeature): void {
    if (this.used.has(feature) || !this.active()) return;
    try {
      const { state } = this.state();
      this.used.add(feature);
      if (state.firstUsed[feature]) return;
      this.save({ ...state, firstUsed: { ...state.firstUsed, [feature]: dayOf(this.now()) } });
      this.record("feature_first_used", { feature });
    } catch (error) {
      this.warn("record", error);
    }
  }

  /** 新出现一次故障：按类别计数，攒到下次心跳一起记 */
  incident(origin: string, source: string): void {
    if (!this.active()) return;
    const key = `${origin}.${source}`;
    this.pendingIncidents[key] = (this.pendingIncidents[key] ?? 0) + 1;
    if (this.incidentTimer) return;
    this.incidentTimer = setTimeout(() => this.saveIncidents(), 5_000);
    this.incidentTimer.unref?.();
  }

  private saveIncidents(): void {
    clearTimeout(this.incidentTimer);
    this.incidentTimer = undefined;
    const pending = this.pendingIncidents;
    this.pendingIncidents = {};
    if (!Object.keys(pending).length || !this.active()) return;
    try {
      const { state } = this.state();
      const counts = { ...state.incidentCounts };
      for (const [key, count] of Object.entries(pending)) counts[key] = (counts[key] ?? 0) + count;
      this.save({ ...state, incidentCounts: counts });
    } catch (error) {
      this.warn("save", error);
    }
  }

  /** 每天（UTC）一次：本机 Agent 数、房间数区间，以及这段时间的故障计数 */
  heartbeat(): void {
    if (!this.active()) return;
    try {
      this.saveIncidents();
      const { state } = this.state();
      const today = dayOf(this.now());
      if (state.heartbeatDay === today) return;
      const snapshot = this.options.snapshot?.() ?? { agents: {}, rooms: 0 };
      const { incidentCounts, ...rest } = state;
      this.save({ ...rest, heartbeatDay: today });
      this.record("heartbeat", { agents: snapshot.agents, rooms: roomBucket(snapshot.rooms) });
      if (incidentCounts && Object.keys(incidentCounts).length) {
        this.record("incident_counts", { counts: incidentCounts });
      }
    } catch (error) {
      this.warn("record", error);
    }
  }

  /** 上报：没配地址、没开时什么都不做；发了不管成败都从队列里去掉 */
  flush(): Promise<void> {
    if (this.flushing || !this.endpoint || !this.active())
      return this.flushing ?? Promise.resolve();
    const endpoint = this.endpoint;
    this.flushing = (async () => {
      try {
        const events = takeTelemetryQueue(this.options.dir);
        if (!events.length) return;
        const body = JSON.stringify(telemetryPayload(this.state().state.installId, events));
        const response = await (this.options.fetch ?? fetch)(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
        });
        if (!response.ok)
          this.options.log?.(`Usage statistics upload rejected (${response.status})`);
      } catch (error) {
        this.warn("send", error);
      } finally {
        this.flushing = undefined;
      }
    })();
    return this.flushing;
  }

  private warn(step: string, error: unknown): void {
    this.options.log?.(`Usage statistics ${step} failed`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
