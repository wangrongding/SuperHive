import { userFsPromises } from "./user-fs.js";
import type { HiveMcpConnection } from "./hive-mcp-config.js";
import { hiveMcpHeaders } from "./hive-mcp-config.js";
import { AgentNonRetryableError, AgentTransientError } from "./responder.js";

const { realpath, stat } = userFsPromises;

export class TaskWorkspaceRemovedError extends Error {
  constructor(readonly path: string) {
    super(`The task workspace was cleaned up: ${path}`);
  }
}

export type TaskWorkspaceSelection = string | TaskWorkspaceRemovedError | undefined;

/**
 * Server 没有沿用这个 Agent「上次用的任务目录」（目录被换了分支、挪走等）：这次在默认目录开工，
 * Bridge 要把原因写进提示和任务卡片，不能让 Agent 不知情地在默认目录里改代码。
 */
export type TaskWorkspaceNotice = { kind: "focus_dropped"; path: string; reason: string };
/**
 * settled：这一轮已经跑完，只是复核执行期间有没有换任务目录。合并的几条消息里，有的可能中途就结束了
 * （提问被人先回答、续到了新调用，或被人停止），Server 照常按这个 Agent 自己的调用回目录，不当成不能开工
 */
export type TaskWorkspaceLookupOptions = { settled?: boolean };
export type TaskWorkspaceNoticeSink = (messageId: string, notice: TaskWorkspaceNotice) => void;

/**
 * Server 给的原因会进任务卡片和提示：截短、压成一行，去掉像凭据的片段（Bearer/token=…、环境变量赋值、
 * 长串密钥样的字符），只留路径、分支名和说明文字。
 */
export function sanitizeServerReason(text: string, limit = 400): string {
  const cleaned = text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\b(bearer|basic)\s+[^\s,;]+/gi, "$1 [redacted]")
    .replace(
      /\b(token|secret|password|passwd|api[_-]?key|authorization|cookie)\b(\s*[:=]\s*)[^\s,;]+/gi,
      "$1$2[redacted]",
    )
    .replace(/\b[A-Z][A-Z0-9_]{2,}=[^\s,;]+/g, (match) => `${match.split("=")[0]}=[redacted]`)
    .replace(/\b(?:sk|pk|ghp|gho|xox[a-z])[-_][A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/(?<![\w/.-])[A-Za-z0-9+_-]{40,}={0,2}(?![\w/.-])/g, (match) =>
      /^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(match) ? match : "[redacted]",
    )
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > limit ? `${cleaned.slice(0, limit - 1)}…` : cleaned;
}

function readNotice(value: unknown): TaskWorkspaceNotice | undefined {
  const notice = value as { kind?: unknown; path?: unknown; reason?: unknown } | undefined;
  if (
    !notice ||
    notice.kind !== "focus_dropped" ||
    typeof notice.path !== "string" ||
    typeof notice.reason !== "string"
  )
    return undefined;
  return {
    kind: "focus_dropped",
    path: sanitizeServerReason(notice.path, 300),
    reason: sanitizeServerReason(notice.reason),
  };
}

/**
 * 暂时没能确认任务目录：Server 忙（排在写操作后面等锁超时、git 超时）或连不上。
 * 不说明哪里不安全，这一轮也还没开始执行；已经自动重试过，稍后再试即可。
 */
export class TaskWorkspaceBusyError extends AgentTransientError {
  constructor(
    readonly reason: string,
    options?: ErrorOptions,
  ) {
    super(`Task workspace lookup is busy: ${reason}`, options);
    this.name = "TaskWorkspaceBusyError";
  }
}

/**
 * 暂时忙时的重试节奏：每次最多等 17 秒，两次之间隔 2、4 秒，三次合计约 57 秒。
 * Server 说这个 Agent 不在线（刚重启、Bridge 还没重连上）时另算：按同样的间隔、之后每 4 秒再问一次，
 * 最多等 reconnectMs（默认 60 秒）。
 */
export type TaskWorkspaceRetry = {
  attempts: number;
  timeoutMs: number;
  delaysMs: number[];
  reconnectMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const DEFAULT_RETRY: TaskWorkspaceRetry = {
  attempts: 3,
  timeoutMs: 17_000,
  delaysMs: [2_000, 4_000],
  reconnectMs: 60_000,
};

/** Server 明确说忙（503）、网关/限流类状态，或请求超时、连不上：都是等一会儿可能就好 */
class TransientLookupError extends Error {}

function transient(error: unknown): boolean {
  if (error instanceof TransientLookupError) return true;
  if (!(error instanceof Error)) return false;
  if (error.name === "TimeoutError" || error.name === "AbortError") return true;
  // fetch 连不上时抛 TypeError("fetch failed")，具体原因在 cause 里
  return error instanceof TypeError && /fetch failed|network/i.test(error.message);
}

/**
 * Server 回 401「Online local agent required」：它这时没看到这个 Agent 在线。合入后 Server 自动重启、
 * Bridge 还没重连上时就是这样，等它重连上再问就好，不说明目录有什么不安全。
 * 别的 401/403（身份不符、只读、目录被换）照旧直接拒绝。
 */
class AgentOfflineLookupError extends Error {}

const AGENT_OFFLINE = "Online local agent required";

/** 带上 Server 给的原因（目录被换了分支等），否则人只看得到一个状态码，不知道该去哪里修 */
async function refusal(response: Response): Promise<string> {
  const body = (await response.json().catch(() => undefined)) as
    { error?: unknown; code?: unknown } | undefined;
  return describeRefusal(body);
}

function describeRefusal(body: { error?: unknown; code?: unknown } | undefined): string {
  if (typeof body?.error !== "string" || !body.error.trim()) return "";
  const code =
    typeof body.code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(body.code)
      ? `${body.code}: `
      : "";
  return `: ${code}${sanitizeServerReason(body.error)}`;
}

async function lookup<Body>(
  hive: HiveMcpConnection,
  init: { url: string; method?: string; body?: string },
  retry: TaskWorkspaceRetry,
): Promise<Body> {
  const sleep = retry.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = retry.now ?? Date.now;
  const reconnectBy = now() + (retry.reconnectMs ?? 0);
  let attempt = 1;
  let offlineWaits = 0;
  for (;;) {
    try {
      const response = await fetch(init.url, {
        ...(init.method ? { method: init.method } : {}),
        headers: init.body
          ? { ...hiveMcpHeaders(hive), "content-type": "application/json" }
          : hiveMcpHeaders(hive),
        ...(init.body ? { body: init.body } : {}),
        signal: AbortSignal.timeout(retry.timeoutMs),
      });
      // 带上 Server 给的原因（比如在限时内没查完任务目录），人和日志里看得出忙在哪
      if ([429, 502, 503, 504].includes(response.status))
        throw new TransientLookupError(
          `Hive Server is busy (${response.status})${await refusal(response)}`,
        );
      if (response.status === 401) {
        const body = (await response.json().catch(() => undefined)) as
          { error?: unknown; code?: unknown } | undefined;
        const message = `Cannot verify managed task workspace (401)${describeRefusal(body)}`;
        throw body?.error === AGENT_OFFLINE
          ? new AgentOfflineLookupError(message)
          : new Error(message);
      }
      if (!response.ok)
        throw new Error(
          `Cannot verify managed task workspace (${response.status})${await refusal(response)}`,
        );
      return (await response.json()) as Body;
    } catch (error) {
      if (error instanceof AgentOfflineLookupError) {
        const delay = retry.delaysMs[offlineWaits] ?? retry.delaysMs.at(-1) ?? 0;
        // 等不到重连：按原样报，交人核对
        if (now() + delay > reconnectBy) throw error;
        offlineWaits += 1;
        await sleep(delay);
        continue;
      }
      if (!transient(error)) throw error;
      if (attempt >= retry.attempts)
        throw new TaskWorkspaceBusyError(
          `${error instanceof Error ? error.message : String(error)} (after ${attempt} attempts)`,
          { cause: error },
        );
      await sleep(retry.delaysMs[attempt - 1] ?? retry.delaysMs.at(-1) ?? 0);
      attempt += 1;
    }
  }
}

/** 身份不符、目录被换、回执不对：选不准目录就不能开工，直接失败，交给人核对 */
function unsafe(error: unknown, plural: boolean): Error {
  if (error instanceof TaskWorkspaceBusyError) return error;
  return new AgentNonRetryableError(
    `Cannot safely select the task workspace${plural ? "s" : ""}; confirm before retrying: ${error instanceof Error ? error.message : String(error)}`,
    { cause: error },
  );
}

export async function resolveTaskWorkspace(
  hive: HiveMcpConnection,
  messageId: string,
  retry: TaskWorkspaceRetry = DEFAULT_RETRY,
  onNotice?: TaskWorkspaceNoticeSink,
): Promise<TaskWorkspaceSelection> {
  try {
    const value = await lookup<{ worktree?: unknown; notice?: unknown }>(
      hive,
      { url: `${hive.serverUrl}/api/agent/worktree?messageId=${encodeURIComponent(messageId)}` },
      retry,
    );
    const selection = await verifyWorkspace(hive, value.worktree);
    const notice = selection === undefined ? readNotice(value.notice) : undefined;
    if (notice) onNotice?.(messageId, notice);
    return selection;
  } catch (error) {
    throw unsafe(error, false);
  }
}

async function verifyWorkspace(
  hive: HiveMcpConnection,
  value: unknown,
): Promise<TaskWorkspaceSelection> {
  if (value === null) return undefined;
  const record = value as
    | { id?: unknown; path?: unknown; agentName?: unknown; roomId?: unknown; removed?: unknown }
    | undefined;
  if (
    !record ||
    typeof record.path !== "string" ||
    record.agentName !== hive.username ||
    record.roomId !== hive.roomId
  )
    throw new Error("Invalid managed task workspace identity");
  if (record.removed === true) {
    if (
      typeof record.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(record.id)
    )
      throw new Error("Invalid managed task workspace removal receipt");
    return new TaskWorkspaceRemovedError(record.path);
  }
  if ((await realpath(record.path)) !== record.path || !(await stat(record.path)).isDirectory())
    throw new Error("Managed task workspace has changed");
  return record.path;
}

export async function resolveTaskWorkspaces(
  hive: HiveMcpConnection,
  messageIds: string[],
  retry: TaskWorkspaceRetry = DEFAULT_RETRY,
  onNotice?: TaskWorkspaceNoticeSink,
  options: TaskWorkspaceLookupOptions = {},
): Promise<Map<string, TaskWorkspaceSelection>> {
  try {
    const value = await lookup<{
      worktrees?: Record<string, unknown>;
      notices?: Record<string, unknown>;
    }>(
      hive,
      {
        url: `${hive.serverUrl}/api/agent/worktree`,
        method: "POST",
        body: JSON.stringify({ messageIds, ...(options.settled ? { settled: true } : {}) }),
      },
      retry,
    );
    const verified = new Map<unknown, Promise<TaskWorkspaceSelection>>();
    return new Map(
      await Promise.all(
        messageIds.map(async (id): Promise<[string, TaskWorkspaceSelection]> => {
          if (!value.worktrees || !Object.hasOwn(value.worktrees, id))
            throw new Error("Incomplete managed task workspace response");
          const record = value.worktrees[id];
          const key = record === null ? null : JSON.stringify(record);
          let selection = verified.get(key);
          if (!selection) {
            selection = verifyWorkspace(hive, record);
            verified.set(key, selection);
          }
          const resolved = await selection;
          const notice =
            resolved === undefined && value.notices && Object.hasOwn(value.notices, id)
              ? readNotice(value.notices[id])
              : undefined;
          if (notice) onNotice?.(id, notice);
          return [id, resolved];
        }),
      ),
    );
  } catch (error) {
    throw unsafe(error, true);
  }
}
