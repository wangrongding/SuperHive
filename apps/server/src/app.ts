import { existsSync } from "node:fs";
import path from "node:path";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { clientEventSchema, type Participant, type ServerEvent } from "@ai-hive/protocol";
import Fastify, { type FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { z } from "zod";
import { AGENT_INSTRUCTIONS } from "./agent-instructions.js";
import { HiveDatabase, HiveError, type CreateMessageInput } from "./database.js";
import { createHiveMcpServer } from "./hive-mcp.js";

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
  staticDir?: string;
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

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  const database = new HiveDatabase(options.databasePath ?? "./data/hive.sqlite");
  const joinToken = database.getOrCreateToken(options.token ?? process.env.HIVE_TOKEN);
  const connections = new Set<Connection>();
  const onlineByName = new Map<string, Connection>();
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 45_000;
  let shuttingDown = false;

  await app.register(cors, { origin: true });
  await app.register(websocket);

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

  function setStatus(connection: Connection, status: "online" | "offline" | "busy"): void {
    const current = connection.participant;
    if (!current || current.status === status) return;
    const participant = database.setParticipantStatus(current.id, status);
    connection.participant = participant;
    broadcast(participant.roomId, { type: "presence.changed", participant });
  }

  function disconnect(connection: Connection): void {
    connections.delete(connection);
    const participant = connection.participant;
    if (!participant) return;
    const key = participantKey(participant.roomId, participant.username);
    if (onlineByName.get(key) !== connection) return;
    onlineByName.delete(key);
    if (shuttingDown) return;
    setStatus(connection, "offline");
  }

  function createAndDispatchMessage(participant: Participant, input: CreateMessageInput) {
    const result = database.createMessage(participant, input);
    if (!result.created) return result;
    broadcast(participant.roomId, { type: "message.created", message: result.message });
    if (result.message.hopCount >= 4) return result;
    for (const mention of result.message.mentions) {
      if (mention.toLocaleLowerCase() === "all") continue;
      const target = onlineByName.get(participantKey(participant.roomId, mention));
      if (target?.participant?.type === "agent" && target.participant.id !== participant.id) {
        send(target.socket, {
          type: "agent.mentioned",
          message: result.message,
          latestSeq: database.latestSeq(participant.roomId),
        });
      }
    }
    return result;
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
    const agentCommandPrefix = options.agentCommandPrefix ?? "npx --yes ai-hive";
    return {
      name: "AI Hive",
      roomId: "general",
      httpUrl,
      wsUrl,
      mcpUrl: `${httpUrl}/mcp`,
      joinToken,
      agentCommand: `${agentCommandPrefix} join --server ${httpUrl} --room general --name my-agent --token ${joinToken}`,
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
    const connection = onlineByName.get(participantKey(roomId, username));
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
      readMessages: (afterSeq, limit) => ({
        messages: database.getMessages(participant.roomId, afterSeq, limit),
        latestSeq: database.latestSeq(participant.roomId),
      }),
      listMembers: () => database.listParticipants(participant.roomId),
      sendMessage: (input) => createAndDispatchMessage(participant, input).message,
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

  app.get<{ Params: { roomId: string } }>(
    "/api/rooms/:roomId/participants",
    async (request, reply) => {
      const params = roomParamsSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "Invalid room parameter." });
      if (!authorized(request)) return reply.code(401).send({ error: "Unauthorized" });
      return { participants: database.listParticipants(params.data.roomId) };
    },
  );

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
        send(socket, { type: "error", code: "INVALID_EVENT", message: "Invalid client event." });
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
        const key = participantKey(event.roomId, event.username);
        if (onlineByName.has(key)) {
          send(socket, {
            type: "error",
            code: "USERNAME_TAKEN",
            message: "This username is already online in the room.",
          });
          return;
        }
        try {
          const participant = database.upsertParticipant({
            roomId: event.roomId,
            username: event.username,
            type: event.participantType,
            ...(event.persona ? { persona: event.persona } : {}),
            ...(event.provider ? { provider: event.provider } : {}),
          });
          connection.participant = participant;
          connection.lastHeartbeat = Date.now();
          onlineByName.set(key, connection);
          send(socket, {
            type: "room.snapshot",
            self: participant,
            participants: database.listParticipants(event.roomId),
            messages: database.getRecentMessages(event.roomId),
            latestSeq: database.latestSeq(event.roomId),
          });
          broadcast(event.roomId, { type: "presence.changed", participant });
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

  app.addHook("onClose", async () => {
    shuttingDown = true;
    clearInterval(heartbeatTimer);
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
