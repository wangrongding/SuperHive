import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  DEFAULT_CACHE_WRITE_ALERT_TOKENS,
  DEFAULT_PROMPT_CACHE_TTL_MS,
  DEFAULT_SESSION_SIZE_ALERT_TOKENS,
  cacheHitRate,
  cacheTtlFor,
  cacheWriteReason,
  usageInputTokens,
  usageSummarySchema,
  type AgentUsage,
  type CacheWriteReason,
  type Participant,
  type UsageBuckets,
  type UsageRecord,
  type UsageSummary,
  type UsageTotals,
} from "@ai-hive/protocol";
import { formatRelativeTime } from "./whiteboard";
import { localized, t } from "./i18n";

/** 每百万 token 的美元价格；按模型配置，存在本机浏览器里 */
export type ModelPrice = { input: number; cacheWrite: number; cacheRead: number; output: number };

export const PRICES_STORAGE_KEY = "ai-hive.usage-prices";
const listeners = new Set<() => void>();
let prices: Record<string, ModelPrice> = readPrices();

function readPrices(): Record<string, ModelPrice> {
  try {
    const value = JSON.parse(localStorage.getItem(PRICES_STORAGE_KEY) ?? "{}") as unknown;
    if (!value || typeof value !== "object") return {};
    const result: Record<string, ModelPrice> = {};
    for (const [model, price] of Object.entries(value as Record<string, unknown>)) {
      const item = price as Partial<ModelPrice> | null;
      const fields = [item?.input, item?.cacheWrite, item?.cacheRead, item?.output];
      if (fields.every((field) => typeof field === "number" && field >= 0)) {
        result[model] = item as ModelPrice;
      }
    }
    return result;
  } catch {
    return {};
  }
}

/** 提醒阈值与假定的缓存有效期；存在本机浏览器里 */
export type UsageSettings = {
  /** 没观测到写入类型时假定的缓存有效期（分钟） */
  cacheTtlMinutes: number;
  cacheWriteAlertTokens: number;
  sessionAlertTokens: number;
};
export const SETTINGS_STORAGE_KEY = "ai-hive.usage-settings";
export const DEFAULT_USAGE_SETTINGS: UsageSettings = {
  cacheTtlMinutes: DEFAULT_PROMPT_CACHE_TTL_MS / 60_000,
  cacheWriteAlertTokens: DEFAULT_CACHE_WRITE_ALERT_TOKENS,
  sessionAlertTokens: DEFAULT_SESSION_SIZE_ALERT_TOKENS,
};
let settings: UsageSettings = readSettings();

function readSettings(): UsageSettings {
  try {
    const value = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? "{}") as Record<
      string,
      unknown
    >;
    const result = { ...DEFAULT_USAGE_SETTINGS };
    for (const key of Object.keys(result) as Array<keyof UsageSettings>) {
      const item = value?.[key];
      if (typeof item === "number" && Number.isFinite(item) && item > 0) result[key] = item;
    }
    return result;
  } catch {
    return { ...DEFAULT_USAGE_SETTINGS };
  }
}

export function setUsageSettings(next: Partial<UsageSettings>): void {
  settings = { ...settings, ...next };
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // 存不下时只在本次页面生效
  }
  for (const listener of listeners) listener();
}

export function resetUsageSettings(): void {
  settings = { ...DEFAULT_USAGE_SETTINGS };
  try {
    localStorage.removeItem(SETTINGS_STORAGE_KEY);
  } catch {
    // 忽略
  }
  for (const listener of listeners) listener();
}

export function useUsageSettings(): UsageSettings {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => settings,
  );
}

export function modelPrices(): Record<string, ModelPrice> {
  return prices;
}

export function setModelPrice(model: string, price: ModelPrice | undefined): void {
  const next = { ...prices };
  if (price) next[model] = price;
  else delete next[model];
  prices = next;
  try {
    localStorage.setItem(PRICES_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 存不下时只在本次页面生效
  }
  for (const listener of listeners) listener();
}

export function useModelPrices(): Record<string, ModelPrice> {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => prices,
  );
}

/**
 * 估算费用：配置了该模型价格就按价格算，否则用 Runtime 自报的费用（Claude Code 按官方价目估算）；
 * 两者都没有时为 undefined。网关的实际计费可能不同，界面上一律标注为估算。
 */
export function estimateCost(
  usage: UsageBuckets & { reportedCostUsd?: number },
  price: ModelPrice | undefined,
): number | undefined {
  if (price) {
    return (
      (usage.inputTokens * price.input +
        usage.cacheWriteTokens * price.cacheWrite +
        usage.cacheReadTokens * price.cacheRead +
        usage.outputTokens * price.output) /
      1_000_000
    );
  }
  return usage.reportedCostUsd && usage.reportedCostUsd > 0 ? usage.reportedCostUsd : undefined;
}

/** 汇总一组细分的估算费用；有一格既没配价格也没有自报费用时，标记为不完整 */
export function estimateCells(
  cells: Array<UsageTotals & { model: string }>,
  table: Record<string, ModelPrice>,
): { usd: number; complete: boolean } {
  let usd = 0;
  let complete = true;
  for (const cell of cells) {
    const cost = estimateCost(cell, table[cell.model]);
    if (cost === undefined) {
      if (usageInputTokens(cell) + cell.outputTokens > 0) complete = false;
    } else usd += cost;
  }
  return { usd, complete };
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  return String(value);
}

export function formatUsd(value: number | undefined): string {
  if (value === undefined) return "—";
  return value >= 1 ? `$${value.toFixed(2)}` : `$${value.toFixed(3)}`;
}

export function formatRate(rate: number | undefined): string {
  return rate === undefined ? "—" : `${Math.round(rate * 1000) / 10}%`;
}

const likelyLabels: Record<CacheWriteReason, string> = localized(() => ({
  new_session: t("新会话开局，整段写入是正常的"),
  idle_beyond_ttl: t("可能原因：间隔超过缓存有效期，缓存已过期"),
  unknown: t("可能原因：会话压缩、上游换了路由或网关没有命中（间隔在有效期内）"),
}));

function durationLabel(ms: number): string {
  const minutes = ms / 60_000;
  if (minutes >= 90) return t("{0} 小时", { 0: Math.round((minutes / 60) * 10) / 10 });
  return minutes >= 1
    ? t("{0} 分钟", { 0: Math.round(minutes) })
    : t("{0} 秒", { 0: Math.round(ms / 1000) });
}

/**
 * 大额缓存写入的说明：先列观测到的事实（会话、间隔、上一轮的缓存有效期），再给可能原因。
 * 原因只是推测——网关的实际有效期和路由都看不到。
 */
export function describeCacheWrite(
  usage: AgentUsage,
  options: Pick<UsageSettings, "cacheTtlMinutes"> = settings,
): { facts: string[]; likely: string } {
  const fallbackMs = options.cacheTtlMinutes * 60_000;
  const facts: string[] = [];
  if (usage.session === "new") facts.push(t("新会话"));
  if (usage.session === "resumed") {
    facts.push(t("续接会话"));
    if (usage.idleMs !== undefined) {
      facts.push(
        usage.idleBasis === "request"
          ? t("距上次模型请求 {0}", { 0: durationLabel(usage.idleMs) })
          : t("距上一轮结束约 {0}（按回合估算）", { 0: durationLabel(usage.idleMs) }),
      );
    }
    const ttl = cacheTtlFor(usage, fallbackMs);
    facts.push(
      ttl.observed
        ? t("上一轮缓存按 {0} 有效期写入", { 0: durationLabel(ttl.ttlMs) })
        : t("有效期未观测到，按 {0} 假定", { 0: durationLabel(ttl.ttlMs) }),
    );
  }
  return { facts, likely: likelyLabels[cacheWriteReason(usage, fallbackMs)] };
}

const outcomeLabels = localized(() => ({
  completed: "",
  failed: t("本轮以失败结束，用量照常记账"),
  cancelled: t("本轮被停止，停止前的用量照常记账"),
  uncertain: t("本轮结果未知，已收到的用量照常记账"),
}));

/** 调用详情里的本轮用量 */
export function InvocationUsage({ usage }: { usage: AgentUsage }) {
  const table = useModelPrices();
  const options = useUsageSettings();
  const cost = estimateCost(usage, usage.model ? table[usage.model] : undefined);
  const large = usage.peakCacheWriteTokens >= options.cacheWriteAlertTokens;
  const bigSession = usage.peakContextTokens >= options.sessionAlertTokens;
  const first = usage.firstRequest;
  const write = describeCacheWrite(usage, options);
  if (usage.requests === 0) {
    return (
      <section aria-label={t("本轮用量")}>
        <h3>{t("本轮用量")}</h3>
        <p className="invocation-details-description">
          {t("这一轮没有发出模型请求，用量为零。")}
          {usage.outcome ? ` ${outcomeLabels[usage.outcome]}` : ""}
        </p>
      </section>
    );
  }
  return (
    <section aria-label={t("本轮用量")}>
      <h3>
        {t("本轮用量")}{" "}
        <span className="invocation-details-caption">
          {[usage.model, t("{0} 次模型请求", { 0: usage.requests })].filter(Boolean).join(" · ")}
        </span>
      </h3>
      {usage.outcome && usage.outcome !== "completed" && (
        <p className="invocation-details-description">{outcomeLabels[usage.outcome]}</p>
      )}
      {large && (
        <div className="invocation-details-notice warning">
          <strong>
            {t("单次缓存写入 {0} token", { 0: formatTokens(usage.peakCacheWriteTokens) })}
          </strong>
          <p>{t("观测：{0}。", { 0: write.facts.join(t("，")) })}</p>
          <p>{write.likely}</p>
        </div>
      )}
      {bigSession && (
        <p className="invocation-details-notice warning">
          {t(
            "会话已有 {0} token；缓存过期后每次重写都按这个大小计费。可以在房间顶部点「新话题」让 Agent 换新会话。",
            { 0: formatTokens(usage.peakContextTokens) },
          )}
        </p>
      )}
      <dl className="invocation-details-metrics usage-metrics">
        <div>
          <dt>{t("缓存命中率")}</dt>
          <dd>{formatRate(cacheHitRate(usage))}</dd>
        </div>
        <div>
          <dt>{t("估算费用")}</dt>
          <dd>{formatUsd(cost)}</dd>
        </div>
        <div>
          <dt>{t("会话大小")}</dt>
          <dd>
            {formatTokens(usage.peakContextTokens)}
            {usage.contextWindow ? ` / ${formatTokens(usage.contextWindow)}` : ""}
          </dd>
        </div>
        <div>
          <dt>{t("开局请求")}</dt>
          <dd>
            {first
              ? t("读 {0} · 写 {1} · 新 {2}", {
                  0: formatTokens(first.cacheReadTokens),
                  1: formatTokens(first.cacheWriteTokens),
                  2: formatTokens(first.inputTokens),
                })
              : "—"}
          </dd>
        </div>
      </dl>
      <p className="invocation-details-description">
        {t("输入：缓存读取 {0} · 缓存写入 {1} · 未缓存 {2}；输出 {3}。", {
          0: formatTokens(usage.cacheReadTokens),
          1: formatTokens(usage.cacheWriteTokens),
          2: formatTokens(usage.inputTokens),
          3: formatTokens(usage.outputTokens),
        })}{" "}
        {write.facts.join(" · ")}
      </p>
      <p className="invocation-details-description">
        {t("token 数取自 Runtime 返回的真实用量；费用为估算，以模型服务的账单为准。")}
      </p>
    </section>
  );
}

function sumTotals(cells: UsageTotals[]): UsageTotals {
  return cells.reduce<UsageTotals>(
    (sum, cell) => ({
      inputTokens: sum.inputTokens + cell.inputTokens,
      cacheWriteTokens: sum.cacheWriteTokens + cell.cacheWriteTokens,
      cacheReadTokens: sum.cacheReadTokens + cell.cacheReadTokens,
      outputTokens: sum.outputTokens + cell.outputTokens,
      turns: sum.turns + cell.turns,
      requests: sum.requests + cell.requests,
      reportedCostUsd: sum.reportedCostUsd + cell.reportedCostUsd,
      largeCacheWrites: sum.largeCacheWrites + cell.largeCacheWrites,
    }),
    {
      inputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      turns: 0,
      requests: 0,
      reportedCostUsd: 0,
      largeCacheWrites: 0,
    },
  );
}

function Cost({ value }: { value: { usd: number; complete: boolean } }) {
  return (
    <span title={value.complete ? t("估算") : t("部分模型没有配置价格，未计入")}>
      ≈{formatUsd(value.usd)}
      {value.complete ? "" : "+"}
    </span>
  );
}

const PERIODS = [1, 7, 30] as const;

/** 运行时面板里的用量统计：按 Agent、按天汇总，并列出最近的大额缓存写入 */
export function UsageSection({
  roomId,
  load,
  refreshKey,
  participants = [],
  onStartTopic,
}: {
  roomId: string;
  load: (roomId: string, days: number, alertTokens: number) => Promise<UsageSummary>;
  /** 有调用结束时变化，触发重新拉取 */
  refreshKey?: string | number;
  /** 当前房间成员：列出没有用量记录的 Agent */
  participants?: readonly Participant[];
  /** 会话过大时给的入口：开启新话题（房间里所有 Agent 换新会话） */
  onStartTopic?: () => void;
}) {
  const options = useUsageSettings();
  const [days, setDays] = useState<(typeof PERIODS)[number]>(1);
  const [summary, setSummary] = useState<UsageSummary>();
  const [error, setError] = useState(false);
  const [pricing, setPricing] = useState(false);
  const table = useModelPrices();
  const fetchSummary = useCallback(() => {
    let cancelled = false;
    load(roomId, days, options.cacheWriteAlertTokens).then(
      (value) => {
        if (cancelled) return;
        // 旧版服务端没有这个接口，或返回了意外的结构：当作加载失败，不让面板崩溃
        const parsed = usageSummarySchema.safeParse(value);
        setSummary(parsed.success ? parsed.data : undefined);
        setError(!parsed.success);
      },
      () => !cancelled && setError(true),
    );
    return () => {
      cancelled = true;
    };
  }, [days, load, options.cacheWriteAlertTokens, roomId]);
  useEffect(() => fetchSummary(), [fetchSummary, refreshKey]);

  if (error && !summary) {
    return <p className="activity-empty">{t("用量统计加载失败。")}</p>;
  }
  if (!summary) return null;
  const cells = summary.cells;
  const total = estimateCells(cells, table);
  const byDay = [...new Set(cells.map((cell) => cell.day))].map((day) => {
    const list = cells.filter((cell) => cell.day === day);
    return { day, totals: sumTotals(list), cost: estimateCells(list, table) };
  });
  const large = summary.recent.filter(
    (record) => record.usage.peakCacheWriteTokens >= summary.cacheWriteAlertTokens,
  );
  const models = [...new Set(cells.map((cell) => cell.model))];
  const now = Date.now();
  const bigSessions = summary.agents.filter(
    (agent) => (agent.latest?.usage.peakContextTokens ?? 0) >= options.sessionAlertTokens,
  );
  const recorded = new Set(summary.agents.map((agent) => agent.agentId));
  const silent = participants.filter(
    (participant) => participant.type === "agent" && !recorded.has(participant.id),
  );

  return (
    <section className="usage-section" aria-label={t("用量统计")}>
      <h3 className="activity-section-label">
        {t("用量 · 当前房间")}
        <span className="usage-periods" role="group" aria-label={t("统计范围")}>
          {PERIODS.map((period) => (
            <button
              key={period}
              type="button"
              aria-pressed={days === period}
              onClick={() => setDays(period)}
            >
              {period === 1 ? t("24 小时") : t("{0} 天", { 0: period })}
            </button>
          ))}
        </span>
      </h3>
      {summary.totals.turns === 0 ? (
        <p className="activity-empty">{t("这段时间还没有记录到用量。")}</p>
      ) : (
        <>
          <dl className="usage-totals">
            <div>
              <dt>{t("估算费用")}</dt>
              <dd>
                <Cost value={total} />
              </dd>
            </div>
            <div>
              <dt>{t("缓存命中率")}</dt>
              <dd>{formatRate(cacheHitRate(summary.totals))}</dd>
            </div>
            <div>
              <dt>{t("输入 / 输出")}</dt>
              <dd>
                {formatTokens(usageInputTokens(summary.totals))} /{" "}
                {formatTokens(summary.totals.outputTokens)}
              </dd>
            </div>
            <div>
              <dt>{t("回合 / 大额重写")}</dt>
              <dd>
                {summary.totals.turns} / {summary.totals.largeCacheWrites}
              </dd>
            </div>
          </dl>
          <table className="usage-table">
            <thead>
              <tr>
                <th>{t("Agent")}</th>
                <th>{t("命中率")}</th>
                <th title={t("最近一轮第一次请求的输入：决定这轮是续上缓存还是整段重写")}>
                  {t("最近开局")}
                </th>
                <th title={t("最近一轮单次请求的最大上下文")}>{t("会话大小")}</th>
                <th>{t("估算费用")}</th>
              </tr>
            </thead>
            <tbody>
              {summary.agents.map((agent) => {
                const latest = agent.latest?.usage;
                const first = latest?.firstRequest;
                return (
                  <tr key={agent.agentId}>
                    <th scope="row">@{agent.agentName}</th>
                    <td>{formatRate(cacheHitRate(agent))}</td>
                    <td>
                      {first ? formatTokens(usageInputTokens({ ...first, outputTokens: 0 })) : "—"}
                    </td>
                    <td
                      className={
                        latest && latest.peakContextTokens >= options.sessionAlertTokens
                          ? "usage-over"
                          : undefined
                      }
                    >
                      {latest ? formatTokens(latest.peakContextTokens) : "—"}
                    </td>
                    <td>
                      <Cost
                        value={estimateCells(
                          cells.filter((cell) => cell.agentId === agent.agentId),
                          table,
                        )}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {bigSessions.length > 0 && (
            <div className="usage-alerts">
              <h4>
                {t("会话偏大（≥ {0} token）", { 0: formatTokens(options.sessionAlertTokens) })}
              </h4>
              <p>
                {t(
                  "{0} 的会话已经很大，缓存过期后每次重写都按这个大小计费。建议开新话题：房间里的 Agent 都会换新会话，历史消息保留，需要时可以再读。",
                  { 0: bigSessions.map((agent) => `@${agent.agentName}`).join("、") },
                )}
              </p>
              {onStartTopic && (
                <button type="button" className="usage-action" onClick={onStartTopic}>
                  {t("开启新话题")}
                </button>
              )}
            </div>
          )}
          {byDay.length > 1 && (
            <table className="usage-table">
              <thead>
                <tr>
                  <th>{t("日期")}</th>
                  <th>{t("回合")}</th>
                  <th>{t("命中率")}</th>
                  <th>{t("估算费用")}</th>
                </tr>
              </thead>
              <tbody>
                {byDay.map((row) => (
                  <tr key={row.day}>
                    <th scope="row">{row.day}</th>
                    <td>{row.totals.turns}</td>
                    <td>{formatRate(cacheHitRate(row.totals))}</td>
                    <td>
                      <Cost value={row.cost} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {large.length > 0 && (
            <div className="usage-alerts">
              <h4>
                {t("大额缓存写入（单次 ≥ {0} token）", {
                  0: formatTokens(summary.cacheWriteAlertTokens),
                })}
              </h4>
              <ul>
                {large.slice(0, 10).map((record) => (
                  <LargeWrite
                    key={`${record.invocationId}-${record.createdAt}`}
                    record={record}
                    now={now}
                  />
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      {silent.length > 0 && (
        <p className="usage-note">
          {t(
            "没有用量记录：{0}。可能是这种 Runtime 还没接入用量采集，或 Agent 还在用旧版本（重启后生效）。",
            { 0: silent.map((participant) => `@${participant.username}`).join("、") },
          )}
        </p>
      )}
      <details
        className="usage-pricing"
        open={pricing}
        onToggle={(event) => setPricing(event.currentTarget.open)}
      >
        <summary>{t("价格与提醒设置")}</summary>
        <SettingsRows key={JSON.stringify(options)} value={options} />
        <h4>{t("价格（每百万 token，美元）")}</h4>
        <p>
          {t(
            "价格只保存在本浏览器。没有配置的模型用 Runtime 自报的费用（Claude Code 按官方价目估算，Codex 不提供）；网关实际计费可能不同。",
          )}
        </p>
        {models.length === 0 && <p>{t("记录到用量后，这里会列出用到的模型。")}</p>}
        {models.map((model) => (
          <PriceRow key={model} model={model} price={table[model]} />
        ))}
      </details>
    </section>
  );
}

function LargeWrite({ record, now }: { record: UsageRecord; now: number }) {
  const write = describeCacheWrite(record.usage, useUsageSettings());
  return (
    <li>
      <strong>@{record.agentName}</strong>{" "}
      {t("写入 {0}", { 0: formatTokens(record.usage.peakCacheWriteTokens) })} ·{" "}
      {write.facts.join(" · ")}{" "}
      <time dateTime={record.createdAt}>{formatRelativeTime(record.createdAt, now)}</time>
      <div className="usage-likely">{write.likely}</div>
    </li>
  );
}

const SETTING_FIELDS = localized(() => [
  {
    key: "cacheTtlMinutes" as const,
    label: t("假定缓存有效期（分钟）"),
    hint: t("只在没观测到写入类型时用于推测原因"),
  },
  { key: "cacheWriteAlertTokens" as const, label: t("大额缓存写入提醒（token）"), hint: "" },
  { key: "sessionAlertTokens" as const, label: t("会话偏大提醒（token）"), hint: "" },
]);

function SettingsRows({ value }: { value: UsageSettings }) {
  return (
    <fieldset className="usage-price-row usage-settings-row">
      <legend>{t("提醒")}</legend>
      {SETTING_FIELDS.map((field) => (
        <label key={field.key} title={field.hint || undefined}>
          <span>{field.label}</span>
          <input
            type="number"
            min="1"
            step="any"
            inputMode="decimal"
            defaultValue={value[field.key]}
            onBlur={(event) => {
              const parsed = Number.parseFloat(event.currentTarget.value);
              if (Number.isFinite(parsed) && parsed > 0) setUsageSettings({ [field.key]: parsed });
              else event.currentTarget.value = String(value[field.key]);
            }}
          />
        </label>
      ))}
      <button type="button" className="usage-action" onClick={resetUsageSettings}>
        {t("恢复默认")}
      </button>
    </fieldset>
  );
}

const PRICE_FIELDS = localized(() => [
  { key: "input" as const, label: t("输入") },
  { key: "cacheWrite" as const, label: t("缓存写入") },
  { key: "cacheRead" as const, label: t("缓存读取") },
  { key: "output" as const, label: t("输出") },
]);

function PriceRow({ model, price }: { model: string; price: ModelPrice | undefined }) {
  const [draft, setDraft] = useState<Record<keyof ModelPrice, string>>(() => ({
    input: price ? String(price.input) : "",
    cacheWrite: price ? String(price.cacheWrite) : "",
    cacheRead: price ? String(price.cacheRead) : "",
    output: price ? String(price.output) : "",
  }));
  const save = () => {
    const values = Object.values(draft);
    if (values.every((value) => value.trim() === "")) {
      setModelPrice(model, undefined);
      return;
    }
    const parsed = Object.fromEntries(
      Object.entries(draft).map(([key, value]) => [key, Number.parseFloat(value)]),
    ) as ModelPrice;
    if (Object.values(parsed).every((value) => Number.isFinite(value) && value >= 0)) {
      setModelPrice(model, parsed);
    }
  };
  return (
    <fieldset className="usage-price-row">
      <legend>{model}</legend>
      {PRICE_FIELDS.map((field) => (
        <label key={field.key}>
          <span>{field.label}</span>
          <input
            type="number"
            min="0"
            step="any"
            inputMode="decimal"
            value={draft[field.key]}
            onChange={(event) => setDraft({ ...draft, [field.key]: event.target.value })}
            onBlur={save}
          />
        </label>
      ))}
    </fieldset>
  );
}
