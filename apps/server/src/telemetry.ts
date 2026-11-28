/**
 * 匿名使用统计：网页、桌面端、CLI 的事件都汇总到这里，由 Server 批量上报（默认每小时一次，或攒够
 * batchSize 条），各端自己不往外发。CLI 直接往本机队列里追加（见 telemetry-core.ts），也由这里一起发。
 *
 * - 一律不报：设置里关了（或 hive telemetry off）、SUPERHIVE_TELEMETRY=0、DO_NOT_TRACK=1、CI、沙箱、测试。
 *   这时什么都不记，也不建文件。
 * - npm 安装和桌面端安装包默认发到项目自部署的 Umami（DEFAULT_TELEMETRY_ENDPOINT）；源码运行默认不发，
 *   只在本机记录、可以预览，要发得显式设 SUPERHIVE_TELEMETRY_URL（见 telemetryEndpoint）。
 * - 发给自部署的 Umami：{地址}/api/batch，一次最多 TELEMETRY_BATCH_LIMIT 条，请求头带 SuperHive 的 UA
 *   （不带 Umami 会当机器人丢掉）。网络不通、服务出错（408、429、5xx）时放回本机队列，过一会儿再发：
 *   第一次等 1 小时，连续失败每次翻倍，最多等 1 天；队列最多 200 条，满了丢最旧的。
 *   服务明确拒收（其它 4xx）的丢掉，重发也没用。任何一步出错都只记日志，不影响别的功能。
 * - 开关存在 ~/.superhive/telemetry/state.json，CLI 改了以后这里按文件修改时间重新读。
 */
import type { TelemetryBlocker, TelemetryStatus } from "@superhive/protocol";
import {
  appendTelemetryEvents,
  dayOf,
  hourOf,
  readTelemetryQueue,
  readTelemetryState,
  requeueTelemetryEvents,
  resetTelemetryId,
  roomBucket,
  setTelemetryEnabled,
  takeTelemetryQueue,
  TELEMETRY_BATCH_LIMIT,
  telemetryBlocker,
  telemetryContext,
  telemetryEndpoint,
  telemetryRequestBody,
  telemetrySite,
  telemetryStateStamp,
  telemetryUserAgent,
  writeTelemetryState,
  type TelemetryEvent,
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
/** 发送失败后最多隔多久再试（从 1 小时起每次翻倍） */
const RETRY_MAX_MS = 24 * HOUR_MS;

/** 一批的结果：sent=收下了（或被明确拒收，重发也没用，丢掉）；retry=放回队列，过一会儿再发 */
type SendResult = "sent" | "retry";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class Telemetry {
  readonly blocker: TelemetryBlocker | undefined;
  private readonly endpoint: string | undefined;
  /** Umami 的 websiteId */
  private readonly site: string;
  private readonly userAgent: string;
  private readonly now: () => number;
  /** 连续失败了几次、下次最早什么时候再发 */
  private failures = 0;
  private retryAt = 0;
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
    this.endpoint = telemetryEndpoint(env, options.runMode);
    this.site = telemetrySite(env);
    this.userAgent = telemetryUserAgent(
      telemetryContext({ version: options.version, runMode: options.runMode, locale: "other" }),
    );
    this.now = options.now ?? Date.now;
  }

  /** 开始定时心跳和上报；状态文件还没有时（开着的情况下）顺带生成安装 ID */
  start(): void {
    if (this.active()) {
      this.state();
      const env = this.options.env ?? process.env;
      this.options.log?.(
        this.endpoint
          ? "Anonymous usage statistics are on; turn them off in Settings or with `hive telemetry off`"
          : env.SUPERHIVE_TELEMETRY_URL?.trim()
            ? "Anonymous usage statistics are on, recorded locally only (SUPERHIVE_TELEMETRY_URL is not an http(s) URL, nothing is sent)"
            : "Anonymous usage statistics are on, recorded locally only (running from source, nothing is sent unless SUPERHIVE_TELEMETRY_URL is set)",
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
  preview(): ReturnType<typeof telemetryRequestBody> | null {
    try {
      if (!this.active()) return null;
      return telemetryRequestBody(
        this.site,
        this.state().state.installId,
        readTelemetryQueue(this.options.dir),
      );
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

  /**
   * 上报：没配地址、没开、还在失败后的等待期里时什么都不做。按批发，某一批该重发时停下，
   * 这一批和后面没发的放回队列，等一会儿再发。
   */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (!this.endpoint || this.now() < this.retryAt || !this.active()) return Promise.resolve();
    const endpoint = this.endpoint;
    this.flushing = (async () => {
      try {
        const installId = this.state().state.installId;
        const events = takeTelemetryQueue(this.options.dir);
        let unsent: TelemetryEvent[] = [];
        for (let start = 0; start < events.length; start += TELEMETRY_BATCH_LIMIT) {
          const batch = events.slice(start, start + TELEMETRY_BATCH_LIMIT);
          if ((await this.send(endpoint, installId, batch)) === "retry") {
            unsent = events.slice(start);
            break;
          }
        }
        if (!unsent.length) {
          this.failures = 0;
          this.retryAt = 0;
          return;
        }
        this.failures += 1;
        this.retryAt = this.now() + Math.min(HOUR_MS * 2 ** (this.failures - 1), RETRY_MAX_MS);
        // 发的时候关掉了统计、或重置了安装 ID：这些数据作废，不放回去
        if (this.active() && this.state().state.installId === installId) {
          requeueTelemetryEvents(this.options.dir, unsent);
        }
      } catch (error) {
        this.warn("send", error);
      } finally {
        this.flushing = undefined;
      }
    })();
    return this.flushing;
  }

  private async send(
    endpoint: string,
    installId: string,
    events: readonly TelemetryEvent[],
  ): Promise<SendResult> {
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": this.userAgent },
        body: JSON.stringify(telemetryRequestBody(this.site, installId, events)),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
      });
    } catch (error) {
      this.warn("send", error);
      return "retry";
    }
    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      this.options.log?.(`Usage statistics upload failed (${response.status}), will retry later`);
      return "retry";
    }
    if (!response.ok) {
      this.options.log?.(`Usage statistics upload rejected (${response.status})`);
      return "sent";
    }
    // Umami 的 /api/batch 逐条处理，回 { size, processed, errors }：一条都没收下（比如它的数据库出错）
    // 时下次再发；只拒了其中几条的（数据不合格）丢掉
    const result: unknown = await response.json().catch(() => undefined);
    if (isRecord(result) && typeof result.errors === "number" && result.errors > 0) {
      if (result.processed === 0) {
        this.options.log?.("Usage statistics upload failed (no event accepted), will retry later");
        return "retry";
      }
      this.options.log?.(`Usage statistics upload: ${result.errors} event(s) rejected`);
    }
    // 发出去了留一行日志（一天也就一两行），哪天发了多少条有据可查
    const accepted =
      isRecord(result) && typeof result.processed === "number" ? result.processed : events.length;
    this.options.log?.(`Usage statistics sent (${accepted} of ${events.length} event(s) accepted)`);
    return "sent";
  }

  private warn(step: string, error: unknown): void {
    this.options.log?.(`Usage statistics ${step} failed`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
