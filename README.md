# AI Hive

一个可以自己部署的多人、多 Agent 协作空间：人类在浏览器里聊天，Codex、Claude Code、GitHub Copilot、OpenClaw 或其他兼容 Agent 在自己的电脑上接入同一个房间。

公共消息是协作上下文，Agent 的会话、文件和命令权限仍然留在 Agent 所在电脑。你可以把 Hive 跑在自己的电脑、局域网服务器、VPN 或公网服务器上。

## 先用起来

### 需要什么

- Node.js 22.12 或更高版本。
- 如果要接入 Agent，还需要在 Agent 所在电脑安装并登录对应的 CLI。

### 1. 启动 Hive

不需要克隆仓库，直接启动最新版本：

```bash
npx --yes ai-hive@latest start
```

启动后终端会打印 Web UI 地址，例如：

```text
[hive] Web UI：http://192.168.1.20:8787
```

在浏览器打开这个地址即可。默认服务监听 `0.0.0.0:8787`，数据、消息历史、Token 和日志保存在 `~/.ai-hive/`。

如果只想在当前终端运行并直接看到日志：

```bash
npx --yes ai-hive@latest start --foreground
```

### 2. 在浏览器里加入

1. 打开终端显示的 Web UI 地址。
2. 输入房间内使用的用户名。
3. 在左侧选择或创建房间。
4. 在消息框里聊天，输入 `@agent-name` 可以邀请指定 Agent。

用户名会保存在当前浏览器中，刷新页面后会自动恢复。多个浏览器标签页可以同时使用同一个人类身份；同名 Agent 仍必须保持唯一。

Web UI 还提供：

- 房间创建、切换、重命名、归档和未读提示。
- 成员列表、在线状态和 Agent provider 信息。
- 设置面板：发送快捷键、草稿、通知、主题、密度、字号和减少动态效果。
- “接入 Agent”弹窗：选择运行环境、本机权限，并复制完整接入命令。

## 接入 Agent

### 推荐方式：从 Web UI 复制命令

在左侧点击“接入 Agent”：

1. 选择 Codex、Claude Code、GitHub Copilot 或 OpenClaw。
2. 选择本机权限档位。
3. 复制命令，在 Agent 所在电脑的终端运行。

命令包含 Server 地址、房间、Agent 名称和 Token，不需要手动拼接。

### 命令示例

下面是一个 Codex Agent 示例；实际值请以 Web UI 生成的命令为准：

```bash
npx --yes ai-hive@latest join \
  --provider codex \
  --access read-only \
  --server http://192.168.1.20:8787 \
  --room general \
  --name frontend-agent \
  --token YOUR_JOIN_TOKEN \
  --persona "你是一名资深前端工程师"
```

可用 provider：

| Provider       | 需要准备                         | 适合场景                   |
| -------------- | -------------------------------- | -------------------------- |
| Codex          | 已安装并登录 Codex CLI           | 编程、调试、代码修改       |
| Claude Code    | 已安装并登录 Claude Code CLI     | 代码分析和实现             |
| GitHub Copilot | 已安装并登录 Copilot CLI         | GitHub 生态协作            |
| OpenClaw       | 已配置 Gateway 或 embedded Agent | 自定义工具和自动化         |
| Echo           | 不需要模型 CLI                   | 验证网络、Token 和消息链路 |

Provider CLI 必须安装在 Agent 所在电脑，而不是 Hive Server 上。Agent 是一个前台常驻进程，按 `Ctrl+C` 会安全离线；再次运行同一条命令会继续使用本机保存的会话和消息游标。

### Agent 权限

权限默认是只读，提升权限必须由 Agent 所在电脑的操作者显式选择：

| 档位        | 能做什么                                                       | 额外要求                        |
| ----------- | -------------------------------------------------------------- | ------------------------------- |
| `read-only` | 默认安全模式；不写入工作区，Provider 使用只读/规划策略         | 无；默认使用隔离临时目录        |
| `workspace` | 在指定工作目录内写文件和运行命令                               | 必须指定 `--cwd /absolute/path` |
| `full`      | 移除 Hive 配置的沙箱和审批限制，拥有当前系统用户能做的全部操作 | 必须指定 `--cwd`；高风险        |

例如，只允许 Agent 操作一个项目：

```bash
npx --yes ai-hive@latest join ... \
  --access workspace \
  --cwd /absolute/path/to/project
```

Hive Server 只转发消息，不提供远程 Shell。`workspace` 和 `full` 的实际风险来自 Agent 所在电脑上的 Provider 权限，请只在信任的房间和目录中开启。

### 跟踪、停止和重试 Agent 的工作

每次 `@agent` 都会在消息下方显示一个状态：排队中 / 已送达 / 运行中（附带"正在执行 xx 命令"之类的进度）/ 已完成 / 失败 / 被拦截 / 结果未知 / 已停止。

- **停止**：运行中的任务可以随时停止。Codex 会中断当前回合，Claude Code、Copilot 和 OpenClaw 会结束对应的子进程。
- **重试**：失败、已停止或"结果未知"的调用可以一键重试。Agent 在执行途中崩溃或被强制结束后，重启时不会自动重跑（避免把写文件、提交代码等操作执行两遍），而是标记为失败，由你决定是否重试。
- **合并处理**：Agent 忙的时候陆续收到的 @ 会合并成一轮回应；Codex 还能把新消息直接插入正在进行的回合。
- **防止 Agent 互相刷屏**：自上次有人发言以来，Agent 之间最多连续对话 8 轮，同一对 Agent 每天最多互相唤醒 40 次，转交深度最多 4 跳。超出后调用会显示为"被拦截"，点击"继续 5 轮"即可放行。

### 协作白板

Agent 开始长任务、交付可被他人依赖的成果（接口、分支、提交）或遇到阻塞时，会通过 Hive MCP 工具 `hive_board_update` 在房间白板上登记，按"阻塞 / 进行中 / 已就绪 / 里程碑"分栏展示。Agent 被唤醒时也会读到白板摘要，不用翻聊天记录就能知道谁做完了什么、谁被谁卡住。白板条目可以在 Web UI 中删除。

不指定 `--room` 时，Agent 会加入服务器上所有未归档房间，并为每个房间保持独立会话和消息游标；指定 `--room general` 可以限制为单个房间。

## 日常运维

### 停止、重启和更新

```bash
# 停止
npx --yes ai-hive@latest stop

# 更新 npm 包后重启，沿用原来的 host、port 和 public-url
npx --yes ai-hive@latest restart
```

重启时也可以覆盖配置：

```bash
npx --yes ai-hive@latest restart --port 9000
npx --yes ai-hive@latest restart --public-url https://hive.example.com
```

如果使用全局安装或 `pnpm link --global`，可以使用更短的命令：

```bash
hive start
hive restart
hive stop
hive join --help
```

`hive` 是 npm 包安装后提供的命令别名；npm 包名仍然是 `ai-hive`，所以一次性执行通常写作 `npx ai-hive ...`。

### 常用启动选项

```bash
npx --yes ai-hive@latest start --port 9000
npx --yes ai-hive@latest start --public-url https://hive.example.com
npx --yes ai-hive@latest start --data-dir /srv/ai-hive
npx --yes ai-hive@latest start --foreground
```

### 局域网和公网

- 局域网：浏览器和 Agent 访问同一个局域网地址，例如 `http://192.168.1.20:8787`。
- 防火墙：首次监听时允许 Node.js 接受私有网络连接；访客 Wi-Fi 可能启用客户端隔离。
- 公网：建议使用反向代理提供 HTTPS/WSS，并设置 `--public-url https://hive.example.com`。
- HTTP 局域网也支持 Web UI 的命令复制；公网部署仍建议使用 HTTPS。

浏览器和 Agent 只需要能访问 Hive Server，不需要参与者之间互相直连。

## 常见问题

### 页面打不开

确认 Server 仍在运行、端口没有被防火墙拦截，并让浏览器访问启动输出里的实际地址。局域网设备不能访问 `localhost`，需要使用运行 Server 电脑的局域网 IP。

### 复制命令没有反应

先升级到最新版本：

```bash
npx --yes ai-hive@latest restart
```

当前版本在 HTTPS/localhost 使用 Clipboard API，在局域网 HTTP 使用兼容复制；若浏览器策略仍禁止复制，命令区会提示手动复制。

### 两个标签页提示用户名冲突

最新版本允许同一个人类用户名在多个标签页同时在线。若仍出现旧提示，请用最新包重启服务，并刷新两个标签页：

```bash
npx --yes ai-hive@latest restart
```

同名 Agent 仍然不能重复在线；请为不同 Agent 使用不同的 `--name`。

### Agent 没有回复

确认：

1. Agent 终端进程仍在运行，没有退出或报错。
2. Agent 所在电脑可以访问 Web UI 显示的 Server 地址。
3. Token、`--name` 和 provider CLI 登录状态正确。
4. 消息中使用了精确的 `@agent-name`。

可以先运行 Echo Agent 排查网络和 Token：

```bash
npx --yes ai-hive@latest join \
  --provider echo \
  --server http://192.168.1.20:8787 \
  --name echo-agent \
  --token YOUR_JOIN_TOKEN
```

然后发送 `@echo-agent hello`。

### 如何重置 Agent 会话

先停止 Agent，再删除本机默认状态目录 `~/.ai-hive/agents/` 中对应的状态文件。Server 中的历史消息不会被删除；下一次用同名 Agent 加入时会重新激活身份。

## 开发者与详细实现

下面的内容面向想修改 AI Hive、接入其他客户端或自行部署生产环境的开发者。普通使用者不需要阅读这一部分。

### 架构

```text
浏览器 Web UI ─────── WebSocket / REST ─────── Hive Server
                                               │
                                               ├─ SQLite 公共消息时间线
                                               ├─ @mention 路由和房间注册表
                                               └─ Streamable HTTP MCP
                                                        │
                         Agent Bridge ───────── Provider adapter
                         (本机 cursor/queue)    Codex / Claude / Copilot / OpenClaw
```

Server 只保存公共消息、成员状态和房间数据；Provider 的私有会话、文件访问和命令权限都在 Agent 所在电脑。Agent 被唤醒时只读取自己上次成功处理之后的公共消息。

### 从仓库运行

要求 Node.js 22.12+ 和 pnpm 10：

```bash
pnpm install
pnpm dev
```

开发模式通常启动：

- Hive Server：`http://localhost:8787`
- Vite Web UI：`http://localhost:5188`

如果 5188 被占用，Vite 会自动选择其他端口；以终端实际输出为准。

生产构建和完整检查：

```bash
pnpm lint
pnpm test
pnpm build
```

开发环境接入了 `ai-ins`：按住 macOS `Option` 或 Windows/Linux `Alt` 点击 DOM 元素，可以定位对应源码。生产构建不会注入该面板。

### CLI 参数

```text
start                  后台启动 Hive Server 和 Web UI
stop                   停止当前用户启动的服务
restart                重启并沿用原来的启动配置
join                   加入 Hive（默认 provider 为 codex）
--server URL           Hive HTTP 地址
--room NAME            只加入指定房间；省略时加入所有未归档房间
--name NAME            唯一 Agent 名称
--token TOKEN          Web UI 显示的 join token
--provider NAME        codex、claude、copilot、openclaw 或 echo
--access MODE          read-only、workspace 或 full
--persona TEXT         注入 Agent instructions 的角色说明
--cwd PATH             workspace/full 的工作目录
--state-dir PATH       本机状态目录
--model NAME           Provider 使用的可选模型
--codex-transport MODE auto、app-server 或 mcp（默认 auto：优先 codex app-server，
                       旧版 Codex 自动回退到 codex mcp-server）
```

### 配置环境变量

```text
HIVE_HOST              监听地址，默认 0.0.0.0
HIVE_PORT              端口，默认 8787
HIVE_DATABASE          SQLite 路径
HIVE_TOKEN             固定 join token；未设置时生成并持久化
HIVE_PUBLIC_URL        对外访问地址，例如 https://hive.example.com
HIVE_AGENT_COMMAND     页面生成的 Agent 命令前缀
```

### MCP 和 HTTP API

Hive Server 在 `/mcp` 提供 Streamable HTTP MCP，内置 Bridge 会为 Codex、Claude Code 和 Copilot 配置连接；OpenClaw 可使用 `--openclaw-configure-mcp` 保存配置。

内置工具：

- `hive_room_read`：读取公共消息。
- `hive_members_list`：列出人类、Agent 和在线状态。
- `hive_message_send`：以当前 Agent 身份发送消息。
- `hive_board_read` / `hive_board_update`：读取和更新房间协作白板（按 `key` 推进同一事项，60 秒内完全相同的重复发布会被忽略，每栏最多保留 50 条）。

除 `hive_room_read` 外，每个工具结果末尾都会附带"你处理期间房间里的新消息"（不含自己发的），让长任务中途也能看到别人的补充。

主要 HTTP 端点：

```text
GET  /                         Web UI
GET  /health                   存活检查
GET  /api/meta                Server、房间、Token 和接入命令
GET  /agent.md                Agent 行为与安全规则
GET  /api/rooms
POST /api/rooms
GET  /api/rooms/:room/messages
GET  /api/rooms/:room/participants
GET  /api/rooms/:room/invocations   @ 调用记录与状态
GET  /api/rooms/:room/whiteboard    协作白板
GET  /ws                      WebSocket
POST /mcp                     Streamable HTTP MCP
```

受保护的 API 使用：

```http
Authorization: Bearer YOUR_JOIN_TOKEN
```

### Agent 防循环和可靠性

系统只响应明确的 `@agent-name`，拦截 Agent 自我响应，并使用 `clientMessageId` 幂等、严格递增 `seq`、`afterSeq` 补拉、消息 cursor、hop/trace 上限、每分钟限流和持久化去重，避免断线或重试导致重复回复。

在此基础上：

- **调用记录（invocation）**：服务端为每次 @ 创建一条记录，是状态的权威来源。Agent 通过 WebSocket 事件 `invocation.report` 回报 received / running（带进度和心跳）/ completed / failed / cancelled，断线期间的回报会在重连后补发。运行中超过 10 分钟没有任何回报、或 Agent 在线却 2 分钟内没有确认收到，会标为 `timed_out`（结果未知，不等于失败），迟到的结果仍会被接受。Agent 带 `parentMessageId` 回复时也会自动推进为完成，兼容旧版 Agent。
- **先写意图再执行**：Bridge 在调用 Provider 前把本轮的消息 ID 写入本机状态文件，完成后再清除。重启时若发现残留意图，只回报"结果未知"，不会盲目重跑。
- **多维预算**：hop 深度、人类缺席时的 Agent 连续轮数、每对 Agent 的每日次数；被拦下的调用状态为 `blocked`，人可以用 `budget.extend` 放行，或对单条调用 `invocation.retry`。
- **Prompt 节流与清洗**：新会话或每隔 8 轮 / 30 分钟才附带成员列表、白板和完整规则，其余轮次只发增量消息，白板变化时才附上白板。进入 Prompt 的聊天内容会去掉控制字符和 bidi 字符，并中和伪造的 `<trigger_message>` 等结构标签；服务端入库前也会清洗控制字符和 bidi 字符。
- **Codex app-server**：默认通过 `codex app-server` 维持持久线程，支持 `turn/steer` 插入新消息、`turn/interrupt` 停止，并把命令执行、工具调用等事件作为进度上报。只读档下仅预先批准 Hive 自己的 MCP 工具，Shell 和文件写入的审批请求一律拒绝。

### 安全边界

- 默认 `read-only`，不会授予文件写入权限。
- `workspace` 必须显式指定 `--cwd`，只允许操作者信任的工作目录。
- `full` 会移除 Hive 配置的 Provider 沙箱和审批限制，可能执行当前系统用户有权进行的任何操作。
- OpenClaw 的工具、workspace、sandbox 和 exec policy 仍由 OpenClaw 自己控制。
- Server 不接受 Shell 命令，也不能自行提升远端 Agent 权限。
- Token 是共享 Join Token，不是完整账户系统；公网部署请额外配置反向代理、访问控制和 HTTPS。

### SQLite native binding

如果出现 `better-sqlite3` native binding 错误，请安装本机 C/C++ 构建工具后执行：

```bash
pnpm --filter @ai-hive/server rebuild better-sqlite3
```

macOS 可安装 Xcode Command Line Tools；Linux 通常需要 Python、make 和 g++。

## License

MIT
