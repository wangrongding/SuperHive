import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { AgentBridge } from "./bridge.js";
import { AgentManager, type StackHooks } from "./agent-manager.js";
import { ClaudeCodeResponder } from "./claude-client.js";
import { CodexMcpResponder } from "./codex-client.js";
import { CopilotResponder } from "./copilot-client.js";
import { OpenClawResponder } from "./openclaw-client.js";
import {
  hiveMcpUrl,
  openClawHiveMcpConfig,
  openClawHiveMcpName,
  type HiveMcpConnection,
} from "./hive-mcp-config.js";
import { fetchRooms } from "./room-client.js";
import {
  EchoResponder,
  type AgentAccessMode,
  type AgentProvider,
  type AgentResponder,
} from "./responder.js";
import { StateStore } from "./state-store.js";

const usage = `
AI Hive Agent

提示：全局安装或 link 后，ai-hive 可简写为 hive。

用法：
  ai-hive join --server URL --name NAME --token TOKEN [选项]

选项：
  --room ID         只加入指定房间；省略时加入服务器上所有未归档房间，
                    并自动跟随房间的新建与归档
  --provider NAME   codex、claude、copilot 或 openclaw（默认 codex）
  --access MODE     read-only、workspace 或 full（默认 read-only）
  --persona TEXT    Agent 的角色描述
  --cwd PATH        Agent 工作目录（workspace/full 必填；只读默认使用空临时目录）
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
      room: { type: "string" },
      name: { type: "string" },
      token: { type: "string" },
      provider: { type: "string" },
      access: { type: "string", default: "read-only" },
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
  if (roomId !== undefined && !/^[A-Za-z0-9_-]+$/.test(roomId)) {
    throw new Error("room 含有不支持的字符。");
  }
  if (!/^[\p{L}\p{N}_.-]+$/u.test(username)) {
    throw new Error("name 含有不支持的字符。");
  }
  const providerValue = defaultProvider === "echo" ? "echo" : (parsed.values.provider ?? "codex");
  const supportedProviders: AgentProvider[] = ["codex", "claude", "copilot", "openclaw", "echo"];
  if (!supportedProviders.includes(providerValue as AgentProvider)) {
    throw new Error(
      `不支持的 provider “${providerValue}”；当前可用：codex、claude、copilot、openclaw。`,
    );
  }
  const provider = providerValue as AgentProvider;
  const accessValue = parsed.values.access;
  const supportedAccessModes: AgentAccessMode[] = ["read-only", "workspace", "full"];
  if (!supportedAccessModes.includes(accessValue as AgentAccessMode)) {
    throw new Error(`不支持的 access “${accessValue}”；当前可用：read-only、workspace、full。`);
  }
  const access = accessValue as AgentAccessMode;
  if (access !== "read-only" && !parsed.values.cwd) {
    throw new Error(`--access ${access} 必须同时显式指定 --cwd，避免授权到错误目录。`);
  }

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

  function buildResponder(hive: HiveMcpConnection): AgentResponder {
    switch (provider) {
      case "echo":
        return new EchoResponder(username!);
      case "claude":
        return new ClaudeCodeResponder({
          command,
          cwd,
          hive,
          access,
          ...(parsed.values.model ? { model: parsed.values.model } : {}),
        });
      case "copilot":
        return new CopilotResponder({
          command,
          cwd,
          hive,
          access,
          ...(parsed.values.model ? { model: parsed.values.model } : {}),
        });
      case "openclaw":
        return new OpenClawResponder({
          command,
          cwd,
          local: parsed.values["openclaw-local"] ?? false,
          ...(parsed.values["openclaw-agent"] ? { agentId: parsed.values["openclaw-agent"] } : {}),
          ...(parsed.values.model ? { model: parsed.values.model } : {}),
        });
      case "codex":
        return new CodexMcpResponder({ command, cwd, hive, access });
    }
  }

  function buildStack(stackRoomId: string, hooks?: Partial<StackHooks>): AgentBridge {
    const hive: HiveMcpConnection = {
      serverUrl: serverUrl!,
      roomId: stackRoomId,
      username: username!,
      token: token!,
    };
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
    const store = new StateStore(stateDir, {
      serverUrl: serverUrl!,
      roomId: stackRoomId,
      username: username!,
      provider,
      access,
    });
    return new AgentBridge(
      {
        serverUrl: serverUrl!,
        roomId: stackRoomId,
        username: username!,
        persona,
        provider,
        token: token!,
        access,
        ...(hooks?.onRoomsChanged ? { onRoomsChanged: hooks.onRoomsChanged } : {}),
        ...(hooks?.onArchived ? { onArchived: hooks.onArchived } : {}),
      },
      store,
      buildResponder(hive),
    );
  }

  let stopAll: () => Promise<void>;
  if (roomId !== undefined) {
    const bridge: AgentBridge = buildStack(roomId, {
      onArchived: () => {
        console.error(`[hive] 房间 #${roomId} 已归档，Agent 退出。`);
        void bridge.stop().finally(() => process.exit(1));
      },
    });
    await bridge.start();
    stopAll = () => bridge.stop();
  } else {
    const manager = new AgentManager({
      listRooms: () => fetchRooms(serverUrl, token),
      createStack: (id, hooks) => buildStack(id, hooks),
    });
    const joined = await manager.start();
    console.log(
      `[hive] 已加入 ${joined.length} 个房间：${joined.map((id) => `#${id}`).join("、")}`,
    );
    console.log("[hive] 将自动加入新建房间，并在房间归档时离开对应房间。");
    stopAll = () => manager.stop();
  }
  const hiveForLogs: HiveMcpConnection = {
    serverUrl,
    roomId: roomId ?? "general",
    username,
    token,
  };
  console.log(`[hive] 状态目录：${stateDir}（每个房间一个状态文件）`);
  console.log(
    `[hive] ${providerLabels[provider]} 命令工作目录：${cwd}${parsed.values.cwd ? "" : "（安全的空临时目录）"}`,
  );
  console.log(
    `[hive] 本机权限：${access === "read-only" ? "只读" : access === "workspace" ? "工作区读写与命令" : "完全访问（无 Hive 沙箱）"}`,
  );
  if (provider === "codex" || provider === "claude" || provider === "copilot") {
    console.log(
      `[hive] ${providerLabels[provider]} Hive MCP：已启用，将按需临时注入 ${hiveMcpUrl(hiveForLogs)}（仅当前 Agent 进程，不修改全局配置）`,
    );
  }
  if (provider === "openclaw") {
    console.warn(
      `[hive] OpenClaw 的工具和文件权限由其 Agent/Gateway 配置控制；--access ${access} 仅声明期望档位，请确认 sandbox 与 exec policy 与之匹配。`,
    );
    if (parsed.values["openclaw-configure-mcp"]) {
      console.log(`[hive] OpenClaw Hive MCP：已按房间保存 ${hiveMcpUrl(hiveForLogs)}`);
      if (roomId === undefined) {
        console.warn(
          "[hive] OpenClaw Hive MCP 按房间写入全局配置；房间归档后对应条目不会自动清理。",
        );
      }
    } else {
      console.warn(
        "[hive] 当前未配置 Hive MCP；添加 --openclaw-configure-mcp 后，OpenClaw 才能直接读取成员/消息并主动发送。",
      );
    }
  }
  console.log("[hive] 按 Ctrl+C 停止 Agent 并离线；再次运行同一命令可恢复连接。");

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void stopAll().finally(() => process.exit(0));
    });
  }
}
