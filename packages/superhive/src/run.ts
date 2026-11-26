import { spawnSync } from "node:child_process";
import { commandFor } from "./windows-command.js";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { superhiveHome } from "./home-dir.js";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { AgentBridge } from "./bridge.js";
import {
  resolveTaskWorkspace,
  resolveTaskWorkspaces,
  type TaskWorkspaceLookupOptions,
  type TaskWorkspaceNoticeSink,
} from "./task-workspace.js";
import { AgentManager, SingleRoomStack, type StackHooks } from "./agent-manager.js";
import { ClaudeCodeResponder, claudeWorkspaceSandboxed } from "./claude-client.js";
import {
  ClaudeWarmRegistry,
  claudeMaxWarm,
  defaultWarmRegistryDir,
} from "./claude-warm-registry.js";
import { CODEX_MIN_VERSION, CodexResponder } from "./codex-responder.js";
import { CopilotResponder } from "./copilot-client.js";
import { createOmpResponder } from "./omp-client.js";
import { createGeminiResponder } from "./gemini-client.js";
import { createAgyResponder } from "./agy-client.js";
import { createOpenCodeResponder } from "./opencode-client.js";
import { OpenClawResponder } from "./openclaw-client.js";
import {
  hiveMcpUrl,
  openClawHiveMcpBatch,
  sweepStaleHiveMcpConfigs,
  type HiveMcpConnection,
} from "./hive-mcp-config.js";
import { fetchRooms } from "./room-client.js";
import { runningCodeVersion } from "./code-version.js";
import type { RoomSummary } from "./hive-protocol.js";
import { allowedWorkspaceRoots, resolveRoomWorkspace } from "./workspace.js";
import {
  EchoResponder,
  type AgentAccessMode,
  type AgentProvider,
  type AgentResponder,
} from "./responder.js";
import { StateStore, agentWorkspaceDir } from "./state-store.js";
import { addServerToNoProxy } from "./no-proxy.js";
import { RemoteJoinTracker, relaunchArgs } from "./remote-join-tracker.js";
import {
  launchInBackground,
  logTail,
  readRecord,
  recordRunning,
  remoteJoinId,
  remoteJoinsDir,
  waitForOnline,
} from "./remote-joins.js";

/**
 * 文件工具只能碰工作区和显式放行目录的运行时（实测）：Copilot 要 --add-dir、Gemini 要 --include-directories、
 * OpenCode 要在 external_directory 里放行；agy 没法实测，按同样受限处理（只是附件多下载一份）。
 * Claude Code（含 plan 模式）、Codex（read-only 沙箱可读全盘）、omp 都能直接读工作区以外的文件
 */
const ATTACHMENT_DIR_RESTRICTED = new Set(["copilot", "gemini", "opencode", "agy"]);

const usage = `
SuperHive Agent

提示：未全局安装时用 npx superhive 代替 hive。

用法：
  hive join --server URL --name NAME --token TOKEN [选项]

选项：
  --room ID         只加入指定房间；省略时加入服务器上所有未归档房间，
                    并自动跟随房间的新建与归档
  --provider NAME   codex、claude、copilot、openclaw、opencode、omp、gemini 或 agy（默认 codex）
  --access MODE     read-only、workspace 或 full（默认 read-only）
  --persona TEXT    Agent 的角色描述
  --background      在后台运行：关掉终端也在线，日志写到 ~/.superhive/remote-joins/。
                    用 hive agents 查看、hive leave NAME 让它离线
  --allow-root PATH 允许跟随房间工作区切换到的目录（可重复）；默认只有 --cwd 及其上一级
  --trust-room-workspace
                    房间工作区一律跟随（由本机 Hive Server 拉起的 Agent 使用：
                    工作区只有房主能设）
  --cwd PATH        Agent 工作目录（workspace/full 必填；只读默认使用状态目录下
                    该 Agent 专属的空目录）
  --state-dir PATH  Agent 状态目录（默认 ~/.superhive/agents）
  --codex PATH      Codex CLI 命令（默认 codex）
  --codex-transport MODE
                    auto 或 app-server（两者相同；旧的 mcp 已移除：Codex 0.154 起没有
                    mcp-server 子命令）
  --claude PATH     Claude Code CLI 命令（默认 claude）
  --copilot PATH    GitHub Copilot CLI 命令（默认 copilot）
  --openclaw PATH   OpenClaw CLI 命令（默认 openclaw）
  --openclaw-local  强制 OpenClaw 使用 embedded agent，不连接 Gateway
  --openclaw-agent  OpenClaw 中已配置的 Agent ID
  --openclaw-configure-mcp  将当前 Hive MCP 身份保存到 OpenClaw 配置
  --opencode PATH   OpenCode CLI 命令（默认 opencode）
  --omp PATH        omp（oh-my-pi）CLI 命令（默认 omp）
  --gemini PATH     Gemini CLI 命令（默认 gemini）
  --agy PATH        Antigravity CLI 命令（默认 agy）
  --model NAME      provider 使用的可选模型（opencode 为 provider/model 格式）
  --agent-settings FILE
                    Agent 设置文件（JSON：{"mcpDisabled": ["名称"]}）；给定时 Claude Code / Codex
                    只加载未关闭的本机 MCP，每一轮重新读取。本机 Hive Server 拉起时自动传入
`;

/**
 * 由本机 Hive Server 拉起时，Server 若被强制结束（kill -9、崩溃）不会通知子进程。
 * 定期检查父进程是否还在。不在了先别急着退：开发时代码更新会换一个新 Server 接管本 Agent，
 * 在宽限期内通过 findSuccessor 找到新 Server 就改为看护它，手上的任务照常做完；
 * 宽限期过了还没有新 Server，才离线退出，避免留下占着名字的孤儿 Agent。
 */
export function watchSupervisor(
  pidValue: string | undefined,
  onGone: () => void,
  options: {
    intervalMs?: number;
    isAlive?: (pid: number) => boolean;
    /** 找接管的新 Server 进程号；省略则原 Server 一消失就退出 */
    findSuccessor?: () => Promise<number | undefined>;
    graceMs?: number;
    now?: () => number;
  } = {},
): (() => void) | undefined {
  let pid = Number.parseInt(pidValue ?? "", 10);
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  const isAlive =
    options.isAlive ??
    ((target: number) => {
      try {
        process.kill(target, 0);
        return true;
      } catch (error) {
        // EPERM 说明进程存在只是无权发信号
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    });
  const now = options.now ?? Date.now;
  let orphanSince: number | undefined;
  let searching = false;
  let done = false;
  const timer = setInterval(() => {
    if (done || searching) return;
    if (isAlive(pid)) {
      orphanSince = undefined;
      return;
    }
    if (!options.findSuccessor) {
      done = true;
      clearInterval(timer);
      onGone();
      return;
    }
    orphanSince ??= now();
    searching = true;
    void options
      .findSuccessor()
      .catch(() => undefined)
      .then((successor) => {
        searching = false;
        if (done) return;
        if (successor && successor !== pid && isAlive(successor)) {
          pid = successor;
          orphanSince = undefined;
          return;
        }
        if (now() - (orphanSince ?? now()) >= (options.graceMs ?? 120_000)) {
          done = true;
          clearInterval(timer);
          onGone();
        }
      });
  }, options.intervalMs ?? 2_000);
  timer.unref();
  return () => {
    done = true;
    clearInterval(timer);
  };
}

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
      "allow-root": { type: "string", multiple: true },
      "trust-room-workspace": { type: "boolean", default: false },
      "state-dir": { type: "string" },
      codex: { type: "string", default: "codex" },
      "codex-transport": { type: "string", default: "auto" },
      claude: { type: "string", default: "claude" },
      copilot: { type: "string", default: "copilot" },
      openclaw: { type: "string", default: "openclaw" },
      "openclaw-local": { type: "boolean" },
      "openclaw-agent": { type: "string" },
      "openclaw-configure-mcp": { type: "boolean" },
      opencode: { type: "string", default: "opencode" },
      omp: { type: "string", default: "omp" },
      gemini: { type: "string", default: "gemini" },
      agy: { type: "string", default: "agy" },
      model: { type: "string" },
      "agent-settings": { type: "string" },
      background: { type: "boolean", default: false },
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
  // 也可经环境变量传入：由本机 Hive Server 拉起时用它，避免 token 出现在进程参数里
  const token = parsed.values.token ?? process.env.HIVE_AGENT_TOKEN;
  // 读完就从环境里删掉：各运行时都继承本进程的环境，Agent 执行的命令能读到它（join token 有房主权限）
  delete process.env.HIVE_AGENT_TOKEN;
  if (!serverUrl || !username || !token)
    throw new Error(`缺少 --server、--name 或 --token。\n${usage}`);
  sweepStaleHiveMcpConfigs();
  new URL(serverUrl);
  if (addServerToNoProxy(process.env, serverUrl)) {
    console.log(`[hive] 已设代理：${new URL(serverUrl).hostname} 加进 NO_PROXY，连 Hive 不走代理`);
  }
  if (roomId !== undefined && !/^[A-Za-z0-9_-]+$/.test(roomId)) {
    throw new Error("room 含有不支持的字符。");
  }
  if (!/^[\p{L}\p{N}_.-]+$/u.test(username)) {
    throw new Error("name 含有不支持的字符。");
  }
  const providerValue = defaultProvider === "echo" ? "echo" : (parsed.values.provider ?? "codex");
  const supportedProviders: AgentProvider[] = [
    "codex",
    "claude",
    "copilot",
    "openclaw",
    "opencode",
    "omp",
    "gemini",
    "agy",
    "echo",
  ];
  if (!supportedProviders.includes(providerValue as AgentProvider)) {
    throw new Error(
      `不支持的 provider “${providerValue}”；当前可用：codex、claude、copilot、openclaw、opencode、omp、gemini、agy。`,
    );
  }
  const provider = providerValue as AgentProvider;
  const accessValue = parsed.values.access;
  const supportedAccessModes: AgentAccessMode[] = ["read-only", "workspace", "full"];
  if (!supportedAccessModes.includes(accessValue as AgentAccessMode)) {
    throw new Error(`不支持的 access “${accessValue}”；当前可用：read-only、workspace、full。`);
  }
  const access = accessValue as AgentAccessMode;
  const codexTransport = parsed.values["codex-transport"];
  if (codexTransport === "mcp") {
    throw new Error(
      `--codex-transport mcp 已移除：Codex 0.154 起没有 mcp-server 子命令，Hive 只通过 app-server 驱动 Codex（最低 ${CODEX_MIN_VERSION}）。去掉这个参数即可。`,
    );
  }
  if (!["auto", "app-server"].includes(codexTransport ?? "")) {
    throw new Error(`不支持的 codex-transport “${codexTransport}”；当前可用：auto、app-server。`);
  }
  if (access !== "read-only" && !parsed.values.cwd) {
    throw new Error(`--access ${access} 必须同时显式指定 --cwd，避免授权到错误目录。`);
  }

  const stateDir = path.resolve(parsed.values["state-dir"] ?? path.join(superhiveHome(), "agents"));
  const cwd = parsed.values.cwd
    ? path.resolve(parsed.values.cwd)
    : agentWorkspaceDir(stateDir, { serverUrl, username, provider });
  if (!existsSync(cwd) || !statSync(cwd).isDirectory())
    throw new Error(`cwd 不是可访问的目录：${cwd}`);
  const defaultPersonas: Record<AgentProvider, string> = {
    codex: "通用协作 Agent",
    claude: "通用协作 Agent",
    copilot: "通用协作 Agent",
    openclaw: "通用协作 Agent",
    opencode: "通用协作 Agent",
    omp: "通用协作 Agent",
    gemini: "通用协作 Agent",
    agy: "通用协作 Agent",
    echo: "Echo 测试 Agent",
  };
  const persona = parsed.values.persona ?? defaultPersonas[provider];
  const commands: Record<AgentProvider, string> = {
    codex: parsed.values.codex,
    claude: parsed.values.claude,
    copilot: parsed.values.copilot,
    openclaw: parsed.values.openclaw,
    opencode: parsed.values.opencode,
    omp: parsed.values.omp,
    gemini: parsed.values.gemini,
    agy: parsed.values.agy,
    echo: "echo",
  };
  const providerLabels: Record<AgentProvider, string> = {
    codex: "Codex",
    claude: "Claude Code",
    copilot: "GitHub Copilot",
    openclaw: "OpenClaw",
    opencode: "OpenCode",
    omp: "omp",
    gemini: "Gemini CLI",
    agy: "agy",
    echo: "Echo",
  };
  const command = commands[provider];

  if (provider !== "echo") {
    const probe = commandFor(command, ["--version"]);
    const check = spawnSync(probe.command, probe.args, { encoding: "utf8", windowsHide: true });
    if (check.error && (check.error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `找不到 ${providerLabels[provider]} 命令 “${command}”。请先安装 CLI 并完成登录或配置。`,
      );
    }
    if (check.status !== 0)
      throw new Error(`Agent CLI 无法启动：${check.stderr || check.error?.message}`);
  }

  // 本机 Hive Server 拉起时传入：网页上勾选的 MCP 写在这个文件里，Agent 每一轮读取
  const settingsFile = parsed.values["agent-settings"]
    ? path.resolve(parsed.values["agent-settings"])
    : undefined;

  // 附件缓存目录：Bridge 把用户贴的图下载到这里，Agent 用读文件工具打开（各档都给，只读档也要看图）。
  // 文件工具只能碰指定目录的运行时只放行这一个目录：附件一律下载到这里，不用同机 Server 数据目录里那份
  const attachmentCacheDir = path.join(stateDir, "attachments");
  const attachmentDirRestricted = ATTACHMENT_DIR_RESTRICTED.has(provider);
  let attachmentDir: string | undefined;
  if (attachmentDirRestricted) {
    mkdirSync(attachmentCacheDir, { recursive: true, mode: 0o700 });
    attachmentDir = realpathSync(attachmentCacheDir);
  }

  function buildResponder(hive: HiveMcpConnection, cwd: string): AgentResponder {
    switch (provider) {
      case "echo":
        return new EchoResponder(username!);
      case "claude":
        return new ClaudeCodeResponder({
          command,
          cwd,
          hive,
          access,
          keepAliveMs: claudeKeepAliveMs(process.env.HIVE_CLAUDE_KEEPALIVE_MS),
          // 同一台机器上所有 Agent 合起来最多留几个空闲的 Claude 进程，超出就淘汰最久没用的
          warmRegistry: new ClaudeWarmRegistry({
            dir: defaultWarmRegistryDir(),
            max: claudeMaxWarm(process.env.HIVE_CLAUDE_MAX_WARM),
          }),
          ...(settingsFile ? { settingsFile } : {}),
          ...(parsed.values.model ? { model: parsed.values.model } : {}),
        });
      case "copilot":
        return new CopilotResponder({
          command,
          cwd,
          hive,
          access,
          ...(attachmentDir ? { attachmentDir } : {}),
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
      case "opencode":
        return createOpenCodeResponder({
          command,
          cwd,
          hive,
          access,
          ...(attachmentDir ? { attachmentDir } : {}),
          ...(parsed.values.model ? { model: parsed.values.model } : {}),
        });
      case "omp":
        return createOmpResponder({
          command,
          cwd,
          hive,
          access,
          ...(parsed.values.model ? { model: parsed.values.model } : {}),
        });
      case "gemini":
        return createGeminiResponder({
          command,
          cwd,
          hive,
          access,
          ...(attachmentDir ? { attachmentDir } : {}),
          ...(parsed.values.model ? { model: parsed.values.model } : {}),
        });
      case "agy":
        return createAgyResponder({
          command,
          cwd,
          hive,
          access,
          ...(parsed.values.model ? { model: parsed.values.model } : {}),
        });
      case "codex":
        return new CodexResponder({
          command,
          cwd,
          hive,
          access,
          ...(settingsFile ? { settingsFile } : {}),
          ...(parsed.values.model ? { model: parsed.values.model } : {}),
        });
    }
  }

  // 带到别人房间的 Agent（不是本机 Hive Server 拉起的）：登记进本机清单，hive agents / 网页里看得到、停得掉
  const supervised = Boolean(process.env.HIVE_SUPERVISOR_PID);
  const joinsDir = remoteJoinsDir();
  const launch = {
    command: process.execPath,
    args: [...process.execArgv, process.argv[1] ?? "", ...relaunchArgs(process.argv.slice(2))],
    cwd: process.cwd(),
  };
  if (parsed.values.background && !supervised) {
    await startInBackground({
      dir: joinsDir,
      id: remoteJoinId(serverUrl, roomId ?? null, username),
      name: username,
      launch,
      token,
    });
    return;
  }
  const background = process.env.HIVE_REMOTE_JOIN_BACKGROUND === "1";
  const tracker = supervised
    ? undefined
    : new RemoteJoinTracker({
        dir: joinsDir,
        server: serverUrl,
        roomId: roomId ?? null,
        name: username,
        runtime: provider,
        access,
        cwd: parsed.values.cwd ? cwd : null,
        model: parsed.values.model ?? null,
        token,
        background,
        logFile: process.env.HIVE_REMOTE_JOIN_LOG ?? null,
        launch,
      });
  delete process.env.HIVE_REMOTE_JOIN_BACKGROUND;
  delete process.env.HIVE_REMOTE_JOIN_LOG;
  if (tracker) {
    const other = tracker.runningElsewhere();
    if (other) {
      throw new Error(
        `${username} 已经在运行（进程 ${other.pid}${other.background ? "，后台" : ""}），同一个名字再连一次会把它顶掉。先运行 hive leave ${username} 让它离线，或者用 hive agents 查看。`,
      );
    }
  }

  const allowedRoots = allowedWorkspaceRoots(cwd, parsed.values["allow-root"] ?? []);

  function buildStack(room: RoomSummary, hooks?: Partial<StackHooks>): AgentBridge {
    const stackRoomId = room.id;
    const workspace = resolveRoomWorkspace({
      roomWorkspace: room.workspace,
      defaultCwd: cwd,
      allowedRoots,
      access,
      trusted: parsed.values["trust-room-workspace"] === true,
      // OpenClaw 的工具权限由它自己的配置决定，Hive 限制不了只读：只读档不切到房间工作区
      readOnlyEnforced: provider !== "openclaw",
      scratchDefault: !parsed.values.cwd,
    });
    if (room.workspace) {
      console.log(
        `[hive] #${stackRoomId} 工作目录：${workspace.cwd}${workspace.note ? `（${workspace.note}）` : ""}`,
      );
    }
    const hive: HiveMcpConnection = {
      serverUrl: serverUrl!,
      roomId: stackRoomId,
      username: username!,
      token: token!,
    };
    if (provider === "openclaw" && parsed.values["openclaw-configure-mcp"]) {
      // 配置里有 Hive token：经只有自己能读的临时文件交给 config set --batch-file，
      // 不用 mcp set 把它放在参数里（同机其他用户用 ps 就能看到）
      const batchDir = mkdtempSync(path.join(tmpdir(), "hive-openclaw-mcp-"));
      const batchFile = path.join(batchDir, "mcp.json");
      let configured;
      try {
        writeFileSync(batchFile, openClawHiveMcpBatch(hive), { mode: 0o600 });
        const configure = commandFor(command, ["config", "set", "--batch-file", batchFile]);
        configured = spawnSync(configure.command, configure.args, {
          encoding: "utf8",
          windowsHide: true,
        });
      } finally {
        rmSync(batchDir, { recursive: true, force: true });
      }
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
        attachmentCacheDir,
        ...(attachmentDirRestricted ? { attachmentServerPath: false } : {}),
        cwd: workspace.cwd,
        ...(room.workspace ? { roomWorkspace: room.workspace } : {}),
        ...(room.leadAgent ? { roomLeadAgent: room.leadAgent } : {}),
        ...(workspace.note ? { workspaceNote: workspace.note } : {}),
        ...(provider === "claude" && access === "workspace" && !claudeWorkspaceSandboxed()
          ? { noSandbox: true }
          : {}),
        ...(hooks?.onRoomsChanged ? { onRoomsChanged: hooks.onRoomsChanged } : {}),
        ...(hooks?.onArchived || tracker
          ? {
              onArchived: () => {
                tracker?.removeRoom(stackRoomId);
                hooks?.onArchived?.();
              },
            }
          : {}),
        ...(tracker
          ? { onConnectionChange: (connected: boolean) => tracker.setRoom(stackRoomId, connected) }
          : {}),
        ...(process.env.HIVE_SUPERVISOR_PID ? { onShutdown: () => shutdownOnRequest() } : {}),
        ...(settingsFile ? { settingsFile } : {}),
        ...(settingsFile &&
        process.env.HIVE_SUPERVISOR_PID &&
        parsed.values["trust-room-workspace"] === true &&
        access !== "read-only"
          ? {
              taskWorkspace: {
                resolve: (messageId: string, onNotice?: TaskWorkspaceNoticeSink) =>
                  resolveTaskWorkspace(hive, messageId, undefined, onNotice),
                resolveMany: (
                  messageIds: string[],
                  onNotice?: TaskWorkspaceNoticeSink,
                  options?: TaskWorkspaceLookupOptions,
                ) => resolveTaskWorkspaces(hive, messageIds, undefined, onNotice, options),
                responder: (directory: string) => buildResponder(hive, directory),
              },
            }
          : {}),
      },
      store,
      buildResponder(hive, workspace.cwd),
    );
  }

  // 启动时就记下这个进程跑的代码版本（加入房间时上报）：之后仓库再变，这个进程跑的仍是这一份
  const codeVersion = runningCodeVersion();
  console.log(
    `[hive] 代码版本：${codeVersion.package}${codeVersion.commit ? `（${codeVersion.commit.slice(0, 7)}）` : ""}`,
  );
  // 加入过程中就收到停止请求时，还没有可停的连接，直接退出
  let stopAll: () => Promise<void> = async () => undefined;
  let shuttingDown = false;
  /**
   * 拉起本进程的本机 Hive Server 请它退出：正常离线后退出。只有由本机 Server 拉起的 Agent
   * （带 HIVE_SUPERVISOR_PID）才响应，手动运行的 Agent 不会被远端 Server 关掉。
   */
  function shutdownOnRequest() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("[hive] 本机 Hive Server 请求停止，正常离线后退出。");
    void stopAll().finally(() => process.exit(0));
  }
  if (tracker) {
    tracker.start(() => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log("[hive] 收到停止请求（hive leave 或网页上点了离线），正常离线后退出。");
      void stopAll().finally(() => process.exit(0));
    });
    process.once("exit", (code) => tracker.markStopped(code !== 0));
    const originalError = console.error.bind(console);
    console.error = (...args: unknown[]) => {
      tracker.noteError(
        args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(" "),
      );
      originalError(...args);
    };
  }
  if (roomId !== undefined) {
    // 单房间模式：房间改了工作区，和多房间一样等空闲后换到新目录重新加入
    const room = (await fetchRooms(serverUrl, token).catch(() => [])).find(
      (item) => item.id === roomId,
    );
    const single: SingleRoomStack = new SingleRoomStack({
      room: room ?? ({ id: roomId } as RoomSummary),
      createStack: (target, hooks) => buildStack(target, hooks),
      onArchived: () => {
        console.error(`[hive] 已不能再访问房间 #${roomId}（归档、到期或被移除），Agent 退出。`);
        void single.stop().finally(() => process.exit(1));
      },
      onSwitchFailed: (error) => {
        console.error(
          `[hive] 换到房间 #${roomId} 的新工作区后没能重新加入：${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      },
    });
    await single.start();
    stopAll = () => single.stop();
  } else {
    const manager = new AgentManager({
      listRooms: () => fetchRooms(serverUrl, token),
      createStack: (room, hooks) => buildStack(room, hooks),
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
    `[hive] ${providerLabels[provider]} 命令工作目录：${cwd}${parsed.values.cwd ? "" : "（该 Agent 专属的空目录，固定复用以便恢复会话）"}`,
  );
  console.log(
    `[hive] 本机权限：${access === "read-only" ? "只读" : access === "workspace" ? "工作区读写与命令" : "完全访问（无 Hive 沙箱）"}`,
  );
  if (["codex", "claude", "copilot", "opencode", "omp", "gemini", "agy"].includes(provider)) {
    console.log(
      `[hive] ${providerLabels[provider]} Hive MCP：已启用，将按需临时注入 ${hiveMcpUrl(hiveForLogs)}（仅当前 Agent 进程，不修改全局配置）`,
    );
  }
  if (provider === "claude" && access === "workspace" && !claudeWorkspaceSandboxed()) {
    console.warn(
      "[hive] Windows 上 Claude Code 没有系统沙箱：工作区档的命令能访问工作目录以外的文件，靠 Claude 的 auto 审核（有风险的操作直接拦下）和人工审批（命中 ask 规则的操作在网页上请你确认）。",
    );
  }
  if (provider === "omp" && access === "workspace") {
    console.warn(
      "[hive] omp 不会把 write/edit 限制在工作目录内；workspace 档只是在只读工具之外再开放 edit、write、bash。需要目录隔离时请改用 opencode、codex 或 claude。",
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
  if (tracker && background) {
    console.log(`[hive] 在后台运行：hive agents 查看，hive leave ${username} 让它离线。`);
  } else if (tracker) {
    console.log(
      "[hive] 按 Ctrl+C 停止 Agent 并离线；关掉这个终端 Agent 也会离线。想关掉终端后继续在线，加 --background 在后台运行。",
    );
  } else {
    console.log("[hive] 按 Ctrl+C 停止 Agent 并离线；再次运行同一命令可恢复连接。");
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void stopAll().finally(() => process.exit(0));
    });
  }
  const orphanGraceMs = Number.parseInt(process.env.HIVE_ORPHAN_GRACE_MS ?? "", 10);
  watchSupervisor(
    process.env.HIVE_SUPERVISOR_PID,
    () => {
      console.error(
        "[hive] 拉起本 Agent 的 Hive Server 已退出且没有新 Server 接管，Agent 随之离线。",
      );
      void stopAll().finally(() => process.exit(0));
    },
    {
      ...(Number.isInteger(orphanGraceMs) && orphanGraceMs >= 0 ? { graceMs: orphanGraceMs } : {}),
      // 新 Server 的 /health 带着它的进程号；同一台机器上能找到它，就说明是换代重启而不是关闭
      findSuccessor: async () => {
        const response = await fetch(`${serverUrl}/health`, {
          signal: AbortSignal.timeout(1_500),
        });
        const body = (await response.json()) as { pid?: unknown };
        return typeof body.pid === "number" ? body.pid : undefined;
      },
    },
  );
}

/** Claude 进程一轮结束后保留多久给下一轮复用：默认 10 分钟；HIVE_CLAUDE_KEEPALIVE_MS=0 关闭（每轮新起进程） */
export function claudeKeepAliveMs(value: string | undefined): number {
  const parsed = value === undefined || value.trim() === "" ? NaN : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 10 * 60_000;
}

/**
 * hive join --background：同样的参数（去掉 token）在后台再起一个 join 进程，关掉终端也在线。
 * 等它连上房间再返回；没连上就把日志最后几行打出来。
 */
async function startInBackground(input: {
  dir: string;
  id: string;
  name: string;
  launch: { command: string; args: string[]; cwd: string };
  token: string;
}): Promise<void> {
  const existing = readRecord(input.dir, input.id);
  if (existing?.pid && !existing.stoppedAt) {
    if (recordRunning(existing)) {
      throw new Error(
        `${input.name} 已经在运行（进程 ${existing.pid}）。先运行 hive leave ${input.name} 让它离线，或者用 hive agents 查看。`,
      );
    }
  }
  const pid = await launchInBackground(input.dir, {
    ...input.launch,
    id: input.id,
    token: input.token,
  });
  const logFile = path.join(input.dir, `${input.id}.log`);
  const result = await waitForOnline(input.dir, input.id, pid, backgroundWaitMs());
  if (result === "exited") {
    const tail = logTail(logFile);
    throw new Error(`${input.name} 在后台启动后退出了。日志：${logFile}${tail ? `\n${tail}` : ""}`);
  }
  console.log(
    result === "online"
      ? `[hive] ${input.name} 已在后台运行并连上房间（进程 ${pid}）。关掉这个终端也不会离线。`
      : `[hive] ${input.name} 已在后台启动（进程 ${pid}），还在连接，稍后用 hive agents 查看是否在线。`,
  );
  console.log(`[hive] 日志：${logFile}`);
  console.log(`[hive] 查看：hive agents；让它离线：hive leave ${input.name}`);
}

function backgroundWaitMs(): number {
  const value = Number.parseInt(process.env.HIVE_BACKGROUND_WAIT_MS ?? "", 10);
  return Number.isInteger(value) && value >= 0 ? value : 30_000;
}
