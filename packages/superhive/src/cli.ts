#!/usr/bin/env node
// 必须最先加载：给 Node 24 自带 fetch 的 setTypeOfService 崩溃打补丁
import "./socket-tos-guard.js";
import { createRequire } from "module";
import { fileURLToPath } from "node:url";
import { autostartCommand } from "./autostart.js";
import { DOCS_URL } from "./docs-url.js";
import { shouldExitAfterCommand } from "./electron-exit.js";
import { mcpCommand } from "./mcp-command.js";
import { modelsCommand } from "./models-command.js";
import { agentsCommand, leaveCommand } from "./remote-join-command.js";
import { run } from "./run.js";
import { redirectOutputToLog } from "./self-log.js";
import { restartService, serviceRunning, startService, stopService } from "./service.js";
import { readSkill } from "./skill.js";
import { skillInstallCommand, skillStatusCommand, skillUninstallCommand } from "./skill-command.js";
import {
  checkLatest,
  detectInstall,
  packageRootOf,
  shouldCheckForUpdate,
  updateCommand,
  updateNotice,
} from "./update.js";

// 兜底：某个异步调用漏了 catch（比如服务端正好重启时的一次 fetch）不应该把整个 Agent 进程带走，
// 那样正在执行的回合全部变成「结果未知」。记下来继续跑；真正的同步异常仍按默认行为退出并由管家重启。
process.on("unhandledRejection", (reason) => {
  console.error("[hive] 未处理的异步错误，已记录，进程继续运行：", reason);
});

const _require = createRequire(import.meta.url);
const pkg = _require("../package.json") as { name: string; version: string };
const { version } = pkg;

const usage = `
SuperHive（命令：hive；未全局安装时用 npx superhive 代替 hive）

用法：
  hive [选项]         同 hive start：启动 Hive Server 并在浏览器打开（已在运行就直接打开）
  hive start [选项]   启动自己的 Hive Server 和 Web UI
  hive stop [选项]    停止由 hive start 启动的 Server（也可以写 hive off）
  hive restart [选项] 重启 Server，并沿用原有启动配置
  hive update [--check]  更新到最新版；Server 在运行就用新版本自动重启
  hive autostart on|off|status  登录这台电脑后自动启动 Server
  hive join [选项]    将本机 Agent 加入 Hive（默认加入所有未归档房间；加 --background 在后台运行）
  hive agents         列出本机带到别人房间的 Agent，以及是否在线
  hive leave NAME     让带到别人房间的 Agent 离线（加 --leave-room 同时退出对方房间）
  hive mcp list [选项] 列出 Agent 会加载的本机 MCP 及其开局 token 估算
  hive models --provider NAME  列出这个 Agent CLI 能用的模型
  hive --skill        打印给 Agent 用的协作说明（SKILL.md，与当前版本对应）
  hive skill install [claude|codex|openclaw]
                      把上面的 SKILL.md 装进本机 Agent 的全局 skills 目录（缺省=全部已装的）
  hive skill status   查看各 Agent 的安装状态与版本
  hive skill uninstall [claude|codex|openclaw]
                      移除装进去的 SKILL.md（缺省=全部）

运行 hive <命令> --help 查看详细选项。
文档：${DOCS_URL}
`;

const packageRoot = packageRootOf(fileURLToPath(import.meta.url));

/**
 * 每次在终端里运行 hive 都查一下有没有新版（限时 1.5 秒、结果缓存 1 小时，查不到不影响命令），
 * 和命令同时进行，命令跑完再提示。Agent 用的 join / mcp / models、--skill 输出、hive update 自己不查。
 */
const QUIET_COMMANDS = new Set([
  "join",
  "agents",
  "leave",
  "mcp",
  "models",
  "--skill",
  "update",
  "-v",
  "-V",
  "--version",
  "version",
]);

function startUpdateCheck(command: string | undefined): Promise<string | undefined> {
  if ((command && QUIET_COMMANDS.has(command)) || !shouldCheckForUpdate()) {
    return Promise.resolve(undefined);
  }
  return checkLatest(version).catch(() => undefined);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  // 什么都不带（npx superhive）或只带选项（npx superhive --port 9000）：直接启动并打开网页
  if (
    !command ||
    (command.startsWith("--") &&
      command !== "--help" &&
      command !== "--version" &&
      command !== "--skill")
  )
    return startService(process.argv.slice(2));
  if (command === "help" || command === "--help" || command === "-h") {
    console.log(usage);
    return;
  }
  if (command === "-v" || command === "-V" || command === "--version" || command === "version") {
    console.log(version);
    return;
  }
  if (command === "--skill") {
    process.stdout.write(readSkill());
    return;
  }
  if (command === "skill") {
    const sub = process.argv[3];
    const args = process.argv.slice(4);
    if (sub === "install") return skillInstallCommand(args, { version, skillText: readSkill() });
    if (sub === "status") return skillStatusCommand({ version, skillText: readSkill() });
    if (sub === "uninstall") return skillUninstallCommand(args);
    if (!sub) {
      process.stdout.write(readSkill());
      return;
    }
    throw new Error(`未知的子命令：“skill ${sub}”。可用：install、status、uninstall。\n${usage}`);
  }
  if (command === "start") return startService();
  if (command === "stop" || command === "off") return stopService();
  if (command === "restart") return restartService();
  if (command === "autostart") return autostartCommand(process.argv.slice(3));
  if (command === "join") {
    redirectOutputToLog();
    return run("codex");
  }
  if (command === "agents") return agentsCommand(process.argv.slice(3));
  if (command === "leave") return leaveCommand(process.argv.slice(3));
  if (command === "mcp") return mcpCommand(process.argv.slice(3));
  if (command === "models") return modelsCommand(process.argv.slice(3));
  if (command === "update" || command === "upgrade") {
    return updateCommand(process.argv.slice(3), {
      version,
      packageRoot,
      serviceRunning: () => serviceRunning(),
    });
  }
  throw new Error(`未知命令：“${command}”。\n${usage}`);
}

const updateCheck = startUpdateCheck(process.argv[2]);

let failed = false;
main()
  .catch((error: unknown) => {
    console.error(`[hive] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    failed = true;
  })
  .then(async () => {
    // 命令跑完再提示，不打断它自己的输出；前台常驻的 hive start --foreground 不会走到这里，也就不提示
    const latest = await updateCheck;
    if (latest) console.log(updateNotice(version, latest, detectInstall(packageRoot)));
    const electron = Boolean(process.versions.electron);
    const background = process.argv.includes("--background");
    if (shouldExitAfterCommand({ command: process.argv[2], failed, electron, background })) {
      // macOS / Linux 上管道写是异步的：等前面的输出都写出去再退，不然 Server 拿到的 JSON 可能被截断
      const code = process.exitCode ?? 0;
      process.stderr.write("", () => process.stdout.write("", () => process.exit(code)));
    }
  });
