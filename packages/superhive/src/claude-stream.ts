import { createHash } from "node:crypto";
import type { AgentUsage, RuntimeEvent, TraceStep } from "./hive-protocol.js";
import { ThinkingTrace, claudeToolSummary, isHiveProgress } from "./trace.js";
import { UsageAccumulator, anthropicBuckets } from "./usage.js";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : undefined;
const integer = (value: unknown, min: number, max: number): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : undefined;

export type ClaudeResult = {
  is_error?: boolean;
  result?: string;
  session_id?: string;
  /** 出错时 Claude Code 给的原因（如恢复会话失败「No conversation found with session ID」） */
  errors?: string[];
  /** 服务商回的 HTTP 状态码；断网等没收到回应时没有 */
  api_error_status?: number;
  /** 回合怎么结束的（api_error、prompt_too_long……） */
  terminal_reason?: string;
  /** 出错前那条合成 assistant 消息上的错误类别（rate_limit、authentication_failed、billing_error……） */
  error_category?: string;
};

function toolCategory(name: unknown): NonNullable<RuntimeEvent["tool"]> {
  if (name === "Read") return "read";
  if (name === "Edit" || name === "Write" || name === "NotebookEdit") return "write";
  if (name === "Glob" || name === "Grep" || name === "WebSearch") return "search";
  if (name === "Bash") return "command";
  if (typeof name === "string" && name.startsWith("mcp__hive__")) return "collaboration";
  return "other";
}

/**
 * Only allowlisted facts leave this parser through emit (no model text, arguments, stderr or session IDs).
 * 执行过程另走 trace：只给房主实时看，带命令、路径和中途说的话，由 Bridge 脱敏后上报。
 */
export class ClaudeStream {
  private buffer = "";
  private discarding = false;
  private failed = false;
  /** 这一轮里 Claude Code 压缩过上下文（system/compact_boundary）：之前发过的成员、白板快照可能已被概括掉 */
  private compactedInTurn = false;
  private errorCategory: string | undefined;
  private result?: ClaudeResult;
  /** 这个进程里的每一轮结果：引导后 Claude 可能再跑一轮，各轮的回复都要交出去 */
  private readonly results: ClaudeResult[] = [];
  /** 每出一个结果、每确认收到一条写进去的消息时回调（引导用） */
  onResult?: (result: ClaudeResult) => void;
  onUserAck?: (uuid: string) => void;
  /** 启动信息里 hive MCP 的状态：connected 或连不上（failed、needs-auth） */
  onHiveTools?: (status: "connected" | "unavailable", detail?: string) => void;
  /** Claude Code 开始自动压缩上下文（system/status compacting） */
  onCompacting?: () => void;
  /** 自动压缩完成（system/compact_boundary），带压缩前后的上下文大小 */
  onCompacted?: (compaction: {
    preTokens: number;
    postTokens?: number;
    durationMs?: number;
  }) => void;
  /** 控制请求（例如 interrupt、cancel_async_message）的答复；payload 是答复里的 response 对象（没有时为 undefined） */
  onControlResponse?: (requestId: string, ok: boolean, payload?: Record<string, unknown>) => void;
  /**
   * 写进去的消息在 Claude Code 队列里的去向（command_lifecycle，msg_lifecycle_v1）：
   * queued 排上队、started 被一轮取走、completed 处理完、cancelled 被撤回或随中断作废
   */
  onLifecycle?: (uuid: string, state: string) => void;
  /** 开始向模型发请求（system/status requesting 或 message_start）：说明 Claude 正在跑一轮 */
  onRequest?: () => void;
  /** Claude 要求宿主批准一次工具调用（--permission-prompt-tool stdio 时的 can_use_tool） */
  onPermissionRequest?: (
    requestId: string,
    request: { toolName: string; input: Record<string, unknown>; description?: string },
  ) => void;
  private readonly tools = new Map<string, RuntimeEvent["tool"]>();
  private readonly accounting = new UsageAccumulator();
  private currentMessageId: string | undefined;
  private sessionCost: number | undefined;
  /** 工具调用开始时的信息：结果回来时据此补全这一步 */
  private readonly traceTools = new Map<string, TraceStep>();
  /** 当前消息里正在进行的思考块（块序号 → 步骤 id） */
  private readonly thinking = new Map<number, string>();
  private readonly thinkingTrace: ThinkingTrace;
  private readonly seenTexts = new Set<string>();
  constructor(
    private readonly emit: (event: RuntimeEvent) => void,
    private readonly trace: (step: TraceStep) => void = () => undefined,
    private readonly session: (sessionId: string) => void = () => undefined,
    now: () => number = Date.now,
  ) {
    this.thinkingTrace = new ThinkingTrace((step) => this.trace(step), now);
  }

  /** init 事件里的 mcp_servers：[{ name, status }]，status 为 connected / failed / needs-auth / pending */
  private hiveMcp(servers: unknown): void {
    if (!Array.isArray(servers)) return;
    const hive = servers.map((item) => object(item)).find((item) => item?.name === "hive");
    const status = typeof hive?.status === "string" ? hive.status : undefined;
    if (status === "connected") this.onHiveTools?.("connected");
    else if (status === "failed" || status === "needs-auth")
      this.onHiveTools?.("unavailable", `Claude Code 报告 hive MCP 状态为 ${status}`);
  }

  private traceAssistant(message: ObjectValue | undefined): void {
    if (!Array.isArray(message?.content)) return;
    const messageId = typeof message.id === "string" ? message.id : "message";
    const now = new Date().toISOString();
    for (const value of message.content) {
      const block = object(value);
      if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
        const id = `text:${messageId}:${createHash("sha1").update(block.text).digest("hex").slice(0, 12)}`;
        if (this.seenTexts.has(id) || this.seenTexts.size > 2048) continue;
        this.seenTexts.add(id);
        this.trace({ id, kind: "text", text: block.text, startedAt: now, endedAt: now });
      } else if (block?.type === "tool_use" && typeof block.id === "string") {
        if (this.traceTools.has(block.id) || this.traceTools.size >= 1024) continue;
        const name = typeof block.name === "string" ? block.name : "tool";
        const step: TraceStep = {
          id: block.id,
          kind: "tool",
          tool: toolCategory(name),
          name,
          ...(isHiveProgress(name, block.input) ? { hiveProgress: true as const } : {}),
          summary: claudeToolSummary(name, object(block.input) ?? {}),
          status: "running",
          startedAt: now,
        };
        this.traceTools.set(block.id, step);
        this.trace(step);
      }
    }
  }

  private traceResults(message: ObjectValue | undefined): void {
    if (!Array.isArray(message?.content)) return;
    for (const value of message.content) {
      const block = object(value);
      if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      const step = this.traceTools.get(block.tool_use_id);
      if (!step) continue;
      this.traceTools.delete(block.tool_use_id);
      this.trace({
        ...step,
        status: block.is_error === true ? "error" : "ok",
        endedAt: new Date().toISOString(),
      });
    }
  }

  push(chunk: string): void {
    for (const [index, part] of chunk.split("\n").entries()) {
      if (index > 0) {
        if (!this.discarding) this.line(this.buffer);
        this.buffer = "";
        this.discarding = false;
      }
      if (!this.discarding) {
        this.buffer += part;
        if (this.buffer.length > 1_048_576) {
          // Large tool results must neither grow memory without limit nor break the final result.
          this.buffer = "";
          this.discarding = true;
        }
      }
    }
  }

  finish(): ClaudeResult | undefined {
    if (!this.discarding && this.buffer.trim()) this.line(this.buffer);
    this.buffer = "";
    this.thinkingTrace.endAll();
    // 引导后多跑了几轮：以最后一轮为准。它看得到前面的对话，通常会把结论连同引导一起重说一遍，
    // 直接拼接反而重复；最后一轮没给出文字时才退回到上一轮的回复
    if (this.results.length <= 1) return this.result;
    const last = this.results.at(-1)!;
    if (last.is_error || last.result?.trim()) return last;
    const earlier = [...this.results]
      .reverse()
      .find((item) => !item.is_error && item.result?.trim());
    return earlier?.result ? { ...last, result: earlier.result } : last;
  }

  /** 本轮真实用量（token 数与模型名）；一次请求都没有时为全零 */
  compacted(): boolean {
    return this.compactedInTurn;
  }

  usage(): AgentUsage {
    return this.accounting.finish();
  }

  private account(message: ObjectValue | undefined, id: unknown): void {
    if (!message) return;
    this.accounting.setModel(message.model);
    const buckets = anthropicBuckets(message.usage);
    if (typeof id === "string" && id && buckets) this.accounting.request(id, buckets);
  }

  /**
   * result 里的 modelUsage 与 total_cost_usd 是整个会话（含 --resume 之前各轮）的累计值，
   * 不能当成本轮用量：本轮 token 以流里逐条请求为准，累计费用交给 Bridge 按会话求差。
   */
  private accountResult(event: ObjectValue): void {
    if (typeof event.total_cost_usd === "number" && Number.isFinite(event.total_cost_usd)) {
      this.sessionCost = event.total_cost_usd;
    }
    const models = object(event.modelUsage);
    for (const [name, value] of Object.entries(models ?? {})) {
      const model = object(value);
      if (!model) continue;
      this.accounting.setModel(
        typeof model.canonicalModel === "string" ? model.canonicalModel : name,
      );
      this.accounting.setContextWindow(model.contextWindow);
      break;
    }
  }

  /** Claude Code 自报的会话累计费用（美元） */
  sessionCostUsd(): number | undefined {
    return this.sessionCost;
  }

  private recovered(): void {
    if (this.failed) this.emit({ kind: "recovered" });
    this.failed = false;
  }

  /** 这一轮已经开始调用工具：会话坏了也不能自动重跑 */
  toolStarted = false;

  private block(value: unknown): void {
    const block = object(value);
    if (block?.type === "tool_use") {
      this.toolStarted = true;
      const tool = toolCategory(block.name);
      if (typeof block.id === "string" && this.tools.size < 1024) this.tools.set(block.id, tool);
      this.emit({ kind: "activity", phase: "tool_running", tool });
    } else if (block?.type === "tool_result") {
      const tool =
        typeof block.tool_use_id === "string" ? this.tools.get(block.tool_use_id) : undefined;
      if (typeof block.tool_use_id === "string") this.tools.delete(block.tool_use_id);
      // Completion is not success; never infer recovery from a tool result.
      this.emit({ kind: "activity", phase: "tool_completed", ...(tool ? { tool } : {}) });
    }
  }

  private line(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    const event = object(value);
    if (!event) return;
    if (event.type === "result" || (event.type === undefined && typeof event.result === "string")) {
      this.result = {
        ...(typeof event.result === "string" ? { result: event.result } : {}),
        ...(typeof event.session_id === "string" ? { session_id: event.session_id } : {}),
        is_error: event.is_error === true,
        ...(integer(event.api_error_status, 100, 599) !== undefined
          ? { api_error_status: event.api_error_status as number }
          : {}),
        ...(typeof event.terminal_reason === "string"
          ? { terminal_reason: event.terminal_reason.slice(0, 64) }
          : {}),
        ...(this.errorCategory ? { error_category: this.errorCategory } : {}),
        ...(Array.isArray(event.errors)
          ? {
              errors: event.errors
                .filter((item): item is string => typeof item === "string")
                .slice(0, 5),
            }
          : {}),
      };
      this.accountResult(event);
      this.results.push(this.result);
      if (!this.result.is_error) this.recovered();
      this.onResult?.(this.result);
      return;
    }
    if (event.type === "control_request") {
      const request = object(event.request);
      if (typeof event.request_id === "string" && request?.subtype === "can_use_tool") {
        this.onPermissionRequest?.(event.request_id, {
          toolName: typeof request.tool_name === "string" ? request.tool_name : "tool",
          input: object(request.input) ?? {},
          ...(typeof request.description === "string" ? { description: request.description } : {}),
        });
      }
      return;
    }
    if (event.type === "control_response") {
      const response = object(event.response);
      if (typeof response?.request_id === "string") {
        this.onControlResponse?.(
          response.request_id,
          response.subtype === "success",
          object(response.response),
        );
      }
      return;
    }
    if (event.type === "system" && event.subtype === "init") {
      this.hiveMcp(event.mcp_servers);
      if (typeof event.session_id === "string") this.session(event.session_id);
      return;
    }
    if (event.type === "command_lifecycle") {
      if (typeof event.command_uuid === "string" && typeof event.state === "string")
        this.onLifecycle?.(event.command_uuid, event.state);
      return;
    }
    if (event.type === "system" && event.subtype === "status") {
      if (event.status === "compacting") this.onCompacting?.();
      if (event.status === "requesting") this.onRequest?.();
      return;
    }
    if (event.type === "system" && event.subtype === "compact_boundary") {
      this.compactedInTurn = true;
      const meta = object(event.compact_metadata);
      // 只报自动压缩：人手动 /compact 不会经过 Bridge
      const preTokens = integer(meta?.pre_tokens, 0, 100_000_000);
      if (meta?.trigger === "auto" && preTokens !== undefined) {
        const postTokens = integer(meta.post_tokens, 0, 100_000_000);
        const durationMs = integer(meta.duration_ms, 0, 86_400_000);
        this.onCompacted?.({
          preTokens,
          ...(postTokens !== undefined ? { postTokens } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
        });
      }
      return;
    }
    if (event.type === "system" && event.subtype === "api_retry") {
      const code = integer(event.error_status, 100, 599);
      const retryAttempt = integer(event.attempt, 1, 1000);
      const retryInMs = integer(event.retry_delay_ms, 0, 86_400_000);
      this.failed = true;
      this.emit({
        kind: "provider_error",
        ...(code !== undefined ? { code } : {}),
        ...(retryAttempt !== undefined ? { retryAttempt } : {}),
        ...(retryInMs !== undefined ? { retryInMs } : {}),
      });
      return;
    }
    // 出错时 Claude Code 先写一条合成的 assistant 消息，error 是错误类别；记下来随 result 交给分类
    if (event.type === "assistant" && typeof event.error === "string" && event.error) {
      this.errorCategory = event.error.slice(0, 64);
      return;
    }
    if (event.type === "assistant" && !event.error) {
      this.errorCategory = undefined;
      this.recovered();
      const message = object(event.message);
      this.account(message, message?.id);
      if (Array.isArray(message?.content)) for (const block of message.content) this.block(block);
      this.traceAssistant(message);
      return;
    }
    if (event.type === "user") {
      // --replay-user-messages：Claude 把从标准输入读进去的消息回放出来，说明它已经收进对话
      if (event.isReplay === true) {
        if (typeof event.uuid === "string") this.onUserAck?.(event.uuid);
        return;
      }
      const message = object(event.message);
      if (Array.isArray(message?.content)) for (const block of message.content) this.block(block);
      this.traceResults(message);
      return;
    }
    if (event.type === "stream_event") {
      const stream = object(event.event);
      if (stream?.type === "message_start") {
        const message = object(stream.message);
        if (typeof message?.id === "string") this.currentMessageId = message.id;
        // 上一条消息里没等到结束的思考块，到这里一并收尾
        for (const id of this.thinking.values()) this.thinkingTrace.end(id);
        this.thinking.clear();
        this.account(message, message?.id);
        this.recovered();
        this.onRequest?.();
        this.emit({ kind: "activity", phase: "thinking" });
      } else if (stream?.type === "message_delta") {
        const buckets = anthropicBuckets(stream.usage);
        if (this.currentMessageId && buckets)
          this.accounting.request(this.currentMessageId, buckets);
      } else if (stream?.type === "content_block_start") {
        this.block(stream.content_block);
        const index = integer(stream.index, 0, 10_000);
        const type = object(stream.content_block)?.type;
        // redacted_thinking 拿不到正文，只记时长
        if ((type === "thinking" || type === "redacted_thinking") && index !== undefined) {
          const id = `thinking:${this.currentMessageId ?? "message"}:${index}`;
          this.thinking.set(index, id);
          this.thinkingTrace.start(id);
        }
      } else if (stream?.type === "content_block_stop") {
        const index = integer(stream.index, 0, 10_000);
        const id = index !== undefined ? this.thinking.get(index) : undefined;
        if (id && index !== undefined) {
          this.thinking.delete(index);
          this.thinkingTrace.end(id);
        }
      } else if (stream?.type === "content_block_delta") {
        const delta = object(stream.delta);
        if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
          const index = integer(stream.index, 0, 10_000);
          const id = index !== undefined ? this.thinking.get(index) : undefined;
          if (id) this.thinkingTrace.append(id, delta.thinking);
        }
        if (delta?.type === "text_delta" || delta?.type === "thinking_delta") {
          this.emit({ kind: "activity", phase: "thinking" });
        }
      }
    }
  }
}
