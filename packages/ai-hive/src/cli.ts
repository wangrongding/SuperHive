#!/usr/bin/env node
import { createRequire } from "module";
import updateNotifier from "update-notifier";
import { mcpCommand } from "./mcp-command.js";
import { run } from "./run.js";
import { restartService, startService, stopService } from "./service.js";

const _require = createRequire(import.meta.url);
const pkg = _require("../package.json") as { name: string; version: string };
const { version } = pkg;

const usage = `
AI Hive（命令别名：hive）

用法：
  ai-hive start [选项]   启动自己的 Hive Server 和 Web UI
  ai-hive stop [选项]    停止由 ai-hive start 启动的 Server
  ai-hive restart [选项] 重启 Server，并沿用原有启动配置
  ai-hive join [选项]    将本机 Agent 加入 Hive（默认加入所有未归档房间）
  ai-hive mcp list [选项] 列出 Agent 会加载的本机 MCP 及其开局 token 估算

运行 ai-hive <命令> --help 查看详细选项。
上述 ai-hive 均可替换为 hive。
`;

// 后台子进程每天最多查一次 npm registry 并缓存，有新版本时在下一次运行打印提示（NO_UPDATE_NOTIFIER=1 可关闭）
updateNotifier({
  pkg,
  updateCheckInterval: 1000 * 60 * 60 * 24,
  shouldNotifyInNpmScript: true,
}).notify({
  isGlobal: true,
  message:
    "AI Hive 有新版本 {currentVersion} → {latestVersion}\n" +
    "在启动服务的电脑运行 npx --yes ai-hive@latest restart 更新",
  boxenOptions: {
    title: "有新版本的 AI Hive 可用",
    padding: 1,
    margin: 1,
    align: "center",
    borderColor: "yellowBright",
    borderStyle: "round",
  },
});

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
  if (command === "mcp") return mcpCommand(process.argv.slice(3));
  throw new Error(`未知命令：“${command}”。\n${usage}`);
}

main().catch((error: unknown) => {
  console.error(`[hive] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
