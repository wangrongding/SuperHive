import { createRequire } from "node:module";
import path from "node:path";
import { acpHiveMcpServer, type HiveMcpConnection } from "./hive-mcp-config.js";
import {
  AgentCancelledError,
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
 * 基于 Agent Client Protocol（ACP，stdio 上的换行分隔 JSON-RPC）的通用 Responder。
 * opencode（`opencode acp`）与 omp（`omp --mode acp`）都实现了 ACP 的 Agent 端，相比逐次调用 CLI：
 * - Hive MCP 随 session/new 按会话注入，不写入任何配置文件，也不受用户全局 MCP 影响（omp）
 * - Agent 发起的 session/request_permission 由本客户端按 --access 档位逐次裁决
 * - 停止走 session/cancel，工具调用通过 session/update 实时上报为进度
 * - 进程常驻，会话可在进程重启后通过 session/resume 或 session/load 恢复
 */

export const ACP_PROTOCOL_VERSION = 1;

export type AcpToolCall = {
  title?: string;
  kind?: string;
  locations?: Array<{ path?: string }>;
  rawInput?: unknown;
};

export type AcpResponderOptions = {
  /** 日志与错误里显示的名称，如 "OpenCode" */
  label: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd: string;
  hive: HiveMcpConnection;
  access?: AgentAccessMode;
  log?: (message: string) => void;
};

export type AcpResponderDependencies = {
  /** 自定义传输（测试用）；默认 spawn 真实的 Agent 进程 */
  createTransport?: StdioTransportFactory;
  /** 握手类请求（initialize / session/new / load / steering）的超时，默认 120s */
  requestTimeoutMs?: number;
  /** 发出 session/cancel 后等待 prompt 结束的宽限时间，超时则结束进程，默认 10s */
  cancelGraceMs?: number;
  clientVersion?: string;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_CANCEL_GRACE_MS = 10_000;

function packageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    return (require("../package.json") as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Agent 返回的 JSON-RPC 错误 */
export class AcpRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | undefined,
    message: string,
  ) {
    super(`${method} 失败：${message}`);
    this.name = "AcpRpcError";
  }
}

class RequestTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`${method} 超时（${timeoutMs}ms）。`);
    this.name = "RequestTimeoutError";
  }
}

function isInside(cwd: string, target: string): boolean {
  const relative = path.relative(cwd, path.resolve(cwd, target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** 从工具调用里收集涉及的文件路径：locations 优先，rawInput 里常见的路径字段兜底 */
function toolCallPaths(toolCall: AcpToolCall): string[] {
  const paths = (toolCall.locations ?? [])
    .map((location) => location.path)
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  const input = toolCall.rawInput;
  if (input && typeof input === "object" && !Array.isArray(input)) {
    for (const key of ["path", "filePath", "file_path", "from", "to", "destination"]) {
      const value = (input as Record<string, unknown>)[key];
      if (typeof value === "string" && value) paths.push(value);
    }
  }
  return paths;
}

/**
 * 按 --access 档位裁决一次权限请求。Hive 代理无人值守，没有"询问用户"这一选项：
 * - read-only：只放行读取、搜索、思考类工具
 * - workspace：文件改动必须全部落在 cwd 之内（无法判断路径时拒绝），命令执行放行
 * - full：全部放行
 */
export function decideAcpPermission(
  access: AgentAccessMode,
  cwd: string,
  toolCall: AcpToolCall,
): "allow" | "reject" {
  if (access === "full") return "allow";
  const kind = toolCall.kind ?? "other";
  if (access === "read-only")
    return ["read", "search", "think"].includes(kind) ? "allow" : "reject";
  if (kind === "edit" || kind === "delete" || kind === "move") {
    const paths = toolCallPaths(toolCall);
    return paths.length > 0 && paths.every((target) => isInside(cwd, target)) ? "allow" : "reject";
  }
  return "allow";
}

type PermissionOption = { optionId: string; kind?: string };

/** 只用一次性选项，避免 "always" 把单次裁决扩大成会话级授权 */
function pickPermissionOption(
  options: PermissionOption[],
  decision: "allow" | "reject",
): PermissionOption | undefined {
  const preferred =
    decision === "allow" ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  for (const kind of preferred) {
    const option = options.find((candidate) => candidate.kind === kind);
    if (option) return option;
  }
  return undefined;
}

function truncate(text: string, max: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > max ? `${singleLine.slice(0, max - 1)}…` : singleLine;
}

function progressForToolCall(toolCall: AcpToolCall): string | undefined {
  const title = toolCall.title ? truncate(toolCall.title, 80) : "";
  if (!title) return undefined;
  switch (toolCall.kind) {
    case "execute":
      return `执行命令：${title}`;
    case "edit":
    case "delete":
    case "move":
      return `修改文件：${title}`;
    case "read":
      return `读取：${title}`;
    case "search":
      return `搜索：${title}`;
    case "fetch":
      return `获取：${title}`;
    case "think":
      return undefined;
    default:
      return `调用工具：${title}`;
  }
}

type PendingRequest = {
  method: string;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};

type AgentProcess = {
  transport: StdioTransport;
  nextId: number;
  pending: Map<number, PendingRequest>;
  /** 本进程已创建或恢复过的会话 */
  loadedSessions: Set<string>;
  capabilities: any;
  steering: boolean;
  ready: Promise<void>;
  initialized: boolean;
  dead: boolean;
};

type ActiveTurn = {
  process?: AgentProcess;
  sessionId?: string;
  signal?: AbortSignal | undefined;
  onProgress?: ((progress: string) => void) | undefined;
  /** 按工具调用切分的回复片段：最后一个非空片段即最终回答 */
  segments: string[];
  toolTitles: Map<string, string>;
  thinkingReported: boolean;
  cancelled: boolean;
  graceTimer?: ReturnType<typeof setTimeout>;
  resolve: (reply: AgentReply) => void;
  reject: (error: Error) => void;
  settled: boolean;
};

export class AcpResponder implements AgentResponder {
  private agent: AgentProcess | undefined;
  private active: ActiveTurn | undefined;
  private readonly log: (message: string) => void;
  private readonly createTransport: StdioTransportFactory;
  private readonly requestTimeoutMs: number;
  private readonly cancelGraceMs: number;
  private readonly clientVersion: string;

  constructor(
    private readonly options: AcpResponderOptions,
    dependencies: AcpResponderDependencies = {},
  ) {
    this.log = options.log ?? console.warn;
    this.createTransport = dependencies.createTransport ?? spawnStdioTransport;
    this.requestTimeoutMs = dependencies.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.cancelGraceMs = dependencies.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
    this.clientVersion = dependencies.clientVersion ?? packageVersion();
  }

  async reply(input: AgentReplyInput): Promise<AgentReply> {
    if (input.signal?.aborted) throw new AgentCancelledError();
    if (this.active) {
      throw new Error(`${this.options.label} 已有进行中的回合，请等待其结束后再发起新回合。`);
    }

    // 先占位，防止并发调用在握手期间重复进入
    const placeholder = { settled: false } as ActiveTurn;
    this.active = placeholder;
    let agent: AgentProcess;
    let session: { sessionId: string; fresh: boolean };
    try {
      agent = await this.ensureAgent();
      this.throwIfAborted(input.signal);
      session = await this.openSession(agent, input.threadId);
      this.throwIfAborted(input.signal);
    } catch (error) {
      if (this.active === placeholder) this.active = undefined;
      throw error;
    }

    // ACP 没有系统提示词字段：新会话或需要刷新时把规则拼进本轮消息
    const text =
      session.fresh || input.refreshInstructions
        ? `${input.instructions}\n\n---\n\n${input.prompt}`
        : input.prompt;

    return new Promise<AgentReply>((resolve, reject) => {
      const turn: ActiveTurn = {
        process: agent,
        sessionId: session.sessionId,
        signal: input.signal,
        onProgress: input.onProgress,
        segments: [""],
        toolTitles: new Map(),
        thinkingReported: false,
        cancelled: false,
        settled: false,
        resolve,
        reject,
      };
      this.active = turn;

      const onAbort = () => this.cancelTurn(turn);
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

      this.request(
        agent,
        "session/prompt",
        { sessionId: session.sessionId, prompt: [{ type: "text", text }] },
        false,
      ).then(
        (result) => this.completeTurn(turn, result),
        (error: Error) => this.finishTurn(turn, turn.cancelled ? new AgentCancelledError() : error),
      );
    });
  }

  async steer(prompt: string): Promise<boolean> {
    const turn = this.active;
    const agent = this.agent;
    if (!turn || turn.settled || turn.cancelled || !turn.sessionId) return false;
    if (!agent || agent.dead || !agent.steering || turn.process !== agent) return false;
    try {
      const result = await this.request(
        agent,
        "_session/steering",
        { sessionId: turn.sessionId, prompt: [{ type: "text", text: prompt }] },
        true,
      );
      return result?.outcome === "injected";
    } catch (error) {
      if (!(error instanceof AcpRpcError)) {
        this.log(`[hive] ${this.options.label} 注入消息失败：${(error as Error).message}`);
      }
      return false;
    }
  }

  async close(): Promise<void> {
    const agent = this.agent;
    if (!agent) return;
    this.teardown(agent, new Error(`${this.options.label} 已关闭。`));
    agent.transport.kill();
  }

  private throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw new AgentCancelledError();
  }

  private cancelTurn(turn: ActiveTurn) {
    if (turn.settled || turn.cancelled) return;
    turn.cancelled = true;
    const agent = turn.process;
    if (!agent || agent.dead || !turn.sessionId) {
      this.finishTurn(turn, new AgentCancelledError());
      return;
    }
    this.notify(agent, "session/cancel", { sessionId: turn.sessionId });
    // 等待 prompt 以 stopReason=cancelled 结束；Agent 卡住时结束进程，下次回合会恢复会话
    turn.graceTimer = setTimeout(() => {
      this.log(`[hive] ${this.options.label} 未在宽限期内停止，结束进程。`);
      this.finishTurn(turn, new AgentCancelledError());
      this.teardown(agent, new AgentCancelledError());
      agent.transport.kill();
    }, this.cancelGraceMs);
  }

  private finishTurn(turn: ActiveTurn, outcome: AgentReply | Error) {
    if (turn.settled) return;
    turn.settled = true;
    if (turn.graceTimer) clearTimeout(turn.graceTimer);
    if (this.active === turn) this.active = undefined;
    if (outcome instanceof Error) turn.reject(outcome);
    else turn.resolve(outcome);
  }

  private completeTurn(turn: ActiveTurn, result: any) {
    const stopReason = typeof result?.stopReason === "string" ? result.stopReason : "end_turn";
    const label = this.options.label;
    if (turn.cancelled || (stopReason === "cancelled" && turn.signal?.aborted)) {
      this.finishTurn(turn, new AgentCancelledError());
      return;
    }
    const text =
      turn.segments
        .filter((segment) => segment.trim())
        .at(-1)
        ?.trim() ?? "";
    if (stopReason === "cancelled") {
      this.finishTurn(turn, new Error(`${label} 回合被中断。`));
      return;
    }
    if (stopReason === "refusal") {
      this.finishTurn(turn, new Error(`${label} 拒绝了这次请求。`));
      return;
    }
    if (!text) {
      const reason = stopReason === "end_turn" ? "" : `（${stopReason}）`;
      this.finishTurn(turn, new Error(`${label} 没有返回可发送的文本${reason}。`));
      return;
    }
    // max_tokens / max_turn_requests 时仍把已生成的回答发出去，比整轮失败更有用
    this.finishTurn(turn, { text, threadId: turn.sessionId! });
  }

  private async openSession(
    agent: AgentProcess,
    threadId: string | undefined,
  ): Promise<{ sessionId: string; fresh: boolean }> {
    const params = { cwd: this.options.cwd, mcpServers: [acpHiveMcpServer(this.options.hive)] };
    if (threadId) {
      if (agent.loadedSessions.has(threadId)) return { sessionId: threadId, fresh: false };
      // session/resume 不回放历史，优先使用；否则退回 session/load（回放的 session/update 会被忽略）
      const method = agent.capabilities?.sessionCapabilities?.resume
        ? "session/resume"
        : agent.capabilities?.loadSession
          ? "session/load"
          : undefined;
      if (method) {
        try {
          await this.request(agent, method, { sessionId: threadId, ...params }, true);
          agent.loadedSessions.add(threadId);
          return { sessionId: threadId, fresh: false };
        } catch (error) {
          if (!(error instanceof AcpRpcError)) throw error;
          this.log(
            `[hive] ${this.options.label} 旧会话 ${threadId} 已失效（${error.message}），自动创建新会话继续处理。`,
          );
        }
      }
    }
    const result = await this.request(agent, "session/new", params, true);
    const sessionId = result?.sessionId;
    if (typeof sessionId !== "string" || !sessionId) {
      throw new Error(`${this.options.label} session/new 没有返回会话 ID。`);
    }
    agent.loadedSessions.add(sessionId);
    return { sessionId, fresh: true };
  }

  private ensureAgent(): Promise<AgentProcess> {
    const existing = this.agent;
    if (existing && !existing.dead) return existing.ready.then(() => existing);

    const transport = this.createTransport(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      ...(this.options.env ? { env: this.options.env } : {}),
    });
    const agent: AgentProcess = {
      transport,
      nextId: 1,
      pending: new Map(),
      loadedSessions: new Set(),
      capabilities: undefined,
      steering: false,
      ready: Promise.resolve(),
      initialized: false,
      dead: false,
    };
    this.agent = agent;
    transport.onLine((line) => this.handleLine(agent, line));
    transport.onExit((exit) => this.handleExit(agent, exit));

    agent.ready = (async () => {
      let result: any;
      try {
        result = await this.request(
          agent,
          "initialize",
          {
            protocolVersion: ACP_PROTOCOL_VERSION,
            // 不提供文件系统与终端能力：Agent 用自己的工具，权限由 request_permission 裁决
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
            },
            clientInfo: { name: "superhive", title: "SuperHive", version: this.clientVersion },
          },
          true,
        );
      } catch (error) {
        this.teardown(agent, error as Error);
        transport.kill();
        throw error;
      }
      if (result?.protocolVersion !== ACP_PROTOCOL_VERSION) {
        const error = new Error(
          `${this.options.label} 的 ACP 协议版本为 ${String(result?.protocolVersion)}，SuperHive 仅支持版本 ${ACP_PROTOCOL_VERSION}。`,
        );
        this.teardown(agent, error);
        transport.kill();
        throw error;
      }
      agent.capabilities = result.agentCapabilities ?? {};
      agent.steering = result._meta?.steering?.supported === true;
      agent.initialized = true;
    })();
    return agent.ready.then(() => agent);
  }

  private request(
    agent: AgentProcess,
    method: string,
    params: unknown,
    withTimeout: boolean,
  ): Promise<any> {
    if (agent.dead) return Promise.reject(new Error(`${this.options.label} 未运行。`));
    const id = agent.nextId++;
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = { method, resolve, reject };
      if (withTimeout) {
        pending.timer = setTimeout(() => {
          agent.pending.delete(id);
          reject(new RequestTimeoutError(`${this.options.label} ${method}`, this.requestTimeoutMs));
        }, this.requestTimeoutMs);
      }
      agent.pending.set(id, pending);
      agent.transport.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  private notify(agent: AgentProcess, method: string, params: unknown) {
    agent.transport.write(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  private respond(agent: AgentProcess, id: unknown, result: unknown) {
    agent.transport.write(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  private respondError(agent: AgentProcess, id: unknown, code: number, message: string) {
    agent.transport.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
  }

  private handleLine(agent: AgentProcess, line: string) {
    if (agent.dead) return;
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
      this.handleAgentRequest(agent, message.id, message.method, message.params);
      return;
    }
    if (hasId) {
      const pending = agent.pending.get(message.id);
      if (!pending) return;
      agent.pending.delete(message.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (message.error) {
        const detail = message.error.data?.message ?? message.error.data?.details;
        pending.reject(
          new AcpRpcError(
            `${this.options.label} ${pending.method}`,
            typeof message.error.code === "number" ? message.error.code : undefined,
            `${String(message.error.message ?? "未知错误")}${typeof detail === "string" && detail ? `：${detail}` : ""}`,
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method === "session/update") this.handleUpdate(message.params);
  }

  private handleAgentRequest(agent: AgentProcess, id: unknown, method: string, params: any) {
    if (method !== "session/request_permission") {
      // 未声明 fs / terminal 能力，其余客户端方法一律不支持
      this.respondError(agent, id, -32601, `SuperHive 不支持的请求：${method}`);
      return;
    }
    const sessionId = typeof params?.sessionId === "string" ? params.sessionId : "";
    // 权限请求总是同步答复；回合取消后到达的请求按规范答复 cancelled
    const turn = this.active;
    if (turn?.cancelled && turn.sessionId === sessionId) {
      this.respond(agent, id, { outcome: { outcome: "cancelled" } });
      return;
    }
    const toolCall: AcpToolCall = params?.toolCall ?? {};
    const decision = decideAcpPermission(
      this.options.access ?? "read-only",
      this.options.cwd,
      toolCall,
    );
    const option = pickPermissionOption(
      Array.isArray(params?.options) ? params.options : [],
      decision,
    );
    if (decision === "reject") {
      this.log(
        `[hive] ${this.options.label} 请求的操作超出 --access ${this.options.access ?? "read-only"}，已拒绝：${truncate(toolCall.title ?? toolCall.kind ?? "unknown", 120)}`,
      );
    }
    if (!option) {
      this.respond(agent, id, { outcome: { outcome: "cancelled" } });
      return;
    }
    this.respond(agent, id, { outcome: { outcome: "selected", optionId: option.optionId } });
  }

  private handleUpdate(params: any) {
    const turn = this.active;
    // 只处理当前回合的更新；session/load 回放的历史在回合开始前到达，会被忽略
    if (!turn || turn.settled || !turn.sessionId || params?.sessionId !== turn.sessionId) return;
    const update = params.update;
    switch (update?.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content?.type === "text" && typeof update.content.text === "string") {
          turn.segments[turn.segments.length - 1] += update.content.text;
        }
        return;
      case "agent_thought_chunk":
        if (!turn.thinkingReported) {
          turn.thinkingReported = true;
          this.reportProgress(turn, "思考中");
        }
        return;
      case "tool_call": {
        if (turn.segments.at(-1)?.trim()) turn.segments.push("");
        const id = typeof update.toolCallId === "string" ? update.toolCallId : "";
        if (typeof update.title === "string") turn.toolTitles.set(id, update.title);
        this.reportProgress(turn, progressForToolCall(update));
        return;
      }
      case "tool_call_update": {
        // opencode 先以工具名创建调用，执行时才更新为具体命令/路径；标题变化时再上报一次
        const id = typeof update.toolCallId === "string" ? update.toolCallId : "";
        if (
          typeof update.title !== "string" ||
          !update.title ||
          turn.toolTitles.get(id) === update.title
        ) {
          return;
        }
        turn.toolTitles.set(id, update.title);
        if (update.status === "in_progress") this.reportProgress(turn, progressForToolCall(update));
        return;
      }
      default:
        return;
    }
  }

  private reportProgress(turn: ActiveTurn, progress: string | undefined) {
    if (!progress || !turn.onProgress) return;
    try {
      turn.onProgress(progress);
    } catch {
      // 进度回调异常不影响回合
    }
  }

  private handleExit(agent: AgentProcess, exit: StdioExit) {
    // close() 或握手失败时已经收尾过
    if (agent.dead) return;
    let error: Error;
    if ((exit.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      error = Object.assign(
        new Error(
          `找不到 ${this.options.label} 命令 “${this.options.command}”。请先安装 CLI 并完成登录或模型配置。`,
        ),
        { code: "ENOENT" },
      );
    } else {
      const detail = exit.error
        ? exit.error.message
        : `code=${exit.code ?? "null"}${exit.signal ? `, signal=${exit.signal}` : ""}`;
      const stderr = exit.stderr.trim() ? `\n${exit.stderr.trim().slice(-1_000)}` : "";
      error = new Error(`${this.options.label} 意外退出（${detail}）。${stderr}`);
    }
    this.teardown(agent, error);
  }

  /** 进程失效：拒绝所有挂起请求和进行中的回合，下次 reply 会重新启动并恢复会话 */
  private teardown(agent: AgentProcess, error: Error) {
    agent.dead = true;
    if (this.agent === agent) this.agent = undefined;
    for (const pending of agent.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    agent.pending.clear();
    const turn = this.active;
    if (turn && turn.process === agent) {
      this.finishTurn(turn, turn.cancelled ? new AgentCancelledError() : error);
    }
  }
}
