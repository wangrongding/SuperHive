/**
 * hive agents / hive leave：查看、停止、重新上线、移除本机带到别人房间的 Agent（清单见 remote-joins.ts）。
 */
import { parseArgs } from "node:util";
import {
  findRecord,
  forgetRemoteJoin,
  leaveRemoteRoom,
  listRemoteJoins,
  readRecords,
  readToken,
  remoteJoinsDir,
  restartRemoteJoin,
  stopRemoteJoin,
  viewOf,
  waitForOnline,
  type RemoteJoinRecord,
  type RemoteJoinView,
} from "./remote-joins.js";

export const agentsUsage = `
用法：
  hive agents [--json]          列出本机带到别人房间的 Agent（服务器、房间、名字、运行时、进程、是否在线）
  hive agents start NAME|ID     重新上线（后台运行，沿用当初的参数）
  hive agents forget NAME|ID    从清单里删掉（不在线的才能删；在线的先 hive leave）
  hive leave NAME|ID            让它离线（进程退出，清单里保留，之后可以 hive agents start）
  hive leave NAME|ID --leave-room
                                离线并退出对方的房间（访客带入的 Agent），从清单里删掉
  hive leave --all [--leave-room]
                                全部离线
`;

const STATUS_LABEL: Record<RemoteJoinView["status"], string> = {
  online: "在线",
  connecting: "连接中",
  stopped: "已离线",
};

export function formatJoins(joins: RemoteJoinView[]): string {
  if (joins.length === 0) {
    return "本机还没有带到别人房间的 Agent。用 hive join --server … --background 带一个进去。";
  }
  const lines = joins.map((join) => {
    const room = join.roomId ? `#${join.roomId}` : "所有房间";
    const where = `${join.server} ${room}`;
    const process = join.pid
      ? `进程 ${join.pid}${join.background ? "（后台）" : "（前台终端）"}`
      : "";
    return [
      `${STATUS_LABEL[join.status]}  ${join.name}（${join.runtime}）  ${where}`,
      `    id ${join.id}${process ? `  ${process}` : ""}${join.logFile ? `  日志 ${join.logFile}` : ""}`,
      ...(join.status === "stopped" && join.lastError ? [`    上次退出：${join.lastError}`] : []),
    ].join("\n");
  });
  return lines.join("\n");
}

function requireRecord(dir: string, query: string | undefined): RemoteJoinRecord {
  if (!query) throw new Error(`缺少 Agent 名字或 id。${agentsUsage}`);
  const record = findRecord(dir, query);
  if (!record) throw new Error(`清单里没有 ${query}。用 hive agents 查看。`);
  return record;
}

export async function agentsCommand(args: string[], dir = remoteJoinsDir()): Promise<void> {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    options: { json: { type: "boolean", default: false }, help: { type: "boolean", short: "h" } },
  });
  if (parsed.values.help) {
    console.log(agentsUsage);
    return;
  }
  const [sub, query] = parsed.positionals;
  if (!sub || sub === "list") {
    const joins = listRemoteJoins(dir);
    console.log(parsed.values.json ? JSON.stringify({ joins }) : formatJoins(joins));
    return;
  }
  if (sub === "start") {
    const record = requireRecord(dir, query);
    const pid = await restartRemoteJoin(dir, record.id);
    const result = await waitForOnline(dir, record.id, pid, 30_000);
    if (result === "exited") {
      throw new Error(`${record.name} 启动后退出了，日志：${record.logFile ?? "（无）"}`);
    }
    console.log(
      result === "online"
        ? `[hive] ${record.name} 已重新上线（后台进程 ${pid}）。`
        : `[hive] ${record.name} 已在后台启动（进程 ${pid}），还在连接。`,
    );
    return;
  }
  if (sub === "forget" || sub === "remove") {
    const record = requireRecord(dir, query);
    if (viewOf(record).status !== "stopped") {
      throw new Error(`${record.name} 还在线，先运行 hive leave ${record.name}。`);
    }
    forgetRemoteJoin(dir, record.id);
    console.log(`[hive] 已从清单里删掉 ${record.name}。`);
    return;
  }
  throw new Error(`未知的子命令：“agents ${sub}”。${agentsUsage}`);
}

export type LeaveResult = { left: boolean; leaveError?: string };

/** 离线；leaveRoom 时再请对方 Server 把它移出房间，并从清单里删掉 */
export async function leaveOne(
  dir: string,
  record: RemoteJoinRecord,
  leaveRoom: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<LeaveResult> {
  await stopRemoteJoin(dir, record.id);
  if (!leaveRoom) return { left: false };
  const token = readToken(dir, record.id);
  const result = token
    ? await leaveRemoteRoom(record.server, token, fetchImpl)
    : ({ left: false, error: "没有记下这个 Agent 的 token" } as const);
  forgetRemoteJoin(dir, record.id);
  return result.left ? { left: true } : { left: false, leaveError: result.error };
}

export async function leaveCommand(args: string[], dir = remoteJoinsDir()): Promise<void> {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    options: {
      all: { type: "boolean", default: false },
      "leave-room": { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
  });
  if (parsed.values.help) {
    console.log(agentsUsage);
    return;
  }
  const leaveRoom = parsed.values["leave-room"];
  const targets = parsed.values.all
    ? readRecords(dir).filter((record) => leaveRoom || viewOf(record).status !== "stopped")
    : [requireRecord(dir, parsed.positionals[0])];
  if (targets.length === 0) {
    console.log("[hive] 没有在线的 Agent。");
    return;
  }
  for (const record of targets) {
    const result = await leaveOne(dir, record, leaveRoom);
    if (!leaveRoom) {
      console.log(`[hive] ${record.name} 已离线。重新上线：hive agents start ${record.name}`);
    } else if (result.left) {
      console.log(`[hive] ${record.name} 已离线并退出了 ${record.server} 的房间。`);
    } else {
      console.log(`[hive] ${record.name} 已离线，但没能退出房间：${result.leaveError}`);
    }
  }
}
