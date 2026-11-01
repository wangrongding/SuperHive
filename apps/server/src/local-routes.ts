import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  createLocalAgentRequestSchema,
  localAgentProviderSchema,
  updateLocalAgentSettingsRequestSchema,
  keepAwakeSettingsSchema,
  type KeepAwakeSettings,
  type KeepAwakeState,
  type LocalSessionResponse,
} from "@ai-hive/protocol";
import QRCode from "qrcode";
import { HiveError } from "./database.js";
import type { OwnerDevice } from "./owner-devices.js";
import { checkLocalRequest } from "./local-access.js";
import { listDirectories } from "./local-directories.js";
import type { LocalAgentSupervisor } from "./local-agents.js";

/**
 * 本机 Agent 的 HTTP 接口。每个请求都要同时满足：
 * 1. 来自 Hive Server 所在电脑（checkLocalRequest）
 * 2. 携带本次进程启动时生成的房主 token（X-Hive-Owner），它只经 /api/local/session 交给本机页面
 * 公开的 join token 不能用来启动进程。
 */

const OWNER_HEADER = "x-hive-owner";

const ERROR_STATUS: Record<string, number> = {
  LOCAL_AGENT_NOT_FOUND: 404,
  LOCAL_AGENT_NAME_TAKEN: 409,
  LOCAL_AGENT_CWD_REQUIRED: 400,
  LOCAL_AGENT_CWD_INVALID: 400,
  LOCAL_DIRECTORY_INVALID: 400,
  LOCAL_DIRECTORY_NOT_FOUND: 404,
  ROOM_NOT_FOUND: 404,
  NOT_A_MEMBER: 403,
  LOCAL_AGENT_MCP_UNSUPPORTED: 400,
  LOCAL_AGENT_MCP_LIST_FAILED: 502,
};

export type LocalRoomActions = {
  clearRoom: (roomId: string, username: string) => { messages: number; invocations: number };
  /** 房主在其他设备上的登录：只能在 Server 所在电脑上管理 */
  ownerDevices?: {
    list(): OwnerDevice[];
    revoke(id: string): boolean;
    pair(): { ticket: string; expiresAt: string };
    webBase(): string | undefined;
    joinToken(): string;
  };
  /** 熄屏后保持在线：控制的是这台电脑，只给本机房主 */
  keepAwake?: {
    state(): KeepAwakeState | undefined;
    update(patch: Partial<KeepAwakeSettings>): KeepAwakeState | undefined;
  };
};

export function registerLocalAgentRoutes(
  app: FastifyInstance,
  supervisor: LocalAgentSupervisor | undefined,
  rooms: LocalRoomActions,
): void {
  const ownerToken = randomBytes(32).toString("hex");
  const ownerBuffer = Buffer.from(ownerToken);

  app.get("/api/local/session", async (request): Promise<LocalSessionResponse> => {
    if (!supervisor) return { enabled: false, reason: "本机 Agent 已在服务端关闭" };
    const check = checkLocalRequest(request);
    if (!check.local) return { enabled: false, reason: check.reason };
    return { enabled: true, ownerToken };
  });

  /** 返回 true 表示已拒绝并发出了响应 */
  function deny(request: FastifyRequest, reply: FastifyReply): boolean {
    if (!supervisor) {
      void reply.code(404).send({ error: "本机 Agent 已在服务端关闭。" });
      return true;
    }
    const check = checkLocalRequest(request);
    if (!check.local) {
      void reply.code(403).send({ error: check.reason });
      return true;
    }
    const provided = request.headers[OWNER_HEADER];
    const buffer = Buffer.from(typeof provided === "string" ? provided : "");
    if (buffer.length !== ownerBuffer.length || !timingSafeEqual(buffer, ownerBuffer)) {
      void reply.code(401).send({ error: "缺少或错误的房主凭证，请刷新页面。" });
      return true;
    }
    return false;
  }

  function fail(reply: FastifyReply, error: unknown) {
    if (error instanceof HiveError && ERROR_STATUS[error.code]) {
      return reply.code(ERROR_STATUS[error.code]!).send({ error: error.message, code: error.code });
    }
    throw error;
  }

  app.get("/api/local/owner-devices", async (request, reply) => {
    if (deny(request, reply)) return reply;
    if (!rooms.ownerDevices) return reply.code(404).send({ error: "未启用。" });
    return { devices: rooms.ownerDevices.list() };
  });

  app.delete<{ Params: { id: string } }>("/api/local/owner-devices/:id", async (request, reply) => {
    if (deny(request, reply)) return reply;
    if (!rooms.ownerDevices?.revoke(request.params.id)) {
      return reply.code(404).send({ error: "没有这台设备，或已经退出。" });
    }
    return { ok: true };
  });

  /** 在其他设备上登录：一次性链接和二维码，5 分钟内有效 */
  app.post<{ Body: { origin?: string } }>(
    "/api/local/owner-devices/pair",
    async (request, reply) => {
      if (deny(request, reply)) return reply;
      const owner = rooms.ownerDevices;
      if (!owner) return reply.code(404).send({ error: "未启用。" });
      const { ticket, expiresAt } = owner.pair();
      // 页面自己的地址（开发时是 Vite 端口）优先；页面开在 localhost 上时换成服务公布的地址
      const origin = typeof request.body?.origin === "string" ? request.body.origin : "";
      const base =
        origin && !/^https?:\/\/(localhost|127\.|\[::1\])/i.test(origin)
          ? origin.replace(/\/$/, "")
          : (owner.webBase() ?? origin.replace(/\/$/, ""));
      const url = `${base}/?login=${ticket}`;
      return { url, expiresAt, qrDataUrl: await QRCode.toDataURL(url, { margin: 1, width: 240 }) };
    },
  );

  /** 显示总令牌：只给本机房主，用于手动在其他设备上填入或接入远程 Agent */
  app.get("/api/local/owner-token", async (request, reply) => {
    if (deny(request, reply)) return reply;
    if (!rooms.ownerDevices) return reply.code(404).send({ error: "未启用。" });
    return { token: rooms.ownerDevices.joinToken() };
  });

  app.get("/api/local/keep-awake", async (request, reply) => {
    if (deny(request, reply)) return reply;
    const state = rooms.keepAwake?.state();
    if (!state) return reply.code(404).send({ error: "这个服务没有启用熄屏后保持在线。" });
    return state;
  });

  app.put("/api/local/keep-awake", async (request, reply) => {
    if (deny(request, reply)) return reply;
    const parsed = keepAwakeSettingsSchema.partial().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数不正确。" });
    const patch = Object.fromEntries(
      Object.entries(parsed.data).filter(([, value]) => value !== undefined),
    ) as Partial<KeepAwakeSettings>;
    const state = rooms.keepAwake?.update(patch);
    if (!state) return reply.code(404).send({ error: "这个服务没有启用熄屏后保持在线。" });
    return state;
  });

  app.get("/api/local/providers", async (request, reply) => {
    if (deny(request, reply)) return reply;
    return { providers: await supervisor!.providers() };
  });

  app.get<{ Querystring: { path?: string } }>("/api/local/directories", async (request, reply) => {
    if (deny(request, reply)) return reply;
    try {
      return listDirectories(request.query.path);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get("/api/local/agents", async (request, reply) => {
    if (deny(request, reply)) return reply;
    return { agents: supervisor!.list() };
  });

  app.post("/api/local/agents", async (request, reply) => {
    if (deny(request, reply)) return reply;
    const parsed = createLocalAgentRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数不正确。" });
    try {
      return reply.code(201).send({ agent: supervisor!.create(parsed.data) });
    } catch (error) {
      return fail(reply, error);
    }
  });

  for (const action of ["start", "stop", "restart"] as const) {
    app.post<{ Params: { id: string } }>(
      `/api/local/agents/:id/${action}`,
      async (request, reply) => {
        if (deny(request, reply)) return reply;
        try {
          const id = request.params.id;
          const agent =
            action === "start"
              ? supervisor!.startAgent(id)
              : action === "stop"
                ? await supervisor!.stop(id)
                : await supervisor!.restart(id);
          return { agent };
        } catch (error) {
          return fail(reply, error);
        }
      },
    );
  }

  /** 接入前预览：某个 provider 在该目录下会加载的本机 MCP；?measure=1 时估算开局 token */
  app.get<{ Querystring: { provider?: string; cwd?: string; measure?: string } }>(
    "/api/local/mcp",
    async (request, reply) => {
      if (deny(request, reply)) return reply;
      const provider = localAgentProviderSchema.safeParse(request.query.provider);
      if (!provider.success) return reply.code(400).send({ error: "参数不正确。" });
      try {
        return await supervisor!.mcpCandidates(
          provider.data,
          request.query.cwd?.trim() || undefined,
          request.query.measure === "1",
        );
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  /** 这个 Agent 会加载的本机 MCP；?measure=1 时逐个连上估算开局 token（较慢） */
  app.get<{ Params: { id: string }; Querystring: { measure?: string } }>(
    "/api/local/agents/:id/mcp",
    async (request, reply) => {
      if (deny(request, reply)) return reply;
      try {
        return await supervisor!.mcpServers(request.params.id, request.query.measure === "1");
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.put<{ Params: { id: string } }>("/api/local/agents/:id/settings", async (request, reply) => {
    if (deny(request, reply)) return reply;
    const parsed = updateLocalAgentSettingsRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数不正确。" });
    try {
      return { agent: supervisor!.updateSettings(request.params.id, parsed.data) };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/local/agents/:id", async (request, reply) => {
    if (deny(request, reply)) return reply;
    try {
      await supervisor!.remove(request.params.id);
      return reply.code(204).send();
    } catch (error) {
      return fail(reply, error);
    }
  });

  /** 清空房间：不可恢复，所以和启动进程一样只给本机房主 */
  app.post<{ Params: { roomId: string }; Body: { username?: unknown } }>(
    "/api/local/rooms/:roomId/clear",
    async (request, reply) => {
      if (deny(request, reply)) return reply;
      const username = request.body?.username;
      if (typeof username !== "string" || !username.trim()) {
        return reply.code(400).send({ error: "缺少操作人。" });
      }
      try {
        return { removed: rooms.clearRoom(request.params.roomId, username.trim()) };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.get<{ Params: { id: string } }>("/api/local/agents/:id/logs", async (request, reply) => {
    if (deny(request, reply)) return reply;
    try {
      return { lines: supervisor!.logs(request.params.id) };
    } catch (error) {
      return fail(reply, error);
    }
  });
}
