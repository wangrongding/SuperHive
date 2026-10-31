import type { AgentUsage, UsageBuckets } from "./hive-protocol.js";

const MAX_TOKENS = 1_000_000_000_000;
const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), MAX_TOKENS)
    : 0;

/**
 * 汇总一轮里每次模型请求的真实用量。只保留 token 数、模型名和 Runtime 自报费用，
 * 不含任何正文；同一请求会多次上报（流式开始、结束、完整消息），按请求 ID 取各桶最大值。
 */
export class UsageAccumulator {
  private readonly requests = new Map<string, UsageBuckets>();
  private order: string[] = [];
  private model: string | undefined;
  private contextWindow: number | undefined;

  request(id: string, usage: Partial<UsageBuckets>): void {
    if (!this.requests.has(id)) {
      if (this.requests.size >= 10_000) return;
      this.order.push(id);
      this.requests.set(id, {
        inputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
      });
    }
    const current = this.requests.get(id)!;
    for (const key of [
      "inputTokens",
      "cacheWriteTokens",
      "cacheReadTokens",
      "outputTokens",
    ] as const) {
      current[key] = Math.max(current[key], count(usage[key]));
    }
  }

  setModel(model: unknown): void {
    // Claude Code 本地生成的错误提示用 <synthetic> 作模型名，不是真实调用
    if (typeof model === "string" && model.trim() && !model.startsWith("<")) {
      this.model = model.trim().slice(0, 120);
    }
  }

  setContextWindow(tokens: unknown): void {
    const value = count(tokens);
    if (value) this.contextWindow = value;
  }

  finish(): AgentUsage | undefined {
    const requests = this.order.map((id) => this.requests.get(id)!);
    const summed = requests.reduce<UsageBuckets>(
      (sum, item) => ({
        inputTokens: sum.inputTokens + item.inputTokens,
        cacheWriteTokens: sum.cacheWriteTokens + item.cacheWriteTokens,
        cacheReadTokens: sum.cacheReadTokens + item.cacheReadTokens,
        outputTokens: sum.outputTokens + item.outputTokens,
      }),
      { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 },
    );
    const totals = summed;
    const total =
      totals.inputTokens + totals.cacheWriteTokens + totals.cacheReadTokens + totals.outputTokens;
    if (total === 0) return undefined;
    const context = (item: UsageBuckets) =>
      item.inputTokens + item.cacheWriteTokens + item.cacheReadTokens;
    const first = requests[0];
    return {
      ...(this.model ? { model: this.model } : {}),
      inputTokens: Math.min(totals.inputTokens, MAX_TOKENS),
      cacheWriteTokens: Math.min(totals.cacheWriteTokens, MAX_TOKENS),
      cacheReadTokens: Math.min(totals.cacheReadTokens, MAX_TOKENS),
      outputTokens: Math.min(totals.outputTokens, MAX_TOKENS),
      requests: requests.length,
      ...(first
        ? {
            firstRequest: {
              inputTokens: first.inputTokens,
              cacheWriteTokens: first.cacheWriteTokens,
              cacheReadTokens: first.cacheReadTokens,
            },
          }
        : {}),
      peakContextTokens: Math.max(...requests.map(context)),
      peakCacheWriteTokens: Math.max(...requests.map((item) => item.cacheWriteTokens)),
      ...(this.contextWindow ? { contextWindow: this.contextWindow } : {}),
    };
  }
}

/** Anthropic 风格 usage：input_tokens 已不含缓存部分 */
export function anthropicBuckets(value: unknown): Partial<UsageBuckets> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  return {
    inputTokens: count(usage.input_tokens),
    cacheWriteTokens: count(usage.cache_creation_input_tokens),
    cacheReadTokens: count(usage.cache_read_input_tokens),
    outputTokens: count(usage.output_tokens),
  };
}

/** OpenAI/Codex 风格 usage：inputTokens 包含命中缓存的部分，这里拆成互斥的桶 */
export function codexBuckets(value: unknown): Partial<UsageBuckets> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  const cached = count(usage.cachedInputTokens);
  const written = count(usage.cacheWriteInputTokens);
  return {
    inputTokens: Math.max(0, count(usage.inputTokens) - cached - written),
    cacheWriteTokens: written,
    cacheReadTokens: cached,
    outputTokens: count(usage.outputTokens),
  };
}
