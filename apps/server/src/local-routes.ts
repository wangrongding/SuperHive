import { registerPluginLocalRoutes, type PluginRegistry } from "./plugins.js";
import {
  CLAUDE_COMPACT_WINDOW_DEFAULT,
  canOpenWithDefaultApp,
  serverText,
  zhText,
  type ServerText,
} from "@superhive/protocol";
import { errorText, hiveErrorBody } from "./texts.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  createLocalAgentRequestSchema,
  localAgentAutoUpdateSchema,
  localAgentProviderSchema,
  repairWorktreeRequestSchema,
  discardWorktreeRequestSchema,
  restartLocalAgentRequestSchema,
  updateLocalAgentSettingsRequestSchema,
  keepAwakeSettingsSchema,
  networkProxySettingsSchema,
  type NetworkProxySettings,
  type NetworkProxyState,
  type KeepAwakeSettings,
  type KeepAwakeState,
  type LocalAgent,
  type LocalSessionResponse,
  resumeCommand,
  roomClearRequestSchema,
  type RoomClearOptions,
  runtimeCredentialFieldSchema,
  runtimeCredentialProviderSchema,
  type RuntimeCredentialField,
  type RuntimeCredentialProvider,
  type SlowOperationsResponse,
  incidentActionRequestSchema,
  ruleProposalDecisionRequestSchema,
  updateIncidentSettingsRequestSchema,
  type Incident,
  type IncidentActionRequest,
  type IncidentSettings,
  type IncidentsResponse,
  type RuleProposal,
  type RuleProposalDecisionRequest,
  type UpdateIncidentSettingsRequest,
  updateRuntimeCredentialsRequestSchema,
} from "@superhive/protocol";
import QRCode from "qrcode";
import { HiveError } from "./database.js";
import { registerIncidentSecret } from "./incidents.js";
import { ProxySettingsError } from "./network-proxy.js";
import type { HostApproval, HostApprovals } from "./host-approvals.js";
import type { OwnerDevice } from "./owner-devices.js";
import { checkLocalRequest, type LocalCheck } from "./local-access.js";
import { listDirectories } from "./local-directories.js";
import { renderImMessage, type ImMessage } from "./im/im-texts.js";
import { openTerminal, openWithDefaultApp, revealInFolder } from "./open-terminal.js";
import { placeNamedCopy } from "./attachment-open.js";
import type { LocalAgentSupervisor } from "./local-agents.js";
import type { RuntimeCredentialStore } from "./runtime-credentials.js";
import { registerRuntimeConfigRoutes } from "./runtime-config-routes.js";
import type { SkillMarket } from "./skill-market.js";
import { RuntimeConfigStore } from "./runtime-config.js";
import type { AgentCliManager } from "./agent-clis.js";
import { registerAgentCliRoutes } from "./agent-cli-routes.js";
import { registerNpmUpdateRoutes } from "./npm-update-routes.js";
import type { NpmUpdates } from "./npm-updates.js";
import { registerRemoteJoinRoutes, type RunJoinCli } from "./remote-join-routes.js";

/**
 * 本机 Agent 的 HTTP 接口（管理 Hive Server 所在电脑）。请求方必须是下面两种之一：
 * 1. 本机房主：来自 Server 所在电脑（checkLocalRequest），且携带本次进程启动时生成的房主 token
 *    （X-Hive-Owner），它只经 /api/local/session 交给本机页面；
 * 2. 房主设备：房主扫码或经飞书登录的其他设备，Authorization 携带有效的设备令牌（hod_）。
 *    令牌放在请求头里，跨站页面带不上；可以单独退出。
 * 总令牌（join token）不算：Agent 也持有它，放行就等于远程 Agent 能在这台电脑上起进程。访客更不算。
 *
 * 接口分三级：
 * - read：只读（列目录、Agent 状态、MCP 列表、日志），登录的设备直接可用；
 * - manage：会在这台电脑上起进程或改设置。设备要先申请、经本机或可批准的 IM 账号批准，获批后 12 小时内可用，
 *   每次操作记审计日志并推到房主 IM；用完全权限起进程还要逐次批准（stepUp）；
 * - local：凭据类（生成登录二维码、显示总令牌、登记可批准的 IM 账号、运行时地址与密钥），只限本机。
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
  WHITEBOARD_CONFLICT: 409,
  WHITEBOARD_PROTECTED: 409,
  LOCAL_AGENT_MCP_UNSUPPORTED: 400,
  LOCAL_AGENT_EFFORT_UNSUPPORTED: 400,
  LOCAL_AGENT_CONTEXT_UNSUPPORTED: 400,
  LOCAL_AGENT_MCP_LIST_FAILED: 502,
  LOCAL_AGENT_BUSY: 409,
  LOCAL_AGENT_CONFIG_CHANGED: 409,
  RUNTIME_CREDENTIALS_NOT_EDITABLE: 409,
  RUNTIME_CREDENTIALS_UNREADABLE: 409,
  RUNTIME_CREDENTIALS_WRITE_FAILED: 500,
  WORKTREE_UNREGISTERED: 404,
  INCIDENT_NOT_FOUND: 404,
  INCIDENT_NOT_DISPATCHABLE: 409,
  INCIDENT_MEMBER_MISSING: 409,
  RULE_PROPOSAL_NOT_FOUND: 404,
  RULE_PROPOSAL_DECIDED: 409,
};

/** 批准单绑定的 Agent 配置：获批后权限、目录、模型、MCP 任一变化都不算同一件事 */
function configFingerprint(agent: LocalAgent): string {
  return JSON.stringify({
    provider: agent.provider,
    name: agent.name,
    access: agent.access,
    cwd: agent.cwd,
    model: agent.model,
    effort: agent.effort,
    compactWindow: agent.compactWindow,
    cacheTtl: agent.cacheTtl,
    mcpDisabled: [...agent.mcpDisabled].sort(),
  });
}

export type LocalCaller = { kind: "local" } | { kind: "device"; id: string; name: string };

/** read：只读；manage：会在这台电脑上起进程或改设置；local：凭据类，只限本机 */
type Level = "read" | "manage" | "local";

/** 设备获批后能管理这台电脑多久 */
export const MANAGE_GRANT_MS = 12 * 60 * 60_000;

const APPROVAL_HEADER = "x-hive-approval";

export type LocalRoomActions = {
  members?: {
    removedAgents(): import("@superhive/protocol").RemovedLocalAgent[];
    requireRemoved(id: string, name?: string): void;
    hide(id: string): void;
    /** 本机 Agent 删掉之后：它所在房间里自动设的主 Agent 顺延 */
    agentRemoved?(name: string): void;
  };
  worktrees?: {
    list: (roomId: string) => Promise<unknown>;
    cleanup: (
      roomId: string,
      input: { items: Array<{ id: string; headCommit: string }>; deleteBranch: boolean },
    ) => Promise<unknown>;
    configure: (roomId: string, autoCleanup: boolean) => void;
    request: (roomId: string, batchId: string) => boolean;
    /** 被换了分支的任务目录：切回登记分支，或按当前分支重新登记 */
    repair?: (roomId: string, id: string, action: "restore" | "adopt") => Promise<unknown>;
    /** 尚未合入的任务线丢弃前要给房主看的提交 */
    discardPreview?: (roomId: string, id: string) => Promise<unknown>;
    /** 房主确认后丢弃尚未合入的任务线；by 写进审计日志 */
    discard?: (
      roomId: string,
      id: string,
      headCommit: string,
      by: string,
    ) => Promise<{ branch: string; discarded: string[] }>;
  };
  /** 请求是否来自 Server 所在电脑；默认 checkLocalRequest（不放行别的端口上的网页） */
  isLocal?: (request: FastifyRequest) => LocalCheck;
  clearRoom: (
    roomId: string,
    username: string,
    options: RoomClearOptions,
  ) => { messages: number; invocations: number };
  /** 房主在其他设备上的登录 */
  ownerDevices?: {
    list(): OwnerDevice[];
    revoke(id: string): boolean;
    revokeAll(except?: string): string[];
    pair(): { ticket: string; expiresAt: string };
    webBase(): string | undefined;
    joinToken(): string;
    /** 设备令牌对应的设备；无效、已退出、超期或闲置过久时为 undefined */
    resolve(token: string): OwnerDevice | undefined;
  };
  /** 其他设备管理这台电脑要经过的批准 */
  approvals?: {
    store: HostApprovals;
    /** 把批准卡推到可批准的 IM 账号，返回推出去的数量（0 表示只能回本机批准） */
    send(approval: HostApproval, summaryText?: ImMessage): number;
    /** 有没有可批准的 IM 账号 */
    remote(): boolean;
    /** 批准或拒绝（本机网页和 IM 卡片共用）：manage 获批时给设备授予管理权 */
    decide(id: string, allow: boolean, by: string): HostApproval | undefined;
    /** 可以批准的 IM 账号：只能在本机登记 */
    approvers(): Array<{ connectionId: string; channel: string; label: string; allowed: boolean }>;
    setApprover(connectionId: string, allowed: boolean): boolean;
  };
  /** 房主设备上做了会在这台电脑上起进程、改设置的操作：推到房主 IM，便于发现设备被盗用 */
  notifyOwner?: (text: ImMessage) => void;
  /** Agent 在某个房间当前的 Provider 会话（Bridge 上报）；busy：这一轮还在执行 */
  agentSession?: (
    roomId: string,
    agentName: string,
  ) => { sessionId: string; cwd: string; busy: boolean } | undefined;
  /** 在这台电脑上开终端执行命令；测试里替换掉 */
  openTerminal?: (command: string) => Promise<void>;
  /** 房间工作区（或它的 worktree）里一个文件的真实路径；路径校验与只读浏览接口相同 */
  workspaceFile?: (roomId: string, source: string, path: string) => Promise<string>;
  /** 房间绑定的工作区目录（桌面端选附件时用作对话框起始目录）；房间不存在时抛 HiveError，没绑定时为 undefined */
  roomWorkspace?: (roomId: string) => string | undefined;
  /** 在文件管理器里选中文件；测试里替换掉 */
  revealInFolder?: (file: string) => Promise<void>;
  /** 用系统默认应用打开文件；测试里替换掉 */
  openWithDefaultApp?: (file: string) => Promise<void>;
  /** 房间里随消息发出、没撤回的附件；不在这个房间、还没发出或已撤回时抛 HiveError */
  roomAttachment?: (
    roomId: string,
    attachmentId: string,
  ) => { name: string; filePath: string; size: number; sha256: string };
  /** 附件按原文件名放副本的目录（<dir>/<roomId>/），本机打开和在访达中显示都用这份 */
  attachmentFilesDir?: string;
  /** 运行时（Claude Code、Codex）全局配置里的接口地址和密钥 */
  runtimeCredentials?: RuntimeCredentialStore;
  /** 从网上搜索、下载 skill；省略用真实网络（测试注入替身） */
  skillMarket?: SkillMarket;
  /** 本机装的 Agent CLI：检测版本与一键升级 */
  agentClis?: AgentCliManager;
  npmUpdates?: NpmUpdates;
  /** 最近的慢操作（锁、git、重查询、HTTP 请求）；只限本机 */
  slowOps?: () => SlowOperationsResponse;
  /** 插件原型：本机房主管理插件（列出、批准、撤销） */
  plugins?: PluginRegistry;
  /** 故障单、经验库、规则提议；只限本机（现场里有调用栈和仓库路径） */
  incidents?: {
    snapshot(): IncidentsResponse;
    updateSettings(patch: UpdateIncidentSettingsRequest): IncidentSettings;
    act(id: string, action: IncidentActionRequest["action"]): Incident;
    decide(id: string, decision: RuleProposalDecisionRequest["decision"], by: string): RuleProposal;
  };
  /** 网络代理：本机 Agent 子进程的代理环境变量 */
  networkProxy?: {
    state(): NetworkProxyState;
    update(patch: Partial<NetworkProxySettings>): NetworkProxyState;
  };
  /** 带到别人房间的 Agent 清单 */
  remoteJoins?: { dir: string; runJoinCli?: RunJoinCli };
  /** 熄屏后保持在线 */
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
  // 房主令牌：故障现场里出现原值就抹掉
  registerIncidentSecret(ownerToken);
  const ownerBuffer = Buffer.from(ownerToken);

  const hostLabel = hostname().replace(/\.local$/, "");
  const isLocal = rooms.isLocal ?? ((request: FastifyRequest) => checkLocalRequest(request));
  /** 带了设备令牌但无效（退出、超期）：直接拒绝，不能退回去按本机身份放行 */
  const staleDevice = (request: FastifyRequest, device: OwnerDevice | undefined) =>
    !device && Boolean(request.headers.authorization?.startsWith("Bearer hod_"));

  /** 带着有效设备令牌的请求：房主在其他设备上登录 */
  function deviceOf(request: FastifyRequest): OwnerDevice | undefined {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) return undefined;
    return rooms.ownerDevices?.resolve(header.slice(7));
  }

  function disabledSession(reason: ServerText): LocalSessionResponse {
    return { enabled: false, reason: zhText(reason), reasonText: reason };
  }

  function localSession(request: FastifyRequest, forUpdate = false): LocalSessionResponse {
    if (!supervisor && !(rooms.npmUpdates && forUpdate))
      return disabledSession(serverText("error.localAgent.disabled"));
    // 带着设备令牌来的按设备对待，即使页面开在这台电脑上：只下发和它身份相符的能力
    const device = deviceOf(request);
    if (staleDevice(request, device)) {
      return disabledSession(serverText("error.device.sessionInvalid"));
    }
    if (device) {
      return {
        enabled: true,
        mode: "device",
        deviceId: device.id,
        hostLabel,
        hostPlatform: process.platform,
        manageUntil: device.manageUntil,
        approval: rooms.approvals?.remote() ? "im" : "local",
      };
    }
    const check = isLocal(request);
    if (!check.local) return disabledSession(check.reason);
    return { enabled: true, mode: "local", ownerToken, hostLabel, hostPlatform: process.platform };
  }
  app.get("/api/local/session", async (request) => localSession(request));
  if (rooms.npmUpdates)
    app.get("/api/local/update/session", async (request) => localSession(request, true));

  /** 校验请求方能否调用这一级接口；不能时发出响应并返回 undefined */
  function authorize(
    request: FastifyRequest,
    reply: FastifyReply,
    level: Level,
    forUpdate = false,
  ): LocalCaller | undefined {
    if (!supervisor && !(rooms.npmUpdates && forUpdate && level === "local")) {
      void reply.code(404).send({ ...errorText(serverText("error.localAgent.disabled")) });
      return undefined;
    }
    const provided = request.headers[OWNER_HEADER];
    const device = deviceOf(request);
    if (staleDevice(request, device)) {
      void reply.code(401).send({
        ...errorText(serverText("error.device.sessionInvalid")),
        code: "DEVICE_SESSION_INVALID",
      });
      return undefined;
    }
    // 带了本机凭证就只按本机校验：设备令牌不能和本机凭证混用
    if (provided === undefined) {
      if (device) {
        if (level === "local") {
          void reply.code(403).send({
            ...errorText(serverText("error.device.localOnly")),
            code: "LOCAL_ONLY",
          });
          return undefined;
        }
        if (
          level === "manage" &&
          !(device.manageUntil && Date.parse(device.manageUntil) > Date.now())
        ) {
          void reply.code(403).send({
            ...errorText(serverText("error.device.manageRequired")),
            code: "MANAGE_REQUIRED",
          });
          return undefined;
        }
        return { kind: "device", id: device.id, name: device.name };
      }
    }
    const check = isLocal(request);
    if (!check.local) {
      void reply.code(403).send(errorText(check.reason));
      return undefined;
    }
    const buffer = Buffer.from(typeof provided === "string" ? provided : "");
    if (buffer.length !== ownerBuffer.length || !timingSafeEqual(buffer, ownerBuffer)) {
      void reply.code(401).send({ ...errorText(serverText("error.device.ownerCredential")) });
      return undefined;
    }
    return { kind: "local" };
  }

  /**
   * 单次高危操作（用完全权限起进程）：设备上每次都要批准。
   * 带着已批准、未用过、同一设备同一参数的批准单才放行；否则发起批准并回 403 APPROVAL_REQUIRED。
   */
  function stepUp(
    request: FastifyRequest,
    reply: FastifyReply,
    caller: LocalCaller,
    fingerprint: string,
    summaryText: ImMessage,
  ): boolean {
    const summary = renderImMessage("zh-CN", summaryText);
    if (caller.kind === "local") return true;
    const approvals = rooms.approvals;
    if (!approvals) {
      void reply.code(403).send({ ...errorText(serverText("error.device.localOnly")) });
      return false;
    }
    const presented = request.headers[APPROVAL_HEADER];
    if (
      typeof presented === "string" &&
      approvals.store.consume(presented, caller.id, fingerprint)
    ) {
      return true;
    }
    const approval = approvals.store.create({
      kind: "action",
      deviceId: caller.id,
      deviceName: caller.name,
      summary,
      fingerprint,
    });
    const delivered = approvals.send(approval, summaryText);
    void reply.code(403).send({
      ...errorText(
        serverText(delivered ? "error.approval.feishuRequired" : "error.approval.localRequired"),
      ),
      code: "APPROVAL_REQUIRED",
      approval,
      delivered,
    });
    return false;
  }

  /** 房主设备上的操作：记审计日志；notify 时再推一条到房主 IM */
  function audit(request: FastifyRequest, caller: LocalCaller, action: ImMessage, notify = false) {
    if (caller.kind !== "device") return;
    request.log.info(
      {
        ownerDevice: { id: caller.id, name: caller.name },
        action: renderImMessage("zh-CN", action),
      },
      "owner device action",
    );
    // 推到房主 IM 时按每个连接的语言渲染
    if (notify)
      rooms.notifyOwner?.({
        key: "im.audit.notice",
        params: { device: caller.name, host: hostLabel, action },
      });
  }

  function fail(reply: FastifyReply, error: unknown) {
    if (error instanceof HiveError && ERROR_STATUS[error.code]) {
      return reply.code(ERROR_STATUS[error.code]!).send(hiveErrorBody(error));
    }
    throw error;
  }

  app.get<{ Params: { roomId: string } }>(
    "/api/local/worktrees/:roomId",
    async (request, reply) => {
      if (!authorize(request, reply, "read")) return reply;
      if (!rooms.worktrees) return reply.code(404).send({ error: "Worktrees unavailable" });
      try {
        return await rooms.worktrees.list(request.params.roomId);
      } catch (error) {
        return reply
          .code(409)
          .send(error instanceof HiveError ? hiveErrorBody(error) : { error: String(error) });
      }
    },
  );
  app.post<{ Params: { roomId: string }; Body: unknown }>(
    "/api/local/worktrees/:roomId/cleanup",
    async (request, reply) => {
      const caller = authorize(request, reply, "manage");
      if (!caller) return reply;
      const input = z
        .object({
          items: z
            .array(
              z.object({
                id: z.string().uuid(),
                headCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
              }),
            )
            .min(1)
            .max(100),
          deleteBranch: z.boolean().default(true),
        })
        .safeParse(request.body);
      if (!input.success || !rooms.worktrees)
        return reply.code(400).send({ error: "Invalid worktree selection" });
      const result = await rooms.worktrees.cleanup(request.params.roomId, input.data);
      audit(
        request,
        caller,
        { key: "im.worktree.audit", params: { count: input.data.items.length } },
        true,
      );
      return result;
    },
  );
  app.post<{ Params: { roomId: string; id: string }; Body: unknown }>(
    "/api/local/worktrees/:roomId/items/:id/repair",
    async (request, reply) => {
      const caller = authorize(request, reply, "manage");
      if (!caller) return reply;
      const input = repairWorktreeRequestSchema.safeParse(request.body);
      const id = z.string().uuid().safeParse(request.params.id);
      if (!input.success || !id.success || !rooms.worktrees?.repair)
        return reply.code(400).send({ error: "Invalid worktree repair" });
      try {
        const status = await rooms.worktrees.repair(
          request.params.roomId,
          id.data,
          input.data.action,
        );
        audit(
          request,
          caller,
          { key: "im.worktree.repairAudit", params: { action: input.data.action } },
          true,
        );
        return { worktree: status };
      } catch (error) {
        if (!(error instanceof HiveError)) throw error;
        return reply.code(ERROR_STATUS[error.code] ?? 409).send(hiveErrorBody(error));
      }
    },
  );
  app.get<{ Params: { roomId: string; id: string } }>(
    "/api/local/worktrees/:roomId/items/:id/discard",
    async (request, reply) => {
      if (!authorize(request, reply, "read")) return reply;
      const id = z.string().uuid().safeParse(request.params.id);
      if (!id.success || !rooms.worktrees?.discardPreview)
        return reply.code(400).send({ error: "Invalid worktree" });
      try {
        return await rooms.worktrees.discardPreview(request.params.roomId, id.data);
      } catch (error) {
        if (!(error instanceof HiveError)) throw error;
        return reply.code(ERROR_STATUS[error.code] ?? 409).send(hiveErrorBody(error));
      }
    },
  );
  app.post<{ Params: { roomId: string; id: string }; Body: unknown }>(
    "/api/local/worktrees/:roomId/items/:id/discard",
    async (request, reply) => {
      const caller = authorize(request, reply, "manage");
      if (!caller) return reply;
      const input = discardWorktreeRequestSchema.safeParse(request.body);
      const id = z.string().uuid().safeParse(request.params.id);
      if (!input.success || !id.success || !rooms.worktrees?.discard)
        return reply.code(400).send({ error: "Invalid worktree discard" });
      try {
        const result = await rooms.worktrees.discard(
          request.params.roomId,
          id.data,
          input.data.headCommit,
          caller.kind === "device" ? `${caller.name}（房主设备）` : "本机房主",
        );
        audit(
          request,
          caller,
          {
            key: "im.worktree.discardAudit",
            params: { branch: result.branch, count: result.discarded.length },
          },
          true,
        );
        return result;
      } catch (error) {
        if (!(error instanceof HiveError)) throw error;
        return reply.code(ERROR_STATUS[error.code] ?? 409).send(hiveErrorBody(error));
      }
    },
  );
  app.post<{ Params: { roomId: string; batchId: string } }>(
    "/api/local/worktrees/:roomId/batches/:batchId",
    async (request, reply) => {
      if (!authorize(request, reply, "manage")) return reply;
      if (!rooms.worktrees?.request(request.params.roomId, request.params.batchId))
        return reply.code(409).send({ error: "Cleanup batch unavailable" });
      return { queued: true };
    },
  );
  app.put<{ Params: { roomId: string }; Body: unknown }>(
    "/api/local/worktrees/:roomId/settings",
    async (request, reply) => {
      const caller = authorize(request, reply, "manage");
      if (!caller) return reply;
      const input = z.object({ autoCleanup: z.boolean() }).safeParse(request.body);
      if (!input.success || !rooms.worktrees)
        return reply.code(400).send({ error: "Invalid cleanup settings" });
      rooms.worktrees.configure(request.params.roomId, input.data.autoCleanup);
      audit(
        request,
        caller,
        {
          key: "im.worktree.autoAudit",
          params: { enabled: String(input.data.autoCleanup) },
        },
        true,
      );
      return input.data;
    },
  );

  app.get("/api/local/owner-devices", async (request, reply) => {
    if (!authorize(request, reply, "read")) return reply;
    if (!rooms.ownerDevices)
      return reply.code(404).send({ ...errorText(serverText("error.feature.disabled")) });
    return { devices: rooms.ownerDevices.list() };
  });

  /** 退出一台设备：退出自己随时可以；退出别的设备要有管理权 */
  app.delete<{ Params: { id: string } }>("/api/local/owner-devices/:id", async (request, reply) => {
    const self = deviceOf(request)?.id === request.params.id;
    const caller = authorize(request, reply, self ? "read" : "manage");
    if (!caller) return reply;
    if (!rooms.ownerDevices?.revoke(request.params.id)) {
      return reply.code(404).send({ ...errorText(serverText("error.device.notFound")) });
    }
    rooms.approvals?.store.dropDevice(request.params.id);
    if (!self) audit(request, caller, { key: "im.audit.revokeOne" }, true);
    return { ok: true };
  });

  /** 全部退出：丢了设备时用。在设备上操作时保留它自己 */
  app.post("/api/local/owner-devices/revoke-all", async (request, reply) => {
    const caller = authorize(request, reply, "manage");
    if (!caller) return reply;
    const owner = rooms.ownerDevices;
    if (!owner) return reply.code(404).send({ ...errorText(serverText("error.feature.disabled")) });
    const revoked = owner.revokeAll(caller.kind === "device" ? caller.id : undefined);
    for (const id of revoked) rooms.approvals?.store.dropDevice(id);
    audit(
      request,
      caller,
      { key: "im.audit.revokeOthers", params: { count: revoked.length } },
      true,
    );
    return { revoked: revoked.length };
  });

  /* ---------- 其他设备申请管理这台电脑 ---------- */

  app.post("/api/local/manage-request", async (request, reply) => {
    const device = deviceOf(request);
    if (!device) {
      return reply
        .code(400)
        .send({ ...errorText(serverText("error.device.notADevice")), code: "NOT_A_DEVICE" });
    }
    if (!authorize(request, reply, "read")) return reply;
    const approvals = rooms.approvals;
    if (!approvals)
      return reply.code(404).send({ ...errorText(serverText("error.feature.disabled")) });
    const summaryText: ImMessage = {
      key: "im.host.request.manage",
      params: { device: device.name, host: hostLabel },
    };
    const approval = approvals.store.create({
      kind: "manage",
      deviceId: device.id,
      deviceName: device.name,
      summary: renderImMessage("zh-CN", summaryText),
    });
    return { approval, delivered: approvals.send(approval, summaryText) };
  });

  /** 设备查自己的申请批了没有；本机能查全部 */
  app.get<{ Params: { id: string } }>("/api/local/approvals/:id", async (request, reply) => {
    const caller = authorize(request, reply, "read");
    if (!caller) return reply;
    const approval = rooms.approvals?.store.get(request.params.id);
    if (!approval || (caller.kind === "device" && approval.deviceId !== caller.id)) {
      return reply.code(404).send({ ...errorText(serverText("error.approval.requestNotFound")) });
    }
    return { approval };
  });

  /** 本机网页：待批准的申请 */
  app.get("/api/local/approvals", async (request, reply) => {
    if (!authorize(request, reply, "local")) return reply;
    return { approvals: rooms.approvals?.store.pending() ?? [] };
  });

  app.post<{ Params: { id: string }; Body: { allow?: unknown } }>(
    "/api/local/approvals/:id/decision",
    async (request, reply) => {
      if (!authorize(request, reply, "local")) return reply;
      if (typeof request.body?.allow !== "boolean") {
        return reply.code(400).send({ ...errorText(serverText("error.request.invalid")) });
      }
      const approval = rooms.approvals?.decide(request.params.id, request.body.allow, "local");
      if (!approval)
        return reply.code(404).send({ ...errorText(serverText("error.approval.requestHandled")) });
      return { approval };
    },
  );

  /** 哪些 IM 账号可以在卡片上批准：登记本身只限本机 */
  app.get("/api/local/host-approvers", async (request, reply) => {
    if (!authorize(request, reply, "local")) return reply;
    return { approvers: rooms.approvals?.approvers() ?? [] };
  });

  app.put<{ Params: { connectionId: string }; Body: { allowed?: unknown } }>(
    "/api/local/host-approvers/:connectionId",
    async (request, reply) => {
      if (!authorize(request, reply, "local")) return reply;
      if (typeof request.body?.allowed !== "boolean") {
        return reply.code(400).send({ ...errorText(serverText("error.request.invalid")) });
      }
      if (!rooms.approvals?.setApprover(request.params.connectionId, request.body.allowed)) {
        return reply.code(404).send({ ...errorText(serverText("error.im.connectionNotFound")) });
      }
      return { approvers: rooms.approvals.approvers() };
    },
  );

  /** 在其他设备上登录：一次性链接和二维码，5 分钟内有效 */
  app.post<{ Body: { origin?: string } }>(
    "/api/local/owner-devices/pair",
    async (request, reply) => {
      if (!authorize(request, reply, "local")) return reply;
      const owner = rooms.ownerDevices;
      if (!owner)
        return reply.code(404).send({ ...errorText(serverText("error.feature.disabled")) });
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
    if (!authorize(request, reply, "local")) return reply;
    if (!rooms.ownerDevices)
      return reply.code(404).send({ ...errorText(serverText("error.feature.disabled")) });
    return { token: rooms.ownerDevices.joinToken() };
  });

  /* ---------- 运行时地址与密钥：只限本机房主，值不进日志 ---------- */

  /** 审计只记谁、何时、哪个运行时的哪一项，不记值 */
  function auditCredential(
    request: FastifyRequest,
    action: "view" | "update",
    provider: RuntimeCredentialProvider,
    fields: RuntimeCredentialField[],
  ) {
    request.log.info(
      { runtimeCredential: { by: "local-owner", ip: request.ip, action, provider, fields } },
      action === "view" ? "runtime credential revealed" : "runtime credential updated",
    );
  }

  /** 用这个运行时的本机 Agent：改完要重启它们才生效 */
  const agentsOf = (provider: RuntimeCredentialProvider) =>
    supervisor!
      .list()
      .filter((agent) => agent.provider === provider)
      .map((agent) => ({ id: agent.id, name: agent.name, status: agent.status }));
  /** 这些 Agent 的工作目录：检查项目级配置是否盖过了全局配置 */
  const contextOf = (provider: RuntimeCredentialProvider) => ({
    cwds: [
      ...new Set(
        supervisor!
          .list()
          .filter((agent) => agent.provider === provider && agent.cwd)
          .map((agent) => agent.cwd!),
      ),
    ],
  });

  app.get("/api/local/runtime-credentials", async (request, reply) => {
    if (!authorize(request, reply, "local")) return reply;
    const store = rooms.runtimeCredentials;
    if (!store) return reply.code(404).send({ ...errorText(serverText("error.feature.disabled")) });
    try {
      return {
        runtimes: store
          .list(contextOf)
          .map((runtime) => ({ ...runtime, agents: agentsOf(runtime.provider) })),
      };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post<{ Params: { provider: string }; Body: { field?: unknown } }>(
    "/api/local/runtime-credentials/:provider/reveal",
    async (request, reply) => {
      if (!authorize(request, reply, "local")) return reply;
      const store = rooms.runtimeCredentials;
      if (!store)
        return reply.code(404).send({ ...errorText(serverText("error.feature.disabled")) });
      const provider = runtimeCredentialProviderSchema.safeParse(request.params.provider);
      const field = runtimeCredentialFieldSchema.safeParse(request.body?.field);
      if (!provider.success || !field.success)
        return reply.code(400).send({ ...errorText(serverText("error.request.invalid")) });
      try {
        const value = store.reveal(provider.data, field.data);
        auditCredential(request, "view", provider.data, [field.data]);
        void reply.header("Cache-Control", "no-store");
        return { value };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.put<{ Params: { provider: string } }>(
    "/api/local/runtime-credentials/:provider",
    async (request, reply) => {
      if (!authorize(request, reply, "local")) return reply;
      const store = rooms.runtimeCredentials;
      if (!store)
        return reply.code(404).send({ ...errorText(serverText("error.feature.disabled")) });
      const provider = runtimeCredentialProviderSchema.safeParse(request.params.provider);
      const body = updateRuntimeCredentialsRequestSchema.safeParse(request.body);
      if (!provider.success || !body.success)
        return reply.code(400).send({ ...errorText(serverText("error.request.invalid")) });
      try {
        const runtime = store.update(provider.data, body.data, contextOf(provider.data));
        auditCredential(
          request,
          "update",
          provider.data,
          (["baseUrl", "apiKey"] as const).filter((field) => body.data[field] !== undefined),
        );
        return { runtime: { ...runtime, agents: agentsOf(provider.data) } };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  if (rooms.npmUpdates) {
    registerNpmUpdateRoutes(app, {
      manager: rooms.npmUpdates,
      authorizeLocal: (request, reply) => Boolean(authorize(request, reply, "local", true)),
    });
  }

  if (supervisor) {
    registerAgentCliRoutes(app, {
      manager: rooms.agentClis,
      supervisor,
      authorizeLocal: (request, reply) => Boolean(authorize(request, reply, "local")),
    });
    registerRuntimeConfigRoutes(app, {
      credentials: rooms.runtimeCredentials,
      supervisor,
      authorizeLocal: (request, reply) => Boolean(authorize(request, reply, "local")),
      ...(rooms.skillMarket ? { skillMarket: rooms.skillMarket } : {}),
    });
    if (rooms.remoteJoins) {
      registerRemoteJoinRoutes(app, {
        supervisor,
        authorize: (request, reply, level) => authorize(request, reply, level),
        dir: rooms.remoteJoins.dir,
        ...(rooms.remoteJoins.runJoinCli ? { runJoinCli: rooms.remoteJoins.runJoinCli } : {}),
      });
    }
  }

  if (rooms.plugins) {
    // 插件的 MCP 写进本机运行时的全局配置：和「Agent 运行时」设置页同一套读写（备份、原子替换）
    const runtimeConfig = rooms.runtimeCredentials
      ? new RuntimeConfigStore(rooms.runtimeCredentials)
      : undefined;
    rooms.plugins.setMcpWriter(
      runtimeConfig
        ? {
            put: (provider, entry, server) =>
              runtimeConfig.putMcp(provider, entry, { transport: "stdio", ...server }),
            remove: (provider, entry) => runtimeConfig.deleteMcp(provider, entry),
          }
        : undefined,
    );
    registerPluginLocalRoutes(app, {
      registry: rooms.plugins,
      authorizeLocal: (request, reply) => Boolean(authorize(request, reply, "local")),
      audit: (action, id, detail) =>
        app.log.info({ plugin: id, action, detail }, "plugin grant changed"),
    });
  }

  // 慢操作里有仓库路径、房间和调用来源：和运行时配置一样只给本机看
  app.get("/api/local/slow-ops", async (request, reply) => {
    if (!authorize(request, reply, "local")) return reply;
    if (!rooms.slowOps)
      return reply.code(404).send({ ...errorText(serverText("error.feature.disabled")) });
    return rooms.slowOps();
  });

  // 故障单的现场有调用栈、仓库路径和房间：和慢操作一样只给本机看、只在本机处理
  app.get("/api/local/incidents", async (request, reply) => {
    if (!authorize(request, reply, "local")) return reply;
    if (!rooms.incidents)
      return reply.code(404).send({ ...errorText(serverText("error.incident.disabled")) });
    return rooms.incidents.snapshot();
  });

  app.patch<{ Body: unknown }>("/api/local/incidents/settings", async (request, reply) => {
    if (!authorize(request, reply, "local")) return reply;
    if (!rooms.incidents)
      return reply.code(404).send({ ...errorText(serverText("error.incident.disabled")) });
    const body = updateIncidentSettingsRequestSchema.safeParse(request.body);
    if (!body.success)
      return reply.code(400).send({ ...errorText(serverText("error.request.invalid")) });
    try {
      return { settings: rooms.incidents.updateSettings(body.data) };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/local/incidents/:id/action",
    async (request, reply) => {
      if (!authorize(request, reply, "local")) return reply;
      if (!rooms.incidents)
        return reply.code(404).send({ ...errorText(serverText("error.incident.disabled")) });
      const body = incidentActionRequestSchema.safeParse(request.body);
      if (!body.success)
        return reply.code(400).send({ ...errorText(serverText("error.request.invalid")) });
      try {
        return { incident: rooms.incidents.act(request.params.id, body.data.action) };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/local/rule-proposals/:id/decision",
    async (request, reply) => {
      if (!authorize(request, reply, "local")) return reply;
      if (!rooms.incidents)
        return reply.code(404).send({ ...errorText(serverText("error.incident.disabled")) });
      const body = ruleProposalDecisionRequestSchema.safeParse(request.body);
      if (!body.success)
        return reply.code(400).send({ ...errorText(serverText("error.request.invalid")) });
      try {
        return {
          proposal: rooms.incidents.decide(request.params.id, body.data.decision, "local-owner"),
        };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.get("/api/local/keep-awake", async (request, reply) => {
    if (!authorize(request, reply, "read")) return reply;
    const state = rooms.keepAwake?.state();
    if (!state)
      return reply.code(404).send({ ...errorText(serverText("error.keepAwake.disabled")) });
    return state;
  });

  app.put("/api/local/keep-awake", async (request, reply) => {
    const caller = authorize(request, reply, "manage");
    if (!caller) return reply;
    const parsed = keepAwakeSettingsSchema.partial().safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ ...errorText(serverText("error.request.invalid")) });
    const patch = Object.fromEntries(
      Object.entries(parsed.data).filter(([, value]) => value !== undefined),
    ) as Partial<KeepAwakeSettings>;
    const state = rooms.keepAwake?.update(patch);
    if (!state)
      return reply.code(404).send({ ...errorText(serverText("error.keepAwake.disabled")) });
    audit(request, caller, { key: "im.audit.keepAwake" }, true);
    return state;
  });

  app.get("/api/local/network-proxy", async (request, reply) => {
    if (!authorize(request, reply, "read")) return reply;
    if (!rooms.networkProxy)
      return reply.code(404).send({ ...errorText(serverText("error.networkProxy.disabled")) });
    return rooms.networkProxy.state();
  });

  app.put("/api/local/network-proxy", async (request, reply) => {
    const caller = authorize(request, reply, "manage");
    if (!caller) return reply;
    if (!rooms.networkProxy)
      return reply.code(404).send({ ...errorText(serverText("error.networkProxy.disabled")) });
    const parsed = networkProxySettingsSchema.partial().safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ ...errorText(serverText("error.request.invalid")) });
    const patch = Object.fromEntries(
      Object.entries(parsed.data).filter(([, value]) => value !== undefined),
    ) as Partial<NetworkProxySettings>;
    try {
      const state = rooms.networkProxy.update(patch);
      audit(request, caller, { key: "im.audit.networkProxy" }, true);
      return state;
    } catch (error) {
      if (error instanceof ProxySettingsError)
        return reply.code(400).send({ ...errorText(serverText("error.networkProxy.invalid")) });
      throw error;
    }
  });

  app.get("/api/local/providers", async (request, reply) => {
    if (!authorize(request, reply, "read")) return reply;
    return { providers: await supervisor!.providers() };
  });

  app.get<{ Querystring: { path?: string } }>("/api/local/directories", async (request, reply) => {
    if (!authorize(request, reply, "read")) return reply;
    try {
      return listDirectories(request.query.path);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get("/api/local/agents", async (request, reply) => {
    if (!authorize(request, reply, "read")) return reply;
    const agents = supervisor!.list();
    const currentVersion = supervisor!.currentCodeVersion();
    return {
      agents,
      removedAgents: rooms.members?.removedAgents() ?? [],
      autoUpdate: supervisor!.autoUpdateEnabled(),
      ...(currentVersion ? { currentVersion } : {}),
    };
  });

  /** 自动更新开关：本机 Agent 落后于当前代码时，在空闲后自动重启 */
  app.put("/api/local/agents/auto-update", async (request, reply) => {
    const caller = authorize(request, reply, "manage");
    if (!caller) return reply;
    const parsed = localAgentAutoUpdateSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ ...errorText(serverText("error.request.invalid")) });
    supervisor!.setAutoUpdate(parsed.data.enabled);
    audit(request, caller, {
      key: parsed.data.enabled ? "im.audit.agentAutoUpdateOn" : "im.audit.agentAutoUpdateOff",
    });
    return { autoUpdate: supervisor!.autoUpdateEnabled() };
  });

  app.post("/api/local/agents", async (request, reply) => {
    const caller = authorize(request, reply, "manage");
    if (!caller) return reply;
    const parsed = createLocalAgentRequestSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ ...errorText(serverText("error.request.invalid")) });
    if (parsed.data.rejoinParticipantId) {
      if (!authorize(request, reply, "local")) return reply;
      try {
        if (!rooms.members)
          throw new HiveError("MEMBER_NOT_FOUND", serverText("error.member.notFound"));
        rooms.members.requireRemoved(parsed.data.rejoinParticipantId, parsed.data.name);
      } catch (error) {
        return fail(reply, error);
      }
    }
    if (
      parsed.data.access === "full" &&
      !stepUp(
        request,
        reply,
        caller,
        `create:${JSON.stringify(parsed.data)}`,
        parsed.data.cwd
          ? {
              key: "im.host.request.createFullIn",
              params: {
                name: parsed.data.name,
                provider: parsed.data.provider,
                cwd: parsed.data.cwd,
              },
            }
          : {
              key: "im.host.request.createFull",
              params: { name: parsed.data.name, provider: parsed.data.provider },
            },
      )
    ) {
      return reply;
    }
    try {
      const agent = supervisor!.create(parsed.data);
      audit(
        request,
        caller,
        {
          key: "im.audit.agentCreated",
          params: { name: agent.name, provider: agent.provider, access: agent.access },
        },
        true,
      );
      return reply.code(201).send({ agent });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/local/members/:id/hide", async (request, reply) => {
    if (!authorize(request, reply, "local")) return reply;
    if (!z.string().uuid().safeParse(request.params.id).success)
      return reply.code(400).send({ ...errorText(serverText("error.request.invalid")) });
    try {
      if (!rooms.members)
        throw new HiveError("MEMBER_NOT_FOUND", serverText("error.member.notFound"));
      rooms.members.requireRemoved(request.params.id);
      rooms.members.hide(request.params.id);
      return { ok: true };
    } catch (error) {
      return fail(reply, error);
    }
  });

  for (const action of ["start", "stop", "restart"] as const) {
    app.post<{ Params: { id: string } }>(
      `/api/local/agents/:id/${action}`,
      async (request, reply) => {
        const caller = authorize(request, reply, "manage");
        if (!caller) return reply;
        const id = request.params.id;
        // 重启默认等它手上的任务做完；when=now 立即重启（网页上要先确认）
        const restartWhen = restartLocalAgentRequestSchema.safeParse(request.body ?? undefined);
        if (action === "restart" && !restartWhen.success)
          return reply.code(400).send({ ...errorText(serverText("error.request.invalid")) });
        const now = restartWhen.success && restartWhen.data.when === "now";
        const target = supervisor!.list().find((agent) => agent.id === id);
        if (
          action !== "stop" &&
          target?.access === "full" &&
          !stepUp(
            request,
            reply,
            caller,
            // 绑定这次要执行的配置：获批后改了权限、目录、MCP，旧批准单就不算数
            `${action}:${id}:${configFingerprint(target)}`,
            {
              key: action === "start" ? "im.host.request.start" : "im.host.request.restart",
              params: { name: target.name },
            },
          )
        ) {
          return reply;
        }
        // 重启要先等旧进程退出：真正启动前再核对一次配置还是批准时那份
        const approved =
          caller.kind === "device" && target?.access === "full"
            ? configFingerprint(target)
            : undefined;
        try {
          const agent =
            action === "start"
              ? supervisor!.startAgent(id)
              : action === "stop"
                ? await supervisor!.stop(id)
                : await supervisor![now ? "restart" : "restartWhenIdle"](
                    id,
                    approved ? (current) => configFingerprint(current) === approved : undefined,
                  );
          const key = {
            start: "im.audit.agentStarted",
            stop: "im.audit.agentStopped",
            restart: "im.audit.agentRestarted",
          } as const;
          audit(
            request,
            caller,
            {
              key:
                action === "restart" && agent.restartWhenIdle
                  ? "im.audit.agentRestartQueued"
                  : key[action],
              params: { name: agent.name },
            },
            action !== "stop",
          );
          return { agent };
        } catch (error) {
          return fail(reply, error);
        }
      },
    );
  }

  /**
   * 接入前预览：某个 provider 在该目录下会加载的本机 MCP（只读配置）。
   * 估算开局 token 要真的连上各个 MCP（会起进程），走 POST …/measure，按 manage 校验。
   */
  async function mcpCandidates(
    request: FastifyRequest,
    reply: FastifyReply,
    input: { provider?: unknown; cwd?: unknown },
    measure: boolean,
  ) {
    const caller = authorize(request, reply, measure ? "manage" : "read");
    if (!caller) return reply;
    const provider = localAgentProviderSchema.safeParse(input.provider);
    if (!provider.success)
      return reply.code(400).send({ ...errorText(serverText("error.request.invalid")) });
    if (measure) audit(request, caller, { key: "im.audit.mcpMeasured" });
    try {
      return await supervisor!.mcpCandidates(
        provider.data,
        (typeof input.cwd === "string" && input.cwd.trim()) || undefined,
        measure,
      );
    } catch (error) {
      return fail(reply, error);
    }
  }

  app.get<{ Querystring: { provider?: string; cwd?: string } }>(
    "/api/local/mcp",
    (request, reply) => mcpCandidates(request, reply, request.query, false),
  );
  app.post<{ Body: { provider?: unknown; cwd?: unknown } }>(
    "/api/local/mcp/measure",
    (request, reply) => mcpCandidates(request, reply, request.body ?? {}, true),
  );

  /** 这个 Agent 会加载的本机 MCP；POST …/measure 时逐个连上估算开局 token（较慢，会起进程） */
  async function mcpServers(
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
    measure: boolean,
  ) {
    const caller = authorize(request, reply, measure ? "manage" : "read");
    if (!caller) return reply;
    if (measure) audit(request, caller, { key: "im.audit.mcpMeasured" });
    try {
      return await supervisor!.mcpServers(request.params.id, measure);
    } catch (error) {
      return fail(reply, error);
    }
  }

  app.get<{ Params: { id: string } }>("/api/local/agents/:id/mcp", (request, reply) =>
    mcpServers(request, reply, false),
  );
  app.post<{ Params: { id: string } }>("/api/local/agents/:id/mcp/measure", (request, reply) =>
    mcpServers(request, reply, true),
  );

  /** 运行时能用的模型：Agent 设置里选模型、失败任务上「换个模型重试」用；?refresh=1 重新拉 */
  app.get<{ Params: { id: string }; Querystring: { refresh?: string } }>(
    "/api/local/agents/:id/models",
    async (request, reply) => {
      const caller = authorize(request, reply, "read");
      if (!caller) return reply;
      try {
        return await supervisor!.models(request.params.id, request.query.refresh === "1");
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  /** 这个 Agent 在房间里的会话：能不能在终端里接着它、用什么命令 */
  function sessionFor(id: string, roomId: string | undefined) {
    const agent = supervisor!.get(id);
    const session = roomId ? rooms.agentSession?.(roomId, agent.name) : undefined;
    const command = session
      ? resumeCommand({
          provider: agent.provider,
          sessionId: session.sessionId,
          cwd: session.cwd,
          platform: process.platform,
        })
      : undefined;
    return { agent, session, command };
  }

  app.get<{ Params: { id: string }; Querystring: { roomId?: string } }>(
    "/api/local/agents/:id/session",
    async (request, reply) => {
      if (!authorize(request, reply, "read")) return reply;
      try {
        const { session, command } = sessionFor(request.params.id, request.query.roomId);
        return session && command
          ? {
              available: true,
              sessionId: session.sessionId,
              cwd: session.cwd,
              command,
              busy: session.busy,
            }
          : { available: false };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  /**
   * 在这台电脑上开终端，接着 Agent 在这个房间的同一个会话（只限本机）。
   * 它正在执行时不开：两边同时写一个会话会把上下文搅乱。
   */
  app.post<{ Params: { id: string }; Body: { roomId?: unknown; force?: unknown } }>(
    "/api/local/agents/:id/terminal",
    async (request, reply) => {
      const caller = authorize(request, reply, "local");
      if (!caller) return reply;
      const roomId = typeof request.body?.roomId === "string" ? request.body.roomId : undefined;
      try {
        const { agent, session, command } = sessionFor(request.params.id, roomId);
        if (!session || !command) {
          return reply.code(409).send({
            ...errorText(serverText("error.terminal.noSession", { agent: agent.name })),
            code: "SESSION_UNAVAILABLE",
          });
        }
        // 执行中也能打开（人想看它做到哪了），只是先提醒一次，确认后带 force 再来
        if (session.busy && request.body?.force !== true) {
          return reply.code(409).send({
            ...errorText(serverText("error.terminal.agentBusy", { agent: agent.name })),
            code: "AGENT_BUSY",
            command,
          });
        }
        await (rooms.openTerminal ?? openTerminal)(command);
        audit(request, caller, { key: "im.audit.terminalOpened", params: { name: agent.name } });
        return { opened: true, command };
      } catch (error) {
        if (error instanceof Error && !(error instanceof HiveError)) {
          return reply.code(500).send({ error: error.message, code: "TERMINAL_FAILED" });
        }
        return fail(reply, error);
      }
    },
  );

  /**
   * 产物和聊天里的附件：用本机应用打开，或在访达 / 资源管理器里选中（只限本机房主）。
   * 附件按 sha256 存，先按原文件名放一份副本再打开或选中，看到的是正常文件名。
   * 程序、脚本这类打开会运行代码的类型只能选中，不直接打开。审计只记谁、哪个房间、哪个附件、做了什么，不记内容。
   */
  app.post<{ Params: { roomId: string; attachmentId: string }; Body: { mode?: unknown } }>(
    "/api/local/rooms/:roomId/attachments/:attachmentId/open",
    async (request, reply) => {
      const caller = authorize(request, reply, "local");
      if (!caller) return reply;
      const mode = request.body?.mode;
      if (
        (mode !== "open" && mode !== "reveal") ||
        !rooms.roomAttachment ||
        !rooms.attachmentFilesDir
      )
        return reply.code(400).send({ ...errorText(serverText("error.request.invalid")) });
      const { roomId, attachmentId } = request.params;
      try {
        const item = rooms.roomAttachment(roomId, attachmentId);
        // 先按原名判断，免得放了副本才拒绝；放好后再按磁盘上的实际文件名核一次（系统按它决定用什么程序打开）
        const blocked = (name: string) => mode === "open" && !canOpenWithDefaultApp(name);
        if (blocked(item.name))
          throw new HiveError(
            "ATTACHMENT_OPEN_BLOCKED",
            serverText("error.attachment.openBlocked"),
          );
        const file = await placeNamedCopy(rooms.attachmentFilesDir, roomId, item).catch(
          (error: NodeJS.ErrnoException) => {
            // 附件库里的文件已被清理
            if (error.code === "ENOENT" && error.path === item.filePath)
              throw new HiveError("ATTACHMENT_GONE", serverText("error.attachment.gone"));
            throw error;
          },
        );
        if (blocked(path.basename(file)))
          throw new HiveError(
            "ATTACHMENT_OPEN_BLOCKED",
            serverText("error.attachment.openBlocked"),
          );
        await (mode === "open"
          ? (rooms.openWithDefaultApp ?? openWithDefaultApp)(file)
          : (rooms.revealInFolder ?? revealInFolder)(file));
        request.log.info(
          {
            attachmentFiles: {
              room: roomId,
              by: "local-owner",
              action: mode,
              attachment: attachmentId,
            },
          },
          "attachment opened on this computer",
        );
        return { opened: true, name: path.basename(file) };
      } catch (error) {
        if (error instanceof HiveError) {
          const status =
            {
              ATTACHMENT_OPEN_BLOCKED: 400,
              ATTACHMENT_REVOKED: 410,
              ATTACHMENT_GONE: 410,
            }[error.code] ?? 404;
          return reply.code(status).send(hiveErrorBody(error));
        }
        return reply.code(500).send({
          error: error instanceof Error ? error.message : String(error),
          code: "OPEN_FAILED",
        });
      }
    },
  );

  /**
   * 房间绑定的工作区目录（只限本机房主，要本机凭证）：桌面端主进程选附件时拿它当对话框的起始目录，
   * 不信网页传来的路径。只回路径本身，不列目录内容。
   */
  app.get<{ Params: { roomId: string } }>(
    "/api/local/rooms/:roomId/workspace",
    async (request, reply) => {
      if (!authorize(request, reply, "local")) return reply;
      if (!rooms.roomWorkspace)
        return reply.code(404).send({ ...errorText(serverText("error.feature.disabled")) });
      try {
        return { workspace: rooms.roomWorkspace(request.params.roomId) ?? null };
      } catch (error) {
        if (error instanceof HiveError) return reply.code(404).send(hiveErrorBody(error));
        throw error;
      }
    },
  );

  /**
   * 在这台电脑的访达 / 资源管理器里显示工作区里的文件（只限本机房主）：
   * 文件本来就在本机，没法在网页里预览的直接去文件夹里打开，不用再下载一份。只选中，不打开、不执行。
   */
  app.post<{ Params: { roomId: string }; Body: { source?: unknown; path?: unknown } }>(
    "/api/local/rooms/:roomId/workspace/reveal",
    async (request, reply) => {
      const caller = authorize(request, reply, "local");
      if (!caller) return reply;
      const source = typeof request.body?.source === "string" ? request.body.source : "workspace";
      const file = typeof request.body?.path === "string" ? request.body.path : "";
      if (!rooms.workspaceFile || !file)
        return reply.code(400).send({ ...errorText(serverText("error.request.invalid")) });
      try {
        const real = await rooms.workspaceFile(request.params.roomId, source, file);
        await (rooms.revealInFolder ?? revealInFolder)(real);
        request.log.info(
          {
            workspaceFiles: {
              room: request.params.roomId,
              by: "local-owner",
              action: "reveal",
              source,
              path: file,
            },
          },
          "workspace file revealed",
        );
        return { revealed: true };
      } catch (error) {
        if (error instanceof HiveError) {
          const status =
            error.code === "WORKSPACE_PATH_NOT_FOUND"
              ? 404
              : error.code.startsWith("WORKSPACE_")
                ? 400
                : 404;
          return reply.code(status).send(hiveErrorBody(error));
        }
        return reply.code(500).send({
          error: error instanceof Error ? error.message : String(error),
          code: "REVEAL_FAILED",
        });
      }
    },
  );

  app.put<{ Params: { id: string } }>("/api/local/agents/:id/settings", async (request, reply) => {
    const caller = authorize(request, reply, "manage");
    if (!caller) return reply;
    const parsed = updateLocalAgentSettingsRequestSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ ...errorText(serverText("error.request.invalid")) });
    try {
      const agent = supervisor!.updateSettings(request.params.id, parsed.data);
      const contextChanged =
        parsed.data.compactWindow !== undefined || parsed.data.cacheTtl !== undefined;
      if (contextChanged)
        audit(
          request,
          caller,
          {
            key: "im.audit.contextChanged",
            params: {
              name: agent.name,
              window: String(agent.compactWindow ?? CLAUDE_COMPACT_WINDOW_DEFAULT),
              ttl: agent.cacheTtl ?? "auto",
            },
          },
          true,
        );
      // 只改了上下文设置：上面已经记过
      if (
        contextChanged &&
        parsed.data.model === undefined &&
        parsed.data.effort === undefined &&
        parsed.data.mcpDisabled === undefined &&
        parsed.data.autoSteer === undefined
      )
        return { agent };
      // 模型和思考强度常在一次保存里一起改：各记一笔
      if (parsed.data.effort !== undefined && parsed.data.model !== undefined)
        audit(
          request,
          caller,
          agent.effort
            ? { key: "im.audit.effortChanged", params: { name: agent.name, effort: agent.effort } }
            : { key: "im.audit.effortDefault", params: { name: agent.name } },
          true,
        );
      audit(
        request,
        caller,
        parsed.data.model !== undefined
          ? agent.model
            ? { key: "im.audit.modelChanged", params: { name: agent.name, model: agent.model } }
            : { key: "im.audit.modelDefault", params: { name: agent.name } }
          : parsed.data.effort !== undefined
            ? agent.effort
              ? {
                  key: "im.audit.effortChanged",
                  params: { name: agent.name, effort: agent.effort },
                }
              : { key: "im.audit.effortDefault", params: { name: agent.name } }
            : {
                key:
                  parsed.data.mcpDisabled !== undefined
                    ? "im.audit.mcpChanged"
                    : parsed.data.autoSteer
                      ? "im.audit.autoSteerOn"
                      : "im.audit.autoSteerOff",
                params: { name: agent.name },
              },
        true,
      );
      return { agent };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/local/agents/:id", async (request, reply) => {
    const caller = authorize(request, reply, "manage");
    if (!caller) return reply;
    try {
      const name = supervisor!.list().find((agent) => agent.id === request.params.id)?.name;
      await supervisor!.remove(request.params.id);
      if (name) rooms.members?.agentRemoved?.(name);
      audit(
        request,
        caller,
        { key: "im.audit.agentDeleted", params: { name: name ?? request.params.id } },
        true,
      );
      return reply.code(204).send();
    } catch (error) {
      return fail(reply, error);
    }
  });

  /** 清空房间：不可恢复，和启动进程同级；房主设备上清空时推到 IM */
  app.post<{ Params: { roomId: string }; Body: { username?: unknown } }>(
    "/api/local/rooms/:roomId/clear",
    async (request, reply) => {
      const caller = authorize(request, reply, "manage");
      if (!caller) return reply;
      const username = request.body?.username;
      if (typeof username !== "string" || !username.trim()) {
        return reply.code(400).send({ ...errorText(serverText("error.request.missingActor")) });
      }
      const body = roomClearRequestSchema.safeParse(request.body);
      if (!body.success)
        return reply.code(400).send({ ...errorText(serverText("error.request.invalid")) });
      try {
        const { username: actor, ...options } = body.data;
        const removed = rooms.clearRoom(request.params.roomId, actor, options);
        audit(
          request,
          caller,
          { key: "im.audit.roomCleared", params: { room: request.params.roomId } },
          true,
        );
        return { removed };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.get<{ Params: { id: string } }>("/api/local/agents/:id/logs", async (request, reply) => {
    // 日志里可能有路径或密钥片段：设备上查看也记审计日志
    const caller = authorize(request, reply, "read");
    if (!caller) return reply;
    audit(request, caller, { key: "im.audit.logsViewed" });
    try {
      return { lines: supervisor!.logs(request.params.id) };
    } catch (error) {
      return fail(reply, error);
    }
  });
}
