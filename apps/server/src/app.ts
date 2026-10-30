import { observeRuntime } from "./runtime-observation.js";
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdtempSync } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
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
  createGuestAgentRequestSchema,
  createInviteRequestSchema,
  redeemInviteRequestSchema,
  renewAccessRequestSchema,
  startImLoginRequestSchema,
  submitImLoginCodeRequestSchema,
  type ImChannel,
  type ChatMessage,
  type ClientEvent,
  type Invocation,
  type InvocationBlockReason,
  type Participant,
  type ServerEvent,
} from "@ai-hive/protocol";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
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
import { createHiveMcpServer, type AttachmentReadResult, type InboxDigest } from "./hive-mcp.js";
import { LocalAgentSupervisor, type LocalAgentSupervisorOptions } from "./local-agents.js";
import { registerLocalAgentRoutes } from "./local-routes.js";
import { checkLocalRequest } from "./local-access.js";
import {
  AccessStore,
  expiresAtFrom,
  isGuestToken,
  type AccessSession,
  type ResolvedSession,
} from "./access-store.js";
import { AttachmentStore, publicAttachment, type StoredAttachment } from "./attachment-store.js";
import { ImHub } from "./im/im-hub.js";
import { ImStore } from "./im/im-store.js";
import { SecretBox } from "./im/secret-box.js";
import type { ImChannelDriver } from "./im/types.js";

/**
 * admin：持有共享 join token 的房主与其 Agent（房主页面只在 Server 所在电脑上拿到它）；
 * guest：凭限时邀请进入的访客或访客带入的 Agent，只能访问一个房间，到期或被移除即失效。
 */
type Principal = { kind: "admin" } | { kind: "guest"; resolved: ResolvedSession };

type Connection = {
  socket: WebSocket;
  participant?: Participant;
  principal?: Principal;
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
  /** 检查访客会话到期的间隔；测试可调小 */
  accessSweepMs?: number;
  staticDir?: string;
  /**
   * 外部 IM 渠道（飞书、个人微信）的驱动；省略即不提供「连接 IM」（测试默认关闭），由 index.ts 注入。
   */
  imDrivers?: Partial<Record<ImChannel, ImChannelDriver>>;
  /** IM 凭据加密密钥文件；省略时用进程内随机密钥（重启后已保存的连接需要重新扫码） */
  imKeyPath?: string;
  /** 附件文件目录；省略时放在数据库旁的 attachments/（内存数据库用临时目录） */
  attachmentsDir?: string;
  /** 每个房间附件总量、每个上传者未发送暂存量（字节）；省略用 LIMITS 里的默认值 */
  roomAttachmentQuotaBytes?: number;
  pendingAttachmentQuotaBytes?: number;
  /** 清理过期上传与无引用文件的间隔；测试可调小 */
  attachmentSweepMs?: number;
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
  const access = new AccessStore(database.connection());
  const imStore = new ImStore(database.connection(), SecretBox.open(options.imKeyPath));
  const clock = () => options.now?.() ?? Date.now();
  const databasePath = options.databasePath ?? "./data/hive.sqlite";
  const attachments = new AttachmentStore(database.connection(), {
    dir:
      options.attachmentsDir ??
      (databasePath === ":memory:"
        ? mkdtempSync(path.join(tmpdir(), "hive-attachments-"))
        : path.join(path.dirname(databasePath), "attachments")),
    ...(options.roomAttachmentQuotaBytes !== undefined
      ? { roomQuotaBytes: options.roomAttachmentQuotaBytes }
      : {}),
    ...(options.pendingAttachmentQuotaBytes !== undefined
      ? { pendingQuotaBytes: options.pendingAttachmentQuotaBytes }
      : {}),
    now: clock,
  });
  const connections = new Set<Connection>();
  const onlineByName = new Map<string, Set<Connection>>();
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 45_000;
  let shuttingDown = false;

  await app.register(cors, { origin: true });
  await app.register(websocket, { options: { maxPayload: LIMITS.maxClientPayloadBytes } });
  // 附件走 multipart 流式上传，写盘时边收边算摘要；不经 JSON，也不进 bodyLimit
  await app.register(multipart, {
    limits: { files: 1, fields: 0, parts: 1, fileSize: LIMITS.maxAttachmentBytes },
  });

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

  /** 跨房间事件涉及的房间；访客只能收到自己房间的 */
  function eventRoomId(event: ServerEvent): string | undefined {
    if (event.type === "invocation.updated") return event.invocation.roomId;
    if (event.type === "rooms.changed") return event.room.id;
    if (event.type === "room.activity") return event.roomId;
    return undefined;
  }

  function broadcastAll(event: ServerEvent): void {
    const roomId = eventRoomId(event);
    for (const connection of connections) {
      if (!connection.participant) continue;
      if (
        connection.principal?.kind === "guest" &&
        connection.principal.resolved.session.roomId !== roomId
      ) {
        continue;
      }
      send(connection.socket, event);
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
    broadcast(participant.roomId, {
      type: "presence.changed",
      participant: withAccess(participant),
    });
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

  /* ---------- 访问控制：房主（join token）与限时访客 ---------- */

  function principalForToken(token: string | undefined): Principal | undefined {
    if (!token) return undefined;
    if (token === joinToken) return { kind: "admin" };
    if (!isGuestToken(token)) return undefined;
    const resolved = access.resolveToken(token, clock());
    return resolved?.state === "active" ? { kind: "guest", resolved } : undefined;
  }

  function bearerToken(request: { headers: { authorization?: string | undefined } }) {
    const header = request.headers.authorization;
    return header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  }

  function requestPrincipal(request: { headers: { authorization?: string | undefined } }) {
    return principalForToken(bearerToken(request));
  }

  function canAccessRoom(principal: Principal, roomId: string): boolean {
    return principal.kind === "admin" || principal.resolved.session.roomId === roomId;
  }

  /** 没有凭证 401；凭证有效但不属于这个房间 403。返回 undefined 时已经回复了错误 */
  function guard(
    request: { headers: { authorization?: string | undefined } },
    reply: { code: (status: number) => { send: (body: unknown) => unknown } },
    roomId?: string,
  ): Principal | undefined {
    const principal = requestPrincipal(request);
    if (!principal) {
      reply.code(401).send({ error: "Unauthorized", code: "UNAUTHORIZED" });
      return undefined;
    }
    if (roomId !== undefined && !canAccessRoom(principal, roomId)) {
      reply.code(403).send({ error: "这个凭证不能访问该房间。", code: "ROOM_FORBIDDEN" });
      return undefined;
    }
    return principal;
  }

  function adminOnly(
    request: { headers: { authorization?: string | undefined } },
    reply: { code: (status: number) => { send: (body: unknown) => unknown } },
  ): boolean {
    const principal = guard(request, reply);
    if (!principal) return false;
    if (principal.kind !== "admin") {
      reply.code(403).send({ error: "只有房主可以执行这个操作。", code: "OWNER_ONLY" });
      return false;
    }
    return true;
  }

  /** 成员最近的访客会话（同类型）；房主与本机 Agent 没有 */
  function guestSessionOf(participant: Pick<Participant, "roomId" | "username" | "type">) {
    const session = access.latestSessionFor(participant.roomId, participant.username);
    return session && session.kind === participant.type
      ? access.resolve(session, clock())
      : undefined;
  }

  /** 成员信息附上访客期限，成员列表据此显示剩余时间 */
  function withAccess(participant: Participant): Participant {
    const resolved = guestSessionOf(participant);
    if (!resolved) return participant;
    return {
      ...participant,
      access: {
        kind: "guest",
        sessionId: resolved.session.id,
        expiresAt: resolved.expiresAt,
        ...(resolved.sponsor ? { sponsorName: resolved.sponsor.username } : {}),
        ...(resolved.state !== "active" ? { ended: true } : {}),
        ...(resolved.state === "revoked" ? { revoked: true } : {}),
      },
    };
  }

  /** 到期或被移除的访客留在离线列表里（带「已到期」标记），房主可续期，访客下次也可能再加入 */
  function participantsOf(roomId: string): Participant[] {
    return database.listParticipants(roomId).map(withAccess);
  }

  const endedMessages = {
    expired: { code: "SESSION_EXPIRED", message: "你的访问期限已到，请联系房主续期或重新邀请。" },
    revoked: { code: "SESSION_REVOKED", message: "房主已把你移出这个房间。" },
  } as const;

  /** 断开访客会话（及其带入的 Agent）的所有连接，并刷新成员列表里的期限 */
  function endSessionConnections(sessionIds: string[], reason: "expired" | "revoked"): void {
    const ids = new Set(sessionIds);
    for (const connection of [...connections]) {
      if (connection.principal?.kind !== "guest") continue;
      if (!ids.has(connection.principal.resolved.session.id)) continue;
      send(connection.socket, { type: "error", ...endedMessages[reason] });
      connection.socket.close(4401, reason);
      disconnect(connection);
    }
  }

  /** 访客或其 Agent 的期限变化后，推送最新的成员信息 */
  function refreshAccessPresence(sessionIds: string[]): void {
    for (const id of sessionIds) {
      const session = access.getSession(id);
      if (!session) continue;
      const participant = database.findParticipant(session.roomId, session.username);
      if (participant) {
        broadcast(session.roomId, {
          type: "presence.changed",
          participant: withAccess(participant),
        });
      }
    }
  }

  /** 连接上的访客会话是否仍有效；失效时断开并返回 false */
  function ensureActive(connection: Connection): boolean {
    if (connection.principal?.kind !== "guest") return true;
    const current = access.getSession(connection.principal.resolved.session.id);
    const resolved = current ? access.resolve(current, clock()) : undefined;
    if (resolved?.state === "active") {
      connection.principal = { kind: "guest", resolved };
      return true;
    }
    const reason = resolved?.state === "expired" ? "expired" : "revoked";
    send(connection.socket, { type: "error", ...endedMessages[reason] });
    connection.socket.close(4401, reason);
    disconnect(connection);
    return false;
  }

  function sweepExpiredAccess(): void {
    const expired = new Set<string>();
    for (const connection of [...connections]) {
      if (connection.principal?.kind !== "guest") continue;
      const id = connection.principal.resolved.session.id;
      if (!ensureActive(connection)) expired.add(id);
    }
    if (expired.size) refreshAccessPresence([...expired]);
  }

  /** 兑换邀请时：同名的有效成员不能被顶替；曾经的访客到期或被移除后，可以用同名重新加入 */
  function isNameTaken(roomId: string, username: string): boolean {
    // 同一链接多人共用：已兑换但还没连上的访客也占着名字
    const pending = access.latestSessionFor(roomId, username);
    if (pending && access.resolve(pending, clock()).state === "active") return true;
    const existing = database.findParticipant(roomId, username);
    if (!existing) return false;
    const resolved = guestSessionOf(existing);
    return !(existing.type === "human" && resolved && resolved.state !== "active");
  }

  function sessionView(resolved: ResolvedSession) {
    return {
      role: "guest" as const,
      kind: resolved.session.kind,
      sessionId: resolved.session.id,
      roomId: resolved.session.roomId,
      username: resolved.session.username,
      expiresAt: resolved.expiresAt,
      allowAgents: resolved.allowAgents,
    };
  }

  function guestAgentCommand(
    request: Parameters<typeof requestPublicUrl>[0],
    session: AccessSession,
    token: string,
  ) {
    const prefix = options.agentCommandPrefix ?? "npx --yes ai-hive@latest";
    return `${prefix} join --server ${requestPublicUrl(request, options.publicUrl)} --room ${session.roomId} --name ${session.username} --token ${token}`;
  }

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
    // 提过问的调用等人回答才算结束；这一轮的回复只记下来，不把它推进到完成
    if (invocation.status === "waiting_human") {
      emitInvocation(database.updateInvocation(invocation.id, { replyMessageId: reply.id }));
      return true;
    }
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
    imHub.onMessageCreated(message);
    // 回执由服务端代发，不是被委派方的回复：既不推进子任务，也不因子任务已停止而吞掉对委派方的 @
    if (
      participant.type === "agent" &&
      !options.receipt &&
      !completeFromReply(participant, message, options)
    ) {
      return result;
    }
    // 人回复了 Agent 的提问：结束等待中的调用，并用这条回答重新唤醒提问的 Agent（不必再 @ 它）
    const answered = participant.type === "human" ? answeredQuestion(message) : undefined;
    const targets = [...message.mentions];
    if (
      answered &&
      !targets.some((name) => name.toLocaleLowerCase() === answered.agentName.toLocaleLowerCase())
    ) {
      targets.push(answered.agentName);
    }
    // Agent 在执行中发出的 @ 记下上游调用，任务概览才能画出真实的委派关系
    const parentInvocation =
      participant.type === "agent" && message.parentMessageId
        ? database.getInvocationFor(message.parentMessageId, participant.id)
        : undefined;
    // 访客（及其 Agent）发出的 @：房主的 Agent 可能有本机完全权限，未获授权时等房主批准
    const senderGuest = options.receipt ? undefined : guestSessionOf(participant);
    for (const mention of targets) {
      if (mention.toLocaleLowerCase() === "all") continue;
      const agent = database.findParticipant(participant.roomId, mention);
      if (!agent || agent.type !== "agent" || agent.id === participant.id) continue;
      const needsApproval =
        senderGuest &&
        !senderGuest.allowAgents &&
        !guestSessionOf(agent) &&
        !(answered && answered.agentId === agent.id);
      const blocked = needsApproval
        ? {
            reason: "guest_approval" as const,
            detail: `${participant.username} 是访客，@ 房主的 Agent 需要房主批准后才会派发。`,
          }
        : budgetBlock(participant, message, agent);
      const { invocation: createdInvocation, created } = database.createInvocation({
        message,
        agent,
        status: blocked ? "blocked" : "queued",
        ...(blocked ? { blockReason: blocked.reason, detail: blocked.detail } : {}),
        ...(parentInvocation ? { parentInvocationId: parentInvocation.id } : {}),
        ...(options.delegateTo === agent.id ? { continuation: "pending" as const } : {}),
      });
      if (!created) continue;
      let invocation = createdInvocation;
      if (answered && answered.agentId === agent.id) {
        if (database.adoptContinuation(answered.id, invocation.id)) {
          invocation = database.getInvocation(invocation.id)!;
        }
        emitInvocation(
          database.updateInvocation(answered.id, {
            status: "completed",
            finishedAt: answered.finishedAt ?? new Date().toISOString(),
            progress: null,
            detail: `${participant.username} 已回答（#${message.seq}），已续到新的调用`,
          }),
        );
      }
      emitInvocation(invocation);
      if (!blocked) deliverMention(message, agent);
    }
    return result;
  }

  /** 这条消息回复的是 Agent 的提问且该调用仍在等人回答时，返回那个等待中的调用 */
  function answeredQuestion(message: ChatMessage): Invocation | undefined {
    if (!message.replyToMessageId) return undefined;
    const invocation = waitingForQuestion(message.replyToMessageId);
    return invocation && invocation.roomId === message.roomId ? invocation : undefined;
  }

  function waitingForQuestion(questionId: string): Invocation | undefined {
    const question = database.getMessage(questionId);
    if (
      !question ||
      question.kind !== "question" ||
      question.deletedAt ||
      !question.parentMessageId
    ) {
      return undefined;
    }
    const invocation = database.getInvocationFor(question.parentMessageId, question.senderId);
    return invocation?.status === "waiting_human" ? invocation : undefined;
  }

  /**
   * 网页点选回答：按提问里保存的题目校验所选，生成完整正文（带选项原文，历史被裁剪也看得懂），
   * 再作为对提问的回复走普通的回答续接。同一 clientMessageId 的重试直接返回已发出的答案；
   * 提问已被回答（另一个标签页、手打回复）后再点选会被拒绝，保证只续接一次。
   */
  function submitAnswer(
    human: Participant,
    input: Extract<ClientEvent, { type: "question.answer" }>,
  ): { message: ChatMessage; created: boolean } {
    const existing = database.findMessageByClientId(human.id, input.clientMessageId);
    if (existing) return { message: existing, created: false };
    const question = database.getMessage(input.questionMessageId);
    if (
      !question ||
      question.roomId !== human.roomId ||
      question.kind !== "question" ||
      question.deletedAt ||
      !question.question
    ) {
      throw new HiveError("QUESTION_NOT_FOUND", "这条提问不存在或没有可选项。");
    }
    if (!waitingForQuestion(question.id)) {
      throw new HiveError("QUESTION_CLOSED", "这个提问已经回答过或已停止等待。");
    }
    const spec = question.question;
    const selected = [...new Set(input.selected)];
    if (selected.length !== input.selected.length) {
      throw new HiveError("INVALID_ANSWER", "选项重复。");
    }
    const labels = new Map(spec.options.map((option) => [option.key, option.label]));
    const unknown = selected.find((key) => !labels.has(key));
    if (unknown) throw new HiveError("INVALID_ANSWER", `没有选项 ${unknown}。`);
    const other = input.other?.trim() || undefined;
    const picks = selected.length + (other ? 1 : 0);
    if (picks === 0) throw new HiveError("INVALID_ANSWER", "请至少选择一项，或填写「其它」。");
    if (!spec.multiple && picks > 1) {
      throw new HiveError("INVALID_ANSWER", "单选题只能选一项（或只填写「其它」）。");
    }
    const ordered = spec.options.filter((option) => selected.includes(option.key));
    const parts = [
      ...(ordered.length
        ? [`选择 ${ordered.map((option) => `${option.key}：${option.label}`).join("；")}`]
        : []),
      ...(other ? [`其它：${other}`] : []),
    ];
    return createAndDispatchMessage(human, {
      content: parts.join("；"),
      clientMessageId: input.clientMessageId,
      replyToMessageId: question.id,
      answer: {
        questionMessageId: question.id,
        selected: ordered.map((option) => option.key),
        ...(other ? { other } : {}),
      },
    });
  }

  /**
   * hive_ask_human：Agent 在执行中需要人拍板时，发一条提问并把当前调用转为等人回答。
   * 这一轮照常结束、不占进程；人回复提问后由服务端以回答重新唤醒它，等待期间不算卡住。
   */
  function askHuman(
    agent: Participant,
    input: { question: string; clientMessageId: string; options?: string[]; multiple?: boolean },
  ) {
    const labels = (input.options ?? []).map((label) => label.replace(/\s+/g, " ").trim());
    if (labels.length > 0) {
      if (labels.length < 2 || labels.length > LIMITS.maxQuestionOptions) {
        throw new HiveError(
          "INVALID_OPTIONS",
          `选项需要 2 到 ${LIMITS.maxQuestionOptions} 个；只有一个可选项时直接写在问题里。`,
        );
      }
      if (labels.some((label) => !label || label.length > LIMITS.maxQuestionOptionLength)) {
        throw new HiveError(
          "INVALID_OPTIONS",
          `每个选项需为 1 到 ${LIMITS.maxQuestionOptionLength} 个字符。`,
        );
      }
      if (new Set(labels.map((label) => label.toLocaleLowerCase())).size !== labels.length) {
        throw new HiveError("INVALID_OPTIONS", "选项不能重复。");
      }
    }
    const spec = labels.length
      ? {
          options: labels.map((label, index) => ({
            key: String.fromCharCode(65 + index),
            label,
          })),
          multiple: input.multiple === true,
        }
      : undefined;
    const parent = inferExecutingParent(agent);
    const invocation = parent ? database.getInvocationFor(parent.id, agent.id) : undefined;
    if (!parent || !invocation || invocation.status === "cancelling") {
      throw new HiveError("NOT_EXECUTING", "只能在处理某条消息的过程中向人提问。");
    }
    const asker =
      invocation.requesterType === "human"
        ? `@${invocation.requesterName} `
        : (() => {
            // 委派链上的子任务：问链条源头的人，没有就不 @ 任何人，靠「等回答」收件箱提醒
            const root = [invocation, ...database.invocationAncestors(invocation.id)].find(
              (item) => item.requesterType === "human",
            );
            return root ? `@${root.requesterName} ` : "";
          })();
    const { message } = createAndDispatchMessage(
      agent,
      {
        // 问题里的 @ 换成全角：提问只发给人，不能借机唤醒其他 Agent
        // 选项也逐行写进正文：不渲染选项的客户端和 Agent 读正文就能看懂、照样能手打回答
        content: [
          `${asker}❓ ${quoteWithoutMentions(input.question, LIMITS.maxMessageLength - 2_000)}`,
          ...(spec
            ? [
                spec.multiple ? "（可多选）" : "（单选）",
                ...spec.options.map(
                  (option) => `${option.key}. ${quoteWithoutMentions(option.label, 100)}`,
                ),
                `（点选选项、填写「其它」，或直接回复这条消息即可把答案交给 ${agent.username}）`,
              ]
            : [`（回复这条消息即可把答案交给 ${agent.username}）`]),
        ].join("\n"),
        clientMessageId: input.clientMessageId,
        parentMessageId: parent.id,
        kind: "question",
        ...(spec ? { question: spec } : {}),
      },
      { inferredParent: true },
    );
    const updated = emitInvocation(
      database.updateInvocation(invocation.id, {
        status: "waiting_human",
        progress: null,
        detail: `等人回答：${input.question.replace(/\s+/g, " ").slice(0, 480)}`,
      }),
    );
    return { invocation: updated, message };
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
    emitInvocation(
      resetForRedelivery(
        invocation,
        invocation.blockReason === "guest_approval"
          ? `${actor.username} 已批准`
          : `${actor.username} 请求重试`,
      ),
    );
    deliverMention(message, agent, true);
  }

  /**
   * 停止调用。尚未开始执行的直接给出终态；已开始的进入 cancelling，等 Agent 回报结束才算停下，
   * 期间不允许重试。状态落库，服务端重启或 Agent 断线后仍保持，Agent 重连时会再次收到停止请求。
   */
  function cancelInvocation(actor: Participant, invocationId: string): void {
    const invocation = invocationInRoom(actor, invocationId);
    if (isTerminal(invocation)) return;
    // 等人回答且这一轮已结束：没有在跑的执行需要确认，直接停下
    if (invocation.status === "waiting_human" && invocation.finishedAt) {
      emitInvocation(
        database.updateInvocation(invocation.id, {
          status: "cancelled",
          detail: `${actor.username} 不再回答，已停止`,
        }),
      );
      return;
    }
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
      // 停止未确认前、或提问后等人回答期间的进度和心跳只更新运行观测，不把调用冲回 running
      if (invocation.status === "cancelling" || invocation.status === "waiting_human") {
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
    // 提问后这一轮正常结束：保持等人回答，只记下回复与结束时间；失败或停止照常落定
    if (invocation.status === "waiting_human" && report.status === "completed") {
      emitInvocation(
        database.updateInvocation(invocation.id, {
          finishedAt: now,
          ...(report.replyMessageId ? { replyMessageId: report.replyMessageId } : {}),
        }),
      );
      return;
    }
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
      if (invocation.status === "waiting_human") {
        return {
          ...summary,
          done: false,
          needsHuman: true,
          note: "子任务在等人回答，人回复后它会继续，结果照常回执给你；不需要等，也不要替人回答。",
        };
      }
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

  /* ---------- 外部 IM：房主扫码把飞书 / 个人微信接进房间 ---------- */

  const imHub = new ImHub({
    store: imStore,
    drivers: options.imDrivers ?? {},
    getRoom: (roomId) => database.getRoom(roomId),
    listRoomIds: () => database.listRooms(false).map((room) => room.id),
    findParticipant: (roomId, username) => database.findParticipant(roomId, username),
    getMessage: (id) => database.getMessage(id),
    post: (owner, input) => createAndDispatchMessage(owner, input).message,
    choose: (owner, questionMessageId, selected, clientMessageId) =>
      submitAnswer(owner, { type: "question.answer", questionMessageId, selected, clientMessageId })
        .message,
    isWaiting: (questionId) => Boolean(waitingForQuestion(questionId)),
    webUrl: (roomId) =>
      options.publicUrl ? `${options.publicUrl.replace(/\/$/, "")}/#${roomId}` : undefined,
    onConnectionsChanged: () => undefined,
    log: (message, detail) => app.log.warn({ detail }, message),
    ...(options.now ? { now: options.now } : {}),
  });

  const imErrorStatus: Record<string, number> = {
    IM_DISABLED: 400,
    IM_NOT_FOUND: 404,
    IM_NO_CODE: 409,
    NOT_A_MEMBER: 400,
  };

  function imError(
    reply: { code: (status: number) => { send: (body: unknown) => unknown } },
    error: unknown,
  ) {
    if (error instanceof HiveError && imErrorStatus[error.code]) {
      return reply
        .code(imErrorStatus[error.code]!)
        .send({ error: error.message, code: error.code });
    }
    throw error;
  }

  app.get("/api/im/channels", async (request, reply) => {
    if (!adminOnly(request, reply)) return reply;
    return imHub.channels();
  });

  app.get<{ Params: { roomId: string } }>("/api/rooms/:roomId/im", async (request, reply) => {
    const params = roomParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid room parameter." });
    if (!adminOnly(request, reply)) return reply;
    return { connections: imHub.list(params.data.roomId) };
  });

  app.post<{ Params: { roomId: string } }>(
    "/api/rooms/:roomId/im/login",
    async (request, reply) => {
      const params = roomParamsSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "Invalid room parameter." });
      if (!adminOnly(request, reply)) return reply;
      const body = startImLoginRequestSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: "Invalid IM login payload." });
      const room = database.getRoom(params.data.roomId);
      if (!room || room.archivedAt) {
        return reply.code(404).send({ error: "房间不存在或已归档。", code: "ROOM_NOT_FOUND" });
      }
      if (body.data.channel === "wechat" && !body.data.acceptRisk) {
        return reply
          .code(400)
          .send({ error: "连接个人微信前需要确认风险。", code: "IM_RISK_NOT_ACCEPTED" });
      }
      const owner = database.findParticipant(room.id, body.data.ownerName);
      // 访客不能把自己的 IM 接进来冒充房主：只有房主本人（非访客的人类成员）能作为发言身份
      if (!owner || owner.type !== "human" || guestSessionOf(owner)) {
        return reply
          .code(400)
          .send({ error: "需要以房主本人在这个房间里的身份连接。", code: "NOT_A_MEMBER" });
      }
      try {
        return reply.code(201).send(imHub.startLogin(room.id, body.data.channel, owner.username));
      } catch (error) {
        return imError(reply, error);
      }
    },
  );

  app.get<{ Params: { id: string } }>("/api/im/logins/:id", async (request, reply) => {
    if (!adminOnly(request, reply)) return reply;
    const view = imHub.getLogin(request.params.id);
    if (!view)
      return reply.code(404).send({ error: "扫码会话不存在或已过期。", code: "IM_NOT_FOUND" });
    return view;
  });

  app.post<{ Params: { id: string } }>("/api/im/logins/:id/code", async (request, reply) => {
    if (!adminOnly(request, reply)) return reply;
    const body = submitImLoginCodeRequestSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "配对码格式不对。" });
    try {
      const view = imHub.submitCode(request.params.id, body.data.code);
      if (!view)
        return reply.code(404).send({ error: "扫码会话不存在或已过期。", code: "IM_NOT_FOUND" });
      return view;
    } catch (error) {
      return imError(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/im/logins/:id", async (request, reply) => {
    if (!adminOnly(request, reply)) return reply;
    const view = imHub.cancelLogin(request.params.id);
    if (!view)
      return reply.code(404).send({ error: "扫码会话不存在或已过期。", code: "IM_NOT_FOUND" });
    return view;
  });

  app.post<{ Params: { id: string; action: string } }>(
    "/api/im/connections/:id/:action",
    async (request, reply) => {
      if (!adminOnly(request, reply)) return reply;
      try {
        if (request.params.action === "pause") return await imHub.pause(request.params.id);
        if (request.params.action === "resume") return await imHub.resume(request.params.id);
        return reply.code(404).send({ error: "Unknown action." });
      } catch (error) {
        return imError(reply, error);
      }
    },
  );

  app.delete<{ Params: { id: string } }>("/api/im/connections/:id", async (request, reply) => {
    if (!adminOnly(request, reply)) return reply;
    try {
      await imHub.remove(request.params.id);
      return { ok: true };
    } catch (error) {
      return imError(reply, error);
    }
  });

  app.get("/health", async () => ({
    status: "ok",
    ...(options.instanceId ? { instanceId: options.instanceId } : {}),
  }));
  app.get("/agent.md", async (_request, reply) => {
    return reply.type("text/markdown; charset=utf-8").send(AGENT_INSTRUCTIONS);
  });
  /**
   * 共享 join token 等同房主权限，只交给 Server 所在电脑上的页面（或已持有它的请求）；
   * 远程访问者拿不到它，只能凭限时邀请兑换的访客会话进入。
   */
  function isOwnerRequest(
    request: Parameters<typeof checkLocalRequest>[0] & {
      headers: { authorization?: string | undefined };
    },
  ): boolean {
    return checkLocalRequest(request).local || bearerToken(request) === joinToken;
  }

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
      ...(isOwnerRequest(request)
        ? {
            joinToken,
            agentCommand: `${agentCommandPrefix} join --server ${httpUrl} --name my-agent --token ${joinToken}`,
          }
        : {}),
    };
  });

  /** 当前访问者是谁：本机房主、有效访客，或没有访问权（含已到期、已被移除） */
  app.get("/api/access", async (request) => {
    const token = bearerToken(request);
    // 带着访客凭证来的按访客对待，即使是在 Server 所在电脑上打开
    if (!(token && isGuestToken(token)) && isOwnerRequest(request)) {
      return { role: "owner", joinToken };
    }
    const resolved = token && isGuestToken(token) ? access.resolveToken(token, clock()) : undefined;
    if (!resolved) return { role: "none", reason: "no_invite" };
    if (resolved.state !== "active") return { role: "none", reason: resolved.state };
    return sessionView(resolved);
  });

  /** 兑换前预览邀请：只透露房间和截止时间，不消耗邀请 */
  app.get<{ Querystring: { token?: string } }>("/api/invites/preview", async (request, reply) => {
    const token = request.query.token;
    const invite = token ? access.peekInvite(token) : undefined;
    if (!invite) return reply.code(404).send({ error: "邀请链接无效。", code: "INVITE_INVALID" });
    const state = invite.revokedAt
      ? "revoked"
      : invite.expiresAt && Date.parse(invite.expiresAt) <= clock()
        ? "expired"
        : "valid";
    return { roomId: invite.roomId, expiresAt: invite.expiresAt, state };
  });

  const inviteErrorStatus: Record<string, number> = {
    INVITE_INVALID: 404,
    INVITE_REVOKED: 410,
    INVITE_EXPIRED: 410,
    USERNAME_TAKEN: 409,
    INVALID_NAME: 400,
  };

  app.post("/api/invites/redeem", async (request, reply) => {
    const body = redeemInviteRequestSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid redeem payload." });
    if (!/^[\p{L}\p{N}_.-]+$/u.test(body.data.username)) {
      return reply.code(400).send({
        error: "名字只能包含字母、数字、点、下划线和连字符。",
        code: "INVALID_NAME",
      });
    }
    try {
      const { session, token } = access.redeemInvite(
        body.data.token,
        body.data.username,
        clock(),
        isNameTaken,
      );
      return { token, ...sessionView(access.resolve(session, clock())) };
    } catch (error) {
      if (error instanceof HiveError && inviteErrorStatus[error.code]) {
        return reply
          .code(inviteErrorStatus[error.code]!)
          .send({ error: error.message, code: error.code });
      }
      throw error;
    }
  });

  app.post<{ Params: { roomId: string } }>("/api/rooms/:roomId/invites", async (request, reply) => {
    const params = roomParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid room parameter." });
    if (!adminOnly(request, reply)) return reply;
    const body = createInviteRequestSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid invite payload." });
    const room = database.getRoom(params.data.roomId);
    if (!room || room.archivedAt) {
      return reply.code(404).send({ error: "房间不存在或已归档。", code: "ROOM_NOT_FOUND" });
    }
    const created = access.createInvite({
      roomId: room.id,
      expiresAt: expiresAtFrom(body.data.expiresInMinutes, clock()),
      allowAgents: body.data.allowAgents,
    });
    return reply.code(201).send(created);
  });

  app.get<{ Params: { roomId: string } }>("/api/rooms/:roomId/invites", async (request, reply) => {
    const params = roomParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid room parameter." });
    if (!adminOnly(request, reply)) return reply;
    return { invites: access.listInvites(params.data.roomId) };
  });

  /** 撤销邀请：链接失效，凭它进来的人和他们的 Agent 立即被断开 */
  app.delete<{ Params: { inviteId: string } }>("/api/invites/:inviteId", async (request, reply) => {
    if (!adminOnly(request, reply)) return reply;
    try {
      const invite = access.revokeInvite(request.params.inviteId);
      const sessions = access.sessionsOfInvite(invite.id);
      endSessionConnections(sessions, "revoked");
      refreshAccessPresence(sessions);
      return { invite };
    } catch (error) {
      if (error instanceof HiveError) return reply.code(404).send({ error: error.message });
      throw error;
    }
  });

  /** 续期邀请：链接与凭它进来的所有人一起延到新的截止时间 */
  app.post<{ Params: { inviteId: string } }>(
    "/api/invites/:inviteId/renew",
    async (request, reply) => {
      if (!adminOnly(request, reply)) return reply;
      const body = renewAccessRequestSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: "Invalid renew payload." });
      try {
        const invite = access.renewInvite(
          request.params.inviteId,
          expiresAtFrom(body.data.expiresInMinutes, clock()),
        );
        refreshAccessPresence(access.sessionsOfInvite(invite.id));
        return { invite };
      } catch (error) {
        if (error instanceof HiveError) {
          return reply
            .code(error.code === "INVITE_NOT_FOUND" ? 404 : 409)
            .send({ error: error.message, code: error.code });
        }
        throw error;
      }
    },
  );

  /** 房主为访客续期；访客带入的 Agent 跟着一起延长 */
  app.post<{ Params: { sessionId: string } }>(
    "/api/guests/:sessionId/renew",
    async (request, reply) => {
      if (!adminOnly(request, reply)) return reply;
      const body = renewAccessRequestSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: "Invalid renew payload." });
      try {
        const session = access.renew(
          request.params.sessionId,
          expiresAtFrom(body.data.expiresInMinutes, clock()),
        );
        refreshAccessPresence(access.familyOf(session.id));
        return { session: sessionView(access.resolve(session, clock())) };
      } catch (error) {
        if (error instanceof HiveError) {
          return reply
            .code(error.code === "SESSION_NOT_FOUND" ? 404 : 409)
            .send({ error: error.message, code: error.code });
        }
        throw error;
      }
    },
  );

  /** 房主移除访客：立即断开访客与其 Agent，之后都连不上；历史消息保留 */
  app.delete<{ Params: { sessionId: string } }>(
    "/api/guests/:sessionId",
    async (request, reply) => {
      if (!adminOnly(request, reply)) return reply;
      try {
        const session = access.revoke(request.params.sessionId);
        const family = access.familyOf(session.id);
        endSessionConnections(family, "revoked");
        refreshAccessPresence(family);
        return { session: sessionView(access.resolve(session, clock())) };
      } catch (error) {
        if (error instanceof HiveError) return reply.code(404).send({ error: error.message });
        throw error;
      }
    },
  );

  /** 访客为自己带入一个 Agent：同房间、同期限，访客到期或被移除时一起失效 */
  app.post("/api/guest-agents", async (request, reply) => {
    const principal = guard(request, reply);
    if (!principal) return reply;
    if (principal.kind !== "guest" || principal.resolved.session.kind !== "human") {
      return reply
        .code(403)
        .send({ error: "只有访客本人可以为自己带入 Agent。", code: "GUEST_ONLY" });
    }
    const body = createGuestAgentRequestSchema.safeParse(request.body);
    if (!body.success || !/^[\p{L}\p{N}_.-]+$/u.test(body.data.username)) {
      return reply.code(400).send({
        error: "Agent 名字只能包含字母、数字、点、下划线和连字符。",
        code: "INVALID_NAME",
      });
    }
    const sponsor = principal.resolved.session;
    if (database.findParticipant(sponsor.roomId, body.data.username)) {
      return reply
        .code(409)
        .send({ error: "房间里已经有这个名字了，请换一个。", code: "USERNAME_TAKEN" });
    }
    const { session, token } = access.createAgentSession(sponsor, body.data.username);
    return reply.code(201).send({
      token,
      command: guestAgentCommand(request, session, token),
      ...sessionView(access.resolve(session, clock())),
    });
  });

  function connectedMcpAgent(request: {
    headers: Record<string, string | string[] | undefined>;
  }): Participant | undefined {
    const principal = principalForToken(
      bearerToken(request as { headers: { authorization?: string } }),
    );
    if (!principal) return undefined;
    const roomId = headerString(request.headers["x-hive-room"]);
    const username = headerString(request.headers["x-hive-agent-name"]);
    if (!roomId || !username) return undefined;
    // 访客 Agent 的凭证只代表它自己：房间与名字都必须对上，访客本人的凭证不能用来调 Agent 工具
    if (
      principal.kind === "guest" &&
      (principal.resolved.session.kind !== "agent" ||
        principal.resolved.session.roomId !== roomId ||
        principal.resolved.session.username.toLocaleLowerCase() !== username.toLocaleLowerCase())
    ) {
      return undefined;
    }
    const connection = onlineAgent(roomId, username);
    return connection?.participant?.type === "agent" ? connection.participant : undefined;
  }

  /** 交给模型看的图片上限：多数看图接口按 base64 后约 5 MB 计 */
  const MCP_IMAGE_MAX_BYTES = 3_750_000;

  async function readAttachmentForAgent(
    agent: Participant,
    input: { id: string; offset: number; maxBytes: number },
  ): Promise<AttachmentReadResult> {
    const item = attachments.get(input.id);
    const message = item?.messageId ? database.getMessage(item.messageId) : undefined;
    if (!item || item.roomId !== agent.roomId || item.revokedAt || !message || message.deletedAt) {
      throw new HiveError("ATTACHMENT_NOT_FOUND", "这个房间里没有这个附件（可能已撤回）。");
    }
    const attachment = publicAttachment(item);
    if (item.kind === "image") {
      if (item.size > MCP_IMAGE_MAX_BYTES) {
        return {
          kind: "file",
          attachment,
          note: "图片超过 3.75 MB，无法作为图片内容返回；如果你能读取本机文件，请用提示里给出的本地路径。",
        };
      }
      return {
        kind: "image",
        attachment,
        data: (await readFile(item.filePath)).toString("base64"),
      };
    }
    if (item.kind !== "text") {
      return {
        kind: "file",
        attachment,
        note: "二进制文件，无法以文本读取；如果你能读取本机文件，请用提示里给出的本地路径。",
      };
    }
    const handle = await open(item.filePath, "r");
    try {
      const buffer = Buffer.alloc(Math.min(input.maxBytes, Math.max(0, item.size - input.offset)));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, input.offset);
      let end = bytesRead;
      // 不在多字节字符中间截断：回退到最后一个完整字符的边界
      if (end > 0 && input.offset + end < item.size) {
        let lead = end - 1;
        while (lead > 0 && end - lead < 4 && (buffer[lead]! & 0xc0) === 0x80) lead -= 1;
        const first = buffer[lead]!;
        const length = first >= 0xf0 ? 4 : first >= 0xe0 ? 3 : first >= 0xc0 ? 2 : 1;
        if (lead + length > end) end = lead;
      }
      const next = input.offset + end;
      return {
        kind: "text",
        attachment,
        text: buffer.subarray(0, end).toString("utf8"),
        nextOffset: next < item.size ? next : null,
      };
    } finally {
      await handle.close();
    }
  }

  /* ---------- 附件：HTTP 上传与鉴权下载，WebSocket 只传附件 ID ---------- */

  /** 房主与本机 Agent 共用一个上传者身份；访客按会话区分，看不到彼此待发的附件 */
  function uploaderOf(principal: Principal): string {
    return principal.kind === "admin" ? "admin" : `guest:${principal.resolved.session.id}`;
  }

  function attachmentError(reply: FastifyReply, error: unknown) {
    const hiveError = error instanceof HiveError ? error : undefined;
    const status =
      hiveError?.code === "ATTACHMENT_TOO_LARGE"
        ? 413
        : hiveError?.code === "UPLOAD_RATE_LIMIT"
          ? 429
          : hiveError?.code?.endsWith("_QUOTA")
            ? 413
            : hiveError
              ? 400
              : 500;
    return reply.code(status).send({
      error: hiveError?.message ?? "附件处理失败。",
      code: hiveError?.code ?? "ATTACHMENT_FAILED",
    });
  }

  /**
   * 读权限：撤回的不再提供；还没发出的只有上传者本人能读；发出后按所在房间的权限。
   * 内容相同的文件共享磁盘，但每条记录各自鉴权。
   */
  function readableAttachment(
    principal: Principal,
    id: string,
  ): { item: StoredAttachment } | { status: number; code: string; error: string } {
    const item = attachments.get(id);
    if (!item) return { status: 404, code: "ATTACHMENT_NOT_FOUND", error: "附件不存在。" };
    if (!canAccessRoom(principal, item.roomId)) {
      return { status: 403, code: "ROOM_FORBIDDEN", error: "这个凭证不能访问该房间。" };
    }
    if (item.revokedAt) {
      return { status: 410, code: "ATTACHMENT_REVOKED", error: "附件所在的消息已撤回。" };
    }
    if (!item.messageId) {
      if (item.uploader !== uploaderOf(principal)) {
        return { status: 404, code: "ATTACHMENT_NOT_FOUND", error: "附件不存在。" };
      }
      if (Date.parse(item.expiresAt) <= clock()) {
        return {
          status: 410,
          code: "ATTACHMENT_EXPIRED",
          error: "附件上传后太久没有发出，已过期。",
        };
      }
    }
    return { item };
  }

  app.post<{ Params: { roomId: string } }>(
    "/api/rooms/:roomId/attachments",
    async (request, reply) => {
      const roomId = roomParamsSchema.parse(request.params).roomId;
      const principal = guard(request, reply, roomId);
      if (!principal) return;
      if (!database.getRoom(roomId)) {
        return reply.code(404).send({ error: "房间不存在。", code: "ROOM_NOT_FOUND" });
      }
      if (!request.isMultipart()) {
        return reply
          .code(415)
          .send({ error: "请用 multipart/form-data 上传文件。", code: "MULTIPART_REQUIRED" });
      }
      const uploader = uploaderOf(principal);
      try {
        attachments.checkRate(uploader);
        // 先按声明的长度预检配额，明知超限就不必把文件收下来
        const declared = Number(request.headers["content-length"] ?? 0);
        attachments.checkQuota(roomId, uploader, Number.isFinite(declared) ? declared : 0);
        const file = await request.file();
        if (!file) {
          return reply.code(400).send({ error: "没有收到文件。", code: "FILE_REQUIRED" });
        }
        const stored = await attachments.save({
          roomId,
          uploader,
          name: file.filename,
          stream: file.file,
          truncated: () => file.file.truncated,
        });
        return reply.code(201).send({
          ...publicAttachment(stored),
          roomId: stored.roomId,
          expiresAt: stored.expiresAt,
        });
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "FST_REQ_FILE_TOO_LARGE") {
          return attachmentError(
            reply,
            new HiveError("ATTACHMENT_TOO_LARGE", "单个附件不能超过 20 MiB。"),
          );
        }
        // 客户端中途取消：连接已断开，不再回复
        if (request.raw.socket?.destroyed) return reply.hijack();
        return attachmentError(reply, error);
      }
    },
  );

  /** 移除还没发出的附件（上传队列里点 ×） */
  app.delete<{ Params: { id: string } }>("/api/attachments/:id", async (request, reply) => {
    const principal = guard(request, reply);
    if (!principal) return;
    const id = z.string().uuid().safeParse(request.params.id);
    if (!id.success || !attachments.discardPending(id.data, uploaderOf(principal))) {
      return reply.code(404).send({ error: "没有这个待发附件。", code: "ATTACHMENT_NOT_FOUND" });
    }
    return reply.code(204).send();
  });

  /**
   * 下载原件：只接受 Authorization 头（不接受 URL 里的凭证）。
   * 图片按嗅探出的类型内联；其余一律 attachment 下载，并用 nosniff + sandbox CSP 防止被当网页执行。
   */
  app.get<{ Params: { id: string } }>("/api/attachments/:id", async (request, reply) => {
    const principal = guard(request, reply);
    if (!principal) return;
    const id = z.string().uuid().safeParse(request.params.id);
    if (!id.success) {
      return reply.code(404).send({ error: "附件不存在。", code: "ATTACHMENT_NOT_FOUND" });
    }
    const result = readableAttachment(principal, id.data);
    if (!("item" in result)) {
      return reply.code(result.status).send({ error: result.error, code: result.code });
    }
    const { item } = result;
    if (!existsSync(item.filePath)) {
      return reply.code(410).send({ error: "附件文件已被清理。", code: "ATTACHMENT_GONE" });
    }
    const inline = item.kind === "image";
    reply
      .header("Content-Type", item.kind === "text" ? "text/plain; charset=utf-8" : item.mime)
      .header("Content-Length", String(item.size))
      .header(
        "Content-Disposition",
        `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(item.name)}`,
      )
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy", "default-src 'none'; sandbox")
      .header("Cache-Control", "private, no-store")
      .header("X-Hive-Attachment-Sha256", item.sha256);
    return reply.send(createReadStream(item.filePath));
  });

  /**
   * 与 Server 同在一台电脑上的房主 Agent 直接拿 Server 存的那份文件路径，不再下载第二份；
   * 远程 Bridge 拿不到这个接口，改为下载到自己机器上的缓存。
   */
  app.get<{ Params: { id: string } }>("/api/attachments/:id/local-path", async (request, reply) => {
    const principal = guard(request, reply);
    if (!principal) return;
    if (principal.kind !== "admin" || !checkLocalRequest(request).local) {
      return reply.code(403).send({ error: "只提供给本机的房主 Agent。", code: "LOCAL_ONLY" });
    }
    const id = z.string().uuid().safeParse(request.params.id);
    const result = id.success
      ? readableAttachment(principal, id.data)
      : { status: 404, code: "ATTACHMENT_NOT_FOUND", error: "附件不存在。" };
    if (!("item" in result)) {
      return reply.code(result.status).send({ error: result.error, code: result.code });
    }
    if (!result.item.messageId || !existsSync(result.item.filePath)) {
      return reply.code(404).send({ error: "附件不存在。", code: "ATTACHMENT_NOT_FOUND" });
    }
    return { path: result.item.filePath, sha256: result.item.sha256 };
  });

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
      listMembers: () => participantsOf(participant.roomId),
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
      askHuman: (input) => askHuman(participant, input),
      wait: (input) => waitForInvocation(participant, input),
      readAttachment: (input) => readAttachmentForAgent(participant, input),
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
    if (!guard(request, reply, params.data.roomId)) return reply;
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
      const principal = guard(request, reply);
      if (!principal) return reply;
      return {
        messages: database
          .searchMessages(query.data.q, query.data.limit)
          .filter((message) => canAccessRoom(principal, message.roomId)),
      };
    },
  );

  app.get<{ Querystring: { username?: string; limit?: string } }>(
    "/api/mentions",
    async (request, reply) => {
      const query = mentionsQuerySchema.safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: "Invalid mentions query." });
      const principal = guard(request, reply);
      if (!principal) return reply;
      return {
        messages: database
          .listMentions(query.data.username, query.data.limit)
          .filter((message) => canAccessRoom(principal, message.roomId)),
      };
    },
  );

  app.get("/api/invocations", async (request, reply) => {
    const principal = guard(request, reply);
    if (!principal) return reply;
    const invocations = database
      .listActiveInvocations()
      .filter((invocation) => canAccessRoom(principal, invocation.roomId));
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
      if (!guard(request, reply, params.data.roomId)) return reply;
      return { entries: database.listWhiteboard(params.data.roomId) };
    },
  );

  app.get<{ Params: { roomId: string } }>(
    "/api/rooms/:roomId/invocations",
    async (request, reply) => {
      const params = roomParamsSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "Invalid room parameter." });
      if (!guard(request, reply, params.data.roomId)) return reply;
      return { invocations: database.listInvocations(params.data.roomId) };
    },
  );

  app.get<{ Params: { roomId: string } }>(
    "/api/rooms/:roomId/participants",
    async (request, reply) => {
      const params = roomParamsSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "Invalid room parameter." });
      if (!guard(request, reply, params.data.roomId)) return reply;
      return { participants: participantsOf(params.data.roomId) };
    },
  );

  app.get<{ Querystring: { includeArchived?: string } }>("/api/rooms", async (request, reply) => {
    const query = roomsQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "Invalid query parameters." });
    const principal = guard(request, reply);
    if (!principal) return reply;
    return {
      rooms: database
        .listRooms(query.data.includeArchived)
        .filter((room) => canAccessRoom(principal, room.id)),
    };
  });

  app.post("/api/rooms", async (request, reply) => {
    if (!adminOnly(request, reply)) return reply;
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
    if (!adminOnly(request, reply)) return reply;
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
        const principal = principalForToken(event.token);
        if (!principal) {
          // 区分「从没被邀请」和「访问已到期 / 被移除」，后者给出明确原因
          const ended = isGuestToken(event.token)
            ? access.resolveToken(event.token, clock())
            : undefined;
          send(
            socket,
            ended && ended.state !== "active"
              ? { type: "error", ...endedMessages[ended.state] }
              : { type: "error", code: "UNAUTHORIZED", message: "Invalid join token." },
          );
          socket.close(1008, "Unauthorized");
          return;
        }
        if (principal.kind === "guest") {
          const session = principal.resolved.session;
          if (
            session.roomId !== event.roomId ||
            session.kind !== event.participantType ||
            session.username.toLocaleLowerCase() !== event.username.toLocaleLowerCase()
          ) {
            send(socket, {
              type: "error",
              code: "ROOM_FORBIDDEN",
              message: `这个邀请只能以 ${session.username} 的身份进入 #${session.roomId}。`,
            });
            socket.close(1008, "Forbidden");
            return;
          }
          if (!database.getRoom(session.roomId)) {
            send(socket, { type: "error", code: "ROOM_NOT_FOUND", message: "房间不存在。" });
            socket.close(1008, "Room not found");
            return;
          }
        }
        connection.principal = principal;
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
            self: withAccess(participant),
            participants: participantsOf(event.roomId),
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
            broadcast(event.roomId, {
              type: "presence.changed",
              participant: withAccess(participant),
            });
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
      // 访客每次操作前都复核期限：到期或被移除后，已建立的连接也不能再收发
      if (!ensureActive(connection)) return;
      const guest = connection.principal?.kind === "guest";
      const ownerOnly =
        event.type === "topic.start" ||
        event.type === "budget.extend" ||
        event.type === "whiteboard.remove";
      if (guest && ownerOnly) {
        send(socket, {
          type: "error",
          code: "OWNER_ONLY",
          message: "访客不能开启新话题、追加轮数或删除白板事项。",
        });
        return;
      }
      if (guest && (event.type === "invocation.retry" || event.type === "invocation.cancel")) {
        const invocation = database.getInvocation(event.invocationId);
        // 访客只能管自己发起的调用；房主批准访客的请求不能由访客自己点
        if (
          !invocation ||
          invocation.requesterId !== participant.id ||
          (event.type === "invocation.retry" && invocation.blockReason === "guest_approval")
        ) {
          send(socket, {
            type: "error",
            code: "OWNER_ONLY",
            message: "访客只能重试或停止自己发起、且无需房主批准的调用。",
          });
          return;
        }
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
          attachments.revokeForMessage(message.id);
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

      if (event.type === "question.answer") {
        try {
          if (participant.type !== "human") {
            throw new HiveError("FORBIDDEN", "Only humans answer agent questions.");
          }
          const result = submitAnswer(participant, event);
          if (!result.created) send(socket, { type: "message.created", message: result.message });
        } catch (error) {
          const hiveError = error instanceof HiveError ? error : undefined;
          send(socket, {
            type: "error",
            code: hiveError?.code ?? "ANSWER_FAILED",
            message: hiveError?.message ?? "Could not submit the answer.",
          });
        }
        return;
      }

      try {
        // 重发同一条消息（断线重试）直接返回已有结果，附件此时已经绑定在那条消息上
        const sent = database.findMessageByClientId(participant.id, event.clientMessageId);
        if (sent) {
          send(socket, { type: "message.created", message: sent });
          return;
        }
        const attachmentIds = [...new Set(event.attachmentIds ?? [])];
        const claimed =
          attachmentIds.length && connection.principal
            ? attachments.claim(attachmentIds, {
                roomId: participant.roomId,
                uploader: uploaderOf(connection.principal),
              })
            : undefined;
        const result = createAndDispatchMessage(participant, {
          content: event.content,
          clientMessageId: event.clientMessageId,
          ...(event.replyToMessageId ? { replyToMessageId: event.replyToMessageId } : {}),
          ...(event.parentMessageId ? { parentMessageId: event.parentMessageId } : {}),
          ...(claimed
            ? {
                attachments: claimed,
                onInsert: (messageId: string) => attachments.bind(attachmentIds, messageId),
              }
            : {}),
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
  // 到点就断开访客，不等它下一次操作；每次操作和重连时也会复核
  const accessTimer = setInterval(sweepExpiredAccess, options.accessSweepMs ?? 10_000);
  // 测试里直接触发清理
  app.decorate("attachmentStore", attachments);
  const attachmentTimer = setInterval(
    () => {
      try {
        attachments.sweep();
      } catch (error) {
        app.log.warn({ err: error }, "attachment sweep failed");
      }
    },
    options.attachmentSweepMs ?? 10 * 60_000,
  );
  attachmentTimer.unref();
  invocationTimer.unref();

  app.addHook("onReady", async () => {
    localAgents?.start();
    imHub.start();
    for (const invocation of database.listPendingContinuations())
      deliverContinuation(invocation.id);
  });

  app.addHook("onClose", async () => {
    shuttingDown = true;
    // 先让本机 Agent 正常离线，再关闭连接与数据库
    await localAgents?.shutdown();
    await imHub.close();
    clearInterval(heartbeatTimer);
    clearInterval(invocationTimer);
    clearInterval(accessTimer);
    clearInterval(attachmentTimer);
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
