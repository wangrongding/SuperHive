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
  /**
   * 当前会话属于哪一道（见 docs/research/task-scoped-sessions.md）：没有就是房间主对话 main，
   * 否则是开启那件子任务的委派调用 ID。别的道的会话收在 parkedSessions 里。
   */
  lane?: string;
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
    /** 这些提及里最小的 seq：重启后补拉原文从它之前开始，不受 lastProcessedSeq 已越过它影响 */
    minSeq?: number;
    /** 本轮第一次出现可能有副作用的操作时落盘；没有它，重启后才敢自动重跑 */
    mutated?: boolean;
    /** 本轮期间活着的运行时子进程；重启时还有没退出的，说明旧回合可能仍在执行 */
    runtimePids?: number[];
    /** 运行时报出的会话 ID：进程中途退出后可以接着这个会话继续，会话里记着已经做到哪 */
    threadId?: string;
    /** 这一轮开始时的工作目录：中断后若会话接不上（比如已切到新任务目录），新会话要知道去哪核对 */
    cwd?: string;
    /** 本轮做过的可能有改动的步骤（最多 20 条）：中断后交给接着做的那一轮，提醒它别重复、先核对 */
    steps?: Array<{ summary: string; done: boolean; irreversible?: boolean }>;
    /** 这一轮所在的道：中断后接着做时回到原来那一道 */
    laneKey?: string;
  };
  /** 中断后转给人决定的提及：当时记下的改动步骤，人点「继续」时交给 Agent（最多留 50 条） */
  interruptedSteps?: Record<
    string,
    Array<{ summary: string; done: boolean; irreversible?: boolean }>
  >;
  /**
   * 退出前没能送达服务端的终态回报（按触发消息）：Server 先断开、Agent 随后被结束时，停止回报只进了
   * 内存 outbox。下次加入时服务端那条调用还没落定就补发，否则它会一直挂着，10 分钟后被判「结果未知」
   */
  undeliveredReports?: Record<string, Omit<import("./hive-protocol.js").InvocationReport, "type">>;
  /** 进程中途退出后已自动重跑的次数（按触发消息），用于封顶并写进状态说明；处理完即删 */
  crashResumes?: Record<string, number>;
  /** 距上次发送完整上下文（成员、白板、规则提示）以来的轮数与时间，用于提示节流 */
  briefTurns?: number;
  lastFullPromptAt?: string;
  /** 上次发完整上下文之后 Runtime 压缩过会话：下一轮重发全量 */
  compactedSinceFull?: boolean;
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
  /** 当前会话有多长：决定主道要不要换新（见 lane-renewal.ts） */
  sessionStats?: SessionStats;
  /**
   * 换到别的任务目录时先收起来的会话（每个目录一段，最多 8 段）：回到原目录时接回，
   * 不用丢掉原来那段对话。开了新话题后收起的作废。
   */
  parkedSessions?: ParkedSession[];
};

/** 收起来的会话：只留和这段会话绑定的状态，回到原目录时原样放回 */
export type ParkedSession = {
  /** 会话所在目录；没有固定工作目录的 Agent 为空字符串 */
  workspace: string;
  /** 所在的道；没有就是主道 main */
  lane?: string;
  threadId: string;
  /** 收起时已经处理到的消息位置：接回后告诉 Agent 这之后的消息是在别的目录里处理的 */
  seenSeq: number;
  /** 收起时所在话题；开了新话题就不再接回 */
  topicSeq?: number;
  parkedAt: string;
  promptContext?: AgentState["promptContext"];
  instructionsDigest?: string;
  briefTurns?: number;
  lastFullPromptAt?: string;
  lastTurnEndedAt?: string;
  lastRequestAt?: string;
  lastCacheTtlMs?: number;
  sessionCost?: AgentState["sessionCost"];
  sessionStats?: SessionStats;
};

/** 一段会话的长度：运行时报了上下文大小就用它，没报就按发出和收到的字符估算（estimated） */
export type SessionStats = {
  threadId: string;
  contextTokens: number;
  estimated?: boolean;
  /** 这段会话已经跑了几轮 */
  turns: number;
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
