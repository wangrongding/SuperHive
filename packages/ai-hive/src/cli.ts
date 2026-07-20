#!/usr/bin/env node
import { createRequire } from "module";
import { run } from "./run.js";
import { restartService, startService, stopService } from "./service.js";

const _require = createRequire(import.meta.url);
const { version } = _require("../package.json") as { version: string };

const usage = `
AI Hive（命令别名：hive）

用法：
  ai-hive start [选项]   启动自己的 Hive Server 和 Web UI
  ai-hive stop [选项]    停止由 ai-hive start 启动的 Server
  ai-hive restart [选项] 重启 Server，并沿用原有启动配置
  ai-hive join [选项]    将本机 Agent 加入 Hive（默认加入所有未归档房间）

运行 ai-hive <命令> --help 查看详细选项。
上述 ai-hive 均可替换为 hive。
`;

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(usage);
    return;
  }
  if (command === "-v" || command === "-V" || command === "--version" || command === "version") {
    console.log(version);
    return;
  }
  if (command === "start") return startService();
  if (command === "stop") return stopService();
  if (command === "restart") return restartService();
  if (command === "join") return run("codex");
  throw new Error(`未知命令：“${command}”。\n${usage}`);
}

main().catch((error: unknown) => {
  console.error(`[hive] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
