import { z } from "zod";

/**
 * 带到别人房间的 Agent（设置 → 这台电脑 → 带到别处的 Agent）。
 *
 * 本机用 `hive join --server <别人的 Hive>` 运行的 Agent 会在 ~/.superhive/remote-joins/ 里各记一份：
 * CLI（hive agents / hive leave）和本机 Server（/api/local/remote-joins）读同一份清单。
 * 由本机 Hive Server 自己拉起、连本机 Server 的 Agent 不在这里，它们是「本机 Agent」。
 *
 * status：
 * - online：进程在，至少有一个房间连上了
 * - connecting：进程在，还没连上（刚启动，或对方 Server 断开后在重连）
 * - stopped：进程不在了（停止、关掉了前台终端、崩溃或电脑重启）
 */
export const remoteJoinStatusSchema = z.enum(["online", "connecting", "stopped"]);
export type RemoteJoinStatus = z.infer<typeof remoteJoinStatusSchema>;

export const remoteJoinSchema = z.object({
  /** 由 server + 房间 + 名字算出：重复运行同一条命令 id 不变 */
  id: z.string(),
  server: z.string(),
  /** null：加入对方的所有房间（hive join 不带 --room） */
  roomId: z.string().nullable(),
  name: z.string(),
  runtime: z.string(),
  access: z.string(),
  cwd: z.string().nullable(),
  model: z.string().nullable(),
  pid: z.number().int().nullable(),
  /** 是否后台运行（关掉终端也在线） */
  background: z.boolean(),
  status: remoteJoinStatusSchema,
  rooms: z.array(z.object({ roomId: z.string(), connected: z.boolean() })),
  startedAt: z.string(),
  updatedAt: z.string(),
  stoppedAt: z.string().nullable(),
  logFile: z.string().nullable(),
  /** 记得启动参数和 token，可以直接重新上线 */
  canRestart: z.boolean(),
  /** 最近一次退出的原因（日志尾部或连接错误） */
  lastError: z.string().nullable(),
});
export type RemoteJoin = z.infer<typeof remoteJoinSchema>;

const remoteJoinProviderSchema = z.enum([
  "codex",
  "claude",
  "copilot",
  "opencode",
  "omp",
  "openclaw",
  "gemini",
  "agy",
]);

export const createRemoteJoinRequestSchema = z
  .object({
    server: z.string().trim().url().max(2048),
    roomId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]+$/)
      .max(64)
      .optional(),
    name: z
      .string()
      .trim()
      .min(1)
      .max(32)
      .regex(/^[\p{L}\p{N}_.-]+$/u),
    token: z.string().trim().min(1).max(4096),
    /** 不填 agentId 时必填 */
    runtime: remoteJoinProviderSchema.optional(),
    access: z.enum(["read-only", "workspace", "full"]).optional(),
    /** workspace / full 必填：本机绝对路径 */
    cwd: z.string().trim().min(1).max(4096).optional(),
    model: z.string().trim().min(1).max(200).optional(),
    /** 沿用某个本机 Agent 的运行时、模型、工作目录和权限档（body 里填的优先） */
    agentId: z.string().uuid().optional(),
  })
  .refine((value) => value.runtime !== undefined || value.agentId !== undefined, {
    message: "runtime or agentId is required",
    path: ["runtime"],
  });
export type CreateRemoteJoinRequest = z.infer<typeof createRemoteJoinRequestSchema>;

export type RemoteJoinListResponse = { joins: RemoteJoin[] };
export type RemoteJoinResponse = { join: RemoteJoin };
export type RemoteJoinRemoveResponse = { removed: true; left: boolean; leaveError?: string };

/** 对方 Server：访客带入的 Agent 用自己的 token 退出房间（撤销自己的访客 Agent 会话） */
export type GuestAgentLeaveResponse = { left: true; roomId: string; username: string };
