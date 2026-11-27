import { execFile } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { NpmUpdateChoice, NpmUpdateInfo, NpmUpdateJob } from "@superhive/protocol";
import type { AgentCli } from "./local-agents.js";

export interface NpmUpdates {
  inspect(refresh?: boolean): Promise<NpmUpdateInfo>;
  /** 网页「检查更新」：绕开这里和 CLI 的两层缓存，马上联网查一次 */
  checkNow(): Promise<NpmUpdateInfo>;
  launch(target: string, choice?: NpmUpdateChoice): Promise<NpmUpdateJob>;
  current(): NpmUpdateJob | null;
}

export class NpmUpdateManager implements NpmUpdates {
  private cached: { value: NpmUpdateInfo; at: number } | undefined;
  private pending: Promise<NpmUpdateInfo> | undefined;
  private checking: Promise<NpmUpdateInfo> | undefined;
  private launching = false;

  constructor(
    private readonly cli: AgentCli,
    private readonly dataDir: string,
    private readonly run: (args: string[]) => Promise<string> = (args) =>
      new Promise((resolve, reject) => {
        execFile(
          cli.command,
          [...cli.args, ...args],
          {
            windowsHide: true,
            timeout: 20_000,
            maxBuffer: 128 * 1024,
          },
          (error, stdout) =>
            error
              ? reject(
                  new Error(
                    "Could not check or start the Hive update. Check web-update.log on the Server.",
                  ),
                )
              : resolve(stdout),
        );
      }),
    private readonly processAlive: (pid: number) => boolean = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    },
  ) {}

  private args() {
    return ["web-update", "--data-dir", this.dataDir, "--server-pid", String(process.pid)];
  }

  inspect(refresh = false): Promise<NpmUpdateInfo> {
    if (!refresh && this.cached && Date.now() - this.cached.at < 60 * 60_000)
      return Promise.resolve(this.cached.value);
    if (this.pending) return this.pending;
    this.pending = this.run(this.args())
      .then((output) => {
        const value = JSON.parse(output) as NpmUpdateInfo;
        this.cached = { value, at: Date.now() };
        return value;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  checkNow(): Promise<NpmUpdateInfo> {
    this.checking ??= this.run([...this.args(), "--refresh"])
      .then((output) => {
        const value = JSON.parse(output) as NpmUpdateInfo;
        this.cached = { value, at: Date.now() };
        return value;
      })
      .finally(() => {
        this.checking = undefined;
      });
    return this.checking;
  }

  current(): NpmUpdateJob | null {
    try {
      const file = path.join(this.dataDir, "web-update.json");
      const job = JSON.parse(readFileSync(file, "utf8")) as NpmUpdateJob;
      if (
        job.workerPid &&
        !["completed", "failed"].includes(job.phase) &&
        Date.now() - job.updatedAt > 5_000 &&
        !this.processAlive(job.workerPid)
      ) {
        job.phase = "failed";
        job.error =
          "Update worker stopped unexpectedly. Check Hive status and web-update.log before updating manually.";
        job.updatedAt = Date.now();
        const temporary = `${file}.${process.pid}.tmp`;
        writeFileSync(temporary, JSON.stringify(job), { mode: 0o600 });
        renameSync(temporary, file);
      }
      return job;
    } catch {
      return null;
    }
  }

  async launch(target: string, choice?: NpmUpdateChoice): Promise<NpmUpdateJob> {
    const current = this.current();
    if (current?.error?.startsWith("Update worker stopped unexpectedly"))
      throw new Error(current.error);
    if (this.launching || (current && !["completed", "failed"].includes(current.phase)))
      throw new Error("An update is already running");
    this.launching = true;
    try {
      const output = await this.run([
        ...this.args(),
        "--launch",
        "--target",
        target,
        ...(choice ? ["--choice", choice] : []),
      ]);
      return JSON.parse(output) as NpmUpdateJob;
    } finally {
      this.launching = false;
    }
  }
}
