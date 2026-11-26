import type { CommandResult, CommandRunner } from "./command-runner.js";
import { streamCommandRunner } from "./stream-command-runner.js";
import { ClaudeStream, type ClaudeResult } from "./claude-stream.js";
import { classifyClaude, classifyText, isUpstreamKind } from "./failure.js";
import { claudeToolSummary, redactTrace } from "./trace.js";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { claudeHiveMcpConfig, type HiveMcpConnection } from "./hive-mcp-config.js";
import type { ClaudeWarmRegistry, WarmTicket } from "./claude-warm-registry.js";
import { enabledClaudeMcpServers, readAgentSettings, type AgentSettings } from "./mcp-servers.js";
import {
  AgentCancelledError,
  AgentExecutionUncertainError,
  AgentSessionInvalidError,
  AgentUpstreamError,
  type AgentAccessMode,
  type AgentReply,
  type AgentReplyInput,
  type AgentResponder,
} from "./responder.js";

/** 一行 stream-json 输入：一条用户消息，带上 uuid，Claude 收进对话时会按这个 uuid 回放 */
function userLine(text: string, uuid: string): string {
  return `${JSON.stringify({
    type: "user",
    uuid,
    message: { role: "user", content: [{ type: "text", text }] },
  })}\n`;
}

/** 用 --mcp-config 的占位：常驻进程按参数判断能否复用，临时文件路径每次不同，不能算进去 */
const MCP_CONFIG_PLACEHOLDER = "\u0000hive-mcp-config\u0000";

/**
 * 常驻的 Claude 进程：一轮结束后不关标准输入，下一轮直接写进新消息，省掉拉起进程、加载插件和 MCP、
 * 读取会话记录（--resume）的时间。参数（规则、模型、思考强度、MCP、权限档）不变、会话也是同一个时才复用，
 * 否则结束它另起；空闲超时、出错、被停止都会结束进程，下一轮照旧 --resume 接上。
 */
type WarmClaude = {
  key: string;
  /** 这个进程上一轮结束时的会话 ID：Bridge 下一轮要接的会话不是它就不能复用 */
  sessionId?: string | undefined;
  stdin?: { write: (text: string) => void; end: () => void };
  /** 当前这一轮接收 stdout 的地方；空闲时丢弃 */
  route: (chunk: string) => void;
  /** 进程退出：正常退出 resolve，异常 reject（已经挂了处理，不会成为未处理的拒绝） */
  exit: Promise<CommandResult>;
  exited: boolean;
  kill: AbortController;
  idleTimer?: NodeJS.Timeout | undefined;
  /** 停着时在机器级登记表里的登记；被别的 Bridge 淘汰（登记被删）就结束进程 */
  ticket?: WarmTicket | undefined;
  pollTimer?: NodeJS.Timeout | undefined;
};

/** 缓存是 1 小时的：进程也留到接近 1 小时（缓存从最后一次请求算起，留 5 分钟余量） */
const CACHE_1H_KEEPALIVE_MS = 55 * 60_000;

/** 停着的进程多久查一次自己有没有被淘汰 */
const WARM_POLL_MS = 5_000;

/** 不再停着（复用、结束）：撤掉登记和定时器 */
function unpark(warm: WarmClaude): void {
  if (warm.idleTimer) clearTimeout(warm.idleTimer);
  if (warm.pollTimer) clearInterval(warm.pollTimer);
  warm.idleTimer = undefined;
  warm.pollTimer = undefined;
  warm.ticket?.release();
  warm.ticket = undefined;
}

/** 正在跑的这一轮：标准输入保持打开，引导写进去，Claude 在工具间隙读到 */
type ClaudeTurn = {
  stdin?: { write: (text: string) => void; end: () => void };
  /** 已经关闭输入、不再接收引导 */
  closed: boolean;
  /** 写进去、还没被 Claude 收进对话的引导：uuid → 收下后的回调 */
  unacked: Map<string, (accepted: boolean) => void>;
};

/**
 * Claude Code 写出了 is_error 的结果：按错误类别、状态码和原文分类（见 failure.ts 的 classifyClaude），
 * 是上游出错的交给 Bridge 处理；说不清的返回 undefined，照旧按结果未知报
 */
function upstreamFailure(
  payload: ClaudeResult | undefined,
  threadId: string | undefined,
): AgentUpstreamError | undefined {
  if (!payload?.is_error || !payload.result?.trim()) return undefined;
  const kind = classifyClaude({
    category: payload.error_category,
    status: payload.api_error_status,
    terminalReason: payload.terminal_reason,
    text: payload.result,
  });
  if (!isUpstreamKind(kind)) return undefined;
  return new AgentUpstreamError(
    redactTrace(payload.result.replace(/\s+/g, " ").trim()).slice(0, 240),
    payload.session_id ?? threadId,
    kind,
  );
}

/**
 * 工作区档在这个平台上有没有系统沙箱。
 * Windows：Claude Code 的 Windows 沙箱还没对所有会话开放（实测 2.1.299 报「feature gate off」），
 * 强制沙箱就根本起不来，所以不开沙箱，靠 auto 模式的审核：分类器判为有风险的操作直接拒绝（不会弹给人），
 * 只有命中 ask 规则的才通过 can_use_tool 交给人批（Windows 实测：写工作区外的文件不拦也不问，curl | sh 被拒）；
 * 界面和规则都如实说明命令能碰到工作区以外的文件。
 * macOS、Linux：照旧强制沙箱，开不了（如 Linux 缺 bubblewrap）就报错退出，不悄悄降级。
 */
export function claudeWorkspaceSandboxed(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32";
}

/** 工作区档传给 Claude Code 的沙箱设置 */
export function claudeWorkspaceSandboxSettings(
  platform: NodeJS.Platform = process.platform,
): Record<string, unknown> {
  return claudeWorkspaceSandboxed(platform)
    ? { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false }
    : // 显式关掉：「开但允许不可用」会在 Windows 沙箱哪天放开时悄悄改变行为，和界面上的说明对不上
      { enabled: false };
}

export class ClaudeCodeResponder implements AgentResponder {
  private turn: ClaudeTurn | undefined;
  private warm: WarmClaude | undefined;
  /** 最近一次写缓存是不是 1 小时的（缓存时长跟随 Claude Code 时，按实际写入判断常驻多久） */
  private cache1h = false;

  /** 结束常驻进程（Bridge 停止、换任务目录时调用） */
  async close(): Promise<void> {
    const warm = this.warm;
    this.warm = undefined;
    if (!warm) return;
    this.retire(warm);
    await warm.exit.catch(() => undefined);
  }

  /** 关掉常驻进程的标准输入，让它自己退出；临时 MCP 配置在进程退出后删除 */
  private retire(warm: WarmClaude): void {
    if (this.warm === warm) this.warm = undefined;
    unpark(warm);
    warm.route = () => undefined;
    if (warm.exited) return;
    if (warm.stdin) warm.stdin.end();
    else warm.kill.abort();
  }

  /**
   * 引导：写进正在跑的这一轮的标准输入，Claude 回放（确认收进对话）后才算插进去。
   * 这一轮已经结束、或者写进去后进程意外退出，都返回 false，由 Bridge 退回排队。
   * 收下的引导 Claude 一定会处理：在工具间隙读到就并入这一轮，晚了就在同一进程里接着再跑一轮。
   */
  async steer(prompt: string): Promise<boolean> {
    const turn = this.turn;
    if (!turn || turn.closed || !turn.stdin) return false;
    const uuid = randomUUID();
    const accepted = new Promise<boolean>((resolve) => turn.unacked.set(uuid, resolve));
    turn.stdin.write(userLine(prompt, uuid));
    return accepted;
  }
  constructor(
    private readonly options: {
      command: string;
      cwd: string;
      hive: HiveMcpConnection;
      access?: AgentAccessMode;
      model?: string;
      runner?: CommandRunner;
      /** 测试注入：Agent 运行的平台，默认 process.platform */
      platform?: NodeJS.Platform;
      /**
       * 本机 Hive Server 写入的 Agent 设置文件。给定时只加载勾选的 MCP（--strict-mcp-config），
       * 每一轮重新读取，改动下一轮生效；不给时沿用 Claude Code 自己的全部 MCP 配置。
       */
      settingsFile?: string;
      /**
       * 一轮结束后保留 Claude 进程多久，期间下一轮直接复用（0 或不给：每轮新起进程，跑完就退出）。
       * 只在 runner 支持流式输入时生效。
       */
      keepAliveMs?: number;
      /** 缓存是 1 小时时进程保留多久（默认 55 分钟；keepAliveMs 为 0 时不常驻） */
      cacheKeepAliveMs?: number;
      /** 机器级登记表：所有 Agent 合起来最多留几个空闲的 Claude 进程 */
      warmRegistry?: ClaudeWarmRegistry;
      /** 停着时多久查一次有没有被淘汰（默认 5 秒） */
      warmPollMs?: number;
      /** 停止时请 Claude 自己中断，等多久没确认停下就改为结束进程（默认 5 秒） */
      interruptTimeoutMs?: number;
      /** 测试注入：按 cwd 和设置列出要加载的 MCP（不含 hive） */
      mcpServers?: (
        cwd: string,
        settings: AgentSettings,
      ) => Record<string, Record<string, unknown>>;
    },
  ) {}

  /**
   * 本轮的 MCP 配置，写进临时文件交给 --mcp-config。用文件而不是命令行参数：Hive token 和本机 MCP 配置里常有的密钥
   * 放在命令行参数里会被同机其他用户通过 ps 看到。没有设置文件时只写 Hive 一项。
   */
  private mcpConfigJson(): string {
    const servers =
      this.options.settingsFile === undefined
        ? {}
        : (this.options.mcpServers ?? enabledClaudeMcpServers)(
            this.options.cwd,
            readAgentSettings(this.options.settingsFile),
          );
    const hive = (
      JSON.parse(claudeHiveMcpConfig(this.options.hive)) as {
        mcpServers: Record<string, unknown>;
      }
    ).mcpServers;
    // 名称有序且内容不变时文件逐字节相同，工具定义的前缀缓存不会因此失效
    return JSON.stringify({ mcpServers: { ...servers, ...hive } });
  }

  private writeMcpConfig(content: string): { file: string; cleanup: () => void } {
    const dir = mkdtempSync(path.join(tmpdir(), "hive-claude-mcp-"));
    const file = path.join(dir, "mcp.json");
    writeFileSync(file, content, { mode: 0o600 });
    return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  async reply(input: AgentReplyInput): Promise<AgentReply> {
    const access = this.options.access ?? "read-only";
    const hiveTools = [
      "hive_room_read",
      "hive_members_list",
      "hive_message_send",
      "hive_invoke",
      "hive_wait",
      "hive_ask_human",
      "hive_board_read",
      "hive_board_update",
      "hive_todo_list",
      "hive_todo_add",
      "hive_todo_update",
      "hive_attachment_read",
      "hive_schedule_create",
      "hive_schedule_list",
      "hive_schedule_cancel",
      "hive_room_create",
      "hive_room_post",
      "hive_incident_report",
      "hive_rule_propose",
    ]
      .map((tool) => `mcp__hive__${tool}`)
      .join(",");
    const mcpConfig = this.mcpConfigJson();
    const args = [
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      // 流式输入：这一轮跑着时还能写进新消息（引导）；回放写进去的消息，用来确认 Claude 已经收下
      "--input-format",
      "stream-json",
      "--replay-user-messages",
      "--permission-mode",
      access === "read-only" ? "plan" : access === "workspace" ? "auto" : "bypassPermissions",
      "--append-system-prompt",
      input.instructions,
      "--mcp-config",
      MCP_CONFIG_PLACEHOLDER,
      ...(this.options.settingsFile !== undefined ? ["--strict-mcp-config"] : []),
      "--allowedTools",
      access === "workspace" ? `Read,Glob,Grep,Edit,Write,Bash,${hiveTools}` : hiveTools,
      // 工作区档：Claude 想做 auto 模式下要人确认的事时，通过标准输入问我们（can_use_tool），交给人批；
      // 其余档不弹：只读档照旧直接拒绝，完全权限档本来就不问
      ...(access === "workspace" ? ["--permission-prompt-tool", "stdio"] : []),
      // Claude 自带的定时只活在这一轮的进程里，回复完进程一退就没了，服务端也看不到：一律改用 hive_schedule_create
      "--disallowedTools",
      "CronCreate,CronDelete,CronList,ScheduleWakeup",
    ];
    // 一个 --settings 带上这一轮要覆盖的 Claude Code 设置：沙箱（按权限档）、自动压缩阈值、缓存时长。
    // 实测 2.1.330 在 --print、stream-json 下都生效；改了任一项参数就变了，常驻进程按规则换新进程
    const settings: Record<string, unknown> = {};
    if (access === "workspace")
      settings.sandbox = claudeWorkspaceSandboxSettings(this.options.platform);
    if (access === "full") {
      args.push("--dangerously-skip-permissions");
      settings.sandbox = { enabled: false };
    }
    if (input.compactWindow) settings.autoCompactWindow = input.compactWindow;
    if (input.cacheTtl) settings.promptCacheTtl = input.cacheTtl;
    if (Object.keys(settings).length > 0) args.push("--settings", JSON.stringify(settings));
    // 每轮都是新进程：Agent 设置里改的模型、「换个模型重试」下一轮就生效
    const model = input.model ?? this.options.model;
    if (model) args.push("--model", model);
    // 思考强度：Agent 设置或「换个模型重试」选的才传，否则沿用 CLI 自己的配置
    if (input.effort) args.push("--effort", input.effort);
    // 能复用的常驻进程：参数（含 MCP 配置内容）完全一样，且停在 Bridge 要接的这个会话上
    const key = JSON.stringify([this.options.cwd, args, mcpConfig]);
    const previous = this.warm;
    const reuse =
      previous !== undefined &&
      !previous.exited &&
      previous.stdin !== undefined &&
      previous.key === key &&
      input.threadId !== undefined &&
      previous.sessionId === input.threadId &&
      !input.signal?.aborted;
    if (previous && !reuse) this.retire(previous);
    if (previous && reuse) unpark(previous);

    const stream = new ClaudeStream(
      (event) => input.onRuntimeEvent?.(event),
      (step) => input.onTrace?.(step),
      (sessionId) => input.onSession?.(sessionId),
    );
    input.onRuntimeEvent?.({ kind: "capabilities", observability: "partial", usage: true });
    // 失败、中断时也交出已经发生的用量：钱已经花了
    const reportUsage = () => {
      stream.finish();
      input.onUsage?.(stream.usage());
    };
    input.onRuntimeEvent?.({ kind: "activity", phase: "starting" });
    const turn: ClaudeTurn = { closed: false, unacked: new Map() };
    this.turn = turn;
    const keepAliveMs = this.options.keepAliveMs ?? 0;
    // 这一轮停在常驻进程里等下一轮（不关输入）：交给下面 await 的那个 Promise
    let park: (() => void) | undefined;
    const parked = new Promise<"parked">((resolve) => {
      park = () => resolve("parked");
    });
    // 出了结果、又没有还没收下的引导：这一轮结束。成功的结果留着进程给下一轮用，否则关闭输入让进程退出；
    // 还有引导没收下就继续开着，Claude 会读到它们并接着再跑一轮
    const closeIfIdle = (result?: ClaudeResult) => {
      if (turn.closed || turn.unacked.size > 0) return;
      turn.closed = true;
      if (keepAliveMs > 0 && turn.stdin && result && !result.is_error && result.session_id) {
        park?.();
        return;
      }
      turn.stdin?.end();
    };
    if (input.onHiveTools) stream.onHiveTools = input.onHiveTools;
    stream.onCompacting = () => input.onProgress?.("正在自动压缩上下文");
    if (input.onCompacted) stream.onCompacted = input.onCompacted;
    stream.onUserAck = (uuid) => {
      const resolve = turn.unacked.get(uuid);
      if (!resolve) return;
      turn.unacked.delete(uuid);
      resolve(true);
    };
    const settleTurn = () => {
      turn.closed = true;
      for (const resolve of turn.unacked.values()) resolve(false);
      turn.unacked.clear();
      if (this.turn === turn) this.turn = undefined;
    };
    /**
     * 停止：先用 stream-json 的 control_request interrupt 请 Claude 停在当前这一步——它会终止正在跑的工具、
     * 答复 control_response 并以 error_during_execution 结束这一轮，这样能确认确实停下（会话也还在，可以重试）。
     * 中断请求发不出去、或超时没有确认，才结束进程，那时只能按结果未知处理。
     */
    // 结束进程用的开关属于进程：复用时沿用常驻进程的
    const kill = reuse ? previous.kill : new AbortController();
    const interrupt = { requestId: "", acked: false, settled: false };
    let killTimer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      if (!turn.stdin || turn.closed) {
        kill.abort();
        return;
      }
      interrupt.requestId = `interrupt-${randomUUID()}`;
      // 停下以后不再接引导；还没收下的引导退回排队
      for (const resolve of turn.unacked.values()) resolve(false);
      turn.unacked.clear();
      turn.stdin.write(
        `${JSON.stringify({ type: "control_request", request_id: interrupt.requestId, request: { subtype: "interrupt" } })}\n`,
      );
      killTimer = setTimeout(() => kill.abort(), this.options.interruptTimeoutMs ?? 5_000);
      killTimer.unref?.();
    };
    stream.onPermissionRequest = (requestId, request) => {
      const answer = (allow: boolean, message?: string) => {
        if (turn.closed || !turn.stdin) return;
        turn.stdin.write(
          `${JSON.stringify({
            type: "control_response",
            response: {
              subtype: "success",
              request_id: requestId,
              response: allow
                ? { behavior: "allow", updatedInput: request.input }
                : { behavior: "deny", message: message ?? "没有获得批准。" },
            },
          })}\n`,
        );
      };
      if (access !== "workspace" || !input.requestApproval) {
        answer(false, "当前权限档不允许这个操作。");
        return;
      }
      void input
        .requestApproval({
          tool: request.toolName,
          summary: claudeToolSummary(request.toolName, request.input) || request.toolName,
          ...(request.description ? { detail: request.description } : {}),
        })
        .then(
          (allow) => answer(allow, allow ? undefined : "人没有批准这个操作（拒绝或超时）。"),
          () => answer(false),
        );
    };
    stream.onControlResponse = (requestId, ok) => {
      if (requestId === interrupt.requestId && ok) interrupt.acked = true;
    };
    stream.onResult = (result) => {
      // 中断确认后出的这个结果就是这一轮的收尾：确认停下，关输入让进程退出
      if (interrupt.acked) {
        interrupt.settled = true;
        if (killTimer) clearTimeout(killTimer);
        if (!turn.closed) {
          turn.closed = true;
          turn.stdin?.end();
        }
        return;
      }
      closeIfIdle(result);
    };
    if (input.signal?.aborted) onAbort();
    else input.signal?.addEventListener("abort", onAbort, { once: true });
    const stoppedCleanly = () =>
      Boolean(input.signal?.aborted && interrupt.settled && !kill.signal.aborted);
    let warm: WarmClaude;
    if (reuse) {
      warm = previous;
      turn.stdin = warm.stdin!;
      warm.route = (chunk) => stream.push(chunk);
      warm.stdin!.write(userLine(input.prompt, randomUUID()));
    } else {
      if (input.threadId) args.push("--resume", input.threadId);
      const mcp = this.writeMcpConfig(mcpConfig);
      const spawnArgs = args.map((arg) => (arg === MCP_CONFIG_PLACEHOLDER ? mcp.file : arg));
      const created: WarmClaude = {
        key,
        route: (chunk) => stream.push(chunk),
        exit: Promise.resolve({ stdout: "", stderr: "" }),
        exited: false,
        kill,
      };
      created.exit = (this.options.runner ?? streamCommandRunner)(this.options.command, spawnArgs, {
        cwd: this.options.cwd,
        input: userLine(input.prompt, randomUUID()),
        onStdout: (chunk) => created.route(chunk),
        onStdin: (stdin) => {
          created.stdin = stdin;
          turn.stdin = stdin;
        },
        signal: kill.signal,
      });
      const ended = () => {
        created.exited = true;
        unpark(created);
        if (this.warm === created) this.warm = undefined;
        mcp.cleanup();
      };
      created.exit.then(ended, ended);
      warm = created;
      if (keepAliveMs > 0) this.warm = created;
    }
    let result: CommandResult | "parked";
    try {
      result = await Promise.race([warm.exit, parked]);
    } catch (error) {
      settleTurn();
      reportUsage();
      if (killTimer) clearTimeout(killTimer);
      input.signal?.removeEventListener("abort", onAbort);
      // 中断后 Claude 以非零码退出是正常的：已经确认停下
      if (stoppedCleanly()) throw new AgentCancelledError();
      if (error instanceof AgentCancelledError) {
        throw new AgentExecutionUncertainError(
          "已请求终止 Claude 主进程，但工具子进程是否停止尚未确认。",
        );
      }
      // 上游出错（重试用完的 429、额度用完、key 无效……）时，Claude Code 会先写出一条 is_error 的结果再以非零码退出。
      // 原因明确，不是「中途断了」：按上游出错交给 Bridge，它按失败原因决定自动继续还是等人
      const payload = stream.finish();
      // 恢复会话失败（会话文件被清掉、换了机器）：Claude Code 写出 is_error 的结果和原因后退出，什么都还没做
      const errors = payload?.errors?.join("; ") ?? "";
      if (payload?.is_error && input.threadId && classifyText(errors) === "session_invalid") {
        throw new AgentSessionInvalidError(
          redactTrace(errors.replace(/\s+/g, " ").trim()).slice(0, 240),
          stream.toolStarted,
        );
      }
      const upstream = upstreamFailure(payload, input.threadId);
      if (upstream) throw upstream;
      // An interrupted/invalid stream may follow tool side effects. Never blindly replay it.
      // 带上 Claude Code 最后写出的报错，否则人只看得到「中途退出」不知道为什么
      const said =
        payload?.is_error && payload.result?.trim()
          ? redactTrace(payload.result.replace(/\s+/g, " ").trim()).slice(0, 240)
          : "";
      throw new AgentExecutionUncertainError(
        said ? `Claude Code 中途报错退出：${said}。` : "Claude Code 中途退出，没有给出原因。",
      );
    } finally {
      warm.route = () => undefined;
    }
    settleTurn();
    if (killTimer) clearTimeout(killTimer);
    input.signal?.removeEventListener("abort", onAbort);
    if (stoppedCleanly()) {
      reportUsage();
      throw new AgentCancelledError();
    }
    if (result !== "parked") {
      if (this.warm === warm) this.warm = undefined;
      // Injectable legacy runners can return a complete result rather than streaming it.
      if (result.stdout) stream.push(result.stdout);
    }
    const payload = stream.finish();
    if (result === "parked") {
      // 进程留着给下一轮：记下它停在哪个会话，空闲太久就关掉
      warm.sessionId = payload?.session_id;
      if (this.warm === warm && !warm.exited) {
        // 缓存 1 小时（设置里选的，或跟随 Claude Code 时这一轮实际写的是 1 小时）：进程也留到接近 1 小时，否则缓存白留
        const written = stream.usage();
        if (written.cacheWriteTokens > 0 && written.cacheWrite1hTokens !== undefined)
          this.cache1h = written.cacheWrite1hTokens > 0;
        const cache1h = input.cacheTtl === "1h" || (input.cacheTtl === undefined && this.cache1h);
        const keep = cache1h
          ? Math.max(keepAliveMs, this.options.cacheKeepAliveMs ?? CACHE_1H_KEEPALIVE_MS)
          : keepAliveMs;
        warm.idleTimer = setTimeout(() => this.retire(warm), keep);
        warm.idleTimer.unref?.();
        warm.ticket = this.options.warmRegistry?.park();
        if (warm.ticket) {
          warm.pollTimer = setInterval(() => {
            if (!warm.ticket?.held()) this.retire(warm);
          }, this.options.warmPollMs ?? WARM_POLL_MS);
          warm.pollTimer.unref?.();
        }
      }
    }
    reportUsage();
    if (!payload)
      throw new AgentExecutionUncertainError(
        "Claude Code 返回了无法解析的最终结果，执行结果未知。",
      );
    // 上游模型服务出错：进程已正常结束、原因明确，交给 Bridge 按失败原因决定是否接着继续
    const upstream = upstreamFailure(payload, input.threadId);
    if (upstream) throw upstream;
    if (payload.is_error || !payload.result?.trim()) {
      // 带上 Claude Code 给的原因（多半是 API 限流、额度用完），否则只看得到「结果未知」不知道为什么
      const reason =
        payload.is_error && payload.result?.trim()
          ? `：${redactTrace(payload.result.replace(/\s+/g, " ").trim()).slice(0, 240)}`
          : "";
      throw new AgentExecutionUncertainError(
        `Claude Code 没有返回可发送的文本${reason}；执行途中可能已做了部分操作，结果未知。`,
      );
    }
    const usage = stream.usage();
    const sessionCostUsd = stream.sessionCostUsd();
    return {
      text: payload.result,
      ...(payload.session_id ? { threadId: payload.session_id } : {}),
      // 一次请求都没有时不放进回复（onUsage 已交出全零用量）
      ...(usage.requests > 0 ? { usage } : {}),
      ...(sessionCostUsd !== undefined ? { sessionCostUsd } : {}),
      ...(stream.compacted() ? { compacted: true } : {}),
    };
  }
}
