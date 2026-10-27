import { describe, expect, it, vi } from "vitest";
import {
  CodexAppServerResponder,
  CodexAppServerUnsupportedError,
  isAppServerUnsupported,
  type AppServerExit,
  type AppServerTransport,
} from "./codex-app-server-client.js";
import { AgentCancelledError } from "./responder.js";

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
    expect(log).toHaveBeenCalledWith(expect.stringContaining("自动创建新会话"));
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
    await expect(responder.reply({ instructions: "r", prompt: "p" })).rejects.toThrow(
      "rate limited",
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

  it("gives up waiting for the interrupt after the grace period", async () => {
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
    await expect(reply).rejects.toBeInstanceOf(AgentCancelledError);
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

  it("rejects the active reply when the process dies and respawns on the next reply", async () => {
    let first = true;
    const handlers = defaultHandlers({
      "turn/start": (message, server) => {
        if (first) {
          first = false;
          server.emit({ id: message.id, result: { turn: { id: "t" } } });
          return;
        }
        defaultHandlers()["turn/start"]!(message, server);
      },
    });
    const { responder, servers, createTransport } = setup(handlers);
    const reply = responder.reply({ instructions: "r", prompt: "p", threadId: "thread-old" });
    await flush();
    servers[0]!.exit({ code: 137, stderr: "killed by OOM" });
    await expect(reply).rejects.toThrow(/意外退出.*code=137[\s\S]*killed by OOM/);

    await expect(
      responder.reply({ instructions: "r", prompt: "p2", threadId: "thread-old" }),
    ).resolves.toEqual({ text: "done", threadId: "thread-old" });
    expect(createTransport).toHaveBeenCalledTimes(2);
    // 新进程需要重新 resume 线程
    expect(servers[1]!.methods()).toEqual([
      "initialize",
      "initialized",
      "thread/resume",
      "turn/start",
    ]);
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

  it("flags an old codex that exits before initialize as unsupported", async () => {
    const { responder, servers } = setup({});
    const reply = responder.reply({ instructions: "r", prompt: "p" });
    await flush();
    servers[0]!.exit({ code: 1, stderr: "Error: stdin is not a terminal" });
    const error = await reply.catch((e) => e);
    expect(error).toBeInstanceOf(CodexAppServerUnsupportedError);
    expect(isAppServerUnsupported(error)).toBe(true);
  });

  it("does not treat other early exits (e.g. config errors) as unsupported", async () => {
    const { responder, servers } = setup({});
    const reply = responder.reply({ instructions: "r", prompt: "p" });
    await flush();
    servers[0]!.exit({ code: 1, stderr: "Error loading configuration: bad value" });
    const error = await reply.catch((e) => e);
    expect(error.message).toContain("Error loading configuration");
    expect(isAppServerUnsupported(error)).toBe(false);
  });

  it("flags an initialize JSON-RPC error as unsupported", async () => {
    const { responder } = setup({
      initialize: (message, server) =>
        server.emit({ id: message.id, error: { code: -32600, message: "bad request" } }),
    });
    const error = await responder.reply({ instructions: "r", prompt: "p" }).catch((e) => e);
    expect(error).toBeInstanceOf(CodexAppServerUnsupportedError);
  });

  it("flags a handshake timeout as unsupported", async () => {
    const { responder, servers } = setup({}, {}, { requestTimeoutMs: 10 });
    const error = await responder.reply({ instructions: "r", prompt: "p" }).catch((e) => e);
    expect(isAppServerUnsupported(error)).toBe(true);
    expect(servers[0]!.killed).toBe(true);
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
    await expect(reply).rejects.toThrow("已关闭");
    expect(servers[0]!.killed).toBe(true);
  });
});

describe("isAppServerUnsupported", () => {
  it("recognizes typical old-codex messages, including nested causes", () => {
    expect(isAppServerUnsupported(new Error("error: unrecognized subcommand 'app-server'"))).toBe(
      true,
    );
    expect(
      isAppServerUnsupported(new Error("wrap", { cause: new Error("stdin is not a terminal") })),
    ).toBe(true);
    expect(isAppServerUnsupported(new Error("HTTP 502"))).toBe(false);
  });
});
