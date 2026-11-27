import { bridgeText, bridgeTextZh, said, type BridgeText } from "./bridge-text.js";
import { loadAnsweredQuestions } from "./question-context.js";
import { loadReceiptResults } from "./receipt-context.js";
import {
  TaskWorkspaceBusyError,
  TaskWorkspaceRemovedError,
  type TaskWorkspaceNotice,
  type TaskWorkspaceLookupOptions,
  type TaskWorkspaceNoticeSink,
  type TaskWorkspaceSelection,
} from "./task-workspace.js";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import {
  isMentioned,
  type AgentUsage,
  type ChatMessage,
  type Invocation,
  type InvocationReport,
  type RoomSummary,
} from "./hive-protocol.js";
import {
  AgentCancelledError,
  AgentExecutionUncertainError,
  AgentNonRetryableError,
  AgentTransientError,
  AgentSessionInvalidError,
  AgentUpstreamError,
  UPSTREAM_FAILURE_PREFIX,
  isCancelled,
  type AgentAccessMode,
  type AgentReply,
  type ApprovalRequest,
  type AgentResponder,
} from "./responder.js";
import { resolveReplyText } from "./silent-reply.js";
import {
  buildDeveloperInstructions,
  buildMentionPrompt,
  buildSteerPrompt,
  snapshotMembers,
  snapshotWhiteboard,
  contextBudgetFromEnv,
} from "./prompt-builder.js";
import {
  RoomClient,
  RoomClientError,
  type RoomClientHandlers,
  type Snapshot,
} from "./room-client.js";
import { StateStore, type AgentState, type ParkedSession } from "./state-store.js";
import {
  buildHandoffSummary,
  nextSessionStats,
  pendingDelegations,
  renewalReason,
  renewalSettings,
  type RenewalReason,
} from "./lane-renewal.js";
import { isIrreversibleStep, isMutatingStep, sanitizeTraceStep } from "./trace.js";
import { CLAUDE_COMPACT_WINDOW_DEFAULT, readAgentSettings } from "./mcp-servers.js";
import { failurePolicy, type FailureKind } from "./failure.js";
import { anyProcessAlive, liveRuntimePids, onRuntimeSpawn } from "./runtime-processes.js";
import type { TraceStep } from "./hive-protocol.js";
import { AttachmentCache } from "./attachment-cache.js";
import {
  AttachmentPublisher,
  describeFailures,
  parseAttachmentDirective,
} from "./attachment-publisher.js";
import type { AttachmentPaths, WorkspaceInfo } from "./prompt-builder.js";
import { diffPromptContext, type PromptContextSnapshot } from "./prompt-context.js";

type PreparedPrompt = {
  text: string;
  full: boolean;
  threadId?: string;
  whiteboardSnapshot?: PromptContextSnapshot;
  membersSnapshot?: PromptContextSnapshot;
};

/**
 * 交给接着做的那一轮：上一轮做过哪些可能有改动的步骤（Bridge 自己记下的事实，不靠模型回忆），
 * 哪一步可能没做完、哪些是撤不回的对外操作。规则只决定提醒什么，不决定成败
 */
export /** 原因拼进文案中间：没有句末标点的补一个句号，免得和后一句粘在一起 */
function sentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "没有给出原因。";
  return /[。！？.!?]$/.test(trimmed) ? trimmed : `${trimmed}。`;
}

/** 等待时长的说法：一分钟以上按分钟取整，否则按秒 */
function waitText(ms: number): string {
  return ms >= 60_000
    ? `${Math.round(ms / 60_000)} 分钟`
    : `${Math.max(1, Math.round(ms / 1000))} 秒`;
}

function stepsNote(
  steps: ReadonlyArray<{ summary: string; done: boolean; irreversible?: boolean }>,
  cwd?: string,
): string {
  if (steps.length === 0) return "";
  const lines = steps.map(
    (step) =>
      `- ${step.summary}${step.done ? "" : "（可能没执行完）"}${step.irreversible ? "（对外操作，做过就撤不回）" : ""}`,
  );
  return `\n上一轮${cwd ? `在 ${cwd} ` : ""}执行过这些可能有改动的操作，已经做过的不要重复：\n${lines.join("\n")}\n先核对它们的实际结果（本地改动可用 git status 查看，误改的迁移过来或还原）。标为「对外操作」且不确定是否已生效的，要再做之前先用 hive_ask_human 问人。`;
}

export function shouldProcessMention(input: {
  message: ChatMessage;
  username: string;
  ownParticipantId: string;
  processedMessageIds: string[];
  /**
   * 服务端已为本 Agent 建立了这条消息的调用（例如人回答了它的提问、没有再 @ 它）：
   * 服务端是派发的权威，正文里没有 @ 也要处理。
   */
  invited?: boolean;
}): boolean {
  return (
    !input.message.deletedAt &&
    // 自己发的不处理；例外是 hive_room_post 从别的房间转来、由服务端派给自己的活
    (input.message.senderId !== input.ownParticipantId ||
      (input.invited === true && input.message.text?.key === "roomPost.forwarded")) &&
    (input.invited === true || isMentioned(input.message.content, input.username)) &&
    !input.processedMessageIds.includes(input.message.id)
  );
}

export function hasAgentMessage(messages: ChatMessage[], participantId: string): boolean {
  return messages.some((message) => message.senderId === participantId);
}

/**
 * 回复要挂在哪条触发消息下：取传递深度最大的一条（同深度取最新），
 * 这样合批后仍挂在最深的那条回复链上，来回检测不会因为混入人类消息被"重置"。
 */
export function pickReplyParent(triggers: ChatMessage[]): ChatMessage {
  return triggers.reduce((best, message) =>
    message.hopCount > best.hopCount ||
    (message.hopCount === best.hopCount && message.seq > best.seq)
      ? message
      : best,
  );
}

export type BridgeTuning = {
  /** 第一条 @ 到达后等待多久再开工，以便把一阵连发合成一轮（参考 relay 的 500ms 合并窗口） */
  batchWindowMs?: number;
  /** 一轮最多合并多少条触发消息（参考 agent-bridge CodexRoomInbox） */
  maxBatchSize?: number;
  /** 运行中多久没有新进度时也回报一次心跳，避免被服务端判为结果未知 */
  heartbeatMs?: number;
  /** 进度回报的最小间隔 */
  progressThrottleMs?: number;
  /** 执行过程攒批上报的间隔 */
  traceFlushMs?: number;
  /** 上游模型服务出错、这一轮又没改过东西时，自动接着继续前的等待时间（次数即长度） */
  upstreamRetryDelaysMs?: number[];
  /** 连不上模型服务（断网、合盖睡眠）时等多久接着原会话继续；比限流等得更久、次数更多 */
  networkRetryDelaysMs?: number[];
  /** 暂时性失败（还没开始执行：Server 忙、握手超时）自动重试前的等待时间（次数即长度） */
  transientRetryDelaysMs?: number[];
  /** 执行中的权限申请等人批多久，过时按拒绝（略长于服务端的时限，以服务端为准） */
  approvalTimeoutMs?: number;
  /** 多久未收到 Runtime 新进度时提示待核实；只告警，不自动取消或重试 */
  progressStaleMs?: number;
  /** 隔多少轮或多久重新发送一次完整上下文 */
  fullPromptEveryTurns?: number;
  fullPromptEveryMs?: number;
  /**
   * Agent 已经干完活、正要把结果交回时连不上 Server（例如 Server 正在换代重启），
   * 最多等这么久并反复重试，而不是把整轮当失败重跑一遍
   */
  offlineRetryMs?: number;
  offlineRetryIntervalMs?: number;
  /** 进程中途退出、这一轮又没有副作用时，同一条提及最多自动重跑几次 */
  crashResumeLimit?: number;
  /** 重启时旧运行时子进程还活着，最多等它们自己退出多久（管道断了它们通常很快退出） */
  runtimeExitGraceMs?: number;
};

/** 连不上 Server 一类的错误：可以等 Server 回来再试，不代表这一轮做错了 */
export function isServerUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "TypeError" || error.name === "AbortError" || error.name === "TimeoutError")
    return true;
  return /ECONNREFUSED|ECONNRESET|fetch failed|socket hang up|聊天室连接|未在 15 秒内确认|\(5\d\d\)/.test(
    error.message,
  );
}

type ActiveBatch = {
  executionId: string;
  messages: ChatMessage[];
  controller: AbortController;
  cancelled: Set<string>;
  /** Provider 回合仍在进行、可以吸收 steer；回合结束后新消息改为排队 */
  accepting: boolean;
  workspace: string | undefined;
  /** 这一轮所在的道（见 laneOf）：引导只插同一道的消息 */
  lane: string;
  /** 这一轮做过可能有副作用的操作（改文件、跑非只读命令、发消息……）：中断后不自动继续 */
  mutated?: boolean;
  /** 这一轮做过的可能有改动的步骤：出错后接着做时交给下一轮 */
  steps?: Map<string, { summary: string; done: boolean; irreversible?: boolean }>;
  /** 这一轮调用过任何工具（只读的也算）：会话失效时不自动重跑 */
  toolUsed?: boolean;
  /** Bridge 开始处理这一轮的时间（选任务目录、拼提示之前），本轮计时都从这里算 */
  startedAt: number;
  /** 本轮用量：Provider 交出的原始观测、补全后的结果，以及是否已经随某次上报发出 */
  turn?: {
    startedAt: number;
    session: "new" | "resumed";
    observed?: AgentUsage;
    usage?: AgentUsage;
    reported?: boolean;
    /** 这一轮传给运行时的思考强度；运行时说当前模型不支持时清掉 */
    effort?: string;
    /** 运行时第一次交出输出（思考、文字、工具调用或进度）的时间 */
    firstOutputAt?: number;
    /** 这一轮里运行时自动压缩了上下文（Claude Code） */
    compactions?: Array<{ preTokens: number; postTokens?: number; durationMs?: number }>;
    /** 这一轮传给运行时的自动压缩阈值（只有 Claude 用） */
    compactWindow?: number;
  };
};

function describeRenewal(reason: RenewalReason): string {
  return reason.kind === "size"
    ? `约 ${formatTokens(reason.contextTokens)} token，超过 ${formatTokens(reason.threshold)}`
    : `约 ${formatTokens(reason.contextTokens)} token，空闲 ${Math.round(reason.idleMs / 60_000)} 分钟缓存已过期`;
}

/** 状态里写的 token 数：289737 → 290k（中英文都看得懂） */
function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

const MAX_ATTEMPTS = 3;
/** 落盘待补发的终态回报最多留这么多条（按触发消息），超出丢最早的 */
const MAX_UNDELIVERED_REPORTS = 50;
/** 最多收起几段会话（每个目录 + 道一段），多了先丢最早收起的子任务道 */
const MAX_PARKED_SESSIONS = 16;
/** 房间主对话所在的那一道；子任务各自一道（键是开启它的那次委派的调用 ID） */
export const MAIN_LANE = "main";
/** 这些 Provider 续接会话时不会换上新的系统 / 开发者规则（ACP 等由 refreshInstructions 重新注入） */
const RESUMED_SYSTEM_PROMPT_PROVIDERS = new Set(["claude", "codex"]);
/**
 * 会在回复里报告「这一轮压缩过上下文」的 Runtime（见 AgentReply.compacted）：
 * 同一会话里之前发过的成员、白板一直在上下文里，压缩过才需要补发全量，定时重发只留作兜底。
 * 其它 Runtime 压缩时不说，照旧每隔几轮重发一次。
 */
const COMPACTION_REPORTING_PROVIDERS = new Set(["claude", "codex"]);

export class AgentBridge {
  private state!: AgentState;
  private stateExisted = false;
  /** 房主暂停了这个访客 Agent（SESSION_PAUSED）：只在开始暂停时记一次日志，恢复加入后清掉 */
  private pausedByHost = false;
  private ownParticipantId = "";
  private instructions = "";
  private serverRules = "";
  private readonly defaultCwd: string | undefined;
  private readonly pending: ChatMessage[] = [];
  private active: ActiveBatch | undefined;
  private draining: Promise<void> | undefined;
  private batchTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  private readonly steering = new Set<string>();
  // 排队或处理期间被发送者撤回的 @：处理前跳过，处理中则不再代发回复
  private readonly recalled = new Set<string>();
  // 人在 UI 点了"停止"但消息尚未到达本地队列（例如断线期间）的提及
  private readonly cancelledEarly = new Set<string>();
  private readonly attempts = new Map<string, number>();
  /** 人要求「停下当前，改做这条」的消息：排在队首、单独成一轮 */
  private readonly soloNext = new Set<string>();
  /** 服务端标明是当作主 Agent 派来的消息（没有 @ 任何人）：提示词据此说明由它接话、调度 */
  private readonly leadMessages = new Set<string>();
  /** 房间当前的主 Agent 名字：缓存时长跟随 Claude Code 时，主 Agent 默认按 1 小时 */
  private roomLeadAgent: string | undefined;
  /** 上游出错后已自动继续的次数 */
  private readonly upstreamRetries = new Map<string, number>();
  /** 暂时性失败后已自动重试的次数 */
  private readonly transientRetries = new Map<string, number>();
  /** 这条消息下一轮用的模型和思考强度：人点了「换个模型重试」，只对这一次生效 */
  private readonly modelOverrides = new Map<string, { model?: string; effort?: string }>();
  /** 已经因为会话失效自动开新会话重跑过一次的消息：再失败就交给人 */
  private readonly sessionRetried = new Set<string>();
  /** 上游出错后正在等待自动继续的消息（及其计时器） */
  private readonly waitingResume = new Map<string, NodeJS.Timeout>();
  /** 等待自动继续期间的心跳（按等待计时器索引）：等待可能比 Server 判超时的窗口还长，期间也要报进度 */
  private readonly waitingHeartbeats = new Map<NodeJS.Timeout, NodeJS.Timeout>();
  /** 上游出错中断的原因：下一轮（自动继续或人点「继续」）开头提示 Agent 从断点接着做 */
  private readonly resumeNotes = new Map<string, string>();
  /**
   * 进程中途退出、可以安全重跑的提及（值为这是第几次自动恢复）：等拿到服务端快照、
   * 确认调用仍在执行或已判超时（没被人停止、收起）后再重新排队
   */
  private readonly crashResumable = new Map<string, number>();
  /** 中断前改过东西、接着原会话继续的提及：交给下一轮的步骤清单 */
  /** 刚接回的会话没看到的消息范围（见 switchSession） */
  private sessionGap:
    { threadId: string; afterSeq: number; untilSeq: number; lane: string } | undefined;
  /** 主道刚换了新会话时交给它的交接摘要（见 renewMainSession），只用一次 */
  private pendingHandoff: { threadId: string; text: string } | undefined;
  /** 上一轮传给运行时的自动压缩阈值：换新阈值不超过它的 0.6 */
  private lastCompactWindow: number | undefined;
  /** 刚为子任务开了新会话的那一道（见 takeFreshLaneNote） */
  private freshLane: string | undefined;
  /** 服务端标的每条提及落在哪一道会话（Invocation.laneKey） */
  private readonly laneKeys = new Map<string, string>();
  /** HIVE_TASK_LANES=0 关掉分道：所有消息都在一段会话里，和以前一样 */
  private readonly lanesEnabled = process.env.HIVE_TASK_LANES !== "0";
  private readonly crashNotes = new Map<
    string,
    {
      steps: Array<{ summary: string; done: boolean; irreversible?: boolean }>;
      threadId?: string;
      cwd?: string;
    }
  >();
  private crashResumeMinSeq: number | undefined;
  // 同一组触发消息在本地重试时复用 executionId，保证回复的幂等键不变
  private readonly executionIds = new Map<string, string>();
  private readonly room: RoomClient;
  private readonly tuning: Required<BridgeTuning>;
  private readonly attachments: AttachmentCache | undefined;
  private publisher: AttachmentPublisher | undefined;

  constructor(
    private readonly options: {
      serverUrl: string;
      roomId: string;
      username: string;
      persona: string;
      provider: string;
      token: string;
      access?: AgentAccessMode;
      /**
       * 附件缓存目录：各档都准备本地路径。只读档也能用读文件工具打开（下载是 Bridge 做的，不是 Agent 写），
       * Hive 工具连不上时这是 Agent 看到附件的唯一途径
       */
      attachmentCacheDir?: string;
      /** false：附件一律下载到缓存目录，不用同机 Server 存的那份（见 AttachmentCache） */
      attachmentServerPath?: boolean;
      /** Agent 工作目录：回复里声明的附件只允许来自这里 */
      cwd?: string;
      /** 房间设置的工作区（原样，未解析）；没设时为空 */
      roomWorkspace?: string;
      /** 房间当前的主 Agent（建立时的房间信息）；之后房间设置改了按 rooms.changed 更新 */
      roomLeadAgent?: string;
      /** 房间工作区没有采用时的原因，写进规则 */
      workspaceNote?: string;
      /**
       * 工作区档却没有系统沙箱（Windows 上的 Claude Code）：命令能访问工作区以外的文件，
       * 只靠运行时自己的审核和人工审批。加入房间时上报给成员列表，规则里如实写明
       */
      noSandbox?: boolean;
      onRoomsChanged?: (room: RoomSummary) => void;
      onArchived?: () => void;
      onShutdown?: () => void;
      /** 连上 / 断开这个房间 */
      onConnectionChange?: (connected: boolean) => void;
      tuning?: BridgeTuning;
      /** 本机 Hive Server 写的 Agent 设置文件：模型每一轮从这里读 */
      settingsFile?: string;
      taskWorkspace?: {
        resolve: (
          messageId: string,
          onNotice?: TaskWorkspaceNoticeSink,
        ) => Promise<TaskWorkspaceSelection>;
        resolveMany?: (
          messageIds: string[],
          onNotice?: TaskWorkspaceNoticeSink,
          options?: TaskWorkspaceLookupOptions,
        ) => Promise<Map<string, TaskWorkspaceSelection>>;
        responder: (cwd: string) => AgentResponder;
      };
    },
    private readonly store: StateStore,
    private responder: AgentResponder,
    private readonly log: (message: string) => void = console.log,
    createRoom: (
      options: ConstructorParameters<typeof RoomClient>[0],
      handlers: RoomClientHandlers,
    ) => RoomClient = (roomOptions, handlers) => new RoomClient(roomOptions, handlers),
  ) {
    this.defaultCwd = options.cwd;
    this.roomLeadAgent = options.roomLeadAgent;
    this.tuning = {
      batchWindowMs: 400,
      maxBatchSize: 10,
      heartbeatMs: 60_000,
      progressThrottleMs: 3_000,
      traceFlushMs: 300,
      upstreamRetryDelaysMs: [60_000, 180_000],
      networkRetryDelaysMs: [30_000, 120_000, 300_000, 600_000, 900_000],
      transientRetryDelaysMs: [10_000, 30_000, 60_000],
      approvalTimeoutMs: 10 * 60_000 + 30_000,
      progressStaleMs: 120_000,
      ...(COMPACTION_REPORTING_PROVIDERS.has(options.provider)
        ? { fullPromptEveryTurns: 40, fullPromptEveryMs: 6 * 60 * 60_000 }
        : { fullPromptEveryTurns: 8, fullPromptEveryMs: 30 * 60_000 }),
      offlineRetryMs: 5 * 60_000,
      offlineRetryIntervalMs: 2_000,
      crashResumeLimit: 2,
      runtimeExitGraceMs: 3_000,
      ...options.tuning,
    };
    this.attachments = options.attachmentCacheDir
      ? new AttachmentCache({
          serverUrl: options.serverUrl,
          token: options.token,
          dir: options.attachmentCacheDir,
          ...(options.attachmentServerPath === false ? { serverPath: false } : {}),
        })
      : undefined;
    this.publisher = options.cwd
      ? new AttachmentPublisher({
          serverUrl: options.serverUrl,
          roomId: options.roomId,
          token: options.token,
          cwd: options.cwd,
          access: options.access ?? "read-only",
        })
      : undefined;
    this.room = createRoom(
      {
        serverUrl: this.options.serverUrl,
        roomId: this.options.roomId,
        username: this.options.username,
        token: this.options.token,
        persona: this.options.persona,
        provider: this.options.provider,
        // 让房间里的人看到这个 Agent 在本房间实际在哪个目录工作、房间工作区改了是否已生效
        ...(options.cwd
          ? {
              workspace: {
                cwd: options.cwd,
                ...(options.roomWorkspace ? { roomWorkspace: options.roomWorkspace } : {}),
                ...(options.workspaceNote ? { note: options.workspaceNote } : {}),
                ...(options.noSandbox ? { noSandbox: true } : {}),
              },
            }
          : {}),
      },
      {
        onSnapshot: (snapshot) => this.onSnapshot(snapshot),
        onMention: (
          message,
          _latestSeq,
          retry,
          steer,
          first,
          lead,
          model,
          resume,
          effort,
          laneKey,
        ) => {
          if (laneKey) this.laneKeys.set(message.id, laneKey);
          if (lead) this.leadMessages.add(message.id);
          else this.leadMessages.delete(message.id);
          // 人对一次中途中断点了「继续」：提示 Agent 接着原会话核对现状再往下做，不从头重做
          if (resume && !this.resumeNotes.has(message.id)) {
            const steps = this.state.interruptedSteps?.[message.id] ?? [];
            this.resumeNotes.set(
              message.id,
              `上一次执行中途中断、结果未知，可能已经做了一部分${stepsNote(steps)}`,
            );
          }
          if (this.state.interruptedSteps?.[message.id]) {
            delete this.state.interruptedSteps[message.id];
            void this.store.save(this.state).catch(() => undefined);
          }
          // 人点「换个模型重试」（可以只换思考强度）：只对这一次生效
          if (model || effort)
            this.modelOverrides.set(message.id, {
              ...(model ? { model } : {}),
              ...(effort ? { effort } : {}),
            });
          else if (retry) this.modelOverrides.delete(message.id);
          this.enqueue(message, {
            retry,
            invited: true,
            ...(steer ? { steer } : {}),
            ...(first ? { first } : {}),
          });
        },
        onCancel: (messageId, turn) => this.cancel(messageId, turn),
        onApprovalDecision: (requestId, allow, reason) =>
          this.approvals.get(requestId)?.(allow, reason),
        onMessageDeleted: (message) => this.onRecalled(message.id),
        onRoomsChanged: (room) => {
          this.updateRoom(room);
          this.options.onRoomsChanged?.(room);
        },
        ...(this.options.onShutdown ? { onShutdown: this.options.onShutdown } : {}),
        ...(this.options.onConnectionChange
          ? { onConnectionChange: this.options.onConnectionChange }
          : {}),
        onError: (error) => {
          // 被房主暂停：照常隔一会儿重连，每次都会再被拒一次，只在开始暂停时记一行
          if (error instanceof RoomClientError && error.code === "SESSION_PAUSED") {
            if (!this.pausedByHost) {
              this.pausedByHost = true;
              this.log("[hive] 已被房主暂停，恢复后自动回来。");
            }
            return;
          }
          this.log(`[hive] ${error.message}`);
          if (error instanceof RoomClientError && error.code === "ROOM_ARCHIVED") {
            this.options.onArchived?.();
          }
          // 凭限时邀请带入的 Agent：访客到期或被房主移除后不再重连，直接离开这个房间
          if (
            error instanceof RoomClientError &&
            (error.code === "SESSION_EXPIRED" || error.code === "SESSION_REVOKED")
          ) {
            this.log("[hive] 访问期限已到或已被房主移除，离开这个房间。");
            this.options.onArchived?.();
          }
        },
      },
    );
  }

  async start(): Promise<void> {
    const existing = await this.store.load();
    this.stateExisted = Boolean(existing);
    this.state =
      existing ??
      ({
        serverUrl: this.options.serverUrl,
        roomId: this.options.roomId,
        username: this.options.username,
        lastProcessedSeq: 0,
        processedMessageIds: [],
      } satisfies AgentState);
    const serverRules = await this.room.fetchInstructions();
    this.serverRules = serverRules;
    this.instructions = buildDeveloperInstructions({
      agentName: this.options.username,
      persona: this.options.persona,
      serverRules,
      ...(this.options.access ? { access: this.options.access } : {}),
      ...(this.options.cwd ? { workspace: this.workspaceInfo(this.options.cwd) } : {}),
    });
    // 换了工作目录：旧会话（Codex 线程、Claude 续接）会沿用旧目录，丢掉它从新会话开始；消息游标保留
    if (
      !this.options.taskWorkspace &&
      this.options.cwd &&
      this.state.workspace !== this.options.cwd
    ) {
      if (this.state.threadId && this.state.workspace) {
        this.log(`[hive] 房间工作目录已改为 ${this.options.cwd}，开始新的会话`);
        delete this.state.threadId;
      }
      this.state.workspace = this.options.cwd;
    }
    await this.recoverInterruptedExecution();
    this.reportSession();
    this.room.start();
    this.log(
      `[hive] ${this.options.username} 正在连接 ${this.options.serverUrl}/${this.options.roomId}`,
    );
  }

  /** 告诉服务端这个房间当前的 Provider 会话，人可以在终端里接着它 */
  private reportSession(): void {
    const cwd = this.state?.workspace ?? this.options.cwd;
    if (this.state?.threadId && cwd) {
      this.room.reportSession(this.state.threadId, cwd);
    }
  }

  /** 没有正在执行、排队或待恢复的回合时返回；切换房间工作区前用它等这一轮做完 */
  async whenIdle(pollMs = 500): Promise<void> {
    while (!this.stopped && (this.active || this.pending.length > 0 || this.state?.inflight)) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.batchTimer) clearTimeout(this.batchTimer);
    for (const timer of new Set(this.waitingResume.values())) clearTimeout(timer);
    this.waitingResume.clear();
    for (const heartbeat of this.waitingHeartbeats.values()) clearInterval(heartbeat);
    this.waitingHeartbeats.clear();
    // 停止进程时中断正在进行的回合；执行意图会在中断回报后清除
    this.active?.controller.abort();
    await this.draining?.catch(() => undefined);
    await this.saveUndelivered();
    this.room.stop();
    await this.responder.close?.();
  }

  /** 连接断开时产生、还没送达的终态回报（比如停止回报）落盘，进程退出也不丢 */
  private async saveUndelivered(): Promise<void> {
    const unsent = this.room.undeliveredReports();
    if (!this.state || unsent.length === 0) return;
    const saved = { ...this.state.undeliveredReports };
    for (const event of unsent) {
      const report: Omit<InvocationReport, "type"> & { type?: string } = { ...event };
      delete report.type;
      saved[report.messageId] = report;
    }
    const ids = Object.keys(saved);
    for (const id of ids.slice(0, Math.max(0, ids.length - MAX_UNDELIVERED_REPORTS)))
      delete saved[id];
    this.state.undeliveredReports = saved;
    await this.store.save(this.state).catch(() => undefined);
  }

  /**
   * 补发上次进程没送达的终态回报：服务端那条调用还挂着（执行中、停止中、超时未收起）才发；
   * 不在快照里（已落定）、被人收起、或已重新排队（人点了重试）的不再覆盖
   */
  private deliverSaved(snapshot: Snapshot): void {
    const saved = this.state.undeliveredReports;
    if (!saved) return;
    delete this.state.undeliveredReports;
    const open = new Map<string, Invocation>();
    for (const invocation of snapshot.invocations ?? [])
      if (invocation.agentId === this.ownParticipantId) open.set(invocation.messageId, invocation);
    for (const report of Object.values(saved)) {
      const invocation = open.get(report.messageId);
      if (!invocation || invocation.resolution) continue;
      if (!["running", "cancelling", "timed_out"].includes(invocation.status)) continue;
      this.room.report(report);
    }
  }

  /**
   * 上次进程在执行途中退出（崩溃、断电、kill -9）。这一轮确认没有任何副作用（只读、思考、只读 Hive 工具）、
   * 旧运行时子进程也都退出了、自动恢复次数没用完，就等连上服务端后按原消息重跑；
   * 否则结果未知，不自动重跑，只把这些提及回报为结果未知并标记已处理，由人在 UI 中决定是否重试。
   */
  private async recoverInterruptedExecution(): Promise<void> {
    const inflight = this.state.inflight;
    if (!inflight) return;
    // 接着做时回到原来那一道（服务端快照里的 laneKey 到了也会是同一个）
    if (inflight.laneKey)
      for (const messageId of inflight.messageIds) this.laneKeys.set(messageId, inflight.laneKey);
    const pids = inflight.runtimePids ?? [];
    const deadline = Date.now() + this.tuning.runtimeExitGraceMs;
    while (anyProcessAlive(pids) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const runtimeAlive = anyProcessAlive(pids);
    const resumes = this.state.crashResumes ?? {};
    const used = Math.max(0, ...inflight.messageIds.map((id) => resumes[id] ?? 0));
    // 改过东西也能接着做：只要会话还在（它记得已经做到哪），且中断那一刻没有撤不回的对外操作正在跑
    const steps = inflight.steps ?? [];
    const irreversibleInFlight = steps.some((step) => step.irreversible && !step.done);
    const continuable = !inflight.mutated || (Boolean(inflight.threadId) && !irreversibleInFlight);
    const resumable = continuable && !runtimeAlive && used < this.tuning.crashResumeLimit;
    if (resumable) {
      this.log(
        `[hive] 检测到上次执行中断（${inflight.messageIds.length} 条提及，开始于 ${inflight.startedAt}），${inflight.mutated ? "接着原会话" : "这一轮没有副作用，"}连上后自动继续（第 ${used + 1}/${this.tuning.crashResumeLimit} 次）。`,
      );
      if (inflight.mutated && inflight.threadId) this.state.threadId = inflight.threadId;
      for (const messageId of inflight.messageIds) {
        this.crashResumable.set(messageId, used + 1);
        resumes[messageId] = used + 1;
        if (inflight.mutated)
          this.crashNotes.set(messageId, {
            steps,
            ...(inflight.threadId ? { threadId: inflight.threadId } : {}),
            ...(inflight.cwd ? { cwd: inflight.cwd } : {}),
          });
      }
      this.state.crashResumes = resumes;
      this.crashResumeMinSeq = inflight.minSeq;
    } else {
      const why = runtimeAlive
        ? "原运行时进程还没退出"
        : !continuable
          ? irreversibleInFlight
            ? "中断时一个撤不回的对外操作正在执行"
            : "这一轮有改动且没有可接续的会话"
          : `已自动恢复过 ${used} 次`;
      this.log(
        `[hive] 检测到上次执行中断（${inflight.messageIds.length} 条提及，开始于 ${inflight.startedAt}），${why}，结果未知，不会自动重跑。`,
      );
      // 旧进程还活着要最先判断：其余几种都允许人点「继续」，它活着时继续会让同一任务并行跑两份
      const pending = steps.find((step) => step.irreversible && !step.done);
      const text = runtimeAlive
        ? bridgeText("bridge.crashedRuntimeAlive")
        : pending
          ? bridgeText("bridge.crashedIrreversible", { step: pending.summary })
          : used > 0
            ? bridgeText("bridge.crashedAfterResume", { count: used })
            : bridgeText("bridge.crashedMidTurn");
      // 人之后点「继续」要接上中断的那一轮的会话（目录没变时）：它可能是这一轮新开的，还没写进 state
      if (
        inflight.threadId &&
        !runtimeAlive &&
        (!inflight.cwd || !this.options.cwd || inflight.cwd === this.options.cwd)
      )
        this.state.threadId = inflight.threadId;
      for (const messageId of inflight.messageIds) {
        this.room.report({ messageId, status: "uncertain", ...said(text) });
        this.rememberProcessed(messageId);
        // 人之后点「继续」时交给 Agent：中断前做过哪些改动、哪一步可能没做完（跨重启也要在）
        if (!runtimeAlive && steps.length > 0) {
          this.state.interruptedSteps = {
            ...Object.fromEntries(Object.entries(this.state.interruptedSteps ?? {}).slice(-49)),
            [messageId]: steps,
          };
        }
      }
    }
    delete this.state.inflight;
    await this.store.save(this.state);
  }

  /**
   * 重连拿到快照后，处理上次进程退出时可以安全重跑的提及：调用还在执行或已判超时（没被人收起）就按原消息重新排队；
   * 已被人停止的回报为已停止；已经落定的（人处理过、别处已完成）不再管。拿不到原文的报结果未知。
   */
  private async resumeCrashedMentions(
    known: Map<string, Invocation>,
    fetched: ChatMessage[],
    snapshot: Snapshot,
  ): Promise<void> {
    if (this.crashResumable.size === 0) return;
    const byId = new Map<string, ChatMessage>();
    for (const message of [...snapshot.messages, ...fetched]) byId.set(message.id, message);
    const missing = [...this.crashResumable.keys()].filter((id) => !byId.has(id));
    if (missing.length > 0) {
      const from = Math.max(0, (this.crashResumeMinSeq ?? 1) - 1);
      // 补拉失败直接抛出：待恢复记录还在，onSnapshot 的调用方断开重连后再来一次
      for (const message of (await this.room.fetchMessages(from)).messages) {
        byId.set(message.id, message);
      }
    }
    for (const [messageId, count] of [...this.crashResumable]) {
      const invocation = known.get(messageId);
      const message = byId.get(messageId);
      this.crashResumable.delete(messageId);
      if (this.isLocal(messageId) || this.state.processedMessageIds.includes(messageId)) continue;
      const status = invocation?.status;
      if (status === "cancelling") {
        this.rememberProcessed(messageId);
        this.room.report({
          messageId,
          status: "cancelled",
          ...said(bridgeText("bridge.crashResumeStopped")),
        });
        continue;
      }
      const resolved = Boolean(invocation?.resolution);
      // 快照总带着所有没落定的调用：找不到说明早已落定（完成、失败、被人收起）
      if (
        (snapshot.invocations && !invocation) ||
        !message ||
        message.deletedAt ||
        resolved ||
        (status !== undefined &&
          status !== "running" &&
          status !== "timed_out" &&
          status !== "queued")
      ) {
        // 人已经收起或停止、调用已经落定、原消息撤回：不再自动重跑
        if (!message && !resolved && (status === "running" || status === "timed_out")) {
          this.room.report({
            messageId,
            status: "uncertain",
            ...said(bridgeText("bridge.crashedMidTurn")),
          });
        }
        this.rememberProcessed(messageId);
        continue;
      }
      this.log(
        `[hive] #${message.seq} 上次处理中途进程退出，自动重新执行（第 ${count}/${this.tuning.crashResumeLimit} 次）`,
      );
      this.enqueue(message, { invited: true });
    }
    await this.store.save(this.state);
  }

  private async onSnapshot(snapshot: Snapshot): Promise<void> {
    this.ownParticipantId = snapshot.self.id;
    if (this.pausedByHost) {
      this.pausedByHost = false;
      this.log("[hive] 房主已恢复，重新回到房间。");
    }
    this.log(`[hive] 已加入 #${this.options.roomId}，公共消息最新 seq=${snapshot.latestSeq}`);
    this.deliverSaved(snapshot);
    if (!this.stateExisted) {
      // 首次加入不回放历史聊天，但服务端仍为本 Agent 挂着的 queued 调用要接着做，
      // 否则这些 @ 永远没人处理，最后被扫成"结果未知"
      for (const invocation of snapshot.invocations ?? [])
        if (invocation.agentId === this.ownParticipantId && invocation.laneKey)
          this.laneKeys.set(invocation.messageId, invocation.laneKey);
      const queued = new Set(
        (snapshot.invocations ?? [])
          .filter(
            (invocation) =>
              invocation.agentId === this.ownParticipantId && invocation.status === "queued",
          )
          .map((invocation) => invocation.messageId),
      );
      this.state.lastProcessedSeq = snapshot.latestSeq;
      this.stateExisted = true;
      await this.store.save(this.state);
      for (const message of snapshot.messages) {
        if (queued.delete(message.id)) this.enqueue(message, { invited: true });
      }
      // 快照只带最近的消息；更早的提及拿不到原文，如实报告并交给人决定是否重试
      for (const messageId of queued) {
        this.room.report({
          messageId,
          status: "failed",
          ...said(bridgeText("bridge.beyondCatchUp")),
        });
      }
      return;
    }
    const known = new Map<string, Invocation>();
    for (const invocation of snapshot.invocations ?? []) {
      if (invocation.agentId !== this.ownParticipantId) continue;
      known.set(invocation.messageId, invocation);
      if (invocation.laneKey) this.laneKeys.set(invocation.messageId, invocation.laneKey);
    }
    const missed = await this.room.fetchMessages(this.state.lastProcessedSeq);
    // 先把上次进程退出时可以安全重跑的排回队里：它们算作本地在办，下面就不会被当成「已不在进行」
    await this.resumeCrashedMentions(known, missed.messages, snapshot);
    for (const message of missed.messages) {
      const invocation = known.get(message.id);
      if (!this.isEligible(message, Boolean(invocation))) continue;
      // 服务端是调用状态的权威：被拦下、已停止或已结束的提及不再补做
      if (snapshot.invocations && invocation && invocation.status !== "queued") {
        if (
          (invocation.status === "running" || invocation.status === "timed_out") &&
          !this.isLocal(message.id)
        ) {
          this.room.report({
            messageId: message.id,
            status: "uncertain",
            ...said(bridgeText("bridge.reconnectedGone")),
          });
          this.rememberProcessed(message.id);
        }
        continue;
      }
      this.enqueue(message, { invited: Boolean(invocation) });
    }
    await this.store.save(this.state);
  }

  private isEligible(message: ChatMessage, invited = false): boolean {
    return shouldProcessMention({
      message,
      username: this.options.username,
      ownParticipantId: this.ownParticipantId,
      processedMessageIds: this.state.processedMessageIds,
      invited,
    });
  }

  private isLocal(messageId: string): boolean {
    return (
      this.waitingResume.has(messageId) ||
      this.steering.has(messageId) ||
      this.pending.some((message) => message.id === messageId) ||
      Boolean(this.active?.messages.some((message) => message.id === messageId))
    );
  }

  private enqueue(
    message: ChatMessage,
    options: { retry?: boolean; invited?: boolean; steer?: boolean; first?: boolean } = {},
  ): void {
    if (this.stopped) return;
    // 停下当前，改做这条：排到队首，下一轮只做它（不和别的排队消息合在一起）
    if (options.first) {
      this.soloNext.add(message.id);
      const index = this.pending.findIndex((item) => item.id === message.id);
      if (index > 0) this.pending.unshift(...this.pending.splice(index, 1));
      if (index >= 0) return;
    }
    // 人要求引导：已经在排队的从队里拿出来用来引导当前任务；不能插就留在队里并说明原因
    if (options.steer && this.pending.some((item) => item.id === message.id)) {
      if (this.canSteer(message)) {
        this.pending.splice(
          this.pending.findIndex((item) => item.id === message.id),
          1,
        );
        void this.steerIntoActive(this.active!, message);
      } else {
        this.reportNotSteered(message);
      }
      return;
    }
    if (options.retry) {
      // 人显式重试：忽略本地"已处理/已停止"记录，重新开始计数和幂等键
      this.state.processedMessageIds = this.state.processedMessageIds.filter(
        (id) => id !== message.id,
      );
      this.cancelledEarly.delete(message.id);
      this.attempts.delete(message.id);
      this.sessionRetried.delete(message.id);
      this.executionIds.delete(message.id);
    }
    if (this.isLocal(message.id)) return;
    if (!this.isEligible(message, options.invited)) {
      // 服务端明确派给我的却被判为不处理：记一行，下次「没确认收到」能直接查到原因
      if (options.invited && !this.state.processedMessageIds.includes(message.id))
        this.log(
          `[hive] #${message.seq} 服务端派来的提及未处理（发送者 ${message.senderName}，${message.deletedAt ? "已撤回" : "不符合处理条件"}）`,
        );
      return;
    }
    if (this.cancelledEarly.delete(message.id)) {
      this.rememberProcessed(message.id);
      void this.store
        .save(this.state)
        .then(() => {
          this.room.report({
            messageId: message.id,
            status: "cancelled",
            ...said(bridgeText("bridge.cancelledBeforeRun")),
          });
        })
        .catch(() => this.room.report({ messageId: message.id, status: "uncertain" }));
      return;
    }
    this.room.report({ messageId: message.id, status: "received" });
    // 默认排队；只有人明确要求（引导当前任务、发送并引导、Agent 开了自动引导）才插进正在执行的这一轮
    if (options.steer) {
      if (this.canSteer(message)) {
        void this.steerIntoActive(this.active!, message);
        return;
      }
      this.reportNotSteered(message);
    }
    if (this.soloNext.has(message.id)) this.pending.unshift(message);
    else this.pending.push(message);
    this.scheduleDrain(this.tuning.batchWindowMs);
  }

  /** 有正在执行、还能吸收新消息的一轮，而且这个运行时支持引导 */
  private canSteer(message?: ChatMessage): boolean {
    return Boolean(
      this.active?.accepting &&
      this.responder.steer &&
      !this.active.controller.signal.aborted &&
      // 只插进同一道的那一轮：别的道的消息要在自己的会话里做
      (!message || this.laneOf(message.id) === this.active.lane),
    );
  }

  /** Server 没沿用「上次用的任务目录」的说明，按消息记下，开工时写进提示和任务卡片 */
  private readonly workspaceNotices = new Map<string, TaskWorkspaceNotice>();
  private readonly noticeSink: TaskWorkspaceNoticeSink = (messageId, notice) => {
    this.workspaceNotices.set(messageId, notice);
  };

  /**
   * 取走这几条消息的目录说明：任务卡片上写明这次没沿用哪个目录、为什么，返回给 Agent 的系统提示。
   * 每条说明只用一次。
   */
  /** 写进规则的目录说明：房间工作区、当前工作目录，以及没用上房间工作区的原因 */
  private workspaceInfo(cwd: string): WorkspaceInfo {
    const onDefault = cwd === this.defaultCwd;
    return {
      cwd,
      ...(this.options.roomWorkspace ? { roomWorkspace: this.options.roomWorkspace } : {}),
      ...(!onDefault ? { taskDirectory: true } : {}),
      ...(onDefault && this.options.workspaceNote ? { note: this.options.workspaceNote } : {}),
      ...(this.options.noSandbox ? { noSandbox: true } : {}),
    };
  }

  private takeWorkspaceNote(messages: ChatMessage[]): string | undefined {
    const notices = messages.flatMap((message) => {
      const notice = this.workspaceNotices.get(message.id);
      if (!notice) return [];
      this.workspaceNotices.delete(message.id);
      this.room.report({
        messageId: message.id,
        status: "running",
        ...said(
          bridgeText("bridge.worktreeFocusDropped", { path: notice.path, reason: notice.reason }),
        ),
      });
      return [notice];
    });
    const notice = notices[0];
    if (!notice) return undefined;
    return `（系统提示）你上次用的任务目录 ${notice.path} 不能再用：${notice.reason}\n这次没有沿用它，你现在在房间的默认工作目录 ${this.options.cwd ?? this.defaultCwd ?? ""}。这一轮要改代码、提交，先用 hive_worktree_create 以新的 slug 建任务目录，再按 runtimeHandoff 到新目录里做；不要在默认工作目录里改代码，也不要回旧目录里切分支。只读的查询、回答不受影响。`;
  }

  private async taskWorkspaces(
    messages: ChatMessage[],
    options?: TaskWorkspaceLookupOptions,
  ): Promise<Map<string, TaskWorkspaceSelection>> {
    const runtime = this.options.taskWorkspace;
    if (!runtime) return new Map(messages.map((message) => [message.id, undefined]));
    const ids = messages.map((message) => message.id);
    const selections = runtime.resolveMany
      ? await (options
          ? runtime.resolveMany(ids, this.noticeSink, options)
          : runtime.resolveMany(ids, this.noticeSink))
      : new Map(
          await Promise.all(
            ids.map(async (id) => [id, await runtime.resolve(id, this.noticeSink)] as const),
          ),
        );
    if (ids.some((id) => !selections.has(id)))
      throw new AgentNonRetryableError("Incomplete managed task workspace selection");
    return selections;
  }

  private async selectTaskWorkspace(
    messageId: string,
    prepared?: { path: TaskWorkspaceSelection },
    lane = this.currentLane(),
  ): Promise<boolean> {
    const runtime = this.options.taskWorkspace;
    if (!runtime || !this.defaultCwd) return false;
    const selected =
      (prepared ? prepared.path : await runtime.resolve(messageId, this.noticeSink)) ??
      this.defaultCwd;
    if (selected instanceof TaskWorkspaceRemovedError) throw selected;
    const changed = selected !== this.options.cwd;
    if (changed) {
      await this.responder.close?.();
      this.responder = runtime.responder(selected);
      this.options.cwd = selected;
      this.publisher = new AttachmentPublisher({
        serverUrl: this.options.serverUrl,
        roomId: this.options.roomId,
        token: this.options.token,
        cwd: selected,
        access: this.options.access ?? "read-only",
      });
    }
    if (selected !== this.state.workspace || lane !== this.currentLane())
      this.switchSession(selected, lane);
    this.instructions = buildDeveloperInstructions({
      agentName: this.options.username,
      persona: this.options.persona,
      serverRules: this.serverRules,
      ...(this.options.access ? { access: this.options.access } : {}),
      workspace: this.workspaceInfo(selected),
    });
    await this.store.save(this.state);
    return changed;
  }

  /** 这条消息落在哪一道会话：服务端标的 laneKey；关掉分道或老服务端一律是主道 */
  private laneOf(messageId: string): string {
    if (!this.lanesEnabled) return MAIN_LANE;
    return this.laneKeys.get(messageId) ?? MAIN_LANE;
  }

  /** 当前会话所在的那一道 */
  private currentLane(): string {
    return this.state.lane ?? MAIN_LANE;
  }

  /**
   * 换会话：换任务目录或换到另一道（子任务）时，原来那段会话先收起来；要去的目录 + 道以前有会话就接回，
   * 没有才从新会话开始。这样进任务目录做完、再回房间工作区时，原来那段对话还在；
   * 子任务在自己的会话里做，不把房间主对话越拉越长。
   */
  private switchSession(workspace: string | undefined, lane = this.currentLane()): void {
    const state = this.state;
    const from = { workspace: state.workspace ?? "", lane: this.currentLane() };
    const to = { workspace: workspace ?? "", lane };
    const same = (item: ParkedSession, key: { workspace: string; lane: string }) =>
      item.workspace === key.workspace && (item.lane ?? MAIN_LANE) === key.lane;
    const parked = (state.parkedSessions ?? []).filter(
      (item) => !same(item, to) && !same(item, from),
    );
    if (state.threadId) {
      parked.push({
        workspace: from.workspace,
        ...(from.lane !== MAIN_LANE ? { lane: from.lane } : {}),
        threadId: state.threadId,
        seenSeq: state.lastProcessedSeq,
        ...(state.topicSeq !== undefined ? { topicSeq: state.topicSeq } : {}),
        parkedAt: new Date().toISOString(),
        ...(state.promptContext?.threadId === state.threadId
          ? { promptContext: state.promptContext }
          : {}),
        ...(state.instructionsDigest ? { instructionsDigest: state.instructionsDigest } : {}),
        ...(state.briefTurns !== undefined ? { briefTurns: state.briefTurns } : {}),
        ...(state.lastFullPromptAt ? { lastFullPromptAt: state.lastFullPromptAt } : {}),
        ...(state.lastTurnEndedAt ? { lastTurnEndedAt: state.lastTurnEndedAt } : {}),
        ...(state.lastRequestAt ? { lastRequestAt: state.lastRequestAt } : {}),
        ...(state.lastCacheTtlMs !== undefined ? { lastCacheTtlMs: state.lastCacheTtlMs } : {}),
        ...(state.sessionCost?.threadId === state.threadId
          ? { sessionCost: state.sessionCost }
          : {}),
        ...(state.sessionStats?.threadId === state.threadId
          ? { sessionStats: state.sessionStats }
          : {}),
      });
    }
    const restore = (state.parkedSessions ?? []).find(
      (item) => same(item, to) && item.topicSeq === state.topicSeq,
    );
    // 主道的会话最珍贵：超出上限时先丢最早收起的子任务道
    while (parked.length > MAX_PARKED_SESSIONS) {
      const index = parked.findIndex((item) => (item.lane ?? MAIN_LANE) !== MAIN_LANE);
      parked.splice(index >= 0 ? index : 0, 1);
    }
    state.parkedSessions = parked;
    if (state.parkedSessions.length === 0) delete state.parkedSessions;
    delete state.threadId;
    delete state.promptContext;
    delete state.instructionsDigest;
    delete state.lastFullPromptAt;
    delete state.lastTurnEndedAt;
    delete state.lastRequestAt;
    delete state.lastCacheTtlMs;
    delete state.sessionStats;
    state.briefTurns = 0;
    if (workspace !== undefined) state.workspace = workspace;
    if (lane === MAIN_LANE) delete state.lane;
    else state.lane = lane;
    this.sessionGap = undefined;
    this.freshLane = undefined;
    if (!restore) {
      if (lane !== MAIN_LANE) this.freshLane = lane;
      return;
    }
    state.threadId = restore.threadId;
    if (restore.promptContext) state.promptContext = restore.promptContext;
    if (restore.instructionsDigest) state.instructionsDigest = restore.instructionsDigest;
    if (restore.briefTurns !== undefined) state.briefTurns = restore.briefTurns;
    if (restore.lastFullPromptAt) state.lastFullPromptAt = restore.lastFullPromptAt;
    if (restore.lastTurnEndedAt) state.lastTurnEndedAt = restore.lastTurnEndedAt;
    if (restore.lastRequestAt) state.lastRequestAt = restore.lastRequestAt;
    if (restore.lastCacheTtlMs !== undefined) state.lastCacheTtlMs = restore.lastCacheTtlMs;
    if (restore.sessionCost) state.sessionCost = restore.sessionCost;
    if (restore.sessionStats) state.sessionStats = restore.sessionStats;
    this.log(
      lane === MAIN_LANE
        ? `[hive] 回到 ${to.workspace || "工作目录"}，接回之前在这里的会话`
        : `[hive] 接回子任务 ${lane.slice(0, 8)} 的会话`,
    );
    if (restore.seenSeq < state.lastProcessedSeq)
      this.sessionGap = {
        threadId: restore.threadId,
        afterSeq: restore.seenSeq,
        untilSeq: state.lastProcessedSeq,
        lane,
      };
  }

  /** 这一轮结束后会话有多长：运行时报了就用它报的，没报就按字符估 */
  private noteSessionLength(promptText: string, reply: AgentReply, compactWindow?: number): void {
    if (compactWindow) this.lastCompactWindow = compactWindow;
    const threadId = this.state.threadId;
    if (!threadId) return;
    const usage = reply.usage;
    const reported =
      usage?.lastContextTokens ??
      (usage && usage.requests > 0 ? usage.peakContextTokens : undefined);
    this.state.sessionStats = nextSessionStats({
      previous: this.state.sessionStats,
      threadId,
      ...(reported !== undefined ? { contextTokens: reported } : {}),
      promptText,
      replyText: reply.text,
    });
  }

  /**
   * 主道在两件活之间、会话太长或缓存已过期时换一段新会话，并附上按规则拼的交接摘要。
   * 回执、提问的回答、中断后接着做的不换：那是同一件活做到一半。
   */
  private async renewMainSession(active: ActiveBatch, context: ChatMessage[]): Promise<void> {
    if (!this.lanesEnabled || active.lane !== MAIN_LANE || !this.state.threadId) return;
    const continuing = active.messages.some(
      (message) =>
        message.kind === "receipt" ||
        Boolean(message.replyToMessageId) ||
        this.resumeNotes.has(message.id) ||
        this.crashResumable.has(message.id) ||
        (this.state.crashResumes?.[message.id] ?? 0) > 0,
    );
    if (continuing) return;
    const reason = renewalReason({
      stats: this.state.sessionStats,
      threadId: this.state.threadId,
      settings: renewalSettings(),
      ...(this.lastCompactWindow ? { compactWindow: this.lastCompactWindow } : {}),
      ...(this.state.lastTurnEndedAt ? { lastTurnEndedAt: this.state.lastTurnEndedAt } : {}),
      ...(this.state.lastCacheTtlMs ? { cacheTtlMs: this.state.lastCacheTtlMs } : {}),
    });
    if (!reason) return;
    const afterSeq = Math.max(0, this.state.lastProcessedSeq - 300);
    let history: ChatMessage[];
    try {
      history = (await this.room.fetchMessages(afterSeq)).messages;
    } catch {
      // 拿不到房间记录就拼不出摘要：这一轮先不换，下一轮再看
      return;
    }
    const seen = new Set(history.map((message) => message.id));
    history = [...history, ...context.filter((message) => !seen.has(message.id))];
    const triggers = new Set(active.messages.map((message) => message.id));
    const before = history.filter((message) => !triggers.has(message.id));
    // 还有派出去没回执的子任务：回执到了要接着这段会话做，先不换
    if (pendingDelegations(before, this.ownParticipantId).length > 0) return;
    const previous = this.state.threadId;
    this.dropSession();
    const text = buildHandoffSummary({
      messages: before,
      username: this.options.username,
      ownId: this.ownParticipantId,
      reason,
      ...(this.options.cwd ? { cwd: this.options.cwd } : {}),
      afterSeq,
    });
    this.pendingHandoff = { threadId: previous, text };
    this.log(
      `[hive] 房间主对话换新会话（${describeRenewal(reason)}），附交接摘要 ${text.length} 字`,
    );
    const note = bridgeText("bridge.sessionRenewed", {
      tokens: formatTokens(reason.contextTokens),
    });
    this.reportAll(active.messages, {
      status: "running",
      ...said(note),
      progress: bridgeTextZh(note).slice(0, 200),
    });
    await this.store.save(this.state);
  }

  /** 丢掉当前这一道的会话（换新），消息游标、收起的别的会话都保留 */
  private dropSession(): void {
    const state = this.state;
    delete state.threadId;
    delete state.promptContext;
    delete state.instructionsDigest;
    delete state.lastFullPromptAt;
    delete state.lastTurnEndedAt;
    delete state.lastRequestAt;
    delete state.lastCacheTtlMs;
    delete state.sessionStats;
    delete state.compactedSinceFull;
    state.briefTurns = 0;
  }

  /** 主道刚换新：这一轮开头附上交接摘要，只用一次 */
  private takeHandoffNote(): string | undefined {
    const handoff = this.pendingHandoff;
    this.pendingHandoff = undefined;
    if (!handoff || this.state.threadId) return undefined;
    return handoff.text;
  }

  /** 接回的会话没看到的那段消息（在别的任务目录里处理的），这一轮开头告诉 Agent，只说一次 */
  private takeSessionGapNote(): string | undefined {
    const gap = this.sessionGap;
    this.sessionGap = undefined;
    if (!gap || gap.threadId !== this.state.threadId) return undefined;
    const args = JSON.stringify({ afterSeq: gap.afterSeq });
    if (gap.lane !== MAIN_LANE)
      return `（系统提示）这是你之前处理这件子任务时的那段对话，已接回。之后你在房间主对话或别的子任务里处理过一些消息（#${gap.afterSeq + 1}～#${gap.untilSeq} 之间），那些不在这里；下面只附上新消息。需要时用 hive_room_read(${args}) 补读。`;
    return `（系统提示）这是你之前在当前工作目录里的那段对话，已接回。之后你在别的任务目录或子任务里处理过一些消息（#${gap.afterSeq + 1}～#${gap.untilSeq} 之间），那些对话不在这里；下面只附上新消息。需要了解当时做了什么时，用 hive_room_read(${args}) 补读。`;
  }

  /** 刚为一件子任务开了单独的会话：这一轮开头说明它看不到房间主对话，只说一次 */
  private takeFreshLaneNote(): string | undefined {
    const lane = this.freshLane;
    this.freshLane = undefined;
    if (!lane || lane !== this.currentLane() || this.state.threadId) return undefined;
    return `（系统提示）这是为这件子任务单独开的新对话，看不到你在房间主对话和其它子任务里的上下文。照任务说明做；缺背景时用 hive_room_read 补读相关消息，或在回执里说明需要什么。`;
  }

  private reportNotSteered(message: ChatMessage): void {
    this.room.report({
      messageId: message.id,
      status: "received",
      ...said(
        bridgeText(this.responder.steer ? "bridge.notSteeredQueued" : "bridge.steerUnsupported"),
      ),
    });
  }

  /** 把新消息插进正在运行的这一轮（Codex turn/steer、Claude 流式输入、ACP steering），插不进去就退回排队 */
  private async steerIntoActive(active: ActiveBatch, message: ChatMessage): Promise<void> {
    this.steering.add(message.id);
    let steered = false;
    let queuedDetail: BridgeText | undefined;
    try {
      const selected = this.options.taskWorkspace
        ? await this.options.taskWorkspace.resolve(message.id, this.noticeSink)
        : undefined;
      if (selected instanceof TaskWorkspaceRemovedError) {
        this.rememberProcessed(message.id);
        await this.store.save(this.state);
        this.room.report({
          messageId: message.id,
          status: "completed",
          ...said(bridgeText("bridge.worktreeCleaned", { path: selected.path })),
        });
        return;
      }
      if (selected && selected !== active.workspace) {
        queuedDetail = bridgeText("bridge.worktreeSteerQueued", { path: selected });
      } else {
        const runtime = this.responder;
        const note = this.takeWorkspaceNote([message]);
        const [answered] = await this.answeredQuestions([message], []);
        const steer = buildSteerPrompt(message, await this.attachmentPaths([message]), answered);
        const prompt = note ? `${note}\n\n${steer}` : steer;
        if (
          this.active === active &&
          active.accepting &&
          !active.controller.signal.aborted &&
          !this.cancelledEarly.has(message.id) &&
          this.responder === runtime
        ) {
          this.room.report({
            messageId: message.id,
            status: "received",
            ...said(bridgeText("bridge.steering")),
          });
          steered = await runtime.steer!(prompt);
        }
      }
    } catch (error) {
      if (
        error instanceof AgentExecutionUncertainError ||
        error instanceof AgentNonRetryableError
      ) {
        this.rememberProcessed(message.id);
        await this.store.save(this.state);
        this.room.report({
          messageId: message.id,
          status: error instanceof AgentNonRetryableError ? "failed" : "uncertain",
          ...said(
            error instanceof AgentNonRetryableError
              ? bridgeText("bridge.unsafe", { reason: error.message.slice(0, 380) })
              : bridgeText("bridge.steerUnconfirmed"),
          ),
        });
        return;
      }
      steered = false;
    } finally {
      this.steering.delete(message.id);
    }
    if (this.cancelledEarly.delete(message.id)) {
      if (steered && this.active === active && active.accepting) {
        active.messages.push(message);
        active.cancelled.add(message.id);
      } else if (!steered) {
        this.rememberProcessed(message.id);
        await this.store.save(this.state);
        this.room.report({
          messageId: message.id,
          status: "cancelled",
          ...said(bridgeText("bridge.steerRemoved")),
        });
      } else {
        this.room.report({
          messageId: message.id,
          status: "uncertain",
          ...said(bridgeText("bridge.steerCancelRace")),
        });
      }
      return;
    }
    // A confirmed steer that races completion may already have run; never queue it twice.
    if (steered && (this.active !== active || !active.accepting)) {
      this.rememberProcessed(message.id);
      await this.store.save(this.state);
      this.room.report({
        messageId: message.id,
        status: "uncertain",
        ...said(bridgeText("bridge.steerEndRace")),
      });
      return;
    }
    if (steered && this.active === active && active.accepting) {
      active.messages.push(message);
      // 并入的消息也写进执行意图：进程这时退出，重启后和本轮其它提及一起判断能否重跑
      const inflight = this.state.inflight;
      if (inflight?.executionId === active.executionId) {
        inflight.messageIds = [...inflight.messageIds, message.id];
        inflight.minSeq = Math.min(inflight.minSeq ?? message.seq, message.seq);
        void this.store.save(this.state).catch(() => undefined);
      }
      const host = active.messages[0]!;
      this.log(`[hive] #${message.seq} 已并入正在进行的 #${host.seq}`);
      this.room.report({
        messageId: message.id,
        status: "running",
        ...said(bridgeText("bridge.steered", { seq: host.seq })),
      });
      // 执行过程里标出引导的位置，看得出 Agent 从哪一步开始调整
      const at = new Date().toISOString();
      for (const item of active.messages.filter((entry) => entry.id !== message.id)) {
        this.room.trace(item.id, [
          {
            id: `steer:${message.id}`,
            kind: "text",
            text: `↳ ${message.senderName} 引导：${message.content}`.slice(0, 2000),
            startedAt: at,
            endedAt: at,
          },
        ]);
      }
      return;
    }
    this.room.report({
      messageId: message.id,
      status: "received",
      ...said(queuedDetail ?? bridgeText("bridge.steerLate")),
    });
    this.pending.push(message);
    this.scheduleDrain(this.tuning.batchWindowMs);
  }

  private scheduleDrain(delayMs: number): void {
    if (this.batchTimer || this.stopped) return;
    this.batchTimer = setTimeout(() => {
      this.batchTimer = undefined;
      void this.drain();
    }, delayMs);
    this.batchTimer.unref?.();
  }

  private drain(): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = (async () => {
      while (this.pending.length > 0 && !this.stopped) {
        const first = this.pending[0]!;
        const candidates = this.pending.slice(
          0,
          this.soloNext.has(first.id) ? 1 : this.tuning.maxBatchSize,
        );
        let prepared: { path: TaskWorkspaceSelection } | undefined;
        let count = candidates.length;
        // 一轮只做同一道的消息：子任务和房间主对话各用各的会话
        const lane = this.laneOf(first.id);
        const otherLane = candidates.findIndex((message) => this.laneOf(message.id) !== lane);
        if (otherLane >= 0) count = otherLane;
        if (this.options.taskWorkspace) {
          try {
            const selections = await this.taskWorkspaces(candidates);
            prepared = { path: selections.get(first.id) };
            if (prepared.path instanceof TaskWorkspaceRemovedError) count = 1;
            const directory = prepared.path ?? this.defaultCwd;
            const different = candidates.findIndex(
              (message) => (selections.get(message.id) ?? this.defaultCwd) !== directory,
            );
            if (different >= 0) count = Math.min(count, different);
          } catch {
            count = 1;
          }
        }
        if (this.stopped) break;
        if (this.pending[0]?.id !== first.id) continue;
        const batch = candidates
          .slice(0, count)
          .filter((message, index) => this.pending[index]?.id === message.id);
        if (!batch.length) continue;
        this.soloNext.delete(first.id);
        this.pending.splice(0, batch.length);
        await this.runBatch(batch, prepared);
      }
    })().finally(() => {
      this.draining = undefined;
    });
    return this.draining;
  }

  private onRecalled(messageId: string): void {
    if (this.isLocal(messageId)) this.recalled.add(messageId);
  }

  /** 成员列表的忙闲：正在跑一轮，或有任务在等上游恢复后自动继续 */
  private syncTyping(): void {
    this.room.setTyping(Boolean(this.active) || this.waitingResume.size > 0);
  }

  /**
   * 停止一条消息的处理。turn 是服务端一起停的同轮消息（人停的是整轮）：在跑的这一轮里有它们就一并
   * 标为停止，不等几条停止请求逐条到达，免得中间误判成「同轮还有没停的」而上报停止被推迟。
   */
  private cancel(messageId: string, turn?: string[]): void {
    // 正在等待自动继续：直接取消，不用等计时器
    const waiting = this.waitingResume.get(messageId);
    if (waiting) {
      this.waitingResume.delete(messageId);
      if (![...this.waitingResume.values()].includes(waiting)) {
        clearTimeout(waiting);
        this.stopWaitingHeartbeat(waiting);
      }
      this.resumeNotes.delete(messageId);
      this.rememberProcessed(messageId);
      this.syncTyping();
      this.log(`[hive] 等待自动继续的 ${messageId} 已被停止`);
      void this.store
        .save(this.state)
        .then(() => {
          this.room.report({
            messageId,
            status: "cancelled",
            ...said(bridgeText("bridge.stoppedWhileWaiting")),
          });
        })
        .catch(() =>
          this.room.report({
            messageId,
            status: "uncertain",
            ...said(bridgeText("bridge.cancelNotPersisted")),
          }),
        );
      return;
    }
    const pendingIndex = this.pending.findIndex((message) => message.id === messageId);
    if (pendingIndex >= 0) {
      this.pending.splice(pendingIndex, 1);
      this.log(`[hive] 排队中的提及 ${messageId} 已被停止`);
      this.rememberProcessed(messageId);
      void this.store
        .save(this.state)
        .then(() => {
          this.room.report({
            messageId,
            status: "cancelled",
            ...said(bridgeText("bridge.queuedRemoved")),
          });
        })
        .catch(() =>
          this.room.report({
            messageId,
            status: "uncertain",
            ...said(bridgeText("bridge.cancelNotPersisted")),
          }),
        );
      return;
    }
    const active = this.active;
    if (active?.messages.some((message) => message.id === messageId)) {
      const together = new Set([messageId, ...(Array.isArray(turn) ? turn : [])]);
      const stopping = active.messages.filter(
        (message) => together.has(message.id) && !active.cancelled.has(message.id),
      );
      for (const message of stopping) active.cancelled.add(message.id);
      // 合批中只要还有未被停止的消息，就继续这一轮
      if (active.messages.every((message) => active.cancelled.has(message.id))) {
        this.log("[hive] 收到停止请求，正在中断当前回合");
        active.controller.abort();
        return;
      }
      // 这一轮不会马上停：如实告诉服务端，别让这几条一直显示「停止中」。
      // 重复的停止请求（已标过的）也再说一次，服务端可能刚又把它改成了停止中
      const deferred = stopping.length > 0 ? stopping : [{ id: messageId }];
      this.log(`[hive] 收到停止请求，但同一轮还有没停的消息，这一轮继续`);
      for (const message of deferred) {
        this.room.report({
          messageId: message.id,
          status: "running",
          stopDeferred: true,
          ...said(bridgeText("bridge.stopDeferred")),
        });
      }
      return;
    }
    // 这一轮早已结束（比如结果未知后人又点了停止）：这边没有在跑的回合，立即回复，
    // 否则服务端会一直显示「停止中」，要等 10 分钟超时才放开。仍报结果未知：
    // 当初中断时工具子进程是否停下并没有确认，不能借这次停止把它洗成可重试的「已停止」
    if (this.state.processedMessageIds.includes(messageId)) {
      this.log(`[hive] ${messageId} 这一轮已经结束，没有在跑的回合`);
      this.room.report({
        messageId,
        status: "uncertain",
        ...said(bridgeText("bridge.alreadyEnded")),
      });
      return;
    }
    this.cancelledEarly.add(messageId);
  }

  private rememberProcessed(messageId: string): void {
    this.leadMessages.delete(messageId);
    this.modelOverrides.delete(messageId);
    this.sessionRetried.delete(messageId);
    this.laneKeys.delete(messageId);
    this.state.processedMessageIds = [
      ...this.state.processedMessageIds.filter((id) => id !== messageId),
      messageId,
    ].slice(-1000);
    this.attempts.delete(messageId);
    this.upstreamRetries.delete(messageId);
    this.transientRetries.delete(messageId);
    this.executionIds.delete(messageId);
    this.crashResumable.delete(messageId);
    this.crashNotes.delete(messageId);
    if (this.state.crashResumes && messageId in this.state.crashResumes) {
      delete this.state.crashResumes[messageId];
      if (Object.keys(this.state.crashResumes).length === 0) delete this.state.crashResumes;
    }
  }

  private reportAll(messages: ChatMessage[], report: Omit<InvocationReport, "type" | "messageId">) {
    for (const message of messages) this.room.report({ messageId: message.id, ...report });
  }

  private async runBatch(
    initial: ChatMessage[],
    preparedWorkspace?: { path: TaskWorkspaceSelection },
  ): Promise<void> {
    const skipped = initial.filter(
      (message) =>
        this.recalled.has(message.id) || this.state.processedMessageIds.includes(message.id),
    );
    for (const message of skipped) {
      if (this.recalled.delete(message.id)) {
        this.log(`[hive] #${message.seq} 已被发送者撤回，跳过处理`);
        this.rememberProcessed(message.id);
      }
    }
    const messages = initial.filter((message) => !skipped.includes(message));
    if (messages.length === 0) {
      await this.store.save(this.state);
      return;
    }
    const executionId = this.executionIds.get(messages[0]!.id) ?? randomUUID();
    for (const message of messages) this.executionIds.set(message.id, executionId);
    const active: ActiveBatch = {
      executionId,
      messages: [...messages],
      controller: new AbortController(),
      cancelled: new Set(),
      accepting: false,
      workspace: this.options.cwd,
      lane: this.laneOf(messages[0]!.id),
      startedAt: Date.now(),
    };
    this.active = active;
    let heartbeat: NodeJS.Timeout | undefined;
    let traceTimer: NodeJS.Timeout | undefined;
    // 回合结束前把攒着的执行过程发出去：Server 在调用结束后就不再收，最后一段思考、最后一步的结果会丢
    let flushPendingTrace: () => void = () => undefined;
    let stopWatchingRuntime: () => void = () => undefined;
    try {
      const context = await this.room.fetchMessages(this.state.lastProcessedSeq);
      // 先落盘执行意图，再调用 Provider：崩溃后据此判定"结果未知"而不是重跑
      this.state.inflight = {
        executionId,
        messageIds: messages.map((message) => message.id),
        startedAt: new Date().toISOString(),
        minSeq: Math.min(...messages.map((message) => message.seq)),
        runtimePids: liveRuntimePids(),
        ...(this.options.cwd ? { cwd: this.options.cwd } : {}),
        ...(active.lane !== MAIN_LANE ? { laneKey: active.lane } : {}),
      };
      await this.store.save(this.state);
      // 本轮新起的运行时子进程也记下：进程退出后它们可能还在跑
      stopWatchingRuntime = onRuntimeSpawn((pid) => {
        const inflight = this.state.inflight;
        if (inflight?.executionId !== executionId) return;
        inflight.runtimePids = [...(inflight.runtimePids ?? []), pid];
        void this.store.save(this.state).catch(() => undefined);
      });
      const resumedCount = Math.max(
        0,
        ...messages.map((message) => this.state.crashResumes?.[message.id] ?? 0),
      );

      // 人点「换个模型重试」选的模型和思考强度：只对这一次生效，状态里写明用的是哪个
      const override = messages
        .map((message) => this.modelOverrides.get(message.id))
        .find((item) => item?.model || item?.effort);
      const picked = override?.model;
      const pickedEffort = override?.effort;
      const using = picked
        ? pickedEffort
          ? bridgeText("bridge.usingModelEffort", { model: picked, effort: pickedEffort })
          : bridgeText("bridge.usingModel", { model: picked })
        : pickedEffort
          ? bridgeText("bridge.usingEffort", { effort: pickedEffort })
          : resumedCount > 0
            ? bridgeText("bridge.crashResumed", {
                count: resumedCount,
                limit: this.tuning.crashResumeLimit,
              })
            : undefined;
      this.reportAll(active.messages, {
        status: "running",
        contextSeq: context.latestSeq,
        ...(using ? { ...said(using), progress: bridgeTextZh(using).slice(0, 200) } : {}),
      });
      this.room.setTyping(true);
      // 执行过程里标出这是中断后自动恢复的一轮：重跑不是悄悄发生的
      if (resumedCount > 0) {
        const at = new Date().toISOString();
        const note = bridgeTextZh(
          bridgeText("bridge.crashResumed", {
            count: resumedCount,
            limit: this.tuning.crashResumeLimit,
          }),
        );
        for (const message of active.messages) {
          this.room.trace(message.id, [
            {
              id: `crash-resume:${executionId}`,
              kind: "text",
              text: `↻ ${note}`,
              startedAt: at,
              endedAt: at,
            },
          ]);
        }
      }
      // Bridge 存活不等于 Runtime 在推进；心跳不得刷新最后一次真实进度的时间。
      let lastRuntimeProgressAt = Date.now();
      // 这一轮做过的可能有改动的步骤：切目录、中断后接着做时交给下一轮，提醒它别重复、先核对
      const mutatingSteps = new Map<
        string,
        { summary: string; done: boolean; irreversible?: boolean }
      >();
      active.steps = mutatingSteps;
      let lastProgressReportAt: number | undefined;
      let lastRuntimeReportAt: number | undefined;
      let lastProgress: string | undefined;
      let lastActivityKey: string | undefined;
      let lastActivityReportAt: number | undefined;
      // 执行过程：脱敏后按 id 合并，攒一小会儿再发，避免 Runtime 一条命令连发几十个事件
      const pendingTrace = new Map<string, TraceStep>();
      const flushTrace = () => {
        traceTimer = undefined;
        if (pendingTrace.size === 0) return;
        const steps = [...pendingTrace.values()];
        pendingTrace.clear();
        for (const message of active.messages) {
          if (active.cancelled.has(message.id)) continue;
          for (let index = 0; index < steps.length; index += 50) {
            this.room.trace(message.id, steps.slice(index, index + 50));
          }
        }
      };
      flushPendingTrace = () => {
        if (traceTimer) clearTimeout(traceTimer);
        flushTrace();
      };
      const reportProgress = (progress: string) => {
        lastProgressReportAt = Date.now();
        this.reportAll(active.messages, { status: "running", progress: progress.slice(0, 200) });
      };
      heartbeat = setInterval(() => {
        const now = Date.now();
        if (
          lastProgressReportAt !== undefined &&
          now - lastProgressReportAt < this.tuning.heartbeatMs
        ) {
          return;
        }
        const idleMs = Math.max(0, now - lastRuntimeProgressAt);
        const seconds = Math.floor(idleMs / 1000);
        const elapsed =
          seconds >= 60 ? `${Math.floor(seconds / 60)}分${seconds % 60}秒` : `${seconds}秒`;
        const warning = idleMs >= this.tuning.progressStaleMs ? "，状态待核实" : "";
        reportProgress(
          `仅 Bridge 心跳；${elapsed}未收到 Runtime 新进度${warning}${lastProgress ? `；上次：${lastProgress}` : ""}`,
        );
      }, this.tuning.heartbeatMs);
      heartbeat.unref?.();

      await this.selectTaskWorkspace(messages[0]!.id, preparedWorkspace, active.lane);
      // 没有任务目录的 Agent 也要换道：子任务在自己的会话里做
      if (this.currentLane() !== active.lane) {
        this.switchSession(this.state.workspace, active.lane);
        await this.store.save(this.state);
      }
      await this.renewMainSession(active, context.messages);
      let handoff: string | undefined;
      let handoffSteps: Array<{ summary: string; done: boolean; irreversible?: boolean }> = [];
      let handoffFrom: string | undefined;
      let handoffs = 0;
      // 这一轮调用了 hive_worktree_create、按 runtimeHandoff 结束了准备回合，但任务目录就是当前目录
      // （复用同一 slug、早已在这里）：没有可切换的，接着原会话把任务做完，不能就这么收尾
      let worktreeRequested = false;
      let continueHere = false;
      let reply: AgentReply;
      let prompt: PreparedPrompt;
      let usage: AgentUsage | undefined;
      while (true) {
        const built = await this.buildPrompt(
          this.applyTopicBoundary(context.messages),
          active.messages,
        );
        // 上一轮因上游出错中断：提醒 Agent 接着原会话从断点继续，别把已经做过的再做一遍
        const interrupted = messages
          .map((message) => this.resumeNotes.get(message.id))
          .find((note) => note !== undefined);
        for (const message of messages) this.resumeNotes.delete(message.id);
        // 中途开了新话题、旧会话已丢弃时，就不能说「会话已接上」
        prompt = interrupted
          ? {
              ...built,
              text: `（系统提示）你上一轮处理下面这条消息时，因上游模型服务出错在中途中断：${interrupted}\n${
                this.state.threadId
                  ? "会话已接上。请先根据你已经做过的操作确认进度，从中断处继续把原任务做完；"
                  : "原会话已随新话题丢弃，看不到上一轮的步骤。请先检查工作区和房间里的现状，确认哪些已经做过，再把原任务做完；"
              }不要重复已经完成的、有副作用的操作（改文件、提交、发消息等）。\n\n${built.text}`,
            }
          : built;
        // 上一轮 Agent 进程中途退出（那一轮没有任何副作用）：照常把任务做完，不必担心重复
        const crashNote = messages.map((message) => this.crashNotes.get(message.id)).find(Boolean);
        for (const message of messages) this.crashNotes.delete(message.id);
        if (resumedCount > 0 && !interrupted && !handoff)
          prompt = {
            ...prompt,
            text: crashNote
              ? // 会话真的接上了才这么说：中断时若刚建好任务目录，这里已在新目录开了新会话，看不到上一轮
                crashNote.threadId && this.state.threadId === crashNote.threadId
                ? `（系统提示）你上一轮处理下面这条消息时，Agent 进程意外退出、在中途中断；会话已接上。最后一步做没做完不确定，先核对现状再从中断处继续，不要重复已经完成的操作。${stepsNote(crashNote.steps)}\n\n${prompt.text}`
                : `（系统提示）你上一轮处理下面这条消息时，Agent 进程意外退出、在中途中断；这是新会话，看不到上一轮的步骤。不要从头重做原任务：先核对工作区、房间里的现状和下面列出的已做操作，确认做到哪了，再继续没做完的部分。${stepsNote(crashNote.steps, crashNote.cwd)}\n\n${prompt.text}`
              : `（系统提示）你上一轮处理下面这条消息时，Agent 进程意外退出、在中途中断；那一轮只做过只读操作，没有改动任何东西。请照常把原任务完整做完。\n\n${prompt.text}`,
          };
        if (continueHere)
          prompt = {
            ...prompt,
            text: `（系统提示）你上一轮调用 hive_worktree_create 后按 runtimeHandoff 结束了准备回合，但任务目录就是你当前所在的 ${this.options.cwd ?? "工作目录"}，不需要切换，会话也没有变。不要再停下等交接：接着把原任务做完。\n\n${prompt.text}`,
          };
        // 只在第一次开工时说：切到新任务目录之后，新会话里就不需要了
        const workspaceNote = handoff ? undefined : this.takeWorkspaceNote(messages);
        if (workspaceNote) prompt = { ...prompt, text: `${workspaceNote}\n\n${prompt.text}` };
        const gapNote =
          this.takeHandoffNote() ?? this.takeSessionGapNote() ?? this.takeFreshLaneNote();
        if (gapNote) prompt = { ...prompt, text: `${gapNote}\n\n${prompt.text}` };
        if (handoff)
          prompt = {
            ...prompt,
            text: `（系统提示）上一轮已正常结束；现在已在 ${this.options.cwd} ${this.state.threadId ? "接回你之前在这个目录里的会话，并有写权限" : "建立独立的新会话和写权限"}。不要重放原任务或重复已完成的操作；先核对工作区及上一轮摘要，再继续尚未完成的工作。${this.state.threadId ? "上一轮（准备回合）的会话没有搬到这里。" : "旧会话没有搬到这里。"}${stepsNote(handoffSteps, handoffFrom)}\n<previous_turn_summary untrusted="true">\n${handoff.slice(-12_000)}\n</previous_turn_summary>\n\n${prompt.text}`,
          };
        this.log(
          `[hive] 正在处理 ${messages.map((message) => `#${message.seq}`).join("、")}（来自 ${[...new Set(messages.map((message) => message.senderName))].join("、")}）`,
        );
        const turn: NonNullable<ActiveBatch["turn"]> = {
          startedAt: Date.now(),
          session: this.state.threadId ? "resumed" : "new",
        };
        active.turn = turn;
        // 这一轮的模型：「换个模型重试」选的优先，其次是网页上设置的；都没有就不传，用启动时的 --model
        const settings = this.settings();
        const turnModel = picked ?? settings.model;
        // 思考强度同理；都没有就不传，沿用 CLI 自己的配置
        const turnEffort = pickedEffort ?? settings.effort;
        if (turnEffort) turn.effort = turnEffort;
        // Claude 的自动压缩阈值：没设过按默认 40 万（老 Agent、命令行直接起的也一样），"auto" 不传交给 Claude Code
        const compactWindow = settings.compactWindow ?? CLAUDE_COMPACT_WINDOW_DEFAULT;
        if (compactWindow !== "auto" && this.options.provider === "claude")
          turn.compactWindow = compactWindow;
        const turnCacheTtl = this.cacheTtlFor(settings.cacheTtl);
        active.workspace = this.options.cwd;
        active.accepting = true;
        reply = await this.responder.reply({
          onUsage: (usage) => {
            turn.observed = usage;
          },
          instructions: this.instructions,
          prompt: prompt.text,
          refreshInstructions: prompt.full,
          ...(turnModel ? { model: turnModel } : {}),
          ...(compactWindow !== "auto" ? { compactWindow } : {}),
          ...(turnCacheTtl ? { cacheTtl: turnCacheTtl } : {}),
          onCompacted: (compaction) => {
            (turn.compactions ??= []).push(compaction);
            if (this.active !== active || active.controller.signal.aborted) return;
            const note = bridgeText("bridge.compacted", {
              before: formatTokens(compaction.preTokens),
              after:
                compaction.postTokens !== undefined ? formatTokens(compaction.postTokens) : "?",
            });
            this.log(`[hive] ${bridgeTextZh(note)}`);
            this.reportAll(active.messages, {
              status: "running",
              ...said(note),
              progress: bridgeTextZh(note).slice(0, 200),
            });
          },
          ...(turnEffort
            ? {
                effort: turnEffort,
                onEffortIgnored: (effort: string, options: string[]) => {
                  delete turn.effort;
                  if (this.active !== active || active.controller.signal.aborted) return;
                  const note = bridgeText("bridge.effortUnsupported", {
                    effort,
                    options: options.join(" / ") || "-",
                  });
                  this.log(`[hive] ${bridgeTextZh(note)}`);
                  this.reportAll(active.messages, {
                    status: "running",
                    ...said(note),
                    progress: bridgeTextZh(note).slice(0, 200),
                  });
                },
              }
            : {}),
          signal: active.controller.signal,
          onProgress: (progress) => {
            turn.firstOutputAt ??= Date.now();
            if (this.active !== active || active.controller.signal.aborted) return;
            lastRuntimeProgressAt = Date.now();
            lastProgress = progress.slice(0, 200);
            if (
              lastRuntimeReportAt !== undefined &&
              lastRuntimeProgressAt - lastRuntimeReportAt < this.tuning.progressThrottleMs
            ) {
              return;
            }
            lastRuntimeReportAt = lastRuntimeProgressAt;
            lastProgressReportAt = Date.now();
            this.reportAll(active.messages, {
              status: "running",
              progress: lastProgress,
              runtimeEvent: { kind: "activity", phase: "working" },
            });
          },
          requestApproval: (request) => this.askApproval(active, request),
          // 第一轮还没结束就能在终端里打开：一拿到会话 ID 就报，不等回合结束
          onSession: (sessionId) => {
            if (this.options.cwd) this.room.reportSession(sessionId, this.options.cwd);
            // 记下会话：进程中途退出后可以接着这个会话做，它记得已经做到哪
            const inflight = this.state.inflight;
            if (inflight?.executionId === executionId && inflight.threadId !== sessionId) {
              inflight.threadId = sessionId;
              void this.store.save(this.state).catch(() => undefined);
            }
          },
          // Hive 工具连不上：Agent 少了全部 hive_* 工具（读附件、白板、委派……），回复靠 Bridge 代发看不出来。
          // 记进日志，并在成员状态里标出来，不能悄无声息地少了工具
          onHiveTools: (status, detail) => {
            const clean = detail ? hiveToolsDetail(detail) : undefined;
            if (status === "unavailable")
              this.log(`[hive] Hive 工具（MCP）连不上${clean ? `：${clean}` : ""}`);
            this.room.reportHiveTools(status, clean);
          },
          onTrace: (step) => {
            turn.firstOutputAt ??= Date.now();
            if (this.active !== active || active.controller.signal.aborted) return;
            const clean = sanitizeTraceStep(step);
            if (isMutatingStep(step)) {
              active.mutated = true;
              const known = mutatingSteps.get(step.id);
              const done = step.status === "ok" || step.status === "error";
              if (!known || (done && !known.done)) {
                mutatingSteps.set(step.id, {
                  summary: (
                    known?.summary ??
                    (clean.summary || clean.name || clean.tool || "?")
                  ).slice(0, 160),
                  done,
                  ...(isIrreversibleStep(step) || known?.irreversible
                    ? { irreversible: true }
                    : {}),
                });
                // 落盘：进程这时退出，重启后据此决定怎么接着做（只在步骤开始、结束时写）
                const inflight = this.state.inflight;
                if (inflight?.executionId === executionId) {
                  inflight.mutated = true;
                  inflight.steps = [...mutatingSteps.values()].slice(-20);
                  void this.store.save(this.state).catch(() => undefined);
                }
              }
            }
            if (step.kind === "tool") active.toolUsed = true;
            if (/(?:^|[._])hive_worktree_create$/.test(step.name ?? "")) worktreeRequested = true;
            pendingTrace.set(clean.id, { ...pendingTrace.get(clean.id), ...clean });
            traceTimer ??= setTimeout(flushTrace, this.tuning.traceFlushMs);
          },
          onRuntimeEvent: (event) => {
            if (this.active !== active || active.controller.signal.aborted) return;
            const now = Date.now();
            if (event.kind === "activity" || event.kind === "recovered")
              lastRuntimeProgressAt = now;
            if (event.kind === "activity") {
              const key = `${event.phase}:${event.tool ?? ""}`;
              if (
                key === lastActivityKey &&
                lastActivityReportAt !== undefined &&
                now - lastActivityReportAt < this.tuning.progressThrottleMs
              )
                return;
              lastActivityKey = key;
              lastActivityReportAt = now;
              lastProgress =
                event.phase === "tool_running"
                  ? "Runtime 正在执行工具"
                  : event.phase === "tool_completed"
                    ? "Runtime 工具已返回（不代表任务完成）"
                    : event.phase === "starting"
                      ? "正在启动 Runtime"
                      : event.phase === "working"
                        ? "收到 Runtime 执行事件"
                        : "收到模型响应事件";
            }
            if (event.kind === "provider_error") lastProgress = "API 异常，等待恢复证据";
            if (event.kind === "recovered") lastProgress = "收到模型恢复证据";
            lastProgressReportAt = now;
            this.reportAll(
              active.messages.filter((message) => !active.cancelled.has(message.id)),
              {
                status: "running",
                runtimeEvent: event,
                ...(event.kind !== "capabilities" && lastProgress
                  ? { progress: lastProgress }
                  : {}),
              },
            );
          },
          ...(this.state.threadId ? { threadId: this.state.threadId } : {}),
        });
        active.accepting = false;
        flushPendingTrace();
        if (reply.usage) turn.observed = reply.usage;
        usage = this.settleUsage(active, "completed", reply);
        if (reply.threadId) this.state.threadId = reply.threadId;
        this.noteSessionLength(prompt.text, reply, turn.compactWindow);
        this.reportSession();
        this.notePromptSent(prompt);
        // 压缩可能把这一轮及之前发过的成员、白板快照概括掉了：下一轮补发全量
        if (reply.compacted) {
          this.state.compactedSinceFull = true;
          this.log("[hive] 这一轮压缩过上下文，下一轮重发完整的成员列表和白板");
        }
        // settled：这一轮已经跑完，合并的消息里有的中途结束了（提问被人先回答、被停止）也照常复核
        // 合入后开发环境换代、Server 正在重启时连不上：和补拉消息、发回复一样等它回来再复核，
        // 不因为快速重试的几次没赶上就把整轮判成结果未知；被拒绝（409、身份不符）照旧交人核对
        const selections = await this.whenOnline(
          "复核任务目录",
          () => this.taskWorkspaces(active.messages, { settled: true }),
          (error) => error instanceof TaskWorkspaceBusyError && !active.controller.signal.aborted,
        ).catch((error: unknown) => {
          // 这一轮已经执行过了：暂时忙也好、核对不上也好，都不能当成「还没开始」去重跑，交人核对
          if (isCancelled(error, active.controller.signal)) throw error;
          throw new AgentExecutionUncertainError(
            `这一轮已执行完，但没能复核任务目录（${error instanceof TaskWorkspaceBusyError ? error.reason : error instanceof Error ? error.message : String(error)}）。`,
            { cause: error, settled: true },
          );
        });
        const selected = selections.get(messages[0]!.id);
        if (
          this.options.taskWorkspace &&
          active.messages.some(
            (message) =>
              selections.get(message.id) !== undefined &&
              selections.get(message.id) !== (selected ?? this.defaultCwd),
          )
        )
          throw new AgentExecutionUncertainError("这一轮执行期间，几条消息绑定的任务目录变了。", {
            settled: true,
          });
        const previousCwd = this.options.cwd;
        const changed = await this.selectTaskWorkspace(messages[0]!.id, { path: selected });
        if (!changed) {
          if (worktreeRequested && !continueHere && !handoff && !active.controller.signal.aborted) {
            worktreeRequested = false;
            continueHere = true;
            continue;
          }
          break;
        }
        // 不再因为切目录前跑过什么就拦下：把这些步骤交给新会话，由它核对原目录、别重复已做的事
        handoffSteps = [...mutatingSteps.values()];
        handoffFrom = previousCwd;
        const detail = bridgeText("bridge.worktreeHandoff", { path: this.options.cwd! });
        for (const message of active.messages)
          this.room.report({
            messageId: message.id,
            status: "running",
            ...said(detail),
            ...this.usageReport(active),
          });
        // 人在切目录时点了停止：准备回合已做完，新会话还没开，按停止处理
        if (active.controller.signal.aborted)
          throw new AgentCancelledError("已切到任务目录，新会话开始前被停止；没有接着执行。");
        if (++handoffs > 1)
          throw new AgentNonRetryableError("一个任务里切了不止一次任务目录，请先核对该用哪个目录");
        handoff = reply.text;
      }

      const resolved = resolveReplyText(reply.text);
      const directive = parseAttachmentDirective(resolved.silent ? "" : resolved.text);
      let content = directive.text;
      if (!resolved.silent && !content && directive.paths.length === 0) {
        throw new Error("Agent 回复为空。");
      }
      const live = active.messages.filter(
        (message) => !this.recalled.has(message.id) && !active.cancelled.has(message.id),
      );
      // 结果已经出来了：之后与 Server 的往来如果赶上它重启，等它回来再交，不把整轮重跑
      const messagesAfterReply = await this.whenOnline("补拉回复前后的消息", () =>
        this.room.fetchMessages(context.latestSeq),
      );
      // 经 hive_invoke 发出的委派、hive_ask_human 提的问题只是中间动作，服务端代发的回执（子任务、定时任务说明）
      // 也不是这一轮自己发的；服务端以它名义发的房间提示（成了主 Agent）同样不算。都不能当成这一轮的回复，否则最终答复会被吞掉
      const toolMessages = messagesAfterReply.messages.filter(
        (message) =>
          message.senderId === this.ownParticipantId &&
          message.kind !== "delegation" &&
          message.kind !== "question" &&
          message.kind !== "receipt" &&
          message.kind !== "progress" &&
          message.kind !== "notice",
      );
      // 这一轮用 hive_message_send 发过消息，最终回复仍要照常代发：工具发的往往只是中途的进度（「收到，开始做」），
      // 只有最终输出为 NO_REPLY、和已发的内容相同，或只是一句「已发送」时，才把工具发的那条当作这一轮的回复
      const sentWithHiveTool =
        toolMessages.length > 0 &&
        (resolved.silent ||
          repeatsToolMessage(content, toolMessages) ||
          isSendAcknowledgement(content))
          ? toolMessages.at(-1)
          : undefined;
      let replyMessageId: string | undefined = sentWithHiveTool?.id;
      if (live.length === 0) {
        this.log("[hive] 本轮的触发消息都已被撤回或停止，不再发送回复");
      } else if (!sentWithHiveTool && resolved.silent) {
        this.log(
          `[hive] ${live.map((message) => `#${message.seq}`).join("、")} 无需回复，未发送消息`,
        );
      } else if (!sentWithHiveTool) {
        // 回复里声明的产物由本机 Bridge 上传成附件，随回复一起发出
        let attachmentIds: string[] = [];
        if (directive.paths.length) {
          const publisher = this.publisher;
          const published = publisher
            ? await this.whenOnline("上传附件", () => publisher.publish(directive.paths))
            : {
                attachmentIds: [],
                failures: directive.paths.map((item) => ({
                  path: item,
                  reason: "这个 Agent 没有配置工作目录，不能发布文件",
                })),
              };
          attachmentIds = published.attachmentIds;
          content = `${content}${describeFailures(published.failures)}`.trim();
          for (const failure of published.failures) {
            this.log(`[hive] 附件 ${failure.path} 未发出：${failure.reason}`);
          }
        }
        const sent = await this.whenOnline("发送回复", () =>
          this.room.sendMessage({
            content,
            ...(attachmentIds.length ? { attachmentIds } : {}),
            // 同一次执行（含本地重试）复用幂等键；人重试时换新键，确保会发出新回复
            clientMessageId: `agent-reply-${executionId}`,
            parentMessageId: pickReplyParent(live).id,
          }),
        );
        replyMessageId = sent.id;
      } else {
        this.log("[hive] 最终回复已用 hive_message_send 发出，不再重复代发。");
        if (directive.paths.length) {
          this.log(
            "[hive] 回复里声明的附件只随 Bridge 代发的回复发出，这次已用工具发送，附件未发出",
          );
        }
      }
      const resumedFor = new Map(
        active.messages.map((message) => [message.id, this.state.crashResumes?.[message.id] ?? 0]),
      );
      for (const message of active.messages) {
        this.recalled.delete(message.id);
        this.rememberProcessed(message.id);
      }
      this.state.lastProcessedSeq = Math.max(
        this.state.lastProcessedSeq,
        context.latestSeq,
        messagesAfterReply.latestSeq,
        ...active.messages.map((message) => message.seq),
      );
      delete this.state.inflight;
      // 先持久化"已处理"，再对外宣告完成：两步之间崩溃时宁可漏报，也不重复执行
      await this.store.save(this.state);
      const stopped = active.messages.filter((message) => active.cancelled.has(message.id));
      for (const [index, message] of stopped.entries()) {
        this.room.report({
          messageId: message.id,
          status: "cancelled",
          ...said(bridgeText("bridge.stoppedNoReply")),
          // 触发消息全停了也照样花了钱：用量记到第一条上
          ...(usage && live.length === 0 && index === 0 ? this.usageReport(active) : {}),
        });
      }
      // 一轮合并处理多条消息时，用量只随第一条上报，避免按消息重复计费
      const [usageCarrier, ...others] = live;
      // 中断后自动恢复过的：完成说明里写明恢复了几次，事后也看得出来
      const doneDetail = (messageId: string) => {
        const count = resumedFor.get(messageId) ?? 0;
        if (count === 0) return replyMessageId ? {} : said(bridgeText("bridge.noReply"));
        return said(
          bridgeText(replyMessageId ? "bridge.crashResumedDone" : "bridge.crashResumedNoReply", {
            count,
          }),
        );
      };
      if (usageCarrier) {
        this.room.report({
          messageId: usageCarrier.id,
          status: "completed",
          ...(replyMessageId ? { replyMessageId } : {}),
          ...doneDetail(usageCarrier.id),
          ...this.usageReport(active),
        });
      }
      for (const message of others) {
        this.room.report({
          messageId: message.id,
          status: "completed",
          ...(replyMessageId ? { replyMessageId } : {}),
          ...doneDetail(message.id),
        });
      }
      this.log(
        `[hive] ${replyMessageId ? "已回复" : "已处理"} ${active.messages.map((message) => `#${message.seq}`).join("、")}`,
      );
    } catch (error) {
      flushPendingTrace();
      await this.handleBatchError(active, error);
    } finally {
      active.accepting = false;
      stopWatchingRuntime();
      if (heartbeat) clearInterval(heartbeat);
      if (traceTimer) clearTimeout(traceTimer);
      traceTimer = undefined;
      if (this.active === active) this.active = undefined;
      // 等上游恢复后自动继续的任务还算在办：成员列表显示忙，不然对话流里还在「执行中」，列表却是空闲
      this.syncTyping();
    }
  }

  /** 连不上 Server 时等它回来再试；超过 offlineRetryMs 或遇到其它错误照常抛出 */
  private async whenOnline<T>(
    label: string,
    action: () => Promise<T>,
    retryable: (error: unknown) => boolean = () => true,
  ): Promise<T> {
    const deadline = Date.now() + this.tuning.offlineRetryMs;
    let warned = false;
    for (;;) {
      try {
        return await action();
      } catch (error) {
        if (
          this.stopped ||
          !retryable(error) ||
          !isServerUnavailable(error) ||
          Date.now() >= deadline
        )
          throw error;
        if (!warned) {
          warned = true;
          this.log(`[hive] ${label}时连不上 Hive Server，等它恢复后重试`);
        }
        await new Promise((resolve) => setTimeout(resolve, this.tuning.offlineRetryIntervalMs));
      }
    }
  }

  /**
   * 补全本轮用量（只做一次）：会话是新是旧、距上次模型请求的间隔、上一轮缓存的有效期、会话费用差额，
   * 并推进下一轮要用的基线。失败、停止、结果未知的回合同样记账。
   */
  private settleUsage(
    active: ActiveBatch,
    outcome: NonNullable<AgentUsage["outcome"]>,
    reply?: AgentReply,
  ): AgentUsage | undefined {
    const turn = active.turn;
    if (!turn?.observed) return undefined;
    // 已补全过（例如成功后发送回复时才出错）：只更新结局，基线不再推进
    if (turn.usage) {
      if (!turn.reported) turn.usage = { ...turn.usage, outcome };
      return turn.usage;
    }
    const raw = turn.observed;
    const now = Date.now();
    // 自报费用是会话累计值：同一会话减去上一轮的累计，换了会话（或累计值变小）就从头算
    let turnCostUsd: number | undefined;
    if (reply?.sessionCostUsd !== undefined && reply.threadId) {
      const previous =
        this.state.sessionCost?.threadId === reply.threadId
          ? this.state.sessionCost.usd
          : turn.session === "new"
            ? 0
            : undefined;
      // 续接的会话没有上一轮的累计（例如刚升级）：本轮费用未知，只记下基线
      if (previous !== undefined) {
        turnCostUsd =
          reply.sessionCostUsd >= previous ? reply.sessionCostUsd - previous : reply.sessionCostUsd;
      }
      this.state.sessionCost = { threadId: reply.threadId, usd: reply.sessionCostUsd };
    }
    // 间隔优先按模型请求算（上轮最后一次请求 → 本轮第一次请求），拿不到再按回合算（上轮结束 → 本轮开始）
    let idle: Pick<AgentUsage, "idleMs" | "idleBasis"> = {};
    if (turn.session === "resumed") {
      const lastRequest = Date.parse(this.state.lastRequestAt ?? "");
      const firstRequest = Date.parse(raw.firstRequestAt ?? "");
      const lastTurnEnded = Date.parse(this.state.lastTurnEndedAt ?? "");
      if (Number.isFinite(lastRequest) && Number.isFinite(firstRequest)) {
        idle = { idleMs: Math.max(0, firstRequest - lastRequest), idleBasis: "request" };
      } else if (Number.isFinite(lastTurnEnded)) {
        idle = { idleMs: Math.max(0, turn.startedAt - lastTurnEnded), idleBasis: "turn" };
      }
    }
    const usage: AgentUsage = {
      ...raw,
      ...(turnCostUsd !== undefined
        ? { reportedCostUsd: Math.round(turnCostUsd * 1e6) / 1e6 }
        : {}),
      ...(turn.effort ? { effort: turn.effort } : {}),
      ...(turn.firstOutputAt !== undefined
        ? { firstOutputMs: Math.max(0, turn.firstOutputAt - active.startedAt) }
        : {}),
      turnMs: Math.max(0, now - active.startedAt),
      ...(turn.compactions?.length ? { compactions: turn.compactions.slice(-20) } : {}),
      ...(turn.compactWindow ? { compactWindow: turn.compactWindow } : {}),
      session: turn.session,
      ...idle,
      ...(turn.session === "resumed" && this.state.lastCacheTtlMs
        ? { previousCacheTtlMs: this.state.lastCacheTtlMs }
        : {}),
      outcome,
    };
    this.state.lastTurnEndedAt = new Date(now).toISOString();
    if (raw.lastRequestAt) this.state.lastRequestAt = raw.lastRequestAt;
    // 只有 Runtime 区分了 5 分钟 / 1 小时写入，才记下缓存有效期；不区分的（如 Codex）保持未知
    if (raw.cacheWriteTokens > 0) {
      if (raw.cacheWrite1hTokens !== undefined) {
        this.state.lastCacheTtlMs = raw.cacheWrite1hTokens > 0 ? 3_600_000 : 300_000;
      } else delete this.state.lastCacheTtlMs;
    }
    // 缓存还能活多久：这一轮写了缓存就按写入的类型，只读了缓存（读也会续期）就沿用上一轮的；不知道就不填
    if (raw.requests > 0 && raw.lastRequestAt && this.state.lastCacheTtlMs)
      usage.cacheTtlMs = this.state.lastCacheTtlMs;
    turn.usage = usage;
    return usage;
  }

  /** 随一次上报带上本轮用量；同一轮只带一次，避免按消息重复计费 */
  private usageReport(active: ActiveBatch): { usage?: AgentUsage } {
    const usage = active.turn?.usage;
    if (!usage || active.turn?.reported) return {};
    active.turn!.reported = true;
    return { usage };
  }

  /** 等人批的权限申请：requestId → 收到决定时的回调 */
  private readonly approvals = new Map<string, (allow: boolean, reason?: string) => void>();

  /**
   * Runtime 执行中申请权限：交给服务端转成「允许 / 拒绝」的提问，等人批。
   * 服务端不支持、连不上、超时、这一轮被停止都按拒绝；只读档和完全权限档由各 Runtime 自己决定不走这里。
   */
  private askApproval(active: ActiveBatch, request: ApprovalRequest): Promise<boolean> {
    const trigger = active.messages.find((message) => !active.cancelled.has(message.id));
    if (!trigger || active.controller.signal.aborted) return Promise.resolve(false);
    const requestId = randomUUID();
    const sent = this.room.requestApproval({
      messageId: trigger.id,
      requestId,
      tool: request.tool.slice(0, 64),
      summary: request.summary.replace(/\s+/g, " ").trim().slice(0, 1000) || request.tool,
      ...(request.detail ? { detail: request.detail.slice(0, 4000) } : {}),
    });
    if (!sent) {
      this.log(`[hive] 权限申请没能交给人（服务端不支持或未连接），按拒绝处理：${request.summary}`);
      return Promise.resolve(false);
    }
    this.log(`[hive] 已把权限申请交给人批：${request.summary}`);
    return new Promise<boolean>((resolve) => {
      const finish = (allow: boolean, reason?: string) => {
        if (!this.approvals.delete(requestId)) return;
        clearTimeout(timer);
        active.controller.signal.removeEventListener("abort", onAbort);
        this.log(`[hive] 权限申请${allow ? "已获准" : `被拒绝${reason ? `：${reason}` : ""}`}`);
        resolve(allow);
      };
      const onAbort = () => finish(false, "这一轮已停止");
      const timer = setTimeout(() => finish(false, "等人批超时"), this.tuning.approvalTimeoutMs);
      timer.unref?.();
      active.controller.signal.addEventListener("abort", onAbort, { once: true });
      this.approvals.set(requestId, finish);
    });
  }

  private async handleBatchError(active: ActiveBatch, error: unknown): Promise<void> {
    const turnThread = this.state.inflight?.threadId;
    delete this.state.inflight;
    if (
      error instanceof TaskWorkspaceRemovedError &&
      !isCancelled(error, active.controller.signal)
    ) {
      this.settleUsage(active, "completed");
      for (const message of active.messages) this.rememberProcessed(message.id);
      await this.store.save(this.state);
      this.reportAll(active.messages, {
        status: "completed",
        ...said(bridgeText("bridge.worktreeCleaned", { path: error.path })),
        ...this.usageReport(active),
      });
      return;
    }
    if (error instanceof AgentUpstreamError && !isCancelled(error, active.controller.signal)) {
      await this.handleUpstreamError(active, error);
      return;
    }
    if (
      error instanceof AgentSessionInvalidError &&
      !isCancelled(error, active.controller.signal)
    ) {
      await this.handleSessionInvalid(active, error);
      return;
    }
    if (error instanceof AgentTransientError && !isCancelled(error, active.controller.signal)) {
      await this.handleTransient(active, error);
      return;
    }
    const outcome: NonNullable<AgentUsage["outcome"]> =
      error instanceof AgentExecutionUncertainError
        ? "uncertain"
        : isCancelled(error, active.controller.signal)
          ? "cancelled"
          : "failed";
    this.settleUsage(active, outcome);
    // 用量随第一条消息的上报发出
    const withUsage = (
      messages: ChatMessage[],
      report: Omit<InvocationReport, "type" | "messageId">,
    ) => {
      for (const message of messages) {
        this.room.report({ messageId: message.id, ...report, ...this.usageReport(active) });
      }
    };
    if (error instanceof AgentExecutionUncertainError) {
      // 人之后点「继续」要接上的是这一轮的会话：它可能是这一轮新开的，正常结束前还没写进 state
      if (turnThread) this.state.threadId = turnThread;
      // The provider may have completed side effects before its result stream was lost.
      for (const message of active.messages) this.rememberProcessed(message.id);
      await this.store.save(this.state);
      withUsage(active.messages, {
        status: "uncertain",
        // 带上 Runtime 给的具体原因（API 限流、流中断、停止未确认……）
        ...said(bridgeText("bridge.uncertain", { reason: sentence(error.message.slice(0, 380)) })),
      });
      return;
    }
    if (error instanceof AgentNonRetryableError) {
      for (const message of active.messages) this.rememberProcessed(message.id);
      await this.store.save(this.state);
      withUsage(active.messages, {
        status: "failed",
        ...said(bridgeText("bridge.unsafe", { reason: error.message.slice(0, 380) })),
      });
      this.log(`[hive] 不安全，已拒绝：${error.message}`);
      return;
    }
    if (isCancelled(error, active.controller.signal)) {
      this.log("[hive] 当前回合已停止");
      for (const message of active.messages) this.rememberProcessed(message.id);
      await this.store.save(this.state);
      withUsage(active.messages, {
        status: "cancelled",
        ...(this.stopped ? said(bridgeText("bridge.offline")) : {}),
      });
      return;
    }
    const reason = error instanceof Error ? error.message : String(error);
    this.log(`[hive] 处理 @mention 失败：${reason}`);
    const retryable: ChatMessage[] = [];
    const exhausted: ChatMessage[] = [];
    for (const message of active.messages) {
      const attempt = (this.attempts.get(message.id) ?? 0) + 1;
      this.attempts.set(message.id, attempt);
      if (attempt < MAX_ATTEMPTS) retryable.push(message);
      else exhausted.push(message);
    }
    // 本地重试耗尽：作为"死信"交给人处理，不再在重连时自动补做（先落盘再上报）
    for (const message of exhausted) this.rememberProcessed(message.id);
    await this.store.save(this.state);
    for (const message of exhausted) {
      this.log(
        `[hive] #${message.seq} 连续失败 ${MAX_ATTEMPTS} 次，已标记为失败，可在界面中重试。`,
      );
      this.room.report({
        messageId: message.id,
        status: "failed",
        ...said(bridgeText("bridge.failedRepeatedly", { attempts: MAX_ATTEMPTS, reason })),
        ...this.usageReport(active),
      });
    }
    if (retryable.length === 0) return;
    const attempt = Math.max(...retryable.map((message) => this.attempts.get(message.id) ?? 1));
    withUsage(retryable, {
      status: "running",
      progress: `第 ${attempt} 次尝试失败，稍后自动重试`,
    });
    const timer = setTimeout(
      () => {
        if (this.stopped) return;
        this.pending.unshift(...retryable.filter((message) => !this.isLocal(message.id)));
        void this.drain();
      },
      1_000 * 2 ** (attempt - 1),
    );
    timer.unref?.();
  }

  private settings() {
    return readAgentSettings(this.options.settingsFile);
  }

  /** 房间信息变了（房间设置、或多房间模式定时对账）：记下当前主 Agent，下一轮按新身份选缓存时长 */
  updateRoom(room: RoomSummary): void {
    if (room.id !== this.options.roomId) return;
    this.roomLeadAgent = room.leadAgent;
  }

  /** 自己是不是这个房间的主 Agent（名字不区分大小写，和 Server 一致） */
  private isRoomLead(): boolean {
    const lead = this.roomLeadAgent;
    return (
      lead !== undefined && lead.toLocaleLowerCase() === this.options.username.toLocaleLowerCase()
    );
  }

  /**
   * 这一轮的缓存时长：人在设置里选了 5 分钟或 1 小时就照办；跟随 Claude Code（没设）时，
   * 主 Agent 两轮之间常隔 5 分钟以上（等子任务回执、等人回复），默认按 1 小时，其余不传交给 Claude Code
   */
  private cacheTtlFor(chosen: "5m" | "1h" | undefined): "5m" | "1h" | undefined {
    if (chosen) return chosen;
    return this.options.provider === "claude" && this.isRoomLead() ? "1h" : undefined;
  }

  /**
   * 会话坏了（Codex 解不开旧会话里加密的推理内容、找不到之前的 response、恢复会话的文件坏了……）：
   * 丢掉旧会话，下一轮用完整上下文开新会话。这一轮还没执行任何工具就自动重跑一次；
   * 执行过工具、或已经自动重跑过的交给人，点「重试」时一定是新会话。
   */
  private async handleSessionInvalid(
    active: ActiveBatch,
    error: AgentSessionInvalidError,
  ): Promise<void> {
    this.settleUsage(active, "failed");
    delete this.state.threadId;
    delete this.state.promptContext;
    this.reportSession();
    const live = active.messages.filter((message) => !active.cancelled.has(message.id));
    const executed = error.executed || active.toolUsed === true || active.mutated === true;
    const retried = live.some((message) => this.sessionRetried.has(message.id));
    if (!executed && !retried && live.length > 0) {
      for (const message of live) this.sessionRetried.add(message.id);
      await this.store.save(this.state);
      this.log(`[hive] ${error.message}；这一轮还没执行工具，开新会话重跑`);
      for (const message of live) {
        this.room.report({
          messageId: message.id,
          status: "running",
          ...said(bridgeText("bridge.sessionRetrying", { reason: error.reason.slice(0, 200) })),
          failure: "session_invalid",
          progress: bridgeTextZh(
            bridgeText("bridge.sessionRetrying", { reason: error.reason.slice(0, 120) }),
          ).slice(0, 200),
          ...this.usageReport(active),
        });
      }
      this.pending.unshift(...live);
      void this.drain();
      return;
    }
    for (const message of active.messages) this.rememberProcessed(message.id);
    await this.store.save(this.state);
    const why = bridgeText(executed ? "bridge.sessionExecuted" : "bridge.sessionRetried");
    const detail = said(
      bridgeText("bridge.sessionInvalid", { reason: error.reason.slice(0, 360), why }),
    );
    this.log(`[hive] ${detail.detail}`);
    for (const message of live) {
      this.room.report({
        messageId: message.id,
        status: "failed",
        ...detail,
        failure: "session_invalid",
        ...this.usageReport(active),
      });
    }
  }

  /**
   * 上游模型服务出错：进程已正常退出、原因明确，不会有残留执行。按失败原因（failure.ts 的 failurePolicy）处理：
   * 断网、限流、过载、5xx 等一会儿接着原会话自动继续（次数与等待时间见 tuning 的 networkRetryDelaysMs、
   * upstreamRetryDelaysMs）；额度、认证、模型用不了、上下文超长这类等多久都不会好，直接报失败并写明要人做什么。
   * 次数用完或不自动重试的，由人点「继续」（即重试），同样接着原会话从断点往下做。
   */
  private async handleUpstreamError(active: ActiveBatch, error: AgentUpstreamError): Promise<void> {
    this.settleUsage(active, "failed");
    // 接着出错的那个会话继续：它记得这一轮已经做过的步骤
    if (error.threadId) this.state.threadId = error.threadId;
    this.reportSession();
    const live = active.messages.filter((message) => !active.cancelled.has(message.id));
    const steps = stepsNote([...(active.steps?.values() ?? [])]);
    for (const message of live) this.resumeNotes.set(message.id, `${error.reason}${steps}`);
    const used = Math.max(0, ...live.map((message) => this.upstreamRetries.get(message.id) ?? 0));
    // 按失败原因决定：断网等网络回来（那几档等得久），限流、过载、5xx 等一会儿；
    // 额度、认证、模型用不了、上下文超长这类等多久都不会好，不自动重试，写明要人做什么
    const policy = failurePolicy(error.kind);
    const delays =
      policy.retry === "network"
        ? this.tuning.networkRetryDelaysMs
        : this.tuning.upstreamRetryDelaysMs;
    const delay = policy.retry === "none" ? undefined : delays[used];
    // 上游出错时运行时是在两步之间发请求失败的：已经做完的步骤都记在会话里，接着原会话继续，
    // 提示里再写明做过哪些改动，Agent 自己就知道做到哪、不会重复。改过东西也照样自动继续
    if (delay !== undefined && live.length > 0) {
      for (const message of live) this.upstreamRetries.set(message.id, used + 1);
      await this.store.save(this.state);
      const reason =
        policy.retry === "network" ? "连不上模型服务（网络中断）" : UPSTREAM_FAILURE_PREFIX;
      const progress = (wait: string) =>
        `${reason}，${wait}后自动继续（第 ${used + 1}/${delays.length} 次）`.slice(0, 200);
      const wait = waitText(delay);
      this.log(`[hive] ${error.message}；这一轮没有改动，${wait}后自动继续`);
      for (const message of live) {
        this.room.report({
          messageId: message.id,
          status: "running",
          progress: progress(wait),
          detail: error.message.slice(0, 500),
          failure: error.kind,
          ...this.usageReport(active),
        });
      }
      this.resumeLater(
        live,
        delay,
        (remaining) => progress(`约 ${remaining}`),
        error.message.slice(0, 500),
        error.kind,
      );
      return;
    }
    for (const message of active.messages) {
      this.rememberProcessed(message.id);
      this.upstreamRetries.delete(message.id);
    }
    await this.store.save(this.state);
    const why = policy.fix
      ? bridgeText(`bridge.fix.${policy.fix}`)
      : bridgeText("bridge.upstreamExhausted", { count: delays.length });
    // 模型本身用不了：接着原会话「继续」还是同一个模型，没用，让人换模型
    const detail = said(
      error.kind === "model_unavailable"
        ? bridgeText("bridge.modelFailed", { reason: error.reason.slice(0, 360) })
        : bridgeText("bridge.upstreamFailed", { reason: error.reason.slice(0, 360), why }),
    );
    this.log(`[hive] ${detail.detail}，等人点「继续」`);
    for (const message of live) {
      this.room.report({
        messageId: message.id,
        status: "failed",
        ...detail,
        failure: error.kind,
        ...this.usageReport(active),
      });
    }
  }

  /** 等 delay 后把这些消息放回队首重新执行；等待中的消息算作本地在办：重连补拉、重复的 @ 都不会再另起一份 */
  private resumeLater(
    live: ChatMessage[],
    delay: number,
    progress: (remaining: string) => string,
    detail: string,
    failure?: FailureKind,
  ): void {
    const resumeAt = Date.now() + delay;
    const timer = setTimeout(() => {
      this.stopWaitingHeartbeat(timer);
      const resume: ChatMessage[] = [];
      for (const message of live) {
        if (this.waitingResume.get(message.id) !== timer) continue;
        this.waitingResume.delete(message.id);
        if (this.stopped || this.state.processedMessageIds.includes(message.id)) continue;
        resume.push(message);
      }
      if (resume.length === 0) {
        this.syncTyping();
        return;
      }
      this.pending.unshift(...resume);
      void this.drain();
    }, delay);
    timer.unref?.();
    for (const message of live) this.waitingResume.set(message.id, timer);
    // Server 把 heartbeat 窗口内没有更新的 running 调用判为超时（结果未知）：等多久都照常报进度
    const heartbeat = setInterval(() => {
      const remaining = waitText(Math.max(0, resumeAt - Date.now()));
      for (const message of live) {
        if (this.waitingResume.get(message.id) !== timer) continue;
        // detail、failure 和第一次上报保持一致：Server 收到不带 detail 的 running 会把它清空；用量第一次已经报过，这里不再带
        this.room.report({
          messageId: message.id,
          status: "running",
          progress: progress(remaining),
          detail,
          ...(failure ? { failure } : {}),
        });
      }
    }, this.tuning.heartbeatMs);
    heartbeat.unref?.();
    this.waitingHeartbeats.set(timer, heartbeat);
  }

  private stopWaitingHeartbeat(timer: NodeJS.Timeout): void {
    const heartbeat = this.waitingHeartbeats.get(timer);
    if (!heartbeat) return;
    clearInterval(heartbeat);
    this.waitingHeartbeats.delete(timer);
  }

  /**
   * 暂时性失败（Server 忙、握手超时……）：这一轮还没开始执行，按 tuning.transientRetryDelaysMs 退避自动重试，
   * 人看到的只是「稍后自动重试」的进度；次数用完才报失败，写明还没执行、重试安全。
   */
  private async handleTransient(active: ActiveBatch, error: AgentTransientError): Promise<void> {
    this.settleUsage(active, "failed");
    const live = active.messages.filter((message) => !active.cancelled.has(message.id));
    const reason = error instanceof TaskWorkspaceBusyError ? error.reason : error.message;
    const used = Math.max(0, ...live.map((message) => this.transientRetries.get(message.id) ?? 0));
    const delays = this.tuning.transientRetryDelaysMs;
    const delay = delays[used];
    if (delay !== undefined && live.length > 0) {
      for (const message of live) this.transientRetries.set(message.id, used + 1);
      await this.store.save(this.state);
      const progress = (wait: string) =>
        `暂时没成功，${wait}后自动重试（第 ${used + 1}/${delays.length} 次）`;
      const wait = `${Math.max(1, Math.round(delay / 1000))} 秒`;
      this.log(`[hive] 暂时没成功（${reason}），还没开始执行，${wait}后自动重试`);
      for (const message of live) {
        this.room.report({
          messageId: message.id,
          status: "running",
          progress: progress(wait),
          detail: reason.slice(0, 500),
          ...this.usageReport(active),
        });
      }
      this.resumeLater(
        live,
        delay,
        (remaining) => progress(`约 ${remaining}`),
        reason.slice(0, 500),
      );
      return;
    }
    for (const message of active.messages) this.rememberProcessed(message.id);
    await this.store.save(this.state);
    const detail = said(
      error instanceof TaskWorkspaceBusyError
        ? bridgeText("bridge.worktreeBusy", { reason: reason.slice(0, 300) })
        : bridgeText("bridge.transientFailed", { reason: reason.slice(0, 300), count: used }),
    );
    this.log(`[hive] ${detail.detail}`);
    for (const message of live) {
      this.room.report({
        messageId: message.id,
        status: "failed",
        ...detail,
        ...this.usageReport(active),
      });
    }
  }

  /**
   * 有人开启了新话题（或房主清空了房间）：丢弃 Provider 旧会话，上下文只保留分隔之后的消息。
   * 在每轮开始时检查而不是监听事件：Agent 离线期间发生的分隔，上线后第一轮同样生效。
   */
  private applyTopicBoundary(context: ChatMessage[]): ChatMessage[] {
    const boundary = context.filter((message) => message.kind === "topic").at(-1);
    if (!boundary) return context;
    if (boundary.seq > (this.state.topicSeq ?? 0)) {
      this.state.topicSeq = boundary.seq;
      // 收起来的会话都属于旧话题，不再接回
      delete this.state.parkedSessions;
      this.sessionGap = undefined;
      if (this.state.threadId) {
        this.log(`[hive] #${boundary.seq} 开启了新话题，丢弃之前的会话，从新会话开始`);
        delete this.state.threadId;
      }
    }
    return context.filter((message) => message.seq > boundary.seq);
  }

  /** 决定这一轮发完整上下文还是只发增量，并按需附带白板 */
  private async buildPrompt(
    context: ChatMessage[],
    triggers: ChatMessage[],
  ): Promise<PreparedPrompt> {
    const lastFull = this.state.lastFullPromptAt ? Date.parse(this.state.lastFullPromptAt) : 0;
    const full =
      !this.state.threadId ||
      this.state.instructionsDigest !== this.instructionsDigest() ||
      this.state.compactedSinceFull === true ||
      (this.state.briefTurns ?? 0) >= this.tuning.fullPromptEveryTurns ||
      Date.now() - lastFull >= this.tuning.fullPromptEveryMs;
    const previous =
      this.state.threadId && this.state.promptContext?.threadId === this.state.threadId
        ? this.state.promptContext
        : undefined;
    let whiteboardSnapshot: PromptContextSnapshot | undefined;
    let membersSnapshot: PromptContextSnapshot | undefined;
    // Refresh both cheaply from the room; only semantic differences enter the model prompt.
    // A failed fetch is unknown, not an empty list, and must not overwrite its last good baseline.
    await Promise.all([
      this.room
        .fetchWhiteboard()
        .then((entries) => {
          whiteboardSnapshot = snapshotWhiteboard(entries);
        })
        .catch((error: unknown) => {
          this.log(`[hive] ${error instanceof Error ? error.message : String(error)}`);
        }),
      this.room
        .fetchParticipants()
        .then((members) => {
          membersSnapshot = snapshotMembers(members, this.options.username);
        })
        .catch((error: unknown) => {
          this.log(`[hive] ${error instanceof Error ? error.message : String(error)}`);
        }),
    ]);
    const whiteboardUpdate = whiteboardSnapshot
      ? diffPromptContext(whiteboardSnapshot, previous?.whiteboard, full)
      : undefined;
    const membersUpdate = membersSnapshot
      ? diffPromptContext(membersSnapshot, previous?.members, full)
      : undefined;
    const [receiptResults, answeredQuestions] = await Promise.all([
      loadReceiptResults(triggers, context, (seq, id) => this.room.fetchMessageAt(seq, id)),
      this.answeredQuestions(triggers, context),
    ]);
    const attachmentPaths = await this.attachmentPaths([
      ...context,
      ...triggers,
      ...receiptResults.flatMap((entry) => (entry.result ? [entry.result] : [])),
    ]);
    // Claude --resume 与 Codex 线程都沿用会话创建时的系统规则：规则更新后在这一轮把完整新规则补发一次
    const rulesUpdated =
      Boolean(this.state.threadId && this.state.instructionsDigest) &&
      this.state.instructionsDigest !== this.instructionsDigest() &&
      RESUMED_SYSTEM_PROMPT_PROVIDERS.has(this.options.provider);
    const prompt = buildMentionPrompt({
      messages: context,
      triggers,
      receiptResults,
      answeredQuestions,
      contextBudgetTokens: contextBudgetFromEnv(),
      mode: full ? "full" : "brief",
      agentName: this.options.username,
      leadMessageIds: triggers
        .filter((message) => this.leadMessages.has(message.id))
        .map((message) => message.id),
      ...(membersUpdate ? { membersUpdate } : {}),
      ...(whiteboardUpdate ? { whiteboardUpdate } : {}),
      ...(membersSnapshot && !membersUpdate ? { membersUnchanged: true } : {}),
      ...(whiteboardSnapshot && !whiteboardUpdate ? { whiteboardUnchanged: true } : {}),
      now: new Date(),
      attachmentPaths,
    });
    return {
      text: rulesUpdated
        ? `你的工作规则已更新，以下为完整的新规则，与之前的规则冲突时以这里为准：\n<updated_rules>\n${this.instructions}\n</updated_rules>\n\n${prompt}`
        : prompt,
      full,
      ...(this.state.threadId ? { threadId: this.state.threadId } : {}),
      ...(whiteboardSnapshot ? { whiteboardSnapshot } : {}),
      ...(membersSnapshot ? { membersSnapshot } : {}),
    };
  }

  /** 触发消息是对提问的回答时，找回那条提问（隔了很久才答，提问往往已不在上下文里） */
  private answeredQuestions(triggers: ChatMessage[], context: ChatMessage[]) {
    return loadAnsweredQuestions(
      triggers,
      context,
      (seq, id) => this.room.fetchMessageAt(seq, id),
      (id) => this.room.fetchMessageById(id),
    ).catch((error: unknown) => {
      this.log(`[hive] ${error instanceof Error ? error.message : String(error)}`);
      return [];
    });
  }

  /** 为消息里的附件准备本机路径；拿不到的只在日志里记一笔，Agent 仍可改用 hive_attachment_read */
  private async attachmentPaths(messages: ChatMessage[]): Promise<AttachmentPaths> {
    const cache = this.attachments;
    if (!cache) return {};
    const items = messages.flatMap((message) =>
      message.deletedAt ? [] : (message.attachments ?? []),
    );
    const paths: AttachmentPaths = {};
    await Promise.all(
      items.map(async (item) => {
        const located = await cache.locate(item);
        if ("path" in located) paths[item.id] = located.path;
        else this.log(`[hive] 附件 ${item.name}：${located.error}`);
      }),
    );
    return paths;
  }

  private instructionsDigest(): string {
    return createHash("sha256").update(this.instructions).digest("hex").slice(0, 16);
  }

  private notePromptSent(prompt: PreparedPrompt): void {
    if (prompt.full) {
      delete this.state.compactedSinceFull;
      this.state.briefTurns = 0;
      this.state.lastFullPromptAt = new Date().toISOString();
      this.state.instructionsDigest = this.instructionsDigest();
    } else {
      this.state.briefTurns = (this.state.briefTurns ?? 0) + 1;
    }
    delete this.state.whiteboardDigest;
    const threadId = this.state.threadId;
    if (prompt.threadId !== threadId || this.state.promptContext?.threadId !== threadId) {
      delete this.state.promptContext;
    }
    // Some runtimes recover a missing thread themselves. A delta sent to that replacement
    // cannot establish a full baseline; send fresh snapshots on the next wake instead.
    if (!threadId || (!prompt.full && prompt.threadId !== threadId)) return;
    const context = this.state.promptContext ?? { threadId };
    if (prompt.whiteboardSnapshot) context.whiteboard = prompt.whiteboardSnapshot;
    if (prompt.membersSnapshot) context.members = prompt.membersSnapshot;
    this.state.promptContext = context;
  }
}

function normalizeReply(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 最终输出和本轮用工具发过的某条消息是同一段话（或几乎整段包含） */
export function repeatsToolMessage(content: string, sent: ChatMessage[]): boolean {
  const final = normalizeReply(content);
  if (!final) return false;
  return sent.some((message) => {
    const posted = normalizeReply(message.content);
    if (!posted) return false;
    if (posted === final) return true;
    const [shorter, longer] = posted.length < final.length ? [posted, final] : [final, posted];
    return longer.includes(shorter) && shorter.length >= longer.length * 0.9;
  });
}

/** 发完之后只说一句「已发送」：不是新的回复内容 */
export function isSendAcknowledgement(content: string): boolean {
  const text = normalizeReply(content);
  return (
    text.length <= 40 &&
    /(已|已经)(通过|用|经)?.{0,20}(发送|发出|回复|发到|发在)|^sent\b|hive_message_send/i.test(text)
  );
}

/** 连不上的原因会给房间里的人看：去掉本机用户目录，限制长度 */
export function hiveToolsDetail(detail: string): string {
  const home = homedir();
  const text = home ? detail.split(home).join("~") : detail;
  return text.replace(/\s+/g, " ").trim().slice(0, 300);
}
