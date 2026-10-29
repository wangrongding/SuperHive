import { codexStartupFailure } from "./codex-errors.js";
import { isMissingCodexThread } from "./codex-client.js";
import { createRequire } from "node:module";
import {
  CODEX_HIVE_TOOLS_APPROVAL_OVERRIDE,
  codexHiveMcpOverrides,
  type HiveMcpConnection,
} from "./hive-mcp-config.js";
import {
  AgentCancelledError,
  AgentExecutionUncertainError,
  AgentNonRetryableError,
  type AgentAccessMode,
  type AgentReply,
  type AgentReplyInput,
  type AgentResponder,
} from "./responder.js";
import {
  spawnStdioTransport,
  type StdioExit,
  type StdioTransport,
  type StdioTransportFactory,
} from "./stdio-transport.js";

/**
 * 基于常驻 `codex app-server` 进程（stdio 上的换行分隔 JSON-RPC）的 Codex Responder。
 * 相比每次调用 `codex mcp-server` 的 CodexMcpResponder，它支持：
 * - 向进行中的回合注入新消息（turn/steer）
 * - 中断回合（turn/interrupt）
 * - 流式进度（item/started 通知）
 */

export type AppServerExit = StdioExit;
export type AppServerTransport = StdioTransport;
export type AppServerTransportFactory = StdioTransportFactory;

export type CodexAppServerResponderOptions = {
  command: string;
  cwd: string;
  hive: HiveMcpConnection;
  access?: AgentAccessMode;
  model?: string;
  log?: (message: string) => void;
};

export type CodexAppServerResponderDependencies = {
  /** 自定义传输（测试用）；默认 spawn 真实的 codex 进程 */
  createTransport?: AppServerTransportFactory;
  /** 握手类请求（initialize / thread / turn start / steer 等）的超时，默认 60s */
  requestTimeoutMs?: number;
  /** 发出 turn/interrupt 后等待 turn/completed 的宽限时间，默认 10s */
  interruptGraceMs?: number;
  /** initialize 中上报的客户端版本 */
  clientVersion?: string;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_INTERRUPT_GRACE_MS = 10_000;

function packageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    return (require("../package.json") as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * 与 codex-client.ts 的 codexAccess 一致，但只读模式使用 "on-request"：
 * codex 0.162 起配置项 approval_policy="untrusted" 已不再被接受（进程直接报错退出）。
 * 只读沙箱下模型若申请越权，审批请求会被本客户端一律拒绝，因此仍保持只读。
 */
function codexAccess(access: AgentAccessMode = "read-only") {
  if (access === "workspace") {
    return { sandbox: "workspace-write", approvalPolicy: "never" } as const;
  }
  if (access === "full") {
    return { sandbox: "danger-full-access", approvalPolicy: "never" } as const;
  }
  return { sandbox: "read-only", approvalPolicy: "on-request" } as const;
}

/** app-server 返回的 JSON-RPC 错误 */
export class AppServerRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | undefined,
    message: string,
  ) {
    super(`Codex app-server ${method} 失败：${message}`);
    this.name = "AppServerRpcError";
  }
}

/** 请求在超时时间内没有响应 */
class RequestTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`Codex app-server ${method} 超时（${timeoutMs}ms）。`);
    this.name = "CodexRequestTimeoutError";
    this.name = "RequestTimeoutError";
  }
}

/** Explicit capability rejection only. It is not permission to try a different protocol. */
export class CodexAppServerUnsupportedError extends AgentNonRetryableError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexAppServerUnsupportedError";
  }
}

export function isAppServerUnsupported(error: unknown): boolean {
  return error instanceof CodexAppServerUnsupportedError;
}

export const spawnAppServerTransport: AppServerTransportFactory = spawnStdioTransport;

type PendingRequest = {
  method: string;
  /** 在读取到响应的同一时刻同步调用，避免与紧随其后的通知产生竞态 */
  onResult?: ((result: any) => void) | undefined;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};

type Session = {
  transport: AppServerTransport;
  nextId: number;
  pending: Map<number, PendingRequest>;
  /** 本进程已加载（start/resume 过）的线程，避免重复 resume */
  loadedThreads: Set<string>;
  ready: Promise<void>;
  initialized: boolean;
  dead: boolean;
};

type AgentMessage = { text: string; phase: string | null; turnId?: string };

type ActiveTurn = {
  session?: Session;
  threadId: string;
  turnId?: string;
  signal?: AbortSignal | undefined;
  onProgress?: ((progress: string) => void) | undefined;
  messages: AgentMessage[];
  reasoningReported: boolean;
  cancelled: boolean;
  interruptSent: boolean;
  graceTimer?: ReturnType<typeof setTimeout>;
  resolve: (reply: AgentReply) => void;
  reject: (error: Error) => void;
  settled: boolean;
};

function truncate(text: string, max: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > max ? `${singleLine.slice(0, max - 1)}…` : singleLine;
}

function progressForItem(item: any, turn: ActiveTurn): string | undefined {
  switch (item?.type) {
    case "commandExecution":
      return typeof item.command === "string" && item.command
        ? `执行命令：${truncate(item.command, 80)}`
        : "执行命令";
    case "fileChange": {
      const path = Array.isArray(item.changes) ? item.changes[0]?.path : undefined;
      return typeof path === "string" && path ? `修改文件：${path}` : "修改文件";
    }
    case "mcpToolCall":
      return `调用工具：${item.server}.${item.tool}`;
    case "webSearch":
      return "搜索网页";
    case "contextCompaction":
      return "压缩上下文";
    case "reasoning":
      if (turn.reasoningReported) return undefined;
      turn.reasoningReported = true;
      return "思考中";
    default:
      return undefined;
  }
}

function agentMessageOf(item: any): AgentMessage | undefined {
  if (item?.type !== "agentMessage" || typeof item.text !== "string") return undefined;
  return { text: item.text, phase: typeof item.phase === "string" ? item.phase : null };
}

/** 优先取最后一条 final_answer，否则取最后一条非空 agentMessage */
function pickReplyText(messages: AgentMessage[]): string {
  const nonEmpty = messages.filter((message) => message.text.trim());
  const final = nonEmpty.filter((message) => message.phase === "final_answer").at(-1);
  return (final ?? nonEmpty.at(-1))?.text.trim() ?? "";
}

function textInput(text: string) {
  return [{ type: "text", text, text_elements: [] }];
}

export class CodexAppServerResponder implements AgentResponder {
  private session: Session | undefined;
  private active: ActiveTurn | undefined;
  private executionUncertain = false;
  private readonly log: (message: string) => void;
  private readonly createTransport: AppServerTransportFactory;
  private readonly requestTimeoutMs: number;
  private readonly interruptGraceMs: number;
  private readonly clientVersion: string;

  constructor(
    private readonly options: CodexAppServerResponderOptions,
    dependencies: CodexAppServerResponderDependencies = {},
  ) {
    this.log = options.log ?? console.warn;
    this.createTransport = dependencies.createTransport ?? spawnAppServerTransport;
    this.requestTimeoutMs = dependencies.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.interruptGraceMs = dependencies.interruptGraceMs ?? DEFAULT_INTERRUPT_GRACE_MS;
    this.clientVersion = dependencies.clientVersion ?? packageVersion();
  }

  async reply(input: AgentReplyInput): Promise<AgentReply> {
    if (input.signal?.aborted) throw new AgentCancelledError();
    if (this.executionUncertain)
      throw new AgentNonRetryableError(
        "上次 Codex 执行结果尚未确认，当前会话已锁定；请核对执行与工具进程，不能直接重放任务。",
      );
    if (this.active)
      throw new AgentNonRetryableError("Codex 已有进行中的回合，请等待其结束后再发起新回合。");

    // 先占位，防止并发调用在握手期间重复进入
    const placeholder = { settled: false } as ActiveTurn;
    this.active = placeholder;
    let threadId: string;
    let session: Session;
    try {
      session = await this.ensureSession();
      this.throwIfAborted(input.signal);
      threadId = await this.openThread(session, input);
      this.throwIfAborted(input.signal);
    } catch (error) {
      if (this.active === placeholder) this.active = undefined;
      if (error instanceof AgentCancelledError) throw error;
      throw codexStartupFailure("app-server 会话准备", error);
    }

    return new Promise<AgentReply>((resolve, reject) => {
      const turn: ActiveTurn = {
        session,
        threadId,
        signal: input.signal,
        onProgress: input.onProgress,
        messages: [],
        reasoningReported: false,
        cancelled: false,
        interruptSent: false,
        settled: false,
        resolve,
        reject,
      };
      this.active = turn;

      const onAbort = () => {
        turn.cancelled = true;
        this.sendInterrupt(turn);
        // Only a terminal event acknowledges stop; an elapsed grace period is not proof.
        turn.graceTimer = setTimeout(() => {
          this.finishTurn(
            turn,
            new AgentExecutionUncertainError(
              "Codex 停止请求尚未收到结束确认，执行结果未知；禁止自动重放。",
            ),
          );
        }, this.interruptGraceMs);
      };
      input.signal?.addEventListener("abort", onAbort, { once: true });
      const cleanup = () => input.signal?.removeEventListener("abort", onAbort);
      turn.resolve = (reply) => {
        cleanup();
        resolve(reply);
      };
      turn.reject = (error) => {
        cleanup();
        reject(error);
      };

      const params: Record<string, unknown> = { threadId, input: textInput(input.prompt) };
      if (this.options.model) params.model = this.options.model;
      const onResult = (result: any) => {
        const turnId = result?.turn?.id;
        if (typeof turnId !== "string" || !turnId) {
          this.finishTurn(
            turn,
            new AgentExecutionUncertainError("Codex turn/start 返回缺少回合标识，执行结果未知。"),
          );
          return;
        }
        if (!turn.turnId) turn.turnId = turnId;
        if (turn.cancelled) this.sendInterrupt(turn);
      };
      this.request(session, "turn/start", params, true, onResult).then(
        () => undefined,
        () => {
          this.finishTurn(
            turn,
            new AgentExecutionUncertainError(
              "Codex turn/start 已发送但未取得可信执行结果，可能仍在运行；禁止自动重放。",
            ),
          );
        },
      );
    });
  }

  async steer(prompt: string): Promise<boolean> {
    const turn = this.active;
    const session = this.session;
    if (!turn || turn.settled || !turn.turnId || turn.cancelled || !session || session.dead) {
      return false;
    }
    try {
      await this.request(
        session,
        "turn/steer",
        { threadId: turn.threadId, expectedTurnId: turn.turnId, input: textInput(prompt) },
        true,
      );
      return true;
    } catch (error) {
      if (error instanceof AppServerRpcError) return false;
      const uncertain = new AgentExecutionUncertainError(
        "Codex turn/steer 已发送但未确认是否接收；不能将同一消息退回队列重放。",
      );
      this.finishTurn(turn, uncertain);
      throw uncertain;
    }
  }

  async close(): Promise<void> {
    const session = this.session;
    if (!session) return;
    this.teardown(session, new Error("Codex app-server 已关闭。"));
    session.transport.kill();
  }

  private throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw new AgentCancelledError();
  }

  private sendInterrupt(turn: ActiveTurn) {
    const session = turn.session;
    if (turn.interruptSent || !turn.turnId || !session || session.dead) return;
    turn.interruptSent = true;
    this.request(
      session,
      "turn/interrupt",
      { threadId: turn.threadId, turnId: turn.turnId },
      true,
    ).catch(() => this.log("[hive] Codex turn/interrupt 未获确认，仍需等待可信结束事件。"));
  }

  private finishTurn(turn: ActiveTurn, outcome: AgentReply | Error) {
    if (turn.settled) return;
    turn.settled = true;
    if (turn.graceTimer) clearTimeout(turn.graceTimer);
    if (this.active === turn) this.active = undefined;
    if (outcome instanceof AgentExecutionUncertainError) this.executionUncertain = true;
    if (outcome instanceof Error) turn.reject(outcome);
    else turn.resolve(outcome);
  }

  private async openThread(session: Session, input: AgentReplyInput): Promise<string> {
    const access = codexAccess(this.options.access);
    const common: Record<string, unknown> = {
      cwd: this.options.cwd,
      sandbox: access.sandbox,
      approvalPolicy: access.approvalPolicy,
      developerInstructions: input.instructions,
    };
    if (this.options.model) common.model = this.options.model;

    if (input.threadId) {
      if (session.loadedThreads.has(input.threadId)) return input.threadId;
      try {
        const result = await this.request(
          session,
          "thread/resume",
          { threadId: input.threadId, ...common, excludeTurns: true },
          true,
        );
        const threadId = typeof result?.thread?.id === "string" ? result.thread.id : input.threadId;
        session.loadedThreads.add(threadId);
        return threadId;
      } catch (error) {
        if (!(error instanceof AppServerRpcError) || !isMissingCodexThread(error)) throw error;
        this.log("[hive] Codex 明确报告旧会话不存在，在发送执行请求前创建新会话。");
      }
    }

    const result = await this.request(session, "thread/start", common, true);
    const threadId = result?.thread?.id;
    if (typeof threadId !== "string" || !threadId) {
      throw new Error("Codex app-server thread/start 没有返回线程 ID。");
    }
    session.loadedThreads.add(threadId);
    return threadId;
  }

  private ensureSession(): Promise<Session> {
    const existing = this.session;
    if (existing && !existing.dead) return existing.ready.then(() => existing);

    const access = codexAccess(this.options.access);
    const args = [
      "app-server",
      "-c",
      `sandbox_mode="${access.sandbox}"`,
      "-c",
      `approval_policy="${access.approvalPolicy}"`,
      ...codexHiveMcpOverrides(this.options.hive).flatMap((override) => ["-c", override]),
      "-c",
      CODEX_HIVE_TOOLS_APPROVAL_OVERRIDE,
    ];
    const transport = this.createTransport(this.options.command, args, { cwd: this.options.cwd });
    const session: Session = {
      transport,
      nextId: 1,
      pending: new Map(),
      loadedThreads: new Set(),
      ready: Promise.resolve(),
      initialized: false,
      dead: false,
    };
    this.session = session;
    transport.onLine((line) => this.handleLine(session, line));
    transport.onExit((exit) => this.handleExit(session, exit));

    session.ready = (async () => {
      try {
        await this.request(
          session,
          "initialize",
          {
            clientInfo: { name: "ai-hive", title: "AI Hive", version: this.clientVersion },
            capabilities: null,
          },
          true,
        );
      } catch (error) {
        this.teardown(session, error as Error);
        transport.kill();
        if (error instanceof AppServerRpcError && error.code === -32601) {
          throw new CodexAppServerUnsupportedError(
            "Codex app-server initialize 不受支持（JSON-RPC -32601）；请检查 CLI 版本，不会自动降级。",
            { cause: error },
          );
        }
        throw codexStartupFailure("app-server initialize", error);
      }
      this.notify(session, "initialized");
      session.initialized = true;
    })();
    return session.ready.then(() => session);
  }

  private request(
    session: Session,
    method: string,
    params: unknown,
    withTimeout: boolean,
    onResult?: (result: any) => void,
  ): Promise<any> {
    if (session.dead) return Promise.reject(new Error("Codex app-server 未运行。"));
    const id = session.nextId++;
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = { method, resolve, reject, onResult };
      if (withTimeout) {
        pending.timer = setTimeout(() => {
          session.pending.delete(id);
          reject(new RequestTimeoutError(method, this.requestTimeoutMs));
        }, this.requestTimeoutMs);
      }
      session.pending.set(id, pending);
      session.transport.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  private notify(session: Session, method: string, params?: unknown) {
    const message: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) message.params = params;
    session.transport.write(JSON.stringify(message));
  }

  private respond(session: Session, id: unknown, result: unknown) {
    session.transport.write(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  private handleLine(session: Session, line: string) {
    if (session.dead) return;
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return;
    let message: any;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;

    const hasId = message.id !== undefined && message.id !== null;
    if (hasId && typeof message.method === "string") {
      this.handleServerRequest(session, message.id, message.method, message.params);
      return;
    }
    if (hasId) {
      const pending = session.pending.get(message.id);
      if (!pending) return;
      session.pending.delete(message.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(
          new AppServerRpcError(
            pending.method,
            typeof message.error.code === "number" ? message.error.code : undefined,
            String(message.error.message ?? "未知错误"),
          ),
        );
      } else {
        pending.onResult?.(message.result);
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === "string") {
      this.handleNotification(message.method, message.params);
    }
  }

  /** Hive 代理以非交互方式运行，审批结果已由沙箱/审批策略预先决定，这里一律拒绝 */
  private handleServerRequest(session: Session, id: unknown, method: string, params: any) {
    switch (method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        this.respond(session, id, { decision: "decline" });
        return;
      case "execCommandApproval":
      case "applyPatchApproval":
        this.respond(session, id, {
          decision: { denied: { rejection: "AI Hive 代理以非交互方式运行，不接受审批请求。" } },
        });
        return;
      case "mcpServer/elicitation/request":
        this.respond(session, id, { action: "decline", content: null, _meta: null });
        return;
      default:
        void params;
        session.transport.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `AI Hive 不支持的请求：${method}` },
          }),
        );
    }
  }

  private matchesActive(params: any): ActiveTurn | undefined {
    const turn = this.active;
    if (!turn || turn.settled || !turn.threadId || params?.threadId !== turn.threadId) {
      return undefined;
    }
    const turnId = params.turnId ?? params.turn?.id;
    if (turn.turnId && typeof turnId === "string" && turnId !== turn.turnId) return undefined;
    return turn;
  }

  private handleNotification(method: string, params: any) {
    switch (method) {
      case "turn/started": {
        const turn = this.matchesActive(params);
        if (turn && !turn.turnId && typeof params.turn?.id === "string") {
          turn.turnId = params.turn.id;
          if (turn.cancelled) this.sendInterrupt(turn);
        }
        return;
      }
      case "item/started": {
        const turn = this.matchesActive(params);
        if (!turn?.onProgress) return;
        const progress = progressForItem(params.item, turn);
        if (progress) {
          try {
            turn.onProgress(progress);
          } catch {
            // 进度回调异常不影响回合
          }
        }
        return;
      }
      case "item/completed": {
        const turn = this.matchesActive(params);
        const message = turn ? agentMessageOf(params.item) : undefined;
        if (turn && message) {
          // 回合 ID 未知时也先收下，完成时再按回合 ID 过滤
          turn.messages.push({
            ...message,
            ...(typeof params.turnId === "string" ? { turnId: params.turnId } : {}),
          });
        }
        return;
      }
      case "turn/completed": {
        const turn = this.matchesActive(params);
        if (turn) this.completeTurn(turn, params.turn);
        return;
      }
      default:
        return;
    }
  }

  private completeTurn(turn: ActiveTurn, result: any) {
    const status = result?.status;
    if (!["completed", "failed", "interrupted"].includes(status)) {
      this.finishTurn(
        turn,
        new AgentExecutionUncertainError("Codex 未返回可信终态，结果未知；禁止自动重放。"),
      );
      return;
    }
    if (turn.cancelled && typeof result?.id !== "string") {
      this.finishTurn(
        turn,
        new AgentExecutionUncertainError("Codex 结束事件缺少回合标识，不能确认停止。"),
      );
      return;
    }
    if (turn.cancelled || (status === "interrupted" && turn.signal?.aborted)) {
      this.finishTurn(turn, new AgentCancelledError());
      return;
    }
    if (status === "failed") {
      this.finishTurn(
        turn,
        new AgentNonRetryableError("Codex 回合已报告失败；可能已执行部分操作，不会自动重放。"),
      );
      return;
    }
    if (status === "interrupted") {
      this.finishTurn(turn, new AgentNonRetryableError("Codex 回合被中断；不会自动重放。"));
      return;
    }
    let messages = turn.messages.filter(
      (message) => !message.turnId || !turn.turnId || message.turnId === turn.turnId,
    );
    if (!messages.length && Array.isArray(result?.items)) {
      messages = result.items
        .map((item: unknown) => agentMessageOf(item))
        .filter((item: AgentMessage | undefined): item is AgentMessage => Boolean(item));
    }
    const text = pickReplyText(messages);
    if (!text) {
      this.finishTurn(
        turn,
        new AgentExecutionUncertainError(
          "Codex 已结束但没有返回可发送的文本，结果未知；禁止自动重放。",
        ),
      );
      return;
    }
    this.finishTurn(turn, { text, threadId: turn.threadId });
  }

  private handleExit(session: Session, exit: AppServerExit) {
    // close() 或握手失败时已经收尾过
    if (session.dead) return;
    let error: Error;
    if ((exit.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      error = Object.assign(
        new Error(`找不到 Codex 命令 “${this.options.command}”。请先安装 Codex CLI 并完成登录。`),
        { code: "ENOENT" },
      );
    } else {
      const detail = `code=${exit.code ?? "null"}${exit.signal ? `, signal=${exit.signal}` : ""}`;
      error = codexStartupFailure(`app-server 退出（${detail}）`, exit.error, exit.stderr);
    }
    this.teardown(session, error);
  }

  /** A dead transport is not proof that submitted execution had no side effects. */
  private teardown(session: Session, error: Error) {
    session.dead = true;
    if (this.session === session) this.session = undefined;
    for (const pending of session.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    session.pending.clear();
    const turn = this.active;
    if (turn && turn.session === session) {
      this.finishTurn(
        turn,
        new AgentExecutionUncertainError(
          "Codex app-server 连接关闭，已发送回合的执行结果未知；禁止自动重放。",
        ),
      );
    }
  }
}
