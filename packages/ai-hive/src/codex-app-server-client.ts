import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import {
  CODEX_HIVE_TOOLS_APPROVAL_OVERRIDE,
  codexHiveMcpOverrides,
  type HiveMcpConnection,
} from "./hive-mcp-config.js";
import {
  AgentCancelledError,
  type AgentAccessMode,
  type AgentReply,
  type AgentReplyInput,
  type AgentResponder,
} from "./responder.js";

/**
 * 基于常驻 `codex app-server` 进程（stdio 上的换行分隔 JSON-RPC）的 Codex Responder。
 * 相比每次调用 `codex mcp-server` 的 CodexMcpResponder，它支持：
 * - 向进行中的回合注入新消息（turn/steer）
 * - 中断回合（turn/interrupt）
 * - 流式进度（item/started 通知）
 */

/** 子进程退出信息；error 表示 spawn 本身失败（如 ENOENT） */
export type AppServerExit = {
  code: number | null;
  signal: string | null;
  error?: Error;
  /** stderr 最近的一段输出，便于诊断 */
  stderr: string;
};

/** 与 app-server 通信的最小传输抽象，测试中可注入假实现 */
export type AppServerTransport = {
  write(line: string): void;
  onLine(listener: (line: string) => void): void;
  onExit(listener: (exit: AppServerExit) => void): void;
  kill(): void;
};

export type AppServerTransportFactory = (
  command: string,
  args: string[],
  options: { cwd: string },
) => AppServerTransport;

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
const STDERR_TAIL_LIMIT = 4_000;

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
    this.name = "RequestTimeoutError";
  }
}

/** 当前 codex 不支持 app-server（版本过旧），调用方应回退到 CodexMcpResponder */
export class CodexAppServerUnsupportedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CodexAppServerUnsupportedError";
  }
}

const UNSUPPORTED_PATTERN =
  /unrecognized subcommand|unexpected argument '?app-server|stdin is not a terminal|unknown variant `initialize`|method not found/i;

/**
 * 判断错误是否意味着本机 codex 不支持 `app-server`。检测方式：
 * 1. 进程在 initialize 返回之前就退出，且 stderr 符合旧版特征（旧版 codex 会把 "app-server"
 *    当作提示词进入 TUI，因 stdin 不是终端报 "stdin is not a terminal" 退出；或 clap 报
 *    unrecognized subcommand）→ CodexAppServerUnsupportedError。其他握手前退出（如配置错误）不算；
 * 2. initialize 超时或返回 JSON-RPC 错误（协议不兼容）→ 同样包装为 CodexAppServerUnsupportedError；
 * 3. 兜底：错误消息（含 cause 链）匹配上述特征文本。
 * ENOENT（根本没装 codex）不算，回退也没有意义。
 */
export function isAppServerUnsupported(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (current instanceof CodexAppServerUnsupportedError) return true;
    const message = current instanceof Error ? current.message : String(current);
    if (UNSUPPORTED_PATTERN.test(message)) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

/** 默认传输：spawn 子进程，stdout 按行读取，stderr 透传并保留尾部 */
export const spawnAppServerTransport: AppServerTransportFactory = (command, args, options) => {
  const child = spawn(command, args, { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] });
  const lineListeners: Array<(line: string) => void> = [];
  const exitListeners: Array<(exit: AppServerExit) => void> = [];
  let stderrTail = "";
  let exited = false;
  const emitExit = (exit: Omit<AppServerExit, "stderr">) => {
    if (exited) return;
    exited = true;
    for (const listener of exitListeners) listener({ ...exit, stderr: stderrTail });
  };

  createInterface({ input: child.stdout! }).on("line", (line) => {
    for (const listener of lineListeners) listener(line);
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_LIMIT);
  });
  // stdin 写入失败（进程已退出）时不要抛出未处理异常，退出事件会负责收尾
  child.stdin!.on("error", () => undefined);
  child.on("error", (error) => emitExit({ code: null, signal: null, error }));
  child.on("close", (code, signal) => emitExit({ code, signal }));

  return {
    write(line) {
      if (!exited && child.stdin!.writable) child.stdin!.write(`${line}\n`);
    },
    onLine(listener) {
      lineListeners.push(listener);
    },
    onExit(listener) {
      exitListeners.push(listener);
    },
    kill() {
      if (!exited) child.kill("SIGTERM");
    },
  };
};

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
    if (this.active) throw new Error("Codex 已有进行中的回合，请等待其结束后再发起新回合。");

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
      throw error;
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
        // 等待 turn/completed(interrupted)；超过宽限期仍未结束则直接放弃
        turn.graceTimer = setTimeout(() => {
          this.finishTurn(turn, new AgentCancelledError());
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
        if (typeof turnId === "string" && !turn.turnId) turn.turnId = turnId;
        if (turn.cancelled) this.sendInterrupt(turn);
      };
      this.request(session, "turn/start", params, true, onResult).then(
        () => undefined,
        (error: Error) => {
          this.finishTurn(turn, turn.cancelled ? new AgentCancelledError() : error);
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
      if (!(error instanceof AppServerRpcError)) {
        this.log(`[hive] Codex 注入消息失败：${(error as Error).message}`);
      }
      return false;
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
    ).catch((error: Error) => this.log(`[hive] Codex 中断回合失败：${error.message}`));
  }

  private finishTurn(turn: ActiveTurn, outcome: AgentReply | Error) {
    if (turn.settled) return;
    turn.settled = true;
    if (turn.graceTimer) clearTimeout(turn.graceTimer);
    if (this.active === turn) this.active = undefined;
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
        if (!(error instanceof AppServerRpcError)) throw error;
        this.log(
          `[hive] Codex 旧会话 ${input.threadId} 已失效（${error.message}），自动创建新会话继续处理。`,
        );
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
        session.dead = true;
        if (this.session === session) this.session = undefined;
        transport.kill();
        const cause = error as Error;
        // 只有协议层面的失败（initialize 返回错误或无响应超时）才视为不支持；
        // 进程退出（ENOENT、配置错误等）已在 handleExit 中分类
        if (!(cause instanceof AppServerRpcError) && !(cause instanceof RequestTimeoutError)) {
          throw cause;
        }
        throw new CodexAppServerUnsupportedError(
          `当前 Codex 无法以 app-server 模式完成握手：${cause.message}`,
          { cause },
        );
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
    if (turn.cancelled || (status === "interrupted" && turn.signal?.aborted)) {
      this.finishTurn(turn, new AgentCancelledError());
      return;
    }
    if (status === "failed") {
      this.finishTurn(turn, new Error(result?.error?.message || "Codex 回合执行失败。"));
      return;
    }
    if (status === "interrupted") {
      this.finishTurn(turn, new Error("Codex 回合被中断"));
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
      this.finishTurn(turn, new Error("Codex 没有返回可发送的文本。"));
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
      const detail = exit.error
        ? exit.error.message
        : `code=${exit.code ?? "null"}${exit.signal ? `, signal=${exit.signal}` : ""}`;
      const stderr = exit.stderr.trim() ? `\n${exit.stderr.trim().slice(-1_000)}` : "";
      const message = `Codex app-server 意外退出（${detail}）。${stderr}`;
      // 握手前退出且输出符合旧版特征才视为不支持；配置错误等其他原因如实上报
      error =
        !session.initialized && UNSUPPORTED_PATTERN.test(`${detail}\n${exit.stderr}`)
          ? new CodexAppServerUnsupportedError(message)
          : new Error(message);
    }
    this.teardown(session, error);
  }

  /** 进程失效：拒绝所有挂起请求和进行中的回合，下次 reply 会重新启动并重新 resume 线程 */
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
      this.finishTurn(turn, turn.cancelled ? new AgentCancelledError() : error);
    }
  }
}
