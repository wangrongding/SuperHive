---
title: 开发与扩展
description: 了解 SuperHive monorepo 的协议、网页、服务端、Agent Bridge 和独立文档应用，按包运行开发与检查，并理解 MCP 与 HTTP 扩展入口。
---

## 把三个角色分清楚

- **网页与 IM**：人查看消息、发布任务、作答和管理房间。
- **Hive Server**：保存公共时间线、调用、白板和定时任务，执行路由与授权检查。
- **Agent Bridge / 运行时**：在 Agent 所在电脑接收任务，调用 Codex、Claude Code 等 Provider，并报告公开结果与状态。

![SuperHive 代码架构示意：网页和 IM 连接 Server，共享协议连接 Bridge 与 Provider；文档应用独立生成静态 HTML，不连接业务数据库。非实际界面截图。](/media/architecture/monorepo.svg)

此图是代码与运行关系示意，不是管理界面截图。公共消息会成为协作上下文；不要把秘密写入房间或认为“运行时私有”就会自动保护被主动发布的内容。

## Monorepo 目录

| 目录                 | 职责                                   | 运行时关系                            |
| -------------------- | -------------------------------------- | ------------------------------------- |
| `packages/protocol`  | 共用类型、Schema、限制和服务端文案     | 网页、Server、Bridge 使用同一协议     |
| `packages/superhive` | npm 包、`hive` CLI、Bridge、运行时适配 | 在 Server 或 Agent 设备执行           |
| `apps/server`        | Fastify、WebSocket、SQLite、MCP、IM    | 需要持久数据和身份授权                |
| `apps/web`           | React + Vite 网页                      | 调用 Server，生产构建可随 npm 包分发  |
| `apps/docs`          | Astro + Starlight 图文文档             | 独立静态部署，不需要 Hive 服务        |
| `apps/desktop`       | Electron 桌面端：起本机 Hive、内置终端 | 打包成独立应用，复用 npm 包的构建产物 |
| `skills/superhive`   | 给 Agent 使用的协作说明                | 随 CLI 发布，`hive --skill` 可打印    |
| `scripts`            | 开发 supervisor 与验证脚本             | 开发或验收工具，不是公开 API          |

文档应用与网页应用不能混为一谈。`pnpm docs:build` 只构建文档；CLI 的分发构建仍使用 `apps/web` 的业务网页，不需要打包文档才能运行 Hive。

## 在页面上交给 Agent 修改

业务网页的 `pnpm dev` 和文档站的 `pnpm docs:dev` 都接入了 `ai-ins`。文档使用原生 `@ai-ins/astro` 集成，支持 `.astro` 模板源码定位，不是生产功能。

按住 macOS `Option` 或 Windows/Linux `Alt` 点选元素，在面板中写下需求，再确认发送给本机的 Agent CLI。前提是本机已经安装并登录对应 CLI；发送会启动实际 Agent，可能修改当前文档工作区文件，不是仅留下留言。

建议从[独立任务工作区](/guides/worktrees/)运行文档 dev。页面组件可定位到 `.astro` 源文件；Markdown 正文元素不一定有逐行定位，修改正文时同时明确文章路径与小节。正式构建和生产预览不加载该面板，也不暴露开发接口。

## 从源码开发

需要 Node.js 22.12+ 和 pnpm 10。仓库根目录运行：

```bash
pnpm install
pnpm dev
```

开发时 Server 默认端口 8787，Vite 网页默认端口 5188；端口被占用时以实际输出为准。修改网页走热更新；Server 由开发 supervisor 换代，Bridge 的改动通常需要重启对应 Agent。

多 Agent 并行修改仓库时，使用[独立任务工作区](/guides/worktrees/)。尤其不要在承载生产或正在运行的开发服务目录里随手修改 Server / Bridge，触发不必要的重启。

```bash
pnpm --filter @superhive/protocol build
pnpm --filter @superhive/server test
pnpm --filter superhive test
pnpm --filter @superhive/web test
pnpm docs:verify
```

全仓验收使用 `pnpm lint`、`pnpm test`、`pnpm build`。修改哪个包先跑相应检查，再按影响范围扩展；不要把未运行的真实模型或 IM 验证写成已通过。文档构建默认是禁止索引的预览，发布配置见[独立文档部署](/reference/documentation/)。

## 桌面端

`apps/desktop` 用 Electron 45 包装 SuperHive：在 `utilityProcess` 里起本机 Hive（`hive start` 已经在跑就按 `~/.superhive/server.json` 直接连上），窗口加载 `http://127.0.0.1:<端口>` 的现有网页，另加一个终端：主进程里是 node-pty，页面里是 xterm。终端只走 Electron IPC，浏览器或局域网里打开的网页拿不到。

```bash
pnpm --filter @superhive/desktop dev          # 组装 .stage/app 并启动
pnpm --filter @superhive/desktop test         # 单元测试
pnpm --filter @superhive/desktop test:smoke   # 真的启动应用、在终端里执行命令、接入一个本机 Agent
pnpm --filter @superhive/desktop make         # 打安装包，产物在 apps/desktop/out/
```

应用组装在 `apps/desktop/.stage/app`，运行时依赖用 npm 单独装一份，Electron 的构建不会碰仓库的 pnpm `node_modules`。打包版关了 `RunAsNode` fuse：Server 从 `HIVE_LOCAL_AGENT_CLI` 得知怎么拉起本机 Agent，桌面端带 `--superhive-cli` 启动时只运行包里的 CLI。安装包作为未签名预览版发布在 [GitHub Releases](https://github.com/wangrongding/SuperHive/releases/latest)；代码签名、公证和自动更新还没做，细节和要准备的东西见 `apps/desktop/README.md`。

## MCP 与 HTTP 扩展入口

想给网页加面板、/ 命令，或给本机 Agent 加 MCP 工具而不改 SuperHive 本身，用[插件](/guides/plugins/)。

Hive 提供 `/mcp` 的 Streamable HTTP MCP 入口；Bridge 会为已接入 Agent 配置相应的身份信息。它不是匿名公共工具服务：需要有效 Bearer Token、在线 Agent 身份与正确的房间范围，具体字段和约束以当前协议、源码与客户端配置为准。

常见工具分组：

| 用途             | 工具                                                                             |
| ---------------- | -------------------------------------------------------------------------------- |
| 读取公开协作信息 | `hive_room_read`、`hive_members_list`、`hive_board_read`、`hive_attachment_read` |
| 委派与回执       | `hive_invoke`、`hive_wait`                                                       |
| 人的决定         | `hive_ask_human`                                                                 |
| 发布与组织       | `hive_message_send`、`hive_board_update`                                         |
| 以后执行         | `hive_schedule_create`、`hive_schedule_list`、`hive_schedule_cancel`             |
| 隔离任务线       | `hive_worktree_create`、`hive_worktree_list`、`hive_worktree_remove`             |

读取工具不授权修改文件；工具名存在也不代表所有身份都能调用。写工具要遵守房主授权、触发消息链、调用状态与预算等约束。跨房间、创建和清理工作区还有额外限制。

主要 HTTP 类型包括 `/health` 健康信息、业务 `/api/...`、实时 WebSocket 和 `/mcp`。开发时查看 `docs/development.md` 与对应源码 Schema，不要依赖抓到的某个网页请求去绕过权限，也不要将真实 Token 写进示例或测试夹具。

## 给 Agent 的说明与自定义运行时

`hive --skill` 输出随版本发布的协作说明；也可以用 CLI 的 skill 安装命令给本机兼容 Agent 安装。角色说明、运行时设置和 MCP 配置共同决定 Agent 怎么工作，见[接入 Agent](/guides/agents/)。

新 Provider 的适配不只是“能发出一条请求”：还要处理会话续接、停止、权限、工具 trace、用量、中断恢复和平台命令差异。兼容外部协议不等于已经内置或实测；以仓库现有适配器与测试为基准。

提交功能前，分别记录 **已通过、只读核对、未运行** 的证据。合入、发布、生产重启和工作区清理是不同动作，需要各自明确的授权与安全检查。
