import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { localizeServerPayload, serverError } from "./server-text";
import type {
  AgentCodeVersion,
  AgentCliInfo,
  AgentCliJob,
  AgentCliTool,
  CreateLocalAgentRequest,
  Incident,
  IncidentActionRequest,
  IncidentSettings,
  IncidentsResponse,
  KeepAwakeSettings,
  KeepAwakeState,
  NetworkProxySettings,
  NetworkProxyState,
  LocalAgent,
  LocalAgentsResponse,
  LocalAgentMcpResponse,
  LocalAgentModelsResponse,
  LocalAgentProvider,
  ClaudeCacheTtl,
  ClaudeCompactWindow,
  LocalDirectoryListing,
  LocalProviderInfo,
  LocalSessionResponse,
  RoomClearOptions,
  RuleProposal,
  RuleProposalDecisionRequest,
  RuntimeCredentialField,
  RuntimeCredentialProvider,
  RuntimeConfig,
  RuntimeCredentials,
  RuntimeMcpServerInput,
  UpdateIncidentSettingsRequest,
  UpdateRuntimeCredentialsRequest,
  WorktreeDiscardPreview,
  WorktreeStatus,
} from "@superhive/protocol";
import { localized, t } from "./i18n";
import { McpChecklist } from "./agent-settings-dialog";
import { agentBatchNames } from "./agent-name";
import { Stepper } from "./stepper";
import { Button } from "./button";

/**
 * 管理 Hive Server 所在电脑（本机 Agent、目录、保持在线…）：
 * - 页面就开在这台电脑上（local）：服务端下发进程房主凭证（X-Hive-Owner），全部可用；
 * - 房主在其他设备上登录（device）：凭设备令牌（Authorization）使用，查看直接可用；
 *   启动 Agent、改设置要先申请管理权（经本机或飞书批准），用完全权限起进程还要逐次批准。
 * 其他访问者看到的仍是"复制命令"。
 */

type AgentAction = "start" | "stop" | "restart";

/** 带 Agent 进别人房间的请求（字段与 remote-join-win 约定的 POST /api/local/remote-joins 一致） */
export type RemoteJoinRequest = {
  server: string;
  roomId?: string;
  name: string;
  token: string;
  /** 沿用这个本机 Agent 的运行时、模型、工作目录和权限档 */
  agentId?: string;
  /** 不沿用本机 Agent 时必填 */
  runtime?: string;
  /** 默认只读；workspace / full 时必须给 cwd */
  access?: "read-only" | "workspace" | "full";
  cwd?: string;
  model?: string;
};

export type LocalAgentsState = {
  worktrees(roomId: string): Promise<{
    worktrees: WorktreeStatus[];
    autoCleanup: boolean;
    cleanupBatch?: { id: string; count: number } | null;
  }>;
  cleanupWorktrees(
    roomId: string,
    input: { items: Array<{ id: string; headCommit: string }>; deleteBranch: boolean },
  ): Promise<{
    results: Array<{
      id: string;
      removed: boolean;
      branchDeleted?: boolean;
      branchError?: string;
      error?: string;
    }>;
  }>;
  configureWorktreeCleanup(roomId: string, autoCleanup: boolean): Promise<void>;
  cleanWorktreeBatch(roomId: string, batchId: string): Promise<void>;
  /** 被换了分支的任务目录：restore=切回登记分支，adopt=按当前分支重新登记 */
  repairWorktree(roomId: string, id: string, action: "restore" | "adopt"): Promise<void>;
  /** 尚未合入的任务线丢弃前要确认的提交 */
  worktreeDiscardPreview(roomId: string, id: string): Promise<WorktreeDiscardPreview>;
  /** 丢弃并删除尚未合入的任务线；headCommit 是确认时看到的分支提交，变了 Server 会拒绝 */
  discardWorktree(
    roomId: string,
    id: string,
    headCommit: string,
  ): Promise<{ branchDeleted: boolean; branchError?: string; discarded: string[] }>;
  /** undefined：还在确认；false：不是本机或房主设备，或服务端已关闭 */
  enabled: boolean | undefined;
  reason?: string | undefined;
  /** local：页面开在 Server 所在电脑上；device：房主登录的其他设备 */
  mode: "local" | "device" | undefined;
  /** Server 所在电脑的名字 */
  hostLabel: string | undefined;
  /** Server 所在电脑（本机 Agent 跑在这里）的平台，process.platform 的值；旧版 Server 不给 */
  hostPlatform: string | undefined;
  /** 房主设备模式下这台设备的 ID */
  deviceId: string | undefined;
  /** 能不能启动 Agent、改设置（本机总是可以；设备要获批） */
  canManage: boolean;
  manageUntil: string | null | undefined;
  /** 设备申请在哪里批准：im=飞书卡片（也可在本机）；local=只能到本机 */
  approvalVia: "im" | "local" | undefined;
  /** 设备申请管理权；返回申请，批准后 canManage 会变为 true */
  requestManage(): Promise<HostApproval>;
  /** 正在等批准的申请（管理权或单次操作） */
  waitingApproval: HostApproval | undefined;
  /** 本机：待批准的申请 */
  approvals: HostApproval[];
  decideApproval(id: string, allow: boolean): Promise<void>;
  /** 本机：哪些 IM 账号可以在卡片上批准 */
  hostApprovers(): Promise<HostApprover[]>;
  setHostApprover(connectionId: string, allowed: boolean): Promise<HostApprover[]>;
  revokeAllOwnerDevices(): Promise<number>;
  /** 本机：装了哪些 Agent CLI、版本、来源和升级命令；refresh 时重新探测 */
  agentClis(refresh?: boolean): Promise<{ tools: AgentCliWithAgents[]; job: AgentCliJob | null }>;
  /** 本机：执行页面确认过的升级命令（服务端重新算一遍，对不上不执行） */
  upgradeAgentCli(tool: AgentCliTool, command: string): Promise<AgentCliJob>;
  /** 本机：执行页面确认过的全局安装命令 */
  installAgentCli(tool: AgentCliTool, command: string): Promise<AgentCliJob>;
  /** 本机：正在跑（或最近一次）的安装、升级任务 */
  agentCliCurrent(): Promise<AgentCliJob | null>;
  agentCliJob(id: string): Promise<AgentCliJob>;
  providers: LocalProviderInfo[] | undefined;
  agents: LocalAgent[];
  /** 重新拉一次本机 Agent 列表（接入面板打开时另有定时刷新） */
  refreshAgents(): Promise<void>;
  /** 代码更新后在空闲时自动重启落后的本机 Agent；旧版 Server 不返回时为 undefined */
  autoUpdate: boolean | undefined;
  setAutoUpdate(enabled: boolean): Promise<void>;
  /** 本机 Agent 用的这份代码当前的版本 */
  currentVersion: AgentCodeVersion | undefined;
  create(request: CreateLocalAgentRequest): Promise<LocalAgent>;
  /**
   * 把本机 Agent 带进别人的房间：Server 在后台跑 `hive join`，清单在设置 →「这台电脑」里。
   * 接口由 remote-join-win 提供；旧版 Server 没有时抛 404 的 LocalApiError。
   */
  joinRemote(request: RemoteJoinRequest): Promise<{ id: string; status: string }>;
  /** 接入面板没开时也要知道装了哪些运行时（「带 Agent 加入」里选） */
  refreshProviders(): Promise<void>;
  /** restart 默认等它手上的任务做完再重启；now 立即重启（会中断正在做的任务，调用方先让人确认） */
  act(id: string, action: AgentAction, options?: { now?: boolean }): Promise<void>;
  /**
   * 在 Server 所在电脑上开终端，接着 Agent 在这个房间的同一个会话（只限本机）；
   * 返回执行的命令。还没有会话、正在执行或在别的设备上时抛错，错误里带 command 时可以复制手动运行。
   */
  openTerminal(id: string, roomId: string, force?: boolean): Promise<string>;
  /** 接着这个会话要运行的命令（在别的设备上复制到 Server 所在电脑运行）；没有会话时为 undefined */
  sessionCommand(id: string, roomId: string): Promise<string | undefined>;
  /** 在这台电脑的访达 / 资源管理器里选中工作区里的文件（只限本机） */
  revealWorkspaceFile(roomId: string, source: string, path: string): Promise<void>;
  /** 产物 / 聊天附件：按原文件名放一份副本，用本机应用打开或在访达里选中（只限本机） */
  openAttachment(roomId: string, attachmentId: string, mode: "open" | "reveal"): Promise<void>;
  remove(id: string): Promise<void>;
  logs(id: string): Promise<string[]>;
  directories(path?: string): Promise<LocalDirectoryListing>;
  /** 清空房间的消息和调用记录，默认同时归档白板；只有本机房主可用 */
  clearRoom(roomId: string, username: string, options?: RoomClearOptions): Promise<void>;
  /** Agent 会加载的本机 MCP；measure 时逐个连上估算开局 token */
  mcpServers(id: string, measure?: boolean): Promise<LocalAgentMcpResponse>;
  /** 接入前预览：provider 在该目录下会加载的本机 MCP */
  mcpCandidates(
    provider: LocalAgentProvider,
    cwd: string | undefined,
    measure?: boolean,
  ): Promise<LocalAgentMcpResponse>;
  updateSettings(
    id: string,
    settings: {
      mcpDisabled?: string[];
      autoSteer?: boolean;
      model?: string | null;
      effort?: string | null;
      compactWindow?: ClaudeCompactWindow | null;
      cacheTtl?: ClaudeCacheTtl | null;
    },
  ): Promise<LocalAgent>;
  /** 这个 Agent 的运行时能用的模型；refresh 时让 Server 重新拉 */
  models(id: string, refresh?: boolean): Promise<LocalAgentModelsResponse>;
  /** 熄屏后保持在线：这台电脑的设置与实际状态（不是本机房主时为 undefined） */
  keepAwake: KeepAwakeState | undefined;
  updateKeepAwake(patch: Partial<KeepAwakeSettings>): Promise<void>;
  /** 网络代理：本机 Agent 子进程走不走代理（设置 → 这台电脑） */
  networkProxy(): Promise<NetworkProxyState>;
  updateNetworkProxy(patch: Partial<NetworkProxySettings>): Promise<NetworkProxyState>;
  /** 本机：故障单、经验库、规则提议与派修设置 */
  incidents(): Promise<IncidentsResponse>;
  updateIncidentSettings(patch: UpdateIncidentSettingsRequest): Promise<IncidentSettings>;
  incidentAction(id: string, action: IncidentActionRequest["action"]): Promise<Incident>;
  decideRuleProposal(
    id: string,
    decision: RuleProposalDecisionRequest["decision"],
  ): Promise<RuleProposal>;
  /** 房主在其他设备上的登录 */
  ownerDevices(): Promise<OwnerDevice[]>;
  revokeOwnerDevice(id: string): Promise<void>;
  pairOwnerDevice(): Promise<{ url: string; expiresAt: string; qrDataUrl: string }>;
  ownerToken(): Promise<string>;
  /** 本机：运行时全局配置里的接口地址和密钥（打码），以及用这个运行时的本机 Agent */
  runtimeCredentials(): Promise<RuntimeCredentialsWithAgents[]>;
  /** 本机：确认后取完整值 */
  revealRuntimeCredential(
    provider: RuntimeCredentialProvider,
    field: RuntimeCredentialField,
  ): Promise<string | null>;
  updateRuntimeCredentials(
    provider: RuntimeCredentialProvider,
    input: UpdateRuntimeCredentialsRequest,
  ): Promise<RuntimeCredentialsWithAgents>;
  /** 本机：Agent CLI 的配置面板（附加项、行为、MCP、提示词、原始文件） */
  runtimeConfig(provider: RuntimeCredentialProvider): Promise<RuntimeConfigResult>;
  updateRuntimeFields(
    provider: RuntimeCredentialProvider,
    values: Record<string, string | boolean | null>,
  ): Promise<RuntimeConfigResult>;
  putRuntimeMcp(
    provider: RuntimeCredentialProvider,
    name: string,
    server: RuntimeMcpServerInput,
    previousName?: string,
  ): Promise<RuntimeConfigResult>;
  deleteRuntimeMcp(provider: RuntimeCredentialProvider, name: string): Promise<RuntimeConfigResult>;
  toggleRuntimeMcp(
    provider: RuntimeCredentialProvider,
    name: string,
    enabled: boolean,
  ): Promise<RuntimeConfigResult>;
  /** 整份原文（原始配置里有密钥，确认后才调） */
  readRuntimeFile(
    provider: RuntimeCredentialProvider,
    file: string,
  ): Promise<{ content: string; hash: string | null; exists: boolean }>;
  writeRuntimeFile(
    provider: RuntimeCredentialProvider,
    file: string,
    content: string,
    baseHash: string | null,
  ): Promise<RuntimeConfigResult & { hash: string | null }>;
};

export type RuntimeCredentialsWithAgents = RuntimeCredentials & {
  agents: Array<{ id: string; name: string; status: LocalAgent["status"] }>;
};

export type RuntimeConfigResult = {
  config: RuntimeConfig;
  agents: RuntimeCredentialsWithAgents["agents"];
};

export type AgentCliWithAgents = AgentCliInfo & {
  agents: Array<{ id: string; name: string; status: LocalAgent["status"] }>;
};

export type OwnerDevice = {
  id: string;
  name: string;
  source: "pair" | "im";
  createdAt: string;
  lastSeenAt: string;
  manageUntil: string | null;
};

export type HostApproval = {
  id: string;
  kind: "manage" | "action";
  deviceId: string;
  deviceName: string;
  summary: string;
  status: "pending" | "approved" | "denied" | "expired" | "used";
  createdAt: string;
  expiresAt: string;
};

export type HostApprover = {
  connectionId: string;
  channel: string;
  label: string;
  allowed: boolean;
};

/** 接口返回的错误：带上服务端的错误码和正文，便于按码处理（例如需要批准） */
export class LocalApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
    readonly body: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** 保持在线状态的刷新间隔（侧栏小月亮用） */
const KEEP_AWAKE_POLL_MS = 30_000;

const POLL_MS = 2_000;

async function readError(response: Response): Promise<LocalApiError> {
  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    // 非 JSON 响应
  }
  const message = serverError(body) ?? t("请求失败（{0}）", { 0: response.status });
  return new LocalApiError(
    message,
    response.status,
    typeof body.code === "string" ? body.code : undefined,
    body,
  );
}

const APPROVAL_POLL_MS = 2_000;
const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

/**
 * active 为 true（接入面板打开）时每 2 秒刷新状态；关闭后保留最后一次结果。
 * authToken 是这个页面的登录凭证：房主设备的令牌（hod_）用来在其他设备上管理 Server 所在电脑。
 */
export function useLocalAgents(
  base: string,
  active: boolean,
  authToken?: string,
): LocalAgentsState {
  const [session, setSession] = useState<LocalSessionResponse | undefined>();
  const [providers, setProviders] = useState<LocalProviderInfo[] | undefined>();
  const [agents, setAgents] = useState<LocalAgent[]>([]);
  const tokenRef = useRef<string | undefined>(undefined);
  const deviceToken = authToken?.startsWith("hod_") ? authToken : undefined;
  const deviceRef = useRef(deviceToken);
  deviceRef.current = deviceToken;

  const loadSession = useCallback(async () => {
    try {
      const response = await fetch(`${base}/api/local/session`, {
        ...(deviceToken ? { headers: { Authorization: `Bearer ${deviceToken}` } } : {}),
      });
      const value = response.ok
        ? localizeServerPayload((await response.json()) as LocalSessionResponse)
        : null;
      const resolved = value ?? { enabled: false as const, reason: t("无法确认是否在本机") };
      tokenRef.current =
        resolved.enabled && resolved.mode !== "device" ? resolved.ownerToken : undefined;
      setSession(resolved);
    } catch {
      setSession({ enabled: false, reason: t("无法连接 Hive Server") });
    }
  }, [base, deviceToken]);
  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  // 旧版 Server 不返回 mode：那时只有本机这一种
  const mode = session?.enabled ? (session.mode ?? "local") : undefined;
  const request = useCallback(
    async (path: string, init: RequestInit = {}, extra: Record<string, string> = {}) => {
      const response = await fetch(`${base}${path}`, {
        ...init,
        headers: {
          ...(mode === "device" && deviceRef.current
            ? { Authorization: `Bearer ${deviceRef.current}` }
            : { "X-Hive-Owner": tokenRef.current ?? "" }),
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...extra,
        },
      });
      if (!response.ok) {
        const error = await readError(response);
        // 设备被退出或会话过期：本机功能整体收起，停掉轮询
        if (error.code === "DEVICE_SESSION_INVALID") {
          setSession({ enabled: false, reason: error.message });
        }
        // 服务端说没有管理权（被拒、已过期、两边时钟不一致）：以服务端为准刷新
        if (error.code === "MANAGE_REQUIRED") void loadSession();
        throw error;
      }
      return response;
    },
    [base, mode, loadSession],
  );

  const worktrees = useCallback(
    async (roomId: string) => {
      const response = await request(`/api/local/worktrees/${encodeURIComponent(roomId)}`);
      return response.json();
    },
    [request],
  );
  const cleanupWorktrees = useCallback(
    async (
      roomId: string,
      input: { items: Array<{ id: string; headCommit: string }>; deleteBranch: boolean },
    ) => {
      const response = await request(`/api/local/worktrees/${encodeURIComponent(roomId)}/cleanup`, {
        method: "POST",
        body: JSON.stringify(input),
      });
      return response.json();
    },
    [request],
  );
  const configureWorktreeCleanup = useCallback(
    async (roomId: string, autoCleanup: boolean) => {
      await request(`/api/local/worktrees/${encodeURIComponent(roomId)}/settings`, {
        method: "PUT",
        body: JSON.stringify({ autoCleanup }),
      });
    },
    [request],
  );
  const cleanWorktreeBatch = useCallback(
    async (roomId: string, batchId: string) => {
      await request(
        `/api/local/worktrees/${encodeURIComponent(roomId)}/batches/${encodeURIComponent(batchId)}`,
        { method: "POST" },
      );
    },
    [request],
  );

  const repairWorktree = useCallback(
    async (roomId: string, id: string, action: "restore" | "adopt") => {
      await request(
        `/api/local/worktrees/${encodeURIComponent(roomId)}/items/${encodeURIComponent(id)}/repair`,
        { method: "POST", body: JSON.stringify({ action }) },
      );
    },
    [request],
  );

  const worktreeDiscardPreview = useCallback(
    async (roomId: string, id: string) => {
      const response = await request(
        `/api/local/worktrees/${encodeURIComponent(roomId)}/items/${encodeURIComponent(id)}/discard`,
      );
      return response.json();
    },
    [request],
  );
  const discardWorktree = useCallback(
    async (roomId: string, id: string, headCommit: string) => {
      const response = await request(
        `/api/local/worktrees/${encodeURIComponent(roomId)}/items/${encodeURIComponent(id)}/discard`,
        { method: "POST", body: JSON.stringify({ headCommit }) },
      );
      return response.json();
    },
    [request],
  );

  const [waitingApproval, setWaitingApproval] = useState<HostApproval>();
  // 页面卸载后不再轮询批准单
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  /** 等一张批准单出结果：批准返回 true，拒绝或过期返回 false */
  const awaitApproval = useCallback(
    async (approval: HostApproval): Promise<boolean> => {
      setWaitingApproval(approval);
      try {
        while (mountedRef.current) {
          await sleep(APPROVAL_POLL_MS);
          const response = await request(`/api/local/approvals/${approval.id}`);
          const current = ((await response.json()) as { approval: HostApproval }).approval;
          if (current.status !== "pending") return current.status === "approved";
        }
        return false;
      } finally {
        setWaitingApproval((current) => (current?.id === approval.id ? undefined : current));
      }
    },
    [request],
  );
  /** 需要逐次批准的操作：先试一次，要批准就等批准后带着批准单重发 */
  const requestApproved = useCallback(
    async (path: string, init: RequestInit): Promise<Response> => {
      try {
        return await request(path, init);
      } catch (error) {
        if (!(error instanceof LocalApiError) || error.code !== "APPROVAL_REQUIRED") throw error;
        const approval = error.body.approval as HostApproval;
        if (!(await awaitApproval(approval))) throw new Error(t("没有获得批准，操作已取消。"));
        return request(path, init, { "X-Hive-Approval": approval.id });
      }
    },
    [awaitApproval, request],
  );

  const [autoUpdate, setAutoUpdateState] = useState<boolean | undefined>();
  const [currentVersion, setCurrentVersion] = useState<AgentCodeVersion | undefined>();
  const refreshAgents = useCallback(async () => {
    const response = await request("/api/local/agents");
    const body = (await response.json()) as LocalAgentsResponse;
    setAgents(body.agents);
    setAutoUpdateState(body.autoUpdate);
    setCurrentVersion(body.currentVersion);
  }, [request]);
  const setAutoUpdate = useCallback(
    async (next: boolean) => {
      const response = await request("/api/local/agents/auto-update", {
        method: "PUT",
        body: JSON.stringify({ enabled: next }),
      });
      setAutoUpdateState(((await response.json()) as { autoUpdate: boolean }).autoUpdate);
    },
    [request],
  );

  const enabled = session?.enabled;
  useEffect(() => {
    if (!enabled) return;
    void refreshAgents().catch(() => undefined);
    if (!active) return;
    void request("/api/local/providers")
      .then((response) => response.json() as Promise<{ providers: LocalProviderInfo[] }>)
      .then((value) => setProviders(value.providers))
      .catch(() => undefined);
    const timer = window.setInterval(() => void refreshAgents().catch(() => undefined), POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, enabled, refreshAgents, request]);

  const refreshProviders = useCallback(async () => {
    const response = await request("/api/local/providers");
    setProviders(((await response.json()) as { providers: LocalProviderInfo[] }).providers);
  }, [request]);

  const create = useCallback(
    async (input: CreateLocalAgentRequest) => {
      const response = await requestApproved("/api/local/agents", {
        method: "POST",
        body: JSON.stringify(input),
      });
      const { agent } = (await response.json()) as { agent: LocalAgent };
      setAgents((current) => [...current.filter((item) => item.id !== agent.id), agent]);
      return agent;
    },
    [requestApproved],
  );

  const joinRemote = useCallback(
    async (input: RemoteJoinRequest) => {
      const response = await requestApproved("/api/local/remote-joins", {
        method: "POST",
        body: JSON.stringify(input),
      });
      const { join } = (await response.json()) as { join: { id: string; status: string } };
      return join;
    },
    [requestApproved],
  );

  const act = useCallback(
    async (id: string, action: AgentAction, options: { now?: boolean } = {}) => {
      const response = await requestApproved(`/api/local/agents/${id}/${action}`, {
        method: "POST",
        ...(action === "restart"
          ? { body: JSON.stringify({ when: options.now ? "now" : "idle" }) }
          : {}),
      });
      const { agent } = (await response.json()) as { agent: LocalAgent };
      setAgents((current) => current.map((item) => (item.id === id ? agent : item)));
    },
    [requestApproved],
  );

  const openTerminal = useCallback(
    async (id: string, roomId: string, force = false) => {
      const response = await request(`/api/local/agents/${id}/terminal`, {
        method: "POST",
        body: JSON.stringify({ roomId, ...(force ? { force } : {}) }),
      });
      return ((await response.json()) as { command: string }).command;
    },
    [request],
  );

  const revealWorkspaceFile = useCallback(
    async (roomId: string, source: string, path: string) => {
      await request(`/api/local/rooms/${encodeURIComponent(roomId)}/workspace/reveal`, {
        method: "POST",
        body: JSON.stringify({ source, path }),
      });
    },
    [request],
  );

  const openAttachment = useCallback(
    async (roomId: string, attachmentId: string, mode: "open" | "reveal") => {
      await request(
        `/api/local/rooms/${encodeURIComponent(roomId)}/attachments/${encodeURIComponent(attachmentId)}/open`,
        { method: "POST", body: JSON.stringify({ mode }) },
      );
    },
    [request],
  );

  const sessionCommand = useCallback(
    async (id: string, roomId: string) => {
      const response = await request(
        `/api/local/agents/${id}/session?roomId=${encodeURIComponent(roomId)}`,
      );
      const body = (await response.json()) as { available: boolean; command?: string };
      return body.available ? body.command : undefined;
    },
    [request],
  );

  const remove = useCallback(
    async (id: string) => {
      await request(`/api/local/agents/${id}`, { method: "DELETE" });
      setAgents((current) => current.filter((item) => item.id !== id));
    },
    [request],
  );

  const logs = useCallback(
    async (id: string) => {
      const response = await request(`/api/local/agents/${id}/logs`);
      return ((await response.json()) as { lines: string[] }).lines;
    },
    [request],
  );

  const directories = useCallback(
    async (target?: string) => {
      const query = target ? `?path=${encodeURIComponent(target)}` : "";
      const response = await request(`/api/local/directories${query}`);
      return (await response.json()) as LocalDirectoryListing;
    },
    [request],
  );

  const clearRoom = useCallback(
    async (roomId: string, username: string, options?: RoomClearOptions) => {
      await request(`/api/local/rooms/${encodeURIComponent(roomId)}/clear`, {
        method: "POST",
        body: JSON.stringify({ username, ...options }),
      });
    },
    [request],
  );

  const mcpServers = useCallback(
    async (id: string, measure = false) => {
      // 测量会在 Server 所在电脑上真的连上各个 MCP（起进程），走 POST
      const response = measure
        ? await request(`/api/local/agents/${id}/mcp/measure`, { method: "POST" })
        : await request(`/api/local/agents/${id}/mcp`);
      return (await response.json()) as LocalAgentMcpResponse;
    },
    [request],
  );

  const mcpCandidates = useCallback(
    async (provider: LocalAgentProvider, cwd: string | undefined, measure = false) => {
      const query = new URLSearchParams({ provider });
      if (cwd) query.set("cwd", cwd);
      const response = measure
        ? await request("/api/local/mcp/measure", {
            method: "POST",
            body: JSON.stringify({ provider, ...(cwd ? { cwd } : {}) }),
          })
        : await request(`/api/local/mcp?${query.toString()}`);
      return (await response.json()) as LocalAgentMcpResponse;
    },
    [request],
  );

  const models = useCallback(
    async (id: string, refresh = false) => {
      const response = await request(
        `/api/local/agents/${id}/models${refresh ? "?refresh=1" : ""}`,
      );
      const data = (await response.json()) as Partial<LocalAgentModelsResponse>;
      // 旧版 Server 不报思考强度：当作不支持
      return {
        ...data,
        source: data.source === "runtime" ? "runtime" : "preset",
        models: Array.isArray(data.models) ? data.models : [],
        efforts: Array.isArray(data.efforts) ? data.efforts : [],
      } satisfies LocalAgentModelsResponse;
    },
    [request],
  );

  const updateSettings = useCallback(
    async (
      id: string,
      settings: {
        mcpDisabled?: string[];
        autoSteer?: boolean;
        model?: string | null;
        effort?: string | null;
        compactWindow?: ClaudeCompactWindow | null;
        cacheTtl?: ClaudeCacheTtl | null;
      },
    ) => {
      const response = await request(`/api/local/agents/${id}/settings`, {
        method: "PUT",
        body: JSON.stringify(settings),
      });
      const { agent } = (await response.json()) as { agent: LocalAgent };
      setAgents((current) => current.map((item) => (item.id === id ? agent : item)));
      return agent;
    },
    [request],
  );

  const [keepAwake, setKeepAwake] = useState<KeepAwakeState | undefined>();
  const refreshKeepAwake = useCallback(async () => {
    const response = await request("/api/local/keep-awake");
    setKeepAwake((await response.json()) as KeepAwakeState);
  }, [request]);
  useEffect(() => {
    if (!enabled) return;
    void refreshKeepAwake().catch(() => setKeepAwake(undefined));
    const timer = window.setInterval(
      () => void refreshKeepAwake().catch(() => undefined),
      KEEP_AWAKE_POLL_MS,
    );
    return () => window.clearInterval(timer);
  }, [enabled, refreshKeepAwake]);
  const updateKeepAwake = useCallback(
    async (patch: Partial<KeepAwakeSettings>) => {
      const response = await request("/api/local/keep-awake", {
        method: "PUT",
        body: JSON.stringify(patch),
      });
      setKeepAwake((await response.json()) as KeepAwakeState);
    },
    [request],
  );

  /* ---------- 网络代理 ---------- */

  const networkProxy = useCallback(async () => {
    const response = await request("/api/local/network-proxy");
    return (await response.json()) as NetworkProxyState;
  }, [request]);
  const updateNetworkProxy = useCallback(
    async (patch: Partial<NetworkProxySettings>) => {
      const response = await request("/api/local/network-proxy", {
        method: "PUT",
        body: JSON.stringify(patch),
      });
      return (await response.json()) as NetworkProxyState;
    },
    [request],
  );

  /* ---------- 故障单（只限本机） ---------- */

  const incidents = useCallback(async () => {
    const response = await request("/api/local/incidents");
    return (await response.json()) as IncidentsResponse;
  }, [request]);
  const updateIncidentSettings = useCallback(
    async (patch: UpdateIncidentSettingsRequest) => {
      const response = await request("/api/local/incidents/settings", {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      return ((await response.json()) as { settings: IncidentSettings }).settings;
    },
    [request],
  );
  const incidentAction = useCallback(
    async (id: string, action: IncidentActionRequest["action"]) => {
      const response = await request(`/api/local/incidents/${encodeURIComponent(id)}/action`, {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      return ((await response.json()) as { incident: Incident }).incident;
    },
    [request],
  );
  const decideRuleProposal = useCallback(
    async (id: string, decision: RuleProposalDecisionRequest["decision"]) => {
      const response = await request(
        `/api/local/rule-proposals/${encodeURIComponent(id)}/decision`,
        { method: "POST", body: JSON.stringify({ decision }) },
      );
      return ((await response.json()) as { proposal: RuleProposal }).proposal;
    },
    [request],
  );

  const ownerDevices = useCallback(async () => {
    const response = await request("/api/local/owner-devices");
    return ((await response.json()) as { devices: OwnerDevice[] }).devices;
  }, [request]);
  const revokeOwnerDevice = useCallback(
    async (id: string) => {
      await request(`/api/local/owner-devices/${id}`, { method: "DELETE" });
    },
    [request],
  );
  const pairOwnerDevice = useCallback(async () => {
    const response = await request("/api/local/owner-devices/pair", {
      method: "POST",
      body: JSON.stringify({ origin: window.location.origin }),
    });
    return (await response.json()) as { url: string; expiresAt: string; qrDataUrl: string };
  }, [request]);
  const ownerToken = useCallback(async () => {
    const response = await request("/api/local/owner-token");
    return ((await response.json()) as { token: string }).token;
  }, [request]);
  const runtimeCredentials = useCallback(async () => {
    const response = await request("/api/local/runtime-credentials");
    return localizeServerPayload(
      ((await response.json()) as { runtimes: RuntimeCredentialsWithAgents[] }).runtimes,
    );
  }, [request]);
  const revealRuntimeCredential = useCallback(
    async (provider: RuntimeCredentialProvider, field: RuntimeCredentialField) => {
      const response = await request(`/api/local/runtime-credentials/${provider}/reveal`, {
        method: "POST",
        cache: "no-store",
        body: JSON.stringify({ field }),
      });
      return ((await response.json()) as { value: string | null }).value;
    },
    [request],
  );
  const updateRuntimeCredentials = useCallback(
    async (provider: RuntimeCredentialProvider, input: UpdateRuntimeCredentialsRequest) => {
      const response = await request(`/api/local/runtime-credentials/${provider}`, {
        method: "PUT",
        body: JSON.stringify(input),
      });
      return localizeServerPayload(
        ((await response.json()) as { runtime: RuntimeCredentialsWithAgents }).runtime,
      );
    },
    [request],
  );
  const agentClis = useCallback(
    async (refresh = false) => {
      const response = await request(`/api/local/agent-clis${refresh ? "?refresh=1" : ""}`);
      return localizeServerPayload(
        (await response.json()) as { tools: AgentCliWithAgents[]; job: AgentCliJob | null },
      );
    },
    [request],
  );
  const startAgentCli = useCallback(
    async (tool: AgentCliTool, action: "install" | "upgrade", command: string) => {
      const response = await request(`/api/local/agent-clis/${tool}/${action}`, {
        method: "POST",
        body: JSON.stringify({ command }),
      });
      return localizeServerPayload(((await response.json()) as { job: AgentCliJob }).job);
    },
    [request],
  );
  const upgradeAgentCli = useCallback(
    (tool: AgentCliTool, command: string) => startAgentCli(tool, "upgrade", command),
    [startAgentCli],
  );
  const installAgentCli = useCallback(
    (tool: AgentCliTool, command: string) => startAgentCli(tool, "install", command),
    [startAgentCli],
  );
  const agentCliCurrent = useCallback(async () => {
    const response = await request("/api/local/agent-clis/current");
    return localizeServerPayload(((await response.json()) as { job: AgentCliJob | null }).job);
  }, [request]);
  const agentCliJob = useCallback(
    async (id: string) => {
      const response = await request(`/api/local/agent-clis/jobs/${encodeURIComponent(id)}`);
      return localizeServerPayload(((await response.json()) as { job: AgentCliJob }).job);
    },
    [request],
  );
  const configRequest = useCallback(
    async (path: string, init: RequestInit = {}) => {
      const response = await request(`/api/local/runtime-config/${path}`, init);
      return localizeServerPayload((await response.json()) as RuntimeConfigResult);
    },
    [request],
  );
  const runtimeConfig = useCallback(
    (provider: RuntimeCredentialProvider) => configRequest(provider),
    [configRequest],
  );
  const updateRuntimeFields = useCallback(
    (provider: RuntimeCredentialProvider, values: Record<string, string | boolean | null>) =>
      configRequest(`${provider}/fields`, { method: "PUT", body: JSON.stringify({ values }) }),
    [configRequest],
  );
  const putRuntimeMcp = useCallback(
    (
      provider: RuntimeCredentialProvider,
      name: string,
      server: RuntimeMcpServerInput,
      previousName?: string,
    ) =>
      configRequest(`${provider}/mcp`, {
        method: "PUT",
        body: JSON.stringify({ name, server, ...(previousName ? { previousName } : {}) }),
      }),
    [configRequest],
  );
  const deleteRuntimeMcp = useCallback(
    (provider: RuntimeCredentialProvider, name: string) =>
      configRequest(`${provider}/mcp/${encodeURIComponent(name)}`, { method: "DELETE" }),
    [configRequest],
  );
  const toggleRuntimeMcp = useCallback(
    (provider: RuntimeCredentialProvider, name: string, enabled: boolean) =>
      configRequest(`${provider}/mcp/${encodeURIComponent(name)}/toggle`, {
        method: "POST",
        body: JSON.stringify({ enabled }),
      }),
    [configRequest],
  );
  const readRuntimeFile = useCallback(
    async (provider: RuntimeCredentialProvider, file: string) => {
      const response = await request(
        `/api/local/runtime-config/${provider}/files/${encodeURIComponent(file)}/read`,
        { method: "POST", cache: "no-store" },
      );
      return (await response.json()) as { content: string; hash: string | null; exists: boolean };
    },
    [request],
  );
  const writeRuntimeFile = useCallback(
    async (
      provider: RuntimeCredentialProvider,
      file: string,
      content: string,
      baseHash: string | null,
    ) => {
      const response = await request(
        `/api/local/runtime-config/${provider}/files/${encodeURIComponent(file)}`,
        { method: "PUT", body: JSON.stringify({ content, baseHash }) },
      );
      return localizeServerPayload(
        (await response.json()) as RuntimeConfigResult & { hash: string | null },
      );
    },
    [request],
  );
  const revokeAllOwnerDevices = useCallback(async () => {
    const response = await request("/api/local/owner-devices/revoke-all", { method: "POST" });
    return ((await response.json()) as { revoked: number }).revoked;
  }, [request]);

  /* ---------- 其他设备管理这台电脑：申请与批准 ---------- */

  const requestManage = useCallback(async () => {
    const response = await request("/api/local/manage-request", { method: "POST" });
    const { approval } = (await response.json()) as { approval: HostApproval };
    void awaitApproval(approval)
      .then(() => loadSession())
      .catch(() => undefined);
    return approval;
  }, [awaitApproval, loadSession, request]);

  // 本机页面：轮询待批准的申请，页面上直接弹出来
  const [approvals, setApprovals] = useState<HostApproval[]>([]);
  const refreshApprovals = useCallback(async () => {
    const response = await request("/api/local/approvals");
    setApprovals(((await response.json()) as { approvals: HostApproval[] }).approvals);
  }, [request]);
  useEffect(() => {
    if (mode !== "local") return;
    void refreshApprovals().catch(() => undefined);
    const timer = window.setInterval(
      () => void refreshApprovals().catch(() => undefined),
      APPROVAL_POLL_MS * 2,
    );
    return () => window.clearInterval(timer);
  }, [mode, refreshApprovals]);
  const decideApproval = useCallback(
    async (id: string, allow: boolean) => {
      await request(`/api/local/approvals/${id}/decision`, {
        method: "POST",
        body: JSON.stringify({ allow }),
      });
      await refreshApprovals();
    },
    [refreshApprovals, request],
  );
  const hostApprovers = useCallback(async () => {
    const response = await request("/api/local/host-approvers");
    return ((await response.json()) as { approvers: HostApprover[] }).approvers;
  }, [request]);
  const setHostApprover = useCallback(
    async (connectionId: string, allowed: boolean) => {
      const response = await request(`/api/local/host-approvers/${connectionId}`, {
        method: "PUT",
        body: JSON.stringify({ allowed }),
      });
      return ((await response.json()) as { approvers: HostApprover[] }).approvers;
    },
    [request],
  );

  // 管理权到期时刷新一次，界面回到「只能查看」
  const manageUntil =
    session?.enabled && session.mode === "device" ? session.manageUntil : undefined;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!manageUntil) return;
    const remaining = Date.parse(manageUntil) - Date.now();
    if (remaining <= 0) return;
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.min(remaining + 500, 2 ** 31 - 1),
    );
    return () => window.clearTimeout(timer);
  }, [manageUntil]);
  const canManage = mode === "local" || Boolean(manageUntil && Date.parse(manageUntil) > now);

  return {
    worktrees,
    cleanupWorktrees,
    configureWorktreeCleanup,
    cleanWorktreeBatch,
    repairWorktree,
    worktreeDiscardPreview,
    discardWorktree,
    enabled,
    reason: session && !session.enabled ? session.reason : undefined,
    mode,
    hostLabel: session?.enabled ? session.hostLabel : undefined,
    hostPlatform: session?.enabled ? session.hostPlatform : undefined,
    deviceId: session?.enabled && session.mode === "device" ? session.deviceId : undefined,
    canManage,
    manageUntil,
    approvalVia: session?.enabled && session.mode === "device" ? session.approval : undefined,
    requestManage,
    waitingApproval,
    approvals,
    decideApproval,
    hostApprovers,
    setHostApprover,
    revokeAllOwnerDevices,
    agentClis,
    upgradeAgentCli,
    installAgentCli,
    agentCliCurrent,
    agentCliJob,
    keepAwake,
    updateKeepAwake,
    networkProxy,
    updateNetworkProxy,
    incidents,
    updateIncidentSettings,
    incidentAction,
    decideRuleProposal,
    ownerDevices,
    revokeOwnerDevice,
    pairOwnerDevice,
    ownerToken,
    runtimeCredentials,
    revealRuntimeCredential,
    updateRuntimeCredentials,
    runtimeConfig,
    updateRuntimeFields,
    putRuntimeMcp,
    deleteRuntimeMcp,
    toggleRuntimeMcp,
    readRuntimeFile,
    writeRuntimeFile,
    providers,
    agents,
    refreshAgents,
    autoUpdate,
    setAutoUpdate,
    currentVersion,
    create,
    joinRemote,
    refreshProviders,
    act,
    openTerminal,
    sessionCommand,
    revealWorkspaceFile,
    openAttachment,
    remove,
    logs,
    directories,
    clearRoom,
    mcpServers,
    mcpCandidates,
    updateSettings,
    models,
  };
}

/**
 * 工作目录选择器：浏览器拿不到真实路径，所以由本机 Server 列目录。
 * 默认停在启动 Hive 的目录，可往上走、点进子目录，也可以直接手输（支持 ~）。
 */
/** 家目录开头的路径显示成 ~/...，避免长路径把选择器挤爆 */
function shortenPath(target: string, home: string): string {
  if (target === home) return "~";
  return target.startsWith(`${home}/`) ? `~${target.slice(home.length)}` : target;
}

export function DirectoryPicker({
  load,
  value,
  onPick,
  onClose,
}: {
  load: LocalAgentsState["directories"];
  value: string;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [listing, setListing] = useState<LocalDirectoryListing>();
  const [error, setError] = useState<string>();
  const browse = useCallback(
    (target?: string) => {
      setError(undefined);
      load(target).then(setListing, (cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      );
    },
    [load],
  );
  useEffect(() => browse(value || undefined), [browse, value]);

  return (
    <div className="directory-picker" role="group" aria-label={t("选择工作目录")}>
      <div className="directory-picker-bar">
        <Button
          size="sm"
          variant="ghost"
          disabled={!listing?.parent}
          aria-label={t("上一级目录")}
          onClick={() => listing?.parent && browse(listing.parent)}
        >
          {t("↑ 上一级")}
        </Button>
        <code title={listing?.path}>
          {listing ? shortenPath(listing.path, listing.defaults.home) : t("加载中…")}
        </code>
        {listing && (
          <>
            <Button size="sm" variant="ghost" onClick={() => browse(listing.defaults.launch)}>
              {t("Hive 目录")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => browse(listing.defaults.home)}>
              {t("家目录")}
            </Button>
          </>
        )}
      </div>
      {error && <p className="local-agent-error">{error}</p>}
      <ul className="directory-picker-list">
        {listing?.entries.map((entry) => (
          <li key={entry.path}>
            <button
              type="button"
              className="directory-picker-entry"
              onClick={() => browse(entry.path)}
            >
              {entry.name}
            </button>
          </li>
        ))}
        {listing && listing.entries.length === 0 && (
          <li className="directory-picker-empty">{t("（没有子目录）")}</li>
        )}
      </ul>
      {listing?.truncated && (
        <p className="directory-picker-empty">{t("子目录过多，只列出了前 500 个。")}</p>
      )}
      <div className="dialog-actions">
        <Button size="sm" onClick={onClose}>
          {t("取消")}
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={!listing}
          onClick={() => {
            if (listing) onPick(listing.path);
          }}
        >
          {t("选择当前目录")}
        </Button>
      </div>
    </div>
  );
}

export function providerInfo(
  local: LocalAgentsState,
  provider: string,
): LocalProviderInfo | undefined {
  return local.providers?.find((item) => item.provider === provider);
}

export const localAgentStatusLabels: Record<LocalAgent["status"], string> = localized(() => ({
  starting: t("启动中"),
  running: t("运行中"),
  restarting: t("重启中"),
  stopped: t("已停止"),
  crashed: t("已崩溃"),
}));

/** 本机 Agent 的最近日志，定时刷新 */
export function LogViewer({
  load: fetchLogs,
  agentId,
}: {
  load: LocalAgentsState["logs"];
  agentId: string;
}) {
  const [lines, setLines] = useState<string[] | undefined>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetchLogs(agentId).then(
        (value) => !cancelled && setLines(value),
        (cause: unknown) =>
          !cancelled && setError(cause instanceof Error ? cause.message : String(cause)),
      );
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [agentId, fetchLogs]);
  if (error) return <p className="local-agent-error">{error}</p>;
  return (
    <pre className="local-agent-logs" aria-label={t("最近日志")}>
      {lines === undefined ? t("加载中…") : lines.slice(-200).join("\n") || t("（暂无输出）")}
    </pre>
  );
}

/** 第 3 步：在本机启动；下方保留"复制命令"作为备选 */
/** 一次最多接入几个：再多就该考虑别的方式了，也避免手滑一次拉起几十个进程 */
const MAX_BATCH = 5;

export function LocalLaunch({
  local,
  provider,
  access,
  defaultName,
  takenNames,
  providerLabel,
  children,
  onLaunched,
}: {
  /** 房间里已有的成员名（小写）：一次接入多个时给后面几个自增取名用 */
  takenNames?: ReadonlySet<string>;
  /** 已经在本机启动：弹窗据此显示「完成」 */
  onLaunched?: () => void;
  local: LocalAgentsState;
  provider: LocalAgentProvider;
  access: "read-only" | "workspace" | "full";
  defaultName: string;
  providerLabel: string;
  /** 命令区块，折叠在"或复制命令"里 */
  children: ReactNode;
}) {
  const [name, setName] = useState(defaultName);
  // 用户手动改过名字后，自动建议（含重名自增）不再覆盖输入；切换 provider 时重新采用建议
  const nameEditedRef = useRef(false);
  const lastProviderRef = useRef(provider);
  const [cwd, setCwd] = useState("");
  const [picking, setPicking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const [launchedIds, setLaunchedIds] = useState<string[]>([]);
  // 一次接入几个同类 Agent（同样的权限、目录和 MCP 设置），名字按第一个往后自增
  const [count, setCount] = useState(1);
  useEffect(() => {
    if (provider !== lastProviderRef.current) {
      lastProviderRef.current = provider;
      nameEditedRef.current = false;
    }
    if (!nameEditedRef.current) setName(defaultName);
  }, [defaultName, provider]);
  // 默认用启动 Hive 服务的目录，省掉大多数情况下的输入
  const { directories } = local;
  useEffect(() => {
    if (access === "read-only") return;
    let cancelled = false;
    directories().then(
      (listing) => !cancelled && setCwd((current) => current || listing.defaults.launch),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [access, directories]);

  const info = providerInfo(local, provider);
  const launchedAgents = launchedIds
    .map((id) => local.agents.find((agent) => agent.id === id))
    .filter((agent): agent is NonNullable<typeof agent> => Boolean(agent));
  const batchNames = name.trim() ? agentBatchNames(name.trim(), count, takenNames) : [];

  // Claude Code / Codex 接入时就能选加载哪些本机 MCP，不必先接入再去设置里改
  const mcpSelectable = provider === "claude" || provider === "codex";
  const [mcpOpen, setMcpOpen] = useState(false);
  const [mcpData, setMcpData] = useState<LocalAgentMcpResponse | undefined>();
  const [mcpFailed, setMcpFailed] = useState(false);
  const [mcpMeasuring, setMcpMeasuring] = useState(false);
  const [mcpDisabled, setMcpDisabled] = useState<Set<string>>(() => new Set());
  const { mcpCandidates, canManage } = local;
  const mcpCwd = access === "read-only" ? undefined : cwd.trim() || undefined;
  useEffect(() => {
    if (!mcpSelectable || !mcpOpen) return;
    let cancelled = false;
    setMcpFailed(false);
    const load = async () => {
      try {
        const listed = await mcpCandidates(provider, mcpCwd);
        if (cancelled) return;
        setMcpData(listed);
        // 估算大小要在 Server 所在电脑上起进程：没有管理权的设备只列出来
        if (!canManage) return;
        setMcpMeasuring(true);
        const measured = await mcpCandidates(provider, mcpCwd, true);
        if (!cancelled) setMcpData(measured);
      } catch {
        if (!cancelled) setMcpFailed(true);
      } finally {
        if (!cancelled) setMcpMeasuring(false);
      }
    };
    // 手输目录时等停下来再读
    const timer = window.setTimeout(() => void load(), 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [canManage, mcpCandidates, mcpCwd, mcpOpen, mcpSelectable, provider]);

  const submit = async () => {
    setSubmitting(true);
    setError(undefined);
    const created: string[] = [];
    try {
      // 逐个创建：某一个失败（比如重名）就停下，已经启动的照常显示
      for (const agentName of batchNames) {
        const agent = await local.create({
          provider,
          name: agentName,
          access,
          ...(access === "read-only" ? {} : { cwd: cwd.trim() }),
          ...(mcpSelectable && mcpDisabled.size > 0 ? { mcpDisabled: [...mcpDisabled] } : {}),
        });
        created.push(agent.id);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (created.length) {
        setLaunchedIds(created);
        onLaunched?.();
      }
      setSubmitting(false);
    }
  };

  return (
    <div className="local-launch">
      {launchedAgents.length > 0 && (
        <div className="local-launch-results">
          {launchedAgents.map((launched) => (
            <div
              key={launched.id}
              className={`local-launch-result ${launched.status}`}
              role="status"
            >
              {launched.status === "running" ? (
                <p>
                  <strong>{launched.name}</strong> {t("已上线，在消息里输入")}{" "}
                  <code>@{launched.name}</code> {t("试试。")}
                </p>
              ) : launched.status === "crashed" ? (
                <p>
                  <strong>{launched.name}</strong> {t("启动失败：")}
                  {launched.lastError ?? t("请查看上方的日志")}
                </p>
              ) : (
                <p>
                  {t("正在启动")} <strong>{launched.name}</strong>
                  {t("…首次启动可能需要十几秒。")}
                </p>
              )}
            </div>
          ))}
          {error && (
            <p className="local-agent-error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
      {launchedAgents.length === 0 && (
        <form
          className="local-launch-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="local-launch-name-row">
            <label>
              <span>{t("名称")}</span>
              <input
                value={name}
                onChange={(event) => {
                  nameEditedRef.current = true;
                  setName(event.target.value);
                }}
                maxLength={32}
                required
                aria-label={t("Agent 名称")}
              />
            </label>
            <div className="local-launch-count">
              <span aria-hidden="true">{t("数量")}</span>
              <Stepper
                value={count}
                min={1}
                max={MAX_BATCH}
                onChange={setCount}
                label={t("一次接入几个")}
                disabled={submitting}
              />
            </div>
          </div>
          {count > 1 && batchNames.length > 1 && (
            <p className="local-launch-batch">
              {t("将依次启动：{0}", { 0: batchNames.join("、") })}
            </p>
          )}
          {access === "full" && (
            <p className="local-launch-warning" role="note">
              {t(
                "完全访问没有任何沙箱：Agent 可以执行你这个系统用户能做的一切，包括读写任意文件、运行命令和联网。",
              )}
            </p>
          )}
          {access !== "read-only" && (
            <div className="local-launch-cwd">
              <label>
                <span>{t("工作目录")}</span>
                <div className="local-launch-cwd-row">
                  <input
                    value={cwd}
                    onChange={(event) => setCwd(event.target.value)}
                    placeholder={t("默认使用启动 Hive 的目录，也可输入 ~/project")}
                    required
                    aria-label={t("工作目录")}
                  />
                  <Button aria-expanded={picking} onClick={() => setPicking((current) => !current)}>
                    {t("选择…")}
                  </Button>
                </div>
              </label>
              {picking && (
                <DirectoryPicker
                  load={local.directories}
                  value={cwd}
                  onPick={(picked) => {
                    setCwd(picked);
                    setPicking(false);
                  }}
                  onClose={() => setPicking(false)}
                />
              )}
            </div>
          )}
          {mcpSelectable && (
            <details
              className="local-launch-mcp"
              onToggle={(event) => setMcpOpen((event.currentTarget as HTMLDetailsElement).open)}
            >
              <summary>
                {mcpDisabled.size > 0
                  ? t("本机 MCP：已关闭 {0} 个", { 0: mcpDisabled.size })
                  : t("本机 MCP：全部加载（可选择）")}
              </summary>
              <McpChecklist
                data={mcpData}
                failed={mcpFailed}
                disabled={mcpDisabled}
                measuring={mcpMeasuring}
                busy={submitting}
                onToggle={(name) =>
                  setMcpDisabled((current) => {
                    const next = new Set(current);
                    if (next.has(name)) next.delete(name);
                    else next.add(name);
                    return next;
                  })
                }
              />
              {mcpFailed && <p className="agent-mcp-hint">{t("没能读取 MCP 列表。")}</p>}
            </details>
          )}
          {info && !info.installed && (
            <p className="local-agent-error">
              {local.mode === "device"
                ? t("{0} 上没有找到", { 0: local.hostLabel ?? t("Server 所在电脑") })
                : t("本机没有找到")}{" "}
              <code>{info.command}</code> {t("命令，请先安装")} {providerLabel} {t("并完成登录。")}
            </p>
          )}
          {error && (
            <p className="local-agent-error" role="alert">
              {error}
            </p>
          )}
          <Button
            type="submit"
            variant="primary"
            block
            disabled={
              submitting || !canManage || !name.trim() || (info !== undefined && !info.installed)
            }
          >
            {submitting
              ? t("正在启动…")
              : local.mode === "device"
                ? t("在 {0} 上启动", { 0: local.hostLabel ?? t("Server 所在电脑") })
                : t("在本机启动")}
            {!submitting && count > 1 ? ` ×${count}` : ""}
          </Button>
        </form>
      )}
      <details className="local-launch-command">
        <summary>{t("或复制命令，到其他终端运行")}</summary>
        {children}
      </details>
    </div>
  );
}
