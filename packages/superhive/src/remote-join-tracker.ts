/**
 * join 进程自己维护清单里的那一条（见 remote-joins.ts）：启动时登记、定时心跳、连上 / 断开时更新、
 * 发现停止请求就正常离线退出、退出时标成已停止。由本机 Hive Server 拉起的本机 Agent 不登记。
 */
import {
  HEARTBEAT_MS,
  clearStopRequest,
  readRecord,
  recordRunning,
  remoteJoinId,
  stopRequested,
  updateRecord,
  writeRecord,
  writeToken,
  type RemoteJoinRecord,
} from "./remote-joins.js";

export type TrackerInput = {
  dir: string;
  server: string;
  roomId: string | null;
  name: string;
  runtime: string;
  access: string;
  cwd: string | null;
  model: string | null;
  token: string;
  background: boolean;
  logFile: string | null;
  launch: RemoteJoinRecord["launch"];
  pid?: number;
  now?: () => Date;
};

export class RemoteJoinTracker {
  readonly id: string;
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;
  private lastError: string | null = null;
  private readonly pid: number;
  private readonly now: () => Date;

  constructor(private readonly input: TrackerInput) {
    this.id = remoteJoinId(input.server, input.roomId, input.name);
    this.pid = input.pid ?? process.pid;
    this.now = input.now ?? (() => new Date());
  }

  /** 同一个 Agent（同 Server、房间、名字）已经有进程在跑：两个进程抢同一个名字会互相顶掉 */
  runningElsewhere(): RemoteJoinRecord | undefined {
    const existing = readRecord(this.input.dir, this.id);
    return existing && existing.pid !== this.pid && recordRunning(existing) ? existing : undefined;
  }

  /** 登记并开始心跳；发现停止请求时调用 onStopRequested（只调一次） */
  start(onStopRequested: () => void): void {
    const at = this.now().toISOString();
    const previous = readRecord(this.input.dir, this.id);
    clearStopRequest(this.input.dir, this.id);
    writeToken(this.input.dir, this.id, this.input.token);
    writeRecord(this.input.dir, {
      version: 1,
      id: this.id,
      server: this.input.server,
      roomId: this.input.roomId,
      name: this.input.name,
      runtime: this.input.runtime,
      access: this.input.access,
      cwd: this.input.cwd,
      model: this.input.model,
      pid: this.pid,
      background: this.input.background,
      startedAt: at,
      updatedAt: at,
      stoppedAt: null,
      // 前台运行时没有单独的日志文件；保留之前后台运行留下的那份
      logFile: this.input.logFile ?? previous?.logFile ?? null,
      rooms: {},
      launch: this.input.launch,
      lastError: null,
    });
    const heartbeat = setInterval(() => this.patch(() => undefined), HEARTBEAT_MS);
    heartbeat.unref();
    let requested = false;
    const stopWatch = setInterval(() => {
      if (requested || !stopRequested(this.input.dir, this.id)) return;
      requested = true;
      clearStopRequest(this.input.dir, this.id);
      onStopRequested();
    }, 1_000);
    stopWatch.unref();
    this.timers.push(heartbeat, stopWatch);
  }

  setRoom(roomId: string, connected: boolean): void {
    this.patch((record) => {
      record.rooms[roomId] = connected;
    });
  }

  removeRoom(roomId: string): void {
    this.patch((record) => {
      delete record.rooms[roomId];
    });
  }

  noteError(message: string): void {
    this.lastError = message.slice(0, 500);
  }

  /** 进程退出时调用（同步写，可在 process.on("exit") 里用） */
  markStopped(failed: boolean): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const timer of this.timers) clearInterval(timer);
    try {
      updateRecord(this.input.dir, this.id, (record) => {
        if (record.pid !== this.pid) return;
        record.pid = null;
        record.stoppedAt = this.now().toISOString();
        for (const roomId of Object.keys(record.rooms)) record.rooms[roomId] = false;
        record.lastError = failed ? this.lastError : null;
      });
    } catch {
      /* 退出时写不了就算了，读的一方按心跳判断 */
    }
  }

  private patch(change: (record: RemoteJoinRecord) => void): void {
    if (this.stopped) return;
    try {
      updateRecord(this.input.dir, this.id, (record) => {
        // 记录已经被同一条命令的新进程接管：不再改它
        if (record.pid !== this.pid) return;
        change(record);
        record.updatedAt = this.now().toISOString();
      });
    } catch {
      /* 清单写不进去不影响 Agent 工作 */
    }
  }
}

/** 去掉 --token 和 --background：记下来用于重新上线，token 单独存、经环境变量传 */
export function relaunchArgs(argv: readonly string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--background" || arg === "--background=true") continue;
    if (arg === "--token") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--token=")) continue;
    result.push(arg);
  }
  return result;
}
