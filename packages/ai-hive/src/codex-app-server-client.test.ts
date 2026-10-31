import { describe, expect, it, vi } from "vitest";
import {
  CodexAppServerResponder,
  CodexAppServerUnsupportedError,
  isAppServerUnsupported,
  type AppServerExit,
  type AppServerTransport,
} from "./codex-app-server-client.js";
import {
  AgentCancelledError,
  AgentExecutionUncertainError,
  AgentNonRetryableError,
} from "./responder.js";

const options = {
  command: "codex",
  cwd: "/workspace",
  hive: {
    serverUrl: "http://localhost:8787",
    roomId: "general",
    username: "codex-agent",
    token: "test-token",
  },
};

type Message = { id?: number | string; method?: string; params?: any; result?: any; error?: any };
type Handler = (message: Message, server: FakeAppServer) => void;

/** 假的 app-server：记录客户端发出的消息，并按 handlers 自动应答 */
class FakeAppServer implements AppServerTransport {
  readonly sent: Message[] = [];
  private lineListeners: Array<(line: string) => void> = [];
  private exitListeners: Array<(exit: AppServerExit) => void> = [];
  killed = false;

  constructor(
    readonly args: string[],
    private readonly handlers: Record<string, Handler>,
  ) {}

  write(line: string) {
    const message = JSON.parse(line) as Message;
    this.sent.push(message);
    if (message.method && this.handlers[message.method]) {
      queueMicrotask(() => this.handlers[message.method!]!(message, this));
    }
  }
  onLine(listener: (line: string) => void) {
    this.lineListeners.push(listener);
  }
  onExit(listener: (exit: AppServerExit) => void) {
    this.exitListeners.push(listener);
  }
  kill() {
    this.killed = true;
  }

  emit(message: unknown) {
    for (const listener of this.lineListeners) listener(JSON.stringify(message));
  }
  emitRaw(line: string) {
    for (const listener of this.lineListeners) listener(line);
  }
  exit(exit: Partial<AppServerExit> = {}) {
    for (const listener of this.exitListeners) {
      listener({ code: 1, signal: null, stderr: "", ...exit });
    }
  }
  methods() {
    return this.sent.map(
      (message) =>
        message.method ?? (message.error ? `error:${message.id}` : `result:${message.id}`),
    );
  }
  responseTo(id: unknown) {
    return this.sent.find((message) => message.id === id && !message.method);
  }
}

const ok =
  (result: unknown): Handler =>
  (message, server) =>
    server.emit({ id: message.id, result });

function agentMessage(text: string, phase: string | null = null) {
  return { type: "agentMessage", id: `m-${text}`, text, phase };
}

/** 默认 handlers：握手、新线程、回合立即以给定消息完成 */
function defaultHandlers(overrides: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    initialize: ok({ userAgent: "fake" }),
    "thread/start": ok({ thread: { id: "thread-new" } }),
    "thread/resume": (message, server) =>
      server.emit({ id: message.id, result: { thread: { id: message.params.threadId } } }),
    "turn/start": (message, server) => {
      const threadId = message.params.threadId;
      server.emit({ id: message.id, result: { turn: { id: "turn-1", status: "inProgress" } } });
      server.emit({ method: "turn/started", params: { threadId, turn: { id: "turn-1" } } });
      server.emit({
        method: "item/completed",
        params: { threadId, turnId: "turn-1", item: agentMessage("done", "final_answer") },
      });
      server.emit({
        method: "turn/completed",
        params: { threadId, turn: { id: "turn-1", status: "completed", items: [], error: null } },
      });
    },
    ...overrides,
  };
}

function setup(
  handlers: Record<string, Handler> = defaultHandlers(),
  extra: { access?: "read-only" | "workspace" | "full"; model?: string } = {},
  deps: { requestTimeoutMs?: number; interruptGraceMs?: number } = {},
) {
  const servers: FakeAppServer[] = [];
  const createTransport = vi.fn((command: string, args: string[]) => {
    const server = new FakeAppServer(args, handlers);
    servers.push(server);
    return server;
  });
  const log = vi.fn();
  const responder = new CodexAppServerResponder(
    { ...options, ...extra, log },
    { createTransport, clientVersion: "9.9.9", ...deps },
  );
  return { responder, servers, createTransport, log };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("CodexAppServerResponder", () => {
  it("returns per-turn token usage from thread/tokenUsage/updated with the thread model", async () => {
    const usage = (input: number, cached: number, output: number, total: number) => ({
      last: {
        inputTokens: input,
        cachedInputTokens: cached,
        outputTokens: output,
        reasoningOutputTokens: 0,
        totalTokens: input + output,
      },
      total: {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: total,
      },
      modelContextWindow: 400_000,
    });
    const { responder } = setup(
      defaultHandlers({
        "thread/start": ok({ thread: { id: "thread-new" }, model: "gpt-6-astra" }),
        "turn/start": (message, server) => {
          const threadId = message.params.threadId;
          server.emit({ id: message.id, result: { turn: { id: "turn-1" } } });
          for (const [index, value] of [
            usage(50_000, 0, 100, 50_100),
            usage(51_000, 50_000, 40, 101_140),
          ].entries()) {
            server.emit({
              method: "thread/tokenUsage/updated",
              params: { threadId, turnId: "turn-1", tokenUsage: value },
            });
            // 重复推送同一次响应不应重复计数
            if (index === 1) {
              server.emit({
                method: "thread/tokenUsage/updated",
                params: { threadId, turnId: "turn-1", tokenUsage: value },
              });
            }
          }
          server.emit({
            method: "item/completed",
            params: { threadId, turnId: "turn-1", item: agentMessage("done", "final_answer") },
          });
          server.emit({
            method: "turn/completed",
            params: { threadId, turn: { id: "turn-1", status: "completed", items: [] } },
          });
        },
      }),
    );
    const reply = await responder.reply({ instructions: "r", prompt: "p" });
    expect(reply.usage).toEqual({
      model: "gpt-6-astra",
      inputTokens: 51_000,
      cacheWriteTokens: 0,
      cacheReadTokens: 50_000,
      outputTokens: 140,
      requests: 2,
      firstRequest: { inputTokens: 50_000, cacheWriteTokens: 0, cacheReadTokens: 0 },
      peakContextTokens: 51_000,
      peakCacheWriteTokens: 0,
      contextWindow: 400_000,
    });
    await responder.close();
  });

  it("recognizes only initialize method-not-found as explicit unsupported", async () => {
    const { responder } = setup({
      initialize: (m, server) =>
        server.emit({ id: m.id, error: { code: -32601, message: "private diagnostic" } }),
    });
    const error = await responder.reply({ instructions: "r", prompt: "p" }).catch((e) => e);
    expect(error).toBeInstanceOf(CodexAppServerUnsupportedError);
    expect(error.message).not.toContain("private diagnostic");
  });

  it("does not discard a resumable thread after an unrelated resume error", async () => {
    const { responder, servers } = setup(
      defaultHandlers({
        "thread/resume": (m, server) =>
          server.emit({ id: m.id, error: { code: -32000, message: "server overloaded" } }),
      }),
    );
    await expect(
      responder.reply({ instructions: "r", prompt: "p", threadId: "known" }),
    ).rejects.toBeInstanceOf(AgentNonRetryableError);
    expect(servers[0]!.methods()).not.toContain("thread/start");
    expect(servers[0]!.methods()).not.toContain("turn/start");
  });

  it("does not replay a timed-out turn/start or accept its late reply as a new turn", async () => {
    const { responder, servers, createTransport } = setup(
      defaultHandlers({ "turn/start": () => {} }),
      {},
      { requestTimeoutMs: 10 },
    );
    await expect(responder.reply({ instructions: "r", prompt: "p" })).rejects.toBeInstanceOf(
      AgentExecutionUncertainError,
    );
    const server = servers[0]!;
    const sent = server.sent.find((m) => m.method === "turn/start")!;
    server.emit({ id: sent.id, result: { turn: { id: "late" } } });
    server.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-new",
        turn: { id: "late", status: "completed", items: [agentMessage("late")] },
      },
    });
    await expect(responder.reply({ instructions: "r", prompt: "new" })).rejects.toBeInstanceOf(
      AgentNonRetryableError,
    );
    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(server.methods().filter((m) => m === "turn/start")).toHaveLength(1);
    await responder.close();
  });

  it("does not treat process death after cancel as stop confirmation", async () => {
    const { responder, servers } = setup(
      defaultHandlers({ "turn/start": ok({ turn: { id: "t" } }), "turn/interrupt": ok({}) }),
    );
    const controller = new AbortController();
    const reply = responder.reply({ instructions: "r", prompt: "p", signal: controller.signal });
    await flush();
    controller.abort();
    servers[0]!.exit();
    await expect(reply).rejects.toBeInstanceOf(AgentExecutionUncertainError);
  });

  it("requires a valid terminal status before acknowledging cancellation", async () => {
    const { responder, servers } = setup(
      defaultHandlers({ "turn/start": ok({ turn: { id: "t" } }), "turn/interrupt": ok({}) }),
    );
    const controller = new AbortController();
    const reply = responder.reply({ instructions: "r", prompt: "p", signal: controller.signal });
    await flush();
    controller.abort();
    servers[0]!.emit({
      method: "turn/completed",
      params: { threadId: "thread-new", turn: { id: "t", status: "inProgress" } },
    });
    await expect(reply).rejects.toBeInstanceOf(AgentExecutionUncertainError);
    await responder.close();
  });

  it("marks a lost steer acknowledgement uncertain, not safe to enqueue again", async () => {
    const { responder } = setup(
      defaultHandlers({ "turn/start": ok({ turn: { id: "t" } }), "turn/steer": () => {} }),
      {},
      { requestTimeoutMs: 10 },
    );
    const reply = responder.reply({ instructions: "r", prompt: "p" }).catch((e) => e);
    await flush();
    await expect(responder.steer("extra")).rejects.toBeInstanceOf(AgentExecutionUncertainError);
    expect(await reply).toBeInstanceOf(AgentExecutionUncertainError);
    await responder.close();
  });

  it("does not mistake a handshake timeout for unsupported transport", async () => {
    const { responder } = setup({}, {}, { requestTimeoutMs: 10 });
    const error = await responder.reply({ instructions: "r", prompt: "p" }).catch((e) => e);
    expect(isAppServerUnsupported(error)).toBe(false);
    expect(error.message).toContain("initialize");
  });

  it("does not acknowledge cancellation without a terminal event", async () => {
    const { responder } = setup(
      defaultHandlers({
        "turn/start": ok({ turn: { id: "t" } }),
        "turn/interrupt": ok({}),
      }),
      {},
      { interruptGraceMs: 10 },
    );
    const controller = new AbortController();
    const reply = responder
      .reply({ instructions: "r", prompt: "p", signal: controller.signal })
      .catch((e) => e);
    await flush();
    controller.abort();
    expect((await reply).name).toBe("AgentExecutionUncertainError");
    await responder.close();
  });

  it("performs the handshake before starting a thread and turn", async () => {
    const { responder, servers, createTransport } = setup();

    await expect(responder.reply({ instructions: "rules", prompt: "hi" })).resolves.toEqual({
      text: "done",
      threadId: "thread-new",
    });

    expect(createTransport).toHaveBeenCalledTimes(1);
    const server = servers[0]!;
    expect(server.args[0]).toBe("app-server");
    expect(server.args).toContain('sandbox_mode="read-only"');
    expect(server.args).toContain('approval_policy="on-request"');
    expect(server.args.some((arg) => arg.startsWith("mcp_servers.hive.url="))).toBe(true);
    expect(server.methods()).toEqual(["initialize", "initialized", "thread/start", "turn/start"]);
    expect(server.sent[0]!.params).toEqual({
      clientInfo: { name: "ai-hive", title: "AI Hive", version: "9.9.9" },
      capabilities: null,
    });
    expect(server.sent[2]!.params).toEqual({
      cwd: "/workspace",
      sandbox: "read-only",
      approvalPolicy: "on-request",
      developerInstructions: "rules",
    });
    expect(server.sent[3]!.params).toEqual({
      threadId: "thread-new",
      input: [{ type: "text", text: "hi", text_elements: [] }],
    });
  });

  it.each([
    ["workspace", "workspace-write", "never"],
    ["full", "danger-full-access", "never"],
  ] as const)("maps %s access", async (access, sandbox, approvalPolicy) => {
    const { responder, servers } = setup(defaultHandlers(), { access, model: "gpt-x" });
    await responder.reply({ instructions: "rules", prompt: "hi" });
    const server = servers[0]!;
    expect(server.args).toContain(`sandbox_mode="${sandbox}"`);
    expect(server.args).toContain(`approval_policy="${approvalPolicy}"`);
    expect(server.sent[2]!.params).toMatchObject({ sandbox, approvalPolicy, model: "gpt-x" });
    expect(server.sent[3]!.params).toMatchObject({ model: "gpt-x" });
  });

  it("reuses one process and resumes a persisted thread only once", async () => {
    const { responder, servers, createTransport } = setup();
    await responder.reply({ instructions: "r", prompt: "a", threadId: "thread-old" });
    await responder.reply({ instructions: "r", prompt: "b", threadId: "thread-old" });

    expect(createTransport).toHaveBeenCalledTimes(1);
    const server = servers[0]!;
    expect(server.methods()).toEqual([
      "initialize",
      "initialized",
      "thread/resume",
      "turn/start",
      "turn/start",
    ]);
    expect(server.sent[2]!.params).toMatchObject({
      threadId: "thread-old",
      cwd: "/workspace",
      sandbox: "read-only",
      approvalPolicy: "on-request",
      developerInstructions: "r",
      excludeTurns: true,
    });
  });

  it("starts a new thread when resume fails", async () => {
    const { responder, servers, log } = setup(
      defaultHandlers({
        "thread/resume": (message, server) =>
          server.emit({
            id: message.id,
            error: { code: -32600, message: "no rollout found for thread id thread-old" },
          }),
      }),
    );

    await expect(
      responder.reply({ instructions: "r", prompt: "a", threadId: "thread-old" }),
    ).resolves.toEqual({ text: "done", threadId: "thread-new" });
    expect(servers[0]!.methods()).toEqual([
      "initialize",
      "initialized",
      "thread/resume",
      "thread/start",
      "turn/start",
    ]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("明确报告旧会话不存在"));
  });

  it("prefers the last final_answer over later commentary", async () => {
    const { responder } = setup(
      defaultHandlers({
        "turn/start": (message, server) => {
          const threadId = message.params.threadId;
          server.emit({ id: message.id, result: { turn: { id: "t" } } });
          for (const item of [
            agentMessage("thinking aloud", "commentary"),
            agentMessage("answer", "final_answer"),
            agentMessage("trailing note", "commentary"),
          ]) {
            server.emit({ method: "item/completed", params: { threadId, turnId: "t", item } });
          }
          // 其他回合的消息应被忽略
          server.emit({
            method: "item/completed",
            params: { threadId, turnId: "other", item: agentMessage("x", "final_answer") },
          });
          server.emit({
            method: "turn/completed",
            params: { threadId, turn: { id: "t", status: "completed", items: [] } },
          });
        },
      }),
    );
    await expect(responder.reply({ instructions: "r", prompt: "p" })).resolves.toMatchObject({
      text: "answer",
    });
  });

  it("falls back to the last agent message from turn.items", async () => {
    const { responder } = setup(
      defaultHandlers({
        "turn/start": (message, server) => {
          const threadId = message.params.threadId;
          server.emit({ id: message.id, result: { turn: { id: "t" } } });
          server.emit({
            method: "turn/completed",
            params: {
              threadId,
              turn: {
                id: "t",
                status: "completed",
                items: [{ type: "reasoning" }, agentMessage("first"), agentMessage("last")],
              },
            },
          });
        },
      }),
    );
    await expect(responder.reply({ instructions: "r", prompt: "p" })).resolves.toMatchObject({
      text: "last",
    });
  });

  it("throws the turn error when a turn fails", async () => {
    const { responder } = setup(
      defaultHandlers({
        "turn/start": (message, server) => {
          server.emit({ id: message.id, result: { turn: { id: "t" } } });
          server.emit({
            method: "turn/completed",
            params: {
              threadId: message.params.threadId,
              turn: { id: "t", status: "failed", error: { message: "rate limited" } },
            },
          });
        },
      }),
    );
    await expect(responder.reply({ instructions: "r", prompt: "p" })).rejects.toBeInstanceOf(
      AgentNonRetryableError,
    );
    // 失败后可以继续下一回合
    expect((responder as any).active).toBeUndefined();
  });

  it("rejects an unexpected interruption that was not requested", async () => {
    const { responder } = setup(
      defaultHandlers({
        "turn/start": (message, server) => {
          server.emit({ id: message.id, result: { turn: { id: "t" } } });
          server.emit({
            method: "turn/completed",
            params: { threadId: message.params.threadId, turn: { id: "t", status: "interrupted" } },
          });
        },
      }),
    );
    await expect(responder.reply({ instructions: "r", prompt: "p" })).rejects.toThrow(
      "Codex 回合被中断",
    );
  });

  it("interrupts the active turn on abort and rejects with AgentCancelledError", async () => {
    const handlers = defaultHandlers({
      "turn/start": (message, server) => {
        server.emit({ id: message.id, result: { turn: { id: "t" } } });
      },
      "turn/interrupt": (message, server) => {
        server.emit({ id: message.id, result: {} });
        server.emit({
          method: "turn/completed",
          params: { threadId: message.params.threadId, turn: { id: "t", status: "interrupted" } },
        });
      },
    });
    const { responder, servers } = setup(handlers);
    const controller = new AbortController();
    const reply = responder.reply({ instructions: "r", prompt: "p", signal: controller.signal });
    await flush();
    controller.abort();
    await expect(reply).rejects.toBeInstanceOf(AgentCancelledError);
    const interrupt = servers[0]!.sent.find((message) => message.method === "turn/interrupt");
    expect(interrupt?.params).toEqual({ threadId: "thread-new", turnId: "t" });
  });

  it("interrupts once the turn id is known when aborted before turn/start returns", async () => {
    let startMessage: Message | undefined;
    const handlers = defaultHandlers({
      "turn/start": (message) => {
        startMessage = message;
      },
      "turn/interrupt": (message, server) => {
        server.emit({ id: message.id, result: {} });
        server.emit({
          method: "turn/completed",
          params: {
            threadId: message.params.threadId,
            turn: { id: "late", status: "interrupted" },
          },
        });
      },
    });
    const { responder, servers } = setup(handlers);
    const controller = new AbortController();
    const reply = responder.reply({ instructions: "r", prompt: "p", signal: controller.signal });
    await flush();
    expect(startMessage).toBeDefined();
    controller.abort();
    expect(servers[0]!.sent.some((message) => message.method === "turn/interrupt")).toBe(false);
    servers[0]!.emit({ id: startMessage!.id, result: { turn: { id: "late" } } });
    await expect(reply).rejects.toBeInstanceOf(AgentCancelledError);
    expect(servers[0]!.sent.find((m) => m.method === "turn/interrupt")?.params).toEqual({
      threadId: "thread-new",
      turnId: "late",
    });
  });

  it("reports unknown rather than stopped after the interrupt grace period", async () => {
    const handlers = defaultHandlers({
      "turn/start": (message, server) =>
        server.emit({ id: message.id, result: { turn: { id: "t" } } }),
      "turn/interrupt": ok({}),
    });
    const { responder } = setup(handlers, {}, { interruptGraceMs: 10 });
    const controller = new AbortController();
    const reply = responder.reply({ instructions: "r", prompt: "p", signal: controller.signal });
    await flush();
    controller.abort();
    await expect(reply).rejects.toBeInstanceOf(AgentExecutionUncertainError);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const { responder, createTransport } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(
      responder.reply({ instructions: "r", prompt: "p", signal: controller.signal }),
    ).rejects.toBeInstanceOf(AgentCancelledError);
    expect(createTransport).not.toHaveBeenCalled();
  });

  it("refuses to start a second concurrent turn", async () => {
    const { responder } = setup(
      defaultHandlers({
        "turn/start": (message, server) =>
          server.emit({ id: message.id, result: { turn: { id: "t" } } }),
      }),
    );
    void responder.reply({ instructions: "r", prompt: "p" }).catch(() => undefined);
    await expect(responder.reply({ instructions: "r", prompt: "q" })).rejects.toThrow(
      "进行中的回合",
    );
    await responder.close();
  });

  it("steers the active turn and reports failures as false", async () => {
    let steerError = false;
    const handlers = defaultHandlers({
      "turn/start": (message, server) =>
        server.emit({ id: message.id, result: { turn: { id: "t" } } }),
      "turn/steer": (message, server) =>
        server.emit(
          steerError
            ? { id: message.id, error: { code: -32600, message: "no active turn to steer" } }
            : { id: message.id, result: { turnId: "t" } },
        ),
    });
    const { responder, servers } = setup(handlers);

    expect(await responder.steer("too early")).toBe(false);
    const reply = responder.reply({ instructions: "r", prompt: "p" });
    await flush();

    expect(await responder.steer("new message")).toBe(true);
    const steer = servers[0]!.sent.find((message) => message.method === "turn/steer");
    expect(steer?.params).toEqual({
      threadId: "thread-new",
      expectedTurnId: "t",
      input: [{ type: "text", text: "new message", text_elements: [] }],
    });

    steerError = true;
    expect(await responder.steer("again")).toBe(false);

    servers[0]!.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-new",
        turn: { id: "t", status: "completed", items: [agentMessage("ok")] },
      },
    });
    await expect(reply).resolves.toMatchObject({ text: "ok" });
    expect(await responder.steer("after")).toBe(false);
  });

  it("declines approval requests and rejects unknown server requests", async () => {
    const handlers = defaultHandlers({
      "turn/start": (message, server) => {
        const threadId = message.params.threadId;
        server.emit({ id: message.id, result: { turn: { id: "t" } } });
        server.emit({ id: 100, method: "item/commandExecution/requestApproval", params: {} });
        server.emit({ id: 101, method: "item/fileChange/requestApproval", params: {} });
        server.emit({ id: 102, method: "execCommandApproval", params: {} });
        server.emit({ id: 103, method: "applyPatchApproval", params: {} });
        server.emit({ id: 104, method: "mcpServer/elicitation/request", params: {} });
        server.emit({ id: "x", method: "item/tool/requestUserInput", params: {} });
        server.emit({
          method: "turn/completed",
          params: { threadId, turn: { id: "t", status: "completed", items: [agentMessage("ok")] } },
        });
      },
    });
    const { responder, servers } = setup(handlers);
    await responder.reply({ instructions: "r", prompt: "p" });
    const server = servers[0]!;
    expect(server.responseTo(100)?.result).toEqual({ decision: "decline" });
    expect(server.responseTo(101)?.result).toEqual({ decision: "decline" });
    expect(server.responseTo(102)?.result).toEqual({
      decision: { denied: { rejection: expect.any(String) } },
    });
    expect(server.responseTo(103)?.result.decision).toHaveProperty("denied");
    expect(server.responseTo(104)?.result).toEqual({
      action: "decline",
      content: null,
      _meta: null,
    });
    expect(server.responseTo("x")?.error).toMatchObject({ code: -32601 });
  });

  it("reports progress for started items", async () => {
    const handlers = defaultHandlers({
      "turn/start": (message, server) => {
        const threadId = message.params.threadId;
        server.emit({ id: message.id, result: { turn: { id: "t" } } });
        const items = [
          { type: "reasoning" },
          { type: "reasoning" },
          { type: "commandExecution", command: `echo ${"x".repeat(200)}` },
          { type: "fileChange", changes: [{ path: "src/a.ts" }, { path: "src/b.ts" }] },
          { type: "fileChange", changes: [] },
          { type: "mcpToolCall", server: "hive", tool: "send_message" },
          { type: "webSearch" },
          { type: "contextCompaction" },
          { type: "agentMessage", text: "" },
        ];
        for (const item of items) {
          server.emit({ method: "item/started", params: { threadId, turnId: "t", item } });
        }
        server.emit({ method: "something/unknown", params: { threadId } });
        server.emitRaw("not json at all");
        server.emitRaw("{broken");
        server.emit({
          method: "turn/completed",
          params: { threadId, turn: { id: "t", status: "completed", items: [agentMessage("ok")] } },
        });
      },
    });
    const { responder } = setup(handlers);
    const onProgress = vi.fn();
    await responder.reply({ instructions: "r", prompt: "p", onProgress });
    const progress = onProgress.mock.calls.map(([text]) => text as string);
    expect(progress[0]).toBe("思考中");
    expect(progress[1]).toMatch(/^执行命令：echo x+…$/);
    expect(progress[1]!.length).toBeLessThanOrEqual("执行命令：".length + 80);
    expect(progress.slice(2)).toEqual([
      "修改文件：src/a.ts",
      "修改文件",
      "调用工具：hive.send_message",
      "搜索网页",
      "压缩上下文",
    ]);
  });

  it("latches unknown execution after process death instead of respawning for another turn", async () => {
    const { responder, servers, createTransport } = setup(
      defaultHandlers({ "turn/start": ok({ turn: { id: "t" } }) }),
    );
    const reply = responder.reply({ instructions: "r", prompt: "p", threadId: "thread-old" });
    await flush();
    servers[0]!.exit({ code: 137, stderr: "Bearer private-token" });
    await expect(reply).rejects.toBeInstanceOf(AgentExecutionUncertainError);
    await expect(
      responder.reply({ instructions: "r", prompt: "p2", threadId: "thread-old" }),
    ).rejects.toBeInstanceOf(AgentNonRetryableError);
    expect(createTransport).toHaveBeenCalledTimes(1);
  });

  it("reports a friendly error when the codex command is missing", async () => {
    const { responder, servers } = setup({});
    const reply = responder.reply({ instructions: "r", prompt: "p" });
    await flush();
    const error = Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" });
    servers[0]!.exit({ code: null, error });
    await expect(reply).rejects.toThrow("找不到 Codex 命令");
    await expect(reply.catch((e) => isAppServerUnsupported(e))).resolves.toBe(false);
  });

  it("reports non-TTY startup without guessing unsupported protocol", async () => {
    const { responder, servers } = setup({});
    const reply = responder.reply({ instructions: "r", prompt: "p" });
    await flush();
    servers[0]!.exit({ code: 1, stderr: "Error: stdin is not a terminal" });
    const error = await reply.catch((e) => e);
    expect(error).toBeInstanceOf(AgentNonRetryableError);
    expect(isAppServerUnsupported(error)).toBe(false);
    expect(error.message).toContain("交互终端");
  });

  it("does not treat other early exits (e.g. config errors) as unsupported", async () => {
    const { responder, servers } = setup({});
    const reply = responder.reply({ instructions: "r", prompt: "p" });
    await flush();
    servers[0]!.exit({ code: 1, stderr: "Error loading configuration: bad value" });
    const error = await reply.catch((e) => e);
    expect(error.message).toContain("配置不兼容");
    expect(isAppServerUnsupported(error)).toBe(false);
  });

  it("does not classify general initialize RPC rejection as unsupported", async () => {
    const { responder } = setup({
      initialize: (message, server) =>
        server.emit({ id: message.id, error: { code: -32600, message: "bad request" } }),
    });
    const error = await responder.reply({ instructions: "r", prompt: "p" }).catch((e) => e);
    expect(error).toBeInstanceOf(AgentNonRetryableError);
    expect(isAppServerUnsupported(error)).toBe(false);
    expect(error.message).toContain("-32600");
  });

  it("preserves initialize timeout as a non-retryable startup failure", async () => {
    const { responder, servers } = setup({}, {}, { requestTimeoutMs: 10 });
    const error = await responder.reply({ instructions: "r", prompt: "p" }).catch((e) => e);
    expect(isAppServerUnsupported(error)).toBe(false);
    expect(servers[0]!.killed).toBe(true);
    expect(error).toBeInstanceOf(AgentNonRetryableError);
  });

  it("close kills the process and rejects the active reply", async () => {
    const { responder, servers } = setup(
      defaultHandlers({
        "turn/start": (message, server) =>
          server.emit({ id: message.id, result: { turn: { id: "t" } } }),
      }),
    );
    const reply = responder.reply({ instructions: "r", prompt: "p" });
    await flush();
    await responder.close();
    await expect(reply).rejects.toBeInstanceOf(AgentExecutionUncertainError);
    expect(servers[0]!.killed).toBe(true);
  });
});

describe("isAppServerUnsupported", () => {
  it("accepts only a scoped explicit capability error, not arbitrary provider text", () => {
    expect(
      isAppServerUnsupported(new CodexAppServerUnsupportedError("initialize unsupported")),
    ).toBe(true);
    expect(isAppServerUnsupported(new Error("method not found"))).toBe(false);
    expect(isAppServerUnsupported(new Error("stdin is not a terminal"))).toBe(false);
    expect(isAppServerUnsupported(new Error("HTTP 502"))).toBe(false);
  });
});
