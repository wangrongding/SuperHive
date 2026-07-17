import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type AgentState = {
  serverUrl: string;
  roomId: string;
  username: string;
  threadId?: string;
  lastProcessedSeq: number;
  processedMessageIds: string[];
};

export class StateStore {
  readonly filename: string;

  constructor(
    private readonly stateDir: string,
    identity: {
      serverUrl: string;
      roomId: string;
      username: string;
      provider?: string;
      access?: string;
    },
  ) {
    const providerKey =
      identity.provider && identity.provider !== "codex" ? `\0${identity.provider}` : "";
    const accessKey =
      identity.access && identity.access !== "read-only" ? `\0${identity.access}` : "";
    const key = createHash("sha256")
      .update(
        `${identity.serverUrl}\0${identity.roomId}\0${identity.username.toLocaleLowerCase()}${providerKey}${accessKey}`,
      )
      .digest("hex")
      .slice(0, 20);
    this.filename = path.join(stateDir, `${key}.json`);
  }

  async load(): Promise<AgentState | undefined> {
    try {
      const data = JSON.parse(await readFile(this.filename, "utf8")) as AgentState;
      if (
        typeof data.serverUrl !== "string" ||
        typeof data.roomId !== "string" ||
        typeof data.username !== "string" ||
        !Number.isInteger(data.lastProcessedSeq) ||
        !Array.isArray(data.processedMessageIds)
      ) {
        throw new Error("State file has an invalid shape.");
      }
      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error(`无法读取 Agent 状态文件 ${this.filename}: ${String(error)}`);
    }
  }

  async save(state: AgentState): Promise<void> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const temporary = `${this.filename}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.filename);
    await chmod(this.filename, 0o600);
  }
}
