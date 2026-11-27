import { createHash } from "node:crypto";
import { mcpHealthSchema, type McpHealth, type McpProblem } from "@superhive/protocol";
import { z } from "zod";

/**
 * 每个 MCP 最近一次「测能不能用」的结果（装完自动测、在列表里点「再测一次」）。
 *
 * 按 MCP 名字记，同时记下测的那份启动配置的指纹（含密钥的配置只取哈希，不存原文）：
 * 之后有人在 Hive 外改了配置、换了密钥，指纹对不上，旧结果就不再显示，免得一直挂着过时的「需要登录」。
 * 存在 Server 的小设置里，重启后角标还在；读写失败不影响安装本身。
 */

export type McpHealthPersistence = {
  read(): string | undefined;
  write(value: string): void;
};

/** 测量进程的输出（见 superhive 的 `hive mcp check`） */
export type McpMeasurementOutput =
  { ok: true; tools: number; tokens: number } | { ok: false; error: string; problem?: McpProblem };

const recordSchema = z.object({ fingerprint: z.string(), health: mcpHealthSchema });
const fileSchema = z.record(z.string(), recordSchema);

/** 只保留这么多条，避免装了又删的名字越积越多 */
const MAX_RECORDS = 200;

/** 启动配置的指纹：键排好序再哈希，同样的配置写在不同 CLI 里得到同一个值 */
export function mcpFingerprint(launch: { transport: string; config: Record<string, unknown> }) {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.keys(value as Record<string, unknown>)
          .sort()
          .map((key) => [key, stable((value as Record<string, unknown>)[key])]),
      );
    }
    return value;
  };
  return createHash("sha256")
    .update(JSON.stringify(stable(launch)))
    .digest("hex")
    .slice(0, 32);
}

export function toHealth(measurement: McpMeasurementOutput, checkedAt: number): McpHealth {
  if (measurement.ok) {
    return { ok: true, tools: measurement.tools, tokens: measurement.tokens, checkedAt };
  }
  return {
    ok: false,
    // 旧版 CLI 不分类：按起不来算，原因照原样给
    problem: measurement.problem ?? "failed",
    reason: measurement.error.slice(0, 300),
    checkedAt,
  };
}

export class McpHealthStore {
  private records = new Map<string, z.infer<typeof recordSchema>>();

  constructor(private readonly persistence?: McpHealthPersistence) {
    try {
      const raw = persistence?.read();
      const parsed = raw ? fileSchema.safeParse(JSON.parse(raw)) : undefined;
      if (parsed?.success) this.records = new Map(Object.entries(parsed.data));
    } catch {
      // 存的东西读不懂就当没测过
    }
  }

  set(name: string, fingerprint: string, health: McpHealth) {
    this.records.delete(name);
    this.records.set(name, { fingerprint, health });
    while (this.records.size > MAX_RECORDS) {
      this.records.delete(this.records.keys().next().value!);
    }
    this.save();
  }

  /** 配置还是测的那一份时返回结果；fingerprints 是这个名字在各 CLI 里的当前指纹 */
  get(name: string, fingerprints: Iterable<string>): McpHealth | undefined {
    const record = this.records.get(name);
    if (!record) return undefined;
    for (const fingerprint of fingerprints) {
      if (fingerprint === record.fingerprint) return record.health;
    }
    return undefined;
  }

  has(name: string) {
    return this.records.has(name);
  }

  private save() {
    try {
      this.persistence?.write(JSON.stringify(Object.fromEntries(this.records)));
    } catch {
      // 存不下只影响重启后角标还在不在
    }
  }
}
