/**
 * 匿名使用统计：网页、桌面端、CLI 的事件都汇总到这里，由 Server 上报，各端自己不往外发。
 * CLI 直接往本机队列里追加（见 telemetry-core.ts），也由这里一起发。
 *
 * - 一律不报：设置里关了（或 hive telemetry off）、SUPERHIVE_TELEMETRY=0、DO_NOT_TRACK=1、CI、沙箱、测试。
 *   这时什么都不记，也不建文件。
 * - npm 安装和桌面端安装包默认发到项目自部署的 Umami（DEFAULT_TELEMETRY_ENDPOINT）；源码运行默认不发，
 *   只在本机记录、可以预览，要发得显式设 SUPERHIVE_TELEMETRY_URL（见 telemetryEndpoint）。
 * - 每天（UTC）一条心跳（heartbeat），带 active：那天有没有人（不是 Agent）发过消息。当天第一次有人
 *   发消息时定下来（active=yes）；开着但一直没人发消息的那天先存成待定，到了之后哪天按 active=no 定下来。
 * - 每天最多上报一次，跟心跳一起发：队列里有定下来的心跳才发，把队列里的全部放进一个请求，发给自部署的
 *   Umami 的 {地址}/api/batch，请求头带 SuperHive 的 UA（不带 Umami 会当机器人丢掉）。当天发过（不管成没成）
 *   就等第二天：网络不通、服务出错（408、429、5xx）时放回本机队列，下次一起发；队列最多 200 条，满了丢最旧的。
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
  sanitizeEvent,
  setTelemetryEnabled,
  settleHeartbeat,
  takeTelemetryQueue,
  telemetryBlocker,
  telemetryContext,
  telemetryEndpoint,
  telemetryOutbox,
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
  /** 多久看一次换没换天（定下前一天的心跳、记新一天的）、该不该发（默认 1 小时） */
  intervalMs?: number;
  /** 启动后多久做第一次（默认 1 分钟，别和启动抢资源） */
  startDelayMs?: number;
  /** 当天第一次有人发消息后多久把心跳定下来、发出去（默认 1 分钟，不在发消息的路上做） */
  activityDelayMs?: number;
  /** 一次上报最多等多久 */
  timeoutMs?: number;
};

const HOUR_MS = 60 * 60_000;

/** 一次上报的结果：sent=收下了（或被明确拒收，重发也没用，丢掉）；retry=放回队列，下次一起发 */
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
  private cached: { stamp: string | undefined; state: TelemetryState; stored: boolean } | undefined;
  private timers: Array<ReturnType<typeof setTimeout>> = [];
  private flushing: Promise<void> | undefined;
  /** 这次进程里已经确认记过「第一次用到」的功能：之后不再读文件 */
  private readonly used = new Set<TelemetryFeature>();
  /** 这次进程里已经记下「这天有人发过消息」的日期：同一天之后的消息不再读文件 */
  private activityDay: string | undefined;
  private activityTimer: ReturnType<typeof setTimeout> | undefined;

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
    const first = setTimeout(() => this.tick(), this.options.startDelayMs ?? 60_000);
    const every = setInterval(() => this.tick(), this.options.intervalMs ?? HOUR_MS);
    first.unref?.();
    every.unref?.();
    this.timers.push(first, every);
  }

  close(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    clearTimeout(this.activityTimer);
    this.activityTimer = undefined;
  }

  /** 定心跳，该发就发 */
  private tick(): void {
    this.heartbeat();
    void this.flush();
  }

  /** 读状态（文件改过才重新读）；开着且文件还没有时写一份，生成安装 ID */
  private state(): { state: TelemetryState; stored: boolean } {
    const stamp = telemetryStateStamp(this.options.dir);
    if (!this.cached || this.cached.stamp !== stamp || stamp === undefined) {
      const read = readTelemetryState(this.options.dir);
      this.cached = { stamp, ...read };
      // 文件被改过（CLI 换了开关、重置了 ID）：这次进程里记下的「用过」「有人发过消息」作废，以文件为准
      this.used.clear();
      this.activityDay = undefined;
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
        queued: active ? telemetryOutbox(this.options.dir, state).length : 0,
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

  /** 等着发的请求体，含还没定下来的心跳（设置里「查看要发送的数据」、hive telemetry preview） */
  preview(): ReturnType<typeof telemetryRequestBody> | null {
    try {
      if (!this.active()) return null;
      const { state } = this.state();
      return telemetryRequestBody(
        this.site,
        state.installId,
        telemetryOutbox(this.options.dir, state),
      );
    } catch (error) {
      this.warn("read", error);
      return null;
    }
  }

  /** 现在发生的一条事件（还没按白名单校验） */
  private event(
    event: TelemetryEventName,
    props: Readonly<Record<string, unknown>>,
    state: TelemetryState,
  ) {
    return {
      event,
      time: hourOf(this.now()),
      context: telemetryContext({
        version: this.options.version,
        runMode: this.options.runMode,
        locale: state.uiLocale,
      }),
      props,
    };
  }

  /** 记一条事件（按白名单校验，不认得的字段、不在范围里的值丢掉），等下次跟心跳一起发 */
  record(event: TelemetryEventName, props: Readonly<Record<string, unknown>>): void {
    if (!this.active()) return;
    try {
      appendTelemetryEvents(this.options.dir, [this.event(event, props, this.state().state)]);
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

  /**
   * 有人（不是 Agent，也不是定时任务代发、系统提示）发了一条消息：记下这天有人在用。当天的心跳还没
   * 定下来时，过一会儿把它定成 active=yes、发出去。只记日期，不记条数
   */
  humanMessage(): void {
    const today = dayOf(this.now());
    if (this.activityDay === today || !this.active()) return;
    try {
      const { state } = this.state();
      this.activityDay = today;
      if (state.activeDay !== today) this.save({ ...state, activeDay: today });
      if (state.heartbeatDay === today || this.activityTimer) return;
      this.activityTimer = setTimeout(() => {
        this.activityTimer = undefined;
        this.tick();
      }, this.options.activityDelayMs ?? 60_000);
      this.activityTimer.unref?.();
    } catch (error) {
      this.warn("save", error);
    }
  }

  /**
   * 每天（UTC）一条心跳：本机 Agent 数、房间数区间、那天有没有人发过消息（active）。
   * - 当天有人发过消息：记 active=yes，进队列，这天不再记。
   * - 还没有：先存成待定（state.pendingHeartbeat），当天之后有人发消息再换成 active=yes。
   * - 待定的那天过去了：按那天有没有人发过消息定下来（一般是 active=no），时间仍是那天。
   * Server 没开的日子没有心跳。
   */
  heartbeat(): void {
    if (!this.active()) return;
    try {
      const { state } = this.state();
      const today = dayOf(this.now());
      const next: TelemetryState = { ...state };
      const settled: TelemetryEvent[] = [];
      const pending = next.pendingHeartbeat;
      if (pending && pending.time.slice(0, 10) !== today) {
        const day = pending.time.slice(0, 10);
        if (!next.heartbeatDay || next.heartbeatDay < day) {
          settled.push(settleHeartbeat(pending, next.activeDay));
          next.heartbeatDay = day;
        }
        delete next.pendingHeartbeat;
      }
      const active = next.activeDay === today;
      if ((!next.heartbeatDay || next.heartbeatDay < today) && (active || !next.pendingHeartbeat)) {
        const snapshot = this.options.snapshot?.() ?? { agents: {}, rooms: 0 };
        const heartbeat = sanitizeEvent(
          this.event(
            "heartbeat",
            {
              agents: snapshot.agents,
              rooms: roomBucket(snapshot.rooms),
              active: active ? "yes" : "no",
            },
            state,
          ),
        );
        if (heartbeat && active) {
          settled.push(heartbeat);
          next.heartbeatDay = today;
          delete next.pendingHeartbeat;
        } else if (heartbeat) {
          next.pendingHeartbeat = heartbeat;
        }
      }
      // 先进队列再改状态：中途出错最多重复一条心跳，不会丢
      if (settled.length) appendTelemetryEvents(this.options.dir, settled);
      if (JSON.stringify(next) !== JSON.stringify(state)) this.save(next);
    } catch (error) {
      this.warn("record", error);
    }
  }

  /**
   * 上报：每天（UTC）最多一次，跟心跳一起发——队列里有定下来的心跳才发，队列里的全部放进一个请求。
   * 没配地址、没开、当天已经发过（不管成没成）时什么都不做；没发出去的放回队列，下次一起发。
   */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (!this.endpoint || !this.active()) return Promise.resolve();
    const endpoint = this.endpoint;
    const run = async () => {
      try {
        const { state } = this.state();
        const today = dayOf(this.now());
        if (state.sentDay && state.sentDay >= today) return;
        const queue = readTelemetryQueue(this.options.dir);
        if (!queue.some((event) => event.event === "heartbeat")) return;
        this.save({ ...state, sentDay: today });
        const installId = state.installId;
        const events = takeTelemetryQueue(this.options.dir);
        if (!events.length) return;
        if ((await this.send(endpoint, installId, events)) === "sent") return;
        // 发的时候关掉了统计、或重置了安装 ID：这些数据作废，不放回去
        if (this.active() && this.state().state.installId === installId) {
          requeueTelemetryEvents(this.options.dir, events);
        }
      } catch (error) {
        this.warn("send", error);
      }
    };
    // 用 .finally 清掉：run() 不发就同步返回时，清理也排在赋值之后，不会把一个已结束的 Promise 永远留在这里
    const flushing = run().finally(() => {
      if (this.flushing === flushing) this.flushing = undefined;
    });
    this.flushing = flushing;
    return flushing;
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
      this.options.log?.(
        `Usage statistics upload failed (${response.status}), will retry with the next daily upload`,
      );
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
        this.options.log?.(
          "Usage statistics upload failed (no event accepted), will retry with the next daily upload",
        );
        return "retry";
      }
      this.options.log?.(`Usage statistics upload: ${result.errors} event(s) rejected`);
    }
    // 发出去了留一行日志（一天最多一行），哪天发了多少条有据可查
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
