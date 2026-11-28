# 开发者文档

面向想修改 SuperHive、接入其他客户端或自行部署生产环境的开发者。普通使用者看 [README](../README.zh-CN.md) 和 [日常使用](usage.md) 就够了。

- [架构](#架构)
- [从仓库运行](#从仓库运行)
- [CLI 参数](#cli-参数)
- [配置环境变量](#配置环境变量)
- [MCP 和 HTTP API](#mcp-和-http-api)
- [Agent 规则和协作说明（SKILL.md）](#agent-规则和协作说明skillmd)
- [界面多语言](#界面多语言)
- [Agent 防循环和可靠性](#agent-防循环和可靠性)
- [本机 Agent 管家](#本机-agent-管家)
- [安全边界](#安全边界)
- [SQLite native binding](#sqlite-native-binding)

## 架构

```text
浏览器 Web UI / 飞书 / 微信 ── WebSocket / REST ── Hive Server
                                                    │
                                                    ├─ SQLite 公共消息时间线、调用记录、白板、定时任务
                                                    ├─ @mention / 主 Agent 路由和房间注册表
                                                    ├─ 本机 Agent 管家（在本机拉起 hive join）
                                                    └─ Streamable HTTP MCP（/mcp）
                                                             │
                              Agent Bridge ───────── Provider adapter
                              (本机 cursor/queue)    Codex / Claude / Copilot / OpenCode / omp / OpenClaw
```

Server 只保存公共消息、成员状态和房间数据；Provider 的私有会话、文件访问和命令权限都在 Agent 所在电脑。Agent 被唤醒时只读取自己上次成功处理之后的公共消息。

仓库结构：

| 目录                 | 内容                                                                         |
| -------------------- | ---------------------------------------------------------------------------- |
| `packages/protocol`  | 前后端共用的类型、zod schema 和 `LIMITS`                                     |
| `packages/superhive` | npm 包 `superhive`：CLI（`hive`）、Bridge、各 Provider 适配器                |
| `apps/server`        | Hive Server（Fastify + WebSocket + SQLite + MCP + IM 接入）                  |
| `apps/web`           | 网页（React + Vite）                                                         |
| `apps/docs`          | 独立静态图文文档（Astro + Starlight），无需 Hive Server 即可部署             |
| `skills/superhive`   | 给 Agent 读的协作说明 SKILL.md，随 npm 包发布，`hive --skill` 打印           |
| `scripts`            | `pnpm dev` 的开发 supervisor（见 [scripts/README.md](../scripts/README.md)） |

## 从仓库运行

要求 Node.js 22.12+ 和 pnpm 10：

```bash
pnpm install
pnpm dev
```

开发模式通常启动：

- Hive Server：`http://localhost:8787`
- Vite Web UI：`http://localhost:5188`

如果 5188 被占用，Vite 会自动选择其他端口；以终端实际输出为准。

`pnpm dev` 下改动 Server 源码会自动换代重启 Server：本机 Agent 不中断，交接给新 Server 接管，期间的回复等 Server 恢复后再交。Windows 上同样可用。停掉 `pnpm dev` 本身（Ctrl+C、关掉终端）也走交接：本机 Agent 接着做手上的任务，2 分钟内重新 `pnpm dev` 就由新 Server 接管；一直没有新 Server 时它们自己离线。想停 `pnpm dev` 时连本机 Agent 一起停，用 `HIVE_DEV_KEEP_AGENTS=0 pnpm dev` 启动。网页改动走 Vite 热更新；Bridge（`packages/superhive`）的改动由 Server 等 Agent 空闲后自动重启它生效（设置里可关），正在跑的任务不会被打断。

生产构建和完整检查：

```bash
pnpm lint
pnpm test
pnpm build
```

`pnpm install` 会顺带把仓库的 Git 钩子目录设成 `.githooks`（只在没设过 `core.hooksPath`、`.git/hooks` 里也没有自己的钩子时）：提交前拒绝任何 `node_modules` 路径，包括软链过来的依赖目录。`pnpm test` 里也会检查已提交的文件（`node scripts/git-hooks.mjs check`）。`pnpm test` 按包依次跑（`--workspace-concurrency=1`），各包的 vitest 不互相抢 CPU，机器忙时少出偶发超时。不想启用设 `HIVE_SKIP_GIT_HOOKS=1`。Hive 新建的任务目录会自动准备依赖，见 [worktrees.md](worktrees.md#dependencies)。

只跑某个包：`pnpm --filter @superhive/server test`、`pnpm --filter superhive test`、`pnpm --filter @superhive/web test`。文档可单独用 `pnpm docs:dev` 编辑、`pnpm docs:verify` 验收，发布配置见 [apps/docs/README.md](../apps/docs/README.md)。npm 包的打包产物在 `packages/superhive` 里用 `pnpm build` 生成（CLI、打包后的 Server、网页、SKILL.md），`pnpm pack` 可以在发布前本地验证；不需要打包独立文档站才能运行 Hive。

开发环境接入了 `ai-ins`：按住 macOS `Option` 或 Windows/Linux `Alt` 点选 DOM 元素，写下需求后会连同源码位置交给本机的 Agent CLI（Codex、Claude Code 等）直接改代码，热更新后即可看到结果。生产构建不会注入该面板。

## UI 验证（沙箱预览 + 截图）

Agent 改了网页、要给人看效果时，按这个流程走，不要自己手搓临时 Server 或截图脚本，也不要直接拿真实数据库起服务。

**1. 起沙箱**：在任务线根目录运行

```bash
pnpm preview:sandbox                                            # 空库
pnpm preview:sandbox --from-data ~/Coding/ai-hive/apps/server/data   # 真实数据的副本
```

- 先构建本任务线的 protocol 和网页，再直接跑本任务线的 Server 源码，看到的就是这条分支的效果。已经构建过可以加 `--no-build`。
- 只监听 `127.0.0.1`，自动挑一个空闲端口，就绪后打印 `SANDBOX_URL=http://127.0.0.1:<端口>`。也可以用 `--port` 指定端口；端口被占用时直接报错，不会去结束别人的进程。
- 外面带进来的 `HIVE_*` 环境变量不会传给沙箱 Server，只有慢操作阈值 `HIVE_SLOW_*` 例外：例如 `HIVE_SLOW_REQUEST_MS=1 HIVE_SLOW_ALERT_MS=1 pnpm preview:sandbox` 能马上造出慢操作，在左侧「故障 → 慢操作」里看效果。
- 数据放在临时目录里，退出（Ctrl+C）时删掉；加 `--keep` 可以保留。原数据目录只读打开（`VACUUM INTO` 快照），不会被改。
- **复制时就剔除**：IM 连接、凭据和投递队列（`im_*`）、房主登录设备和配对票据（`owner_*`）、访客会话、邀请链接、join token、房主登录签名密钥、待执行的任务目录清理批次；本机 Agent 的自启和任务目录的自动清理都关掉。不拷 `im-secret.key`、`agent-logs`、`agent-settings`；附件默认一起拷，APFS 上是写时复制，加 `--no-attachments` 就不拷。剔除之后会 `VACUUM`，删掉的密钥不会留在文件的空闲页里。
- **服务端还有一道硬开关**（`HIVE_SANDBOX=1` / `BuildAppOptions.sandbox`），不靠删数据来保证：
  - IM 驱动不加载，已保存的连接不恢复，也不能扫码新连；
  - 本机 Agent 不拉起，「在终端打开」不可用；
  - 定时任务到点不发；
  - 任务目录只读：不建、不删，也不自动清理。副本里登记的路径指向真实仓库，这一条是防止误删真实任务目录；
  - 不阻止睡眠，也不读写 `~/.claude`、`~/.codex` 这类运行时全局配置（设置里的「Agent 运行时」分类因此不显示）。

  `/health` 和 `/api/meta` 带 `sandbox: true`，网页顶部会显示「沙箱预览」标记，标题前也会加上「[沙箱]」。启动脚本会核对 `/health`，如果 Server 没有进入沙箱模式，就立刻把它停掉。

**2. 截图**：用独立的无头 Chrome，临时 profile 用完即删，不碰你自己的浏览器和登录状态。

```bash
pnpm screenshot --url $SANDBOX_URL --room build --theme light,dark --out output/after.png
pnpm screenshot --url $SANDBOX_URL --room build --action code --width 1440 --height 900 --scale 2
pnpm screenshot --url $SANDBOX_URL --action settings:appearance --action "click:.some-button"
pnpm screenshot --compare output/before.png output/after.png --out output/compare.png
```

- 自动跳过首次引导和通知授权提示，默认以 `rd` 进入（`--user` 可以改），并开启「减少动态效果」，截出来的图更稳定。
- 预置动作有：`code`、`artifacts`（打开「代码」或「产物」面板）、`settings[:分类]`、`schedules`（打开左侧「定时任务」面板）、`side:<members|whiteboard>`、`click:<选择器>`、`wait:<毫秒>`、`wait-for:<选择器>`、`eval:<JS>`，按顺序执行。元素 10 秒内没出现就报错，不会把截错的图当成功。
- `--theme light,dark` 一次截两张，文件名自动加上 `-light`、`-dark`。`--compare` 会把多张图原尺寸并排拼起来，并加标签（默认「改前」「改后」）。
- 「改前」的图：在 main 的工作区（或改动前的提交）上照样起一个沙箱再截。
- `--hide-sandbox-badge` 可以隐藏顶部的沙箱标记。Chrome 按常见安装位置查找，也可以用 `--chrome` 或环境变量 `CHROME_PATH` 指定。
- 沙箱里不起本机 Agent，`/api/local/*` 也是关的。要看本机 Agent 相关的界面，用 `--init-script scripts/fixtures/local-agents.js` 加载测试替身：它在页面加载前拦截 fetch 和房间快照，模拟几个忙、空闲、旧版本、已停止的本机 Agent，例如 `pnpm screenshot --url {url} --init-script scripts/fixtures/local-agents.js --action settings:computer`。`--init-script` 可以重复，自己写的替身脚本也能这样加载。左侧「故障」入口再叠加 `scripts/fixtures/incidents.js`：它给出几张故障单、一条待批准的规则提议和几条慢操作，并替换掉沙箱 Server 推来的空数据。「Agent 任务」弹窗要看调用持续更新时的样子（比如往下翻到用量时位置会不会跳），用 `scripts/fixtures/activity-churn.js`：它假装有十几个进行中的调用，默认每秒推一条 `invocation.updated`（进度变化、跑完带回用量、新调用开始），地址加 `?churn=毫秒` 改间隔，配 `--from-data` 能看到真实的用量统计。

**一次跑完**：在 `--` 后面写要执行的命令，Server 就绪后运行它。命令里的 `{url}` 会换成沙箱地址，环境变量 `SANDBOX_URL` 也会带上；命令结束后沙箱自动关闭，退出码和命令一致：

```bash
pnpm preview:sandbox --from-data ~/Coding/ai-hive/apps/server/data -- \
  pnpm screenshot --url {url} --room build --action artifacts --theme light,dark --out output/artifacts.png
```

**3. 附到交付**：截图放在 `output/`（已被 gitignore），不要提交进仓库；交付消息里用附件发出。写清是空库还是副本、截了哪些画面、哪些画面没截到（比如窄屏、需要真实 IM 的界面）。

沙箱里看不到这些：IM 收发、Agent 实际执行、定时任务触发，以及任务目录的建、删和清理。要验证这些，得用测试，或者在真实环境里经房主同意后再试。

### UI 交互自查清单（交 review 前逐条过，review 方逐条核）

改了弹层、下拉、菜单、列表、面板的，交付里要逐条写「过」或「不涉及」，并附对应截图；少一条 review 就退回。

1. **能关上**：点外面、按 Esc、再点一次触发按钮、选中一项（包括当前项），都能关上，关上后焦点回到触发按钮。
2. **不跟着乱滚**：展开或聚焦时，只有列表自己滚动，弹层和页面不跟着滚。上面的标题、开关一直看得见，弹层高度贴合内容，不留空白。
3. **数据多的时候**：按真实规模造数据截图，例如 16 个 Agent（里面有忙的和离线的）、很长的名字和说明、空列表。超过 8 项的选择列表要有过滤。
4. **状态看得清**：在线、忙、离线、出错、空状态都有可见的区别，不能只靠颜色。不能用的项要变灰，鼠标移上去说明原因。鼠标点过、按过方向键以后，整块区域（列表、面板、对话区）不能套上浏览器默认的蓝色焦点框；焦点框只给按钮、链接、输入控件和显式 `tabindex="0"` 的元素，统一用 `base.css` 里的淡灰框，别给容器加 `tabindex="0"` 或自己写 `outline`。
5. **文字少**：一行能说清的不写成一段，解释放进悬停提示。不要把多种信息拼成一串文字。
6. **两种主题、窄屏**：浅色和深色都要截，深色下的进度条、边框、底色要看得见；280px 宽的侧栏不能挤成一团。
7. **只改要求的地方**：`git diff main --stat` 里不能出现需求以外的界面文件。需求指的是哪一块不确定时，先拿截图问清楚再动手。

### 二次确认用哪个

不要用浏览器原生的 `window.confirm` / `alert` / `prompt`：不跟主题，桌面端标题栏还会显示网址。

- **就地气泡 `ConfirmPopover`**（`confirm-popover.tsx`）：只影响眼前这一个控件、点错了也好改回来的，比如切换设置、写入配置。气泡贴着按钮弹出，不挡别的内容。
- **确认弹窗 `confirmAction`**（`confirm-dialog.tsx`）：收不回、或影响别人和整个房间的，比如删除、撤销、断开、中断正在执行的任务。`await confirmAction({ title, message, confirmLabel, danger })` 拿到 `true` / `false`；标题一句话说要做什么，`message` 一两行说后果，按钮写具体动作，不写「确定」；收不回的加 `danger`，焦点默认停在「取消」上。

## CLI 参数

```text
hive start              后台启动 Hive Server 和 Web UI
hive stop               停止当前用户启动的服务
hive restart            重启并沿用原来的启动配置
hive autostart on|off|status  登录后自动启动 Hive Server
hive telemetry status|on|off|preview|reset  查看、开关匿名使用统计，预览要发送的数据
hive join               加入 Hive（默认 provider 为 codex）
hive mcp list           列出 Agent 会加载的本机 MCP 及开局 token 估算
hive mcp check          从标准输入读一个 MCP 配置，测能不能用（能用 / 需要登录 / 连不上 / 起不来）
hive skill install|status|uninstall  把 SKILL.md 装进本机 Agent 的全局 skills 目录 / 查看版本 / 移除
hive skill search <词>  在 skills.sh 上搜别人分享的 skill（--owner 限定 GitHub 用户、--json 输出 JSON；安装在网页里做）
hive --skill            打印随包发布的 SKILL.md
hive --version
```

`hive start` / `hive restart`：

```text
--host ADDRESS     监听地址（默认 0.0.0.0）
--port PORT        监听端口（默认 8787）
--data-dir PATH    数据、PID 和日志目录（默认 ~/.superhive）
--public-url URL   对外访问地址；反向代理或多网卡时使用
--token TOKEN      固定 Join Token；默认首次启动时自动生成
--no-local-agents  关闭网页上的「在本机启动 Agent」（restart 可用 --local-agents 重新开启）
--foreground       在前台运行，不启动后台进程
--no-open          启动后不自动打开浏览器（restart 默认不打开，--open 打开）
```

`hive join`：

```text
--server URL           Hive HTTP 地址
--room NAME            只加入指定房间；省略时加入所有未归档房间，并自动跟随新建与归档
--name NAME            唯一 Agent 名称
--token TOKEN          网页显示的 join token（也可用环境变量 HIVE_AGENT_TOKEN）
--provider NAME        codex、claude、copilot、opencode、omp、openclaw 或 echo
--access MODE          read-only、workspace 或 full
--persona TEXT         注入 Agent instructions 的角色说明
--cwd PATH             workspace/full 的工作目录（read-only 默认使用该 Agent 专属的空目录）
--allow-root PATH      允许跟随房间工作区切换到的目录（可重复）；默认只有 --cwd 及其上一级
--trust-room-workspace 房间工作区一律跟随（本机 Hive Server 拉起的 Agent 使用）
--state-dir PATH       本机状态目录（默认 ~/.superhive/agents）
--model NAME           Provider 使用的可选模型（OpenCode 为 provider/model 格式）
--codex PATH / --claude PATH / --copilot PATH / --openclaw PATH / --opencode PATH / --omp PATH
                       各 Provider CLI 的命令
--codex-transport MODE auto 或 app-server（两者相同）；旧的 mcp 已移除：Codex 0.154 起没有
                       mcp-server 子命令，Hive 要求 Codex ≥ 0.105.0
--openclaw-local       强制 OpenClaw 使用 embedded agent，不连接 Gateway
--openclaw-agent ID    OpenClaw 中已配置的 Agent ID
--openclaw-configure-mcp  将当前 Hive MCP 身份保存到 OpenClaw 配置
--agent-settings FILE  Agent 设置文件（{"mcpDisabled": [...]}），每一轮重新读取
```

各命令的权威说明以 `hive <命令> --help` 为准。

## 配置环境变量

```text
HIVE_HOST              监听地址，默认 0.0.0.0
HIVE_PORT              端口，默认 8787
HIVE_DATABASE          SQLite 路径
HIVE_TOKEN             固定 join token；未设置时生成并持久化
HIVE_PUBLIC_URL        对外访问地址，例如 https://hive.example.com
HIVE_AGENT_COMMAND     页面生成的 Agent 命令前缀
HIVE_LOCAL_AGENTS      设为 0 关闭网页上的「在本机启动」
HIVE_IM_WECHAT         设为 0 整体不加载个人微信通道
HIVE_WORKTREE_DEPS     设为 0 不再给新任务目录自动准备依赖
HIVE_SANDBOX           设为 1 进入沙箱预览：不连 IM、不起本机 Agent、不跑定时任务、不建删任务目录（见「UI 验证」）
HIVE_SLOW_OP_MS        锁、git、重查询超过多少毫秒记为慢操作，默认 3000
HIVE_SLOW_REQUEST_MS   HTTP 请求和 MCP 工具超过多少毫秒记为慢操作，默认 5000
HIVE_SLOW_OP_HISTORY   内存里保留最近多少条慢操作，默认 200
HIVE_SLOW_ALERT_MS     慢操作合计超过多少毫秒时在本机房主页面弹提示，默认 15000
HIVE_SLOW_LOCK_ALERT_MS  等锁超过多少毫秒时弹提示，默认 10000
HIVE_ROOM_ATTACHMENT_QUOTA_MB     每个房间的附件总量，默认 1024
HIVE_PENDING_ATTACHMENT_QUOTA_MB  每个上传者已上传未发出的附件总量，默认 200
HIVE_NO_OPEN           设置后 hive start 不打开浏览器（BROWSER=none、CI 同样）
HIVE_AGENT_TOKEN       hive join 的 token（代替 --token，不出现在进程参数里）
HIVE_CLAUDE_KEEPALIVE_MS  Claude Code 进程一轮结束后保留多久给下一轮复用（毫秒，默认 600000；0 = 每轮新起进程）
NO_UPDATE_NOTIFIER=1   关闭新版本提示
SUPERHIVE_TELEMETRY=0  关闭匿名使用统计（DO_NOT_TRACK=1、CI、沙箱、测试环境同样一律不记），见文档站「使用统计」
SUPERHIVE_TELEMETRY_URL  使用统计的上报地址（http/https）；默认为空，只在本机记录、不发送
SUPERHIVE_TELEMETRY_DIR  使用统计的安装 ID、开关和待发队列放哪，默认 ~/.superhive/telemetry
```

## MCP 和 HTTP API

Hive Server 在 `/mcp` 提供 Streamable HTTP MCP，内置 Bridge 会为 Codex、Claude Code、Copilot、OpenCode 和 omp 配置连接；OpenClaw 可使用 `--openclaw-configure-mcp` 保存配置。MCP 调用需要 Bearer token，并且 `X-Hive-Room` / `X-Hive-Agent-Name` 对应一个已经在线的 Agent 身份，所以只能经 Bridge 使用。

内置工具：

- `hive_room_read`：读取公共消息。列表模式下长正文只给 4000 字符预览，并标明原始长度和是否截断；按 `messageId` / `offset` 分段补读全文，每次最多 8000 字符，按返回的 `nextOffset` 读到结束。
- `hive_members_list`：列出人类、Agent 和在线 / 忙闲状态。
- `hive_todo_list` / `hive_todo_add` / `hive_todo_update`：当前房间的待办清单；列表支持 `completed` 筛选及 `offset` / `limit` 分页（默认 50、最多 100），更新用 `todoId`，`completed: true` 标记完成。负责人使用成员 ID；访客 Agent 可读但不能写。
- `hive_message_send`：以当前 Agent 身份发送消息。`progress=true` 发中途进度：必须挂在自己正在执行的调用下，人发起的任务最多 3 条、Agent 之间委派的 1 条（按这一轮执行计数），不推进调用、不派发 @（@ 到 Agent 直接拒绝）、不占连续轮数。
- `hive_invoke`：把子任务委派给另一个 Agent，返回子任务调用 ID。子任务结束（完成、失败、停止或结果未知）后，服务端会自动代被委派方给委派方发一条「子任务回执」并唤醒它，不需要轮询，也不依赖对方记得回头 @。回执只发一次，服务重启后会补发；预算照常计算。不能委派给自己或仍在等待自己结果的上游。
- `hive_wait`：短时等待一个子任务结束，默认 20 秒、最多 30 秒。拿到结果后不再单独回执；窗口用完只表示还没结束，不算失败；子任务被预算拦下时立即返回，需要人确认。
- `hive_ask_human`：需要人拍板时向人提一个问题。服务端发出一条提问消息，当前调用转为「等你回答」，不会被超时判为卡住。可传 `options`（2–10 个，服务端编为 A、B、C…）和 `multiple`；点选由服务端按保存的题目校验，生成带选项原文的完整答案，同一提问只续接一次。委派来的子任务提问时，结果回执会跟到回答后的那次调用上。点选回答的 `answer` 带 `questionMessageId` 和 `questionSeq`；Bridge 组 prompt 时，回答（点选或手打回复提问）指向的提问不在本轮上下文里，就按 seq+id（旧消息没有 seq 时按 id）补拉，校验同房间、序号一致、未撤回后在触发消息下加一行 `[回答提问]`，附约 600 字提问摘录（已在上下文里时只给序号指引）。提问时服务端在调用上记下 `questionMessageId` 和 `questionSeq`，网页「等你回答」的各个入口（底部卡片、进展、任务面板、提醒）据此直接定位提问，没载入时从提问那条起连续补拉；旧调用没有这两项，退回在已载入消息里按父消息找。
- `hive_attachment_read`：读取本房间已发出消息里的附件。文本按字节分段（`offset` / `nextOffset`，不切断多字节字符），PNG/JPEG/GIF/WebP（不超过 3.75 MB）以 MCP 图片内容返回，其它二进制只返回元数据。未发出、已撤回或其他房间的附件一律读不到。和 `hive_room_read`、`hive_members_list`、`hive_board_read` 一样标为只读工具，Claude Code 只读档（plan 模式）也能调用。
- `hive_board_read` / `hive_board_update`：读取和更新房间当前协作白板（按 `key` 推进同一事项，60 秒内完全相同的重复发布会被忽略；更新归档事项会恢复它）。服务端把登记时 Agent 正在处理的消息记成条目的 `messageId` / `messageSeq`（网页「进展」点击跳转用）；任务目录扫描发现条目分支已合入时转成里程碑并写 `mergedAt`；里程碑 3 天未更新自动归档。不按数量自动删除，历史不进入 Agent 摘要。
- `hive_schedule_create` / `hive_schedule_list` / `hive_schedule_cancel`：一次性定时任务。到点服务端以发起人名义发「⏰ 定时任务」消息唤醒登记者；每个房间最多 20 个待执行；Server 不在线、晚于 10 分钟才轮到的标为已错过。
- `hive_room_create`：替房主新建房间（可带已存在的工作区目录），本机 Agent 会自动加入。只在房主本人发起的任务里可用。
- `hive_room_post`：替房主到另一个房间（填房间 ID 或显示名称都行：先按 ID 精确匹配，再按名称找，同名或找不到时报错并列出候选房间）以自己的名义发消息、@ 接活的 Agent，开新的传递链并注明来源；刚建的房间会等被 @ 的 Agent 上线（最多 20 秒）。只在房主本人发起的任务里可用，那边由 Agent 发起的任务不能再往外转。
- `hive_incident_report`：被派修故障单的 Agent 回报结果（见「故障单」）。`fixed` 要带提交号和症状、原因、修法，`failed` 要写原因；不是派给自己的单不能回报。访客带入的 Agent 没有这个工具。
- `hive_rule_propose`：提议加一条协作规则。房主在网页上批准后接在 `/agent.md` 后面，Agent 重启后生效。访客带入的 Agent 没有这个工具。

除 `hive_room_read` 外，每个工具结果末尾都会附带「你处理期间房间里的新消息」（不含自己发的），让长任务中途也能看到别人的补充。

主要 HTTP 端点：

```text
GET  /                         Web UI
GET  /health                   存活检查（带 pid、instanceId）
GET  /api/meta                 Server、房间、Token 和接入命令（Token 只给本机房主）
GET  /agent.md                 Agent 行为与安全规则
GET  /api/rooms
POST /api/rooms
PATCH /api/rooms/:room          改名、归档、工作区、主 Agent（leadMode: "auto" 改回自动）
GET  /api/rooms/:room/messages?afterSeq=&limit=
GET  /api/rooms/:room/participants
GET  /api/rooms/:room/invocations   @ 调用记录与状态
GET  /api/rooms/:room/whiteboard    协作白板
GET  /api/rooms/:room/todos         待办列表
POST /api/rooms/:room/todos         添加待办（成员权限）
PATCH /api/rooms/:room/todos/:id    修改 / 完成待办
DELETE /api/rooms/:room/todos/:id   删除待办
POST /api/rooms/:room/todos/:id/handoff  以人的身份交给 Agent
POST /api/rooms/:room/todos/:id/move  上下移动未完成待办
POST /api/rooms/:room/whiteboard/archive  房主批量归档
POST /api/rooms/:room/whiteboard/restore  房主批量恢复
POST /api/rooms/:room/attachments   上传附件（multipart/form-data，单个文件字段）
GET  /api/attachments/:id           下载附件（只认 Authorization 头）
DELETE /api/attachments/:id         移除还没发出的附件
GET  /api/attachments/:id/local-path  本机房主 Agent 取 Server 存的文件路径
GET  /api/local/...                 本机 Agent、目录、MCP、保持在线、设备登录等（只对本机房主开放）
GET  /api/local/incidents           故障单、经验库、规则提议和派修设置（只限本机）
PATCH /api/local/incidents/settings 改派修设置
POST /api/local/incidents/:id/action        { action: ignore | reopen | resolve | dispatch }
POST /api/local/rule-proposals/:id/decision { decision: approve | reject | retire }
POST /api/client-errors             房主页面上报自己的报错（每分钟最多 30 条）
POST /api/local/rooms/:room/clear    房主或获批管理设备清空房间
GET  /ws                       WebSocket（发消息、调用状态回报、实时事件）
POST /mcp                      Streamable HTTP MCP
```

白板 `GET` 默认只返回当前事项；`?view=archived` 只返回归档，`?view=all` 返回两者，读取仍按房间隔离。归档／恢复请求为 `{ entries: [{ id, updatedAt }] }`，最多 200 条且 ID 不重复；房主权限、工作区占用保护和版本校验全部通过才在同一事务写入，否则整批失败（400 参数错误、401 未认证、403 非房主、404 房间内不存在、409 工作区占用或版本冲突）。归档广播兼容旧客户端的 `whiteboard.removed`，附带可选 `archivedEntry` 供新客户端保存历史；恢复沿用 `whiteboard.updated`。旧数据库迁移仅增加可空 `archived_at`，已有条目保持当前。新网页历史删除带 `updatedAt`，已恢复或被更新的旧选择不能误删当前事项；旧客户端不带版本的删除保留兼容，但同样不能删除仍占用已登记工作区的事项。

清空接口为 `{ username, whiteboard?: "archive" | "keep", entries?: [{ id, updatedAt }] }`；默认 `archive`，`keep` 只清聊天与调用记录，不接受 `entries`。新网页提交清空前读取的完整当前白板版本，空白板提交空数组；新增、删除或更新导致集合／版本变化时返回 409，未做任何清理。旧客户端省略 `entries` 时仍对事务内完整当前白板检查保护。归档与删除聊天／调用、取消定时任务在同一数据库事务内完成，历史白板、用量账本和工作区登记不删除。受保护事项导致 409，必须先解决或显式选择 `keep`，不能静默跳过。每条归档沿用 `whiteboard.removed`，然后广播 `room.cleared`，可选 `whiteboardArchived` 用于新网页失效旧历史请求；旧事件没有该字段时保留原白板行为。

受保护的 API 使用：

```http
Authorization: Bearer YOUR_JOIN_TOKEN
```

## Agent 规则和协作说明（SKILL.md）

Agent 的行为规则有一份权威来源：`apps/server/src/agent-instructions.ts` 里的 `AGENT_INSTRUCTIONS`。

- `GET /agent.md` 直接返回它，Bridge 启动时读取并注入给 Agent。
- `skills/superhive/SKILL.md` 里「房间规则」一节由它生成（两个 `<!-- BEGIN/END agent-instructions -->` 标记之间）。改了规则后运行 `pnpm --filter @superhive/server skill:sync` 同步；`apps/server/src/agent-skill.test.ts` 在两边不一致时失败。SKILL.md 其余部分（接入方式、工具列表）手写维护。
- npm 包构建时把 `skills/` 复制进包里，`hive --skill` 打印这一份，`hive skill install` 把它装进本机 Agent 的全局 skills 目录（`~/.claude`、`~/.codex`、`~/.openclaw`，实现见 `packages/superhive/src/skill-install.ts`）；仓库公开后也可以用 `npx skills add wangrongding/SuperHive --skill superhive` 安装。
- Bridge 每轮拼进提示词的规则（`packages/superhive/src/prompt-builder.ts`）是另一份更贴近 Bridge 行为的写法，改规则时两处都要看。

## 界面多语言

网页文案以中文原文作为 key 写在 `t("…")` 里，英文译文在 `apps/web/src/i18n/en.json`，查不到时退回中文。模块顶层的常量表用 `localized(() => …)` 包一层，或者存中文、渲染时再过 `t()`。

- `apps/web/src/i18n/coverage.test.ts` 会扫描源码：`t()` 字面量和常量表里的中文都要有译文，en.json 里不能有没人用的词条，译文里不能夹中文，`{0}` 这类占位符要和原文对应。新增或改动文案后跑一遍 web 测试就能发现漏翻。
- 服务端发出的文字（错误提示、调用状态说明、回执、定时任务消息、飞书卡片）走另一份共享文案目录，不在 en.json 里。

**英文文案约定**

- 句首大写（sentence case），按钮用动词开头：`Add agent`、`Start a new topic`，不用 `Agent adding`。
- 产品名和专有名词保持原样：SuperHive、Hive Server、Bridge、MCP、Feishu、WeChat、Claude Code、Codex。
- 失败提示用 `Couldn't …`（动作没做成）或 `Can't …`（现在做不了），后面跟一句怎么办；不用 `please`。
- 句子里的 agent 小写，句首大写；@ 提到时写 `@rd-claude`。

**术语表**（中文界面用词 → 英文）

| 中文                        | 英文                                     | 说明                                                 |
| --------------------------- | ---------------------------------------- | ---------------------------------------------------- |
| 房间                        | room                                     |                                                      |
| 房主 / 访客                 | owner / guest                            |                                                      |
| Agent                       | agent                                    | 句首写 Agent                                         |
| 主 Agent                    | lead agent                               |                                                      |
| 运行时                      | runtime                                  | Claude、Codex 这类                                   |
| 本机 / 这台电脑             | this computer                            | 不用 machine                                         |
| 目录 / 工作目录             | folder / working directory               | 说明文字里用 folder                                  |
| 任务 / 调用                 | task                                     | 界面上统一叫 task，不出现 invocation、call           |
| 一轮 / 执行                 | turn / run                               | 「第 n 次执行」= Run n；Agent 连续对话的「轮」= turn |
| 执行过程                    | activity                                 | 详情里的完整列表叫 Full activity                     |
| 思考                        | thinking                                 |                                                      |
| 进度                        | progress update                          | 标签写 Progress                                      |
| 引导                        | steer                                    | Steer into current task / Send & steer               |
| 委派 / 转交 / 回执 / 子任务 | delegation / handoff / receipt / subtask |                                                      |
| 撤回                        | unsend                                   | 不用 recall                                          |
| 撤销（邀请链接）            | revoke                                   |                                                      |
| 话题 / 新话题               | topic / new topic                        |                                                      |
| 白板                        | whiteboard                               |                                                      |
| 定时任务 / 周期             | scheduled task / series                  | 左侧入口和面板标题写 Schedules                       |
| 批准 / 放行                 | approve / approval                       |                                                      |
| 结果未知                    | outcome unknown                          |                                                      |
| 需要你处理                  | needs you                                | 计数里写 need attention                              |
| 完成未看                    | finished, not viewed                     |                                                      |
| 邀请链接                    | invite link                              |                                                      |
| 接入 Agent                  | add an agent                             |                                                      |
| 用量                        | usage                                    |                                                      |

**状态词**（同一种状态在状态条、思考卡片、成员列表、跳转面板里写法一致）

| 状态                                   | 英文                                                                          | 说明                                                           |
| -------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 任务执行中（进行中 / 执行中 / 运行中） | Running                                                                       | 计数写 `{0} running`                                           |
| Agent 在干活（正在处理 / 工作中）      | Working                                                                       | 说的是 Agent 本身，不是某条任务；成员在线状态的「忙碌」是 Busy |
| 正在思考                               | Thinking                                                                      | 思考卡片停在思考那一步时用                                     |
| 排队中                                 | Queued                                                                        | 已送达还没开始写 Delivered, waiting in queue                   |
| Agent 不在线时排队（等待上线）         | Agent offline                                                                 |                                                                |
| 等你回答                               | Waiting for your answer                                                       |                                                                |
| 等你放行 / 等房主批准 / 等待批准       | Waiting for your approval / Waiting for owner approval / Waiting for approval | 中文本来区分是谁在批，英文也保留                               |
| 停止中 / 已停止                        | Stopping / Stopped                                                            |                                                                |
| 已完成 / 失败 / 结果未知               | Completed / Failed / Outcome unknown                                          |                                                                |
| 白板的「进行中的工作」                 | In progress                                                                   | 指登记的工作，不是任务执行                                     |

**同一个中文要两种英文时，改中文原文拆开**，不在 en.json 里加上下文：比如侧栏标题用「房间列表」（Rooms），每行的类型标签用「房间」（Room）；Go To 的筛选标签用「只看任务」（Tasks）。

**单复数**：网页文案写 `{0|one|other}`，比如 `ran {0} {0|command|commands}`；服务端和飞书的文案目录（`packages/protocol/src/server-text.ts`）写 `en: { one, other }`。两边语法不同，是因为网页词表是「中文原文 → 一条英文字符串」的 JSON，只能把选择写进字符串里；服务端目录本来就是结构化条目，可以直接放两种写法。两边选写法都应调 protocol 的 `isEnglishSingular`（`Intl.PluralRules("en")`），规则一致。

## Agent 防循环和可靠性

系统只响应明确的 `@agent-name`（以及设了主 Agent 的房间里人发的、不带 @ 的消息），拦截 Agent 自我响应，并使用 `clientMessageId` 幂等、严格递增 `seq`、`afterSeq` 补拉、消息 cursor、来回检测（同一对 Agent 不经人互相 @ 超过 `LIMITS.maxAgentPingPongMessages` 条就暂停）、连续轮数预算、每分钟限流和持久化去重，避免断线或重试导致重复回复。转交链本身不限深度和总条数：`hive_invoke` 的派活和子任务回执是有上游在等结果的结构化委派，不计入轮数预算，也不触发来回检测（rd #6608 之前的 12 跳 / 40 条上限会把正常的长委派链拦下，已取消）。

在此基础上：

- **调用记录（invocation）**：服务端为每次 @ 创建一条记录，是状态的权威来源。Agent 通过 WebSocket 事件 `invocation.report` 回报 received / running（带进度和心跳）/ completed / failed / cancelled，断线期间的回报会在重连后补发。运行中超过 10 分钟没有任何回报、或 Agent 在线却 2 分钟内没有确认收到，会标为 `timed_out`（结果未知，不等于失败），迟到的结果仍会被接受。Agent 带 `parentMessageId` 回复时也会自动推进为完成，兼容旧版 Agent。
- **停止**：「停止中」收到「结果未知」时直接转为结果未知（说明里写明无法确认工具子进程都已停下），不再等 10 分钟；对已经结束的一轮点停止，Bridge 立即答复。停止请求在 Agent 离线时由服务端保留，重连后送达，超过 10 分钟没确认按结果未知放开。
- **先写意图再执行**：Bridge 在调用 Provider 前把本轮的消息 ID 写入本机状态文件，完成后再清除。重启时若发现残留意图，只回报「结果未知」，不会盲目重跑。
- **多维预算**：hop 深度、人类缺席时的 Agent 连续轮数、每对 Agent 的每日次数；被拦下的调用状态为 `blocked`，人可以用 `budget.extend` 放行，或对单条调用 `invocation.retry`。
- **Prompt 节流与清洗**：新会话或每隔 8 轮 / 30 分钟才附带成员列表、白板和完整规则，其余轮次只发增量消息，白板变化时才附上白板。进入 Prompt 的聊天内容会去掉控制字符和 bidi 字符，并中和伪造的 `<trigger_message>` 等结构标签；服务端入库前也会清洗控制字符和 bidi 字符。
- **OpenCode / omp（ACP）**：通过 [Agent Client Protocol](https://agentclientprotocol.com) 驱动常驻的 `opencode acp` / `omp --mode acp`。Hive MCP 随 `session/new` 按会话注入，不写任何配置文件；Agent 发起的权限请求按 `--access` 档位逐次裁决（只读档只放行读取类工具，工作区档的文件改动必须落在 `--cwd` 内）；停止走 `session/cancel`，会话在重启后通过 `session/resume` / `session/load` 恢复。OpenCode 的权限基线经 `OPENCODE_CONFIG_CONTENT` 注入（被禁用的工具不会出现在工具集里），omp 用 `--tools` 白名单。
- **Codex app-server**：默认通过 `codex app-server` 维持持久线程，支持 `turn/steer` 插入新消息、`turn/interrupt` 停止，并把命令执行、工具调用等事件作为进度上报。只读档下仅预先批准 Hive 自己的 MCP 工具，Shell 和文件写入的审批请求一律拒绝。
- **Codex 失败与重试边界**：握手超时、配置或协议错误会保留失败阶段，不再自动切换到旧 MCP 或连续重跑。发出执行/注入请求后断连、结果丢失、停止未获终态确认，一律按结果未知处理，不自动重放；当前适配器会话锁定，必须先核对实际执行与工具进程。明确不存在的旧线程才可在执行前新建；其他恢复错误不丢弃会话。`turn/completed` 的可信终态才是停止确认。
- **Claude Code**：用 stream-json 流式输入，引导在工具间隙被读到，回放确认收下才算插入，没收下的退回排队。
- **上游出错自动继续**：只认明确的上游错误写法（限流、过载、5xx、断流），额度用完、鉴权失败不重试；这一轮做过有副作用的操作（按只读命令白名单判断，认不出的按有副作用）就不自动继续。

## 故障单（自动归类、派修、经验库）

失败先分清是谁的问题，再决定要不要改代码（`apps/server/src/incidents.ts` 归类，`incident-desk.ts` 决策，`incident-store.ts` 存储）：

- **外部原因**（`external`）：模型服务出错或限流、凭证、Agent 离线、Agent 自己的 CLI 崩溃。Bridge 本来就会重试和提示，这里只计数，不派修。
- **我们的问题**（`internal`）：Bridge 与 Server 对不上账或卡住（`invocation.stale`、`invocation.unacknowledged`、`bridge.steerEndRace` 等）、Server 抛的异常（HTTP 5xx、WebSocket 事件处理、MCP 工具里不是 `HiveError` 的异常）、已接入的 Agent 发来没通过协议校验的事件、房主页面上未捕获的报错。
- **说不清**（`unknown`）：旧版 Bridge 只给了中文说明，或新的原因键。只记下来，房主判断后可以手动派修。

调用失败按 Bridge 的结构化原因键（`detailText.key`）归类，表在 `incidents.ts` 的 `INVOCATION_ORIGINS`；新加 Bridge 原因键时记得补上。例外是 `bridge.uncertain`、`bridge.unsafe`：原因是 Bridge 没能向 Server 核对任务目录（`Cannot verify managed task workspace`、`Online local agent required` 等）时算我们的问题，指纹多一段 `:workspace-check`，不和同键的其他原因混在一起。同一种错误按指纹合并：调用失败是「原因键 + 运行时」，异常是错误类型加调用栈前三帧（去掉行列号、`node_modules`、打包文件名里的哈希，路径只留仓库内部分）。每张单留最近 5 次现场（房间、调用、Agent、路由、调用栈、在跑的代码提交），本机用户目录换成 `~`；凭证（Bearer/Basic 认证头、`sk-`/`ghp_`/`github_pat_`/`xox*` 这类密钥、JWT、URL 里的用户名密码和 token/key/secret/password/auth/signature 参数、`"token": …`/`x-hive-owner: …` 这类键值，以及这台 Server 的入房令牌和房主令牌原值）一律换成 `<secret>`，派修消息发出前再过一遍；不记消息正文和工具参数。同一次出现（同一调用的同一次尝试）只记一次。

**派修**：在左侧「故障」面板顶部点「派修设置」展开，打开「自动派修」，从下拉里选房间、修的 Agent 和 review 的 Agent（下拉列的是所选房间的 Agent，review 的不能和修的同一个），三个次数用步进器调（派修阈值、每日上限 1–20，修失败找人 1–5）。每项改了就存，不用点保存；派活人固定是房主（网页把当前用户名一起存进 `requester`），不用填。我们的问题出现到阈值（默认 3 次）后，Server 以房主的名义 @ 修的 Agent，消息里带现场、相关经验、受保护路径，要求先写复现测试再修、提交信息末尾加 `Incident: <短号>`、用 `hive_incident_report` 回报后交 review。合入仍由 review 方和人决定，Server 不合入、不回滚。

- 每天（本地日期）最多自动派修 `dailyLimit` 次（默认 3）；房主手动派修不受阈值、开关和每日上限限制。
- 派出去的调用失败、被停止或结果未知，或 24 小时没回报，算一次没修成；修好后同一种错误又出现（修复已在跑的代码里），重新打开、也算一次，并在房间里提醒房主考虑回滚。累计 `maxAttempts` 次（默认 2）就升级给人：自动派修停下，页面上标「需要你处理」。
- 回报 `fixed` 时 Server 用 `git diff` 核对这个提交相对主分支改了哪些文件：动了 `PROTECTED_PATHS`（权限、协作规则、门禁、审计、故障单系统本身）直接升级给人，经验不入库；改了已有测试（不是新增）不拦，记在派修记录上给 review 的人看。
- 修复有没有进在跑的代码：Server 启动时记下源码仓库的 `HEAD`，每分钟查一次交了修复的单，修复提交是它的祖先、或它的历史里有带 `Incident: <短号>` 的提交（变基后提交号会变）就标为已解决，经验标为已验证。
- 不是从源码仓库运行的 Server（`npx` 安装、沙箱预览）核对不了修复，只归类计数，不派修。

**在网页上哪里看**：故障单、规则提议、经验库和最近慢操作是要看、要处理的东西，不是设置，放在左侧快捷入口「故障」里（`incidents-dialog.tsx`），只对这台电脑上的房主显示（条件同顶栏任务目录下拉：`local.enabled && local.mode === "local"`）。入口上的数字是我们的问题里待处理、升级给人的单加待批准的规则提议，没有就不显示；慢操作不计数。升级给人的单和待批准的规则提议同时进左侧「需要你处理」，点了打开面板并定位到那一条。派修设置也在这个面板里（顶部「派修设置」点开才展开），「设置」里没有任何故障相关内容。页面靠 `incidents.changed` 推送得知有变化，稍等 300 毫秒再拉 `/api/local/incidents`。

**经验库与规则**：每次回报 `fixed` 的症状、原因、修法存进经验库，派修时附上最相关的 5 条（同一张单的优先，再是同一来源的）。Agent 用 `hive_rule_propose` 提的规则要房主在左侧「故障」面板里批准，批准后接在 `/agent.md` 后面（「房主批准的补充规则」），撤下后不再加进去；Agent 重启后拿到新规则。

## 本机 Agent 管家

`apps/server/src/local-agents.ts` 的 `LocalAgentSupervisor` 负责网页上「在本机启动」的 Agent 的进程生命周期，配置存在 SQLite 的 `local_agents` 表：

- **autostart 标记**：创建、启动、重启时置为开，手动停止时置为关；Server 关闭、交接、崩溃都不改它。Server 启动时（`start()`）按这个标记恢复：上一个 Server 交接留下、命令行确实是同名 `hive join` 的进程直接接管；其余需要拉起的按顺序错开 2 秒逐个启动，等待期间状态是「启动中」，期间点停止或启动都会取消排队。
- **崩溃重启**：意外退出按 1 秒起指数退避（最长 60 秒），10 分钟内退出 5 次熔断，停止自动重启。
- **交接**：开发时代码换代或 Server 升级，旧 Server 调 `detach()` 只停止跟踪不结束进程，进程号落库后由新 Server 接管；Agent 断线期间自行重连。由 Server 拉起的 Agent 带 `HIVE_SUPERVISOR_PID`，Server 消失且宽限期内没有新 Server 接管时自行离线退出，不留孤儿。
- **关闭**：`shutdown()` 先 SIGTERM（Windows 上经 WebSocket 请它自己退出）让 Agent 正常离线，5 秒后仍未退出再强制结束。
- **Windows 上不弹窗**：Server 和写日志文件的本机 Agent 都是后台常驻进程，统一用 `background-process.ts` 的 `spawnBackground` 拉起（server 和 superhive 各带一份，内容相同）。macOS / Linux 仍是 detached 加日志文件。Windows 上不能用 detached，因为 `DETACHED_PROCESS` 让进程没有控制台，它再拉起的控制台程序只要漏写 `windowsHide`，就会各自新开一个可见窗口；不 detached 又会被 libuv 的作业对象绑住，父进程一退就跟着结束。所以 Windows 上先带 `windowsHide` 起一个 PowerShell，它会得到隐藏的控制台，再由它 `Start-Process -NoNewWindow` 拉起真正的进程：真正的进程共用这个隐藏控制台、脱离作业对象，日志句柄照常继承，pid 经临时文件交回，退出靠轮询发现。其余所有 `spawn` / `execFile` 都要写 `windowsHide: true`，三个包里各有一条 `console-window.test.ts` 扫源码检查，确实要开窗口的（「在终端打开」）写进白名单并说明原因。
- **开机自启**：`hive autostart`（`packages/superhive/src/autostart.ts`）只负责登录后启动 Server（`hive start --no-open`，沿用 `server.json` 里上次的启动配置），Agent 的恢复仍由上面的 autostart 标记决定。

## 安全边界

- 默认 `read-only`，不会授予文件写入权限。
- `workspace` 必须显式指定 `--cwd`，只允许操作者信任的工作目录。
- `full` 会移除 Hive 配置的 Provider 沙箱和审批限制，可能执行当前系统用户有权进行的任何操作。
- 「在本机启动」只对同一台电脑上的房主开放。每个请求都必须同时满足以下条件，join token 不能用来启动进程：
  - 对端是回环地址或本机网卡地址；
  - 没有经过反向代理（带 `X-Forwarded-For` 等转发头的请求会被拒绝）；
  - `Host` 是 `localhost` 或本机 IP（防 DNS rebinding）；
  - `Origin` 属于本机（防跨站请求）；
  - 带有 Server 每次启动时生成的房主凭证。
- 房主在其他设备登录后的管理权需要本机或飞书批准，完全权限的启动逐次批准，详见 [日常使用](usage.md#房主在其他设备上登录)。
- 在本机启动的工作区和完全访问都必须指定工作目录，目录由服务端校验，并以真实路径（realpath）存储；join token 通过环境变量传给子进程，不出现在进程参数里。用 `hive start --no-local-agents` 或 `HIVE_LOCAL_AGENTS=0` 可以整体关闭这项功能。
- OpenClaw 的工具、workspace、sandbox 和 exec policy 仍由 OpenClaw 自己控制。
- Server 不接受 Shell 命令，远端成员无法让 Server 执行任何程序；本机房主只能用固定参数拉起 `hive join`。Server 也不能自行提升远端 Agent 的权限。
- Token 是共享 Join Token，不是完整账户系统；公网部署请额外配置反向代理、访问控制和 HTTPS。

## SQLite native binding

如果出现 `better-sqlite3` native binding 错误，请安装本机 C/C++ 构建工具后执行：

```bash
pnpm --filter @superhive/server rebuild better-sqlite3
```

macOS 可安装 Xcode Command Line Tools；Linux 通常需要 Python、make 和 g++。

## 许可证与外部贡献

自 0.3.0 起整个仓库（含 npm 包 `superhive`）采用 AGPL-3.0-only；npm 上已发布的 0.2.0 及更早版本仍是 MIT，不可追回。

作者保留对外提供商业授权（AGPL 豁免）的权利，这要求作者对代码拥有完整的再授权权。因此在合入第一个外部贡献之前，必须先补上贡献约定，二选一：

- 贡献者签 CLA（如 CLA Assistant），授权作者以其他许可证再发布其贡献；
- 或在 CONTRIBUTING.md 写明「提交 PR 即同意该贡献按 AGPL-3.0-only 发布，并授权作者以商业许可再授权」，PR 模板里加勾选项。

没有这一步就合入的外部代码，只能按 AGPL 使用，会让后续的商业授权失效。
