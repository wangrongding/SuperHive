import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ClaudeCodeResponder, claudeWorkspaceSandboxed } from "./claude-client.js";
import type { CommandRunner } from "./command-runner.js";
import {
  AgentCancelledError,
  AgentExecutionUncertainError,
  AgentSessionInvalidError,
  AgentUpstreamError,
} from "./responder.js";

const hive = {
  serverUrl: "http://localhost:8787",
  roomId: "general",
  username: "claude-agent",
  token: "test-token",
};

describe("ClaudeCodeResponder", () => {
  it("runs Claude Code in read-only print mode and resumes its session", async () => {
    let mcpConfig: { content: string; mode: number } | undefined;
    const runner = vi.fn<CommandRunner>(async (_command, args) => {
      const file = args[args.indexOf("--mcp-config") + 1]!;
      mcpConfig = { content: readFileSync(file, "utf8"), mode: statSync(file).mode & 0o777 };
      return {
        stdout: JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "来自 Claude 的回复",
          session_id: "11111111-1111-4111-8111-111111111111",
        }),
        stderr: "",
      };
    });
    const responder = new ClaudeCodeResponder({
      command: "claude",
      cwd: "/workspace",
      hive,
      model: "sonnet",
      runner,
    });

    await expect(
      responder.reply({
        instructions: "Hive rules",
        prompt: "Shared context",
        threadId: "00000000-0000-4000-8000-000000000001",
      }),
    ).resolves.toEqual({
      text: "来自 Claude 的回复",
      threadId: "11111111-1111-4111-8111-111111111111",
    });
    const args = runner.mock.calls[0]?.[1] ?? [];
    expect(args).toContain("stream-json");
    expect(args).toContain("--verbose");
    expect(args).toContain("--include-partial-messages");
    expect(args).toContain("--permission-mode");
    expect(args).toContain("plan");
    expect(args).toContain("--mcp-config");
    expect(args.join(" ")).toContain("hive_message_send");
    // 提示词要求 Agent 用白板登记长任务，白名单必须同步放行，否则 Claude 根本调不动
    expect(args.join(" ")).toContain("mcp__hive__hive_board_read");
    expect(args.join(" ")).toContain("mcp__hive__hive_board_update");
    expect(args.join(" ")).toContain("mcp__hive__hive_todo_list");
    expect(args.join(" ")).toContain("mcp__hive__hive_todo_add");
    expect(args.join(" ")).toContain("mcp__hive__hive_todo_update");
    expect(args.join(" ")).toContain("mcp__hive__hive_schedule_create");
    // Claude 自带的定时随这一轮的进程退出就没了：禁用，改走服务端的 hive_schedule
    expect(args[args.indexOf("--disallowedTools") + 1]).toBe(
      "CronCreate,CronDelete,CronList,ScheduleWakeup",
    );
    // Hive token 只在权限 600 的临时配置文件里，跑完就删；命令行参数里不能出现
    expect(args.join(" ")).not.toContain("test-token");
    expect(args).not.toContain("--strict-mcp-config");
    expect(JSON.parse(mcpConfig!.content)).toMatchObject({
      mcpServers: { hive: { headers: { Authorization: "Bearer test-token" } } },
    });
    if (process.platform !== "win32") expect(mcpConfig!.mode).toBe(0o600);
    expect(existsSync(args[args.indexOf("--mcp-config") + 1]!)).toBe(false);
    expect(args).toContain("sonnet");
    expect(args).toContain("00000000-0000-4000-8000-000000000001");
    expect(args).not.toContain("Shared context");
    // 提示走流式输入（一行 JSON 用户消息），不放在命令行参数里
    expect(args[args.indexOf("--input-format") + 1]).toBe("stream-json");
    expect(args).toContain("--replay-user-messages");
    const line = JSON.parse(String(runner.mock.calls[0]?.[2].input).trim());
    expect(line).toMatchObject({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "Shared context" }] },
    });
  });

  it("injects a message into the running turn and keeps input open until Claude has taken it", async () => {
    const written: string[] = [];
    let ended = false;
    let emit: (line: object) => void = () => undefined;
    let finish: () => void = () => undefined;
    const runner: CommandRunner = (_command, _args, options) =>
      new Promise((resolve) => {
        emit = (line) => options.onStdout?.(`${JSON.stringify(line)}\n`);
        finish = () => resolve({ stdout: "", stderr: "" });
        options.onStdin?.({
          write: (text) => written.push(text),
          end: () => {
            ended = true;
          },
        });
      });
    const responder = new ClaudeCodeResponder({ command: "claude", cwd: "/w", hive, runner });
    const reply = responder.reply({ instructions: "r", prompt: "做事" });
    await new Promise((resolve) => setImmediate(resolve));

    const steered = responder.steer("补充：加上暗号");
    const uuid = JSON.parse(written.at(-1)!).uuid as string;
    // 第一轮先出结果：引导还没被收下，输入不能关
    emit({ type: "result", is_error: false, result: "第一段", session_id: "s" });
    expect(ended).toBe(false);
    // Claude 回放这条引导 = 收下了；接着再跑一轮，出结果后才关输入
    emit({ type: "user", isReplay: true, uuid, message: { role: "user", content: [] } });
    await expect(steered).resolves.toBe(true);
    emit({ type: "result", is_error: false, result: "第二段", session_id: "s" });
    expect(ended).toBe(true);
    finish();
    // 以最后一轮为准：它看得到前面的对话，拼起来反而重复
    await expect(reply).resolves.toMatchObject({ text: "第二段", threadId: "s" });

    // 这一轮结束后再引导：直接拒绝，由 Bridge 退回排队
    await expect(responder.steer("太晚了")).resolves.toBe(false);
  });

  it("returns an unacknowledged injection to the queue when the process ends", async () => {
    let finish: () => void = () => undefined;
    const runner: CommandRunner = (_command, _args, options) =>
      new Promise((resolve) => {
        finish = () => {
          options.onStdout?.(
            `${JSON.stringify({ type: "result", is_error: false, result: "ok" })}\n`,
          );
          resolve({ stdout: "", stderr: "" });
        };
        options.onStdin?.({ write: () => undefined, end: () => undefined });
      });
    const responder = new ClaudeCodeResponder({ command: "claude", cwd: "/w", hive, runner });
    const reply = responder.reply({ instructions: "r", prompt: "做事" });
    await new Promise((resolve) => setImmediate(resolve));
    const steered = responder.steer("补充");
    finish();
    await reply;
    await expect(steered).resolves.toBe(false);
  });

  it.each(["workspace", "full"] as const)("maps %s access to Claude Code", async (access) => {
    const runner = vi.fn<CommandRunner>(async () => ({
      stdout: JSON.stringify({ result: "ok", session_id: `session-${access}` }),
      stderr: "",
    }));
    const responder = new ClaudeCodeResponder({
      command: "claude",
      cwd: "/workspace",
      hive,
      access,
      runner,
      platform: "darwin",
    });

    await responder.reply({ instructions: "rules", prompt: "context" });

    const args = runner.mock.calls[0]?.[1] ?? [];
    expect(args[args.indexOf("--permission-mode") + 1]).toBe(
      access === "workspace" ? "auto" : "bypassPermissions",
    );
    const settings = JSON.parse(args[args.indexOf("--settings") + 1] ?? "{}") as {
      sandbox?: {
        enabled?: boolean;
        failIfUnavailable?: boolean;
        allowUnsandboxedCommands?: boolean;
      };
    };
    if (access === "workspace") {
      expect(args.join(" ")).toContain("Edit,Write,Bash");
      expect(settings.sandbox).toMatchObject({
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
      });
      expect(args).not.toContain("--dangerously-skip-permissions");
    } else {
      expect(settings.sandbox).toMatchObject({ enabled: false });
      expect(args).toContain("--dangerously-skip-permissions");
    }
  });

  it.each([
    ["darwin", true],
    ["linux", true],
    ["win32", false],
  ] as const)("workspace access on %s: system sandbox required=%s", async (platform, sandboxed) => {
    const runner = vi.fn<CommandRunner>(async () => ({
      stdout: JSON.stringify({ result: "ok", session_id: "s" }),
      stderr: "",
    }));
    const responder = new ClaudeCodeResponder({
      command: "claude",
      cwd: "/workspace",
      hive,
      access: "workspace",
      runner,
      platform,
    });

    await responder.reply({ instructions: "rules", prompt: "context" });

    const args = runner.mock.calls[0]?.[1] ?? [];
    const settings = JSON.parse(args[args.indexOf("--settings") + 1] ?? "{}") as {
      sandbox?: Record<string, unknown>;
    };
    // 不管有没有沙箱，有风险的操作都照旧弹给人批
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("auto");
    expect(args[args.indexOf("--permission-prompt-tool") + 1]).toBe("stdio");
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(claudeWorkspaceSandboxed(platform)).toBe(sandboxed);
    if (sandboxed) {
      expect(settings.sandbox).toEqual({
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
      });
    } else {
      // Windows：Claude Code 的沙箱开不了，强制就起不来；显式关掉，不留「哪天悄悄开了」的口子
      expect(settings.sandbox).toEqual({ enabled: false });
    }
  });

  it("forwards sanitized live events before returning the final streamed reply", async () => {
    const onRuntimeEvent = vi.fn();
    const responder = new ClaudeCodeResponder({
      command: "claude",
      cwd: "/workspace",
      hive,
      runner: async (_command, _args, options) => {
        options.onStdout?.(
          JSON.stringify({
            type: "system",
            subtype: "api_retry",
            error_status: 503,
            attempt: 1,
            error: "SECRET",
          }) + "\n",
        );
        expect(onRuntimeEvent).toHaveBeenCalledWith({
          kind: "provider_error",
          code: 503,
          retryAttempt: 1,
        });
        options.onStdout?.(
          JSON.stringify({ type: "result", result: "done", session_id: "resumed" }) + "\n",
        );
        return { stdout: "", stderr: "" };
      },
    });
    await expect(
      responder.reply({ instructions: "rules", prompt: "context", onRuntimeEvent }),
    ).resolves.toEqual({ text: "done", threadId: "resumed" });
    expect(onRuntimeEvent).toHaveBeenCalledWith({
      kind: "capabilities",
      observability: "partial",
      usage: true,
    });
    expect(onRuntimeEvent).toHaveBeenCalledWith({ kind: "recovered" });
    expect(JSON.stringify(onRuntimeEvent.mock.calls)).not.toContain("SECRET");
  });

  it("stops by asking Claude to interrupt and reports a confirmed stop", async () => {
    const written: string[] = [];
    let emit: (line: object) => void = () => undefined;
    let killed = false;
    const runner: CommandRunner = (_command, _args, options) =>
      new Promise((resolve, reject) => {
        emit = (line) => options.onStdout?.(`${JSON.stringify(line)}\n`);
        options.signal?.addEventListener("abort", () => {
          killed = true;
          reject(new AgentCancelledError());
        });
        options.onStdin?.({
          write: (text) => written.push(text),
          // 中断后 Claude 关输入即以非零码退出
          end: () => reject(new Error("运行进程异常退出（1）。")),
        });
      });
    const responder = new ClaudeCodeResponder({ command: "claude", cwd: "/w", hive, runner });
    const stop = new AbortController();
    const reply = responder.reply({ instructions: "r", prompt: "做事", signal: stop.signal });
    await new Promise((resolve) => setImmediate(resolve));
    stop.abort();
    const request = JSON.parse(written.at(-1)!);
    expect(request).toMatchObject({ type: "control_request", request: { subtype: "interrupt" } });
    emit({
      type: "control_response",
      response: { subtype: "success", request_id: request.request_id },
    });
    emit({ type: "result", subtype: "error_during_execution", is_error: true, session_id: "s" });
    await expect(reply).rejects.toBeInstanceOf(AgentCancelledError);
    expect(killed).toBe(false);
  });

  it("hands a workspace tool-permission prompt to a human and answers Claude with the decision", async () => {
    const written: string[] = [];
    let emit: (line: object) => void = () => undefined;
    let finish: () => void = () => undefined;
    let args: string[] = [];
    const runner: CommandRunner = (_command, commandArgs, options) =>
      new Promise((resolve) => {
        args = commandArgs;
        emit = (line) => options.onStdout?.(`${JSON.stringify(line)}\n`);
        finish = () => resolve({ stdout: "", stderr: "" });
        options.onStdin?.({ write: (text) => written.push(text), end: () => undefined });
      });
    const responder = new ClaudeCodeResponder({
      command: "claude",
      cwd: "/w",
      hive,
      runner,
      access: "workspace",
    });
    const asked: unknown[] = [];
    const reply = responder.reply({
      instructions: "r",
      prompt: "做事",
      requestApproval: async (request) => {
        asked.push(request);
        return request.summary.includes("allowed");
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(args.join(" ")).toContain("--permission-prompt-tool stdio");
    const ask = (id: string, command: string) =>
      emit({
        type: "control_request",
        request_id: id,
        request: { subtype: "can_use_tool", tool_name: "Bash", input: { command } },
      });
    ask("p1", "touch allowed");
    ask("p2", "rm -rf /");
    await new Promise((resolve) => setImmediate(resolve));
    const responses = written
      .map((line) => JSON.parse(line))
      .filter((line) => line.type === "control_response")
      .map((line) => [line.response.request_id, line.response.response.behavior]);
    expect(responses).toEqual([
      ["p1", "allow"],
      ["p2", "deny"],
    ]);
    expect(asked).toEqual([
      { tool: "Bash", summary: "touch allowed" },
      { tool: "Bash", summary: "rm -rf /" },
    ]);
    emit({ type: "result", is_error: false, result: "ok", session_id: "s" });
    finish();
    await reply;
  });

  it("falls back to killing the process, as an unknown result, when the interrupt is not confirmed", async () => {
    const runner: CommandRunner = (_command, _args, options) =>
      new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new AgentCancelledError()));
        options.onStdin?.({ write: () => undefined, end: () => undefined });
      });
    const responder = new ClaudeCodeResponder({
      command: "claude",
      cwd: "/w",
      hive,
      runner,
      interruptTimeoutMs: 20,
    });
    const stop = new AbortController();
    const reply = responder.reply({ instructions: "r", prompt: "做事", signal: stop.signal });
    await new Promise((resolve) => setImmediate(resolve));
    stop.abort();
    await expect(reply).rejects.toBeInstanceOf(AgentExecutionUncertainError);
  });

  it("does not mistake primary-process cancellation for a verified tool-process stop", async () => {
    const responder = new ClaudeCodeResponder({
      command: "claude",
      cwd: "/workspace",
      hive,
      runner: async () => {
        throw new AgentCancelledError();
      },
    });
    await expect(
      responder.reply({ instructions: "rules", prompt: "context" }),
    ).rejects.toBeInstanceOf(AgentExecutionUncertainError);
  });

  it("rejects malformed or empty Claude Code results", async () => {
    const malformed = new ClaudeCodeResponder({
      command: "claude",
      cwd: "/workspace",
      hive,
      runner: async () => ({ stdout: "not-json", stderr: "" }),
    });
    await expect(malformed.reply({ instructions: "rules", prompt: "context" })).rejects.toThrow(
      /无法解析/,
    );

    const empty = new ClaudeCodeResponder({
      command: "claude",
      cwd: "/workspace",
      hive,
      runner: async () => ({
        stdout: JSON.stringify({ is_error: true, subtype: "error", result: "" }),
        stderr: "",
      }),
    });
    await expect(empty.reply({ instructions: "rules", prompt: "context" })).rejects.toThrow(
      /没有返回/,
    );

    // API 报错（限流等）时把原因带出来，界面上不再只有「结果未知」
    const throttled = new ClaudeCodeResponder({
      command: "claude",
      cwd: "/workspace",
      hive,
      runner: async () => ({
        stdout: JSON.stringify({
          is_error: true,
          result: "API Error: 429 rate limited, key sk-ant-abcdefghijklmnopqrstuvwxyz",
          session_id: "session-1",
        }),
        stderr: "",
      }),
    });
    const failure = throttled.reply({ instructions: "rules", prompt: "context" });
    await expect(failure).rejects.toThrow(/API Error: 429 rate limited/);
    await expect(failure).rejects.not.toThrow(/abcdefghijklmnopqrstuvwxyz/);
    // 上游出错单独归类，并带上这一轮的会话，Bridge 才能接着它继续
    const error = (await failure.catch((cause: unknown) => cause)) as AgentUpstreamError;
    expect(error).toBeInstanceOf(AgentUpstreamError);
    expect(error.threadId).toBe("session-1");
  });

  it("passes the per-turn model to Claude Code over the startup model", async () => {
    const runner = vi.fn<CommandRunner>(async () => ({
      stdout: JSON.stringify({ type: "result", is_error: false, result: "ok", session_id: "s" }),
      stderr: "",
    }));
    const responder = new ClaudeCodeResponder({
      command: "claude",
      cwd: "/workspace",
      hive,
      model: "sonnet",
      runner,
    });
    await responder.reply({ instructions: "r", prompt: "p", model: "opus" });
    const args = runner.mock.calls[0]![1];
    expect(args[args.indexOf("--model") + 1]).toBe("opus");
    expect(args.filter((arg) => arg === "--model")).toHaveLength(1);
  });

  it("passes the per-turn reasoning effort with --effort only when one is set", async () => {
    const runner = vi.fn<CommandRunner>(async () => ({
      stdout: JSON.stringify({ type: "result", is_error: false, result: "ok", session_id: "s" }),
      stderr: "",
    }));
    const responder = new ClaudeCodeResponder({
      command: "claude",
      cwd: "/workspace",
      hive,
      runner,
    });
    await responder.reply({ instructions: "r", prompt: "p", effort: "xhigh" });
    await responder.reply({ instructions: "r", prompt: "p" });
    const [first, second] = runner.mock.calls.map((call) => call[1]);
    expect(first![first!.indexOf("--effort") + 1]).toBe("xhigh");
    // 没设置就不传，沿用 Claude Code 自己的配置
    expect(second).not.toContain("--effort");
  });

  it("passes the compaction window and cache TTL in the same --settings as the sandbox", async () => {
    const runner = vi.fn<CommandRunner>(async () => ({
      stdout: JSON.stringify({ type: "result", is_error: false, result: "ok", session_id: "s" }),
      stderr: "",
    }));
    const responder = new ClaudeCodeResponder({
      command: "claude",
      cwd: "/workspace",
      hive,
      access: "full",
      runner,
    });
    await responder.reply({
      instructions: "r",
      prompt: "p",
      compactWindow: 200_000,
      cacheTtl: "1h",
    });
    await responder.reply({ instructions: "r", prompt: "p" });
    const [first, second] = runner.mock.calls.map((call) => call[1]);
    // 只有一个 --settings：实测多个也会合并，但一个更好核对
    expect(first!.filter((arg) => arg === "--settings")).toHaveLength(1);
    expect(JSON.parse(first![first!.indexOf("--settings") + 1]!)).toEqual({
      sandbox: { enabled: false },
      autoCompactWindow: 200_000,
      promptCacheTtl: "1h",
    });
    // 没给就不传，由 Claude Code 自己定
    expect(JSON.parse(second![second!.indexOf("--settings") + 1]!)).toEqual({
      sandbox: { enabled: false },
    });
  });

  it("read-only access passes --settings only when there is something to set", async () => {
    const runner = vi.fn<CommandRunner>(async () => ({
      stdout: JSON.stringify({ type: "result", is_error: false, result: "ok", session_id: "s" }),
      stderr: "",
    }));
    const responder = new ClaudeCodeResponder({ command: "claude", cwd: "/w", hive, runner });
    await responder.reply({ instructions: "r", prompt: "p" });
    await responder.reply({ instructions: "r", prompt: "p", cacheTtl: "5m" });
    const [first, second] = runner.mock.calls.map((call) => call[1]);
    expect(first).not.toContain("--settings");
    expect(JSON.parse(second![second!.indexOf("--settings") + 1]!)).toEqual({
      promptCacheTtl: "5m",
    });
  });

  it("reports Claude Code's auto-compaction to the caller", async () => {
    // 实测 2.1.330 压缩时的输出（截掉了无关字段）
    const stdout = [
      { type: "system", subtype: "init", session_id: "s" },
      { type: "system", subtype: "status", status: "compacting", session_id: "s" },
      { type: "system", subtype: "status", status: null, compact_result: "success" },
      {
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: {
          trigger: "auto",
          pre_tokens: 289_737,
          post_tokens: 10_079,
          duration_ms: 12_835,
        },
      },
      // 手动 /compact 不算
      {
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "manual", pre_tokens: 5 },
      },
      { type: "result", is_error: false, result: "ok", session_id: "s" },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n");
    const runner = vi.fn<CommandRunner>(async () => ({ stdout, stderr: "" }));
    const responder = new ClaudeCodeResponder({ command: "claude", cwd: "/w", hive, runner });
    const onCompacted = vi.fn();
    const onProgress = vi.fn();
    await responder.reply({ instructions: "r", prompt: "p", onCompacted, onProgress });
    expect(onProgress).toHaveBeenCalledWith("正在自动压缩上下文");
    expect(onCompacted).toHaveBeenCalledTimes(1);
    expect(onCompacted).toHaveBeenCalledWith({
      preTokens: 289_737,
      postTokens: 10_079,
      durationMs: 12_835,
    });
  });

  it("reports a resume that finds no conversation as a broken session", async () => {
    // 真实情况（已实测）：--resume 一个不存在的会话，Claude Code 写出这样的结果后以退出码 1 结束
    const result = `${JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      num_turns: 0,
      session_id: "fresh-id",
      errors: ["No conversation found with session ID: 0b1c-gone"],
    })}\n`;
    const responder = new ClaudeCodeResponder({
      command: "claude",
      cwd: "/workspace",
      hive,
      runner: (_command, _args, options) => {
        options.onStdout?.(result);
        return Promise.reject(new Error("运行进程异常退出（1）。"));
      },
    });
    const error = (await responder
      .reply({ instructions: "rules", prompt: "context", threadId: "0b1c-gone" })
      .catch((cause: unknown) => cause)) as AgentSessionInvalidError;
    expect(error).toBeInstanceOf(AgentSessionInvalidError);
    expect(error.reason).toContain("No conversation found");
    expect(error.executed).toBe(false);

    // 没有续接会话时同样的输出不算会话失效（不是我们的会话坏了）
    const fresh = await responder
      .reply({ instructions: "rules", prompt: "context" })
      .catch((cause: unknown) => cause);
    expect(fresh).not.toBeInstanceOf(AgentSessionInvalidError);
  });

  it("treats a non-zero exit after an upstream error result as an upstream failure, not an interruption", async () => {
    // 真实情况：重试 10 次都 429 后，Claude Code 先写出 is_error 的结果，再以退出码 1 结束
    const result = `${JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      result:
        'API Error: 429 {"error":{"message":"This channel has reached its request rate limit"}}',
      session_id: "session-429",
    })}\n`;
    const exhausted = new ClaudeCodeResponder({
      command: "claude",
      cwd: "/workspace",
      hive,
      runner: (_command, _args, options) => {
        options.onStdout?.(result);
        return Promise.reject(new Error("运行进程异常退出（1）。"));
      },
    });
    const error = (await exhausted
      .reply({ instructions: "rules", prompt: "context" })
      .catch((cause: unknown) => cause)) as AgentUpstreamError;
    expect(error).toBeInstanceOf(AgentUpstreamError);
    expect(error.message).toMatch(/429/);
    expect(error.threadId).toBe("session-429");

    // 网关限流却回 403 + Failed to authenticate（真实输出）：同样按上游出错，能点「继续」
    const gateway = new ClaudeCodeResponder({
      command: "claude",
      cwd: "/workspace",
      hive,
      runner: (_command, _args, options) => {
        options.onStdout?.(
          `${JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Failed to authenticate. API Error: 403 重试渠道均失败（共 7 次尝试）: 该渠道已达到请求速率限制，请稍后重试 (request id: 20261120151200000000000000000000) | 重试渠道均失败（共 1 次尝试）: 555420: The deployment request could not be completed.", session_id: "session-403" })}\n`,
        );
        return Promise.reject(new Error("运行进程异常退出（1）。"));
      },
    });
    const throttled = (await gateway
      .reply({ instructions: "rules", prompt: "context" })
      .catch((cause: unknown) => cause)) as AgentUpstreamError;
    expect(throttled).toBeInstanceOf(AgentUpstreamError);
    expect(throttled.kind).toBe("rate_limited");
    expect(throttled.threadId).toBe("session-403");

    // key 无效：等多久都不会好，按上游出错交给 Bridge（不自动重试、写明要重新登录），不当成结果未知
    const rejected = new ClaudeCodeResponder({
      command: "claude",
      cwd: "/workspace",
      hive,
      runner: (_command, _args, options) => {
        options.onStdout?.(
          `${JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "API Error: 401 invalid api key" })}\n`,
        );
        return Promise.reject(new Error("运行进程异常退出（1）。"));
      },
    });
    const auth = (await rejected
      .reply({ instructions: "rules", prompt: "context" })
      .catch((cause: unknown) => cause)) as AgentUpstreamError;
    expect(auth).toBeInstanceOf(AgentUpstreamError);
    expect(auth.kind).toBe("auth");

    // 结果是说不清的报错：仍按「结果未知」处理，但把 Claude Code 的原话带上，人才知道为什么停
    const other = new ClaudeCodeResponder({
      command: "claude",
      cwd: "/workspace",
      hive,
      runner: (_command, _args, options) => {
        options.onStdout?.(
          `${JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Tool execution aborted unexpectedly" })}\n`,
        );
        return Promise.reject(new Error("运行进程异常退出（1）。"));
      },
    });
    const unknown = await other
      .reply({ instructions: "rules", prompt: "context" })
      .catch((cause: unknown) => cause);
    expect(unknown).toBeInstanceOf(AgentExecutionUncertainError);
    expect((unknown as Error).message).toBe(
      "Claude Code 中途报错退出：Tool execution aborted unexpectedly。",
    );

    // 没有结果：仍按「执行中断，结果未知」处理，不能盲目重放
    const broken = new ClaudeCodeResponder({
      command: "claude",
      cwd: "/workspace",
      hive,
      runner: () => Promise.reject(new Error("运行进程异常退出（1）。")),
    });
    await expect(broken.reply({ instructions: "rules", prompt: "context" })).rejects.toBeInstanceOf(
      AgentExecutionUncertainError,
    );
  });

  it("loads only the MCP servers left enabled in the agent settings file", async () => {
    const settingsFile = path.join(mkdtempSync(path.join(tmpdir(), "hive-settings-")), "a.json");
    writeFileSync(settingsFile, JSON.stringify({ mcpDisabled: ["rea"] }));
    let seen: { file: string; config: unknown; mode: number } | undefined;
    const runner = vi.fn<CommandRunner>(async (_command, args) => {
      const file = args[args.indexOf("--mcp-config") + 1]!;
      seen = {
        file,
        config: JSON.parse(readFileSync(file, "utf8")),
        mode: statSync(file).mode & 0o777,
      };
      return { stdout: JSON.stringify({ result: "ok", session_id: "s1" }), stderr: "" };
    });
    const mcpServers = vi.fn((_cwd: string, settings: { mcpDisabled: string[] }) =>
      settings.mcpDisabled.includes("rea")
        ? { "chrome-devtools": { command: "chrome-devtools-mcp" } }
        : { "chrome-devtools": { command: "chrome-devtools-mcp" }, rea: { command: "rea" } },
    );
    const responder = new ClaudeCodeResponder({
      command: "claude",
      cwd: "/workspace",
      hive,
      runner,
      settingsFile,
      mcpServers,
    });

    await responder.reply({ instructions: "rules", prompt: "context" });

    const args = runner.mock.calls[0]?.[1] ?? [];
    expect(args).toContain("--strict-mcp-config");
    expect(mcpServers).toHaveBeenCalledWith("/workspace", { mcpDisabled: ["rea"] });
    const config = seen?.config as { mcpServers: Record<string, { url?: string }> };
    expect(Object.keys(config.mcpServers)).toEqual(["chrome-devtools", "hive"]);
    expect(config.mcpServers.hive?.url).toBe("http://localhost:8787/mcp");
    // 本机 MCP 配置可能含密钥：只写进本人可读的临时文件，不放进命令行参数，用完删除
    // Windows 没有 POSIX 权限位，靠用户目录的 ACL 保护
    if (process.platform !== "win32") expect(seen?.mode).toBe(0o600);
    expect(args.join(" ")).not.toContain("test-token");
    expect(existsSync(seen!.file)).toBe(false);

    // 改设置后下一轮生效
    writeFileSync(settingsFile, JSON.stringify({ mcpDisabled: [] }));
    await responder.reply({ instructions: "rules", prompt: "context" });
    expect(Object.keys((seen?.config as { mcpServers: object }).mcpServers)).toEqual([
      "chrome-devtools",
      "rea",
      "hive",
    ]);
  });

  it("keeps Claude Code's own MCP loading when no settings file is given", async () => {
    const runner = vi.fn<CommandRunner>(async () => ({
      stdout: JSON.stringify({ result: "ok", session_id: "s1" }),
      stderr: "",
    }));
    const responder = new ClaudeCodeResponder({
      command: "claude",
      cwd: "/workspace",
      hive,
      runner,
    });
    await responder.reply({ instructions: "rules", prompt: "context" });
    expect(runner.mock.calls[0]?.[1]).not.toContain("--strict-mcp-config");
  });
});
