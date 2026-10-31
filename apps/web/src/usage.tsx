import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  DEFAULT_CACHE_WRITE_ALERT_TOKENS,
  cacheHitRate,
  cacheWriteReason,
  usageInputTokens,
  usageSummarySchema,
  type AgentUsage,
  type CacheWriteReason,
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

const reasonLabels: Record<CacheWriteReason, string> = localized(() => ({
  new_session: t("新会话开局"),
  cache_expired: t("空闲超过缓存有效期"),
  unknown: t("原因不明（可能是会话压缩或上游换了路由）"),
}));

export function cacheWriteReasonLabel(usage: AgentUsage): string {
  return reasonLabels[cacheWriteReason(usage)];
}

function idleLabel(ms: number | undefined): string | undefined {
  if (ms === undefined) return undefined;
  const minutes = ms / 60_000;
  return minutes >= 1
    ? t("距上一轮 {0} 分钟", { 0: Math.round(minutes) })
    : t("距上一轮 {0} 秒", { 0: Math.round(ms / 1000) });
}

/** 调用详情里的本轮用量 */
export function InvocationUsage({ usage }: { usage: AgentUsage }) {
  const table = useModelPrices();
  const cost = estimateCost(usage, usage.model ? table[usage.model] : undefined);
  const large = usage.peakCacheWriteTokens >= DEFAULT_CACHE_WRITE_ALERT_TOKENS;
  const first = usage.firstRequest;
  return (
    <section aria-label={t("本轮用量")}>
      <h3>
        {t("本轮用量")}{" "}
        <span className="invocation-details-caption">
          {[usage.model, t("{0} 次模型请求", { 0: usage.requests })].filter(Boolean).join(" · ")}
        </span>
      </h3>
      {large && (
        <p className="invocation-details-notice warning">
          {t("单次缓存写入 {0} token：{1}。", {
            0: formatTokens(usage.peakCacheWriteTokens),
            1: cacheWriteReasonLabel(usage),
          })}
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
        {[
          usage.session === "new" ? t("新会话") : usage.session === "resumed" ? t("续接会话") : "",
          idleLabel(usage.idleMs),
        ]
          .filter(Boolean)
          .join(" · ")}
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
}: {
  roomId: string;
  load: (roomId: string, days: number) => Promise<UsageSummary>;
  /** 有调用结束时变化，触发重新拉取 */
  refreshKey?: string | number;
}) {
  const [days, setDays] = useState<(typeof PERIODS)[number]>(1);
  const [summary, setSummary] = useState<UsageSummary>();
  const [error, setError] = useState(false);
  const [pricing, setPricing] = useState(false);
  const table = useModelPrices();
  const fetchSummary = useCallback(() => {
    let cancelled = false;
    load(roomId, days).then(
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
  }, [days, load, roomId]);
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
                    <td>{latest ? formatTokens(latest.peakContextTokens) : "—"}</td>
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
                  <LargeWrite key={record.invocationId} record={record} now={now} />
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      <details
        className="usage-pricing"
        open={pricing}
        onToggle={(event) => setPricing(event.currentTarget.open)}
      >
        <summary>{t("价格设置（每百万 token，美元）")}</summary>
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
  return (
    <li>
      <strong>@{record.agentName}</strong>{" "}
      {t("写入 {0}", { 0: formatTokens(record.usage.peakCacheWriteTokens) })} ·{" "}
      {cacheWriteReasonLabel(record.usage)}
      {record.usage.idleMs !== undefined && record.usage.session === "resumed"
        ? ` · ${idleLabel(record.usage.idleMs)}`
        : ""}{" "}
      <time dateTime={record.createdAt}>{formatRelativeTime(record.createdAt, now)}</time>
    </li>
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
