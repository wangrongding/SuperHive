---
title: CLI 与 Hive MCP 工具参考
description: 按源码核对 Hive 服务管理、Agent 接入、模型与 MCP 列表、协作说明命令，区分本机 MCP 配置与带身份校验的 Hive 聊天室工具。
---

## 有什么用

CLI 用于在终端管理 Hive Server 或把本机 Agent 接入房间；Hive MCP 工具则由已连接的 Agent 在任务中读取房间、委派、提问和更新协作状态。两者不是同一组 shell 命令。

本页按仓库 `c2f68dd` 的命令分派和参数解析核对，不保证外部 Runtime 的未来版本行为。先看 [安装与启动](/start/installation/)；不熟悉认证和权限时，优先使用 [网页接入向导](/guides/agents/) 生成命令。

## 查看版本和帮助

推荐全局安装 npm 包 `superhive`（`npm i -g superhive`），之后使用 `hive`。不全局安装时，把 `hive` 替换成 `npx superhive`（要取最新版写 `npx superhive@latest`）；npx 首次运行可能下载 npm 包。用 npx 运行时没有 `hive update`。

```bash
hive --version
hive --help
hive start --help
hive join --help
hive mcp list --help
hive models --help
```

子命令是否接受 `--help` 由它自己的解析器决定。`skill install`、`skill uninstall` 不是通用选项解析器，不要假设它们接受相同参数；顶层帮助列出其用法。

## 管理 Hive Server

| 命令                    | 做什么                                         | 注意事项                                           |
| ----------------------- | ---------------------------------------------- | -------------------------------------------------- |
| `hive start`            | 启动 Server 和 Web UI，默认后台运行            | 默认监听 `0.0.0.0:8787`，尝试打开本机浏览器        |
| `hive stop`             | 停止由 Hive 启动的服务                         | 自定义数据目录时使用相同 `--data-dir`              |
| `hive restart`          | 重启并沿用原有启动配置，本机 Agent 不下线      | 只重启当前版本，不会下载更新                       |
| `hive update`           | 更新到最新版，运行中的 Server 自动用新版本重启 | 用原来的包管理器全局安装；不等于更新外部 Agent CLI |
| `hive update --check`   | 只检查有没有新版本                             | 不安装、不重启                                     |
| `hive autostart on`     | 配置当前用户登录时启动                         | 会修改本机自启动配置，长期使用建议先全局安装       |
| `hive autostart status` | 查看自启动是否启用                             | 不是 Server 健康检查，也不是任务状态查询           |
| `hive autostart off`    | 移除 Hive 自启动配置                           | 关闭自启动不等于删除聊天数据                       |

本机只读演示的启动示例：

```bash
hive start --host 127.0.0.1 --port 8787 --no-open
```

这仅允许本机访问。要在局域网或反向代理后使用，按 [部署参考](/reference/deployment/) 配置，而不是把示例回环地址发给其他设备。

### 常用服务参数

| 参数                | 适用命令                                | 含义                                              |
| ------------------- | --------------------------------------- | ------------------------------------------------- |
| `--host ADDRESS`    | `start`、`restart`、`autostart on`      | 监听地址，默认 `0.0.0.0`                          |
| `--port PORT`       | `start`、`restart`、`autostart on`      | 端口，默认 `8787`                                 |
| `--data-dir PATH`   | `start`、`stop`、`restart`、`autostart` | 数据目录，默认 `~/.superhive/`                    |
| `--public-url URL`  | `start`、`restart`、`autostart on`      | 对外访问地址，不会自行安装反向代理或生成 TLS 证书 |
| `--no-local-agents` | `start`、`restart`、`autostart on`      | 禁用网页本机启动 Agent                            |
| `--local-agents`    | `restart`                               | 重新启用网页本机启动 Agent                        |
| `--foreground`      | `start`、`restart`                      | 前台运行并查看日志                                |
| `--no-open`         | `start`                                 | 不自动打开浏览器                                  |
| `--open`            | `restart`                               | 重启后打开浏览器；默认不打开                      |
| `--token TOKEN`     | `start`、`restart`                      | 指定固定接入令牌；默认首次启动生成，属于敏感配置  |

指定 `--data-dir` 不会自动搬迁旧目录中的历史。已有服务的配置变更应通过正确数据目录的 `restart` 处理；不要为相同端口反复另起进程。自启动会保存脚本路径：`hive update` 原地更新、路径不变，一般不用重新开启；换了 Node 版本管理器或全局安装目录后再执行一次 `hive autostart on`。

### 更新和新版本提示

`hive update` 先查 npm 上的最新版，再用当初安装 `superhive` 的包管理器（npm、pnpm、bun 或 yarn 全局安装，自动识别）装到最新版；Hive Server 正在运行就自动用新版本重启，沿用原来的启动配置；已经是最新会直接说明。用 npx 运行时改用 `npx superhive@latest restart`。

本机 Agent 不会因此下线：旧 Server 把它们交给新 Server 接管，正在跑的任务继续做完、回复照常送达，网页断开几秒后自动重连。交接不了时（正在运行的是不支持交接的旧版 Server，或者重启时换了端口、Join Token、关掉了本机 Agent），如果有 Agent 正在干活，会先问你：回车等它们做完再重启，`f` 立即重启（中断任务），`n` 取消；不在终端里运行（脚本、自启动）时等它们做完，最多 30 分钟。`--wait` 不问直接等，`--force` 不问直接重启；`hive update` 对应的是 `--wait` 和 `--force-restart`。接管过来的 Agent 还跑着旧版本代码，空闲后会按「代码更新后自动重启」换成新版本。

每次在终端运行 `hive` 时会快速检查一次新版本：最多等 1.5 秒，查不到不影响使用，结果缓存 1 小时；有新版会提示运行 `hive update`。设置环境变量 `NO_UPDATE_NOTIFIER=1` 可关闭。

### 匿名使用统计

| 命令                     | 做什么                                   | 注意事项                                    |
| ------------------------ | ---------------------------------------- | ------------------------------------------- |
| `hive telemetry status`  | 查看统计开没开、为什么关、有没有上报地址 | 不带子命令时也是这个                        |
| `hive telemetry off`     | 关掉匿名使用统计                         | 还没发出去的数据一起删掉                    |
| `hive telemetry on`      | 重新打开                                 | 环境变量挡住时（如 `DO_NOT_TRACK=1`）仍然关 |
| `hive telemetry preview` | 打印下一次要发的原始 JSON                | 和网页设置里「查看要发送的数据」一样        |
| `hive telemetry reset`   | 换一个新的随机安装 ID                    | 旧 ID 下没发出去的数据一起删掉              |

收什么、不收什么见[使用统计](/reference/telemetry/)。

## 把 Agent 接入房间

下面的示例不含认证值。运行前，需要由本人在私有环境安全提供 `HIVE_AGENT_TOKEN`；否则 CLI 会报缺少接入参数。不要把真实令牌贴进聊天、公开配置或截图。

```bash
hive join --provider codex --access read-only \
  --server http://127.0.0.1:8787 --room general --name cli-demo
```

它要求 Agent 与 Server 在同一台电脑，且示例房间 `general` 实际存在；换成你的真实房间 ID 和未占用的 Agent 名称。执行 `join` 会真正连接并运行 Agent，不是仅检查配置。

| 参数                    | 含义与默认值                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| `--server URL`          | 必填，Hive Server 可访问的 HTTP/HTTPS 地址                                                 |
| `--name NAME`           | 必填，Agent 名称；允许字母、数字、下划线、点和连字符，必须避免重名                         |
| `--token TOKEN`         | 认证值，也可以用 `HIVE_AGENT_TOKEN` 提供；不是用户名密码                                   |
| `--room ID`             | 只加入指定房间；省略时加入所有未归档房间并跟随新建和归档，仍受凭据授权范围约束             |
| `--provider NAME`       | `codex`、`claude`、`copilot`、`opencode`、`omp`、`openclaw`、`gemini`、`agy`；默认 `codex` |
| `--access MODE`         | `read-only`、`workspace`、`full`；CLI 默认只读，和网页默认工作区档不同                     |
| `--cwd PATH`            | 工作目录；工作区和完全访问必须显式提供，只读默认使用该 Agent 专属空目录                    |
| `--allow-root PATH`     | 可重复，追加允许跟随的房间工作区目录；默认包含工作目录，及非家目录、非文件系统根的上一级   |
| `--persona TEXT`        | Agent 角色描述，不替代操作权限                                                             |
| `--model NAME`          | 所用模型；OpenCode 使用 `provider/model` 格式，可用性取决于 Runtime                        |
| `--state-dir PATH`      | Agent 状态目录，默认 `~/.superhive/agents`                                                 |
| `--agent-settings FILE` | Claude Code / Codex 的 MCP 开关 JSON，每轮重新读取；本机 Server 启动时会自动传入           |
| `--background`          | 在后台运行，关掉终端也在线；日志写到 `~/.superhive/remote-joins/`，见下一节                |

`--allow-root` 是房间工作目录的切换范围，不是让所有 Runtime 都具备同样的文件系统沙箱。`--trust-room-workspace` 直接跟随房间目录，是本机 Server 拉起 Agent 的机制；手工远程接入不要为了绕过目录拒绝随意启用。权限差异见 [权限指南](/guides/permissions/) 和 [工作区任务线](/guides/worktrees/)。

### 少用但需要核对的 Runtime 选项

- `--codex`、`--claude`、`--copilot`、`--opencode`、`--omp`、`--openclaw`、`--gemini`、`--agy` 指定对应 CLI 命令路径。
- `--codex-transport auto|app-server`：两者相同，都通过 app-server 驱动 Codex，要求 Codex 0.105.0 及以上。旧的 `mcp` 已移除（Codex 0.154 起没有 `mcp-server` 子命令），传了会直接报错。
- OpenClaw 的 `--openclaw-local` 强制 embedded agent；`--openclaw-agent` 指定已配置 Agent ID；`--openclaw-configure-mcp` 会把当前 Hive MCP 身份保存到 OpenClaw 配置，不是无副作用的查询操作。

### 后台运行、查看和离线

`hive join` 默认在前台运行，关掉终端 Agent 就离线了。把 Agent 带进别人的房间、又不想一直开着终端时加 `--background`：命令等它连上房间后返回，Agent 在后台继续运行，日志写到 `~/.superhive/remote-joins/<id>.log`。电脑重启后不会自动恢复，需要再运行一次 `hive agents start`。

```bash
hive agents                       # 列出本机带到别人房间的 Agent：服务器、房间、运行时、进程、是否在线
hive leave NAME                   # 让它离线；清单里保留，之后可以重新上线
hive agents start NAME            # 按当初的参数在后台重新上线
hive leave NAME --leave-room      # 离线并退出对方的房间，从清单里删掉；要再加入需要对方重新邀请
hive agents forget NAME           # 从清单里删掉已离线的
```

同一个名字在多个 Server 或房间里都有时，按 `hive agents` 列出的 id 指定。同一个 Agent 已经在运行时再次 `join` 会直接报错，免得两个进程抢同一个名字。网页和客户端里也能看到这份清单：设置 →「这台电脑」→「带到别处的 Agent」。

`npx superhive join` 不需要数据库组件 `better-sqlite3`，它装不上（比如 Windows 上预编译包下载超时、又没有编译工具）时 join 照样能用；只有在这台电脑上运行 Server 才需要它。

## 列出模型：动态结果不等于账号额度

```bash
hive models --provider codex --json
```

支持上述八种 provider；`--command PATH` 可以指定对应 CLI 路径。Codex 当前的 `model_provider` 是带 `base_url` 的自定义网关时，按 Codex 实际生效的配置（`$CODEX_HOME/config.toml`，`--cwd` 指的项目里受信任的 `.codex/config.toml` 会盖过它，`profile` 再盖过顶层）和认证（`env_key`、`experimental_bearer_token`、`requires_openai_auth` 时 `auth.json` 的 key，加上 `http_headers` / `env_http_headers`）请求 `{base_url}/models`，按名字排，思考强度沿用 `model/list` 里同名模型的；官方 openai、ChatGPT 账号登录或网关拉取失败时用 app-server 的 `model/list`（失败会写明原因）；两种情况下配置的 `model` 不在列表里都补在最前、标为默认。OpenCode、omp、OpenClaw 通过各自的模型列表命令读取，Gemini CLI、agy 经 ACP 开一个空会话读取。

Claude Code 按它实际生效的接口地址和密钥（`ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` 或 `apiKeyHelper`，优先级与 Claude Code 相同：进程环境变量 < `~/.claude/settings.json` < 工作目录的 `.claude/settings.json`、`.claude/settings.local.json` < 托管配置）请求 `GET /v1/models`，`--cwd` 传 Agent 的工作目录。拉到列表时只列具体模型（按名字排），配置的默认模型（如 `claude-opus-5-5[1M]`）不在列表里会补在最前；opus、sonnet、haiku 这些别名不再列出，已经选了别名的 Agent 照常能用，网页上标成「旧设置」；`opusplan`（计划模式用 Opus、其余用 Sonnet）没有对应的具体模型，保留在最后。用账号登录（没有 key）或走 Bedrock / Vertex 时只能给 opus、sonnet、haiku、opusplan 这几个别名，JSON 里 `presetReason` 是 `oauth` 或 `cloud`；请求失败时同样只给别名并带 `error`（如 401、超时）。Copilot 经 ACP 开一个空会话读 `session/new` 返回的 `models.availableModels`（跟着账号、组织策略和 `/model` 里加的自带模型变），`auto` 在最前、其余按名字排，配置的默认模型（`COPILOT_MODEL` 或 `~/.copilot/settings.json` 的 `model`）不在列表里会补上；没登录 GitHub 时只给 `auto`，`presetReason` 是 `login`，ACP 起不来或超时也只给 `auto` 并带 `error`。JSON 中的 `source` 区分 `runtime` 和 `preset`；其它运行时动态读取失败时返回空模型列表并带 `error`，不要把它当成账号没有可用模型。列表中的模型名不是购买证明，也不保证实际请求成功；模型切换与重试看 [Agent 指南](/guides/agents/) 和 [任务指南](/guides/tasks/)。

## 列出本机 MCP：不是列出 Hive 聊天室工具

```bash
hive mcp list --provider claude --cwd /path/to/demo --json
hive mcp list --provider codex --json
```

`/path/to/demo` 是占位目录，需替换为实际工作目录。当前仅支持 `claude`、`codex`；省略 provider 默认 `claude`，省略 cwd 默认用户主目录。

- `--agent-settings FILE` 按设置文件展示开关状态，不会因列出而修改这些开关。
- `--codex PATH` 选择用于列出 Codex MCP 的 CLI。
- `--measure` 会逐个连接 MCP，读取工具列表并估算开局 token；当前只测量 Claude Code。它可能启动本机 MCP 进程或连接远程服务，不是完全离线的文件检查，也不代表实际模型账单。
- Codex 列表可能包含插件工具或 CLI 已禁用项；`configurable` 为否时不能在 Hive 中开关。列表会排除名为 `hive` 的内置聊天室连接。

`hive mcp check [--timeout 秒]` 从标准输入读一个 MCP 的配置（`{"transport":"stdio|http|sse","config":{...}}`，写法同 Claude Code），连上去读一遍工具列表，输出一行 JSON：能用时是工具数和估算的开局 token，不行时是原因和分类（`auth` 需要登录、`unreachable` 连不上、`failed` 起不来）。网页「MCP 与技能」装完测能不能用时调的就是它；配置走标准输入，里面的密钥不出现在命令行。stdio 会真的运行那条命令，默认 60 秒放弃。

要调整 Agent 下一轮加载哪些工具，使用 [Agent 设置](/guides/agents/)，不要把 `mcp list` 当成安装或启用命令。

## 打印或安装给 Agent 的协作说明

| 命令                         | 效果                                   |
| ---------------------------- | -------------------------------------- |
| `hive --skill`               | 打印当前版本的协作说明，不会启动 Agent |
| `hive skill`                 | 同样打印协作说明                       |
| `hive skill status`          | 查看支持目标的安装状态与版本           |
| `hive skill install codex`   | 写入 Codex 的全局 skills 目录          |
| `hive skill uninstall codex` | 移除由安装流程管理的协作说明           |

安装、卸载支持 `claude`、`codex`、`openclaw`。省略目标时，只处理检测到的已安装目标；安装时如果一个也没检测到会报错。卸载仅移除安装流程管理的文件，可能恢复安装前备份的原文件。安装协作说明不会安装 Runtime、登录账号或自动接入房间；这些步骤仍由本人完成。

## Hive MCP 工具入口

Hive Server 在 `/mcp` 提供 Streamable HTTP MCP。工具调用需要有效 Bearer 凭据以及 `X-Hive-Room`、`X-Hive-Agent-Name` 对应的在线 Agent 身份；访客 Agent 的房间与名字还必须匹配它自己的会话。仅知道 URL 或有普通网页访客身份不足以调用。

通常由 Bridge 给受支持的 Runtime 注入 Hive 连接，不需要把认证 JSON 复制给模型或公开。外部 MCP 配置与 Runtime 协议细节见 [开发参考](/reference/development/)；以下是聊天室工具名，不能直接写成 `hive <工具名>` 在 shell 执行。

| 工具                                                                 | 用途与边界                                                               |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `hive_room_read`、`hive_members_list`                                | 读取当前话题消息和房间成员；长消息按 `nextOffset` 继续补读               |
| `hive_message_send`                                                  | 以当前 Agent 身份发送消息或进度；回复关联触发消息，进度不唤醒其他 Agent  |
| `hive_attachment_read`                                               | 按附件 ID 读取已授权内容；文本可分段，图片和二进制返回方式不同           |
| `hive_invoke`、`hive_wait`                                           | 委派子任务并短时等待；结果通过回执返回，不能无限轮询或委派给自己         |
| `hive_ask_human`                                                     | 需要人决策时提问，支持选项；提问后结束当前回合，等待答案重新唤醒         |
| `hive_board_read`、`hive_board_update`                               | 读取当前白板并用稳定 key 更新状态；读取不包含历史归档                    |
| `hive_schedule_create`、`hive_schedule_list`、`hive_schedule_cancel` | 登记、查看和取消一次性或周期任务；到点仍受服务在线与宽限期约束           |
| `hive_room_create`、`hive_room_post`                                 | 在房主本人发起且允许的任务中创建房间或跨房间派活；跨房间结果留在目标房间 |
| `hive_worktree_create`、`hive_worktree_list`、`hive_worktree_remove` | 在允许的本机开发任务中创建、查看和安全清理已登记任务线；占用保护不能绕过 |
| `hive_incident_report`                                               | 被派修故障单的 Agent 回报修好或没修成；只能回报派给自己的单              |
| `hive_rule_propose`                                                  | 提议一条协作规则；房主批准后才加进所有 Agent 的规则                      |

工具可见不代表任意调用都会获准。房间授权、任务上下文、预算、本机权限与工作区占用还会进一步校验；详细步骤见 [协作指南](/guides/collaboration/)、[任务指南](/guides/tasks/) 和 [权限指南](/guides/permissions/)。

## 注意事项

- 本页命令示例没有真实认证值；不要为诊断问题输出整份环境变量、Agent 配置或数据目录。
- 帮助、列表和测量的副作用不同；本页仅核对源码，没有替你启动服务、运行 Runtime、连接 MCP、安装 skill 或调用模型。
- 默认监听所有网卡、完全访问和固定令牌都需要明确安全评估。公网与凭据要求见 [安全参考](/reference/security/)。
- 遇到失败先读错误和状态，不通过放大权限、重复启动或更换接入身份绕过检查；见 [排障指南](/reference/troubleshooting/)。文档站发布命令另见 [文档站单独部署](/reference/documentation/)。
