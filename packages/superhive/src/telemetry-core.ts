/**
 * 匿名使用统计（telemetry）的公共部分：开关、随机安装 ID、事件白名单、本地队列。
 *
 * 与 packages/superhive/src/telemetry-core.ts 逐字相同（Server 和 superhive 包分别发布，各带一份；
 * apps/server 的 telemetry-core.test.ts 核对两份一致），改动请两边同步。只用 Node 自带模块。
 *
 * 同一台电脑上的 Server、桌面端、CLI 共用一份数据，放在 ~/.superhive/telemetry/：
 * - state.json：开关、安装 ID、首次告知弹过没有、各功能第一次用到的日期、上次心跳的日期
 * - queue.jsonl：等着上报的事件，一行一条，最多 QUEUE_LIMIT 条，超出丢最旧的
 *
 * 只有 Server 往外发（apps/server 的 telemetry.ts），CLI 只往队列里追加。
 * 上报地址默认为空：没配地址时只在本机记录、可以预览，一条都不发。
 * 统计服务是自部署的 Umami（https://umami.is）：发出去的请求体由 telemetryRequestBody 生成，
 * 一条事件对应 Umami 的一条 { type: "event", payload }，预览看到的也是它。
 *
 * 事件和字段都按下面的 TELEMETRY_EVENTS 白名单校验：不在表里的事件整条丢掉，不在表里的字段、
 * 不在取值范围里的值直接去掉。表里只有枚举和计数，没有任何自由文本，消息、路径、名字、主机名、
 * key、IP、报错原文都进不来。文档 apps/docs 的「使用统计」页列的就是这张表。
 */
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** 上报的数据格式版本：字段有不兼容的改动时加一 */
export const TELEMETRY_SCHEMA = 1;
/**
 * 上报地址（Umami 的根地址，例如 https://stats.example.com）。统计服务定下来之前为空：一条都不发，
 * 只在本机记录。也可以用环境变量 SUPERHIVE_TELEMETRY_URL 指定（自己部署统计服务、或调试时用）。
 */
export const DEFAULT_TELEMETRY_ENDPOINT = "";
/** Umami 里 SuperHive 这个站点的 websiteId；环境变量 SUPERHIVE_TELEMETRY_SITE 可以换 */
export const DEFAULT_TELEMETRY_SITE = "b2d13ec6-3fa6-47bf-9cbd-7317357517fc";
/** 每条事件在 Umami 里记的域名：只是个标签，不对应真实网站 */
export const TELEMETRY_HOSTNAME = "superhive.app";
/** 一次请求最多带几条事件（Umami 的 /api/batch 一次最多收 500 条） */
export const TELEMETRY_BATCH_LIMIT = 50;
/** 本地队列最多留多少条，超出丢最旧的 */
export const QUEUE_LIMIT = 200;
/** 「使用统计」文档 */
export const TELEMETRY_DOCS_URL = "https://wangrongding.github.io/SuperHive/reference/telemetry/";

/* ---------- 白名单 ---------- */

/** 本机 Agent 的 CLI 类型（心跳里按它分别计数） */
export const TELEMETRY_AGENT_PROVIDERS = [
  "codex",
  "claude",
  "copilot",
  "opencode",
  "omp",
  "openclaw",
  "gemini",
  "agy",
] as const;
/** 房间数的区间 */
export const TELEMETRY_ROOM_BUCKETS = ["0", "1", "2-5", "6-20", "21+"] as const;
/** 记「第一次用到」的功能 */
export const TELEMETRY_FEATURES = [
  "room_create",
  "agent_join",
  "invite_member",
  "im_connect",
  "mcp_install",
  "artifacts_panel",
  "code_panel",
] as const;
/** 更新的种类：桌面端应用内更新、网页版（npm）在网页里更新、Agent CLI 安装和升级 */
export const TELEMETRY_UPDATE_KINDS = ["desktop", "npm", "agent_cli"] as const;
/** 更新失败的类别（各端把自己的原因归到这几类，不带报错原文） */
export const TELEMETRY_UPDATE_FAILURES = [
  // 桌面端
  "no_package",
  "not_installed",
  "translocated",
  "read_only",
  "not_writable",
  "network",
  "checksum",
  "bad_package",
  // Agent CLI
  "timeout",
  "stalled",
  "exit_code",
  "spawn_failed",
  "version_unknown",
  "version_unchanged",
  "install_broken",
  // 网页版（npm）
  "install_failed",
  "package_mismatch",
  "verify_failed",
  "busy_agents",
  "restart_failed",
  "not_managed",
  "unknown",
] as const;
/** 故障单的类别：是谁的问题（origin）× 从哪来（source） */
export const TELEMETRY_INCIDENT_CATEGORIES = ["internal", "external", "unknown"].flatMap((origin) =>
  ["invocation", "server", "protocol", "web"].map((source) => `${origin}.${source}`),
);

type EnumField = { kind: "enum"; values: readonly string[]; required?: boolean };
type CountsField = { kind: "counts"; keys: readonly string[]; max: number; required?: boolean };
type TelemetryField = EnumField | CountsField;

/** 全部事件和字段：只有枚举和计数 */
export const TELEMETRY_EVENTS = {
  /** 每天一次：本机 Agent 按 CLI 类型分的数量、房间数的区间 */
  heartbeat: {
    agents: { kind: "counts", keys: TELEMETRY_AGENT_PROVIDERS, max: 99 },
    rooms: { kind: "enum", values: TELEMETRY_ROOM_BUCKETS, required: true },
  },
  /** 关键功能第一次用到（每台电脑每个功能只记一次） */
  feature_first_used: {
    feature: { kind: "enum", values: TELEMETRY_FEATURES, required: true },
  },
  /** 更新结果 */
  update_result: {
    kind: { kind: "enum", values: TELEMETRY_UPDATE_KINDS, required: true },
    outcome: { kind: "enum", values: ["success", "failure"], required: true },
    reason: { kind: "enum", values: TELEMETRY_UPDATE_FAILURES },
    /** Agent CLI：哪一个、是安装还是升级 */
    target: { kind: "enum", values: TELEMETRY_AGENT_PROVIDERS },
    action: { kind: "enum", values: ["install", "upgrade"] },
  },
  /** 上次心跳以来新出现的故障，按类别计数（随每天的心跳一起记） */
  incident_counts: {
    counts: { kind: "counts", keys: TELEMETRY_INCIDENT_CATEGORIES, max: 9999, required: true },
  },
} as const satisfies Record<string, Record<string, TelemetryField>>;

export type TelemetryEventName = keyof typeof TELEMETRY_EVENTS;
export type TelemetryFeature = (typeof TELEMETRY_FEATURES)[number];
export type TelemetryUpdateFailure = (typeof TELEMETRY_UPDATE_FAILURES)[number];
export type TelemetryProps = Record<string, string | Record<string, number>>;

export const TELEMETRY_RUN_MODES = ["npm", "desktop", "source"] as const;
export const TELEMETRY_OS = ["darwin", "win32", "linux", "other"] as const;
export const TELEMETRY_ARCH = ["x64", "arm64", "other"] as const;
export const TELEMETRY_LOCALES = ["zh-CN", "en", "other"] as const;
export type TelemetryRunMode = (typeof TELEMETRY_RUN_MODES)[number];
export type TelemetryLocale = (typeof TELEMETRY_LOCALES)[number];

/** 每条事件都带的公共字段 */
export type TelemetryContext = {
  /** superhive 的版本号 */
  version: string;
  runMode: TelemetryRunMode;
  os: (typeof TELEMETRY_OS)[number];
  arch: (typeof TELEMETRY_ARCH)[number];
  /** 界面语言 */
  locale: TelemetryLocale;
};

export type TelemetryEvent = {
  event: TelemetryEventName;
  /** 发生的时间，只精确到小时（UTC） */
  time: string;
  context: TelemetryContext;
  props: TelemetryProps;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEventName(value: unknown): value is TelemetryEventName {
  return typeof value === "string" && Object.hasOwn(TELEMETRY_EVENTS, value);
}

/** 按白名单留下认得的字段；缺了必填字段返回 undefined（整条丢掉） */
export function sanitizeProps(
  event: TelemetryEventName,
  input: unknown,
): TelemetryProps | undefined {
  const spec: Record<string, TelemetryField> = TELEMETRY_EVENTS[event];
  const source = isRecord(input) ? input : {};
  const props: TelemetryProps = {};
  for (const [name, field] of Object.entries(spec)) {
    const value = source[name];
    if (field.kind === "enum") {
      if (typeof value === "string" && field.values.includes(value)) props[name] = value;
    } else if (isRecord(value)) {
      const counts: Record<string, number> = {};
      for (const key of field.keys) {
        const count = value[key];
        if (typeof count === "number" && Number.isInteger(count) && count > 0) {
          counts[key] = Math.min(count, field.max);
        }
      }
      if (Object.keys(counts).length) props[name] = counts;
    }
    if (field.required && !(name in props)) return undefined;
  }
  return props;
}

const VERSION_PATTERN = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.]{1,20})?$/;

function pick<T extends string>(values: readonly T[], value: unknown): T | undefined {
  return typeof value === "string" && (values as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

export function sanitizeContext(input: unknown): TelemetryContext | undefined {
  if (!isRecord(input)) return undefined;
  const version =
    typeof input.version === "string" && VERSION_PATTERN.test(input.version)
      ? input.version
      : undefined;
  const runMode = pick(TELEMETRY_RUN_MODES, input.runMode);
  const os = pick(TELEMETRY_OS, input.os);
  const arch = pick(TELEMETRY_ARCH, input.arch);
  const locale = pick(TELEMETRY_LOCALES, input.locale);
  if (!version || !runMode || !os || !arch || !locale) return undefined;
  return { version, runMode, os, arch, locale };
}

const HOUR_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/;

/** 整条校验：事件名、时间（整点）、公共字段、事件字段；不合格返回 undefined */
export function sanitizeEvent(input: unknown): TelemetryEvent | undefined {
  if (!isRecord(input) || !isEventName(input.event)) return undefined;
  if (typeof input.time !== "string" || !HOUR_PATTERN.test(input.time)) return undefined;
  const context = sanitizeContext(input.context);
  const props = sanitizeProps(input.event, input.props);
  if (!context || !props) return undefined;
  return { event: input.event, time: input.time, context, props };
}

/* ---------- 公共字段 ---------- */

export function hourOf(ms: number): string {
  return new Date(Math.floor(ms / 3_600_000) * 3_600_000).toISOString();
}

/** UTC 日期（YYYY-MM-DD）：心跳按它一天一次 */
export function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function roomBucket(count: number): (typeof TELEMETRY_ROOM_BUCKETS)[number] {
  if (count <= 0) return "0";
  if (count === 1) return "1";
  if (count <= 5) return "2-5";
  if (count <= 20) return "6-20";
  return "21+";
}

export function normalizeLocale(value: string | undefined): TelemetryLocale {
  const lower = value?.toLowerCase() ?? "";
  if (lower.startsWith("zh")) return "zh-CN";
  if (lower.startsWith("en")) return "en";
  return "other";
}

/** 系统语言：网页还没告诉过界面语言时用它 */
export function systemLocale(): TelemetryLocale {
  try {
    return normalizeLocale(Intl.DateTimeFormat().resolvedOptions().locale);
  } catch {
    return "other";
  }
}

export function telemetryContext(
  input: { version: string; runMode: TelemetryRunMode; locale?: TelemetryLocale | undefined },
  platform: string = process.platform,
  arch: string = process.arch,
): TelemetryContext {
  return {
    version: input.version,
    runMode: input.runMode,
    os: pick(TELEMETRY_OS, platform) ?? "other",
    arch: pick(TELEMETRY_ARCH, arch) ?? "other",
    locale: input.locale ?? systemLocale(),
  };
}

/* ---------- 开关 ---------- */

/**
 * 为什么一律不报：
 * env=SUPERHIVE_TELEMETRY=0；do_not_track=DO_NOT_TRACK=1；ci=在 CI 里跑；
 * sandbox=沙箱预览（HIVE_SANDBOX=1）；test=在跑测试
 */
export type TelemetryBlocker = "env" | "do_not_track" | "ci" | "sandbox" | "test";

const FALSE_VALUES = new Set(["0", "false", "off", "no", "disable", "disabled"]);
/** 常见 CI 的标志变量（CI=true 之外各家自己的） */
const CI_VARIABLES = [
  "CONTINUOUS_INTEGRATION",
  "BUILD_NUMBER",
  "RUN_ID",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "CIRCLECI",
  "TRAVIS",
  "BUILDKITE",
  "TF_BUILD",
  "JENKINS_URL",
  "TEAMCITY_VERSION",
  "APPVEYOR",
  "CODEBUILD_BUILD_ID",
  "BITBUCKET_BUILD_NUMBER",
  "DRONE",
  "SEMAPHORE",
  "NETLIFY",
  "VERCEL",
];

function truthy(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return Boolean(normalized) && !FALSE_VALUES.has(normalized!);
}

export function telemetryBlocker(
  env: NodeJS.ProcessEnv = process.env,
): TelemetryBlocker | undefined {
  const setting = env.SUPERHIVE_TELEMETRY?.trim().toLowerCase();
  if (setting && FALSE_VALUES.has(setting)) return "env";
  if (truthy(env.DO_NOT_TRACK)) return "do_not_track";
  if (env.HIVE_SANDBOX === "1") return "sandbox";
  if (truthy(env.CI) || CI_VARIABLES.some((name) => truthy(env[name]))) return "ci";
  if (truthy(env.VITEST) || env.NODE_ENV === "test" || truthy(env.JEST_WORKER_ID)) return "test";
  return undefined;
}

/**
 * 真正发往的地址：Umami 的 {根地址}/api/batch。环境变量优先，其次内置地址；都没有或不是 http(s)
 * 地址时为 undefined（不发）。根地址可以带子路径（Umami 挂在反向代理的 /umami 下）；
 * 写成 …/api/send 或 …/api/batch 也认。
 */
export function telemetryEndpoint(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.SUPERHIVE_TELEMETRY_URL?.trim() || DEFAULT_TELEMETRY_ENDPOINT;
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    const base = url.pathname.replace(/\/api\/(?:send|batch)\/?$/, "").replace(/\/*$/, "/");
    url.pathname = `${base}api/batch`;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Umami 的 websiteId：环境变量 SUPERHIVE_TELEMETRY_SITE 优先（不是 UUID 时不认），其次内置的 */
export function telemetrySite(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.SUPERHIVE_TELEMETRY_SITE?.trim();
  return override && UUID_PATTERN.test(override) ? override.toLowerCase() : DEFAULT_TELEMETRY_SITE;
}

/* ---------- 本机状态 ---------- */

export function telemetryDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const override = env.SUPERHIVE_TELEMETRY_DIR?.trim();
  return override ? path.resolve(override) : path.join(home, ".superhive", "telemetry");
}

export type TelemetryState = {
  /** 用户的选择；没选过时没有这一项，按默认开 */
  enabled?: boolean;
  /** 随机生成的安装 ID，不和账号、电脑绑定，可以重置 */
  installId: string;
  /** 首次告知弹出的时间 */
  noticeShownAt?: string;
  /** 功能 → 第一次用到的日期（UTC） */
  firstUsed: Partial<Record<TelemetryFeature, string>>;
  /** 上次心跳的日期（UTC） */
  heartbeatDay?: string;
  /** 本机房主网页的界面语言 */
  uiLocale?: TelemetryLocale;
  /** 上次心跳以来新出现的故障（按类别），下次心跳时一起记 */
  incidentCounts?: Record<string, number>;
};

const stateFile = (dir: string) => path.join(dir, "state.json");
const queueFile = (dir: string) => path.join(dir, "queue.jsonl");

function freshState(): TelemetryState {
  return { installId: randomUUID(), firstUsed: {} };
}

function parseState(raw: unknown): TelemetryState | undefined {
  if (!isRecord(raw) || typeof raw.installId !== "string" || !/^[0-9a-f-]{36}$/.test(raw.installId))
    return undefined;
  const firstUsed: TelemetryState["firstUsed"] = {};
  if (isRecord(raw.firstUsed)) {
    for (const feature of TELEMETRY_FEATURES) {
      const day = raw.firstUsed[feature];
      if (typeof day === "string") firstUsed[feature] = day;
    }
  }
  const incidentCounts: Record<string, number> = {};
  if (isRecord(raw.incidentCounts)) {
    for (const key of TELEMETRY_INCIDENT_CATEGORIES) {
      const count = raw.incidentCounts[key];
      if (typeof count === "number" && Number.isInteger(count) && count > 0) {
        incidentCounts[key] = count;
      }
    }
  }
  const uiLocale = pick(TELEMETRY_LOCALES, raw.uiLocale);
  return {
    ...(typeof raw.enabled === "boolean" ? { enabled: raw.enabled } : {}),
    installId: raw.installId,
    ...(typeof raw.noticeShownAt === "string" ? { noticeShownAt: raw.noticeShownAt } : {}),
    firstUsed,
    ...(typeof raw.heartbeatDay === "string" ? { heartbeatDay: raw.heartbeatDay } : {}),
    ...(uiLocale ? { uiLocale } : {}),
    ...(Object.keys(incidentCounts).length ? { incidentCounts } : {}),
  };
}

/** 读本机状态；没有或坏了时返回一份新的（不写盘，要留下来就调 writeTelemetryState） */
export function readTelemetryState(dir: string): { state: TelemetryState; stored: boolean } {
  try {
    const parsed = parseState(JSON.parse(readFileSync(stateFile(dir), "utf8")));
    if (parsed) return { state: parsed, stored: true };
  } catch {
    // 没有文件或不是 JSON：当作第一次
  }
  return { state: freshState(), stored: false };
}

/** 状态文件的修改时间和大小：Server 据此知道 CLI 改过开关，重新读 */
export function telemetryStateStamp(dir: string): string | undefined {
  try {
    const stat = statSync(stateFile(dir));
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return undefined;
  }
}

/** 先写临时文件再改名：别的进程同时读也读不到写了一半的内容 */
function writeAtomic(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(temporary, content, { mode: 0o600 });
  renameSync(temporary, file);
}

export function writeTelemetryState(dir: string, state: TelemetryState): void {
  writeAtomic(stateFile(dir), `${JSON.stringify(state, null, 2)}\n`);
}

/** 打开或关闭（自己选过了，首次告知不用再弹）；关闭时把还没发的数据一起删掉 */
export function setTelemetryEnabled(
  dir: string,
  enabled: boolean,
  now = Date.now(),
): TelemetryState {
  const current = readTelemetryState(dir).state;
  const state = {
    ...current,
    enabled,
    noticeShownAt: current.noticeShownAt ?? new Date(now).toISOString(),
  };
  writeTelemetryState(dir, state);
  if (!enabled) clearTelemetryQueue(dir);
  return state;
}

/** 换一个新的安装 ID；还没发的数据一起删掉，新旧 ID 对不上 */
export function resetTelemetryId(dir: string): TelemetryState {
  const state = { ...readTelemetryState(dir).state, installId: randomUUID() };
  writeTelemetryState(dir, state);
  clearTelemetryQueue(dir);
  return state;
}

/* ---------- 本地队列 ---------- */

function parseQueue(text: string): TelemetryEvent[] {
  const events: TelemetryEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = sanitizeEvent(JSON.parse(line));
      if (event) events.push(event);
    } catch {
      // 写了一半的行：跳过
    }
  }
  return events;
}

export function readTelemetryQueue(dir: string): TelemetryEvent[] {
  try {
    return parseQueue(readFileSync(queueFile(dir), "utf8")).slice(-QUEUE_LIMIT);
  } catch {
    return [];
  }
}

/** 追加到队列（逐条按白名单校验，不合格的丢掉）；超过上限时丢最旧的。返回追加后的条数 */
export function appendTelemetryEvents(dir: string, events: readonly unknown[]): number {
  const valid = events.flatMap((event) => sanitizeEvent(event) ?? []);
  if (valid.length) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(queueFile(dir), valid.map((event) => `${JSON.stringify(event)}\n`).join(""), {
      mode: 0o600,
    });
  }
  let text: string;
  try {
    text = readFileSync(queueFile(dir), "utf8");
  } catch {
    return 0;
  }
  const queued = parseQueue(text);
  if (text.split("\n").filter((line) => line.trim()).length <= QUEUE_LIMIT) return queued.length;
  const kept = queued.slice(-QUEUE_LIMIT);
  writeAtomic(queueFile(dir), kept.map((event) => `${JSON.stringify(event)}\n`).join(""));
  return kept.length;
}

/** 取走队列里的全部事件（先改名再读，取的同时别的进程追加的留到下一批）；取不到时为空 */
export function takeTelemetryQueue(dir: string): TelemetryEvent[] {
  const claimed = `${queueFile(dir)}.${process.pid}.${randomUUID().slice(0, 8)}.sending`;
  try {
    renameSync(queueFile(dir), claimed);
  } catch {
    return [];
  }
  try {
    return parseQueue(readFileSync(claimed, "utf8")).slice(-QUEUE_LIMIT);
  } catch {
    return [];
  } finally {
    rmSync(claimed, { force: true });
  }
}

/**
 * 没发出去的放回队列，排在取走以后别的进程新追加的前面，下次再发；超过上限时丢最旧的。
 * 先把队列再取一次（改名）再一起追加：这期间别的进程追加的行不会被覆盖掉。
 */
export function requeueTelemetryEvents(dir: string, events: readonly TelemetryEvent[]): number {
  return appendTelemetryEvents(dir, [...events, ...takeTelemetryQueue(dir)]);
}

export function clearTelemetryQueue(dir: string): void {
  rmSync(queueFile(dir), { force: true });
}

/* ---------- 发给 Umami 的格式 ---------- */

/** Umami 一条事件的请求体（POST /api/send 的 body，/api/batch 收的是它的数组） */
export type UmamiEvent = {
  type: "event";
  payload: {
    website: string;
    hostname: string;
    /** 「/事件名」：Umami 要求事件有个页面地址 */
    url: string;
    name: TelemetryEventName;
    /** 界面语言；other 时不带 */
    language?: string;
    /** 事件发生的整点（Unix 秒）：晚发的事件也记在原来的时间上 */
    timestamp: number;
    /** 安装 ID：Umami 的 distinct ID，按它数有多少台电脑 */
    id: string;
    /** 公共字段和事件字段，拍平成一层；计数类字段拍成「字段_键」，例如 agents_claude */
    data: Record<string, string | number>;
  };
};

/** 拍平：Umami 的 data 只收一层 string / number */
export function telemetryData(event: TelemetryEvent): Record<string, string | number> {
  const data: Record<string, string | number> = { schema: TELEMETRY_SCHEMA, ...event.context };
  for (const [name, value] of Object.entries(event.props)) {
    if (typeof value === "string") {
      data[name] = value;
    } else {
      for (const [key, count] of Object.entries(value))
        data[`${name}_${key.replaceAll(".", "_")}`] = count;
    }
  }
  return data;
}

export function umamiEvent(site: string, installId: string, event: TelemetryEvent): UmamiEvent {
  return {
    type: "event",
    payload: {
      website: site,
      hostname: TELEMETRY_HOSTNAME,
      url: `/${event.event}`,
      name: event.event,
      ...(event.context.locale === "other" ? {} : { language: event.context.locale }),
      timestamp: Math.floor(Date.parse(event.time) / 1000),
      id: installId,
      data: telemetryData(event),
    },
  };
}

/** 要发出去的请求体（预览看到的就是它；真正发送时按 TELEMETRY_BATCH_LIMIT 条一批分开发） */
export function telemetryRequestBody(
  site: string,
  installId: string,
  events: readonly TelemetryEvent[],
): UmamiEvent[] {
  return events.map((event) => umamiEvent(site, installId, event));
}

/**
 * 请求头里的 User-Agent。Umami 会把不带 UA、或 UA 像爬虫的请求当机器人丢掉（只回 {"beep":"boop"}），
 * 所以必须带上，形如「SuperHive/0.4.9 (darwin; arm64)」。
 */
export function telemetryUserAgent(
  context: Pick<TelemetryContext, "version" | "os" | "arch">,
): string {
  return `SuperHive/${context.version} (${context.os}; ${context.arch})`;
}
