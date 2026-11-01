import { describe, expect, it, vi } from "vitest";
import { AcpResponder, decideAcpPermission, type AcpResponderOptions } from "./acp-responder.js";
import { AgentCancelledError } from "./responder.js";
import type { StdioExit, StdioTransport } from "./stdio-transport.js";

const hive = {
  serverUrl: "http://localhost:8787",
  roomId: "general",
  username: "acp-agent",
  token: "test-token",
};

type Message = { id?: number | string; method?: string; params?: any; result?: any; error?: any };
type Handler = (message: Message, agent: FakeAgent) => void;

/** 假的 ACP Agent：记录客户端发出的消息，并按 handlers 自动应答 */
class FakeAgent implements StdioTransport {
  readonly sent: Message[] = [];
  private lineListeners: Array<(line: string) => void> = [];
  private exitListeners: Array<(exit: StdioExit) => void> = [];
  killed = false;

  constructor(
    readonly args: string[],
    readonly env: Record<string, string> | undefined,
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
  onExit(listener: (exit: StdioExit) => void) {
    this.exitListeners.push(listener);
  }
  kill() {
    this.killed = true;
  }

  emit(message: unknown) {
    for (const listener of this.lineListeners) listener(JSON.stringify(message));
  }
  update(sessionId: string, update: Record<string, unknown>) {
    this.emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
  }
  exit(exit: Partial<StdioExit> = {}) {
    for (const listener of this.exitListeners) {
      listener({ code: 1, signal: null, stderr: "", ...exit });
    }
  }
  methods() {
    return this.sent.filter((message) => message.method).map((message) => message.method);
  }
  request(method: string) {
    return this.sent.find((message) => message.method === method);
  }
  responseTo(id: unknown) {
    return this.sent.find((message) => message.id === id && !message.method);
  }
}

const ok =
  (result: unknown): Handler =>
  (message, agent) =>
    agent.emit({ id: message.id, result });

const text = (value: string) => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text: value },
});

const initializeResult = (extra: Record<string, unknown> = {}) => ({
  protocolVersion: 1,
  agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
  ...extra,
});

/** 默认 handlers：握手、新会话、回合输出一段文字后正常结束 */
function defaultHandlers(overrides: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    initialize: ok(initializeResult()),
    "session/new": ok({ sessionId: "ses-new" }),
    "session/resume": ok({}),
    "session/load": ok(null),
    "session/prompt": (message, agent) => {
      agent.update(message.params.sessionId, text("done"));
      agent.emit({ id: message.id, result: { stopReason: "end_turn" } });
    },
    ...overrides,
  };
}

function setup(
  handlers: Record<string, Handler> = defaultHandlers(),
  extra: Partial<AcpResponderOptions> = {},
  deps: { requestTimeoutMs?: number; cancelGraceMs?: number } = {},
) {
  const agents: FakeAgent[] = [];
  const createTransport = vi.fn(
    (_command: string, args: string[], options: { cwd: string; env?: Record<string, string> }) => {
      const agent = new FakeAgent(args, options.env, handlers);
      agents.push(agent);
      return agent;
    },
  );
  const log = vi.fn();
  const responder = new AcpResponder(
    {
      label: "TestAgent",
      command: "test-agent",
      args: ["acp"],
      env: { TEST_ENV: "1" },
      cwd: "/workspace",
      hive,
      log,
      ...extra,
    },
    { createTransport, clientVersion: "9.9.9", ...deps },
  );
  return { responder, agents, createTransport, log };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("AcpResponder", () => {
  it("initializes, injects the Hive MCP into a new session and prefixes the rules", async () => {
    const { responder, agents, createTransport } = setup();

    await expect(responder.reply({ instructions: "rules", prompt: "hi" })).resolves.toEqual({
      text: "done",
      threadId: "ses-new",
    });

    expect(createTransport).toHaveBeenCalledWith("test-agent", ["acp"], {
      cwd: "/workspace",
      env: { TEST_ENV: "1" },
    });
    const agent = agents[0]!;
    expect(agent.methods()).toEqual(["initialize", "session/new", "session/prompt"]);
    expect(agent.request("initialize")?.params).toEqual({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "superhive", title: "SuperHive", version: "9.9.9" },
    });
    expect(agent.request("session/new")?.params).toEqual({
      cwd: "/workspace",
      mcpServers: [
        {
          type: "http",
          name: "hive",
          url: "http://localhost:8787/mcp",
          headers: [
            { name: "Authorization", value: "Bearer test-token" },
            { name: "X-Hive-Room", value: "general" },
            { name: "X-Hive-Agent-Name", value: "acp-agent" },
          ],
        },
      ],
    });
    expect(agent.request("session/prompt")?.params).toEqual({
      sessionId: "ses-new",
      prompt: [{ type: "text", text: "rules\n\n---\n\nhi" }],
    });
  });

  it("returns the final answer after tool calls and reports tool progress", async () => {
    const { responder } = setup(
      defaultHandlers({
        "session/prompt": (message, agent) => {
          const sessionId = message.params.sessionId;
          agent.update(sessionId, {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "…" },
          });
          agent.update(sessionId, text("先看一下成员。"));
          agent.update(sessionId, {
            sessionUpdate: "tool_call",
            toolCallId: "t1",
            title: "bash",
            kind: "execute",
            status: "pending",
          });
          agent.update(sessionId, {
            sessionUpdate: "tool_call_update",
            toolCallId: "t1",
            title: "ls -la",
            kind: "execute",
            status: "in_progress",
          });
          agent.update(sessionId, {
            sessionUpdate: "tool_call",
            toolCallId: "t2",
            title: "hive_members_list",
            kind: "other",
            status: "pending",
          });
          agent.update(sessionId, text("房间里有 "));
          agent.update(sessionId, text("4 位成员。"));
          // 其他会话的更新不应混进来
          agent.update("ses-other", text("无关内容"));
          agent.emit({ id: message.id, result: { stopReason: "end_turn" } });
        },
      }),
    );
    const progress: string[] = [];

    await expect(
      responder.reply({ instructions: "rules", prompt: "hi", onProgress: (p) => progress.push(p) }),
    ).resolves.toEqual({ text: "房间里有 4 位成员。", threadId: "ses-new" });
    expect(progress).toEqual([
      "思考中",
      "执行命令：bash",
      "执行命令：ls -la",
      "调用工具：hive_members_list",
    ]);
  });

  it("resumes an existing session without repeating the rules unless asked to", async () => {
    const { responder, agents } = setup();

    await responder.reply({ instructions: "rules", prompt: "first", threadId: "ses-old" });
    await responder.reply({
      instructions: "rules",
      prompt: "second",
      threadId: "ses-old",
      refreshInstructions: true,
    });

    const agent = agents[0]!;
    // 同一进程内已恢复的会话不再重复 resume
    expect(agent.methods()).toEqual([
      "initialize",
      "session/resume",
      "session/prompt",
      "session/prompt",
    ]);
    expect(agent.request("session/resume")?.params).toMatchObject({
      sessionId: "ses-old",
      cwd: "/workspace",
    });
    const prompts = agent.sent.filter((message) => message.method === "session/prompt");
    expect(prompts[0]?.params.prompt[0].text).toBe("first");
    expect(prompts[1]?.params.prompt[0].text).toBe("rules\n\n---\n\nsecond");
  });

  it("falls back to session/load and ignores the replayed history", async () => {
    const { responder, agents } = setup(
      defaultHandlers({
        initialize: ok({ protocolVersion: 1, agentCapabilities: { loadSession: true } }),
        "session/load": (message, agent) => {
          agent.update(message.params.sessionId, text("历史回放"));
          agent.emit({ id: message.id, result: null });
        },
      }),
    );

    await expect(
      responder.reply({ instructions: "rules", prompt: "hi", threadId: "ses-old" }),
    ).resolves.toEqual({ text: "done", threadId: "ses-old" });
    expect(agents[0]!.methods()).toEqual(["initialize", "session/load", "session/prompt"]);
  });

  it("starts a new session with the rules when the old one cannot be restored", async () => {
    const { responder, agents, log } = setup(
      defaultHandlers({
        "session/resume": (message, agent) =>
          agent.emit({ id: message.id, error: { code: -32602, message: "session not found" } }),
      }),
    );

    await expect(
      responder.reply({ instructions: "rules", prompt: "hi", threadId: "ses-gone" }),
    ).resolves.toEqual({ text: "done", threadId: "ses-new" });
    expect(agents[0]!.request("session/prompt")?.params.prompt[0].text).toBe("rules\n\n---\n\nhi");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("旧会话 ses-gone 已失效"));
  });

  it("answers permission requests according to the access mode", async () => {
    const options = [
      { optionId: "yes", name: "Allow once", kind: "allow_once" },
      { optionId: "always", name: "Always allow", kind: "allow_always" },
      { optionId: "no", name: "Reject", kind: "reject_once" },
    ];
    const permissionHandlers = defaultHandlers({
      "session/prompt": (message, agent) => {
        const sessionId = message.params.sessionId;
        agent.emit({
          jsonrpc: "2.0",
          id: "p1",
          method: "session/request_permission",
          params: { sessionId, options, toolCall: { title: "ls", kind: "execute" } },
        });
        agent.emit({
          jsonrpc: "2.0",
          id: "p2",
          method: "session/request_permission",
          params: {
            sessionId,
            options,
            toolCall: { title: "edit", kind: "edit", locations: [{ path: "/workspace/a.ts" }] },
          },
        });
        agent.emit({
          jsonrpc: "2.0",
          id: "p3",
          method: "session/request_permission",
          params: {
            sessionId,
            options,
            toolCall: { title: "rm", kind: "delete", rawInput: { path: "../outside.txt" } },
          },
        });
        agent.update(sessionId, text("ok"));
        agent.emit({ id: message.id, result: { stopReason: "end_turn" } });
      },
    });
    const outcomes = async (access: "read-only" | "workspace" | "full") => {
      const { responder, agents } = setup(permissionHandlers, { access });
      await responder.reply({ instructions: "rules", prompt: "hi" });
      return ["p1", "p2", "p3"].map(
        (id) => agents[0]!.responseTo(id)?.result.outcome.optionId as string,
      );
    };

    expect(await outcomes("read-only")).toEqual(["no", "no", "no"]);
    expect(await outcomes("workspace")).toEqual(["yes", "yes", "no"]);
    expect(await outcomes("full")).toEqual(["yes", "yes", "yes"]);
  });

  it("cancels the turn with session/cancel when the signal aborts", async () => {
    const { responder, agents } = setup(
      defaultHandlers({
        "session/prompt": () => undefined,
        "session/cancel": (_message, agent) => {
          const prompt = agent.request("session/prompt")!;
          agent.emit({ id: prompt.id, result: { stopReason: "cancelled" } });
        },
      }),
    );
    const controller = new AbortController();

    const reply = responder.reply({
      instructions: "rules",
      prompt: "hi",
      signal: controller.signal,
    });
    await flush();
    controller.abort();

    await expect(reply).rejects.toBeInstanceOf(AgentCancelledError);
    expect(agents[0]!.request("session/cancel")?.params).toEqual({ sessionId: "ses-new" });
    expect(agents[0]!.killed).toBe(false);
  });

  it("kills the agent when it does not stop within the grace period, then recovers", async () => {
    let hang = true;
    const { responder, agents } = setup(
      defaultHandlers({
        "session/prompt": (message, agent) => {
          if (hang) return;
          agent.update(message.params.sessionId, text("recovered"));
          agent.emit({ id: message.id, result: { stopReason: "end_turn" } });
        },
      }),
      {},
      { cancelGraceMs: 10 },
    );
    const controller = new AbortController();

    const reply = responder.reply({
      instructions: "rules",
      prompt: "hi",
      signal: controller.signal,
    });
    await flush();
    controller.abort();

    await expect(reply).rejects.toBeInstanceOf(AgentCancelledError);
    expect(agents[0]!.killed).toBe(true);

    hang = false;
    await expect(
      responder.reply({ instructions: "rules", prompt: "again", threadId: "ses-new" }),
    ).resolves.toEqual({ text: "recovered", threadId: "ses-new" });
    expect(agents[1]!.methods()).toEqual(["initialize", "session/resume", "session/prompt"]);
  });

  it("rejects the turn when the agent exits and restores the session in a new process", async () => {
    let first = true;
    const { responder, agents } = setup(
      defaultHandlers({
        "session/prompt": (message, agent) => {
          if (first) {
            first = false;
            agent.exit({ code: 1, stderr: "boom" });
            return;
          }
          agent.update(message.params.sessionId, text("recovered"));
          agent.emit({ id: message.id, result: { stopReason: "end_turn" } });
        },
      }),
    );

    await expect(responder.reply({ instructions: "rules", prompt: "hi" })).rejects.toThrow(
      /TestAgent 意外退出（code=1）。\nboom/,
    );
    await expect(
      responder.reply({ instructions: "rules", prompt: "again", threadId: "ses-new" }),
    ).resolves.toEqual({ text: "recovered", threadId: "ses-new" });
    expect(agents).toHaveLength(2);
    expect(agents[1]!.methods()).toEqual(["initialize", "session/resume", "session/prompt"]);
  });

  it("reports a missing command clearly", async () => {
    const { responder, agents } = setup(defaultHandlers({ initialize: () => undefined }));

    const reply = responder.reply({ instructions: "rules", prompt: "hi" });
    await flush();
    agents[0]!.exit({ code: null, error: Object.assign(new Error("spawn"), { code: "ENOENT" }) });

    await expect(reply).rejects.toThrow("找不到 TestAgent 命令 “test-agent”");
  });

  it("refuses incompatible protocol versions", async () => {
    const { responder, agents } = setup(
      defaultHandlers({ initialize: ok({ protocolVersion: 2 }) }),
    );

    await expect(responder.reply({ instructions: "rules", prompt: "hi" })).rejects.toThrow(
      "ACP 协议版本为 2",
    );
    expect(agents[0]!.killed).toBe(true);
  });

  it("keeps partial answers on max_tokens and rejects refusals or empty replies", async () => {
    const withStop = (stopReason: string, body?: string) =>
      setup(
        defaultHandlers({
          "session/prompt": (message, agent) => {
            if (body) agent.update(message.params.sessionId, text(body));
            agent.emit({ id: message.id, result: { stopReason } });
          },
        }),
      ).responder.reply({ instructions: "rules", prompt: "hi" });

    await expect(withStop("max_tokens", "部分回答")).resolves.toEqual({
      text: "部分回答",
      threadId: "ses-new",
    });
    await expect(withStop("refusal", "不行")).rejects.toThrow("TestAgent 拒绝了这次请求。");
    await expect(withStop("end_turn")).rejects.toThrow("TestAgent 没有返回可发送的文本。");
    await expect(withStop("max_turn_requests")).rejects.toThrow("（max_turn_requests）");
  });

  it("declines client methods it did not advertise", async () => {
    const { responder, agents } = setup(
      defaultHandlers({
        "session/prompt": (message, agent) => {
          agent.emit({
            jsonrpc: "2.0",
            id: "fs1",
            method: "fs/read_text_file",
            params: { sessionId: message.params.sessionId, path: "/etc/passwd" },
          });
          agent.update(message.params.sessionId, text("ok"));
          agent.emit({ id: message.id, result: { stopReason: "end_turn" } });
        },
      }),
    );

    await responder.reply({ instructions: "rules", prompt: "hi" });
    expect(agents[0]!.responseTo("fs1")?.error).toEqual({
      code: -32601,
      message: "SuperHive 不支持的请求：fs/read_text_file",
    });
  });

  it("steers into the running turn only when the agent supports it", async () => {
    let release: (() => void) | undefined;
    const handlers = (steering: boolean) =>
      defaultHandlers({
        initialize: ok(
          initializeResult(steering ? { _meta: { steering: { supported: true } } } : {}),
        ),
        "session/prompt": (message, agent) => {
          release = () => {
            agent.update(message.params.sessionId, text("done"));
            agent.emit({ id: message.id, result: { stopReason: "end_turn" } });
          };
        },
        "_session/steering": ok({ outcome: "injected", queue: "steer" }),
      });

    const supported = setup(handlers(true));
    await expect(supported.responder.steer("too early")).resolves.toBe(false);
    const reply = supported.responder.reply({ instructions: "rules", prompt: "hi" });
    await flush();
    await expect(supported.responder.steer("新消息")).resolves.toBe(true);
    expect(supported.agents[0]!.request("_session/steering")?.params).toEqual({
      sessionId: "ses-new",
      prompt: [{ type: "text", text: "新消息" }],
    });
    release!();
    await reply;

    const unsupported = setup(handlers(false));
    const second = unsupported.responder.reply({ instructions: "rules", prompt: "hi" });
    await flush();
    await expect(unsupported.responder.steer("新消息")).resolves.toBe(false);
    expect(unsupported.agents[0]!.request("_session/steering")).toBeUndefined();
    release!();
    await second;
  });

  it("does not allow overlapping turns", async () => {
    const { responder } = setup(defaultHandlers({ "session/prompt": () => undefined }));

    const first = responder.reply({ instructions: "rules", prompt: "hi" });
    await expect(responder.reply({ instructions: "rules", prompt: "again" })).rejects.toThrow(
      "已有进行中的回合",
    );
    await flush();
    await responder.close();
    await expect(first).rejects.toThrow("TestAgent 已关闭。");
  });
});

describe("decideAcpPermission", () => {
  it("allows only read-like tools in read-only mode", () => {
    expect(decideAcpPermission("read-only", "/w", { kind: "read" })).toBe("allow");
    expect(decideAcpPermission("read-only", "/w", { kind: "search" })).toBe("allow");
    expect(decideAcpPermission("read-only", "/w", { kind: "execute" })).toBe("reject");
    expect(
      decideAcpPermission("read-only", "/w", { kind: "edit", locations: [{ path: "/w/a" }] }),
    ).toBe("reject");
    expect(decideAcpPermission("read-only", "/w", {})).toBe("reject");
  });

  it("confines workspace file changes to cwd and fails closed without a path", () => {
    expect(
      decideAcpPermission("workspace", "/w", {
        kind: "edit",
        locations: [{ path: "/w/src/a.ts" }],
      }),
    ).toBe("allow");
    expect(
      decideAcpPermission("workspace", "/w", { kind: "edit", rawInput: { filePath: "src/a.ts" } }),
    ).toBe("allow");
    expect(
      decideAcpPermission("workspace", "/w", {
        kind: "move",
        rawInput: { from: "/w/a", to: "/elsewhere/a" },
      }),
    ).toBe("reject");
    expect(
      decideAcpPermission("workspace", "/w", { kind: "edit", locations: [{ path: "/w-other/a" }] }),
    ).toBe("reject");
    expect(decideAcpPermission("workspace", "/w", { kind: "delete" })).toBe("reject");
    expect(decideAcpPermission("workspace", "/w", { kind: "execute" })).toBe("allow");
  });

  it("allows everything in full mode", () => {
    expect(
      decideAcpPermission("full", "/w", { kind: "delete", locations: [{ path: "/etc/x" }] }),
    ).toBe("allow");
  });
});
