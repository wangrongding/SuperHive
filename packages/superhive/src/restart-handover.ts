import { createRequire } from "node:module";
import { createInterface } from "node:readline/promises";

/**
 * hive restart / hive update 的换代交接：旧 Server 退出时不结束本机 Agent，新 Server 起来后按进程号接管，
 * 正在跑的任务不中断、回复照常送达。做不到交接时（旧版 Server、换了端口等），先看有没有本机 Agent
 * 正在干活：有就等它们空闲再重启，或者由用户确认中断；--force 直接重启。
 */

/** 本机 Agent 的进程跟数据库里的进程号：新 Server 接管后进程号不变 */
export type LocalAgentProcess = { name: string; pid: number };

export type LocalAgentSnapshot = {
  /** 在运行（有进程号）的本机 Agent */
  running: LocalAgentProcess[];
  /** 其中手上有任务的（排队、执行中、停止中、提问后本轮没结束），名字按原样 */
  busy: string[];
};

type Statement = { all(...params: unknown[]): unknown[] };
type SqliteDatabase = { prepare(sql: string): Statement; close(): void };
type SqliteConstructor = new (
  file: string,
  options: { readonly: boolean; fileMustExist: boolean },
) => SqliteDatabase;

/**
 * 直接只读打开 Server 的数据库看本机 Agent 忙不忙：任何版本的 Server 都适用（旧版没有查询接口）。
 * 打不开（没装 better-sqlite3、库还没建、表结构对不上）返回 undefined，表示不知道。
 */
export function readLocalAgents(databasePath: string): LocalAgentSnapshot | undefined {
  let Database: SqliteConstructor;
  try {
    Database = createRequire(import.meta.url)("better-sqlite3") as SqliteConstructor;
  } catch {
    return undefined;
  }
  let db: SqliteDatabase | undefined;
  try {
    db = new Database(databasePath, { readonly: true, fileMustExist: true });
    const running = (
      db.prepare("SELECT name, pid FROM local_agents WHERE pid IS NOT NULL").all() as Array<{
        name: string;
        pid: number;
      }>
    ).map((row) => ({ name: row.name, pid: row.pid }));
    const busyKeys = new Set(
      (
        db
          .prepare(
            `SELECT DISTINCT agent_name AS name FROM invocations
               WHERE status IN ('queued', 'running', 'cancelling')
                  OR (status = 'waiting_human' AND finished_at IS NULL)`,
          )
          .all() as Array<{ name: string }>
      ).map((row) => row.name.toLocaleLowerCase()),
    );
    return {
      running,
      busy: running
        .map((agent) => agent.name)
        .filter((name) => busyKeys.has(name.toLocaleLowerCase())),
    };
  } catch {
    return undefined;
  } finally {
    try {
      db?.close();
    } catch {
      // 关不掉也不影响重启
    }
  }
}

export type HandoverCheck = {
  /** 正在运行的 Server 的 /health 里有 handover: true（新版 Server，且开着本机 Agent） */
  serverSupports: boolean;
  /** 能经 POST /api/local/shutdown 请 Server 自己退出（有口令） */
  canAskShutdown: boolean;
  previous: { host: string; port: number; localAgentsOff: boolean };
  next: { host: string; port: number; localAgentsOff: boolean };
  /** 这次重启换了 Join Token：Agent 带着旧令牌连不上新 Server */
  tokenChanged: boolean;
};

/** 不能交接的原因；能交接返回 undefined */
export function handoverBlocker(check: HandoverCheck): string | undefined {
  if (!check.canAskShutdown || !check.serverSupports)
    return "正在运行的 Server 是旧版本，不支持把本机 Agent 交给新 Server";
  if (check.next.localAgentsOff) return "重启后关闭了本机 Agent";
  if (check.next.port !== check.previous.port || check.next.host !== check.previous.host)
    return "重启后换了监听地址或端口，本机 Agent 连不回来";
  if (check.tokenChanged) return "重启时换了 Join Token，本机 Agent 带着旧令牌连不上";
  return undefined;
}

/** 等这些 Agent 都空闲：每隔 intervalMs 查一次，名单变了就打印；超时返回还在忙的名单 */
export async function waitForIdle(
  readBusy: () => string[] | undefined,
  options: {
    timeoutMs: number;
    intervalMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    log?: (line: string) => void;
  },
): Promise<string[]> {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = options.log ?? ((line: string) => console.log(line));
  const deadline = now() + options.timeoutMs;
  let last = "";
  for (;;) {
    // 查不到（数据库暂时锁住等）当作还在忙，下一次再看
    const busy = readBusy();
    if (busy && busy.length === 0) return [];
    const key = busy ? busy.join("、") : "";
    if (busy && key !== last) {
      log(`[hive] 等待 ${key} 手上的任务做完…（Ctrl+C 取消，不会重启）`);
      last = key;
    }
    if (now() >= deadline) return busy ?? ["（未知）"];
    await sleep(options.intervalMs ?? 2_000);
  }
}

export type BusyChoice = "wait" | "now" | "cancel";

/** 终端里问用户：回车等空闲再重启（默认、最稳），f 立即重启，n 取消 */
export async function askBusyChoice(busy: string[], reason: string): Promise<BusyChoice> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`[hive] ${reason}。`);
    console.log(
      `[hive] 有 ${busy.length} 个本机 Agent 正在干活：${busy.join("、")}。现在重启会中断它们手上的任务。`,
    );
    const answer = (
      await rl.question("[hive] 回车 = 等它们做完再重启；f = 立即重启（中断任务）；n = 取消：")
    )
      .trim()
      .toLowerCase();
    return parseBusyChoice(answer);
  } finally {
    rl.close();
  }
}

export function parseBusyChoice(answer: string): BusyChoice {
  const value = answer.trim().toLowerCase();
  if (value === "" || value === "w" || value === "wait") return "wait";
  if (value === "f" || value === "force" || value === "y" || value === "yes") return "now";
  return "cancel";
}
