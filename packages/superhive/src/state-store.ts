import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PromptContextSnapshot } from "./prompt-context.js";

export type AgentState = {
  serverUrl: string;
  roomId: string;
  username: string;
  threadId?: string;
  lastProcessedSeq: number;
  processedMessageIds: string[];
  /**
   * 调用 Provider 之前先落盘的执行意图（参考 yobiru 的 write-ahead intent）。
   * 进程在执行途中退出时据此得知"结果未知"，不会在重启后盲目重跑可能有副作用的任务。
   */
  inflight?: {
    executionId: string;
    messageIds: string[];
    startedAt: string;
  };
  /** 距上次发送完整上下文（成员、白板、规则提示）以来的轮数与时间，用于提示节流 */
  briefTurns?: number;
  lastFullPromptAt?: string;
  /** Legacy fingerprint, ignored after migrating to rendered semantic snapshots. */
  whiteboardDigest?: string;
  /** Last successfully sent context, bound to the provider thread (not the Bridge process). */
  promptContext?: {
    threadId: string;
    whiteboard?: PromptContextSnapshot;
    members?: PromptContextSnapshot;
  };
  /** 会话里最近一次注入的规则指纹；规则变了（升级、改角色）就立即重新注入 */
  instructionsDigest?: string;
  /** 当前 Provider 会话所属话题的起点（话题分隔消息的 seq）；遇到更新的分隔就换新会话 */
  topicSeq?: number;
  /** 当前 Provider 会话所在的工作目录；房间换了工作区就换新会话 */
  workspace?: string;
  /** 上一轮模型调用结束的时间；用量统计据此判断提示缓存是否可能已经过期 */
  lastTurnEndedAt?: string;
  /** 上一轮最后一次模型请求的时间，用来算本轮第一次请求前空闲了多久 */
  lastRequestAt?: string;
  /** 上一轮写入缓存的有效期（观测到 1 小时写入为 3600000）；Runtime 不区分时为空 */
  lastCacheTtlMs?: number;
  /** Runtime 自报的会话累计费用，按会话记录，用来算出每一轮的费用 */
  sessionCost?: { threadId: string; usd: number };
};

/**
 * 只读 Agent 的默认工作目录：每个 Agent 身份固定一个空目录，而不是每次启动随机创建。
 * opencode、omp、Claude Code 等按工作目录存放会话，目录固定后重启才能恢复原会话。
 */
export function agentWorkspaceDir(
  stateDir: string,
  identity: { serverUrl: string; username: string; provider: string },
): string {
  const key = createHash("sha256")
    .update(`${identity.serverUrl}\0${identity.username.toLocaleLowerCase()}\0${identity.provider}`)
    .digest("hex")
    .slice(0, 20);
  const dir = path.join(stateDir, "workspaces", key);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export class StateStore {
  readonly filename: string;
  /** 同一个状态文件的写入串行执行，避免并发保存时互相覆盖或抢同一个临时文件 */
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly stateDir: string,
    identity: {
      serverUrl: string;
      roomId: string;
      username: string;
      provider?: string;
      access?: string;
    },
  ) {
    const providerKey =
      identity.provider && identity.provider !== "codex" ? `\0${identity.provider}` : "";
    const accessKey =
      identity.access && identity.access !== "read-only" ? `\0${identity.access}` : "";
    const key = createHash("sha256")
      .update(
        `${identity.serverUrl}\0${identity.roomId}\0${identity.username.toLocaleLowerCase()}${providerKey}${accessKey}`,
      )
      .digest("hex")
      .slice(0, 20);
    this.filename = path.join(stateDir, `${key}.json`);
  }

  async load(): Promise<AgentState | undefined> {
    try {
      const data = JSON.parse(await readFile(this.filename, "utf8")) as AgentState;
      if (
        typeof data.serverUrl !== "string" ||
        typeof data.roomId !== "string" ||
        typeof data.username !== "string" ||
        !Number.isInteger(data.lastProcessedSeq) ||
        !Array.isArray(data.processedMessageIds) ||
        (data.inflight !== undefined &&
          (typeof data.inflight.executionId !== "string" ||
            !Array.isArray(data.inflight.messageIds)))
      ) {
        throw new Error("State file has an invalid shape.");
      }
      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error(`无法读取 Agent 状态文件 ${this.filename}: ${String(error)}`);
    }
  }

  save(state: AgentState): Promise<void> {
    // 在排队时就取快照：调用方之后继续修改 state 不影响这次写入的内容
    const content = `${JSON.stringify(state, null, 2)}\n`;
    const write = this.writes.then(async () => {
      await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
      const temporary = `${this.filename}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, content, { mode: 0o600 });
      await rename(temporary, this.filename);
      await chmod(this.filename, 0o600);
    });
    this.writes = write.catch(() => undefined);
    return write;
  }
}
