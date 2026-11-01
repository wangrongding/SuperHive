/**
 * 「边玩边迭代」开发模式的运行状态契约。
 * 外层 dev supervisor 把状态原子写入仓库根目录 `.superhive-dev/status.json`，
 * Vite 开发服务器（不随 Hive Server 重启）提供查询接口，页面轮询读取，所以 Server 重启或启动失败时页面仍能看到状态。
 */
export const DEV_STATUS_PATH = "/__hive-dev/status";

export type DevUpdateState = "pending" | "building" | "restarting" | "ready" | "failed";

export interface DevStatus {
  /** 每次开始一轮更新加一；页面靠它判断是否已运行最新代码 */
  generation: number;
  state: DevUpdateState;
  updatedAt: string;
  /** 本轮触发更新的文件，相对仓库根目录 */
  changedFiles?: string[];
  /** 失败时的错误摘要 */
  error?: string | null;
}

const STATES = new Set<DevUpdateState>(["pending", "building", "restarting", "ready", "failed"]);

export function parseDevStatus(value: unknown): DevStatus | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.generation !== "number" || !Number.isFinite(record.generation))
    return undefined;
  if (typeof record.state !== "string" || !STATES.has(record.state as DevUpdateState))
    return undefined;
  return {
    generation: record.generation,
    state: record.state as DevUpdateState,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
    changedFiles: Array.isArray(record.changedFiles)
      ? record.changedFiles.filter((file): file is string => typeof file === "string")
      : [],
    error: typeof record.error === "string" ? record.error : null,
  };
}

/**
 * 代次与页面加载时不同且已就绪，才需要整页刷新。
 * 用不等而非大于：状态文件被重建、代次回退时也能跟上实际运行的版本。
 */
export function shouldReload(baselineGeneration: number | undefined, status: DevStatus): boolean {
  return (
    baselineGeneration !== undefined &&
    status.state === "ready" &&
    status.generation !== baselineGeneration
  );
}
