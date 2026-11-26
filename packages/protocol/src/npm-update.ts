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
