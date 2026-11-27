export type NpmUpdateBlocker =
  "source" | "npx" | "desktop" | "permissions" | "external" | "installer";

export type NpmUpdateInfo = {
  current: string;
  latest: string | null;
  notes: string[];
  releaseUrl: string | null;
  canUpdate: boolean;
  blocker: NpmUpdateBlocker | null;
  manualCommand: string;
  busyAgents: string[];
  canHandover: boolean;
  /** 手动检查（refresh）时没连上 npm 源：latest 是上次缓存的结果，不能据此说「已是最新」 */
  checkFailed?: boolean;
};

/** GET /api/update：所有登录的人都能看的新版摘要；房主带 ?refresh=1 时绕开缓存马上查一次 */
export type NpmUpdateCheckResponse = {
  update: Pick<NpmUpdateInfo, "current" | "latest" | "notes" | "releaseUrl"> | null;
  /** 这个 Server 现在的版本（老 Server 没有） */
  current?: string;
  /** 为什么不能在网页里直接更新；source=从源码运行 */
  blocker?: NpmUpdateBlocker | null;
  /** 这次没查到（断网、npm 源出错） */
  failed?: boolean;
  /** 这个 Server 不在网页里查新版：desktop=桌面客户端运行的 Hive，unsupported=沙盒或找不到 CLI */
  unavailable?: "desktop" | "unsupported";
};

export type NpmUpdateChoice = "wait" | "now";
export type NpmUpdateJob = {
  id: string;
  target: string;
  previous: string;
  phase: "installing" | "waiting" | "restarting" | "rolling_back" | "completed" | "failed";
  startedAt: number;
  updatedAt: number;
  workerPid?: number;
  error?: string;
  rolledBack?: boolean;
};
