import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { AgentBridge } from "./bridge.js";
import { ClaudeCodeResponder } from "./claude-client.js";
import { CodexMcpResponder } from "./codex-client.js";
import { CopilotResponder } from "./copilot-client.js";
import { OpenClawResponder } from "./openclaw-client.js";
import { hiveMcpUrl, openClawHiveMcpConfig, openClawHiveMcpName } from "./hive-mcp-config.js";
import { EchoResponder, type AgentProvider, type AgentResponder } from "./responder.js";
import { StateStore } from "./state-store.js";

const usage = `
AI Hive Agent

提示：全局安装或 link 后，ai-hive 可简写为 hive。

用法：
  ai-hive join --server URL --room general --name NAME --token TOKEN [选项]

选项：
  --provider NAME   codex、claude、copilot 或 openclaw（默认 codex）
  --persona TEXT    Agent 的角色描述
  --cwd PATH        允许 Agent 读取的项目目录（默认使用空临时目录）
  --state-dir PATH  Agent 状态目录（默认 ~/.ai-hive/agents）
  --codex PATH      Codex CLI 命令（默认 codex）
  --claude PATH     Claude Code CLI 命令（默认 claude）
  --copilot PATH    GitHub Copilot CLI 命令（默认 copilot）
  --openclaw PATH   OpenClaw CLI 命令（默认 openclaw）
  --openclaw-local  强制 OpenClaw 使用 embedded agent，不连接 Gateway
  --openclaw-agent  OpenClaw 中已配置的 Agent ID
  --openclaw-configure-mcp  将当前 Hive MCP 身份保存到 OpenClaw 配置
  --model NAME      provider 使用的可选模型
`;

export async function run(defaultProvider: "codex" | "echo"): Promise<void> {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      server: { type: "string" },
      room: { type: "string", default: "general" },
      name: { type: "string" },
      token: { type: "string" },
      provider: { type: "string" },
      persona: { type: "string" },
      cwd: { type: "string" },
      "state-dir": { type: "string" },
      codex: { type: "string", default: "codex" },
      claude: { type: "string", default: "claude" },
      copilot: { type: "string", default: "copilot" },
      openclaw: { type: "string", default: "openclaw" },
      "openclaw-local": { type: "boolean" },
      "openclaw-agent": { type: "string" },
      "openclaw-configure-mcp": { type: "boolean" },
      model: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (parsed.values.help) {
    console.log(usage);
    return;
  }
  if (parsed.positionals[0] !== "join") throw new Error(usage);
  const serverUrl = parsed.values.server?.replace(/\/$/, "");
  const roomId = parsed.values.room;
  const username = parsed.values.name;
  const token = parsed.values.token;
  if (!serverUrl || !username || !token)
    throw new Error(`缺少 --server、--name 或 --token。\n${usage}`);
  new URL(serverUrl);
  if (!/^[A-Za-z0-9_-]+$/.test(roomId) || !/^[\p{L}\p{N}_.-]+$/u.test(username)) {
    throw new Error("room 或 name 含有不支持的字符。");
  }
  const providerValue = defaultProvider === "echo" ? "echo" : (parsed.values.provider ?? "codex");
  const supportedProviders: AgentProvider[] = ["codex", "claude", "copilot", "openclaw", "echo"];
  if (!supportedProviders.includes(providerValue as AgentProvider)) {
    throw new Error(
      `不支持的 provider “${providerValue}”；当前可用：codex、claude、copilot、openclaw。`,
    );
  }
  const provider = providerValue as AgentProvider;

  const cwd = parsed.values.cwd
    ? path.resolve(parsed.values.cwd)
    : mkdtempSync(path.join(tmpdir(), "ai-hive-agent-"));
  if (!existsSync(cwd) || !statSync(cwd).isDirectory())
    throw new Error(`cwd 不是可访问的目录：${cwd}`);
  const stateDir = path.resolve(
    parsed.values["state-dir"] ?? path.join(homedir(), ".ai-hive", "agents"),
  );
  const defaultPersonas: Record<AgentProvider, string> = {
    codex: "通用协作 Agent",
    claude: "通用协作 Agent",
    copilot: "通用协作 Agent",
    openclaw: "通用协作 Agent",
    echo: "Echo 测试 Agent",
  };
  const persona = parsed.values.persona ?? defaultPersonas[provider];
  const commands: Record<AgentProvider, string> = {
    codex: parsed.values.codex,
    claude: parsed.values.claude,
    copilot: parsed.values.copilot,
    openclaw: parsed.values.openclaw,
    echo: "echo",
  };
  const providerLabels: Record<AgentProvider, string> = {
    codex: "Codex",
    claude: "Claude Code",
    copilot: "GitHub Copilot",
    openclaw: "OpenClaw",
    echo: "Echo",
  };
  const command = commands[provider];

  if (provider !== "echo") {
    const check = spawnSync(command, ["--version"], { encoding: "utf8" });
    if (check.error && (check.error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `找不到 ${providerLabels[provider]} 命令 “${command}”。请先安装 CLI 并完成登录或配置。`,
      );
    }
    if (check.status !== 0)
      throw new Error(`Agent CLI 无法启动：${check.stderr || check.error?.message}`);
  }

  const store = new StateStore(stateDir, { serverUrl, roomId, username, provider });
  const hive = { serverUrl, roomId, username, token };
  if (provider === "openclaw" && parsed.values["openclaw-configure-mcp"]) {
    const configured = spawnSync(
      command,
      ["mcp", "set", openClawHiveMcpName(hive), openClawHiveMcpConfig(hive)],
      { encoding: "utf8" },
    );
    if (configured.status !== 0) {
      throw new Error(
        `无法配置 OpenClaw Hive MCP：${configured.stderr || configured.error?.message}`,
      );
    }
  }
  let responder: AgentResponder;
  switch (provider) {
    case "echo":
      responder = new EchoResponder(username);
      break;
    case "claude":
      responder = new ClaudeCodeResponder({
        command,
        cwd,
        hive,
        ...(parsed.values.model ? { model: parsed.values.model } : {}),
      });
      break;
    case "copilot":
      responder = new CopilotResponder({
        command,
        cwd,
        hive,
        ...(parsed.values.model ? { model: parsed.values.model } : {}),
      });
      break;
    case "openclaw":
      responder = new OpenClawResponder({
        command,
        cwd,
        local: parsed.values["openclaw-local"] ?? false,
        ...(parsed.values["openclaw-agent"] ? { agentId: parsed.values["openclaw-agent"] } : {}),
        ...(parsed.values.model ? { model: parsed.values.model } : {}),
      });
      break;
    case "codex":
      responder = new CodexMcpResponder({ command, cwd, hive });
      break;
  }
  const bridge = new AgentBridge(
    { serverUrl, roomId, username, persona, provider, token },
    store,
    responder,
  );
  await bridge.start();
  console.log(`[hive] 状态文件：${store.filename}`);
  console.log(
    `[hive] ${providerLabels[provider]} 命令工作目录：${cwd}${parsed.values.cwd ? "" : "（安全的空临时目录）"}`,
  );
  if (provider === "codex" || provider === "claude" || provider === "copilot") {
    console.log(
      `[hive] ${providerLabels[provider]} Hive MCP：已启用，将按需临时注入 ${hiveMcpUrl(hive)}（仅当前 Agent 进程，不修改全局配置）`,
    );
  }
  if (provider === "openclaw") {
    console.warn(
      "[hive] OpenClaw 的工具和文件权限由其 Agent/Gateway 配置控制；接入前请确认 sandbox 与 exec policy。",
    );
    if (parsed.values["openclaw-configure-mcp"]) {
      console.log(
        `[hive] OpenClaw Hive MCP：已保存 ${hiveMcpUrl(hive)}（配置名 ${openClawHiveMcpName(hive)}）`,
      );
    } else {
      console.warn(
        "[hive] 当前未配置 Hive MCP；添加 --openclaw-configure-mcp 后，OpenClaw 才能直接读取成员/消息并主动发送。",
      );
    }
  }
  console.log("[hive] 按 Ctrl+C 停止 Agent 并离线；再次运行同一命令可恢复连接。");

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void bridge.stop().finally(() => process.exit(0));
    });
  }
}
