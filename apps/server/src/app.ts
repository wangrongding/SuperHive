import { observeRuntime } from "./runtime-observation.js";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  LIMITS,
  clientEventSchema,
  parseMentions,
  createRoomRequestSchema,
  updateRoomRequestSchema,
  type ChatMessage,
  type ClientEvent,
  type Invocation,
  type InvocationBlockReason,
  type Participant,
  type ServerEvent,
} from "@ai-hive/protocol";
import Fastify, { type FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { z } from "zod";
import { AGENT_INSTRUCTIONS } from "./agent-instructions.js";
import {
  CONTINUATION_READY_STATUSES,
  HiveDatabase,
  HiveError,
  TERMINAL_INVOCATION_STATUSES,
  type CreateMessageInput,
} from "./database.js";
import { createHiveMcpServer, type InboxDigest } from "./hive-mcp.js";
import { LocalAgentSupervisor, type LocalAgentSupervisorOptions } from "./local-agents.js";
import { registerLocalAgentRoutes } from "./local-routes.js";

type Connection = {
  socket: WebSocket;
  participant?: Participant;
  lastHeartbeat: number;
};

export type BuildAppOptions = {
  databasePath?: string;
  token?: string;
  publicUrl?: string;
  agentCommandPrefix?: string;
  instanceId?: string;
  logger?: boolean;
  heartbeatTimeoutMs?: number;
  /** 扫描超时调用的间隔；测试可调小 */
  invocationSweepMs?: number;
  /** 超时扫描使用的时钟；测试用来模拟时间流逝 */
  now?: () => number;
  staticDir?: string;
  /**
   * 本机 Agent：允许本机房主在网页上一键拉起 `ai-hive join` 子进程。
   * 省略即关闭（测试默认关闭），由 index.ts 按运行方式注入 CLI 路径。
   */
  localAgents?: Omit<
    LocalAgentSupervisorOptions,
    "database" | "joinToken" | "isAgentOnline" | "isNameInUse"
  >;
};

function participantKey(roomId: string, username: string): string {
  return `${roomId}:${username.toLocaleLowerCase()}`;
}

function send(socket: WebSocket, event: ServerEvent): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
}

function headerString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function requestPublicUrl(
  request: { protocol: string; headers: { host?: string | undefined } },
  configuredUrl?: string,
): string {
  if (configuredUrl) return configuredUrl.replace(/\/$/, "");
  return `${request.protocol}://${request.headers.host ?? "localhost:8787"}`;
}

const roomParamsSchema = z.object({
  roomId: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .max(64),
});
const messagesQuerySchema = z.object({
  afterSeq: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const mentionsQuerySchema = z.object({
  username: z.string().trim().min(1).max(32),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
const roomsQuerySchema = z.object({
  includeArchived: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: LIMITS.maxClientPayloadBytes,
  });
  const database = new HiveDatabase(options.databasePath ?? "./data/hive.sqlite");
  const joinToken = database.getOrCreateToken(options.token ?? process.env.HIVE_TOKEN);
  const connections = new Set<Connection>();
  const onlineByName = new Map<string, Set<Connection>>();
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 45_000;
  let shuttingDown = false;

  await app.register(cors, { origin: true });
  await app.register(websocket, { options: { maxPayload: LIMITS.maxClientPayloadBytes } });

  const configuredStaticDir =
    options.staticDir ?? path.resolve(import.meta.dirname, "../../web/dist");
  const hasWebUi = existsSync(path.join(configuredStaticDir, "index.html"));
  if (hasWebUi) {
    await app.register(fastifyStatic, { root: configuredStaticDir, wildcard: false });
  }

  function broadcast(roomId: string, event: ServerEvent): void {
    for (const connection of connections) {
      if (connection.participant?.roomId === roomId) send(connection.socket, event);
    }
  }

  function broadcastAll(event: ServerEvent): void {
    for (const connection of connections) {
      if (connection.participant) send(connection.socket, event);
    }
  }

  function broadcastRoomActivity(roomId: string): void {
    broadcastAll({
      type: "room.activity",
      roomId,
      latestSeq: database.latestSeq(roomId),
      onlineCount: database.onlineCount(roomId),
    });
  }

  function setStatus(connection: Connection, status: "online" | "offline" | "busy"): void {
    const current = connection.participant;
    if (!current || current.status === status) return;
    const participant = database.setParticipantStatus(current.id, status);
    connection.participant = participant;
    broadcast(participant.roomId, { type: "presence.changed", participant });
    if ((current.status === "offline") !== (status === "offline")) {
      broadcastRoomActivity(participant.roomId);
    }
  }

  function disconnect(connection: Connection): void {
    connections.delete(connection);
    const participant = connection.participant;
    if (!participant) return;
    const key = participantKey(participant.roomId, participant.username);
    const namedConnections = onlineByName.get(key);
    namedConnections?.delete(connection);
    if (namedConnections?.size) return;
    onlineByName.delete(key);
    if (shuttingDown) return;
    setStatus(connection, "offline");
  }

  /** 任意房间里是否有这个名字的在线成员；agentsOnly 时只看 Agent */
  function onlineAnywhere(username: string, agentsOnly: boolean): boolean {
    const suffix = `:${username.toLocaleLowerCase()}`;
    for (const [key, set] of onlineByName) {
      if (!key.endsWith(suffix)) continue;
      for (const connection of set) {
        if (!agentsOnly || connection.participant?.type === "agent") return true;
      }
    }
    return false;
  }

  const localAgents = options.localAgents
    ? new LocalAgentSupervisor({
        ...options.localAgents,
        database,
        joinToken,
        isAgentOnline: (name) => onlineAnywhere(name, true),
        isNameInUse: (name) => onlineAnywhere(name, false),
      })
    : undefined;
  /**
   * 清空房间：删除消息和调用记录后插入一条话题分隔，各 Agent 据此丢弃旧会话。
   * 只经本机房主接口调用（见 local-routes.ts），操作人必须是该房间里的人类成员。
   */
  function clearRoom(roomId: string, username: string) {
    if (!database.getRoom(roomId)) throw new HiveError("ROOM_NOT_FOUND", "房间不存在。");
    const actor = database.findParticipant(roomId, username);
    if (!actor || actor.type !== "human") {
      throw new HiveError("NOT_A_MEMBER", "只有房间里的人类成员可以清空房间。");
    }
    const removed = database.clearRoom(roomId);
    const message = database.createMessage(actor, {
      content: `${actor.username} 清空了房间`,
      clientMessageId: `room-clear-${randomUUID()}`,
      kind: "topic",
    }).message;
    broadcast(roomId, { type: "room.cleared", message });
    broadcastRoomActivity(roomId);
    return removed;
  }
  registerLocalAgentRoutes(app, localAgents, { clearRoom });

  function onlineAgent(roomId: string, username: string): Connection | undefined {
    return [...(onlineByName.get(participantKey(roomId, username)) ?? [])].find(
      (connection) => connection.participant?.type === "agent",
    );
  }

  // 推送给所有在线客户端：侧栏的跨房间"Agent 任务"计数需要实时更新，各房间视图按 roomId 自行过滤
  function emitInvocation(invocation: Invocation): Invocation {
    broadcastAll({ type: "invocation.updated", invocation });
    // 所有状态变更都经过这里：委派的子任务一结束就安排回执，放到下一拍避免在派发循环中重入
    if (
      invocation.continuation === "pending" &&
      CONTINUATION_READY_STATUSES.includes(invocation.status)
    ) {
      setImmediate(() => deliverContinuation(invocation.id));
    }
    return invocation;
  }

  /** 正被委派方 hive_wait 的子任务 ID 及等待者数量 */
  const activeWaits = new Map<string, number>();

  const continuationOutcome: Partial<Record<Invocation["status"], string>> = {
    completed: "已完成",
    failed: "失败",
    cancelled: "已被停止",
    timed_out: "结果未知（超时没有进展，不代表失败）",
  };

  /** 引用的正文里的 @ 换成全角，避免回执把原文中提到的成员再唤醒一遍 */
  function quoteWithoutMentions(text: string, limit: number): string {
    const quoted = text.replace(/@/g, "＠");
    return quoted.length > limit ? `${quoted.slice(0, limit)}…（已截断，全文见原消息）` : quoted;
  }

  /**
   * 子任务结束后，代被委派方给委派方发一条回执，把结果交回去：
   * 委派方不必轮询，也不依赖被委派方记得回头 @ 它。回执沿委派消息挂链，预算照常计算。
   * 先原子地占用回执状态再发消息，保证与 hive_wait、重启补发之间只回执一次。
   */
  function deliverContinuation(childId: string): void {
    // 委派方正在 hive_wait 这个子任务：结果由等待直接交回，等待结束时再决定是否补发回执
    if (activeWaits.has(childId)) return;
    const child = database.getInvocation(childId);
    if (
      !child ||
      child.continuation !== "pending" ||
      !CONTINUATION_READY_STATUSES.includes(child.status)
    ) {
      return;
    }
    const delegation = database.getMessage(child.messageId);
    const requester = child.requesterId ? database.getParticipant(child.requesterId) : undefined;
    const delegate = database.getParticipant(child.agentId);
    if (
      !delegation ||
      delegation.deletedAt ||
      !requester ||
      requester.type !== "agent" ||
      !delegate
    ) {
      if (database.claimContinuation(child.id, "failed")) {
        emitInvocation(database.getInvocation(child.id)!);
      }
      return;
    }
    if (!database.claimContinuation(child.id, "delivered")) return;
    const reply = child.replyMessageId ? database.getMessage(child.replyMessageId) : undefined;
    const lines = [
      `@${requester.username} 📬 子任务回执（Hive 代 ${delegate.username} 发出）`,
      `状态：${continuationOutcome[child.status] ?? child.status}`,
      `委派内容：${quoteWithoutMentions(delegation.content, 300)}`,
    ];
    if (reply && !reply.deletedAt) {
      lines.push(`结果（#${reply.seq}）：\n${quoteWithoutMentions(reply.content, 4000)}`);
    } else if (child.detail) {
      lines.push(`说明：${quoteWithoutMentions(child.detail, 500)}`);
    }
    lines.push(`子任务 ID：${child.id}`);
    try {
      createAndDispatchMessage(
        delegate,
        {
          content: lines.join("\n"),
          clientMessageId: `receipt-${child.id}`,
          parentMessageId: delegation.id,
          kind: "receipt",
        },
        { receipt: true },
      );
      emitInvocation(database.getInvocation(child.id)!);
    } catch (error) {
      // 链条深度、条数到顶这类错误重试也无济于事；限流等暂时性错误放回待发，由扫描重试
      const permanent =
        error instanceof HiveError &&
        ["HOP_LIMIT", "TRACE_LIMIT", "PARENT_NOT_FOUND", "SELF_RESPONSE"].includes(error.code);
      database.releaseContinuation(child.id, permanent ? "failed" : "pending");
      emitInvocation(
        database.updateInvocation(child.id, {
          detail: permanent
            ? `结果无法回执给 ${requester.username}：${error instanceof Error ? error.message : String(error)}`
            : (child.detail ?? null),
        }),
      );
    }
  }

  function isTerminal(invocation: Invocation): boolean {
    return TERMINAL_INVOCATION_STATUSES.includes(invocation.status);
  }

  function deliverMention(message: ChatMessage, agent: Participant, retry = false): void {
    const target = onlineAgent(message.roomId, agent.username);
    if (!target) return;
    send(target.socket, {
      type: "agent.mentioned",
      message,
      latestSeq: database.latestSeq(message.roomId),
      ...(retry ? { retry: true } : {}),
    });
  }

  /**
   * 多维防循环预算（参考 yobiru）：传递深度、人类缺席时的 Agent 连续轮数、每对 Agent 每日次数。
   * 人发出的 @ 只受深度限制；人在 UI 中追加轮数后，被拦下的调用会被恢复。
   */
  function budgetBlock(
    sender: Participant,
    message: ChatMessage,
    agent: Participant,
  ): { reason: InvocationBlockReason; detail: string } | undefined {
    const hopLimit = LIMITS.maxHopCount + database.turnAllowance(message.roomId);
    if (message.hopCount >= hopLimit) {
      return {
        reason: "hop_limit",
        detail: `Agent 之间的转交已达 ${hopLimit} 跳上限，点「继续」或由人重新 @ 即可续上。`,
      };
    }
    if (sender.type !== "agent") return undefined;
    const budget = database.agentTurnBudget(message.roomId);
    if (budget.used > budget.limit) {
      return {
        reason: "consecutive_limit",
        detail: `自上次有人发言以来 Agent 已连续对话 ${budget.used - 1} 轮（上限 ${budget.limit}），等待人确认后继续。`,
      };
    }
    const extra = budget.limit - LIMITS.maxConsecutiveAgentTurns;
    const pairLimit = LIMITS.maxAgentPairTurnsPerDay + extra;
    if (database.pairTurnsToday(message.roomId, sender.id, agent.id) >= pairLimit) {
      return {
        reason: "pair_limit",
        detail: `${sender.username} 今天已唤醒 ${agent.username} ${pairLimit} 次，达到上限。`,
      };
    }
    return undefined;
  }

  /**
   * Agent 经 MCP 发消息却没带 parentMessageId 时，若它正在执行调用，就用触发消息补上 parent。
   * hop / trace 预算只沿 parent 链累计，不能交给提示词规则自觉遵守——
   * 否则执行中省略 parent 就能从 hop 0 另起一条链，绕过防循环上限。
   * 合批时取传递深度最大的触发消息（同深度取最新），与 bridge 的 pickReplyParent 一致。
   */
  function inferExecutingParent(agent: Participant): ChatMessage | undefined {
    let best: ChatMessage | undefined;
    for (const invocation of database.listExecutingInvocations(agent.id)) {
      const trigger = database.getMessage(invocation.messageId);
      if (!trigger || trigger.roomId !== agent.roomId) continue;
      if (
        !best ||
        trigger.hopCount > best.hopCount ||
        (trigger.hopCount === best.hopCount && trigger.seq > best.seq)
      ) {
        best = trigger;
      }
    }
    return best;
  }

  /**
   * Agent 带 parentMessageId 的回复同时推进对应调用。
   * 返回 false 表示回复属于已被人停止的调用：消息照常展示，但不再据此唤醒其他 Agent。
   * parent 由服务端推断时（见 inferExecutingParent）只做防循环记账，不推进完成：
   * 执行中途的一条进度消息不代表这一轮结束，完成由 bridge 在轮末报告。
   */
  function completeFromReply(
    agent: Participant,
    reply: ChatMessage,
    options: { inferredParent?: boolean } = {},
  ): boolean {
    if (!reply.parentMessageId) return true;
    const invocation = database.getInvocationFor(reply.parentMessageId, agent.id);
    if (!invocation) return true;
    if (invocation.status === "cancelled") return false;
    if (options.inferredParent) return invocation.status !== "cancelling";
    if (isTerminal(invocation)) return true;
    const stopping = invocation.status === "cancelling";
    emitInvocation(
      database.updateInvocation(invocation.id, {
        status: stopping ? "cancelling" : "completed",
        replyMessageId: reply.id,
        ...(stopping ? {} : { finishedAt: new Date().toISOString() }),
        progress: null,
        detail: stopping
          ? "停止期间收到回复，仍等待执行结束确认；回复中的 @ 未再派发"
          : invocation.status === "timed_out"
            ? "迟到的结果"
            : null,
      }),
    );
    return !stopping;
  }

  function createAndDispatchMessage(
    participant: Participant,
    input: CreateMessageInput,
    options: { inferredParent?: boolean; delegateTo?: string; receipt?: boolean } = {},
  ) {
    const result = database.createMessage(participant, input);
    if (!result.created) return result;
    const message = result.message;
    broadcast(participant.roomId, { type: "message.created", message });
    broadcastRoomActivity(participant.roomId);
    // 回执由服务端代发，不是被委派方的回复：既不推进子任务，也不因子任务已停止而吞掉对委派方的 @
    if (
      participant.type === "agent" &&
      !options.receipt &&
      !completeFromReply(participant, message, options)
    ) {
      return result;
    }
    // Agent 在执行中发出的 @ 记下上游调用，任务概览才能画出真实的委派关系
    const parentInvocation =
      participant.type === "agent" && message.parentMessageId
        ? database.getInvocationFor(message.parentMessageId, participant.id)
        : undefined;
    for (const mention of message.mentions) {
      if (mention.toLocaleLowerCase() === "all") continue;
      const agent = database.findParticipant(participant.roomId, mention);
      if (!agent || agent.type !== "agent" || agent.id === participant.id) continue;
      const blocked = budgetBlock(participant, message, agent);
      const { invocation, created } = database.createInvocation({
        message,
        agent,
        status: blocked ? "blocked" : "queued",
        ...(blocked ? { blockReason: blocked.reason, detail: blocked.detail } : {}),
        ...(parentInvocation ? { parentInvocationId: parentInvocation.id } : {}),
        ...(options.delegateTo === agent.id ? { continuation: "pending" as const } : {}),
      });
      if (!created) continue;
      emitInvocation(invocation);
      if (!blocked) deliverMention(message, agent);
    }
    return result;
  }

  function invocationInRoom(participant: Participant, invocationId: string): Invocation {
    const invocation = database.getInvocation(invocationId);
    if (!invocation || invocation.roomId !== participant.roomId) {
      throw new HiveError("INVOCATION_NOT_FOUND", "Invocation not found in this room.");
    }
    return invocation;
  }

  function resetForRedelivery(invocation: Invocation, detail: string): Invocation {
    return database.updateInvocation(invocation.id, {
      status: "queued",
      attempts: invocation.attempts + 1,
      blockReason: null,
      detail,
      progress: null,
      runtime: null,
      replyMessageId: null,
      receivedAt: null,
      startedAt: null,
      finishedAt: null,
    });
  }

  function retryInvocation(actor: Participant, invocationId: string): void {
    const invocation = invocationInRoom(actor, invocationId);
    // 结果未知或停止未确认时，上一次执行可能仍在进行；此时重试会让同一任务并行跑两份
    if (invocation.status === "timed_out" || invocation.status === "cancelling") {
      throw new HiveError(
        "INVOCATION_NOT_RETRYABLE",
        "The previous run may still be in progress. Stop it and wait for the agent to confirm before retrying.",
      );
    }
    const retryable =
      invocation.status === "failed" ||
      invocation.status === "cancelled" ||
      (invocation.status === "blocked" && invocation.blockReason !== "hop_limit");
    if (!retryable) {
      throw new HiveError("INVOCATION_NOT_RETRYABLE", "This invocation cannot be retried now.");
    }
    const message = database.getMessage(invocation.messageId);
    const agent = database.getParticipant(invocation.agentId);
    if (!message || message.deletedAt || !agent) {
      throw new HiveError(
        "INVOCATION_NOT_RETRYABLE",
        "The trigger message is no longer available.",
      );
    }
    emitInvocation(resetForRedelivery(invocation, `${actor.username} 请求重试`));
    deliverMention(message, agent, true);
  }

  /**
   * 停止调用。尚未开始执行的直接给出终态；已开始的进入 cancelling，等 Agent 回报结束才算停下，
   * 期间不允许重试。状态落库，服务端重启或 Agent 断线后仍保持，Agent 重连时会再次收到停止请求。
   */
  function cancelInvocation(actor: Participant, invocationId: string): void {
    const invocation = invocationInRoom(actor, invocationId);
    if (isTerminal(invocation)) return;
    const target = onlineAgent(invocation.roomId, invocation.agentName);
    if (invocation.status !== "cancelling") {
      emitInvocation(
        database.updateInvocation(invocation.id, {
          status: "cancelling",
          detail: `${actor.username} 已请求停止，等待 ${invocation.agentName} 确认`,
          progress: null,
        }),
      );
    }
    // 重复点击停止时只重发请求，不改动状态
    if (target) send(target.socket, { type: "agent.cancel", messageId: invocation.messageId });
  }

  function extendBudget(actor: Participant, turns: number): void {
    const allowance = database.extendAgentTurns(actor.roomId, turns);
    const afterSeq = database.lastHumanMessageSeq(actor.roomId);
    for (const invocation of database.listBlockedInvocations(actor.roomId, afterSeq)) {
      const message = database.getMessage(invocation.messageId);
      const agent = database.getParticipant(invocation.agentId);
      if (!message || message.deletedAt || !agent) continue;
      emitInvocation(
        resetForRedelivery(invocation, `${actor.username} 追加了 ${turns} 轮（共 +${allowance}）`),
      );
      deliverMention(message, agent, true);
    }
  }

  function handleReport(
    agent: Participant,
    report: Extract<ClientEvent, { type: "invocation.report" }>,
  ): void {
    let invocation = database.getInvocationFor(report.messageId, agent.id);
    if (!invocation) {
      // 功能上线前的旧消息或补拉到的提及：仅为本房间、确实 @ 了该 Agent 的消息补建记录
      const message = database.getMessage(report.messageId);
      if (
        !message ||
        message.roomId !== agent.roomId ||
        !message.mentions.some(
          (mention) => mention.toLocaleLowerCase() === agent.username.toLocaleLowerCase(),
        )
      ) {
        return;
      }
      invocation = database.createInvocation({ message, agent, status: "queued" }).invocation;
    }
    if (report.contextSeq !== undefined) {
      inboxCursors.set(agent.id, Math.max(inboxCursors.get(agent.id) ?? 0, report.contextSeq));
    }
    const now = new Date().toISOString();
    if (report.status === "received") {
      if (invocation.status !== "queued" || invocation.receivedAt) return;
      emitInvocation(
        database.updateInvocation(invocation.id, { receivedAt: now, detail: "已送达，排队中" }),
      );
      return;
    }
    if (report.status === "uncertain") {
      if (isTerminal(invocation)) return;
      emitInvocation(
        database.updateInvocation(invocation.id, {
          status: invocation.status === "cancelling" ? "cancelling" : "timed_out",
          detail: report.detail ?? "执行结果未知，无法确认工具已停止；禁止自动重放。",
          progress: null,
        }),
      );
      return;
    }
    if (report.status === "running") {
      if (isTerminal(invocation)) return;
      // 停止未确认前的进度和心跳只更新运行观测，不把调用冲回 running
      if (invocation.status === "cancelling") {
        emitInvocation(
          database.updateInvocation(invocation.id, {
            runtime: observeRuntime(invocation.runtime, report.runtimeEvent, now),
          }),
        );
        return;
      }
      emitInvocation(
        database.updateInvocation(invocation.id, {
          status: "running",
          receivedAt: invocation.receivedAt ?? now,
          startedAt: invocation.startedAt ?? now,
          progress: report.progress ?? invocation.progress ?? null,
          runtime: observeRuntime(invocation.runtime, report.runtimeEvent, now),
          detail: report.detail ?? null,
        }),
      );
      return;
    }
    if (isTerminal(invocation)) return;
    emitInvocation(
      database.updateInvocation(invocation.id, {
        status: invocation.status === "cancelling" ? "cancelled" : report.status,
        finishedAt: now,
        progress: null,
        detail: report.detail ?? terminalDetail(invocation, report.status),
        ...(report.replyMessageId ? { replyMessageId: report.replyMessageId } : {}),
      }),
    );
  }

  function terminalDetail(invocation: Invocation, status: Invocation["status"]): string | null {
    if (invocation.status === "cancelling") {
      return status === "cancelled" ? `${invocation.agentName} 已确认停止` : "停止请求生效前已结束";
    }
    return invocation.status === "timed_out" ? "迟到的结果" : null;
  }

  function sweepStaleInvocations(): void {
    // 服务重启前没来得及发出、或因限流暂时失败的回执，在这里补发
    for (const invocation of database.listPendingContinuations())
      deliverContinuation(invocation.id);
    for (const invocation of database.listStaleInvocations(options.now?.() ?? Date.now())) {
      if (invocation.status === "running") {
        emitInvocation(
          database.updateInvocation(invocation.id, {
            status: "timed_out",
            detail: `超过 ${Math.round(LIMITS.invocationStaleMs / 60_000)} 分钟没有任何进展，结果未知`,
          }),
        );
        continue;
      }
      // 只有 Agent 在线却迟迟不确认才算异常；离线时排队等待它上线是正常的
      if (!onlineAgent(invocation.roomId, invocation.agentName)) continue;
      emitInvocation(
        database.updateInvocation(invocation.id, {
          status: "timed_out",
          detail: "Agent 在线但没有确认收到（可能是不支持回报状态的旧版 ai-hive）",
        }),
      );
    }
  }

  /**
   * Hive MCP 是无状态的，未读游标按 Agent 身份落库：放内存的话服务一重启就丢，
   * 下次调用会把游标重置到最新，重启前后那段消息 Agent 就再也收不到了
   */
  const inboxCursors = {
    get: (agentId: string) => database.getInboxCursor(agentId),
    set: (agentId: string, seq: number) => database.setInboxCursor(agentId, seq),
  };

  function takeInbox(agent: Participant): InboxDigest | undefined {
    const cursor = inboxCursors.get(agent.id);
    if (cursor === undefined) {
      inboxCursors.set(agent.id, database.latestSeq(agent.roomId));
      return undefined;
    }
    const fresh = database
      .getMessages(agent.roomId, cursor, 200)
      .filter((message) => !message.deletedAt && message.senderId !== agent.id);
    const latest = database.latestSeq(agent.roomId);
    if (fresh.length === 0) {
      inboxCursors.set(agent.id, Math.max(cursor, latest));
      return undefined;
    }
    const included = fresh.slice(0, 20);
    inboxCursors.set(agent.id, included.at(-1)!.seq);
    const name = agent.username.toLocaleLowerCase();
    return {
      messages: included.map((message) => ({
        seq: message.seq,
        id: message.id,
        sender: message.senderName,
        senderType: message.senderType,
        content:
          message.content.length > 500 ? `${message.content.slice(0, 500)}…` : message.content,
        mentionsYou: message.mentions.some((mention) => mention.toLocaleLowerCase() === name),
      })),
      remaining: fresh.length - included.length,
    };
  }

  /**
   * hive_invoke：以当前执行中的调用为上游发出委派消息，并为被委派方的调用登记待回执。
   * 委派消息不推进调用方自己的调用——它只是中间动作，最终答复仍由调用方给出。
   */
  function delegate(
    requester: Participant,
    input: { agent: string; task: string; clientMessageId: string },
  ) {
    const target = database.findParticipant(requester.roomId, input.agent.replace(/^@/, ""));
    if (!target || target.type !== "agent") {
      throw new HiveError("AGENT_NOT_FOUND", `房间里没有名为 ${input.agent} 的 Agent。`);
    }
    if (target.id === requester.id) {
      throw new HiveError("SELF_DELEGATION", "不能把子任务委派给自己。");
    }
    const parent = inferExecutingParent(requester);
    const parentInvocation = parent
      ? database.getInvocationFor(parent.id, requester.id)
      : undefined;
    if (parentInvocation) {
      const waiting = [parentInvocation, ...database.invocationAncestors(parentInvocation.id)].find(
        (invocation) => invocation.agentId === target.id && !isTerminal(invocation),
      );
      if (waiting) {
        throw new HiveError(
          "DELEGATION_CYCLE",
          `${target.username} 正在等待这条委派链的结果，再委派给它会相互等待；请直接在回复里给出结论。`,
        );
      }
    }
    const name = target.username.toLocaleLowerCase();
    const content = parseMentions(input.task).some(
      (mention) => mention.toLocaleLowerCase() === name,
    )
      ? input.task
      : `@${target.username} ${input.task}`;
    const { message } = createAndDispatchMessage(
      requester,
      {
        content,
        clientMessageId: input.clientMessageId,
        ...(parent ? { parentMessageId: parent.id } : {}),
        kind: "delegation",
      },
      { inferredParent: true, delegateTo: target.id },
    );
    const invocation = database.getInvocationFor(message.id, target.id);
    if (!invocation) {
      throw new HiveError("DELEGATION_FAILED", "委派消息已发出，但没有为对方建立调用记录。");
    }
    const connection = onlineAgent(requester.roomId, target.username);
    return {
      invocation,
      message,
      targetOnline: Boolean(connection),
      targetBusy: connection?.participant?.status === "busy",
    };
  }

  /**
   * hive_wait：轮询调用状态直到结束、被拦下或窗口用完。
   * 调用方亲自拿到了结果，就把回执标成已取走，避免同一结果再唤醒它一次。
   */
  async function waitForInvocation(
    caller: Participant,
    input: { invocationId: string; timeoutMs: number; signal: AbortSignal },
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + input.timeoutMs;
    const id = input.invocationId;
    activeWaits.set(id, (activeWaits.get(id) ?? 0) + 1);
    try {
      return await pollInvocation(caller, input, deadline);
    } finally {
      const remaining = (activeWaits.get(id) ?? 1) - 1;
      if (remaining > 0) activeWaits.set(id, remaining);
      else activeWaits.delete(id);
      // 等待中途被取消、或结束时没能取走结果：照常回执，不能让结果丢在半路
      if (remaining <= 0) deliverContinuation(id);
    }
  }

  async function pollInvocation(
    caller: Participant,
    input: { invocationId: string; signal: AbortSignal },
    deadline: number,
  ): Promise<Record<string, unknown>> {
    for (;;) {
      const invocation = database.getInvocation(input.invocationId);
      if (!invocation || invocation.roomId !== caller.roomId) {
        throw new HiveError("INVOCATION_NOT_FOUND", "当前房间没有这个调用。");
      }
      const summary = {
        invocationId: invocation.id,
        agent: invocation.agentName,
        status: invocation.status,
        ...(invocation.detail ? { detail: invocation.detail } : {}),
      };
      if (invocation.status === "blocked") {
        return {
          ...summary,
          done: false,
          needsHuman: true,
          ...(invocation.blockReason ? { blockReason: invocation.blockReason } : {}),
          note: "子任务被预算拦下，需要人在页面上点「继续」；放行后结果仍会回执给你。不要换个方式绕开。",
        };
      }
      if (CONTINUATION_READY_STATUSES.includes(invocation.status)) {
        if (
          invocation.requesterId === caller.id &&
          database.claimContinuation(invocation.id, "consumed")
        ) {
          emitInvocation(database.getInvocation(invocation.id)!);
        }
        const reply = invocation.replyMessageId
          ? database.getMessage(invocation.replyMessageId)
          : undefined;
        return {
          ...summary,
          done: true,
          ...(invocation.status === "timed_out"
            ? { note: "结果未知：子任务超时没有进展，不代表失败。" }
            : {}),
          ...(reply && !reply.deletedAt
            ? { reply: { seq: reply.seq, id: reply.id, content: reply.content } }
            : {}),
        };
      }
      if (Date.now() >= deadline || input.signal.aborted) {
        return {
          ...summary,
          done: false,
          note: "等待窗口已用完，子任务仍在进行；这不是失败，结束后会自动回执给你。",
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  app.get("/health", async () => ({
    status: "ok",
    ...(options.instanceId ? { instanceId: options.instanceId } : {}),
  }));
  app.get("/agent.md", async (_request, reply) => {
    return reply.type("text/markdown; charset=utf-8").send(AGENT_INSTRUCTIONS);
  });
  app.get("/api/meta", async (request) => {
    const httpUrl = requestPublicUrl(request, options.publicUrl);
    const wsUrl = httpUrl.replace(/^http/, "ws") + "/ws";
    const agentCommandPrefix = options.agentCommandPrefix ?? "npx --yes ai-hive@latest";
    return {
      name: "AI Hive",
      roomId: "general",
      httpUrl,
      wsUrl,
      mcpUrl: `${httpUrl}/mcp`,
      joinToken,
      agentCommand: `${agentCommandPrefix} join --server ${httpUrl} --name my-agent --token ${joinToken}`,
    };
  });

  function authorized(request: { headers: { authorization?: string | undefined } }): boolean {
    return request.headers.authorization === `Bearer ${joinToken}`;
  }

  function connectedMcpAgent(request: {
    headers: Record<string, string | string[] | undefined>;
  }): Participant | undefined {
    if (!authorized(request)) return undefined;
    const roomId = headerString(request.headers["x-hive-room"]);
    const username = headerString(request.headers["x-hive-agent-name"]);
    if (!roomId || !username) return undefined;
    const connection = onlineAgent(roomId, username);
    return connection?.participant?.type === "agent" ? connection.participant : undefined;
  }

  app.post("/mcp", async (request, reply) => {
    const participant = connectedMcpAgent(request);
    if (!participant) {
      return reply.code(401).send({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message:
            "Hive MCP requires a valid Bearer token and an online Agent identity in X-Hive-Room / X-Hive-Agent-Name.",
        },
        id: null,
      });
    }
    const mcpServer = createHiveMcpServer({
      roomId: participant.roomId,
      username: participant.username,
      // 只读当前话题：开启新话题或清空房间后，之前的消息不再作为 Agent 的上下文
      readMessages: (afterSeq, limit) => ({
        messages: database
          .getMessages(
            participant.roomId,
            Math.max(afterSeq, database.currentTopicSeq(participant.roomId) - 1),
            limit,
          )
          .filter((message) => !message.deletedAt),
        latestSeq: database.latestSeq(participant.roomId),
      }),
      listMembers: () => database.listParticipants(participant.roomId),
      sendMessage: (input) => {
        if (input.parentMessageId) return createAndDispatchMessage(participant, input).message;
        const parent = inferExecutingParent(participant);
        return createAndDispatchMessage(
          participant,
          parent ? { ...input, parentMessageId: parent.id } : input,
          { inferredParent: Boolean(parent) },
        ).message;
      },
      readWhiteboard: () => database.listWhiteboard(participant.roomId),
      updateWhiteboard: (input) => {
        const result = database.upsertWhiteboardEntry(participant, input);
        if (result.changed) {
          broadcast(participant.roomId, { type: "whiteboard.updated", entry: result.entry });
          for (const entryId of result.evicted) {
            broadcast(participant.roomId, {
              type: "whiteboard.removed",
              roomId: participant.roomId,
              entryId,
            });
          }
        }
        return { entry: result.entry, changed: result.changed };
      },
      takeInbox: () => takeInbox(participant),
      markRead: (seq) =>
        inboxCursors.set(participant.id, Math.max(inboxCursors.get(participant.id) ?? 0, seq)),
      invoke: (input) => delegate(participant, input),
      wait: (input) => waitForInvocation(participant, input),
    });
    const transport = new StreamableHTTPServerTransport();
    try {
      await mcpServer.connect(transport as unknown as Transport);
      reply.hijack();
      await transport.handleRequest(request.raw, reply.raw, request.body);
      reply.raw.on("close", () => {
        void transport.close();
        void mcpServer.close();
      });
      return reply;
    } catch (error) {
      await transport.close().catch(() => undefined);
      await mcpServer.close().catch(() => undefined);
      if (!reply.raw.headersSent) {
        return reply.code(500).send({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : "Hive MCP request failed.",
          },
          id: null,
        });
      }
      request.log.error(error);
      return reply;
    }
  });

  for (const method of ["GET", "DELETE"] as const) {
    app.route({
      method,
      url: "/mcp",
      handler: async (_request, reply) =>
        reply.code(405).send({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed in stateless MCP mode." },
          id: null,
        }),
    });
  }

  app.get<{
    Params: { roomId: string };
    Querystring: { afterSeq?: string; limit?: string };
  }>("/api/rooms/:roomId/messages", async (request, reply) => {
    const params = roomParamsSchema.safeParse(request.params);
    const query = messagesQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(400).send({ error: "Invalid room or query parameters." });
    }
    if (!authorized(request)) return reply.code(401).send({ error: "Unauthorized" });
    return {
      messages: database.getMessages(params.data.roomId, query.data.afterSeq, query.data.limit),
      latestSeq: database.latestSeq(params.data.roomId),
    };
  });

  app.get<{ Querystring: { q?: string; limit?: string } }>(
    "/api/search",
    async (request, reply) => {
      const query = searchQuerySchema.safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: "Invalid search query." });
      if (!authorized(request)) return reply.code(401).send({ error: "Unauthorized" });
      return { messages: database.searchMessages(query.data.q, query.data.limit) };
    },
  );

  app.get<{ Querystring: { username?: string; limit?: string } }>(
    "/api/mentions",
    async (request, reply) => {
      const query = mentionsQuerySchema.safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: "Invalid mentions query." });
      if (!authorized(request)) return reply.code(401).send({ error: "Unauthorized" });
      return { messages: database.listMentions(query.data.username, query.data.limit) };
    },
  );

  app.get("/api/invocations", async (request, reply) => {
    if (!authorized(request)) return reply.code(401).send({ error: "Unauthorized" });
    const invocations = database.listActiveInvocations();
    // 附带触发消息，任务列表无需逐条再查
    const messages = invocations
      .map((invocation) => database.getMessage(invocation.messageId))
      .filter((message): message is ChatMessage => Boolean(message && !message.deletedAt));
    // 列表需要区分"排队中"与"等待上线"，附带各调用目标 Agent 当前是否在线
    const onlineInvocationIds = invocations
      .filter((invocation) => onlineAgent(invocation.roomId, invocation.agentName))
      .map((invocation) => invocation.id);
    return { invocations, messages, onlineInvocationIds };
  });

  app.get<{ Params: { roomId: string } }>(
    "/api/rooms/:roomId/whiteboard",
    async (request, reply) => {
      const params = roomParamsSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "Invalid room parameter." });
      if (!authorized(request)) return reply.code(401).send({ error: "Unauthorized" });
      return { entries: database.listWhiteboard(params.data.roomId) };
    },
  );

  app.get<{ Params: { roomId: string } }>(
    "/api/rooms/:roomId/invocations",
    async (request, reply) => {
      const params = roomParamsSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "Invalid room parameter." });
      if (!authorized(request)) return reply.code(401).send({ error: "Unauthorized" });
      return { invocations: database.listInvocations(params.data.roomId) };
    },
  );

  app.get<{ Params: { roomId: string } }>(
    "/api/rooms/:roomId/participants",
    async (request, reply) => {
      const params = roomParamsSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "Invalid room parameter." });
      if (!authorized(request)) return reply.code(401).send({ error: "Unauthorized" });
      return { participants: database.listParticipants(params.data.roomId) };
    },
  );

  app.get<{ Querystring: { includeArchived?: string } }>("/api/rooms", async (request, reply) => {
    const query = roomsQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "Invalid query parameters." });
    if (!authorized(request)) return reply.code(401).send({ error: "Unauthorized" });
    return { rooms: database.listRooms(query.data.includeArchived) };
  });

  app.post("/api/rooms", async (request, reply) => {
    if (!authorized(request)) return reply.code(401).send({ error: "Unauthorized" });
    const body = createRoomRequestSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid room payload." });
    try {
      const room = database.createRoom(body.data);
      broadcastAll({ type: "rooms.changed", room });
      return reply.code(201).send({ room });
    } catch (error) {
      if (error instanceof HiveError && error.code === "ROOM_EXISTS") {
        return reply.code(409).send({ error: error.message, code: error.code });
      }
      throw error;
    }
  });

  app.patch<{ Params: { roomId: string } }>("/api/rooms/:roomId", async (request, reply) => {
    const params = roomParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid room parameter." });
    if (!authorized(request)) return reply.code(401).send({ error: "Unauthorized" });
    const body = updateRoomRequestSchema.safeParse(request.body);
    if (!body.success || (body.data.name === undefined && body.data.archived === undefined)) {
      return reply.code(400).send({ error: "Invalid room patch payload." });
    }
    try {
      const room = database.updateRoom(params.data.roomId, body.data);
      broadcastAll({ type: "rooms.changed", room });
      return { room };
    } catch (error) {
      if (error instanceof HiveError && error.code === "ROOM_NOT_FOUND") {
        return reply.code(404).send({ error: error.message, code: error.code });
      }
      if (error instanceof HiveError && error.code === "ROOM_PROTECTED") {
        return reply.code(400).send({ error: error.message, code: error.code });
      }
      throw error;
    }
  });

  if (!hasWebUi) {
    app.get("/", async (_request, reply) => {
      return reply
        .type("text/html; charset=utf-8")
        .send("<h1>AI Hive server is running</h1><p>Run <code>pnpm dev</code> for the Web UI.</p>");
    });
  }

  app.get("/ws", { websocket: true }, (socket) => {
    const connection: Connection = { socket, lastHeartbeat: Date.now() };
    connections.add(connection);

    socket.on("message", (raw) => {
      let json: unknown;
      try {
        json = JSON.parse(raw.toString());
      } catch {
        send(socket, { type: "error", code: "INVALID_JSON", message: "Invalid JSON payload." });
        return;
      }
      const parsed = clientEventSchema.safeParse(json);
      if (!parsed.success) {
        const messageTooLong = parsed.error.issues.some(
          (issue) => issue.code === "too_big" && issue.path.join(".") === "content",
        );
        send(socket, {
          type: "error",
          code: messageTooLong ? "MESSAGE_TOO_LONG" : "INVALID_EVENT",
          message: messageTooLong
            ? `消息超过 ${LIMITS.maxMessageLength} 字符保护上限，请缩短正文或拆分发送。`
            : "Invalid client event.",
        });
        return;
      }
      const event = parsed.data;

      if (event.type === "participant.join") {
        if (connection.participant) {
          send(socket, { type: "error", code: "ALREADY_JOINED", message: "Already joined." });
          return;
        }
        if (event.token !== joinToken) {
          send(socket, { type: "error", code: "UNAUTHORIZED", message: "Invalid join token." });
          socket.close(1008, "Unauthorized");
          return;
        }
        if (!/^[\p{L}\p{N}_.-]+$/u.test(event.username) || !/^[A-Za-z0-9_-]+$/.test(event.roomId)) {
          send(socket, {
            type: "error",
            code: "INVALID_NAME",
            message: "Names may contain letters, numbers, dots, underscores, and hyphens.",
          });
          return;
        }
        const { room, created: roomCreated } = database.ensureRoom(event.roomId, event.username);
        if (room.archivedAt) {
          send(socket, {
            type: "error",
            code: "ROOM_ARCHIVED",
            message: "This room is archived and no longer accepts new participants.",
          });
          socket.close(1008, "Room archived");
          return;
        }
        if (roomCreated) broadcastAll({ type: "rooms.changed", room });
        const key = participantKey(event.roomId, event.username);
        const namedConnections = onlineByName.get(key);
        const existingConnection = namedConnections?.values().next().value;
        const existingParticipant = existingConnection?.participant;
        if (
          existingParticipant &&
          (event.participantType !== "human" || existingParticipant.type !== "human")
        ) {
          send(socket, {
            type: "error",
            code: "USERNAME_TAKEN",
            message: "This username is already online in the room.",
          });
          return;
        }
        try {
          const participant =
            existingParticipant ??
            database.upsertParticipant({
              roomId: event.roomId,
              username: event.username,
              type: event.participantType,
              ...(event.persona ? { persona: event.persona } : {}),
              ...(event.provider ? { provider: event.provider } : {}),
            });
          connection.participant = participant;
          connection.lastHeartbeat = Date.now();
          const activeConnections = namedConnections ?? new Set<Connection>();
          activeConnections.add(connection);
          onlineByName.set(key, activeConnections);
          send(socket, {
            type: "room.snapshot",
            self: participant,
            participants: database.listParticipants(event.roomId),
            messages: database.getRecentMessages(event.roomId),
            latestSeq: database.latestSeq(event.roomId),
            invocations: database.listInvocations(event.roomId),
            whiteboard: database.listWhiteboard(event.roomId),
          });
          if (participant.type === "agent") {
            for (const invocation of database.listCancellingInvocations(participant.id)) {
              send(socket, { type: "agent.cancel", messageId: invocation.messageId });
            }
          }
          if (!existingParticipant) {
            broadcast(event.roomId, { type: "presence.changed", participant });
            broadcastRoomActivity(event.roomId);
          }
        } catch (error) {
          const hiveError = error instanceof HiveError ? error : undefined;
          send(socket, {
            type: "error",
            code: hiveError?.code ?? "JOIN_FAILED",
            message: hiveError?.message ?? "Could not join the room.",
          });
        }
        return;
      }

      const participant = connection.participant;
      if (!participant) {
        send(socket, { type: "error", code: "NOT_JOINED", message: "Join the room first." });
        return;
      }

      if (event.type === "presence.heartbeat") {
        connection.lastHeartbeat = Date.now();
        if (connection.participant?.status === "offline") setStatus(connection, "online");
        return;
      }
      if (event.type === "agent.typing") {
        if (participant.type === "agent") setStatus(connection, event.active ? "busy" : "online");
        return;
      }
      if (event.type === "message.ack") return;
      if (
        event.type === "invocation.report" ||
        event.type === "invocation.retry" ||
        event.type === "invocation.cancel" ||
        event.type === "budget.extend" ||
        event.type === "whiteboard.remove"
      ) {
        try {
          if (event.type === "invocation.report") {
            if (participant.type !== "agent") {
              throw new HiveError("FORBIDDEN", "Only agents report invocation progress.");
            }
            handleReport(participant, event);
            return;
          }
          if (participant.type !== "human") {
            throw new HiveError("FORBIDDEN", "Only humans can manage invocations.");
          }
          if (event.type === "invocation.retry") retryInvocation(participant, event.invocationId);
          else if (event.type === "invocation.cancel") {
            cancelInvocation(participant, event.invocationId);
          } else if (event.type === "budget.extend") extendBudget(participant, event.turns);
          else if (database.removeWhiteboardEntry(participant.roomId, event.entryId)) {
            broadcast(participant.roomId, {
              type: "whiteboard.removed",
              roomId: participant.roomId,
              entryId: event.entryId,
            });
          }
        } catch (error) {
          const hiveError = error instanceof HiveError ? error : undefined;
          send(socket, {
            type: "error",
            code: hiveError?.code ?? "REQUEST_FAILED",
            message: hiveError?.message ?? "Could not handle the request.",
          });
        }
        return;
      }
      if (event.type === "topic.start") {
        // 只有人能开启新话题；Agent 不能借此清掉其他 Agent 的上下文
        if (participant.type !== "human") {
          send(socket, {
            type: "error",
            code: "TOPIC_FORBIDDEN",
            message: "Only humans can start a new topic.",
          });
          return;
        }
        createAndDispatchMessage(participant, {
          content: `${participant.username} 开启了新话题`,
          clientMessageId: `topic-${randomUUID()}`,
          kind: "topic",
        });
        return;
      }
      if (event.type === "message.delete") {
        try {
          const message = database.deleteMessage(participant, event.messageId);
          broadcast(participant.roomId, { type: "message.deleted", message });
        } catch (error) {
          const hiveError = error instanceof HiveError ? error : undefined;
          send(socket, {
            type: "error",
            code: hiveError?.code ?? "DELETE_FAILED",
            message: hiveError?.message ?? "Could not recall the message.",
          });
        }
        return;
      }

      try {
        const result = createAndDispatchMessage(participant, {
          content: event.content,
          clientMessageId: event.clientMessageId,
          ...(event.replyToMessageId ? { replyToMessageId: event.replyToMessageId } : {}),
          ...(event.parentMessageId ? { parentMessageId: event.parentMessageId } : {}),
        });
        if (!result.created) {
          send(socket, { type: "message.created", message: result.message });
          return;
        }
      } catch (error) {
        const hiveError = error instanceof HiveError ? error : undefined;
        send(socket, {
          type: "error",
          code: hiveError?.code ?? "MESSAGE_FAILED",
          message: hiveError?.message ?? "Could not send the message.",
        });
      }
    });

    socket.on("close", () => disconnect(connection));
    socket.on("error", () => disconnect(connection));
  });

  const heartbeatTimer = setInterval(
    () => {
      const now = Date.now();
      for (const connection of connections) {
        if (connection.participant && now - connection.lastHeartbeat > heartbeatTimeoutMs) {
          connection.socket.close(1001, "Heartbeat timeout");
          disconnect(connection);
        }
      }
    },
    Math.min(15_000, Math.max(1_000, heartbeatTimeoutMs / 3)),
  );
  heartbeatTimer.unref();
  const invocationTimer = setInterval(sweepStaleInvocations, options.invocationSweepMs ?? 30_000);
  invocationTimer.unref();

  app.addHook("onReady", async () => {
    localAgents?.start();
    for (const invocation of database.listPendingContinuations())
      deliverContinuation(invocation.id);
  });

  app.addHook("onClose", async () => {
    shuttingDown = true;
    // 先让本机 Agent 正常离线，再关闭连接与数据库
    await localAgents?.shutdown();
    clearInterval(heartbeatTimer);
    clearInterval(invocationTimer);
    for (const connection of connections) {
      if (connection.participant)
        database.setParticipantStatus(connection.participant.id, "offline");
      connection.socket.close(1001, "Server shutting down");
    }
    connections.clear();
    onlineByName.clear();
    database.close();
  });

  return app;
}
