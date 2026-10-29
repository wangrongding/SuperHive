import type { RuntimeEvent } from "./hive-protocol.js";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : undefined;
const integer = (value: unknown, min: number, max: number): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : undefined;

export type ClaudeResult = { is_error?: boolean; result?: string; session_id?: string };

function toolCategory(name: unknown): NonNullable<RuntimeEvent["tool"]> {
  if (name === "Read") return "read";
  if (name === "Edit" || name === "Write" || name === "NotebookEdit") return "write";
  if (name === "Glob" || name === "Grep" || name === "WebSearch") return "search";
  if (name === "Bash") return "command";
  if (typeof name === "string" && name.startsWith("mcp__hive__")) return "collaboration";
  return "other";
}

/** Only allowlisted facts leave this parser. No model text, arguments, stderr or session IDs. */
export class ClaudeStream {
  private buffer = "";
  private discarding = false;
  private failed = false;
  private result?: ClaudeResult;
  private readonly tools = new Map<string, RuntimeEvent["tool"]>();
  constructor(private readonly emit: (event: RuntimeEvent) => void) {}

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
    return this.result;
  }

  private recovered(): void {
    if (this.failed) this.emit({ kind: "recovered" });
    this.failed = false;
  }

  private block(value: unknown): void {
    const block = object(value);
    if (block?.type === "tool_use") {
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
      };
      if (!this.result.is_error) this.recovered();
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
    if (event.type === "assistant" && !event.error) {
      this.recovered();
      const message = object(event.message);
      if (Array.isArray(message?.content)) for (const block of message.content) this.block(block);
      return;
    }
    if (event.type === "user") {
      const message = object(event.message);
      if (Array.isArray(message?.content)) for (const block of message.content) this.block(block);
      return;
    }
    if (event.type === "stream_event") {
      const stream = object(event.event);
      if (stream?.type === "message_start") {
        this.recovered();
        this.emit({ kind: "activity", phase: "thinking" });
      } else if (stream?.type === "content_block_start") {
        this.block(stream.content_block);
      } else if (stream?.type === "content_block_delta") {
        const delta = object(stream.delta);
        if (delta?.type === "text_delta" || delta?.type === "thinking_delta") {
          this.emit({ kind: "activity", phase: "thinking" });
        }
      }
    }
  }
}
