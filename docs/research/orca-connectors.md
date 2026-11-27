# Orca 连接器（Connectors）调研：实现、交互，以及对 SuperHive 的借鉴

> 2026-11-28，rd-claude2，回应 rd #7336。只读调研：没运行 Orca、没装任何东西、没动真实 CLI 配置、8787 和 rd 的 Windows。

## 0. 结论先说

1. **Orca 的「Connectors」主体不是 MCP 目录，而是 Bot 的「外部渠道 + 账号」**。一个 Bot 的 Connectors 列表混放两类东西：
   - **消息渠道**：Slack、GitHub、Linear、Webhooks。别人在那边 @Bot 就把它唤醒，回复发回原处。事件全部经 **Orca 自营、闭源的 connector 云服务**（`connector.orca.dev`）中转，本机长轮询加 wake socket 接收。
   - **给 Agent 用的工具**：Google（Gmail、日历、Drive，走 Orca 自己的 CLI）、Composio 应用、厂商官方远程 MCP（约 20 个），以及按 URL 或命令自定义的 MCP。这些都在本机跑。凭据存在本机加密文件里，经一个 127.0.0.1 的 relay 注入，**Agent 从头到尾拿不到真实 token**。
2. **它比我们强的地方集中在三处**：远程 MCP 的 **OAuth 登录**（PKCE、动态注册、自动刷新、失效检测）；**装完就知道能不能用**（直接调各 CLI 自己的状态接口，判断「已连接 / 需要登录 / 连不上 / 起不来」）；**没出问题就不显示状态**，出了问题汇总进「Needs you」并显示角标。
3. **我们已经有、甚至做得更好的**：版本写死的精选清单；预览后冻结计划再写入；一次装进 5 个 CLI；测工具数和 token 占用；按 Agent 勾选加载哪些 MCP。IM 这边，飞书走官方 SDK 的长连接，**不依赖任何第三方云**，Orca 的 Slack、Linear、GitHub 则离不开它的云。另外，Orca 主机级的「Settings › MCP servers」**还挂在开关后面没有发布**：`ORCA_MCP_SERVERS=1` 才开，默认关。
4. **建议按顺序做**：
   - ① 装完自动验证，并持续显示问题状态（2～3 天）
   - ② 远程 MCP 的 OAuth（5～8 天）
   - ③ 「需要你处理」汇总（1～2 天）
   - ④ 清单每周自动巡检（1 天）
   - ⑤ Agent 在聊天里请人装 MCP 的卡片（2～3 天）
   - ⑥ IM 的「谁能找 Agent」名单（3～4 天）

   **不跟的**：Orca 云中继、Composio、每个 Bot 单独建一个 Slack app、凭据 relay 全量改造。理由见第 4 节。

## 1. 固定版本与方法

- Orca：`stablyai/orca` **v1.4.280**（2026-11-27 发布），commit **`16dc39cfb7ba5b16c88eef510a6141e223ece0be`**。浅克隆到临时目录读 TypeScript 源码。下文 Orca 路径相对仓库根，行号对应这个 commit；`R/` 是 `src/renderer/src/components/` 的缩写。
- SuperHive：对照 main **`2cccc50`**。重点是 3b7ef0f（MCP 精选清单和安装向导）、2796d87（卡片商店和安装抽屉）、7547658（技能商店），以及已有的 IM 连接（`apps/server/src/im/`）。
- 上一份报告 `docs/research/orca-borrow.md` 固定的是 1.4.274。本文只对 1.4.280 下结论。
- connector 云服务端不开源。`cloud/README.md:31-34` 写明 "The hosted service is run by Orca and is not in this repository"，仓库里只有 wire contract（`cloud/packages/connector-contract`）。所以云端行为只能从契约和客户端反推，凡是推断都标「推断」。
- 截图：仓库里没有连接器设置页的截图。附图 `bots.poster.jpg` 来自 Orca README（`docs/assets/readme-features/`），能看到 Bot 页右上角的「Connectors」tab 和右侧的「Needs you」。没有在本机运行 Orca 自己截图：它的登录和连接都要 Orca 账号与云端，临时 HOME 下也看不到真实流程，性价比低。

## 2. 实现

### 2.1 种类与性质

统一列表 `src/shared/bots/bot-connector-entries.ts:46-64`，`kind ∈ slack | linear | github | google | webhooks | composio | app | composio-problem`。

| 种类       | 性质                                         | 怎么用 / 以谁的身份                                                                                                                                                                              |
| ---------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Slack      | 渠道：频道或私信里 @Bot 唤醒它               | 每个 Bot 在每个工作区一个自己的 Slack app（`bot-record-schemas.ts:101-103`，上限 8 个工作区）。回复由 Orca Cloud 以 Bot 身份发出（`src/main/runtime/rpc/methods/connectors/connector.ts:39-60`） |
| Linear     | 渠道 + 工具                                  | Orca 共享的 Linear app。Agent 用 `orca linear`，以 owner 身份操作                                                                                                                                |
| GitHub     | 渠道：issue 或 PR 里 @Bot，PR 事件触发自动化 | Orca 共享的 GitHub App。Agent 操作 GitHub 用本机的 `gh`，以 owner 身份                                                                                                                           |
| Webhooks   | 渠道：外部系统调云端托管的 URL               | 云端先去掉签名、cookie 等再转发（`cloud/packages/connector-contract/src/webhook-envelope.ts:4-5`）                                                                                               |
| Google     | 工具                                         | `orca gmail / calendar / contacts` CLI，不是 MCP（`src/main/bots/bot-google-access.ts:1-4`）                                                                                                     |
| Composio   | 工具                                         | 每个 Bot 一个 Composio tool_router 会话，作为一个 HTTP MCP 挂上（`src/main/composio/composio-bot-tool.ts:1-2`）                                                                                  |
| app（MCP） | 工具                                         | Bot 自己的 HTTP 或 stdio MCP，可以从目录选，也可以按 URL 加                                                                                                                                      |

另有主机级的「Settings › MCP servers」：所有会话共用，Bot 要打开「Your MCP servers」开关才继承。这一块整体由 `ORCA_MCP_SERVERS=1` 控制，**默认关闭、尚未发布**（`src/main/mcp-servers/mcp-servers-feature.ts:1-7`）。

### 2.2 数据模型

- **目录**
  - **厂商 MCP 目录是写死的常量**：`BOT_MCP_APPS`（`src/shared/bots/bot-mcp-apps.ts:118-310`），约 20 个，有 Vercel、Sentry、Datadog、PostHog、Cloudflare、Supabase、Neon、Netlify、GitLab、Context7、Atlassian、Notion、Stripe、ClickUp、Airtable、Todoist、Zapier、Granola、Intercom。
    - 条目字段：`id / name / line / url`（url 可带 `{key}` 占位，配合 `variable` 选站点，例如 Datadog 的 US1 和 EU）、`signIn: 'browser' | 'none'`、`category`、`composio?`（用来和 Composio 去重），见 `:17-29`。
    - 文件头注释写明，每个条目都要通过**每周一次的 app 检查**（`config/scripts/bot-apps/bot-app-catalog-smoke.mjs`）。
    - **全是远程 HTTP、浏览器登录**，没有 npx 或 stdio 配方。
  - **Composio 目录在运行时拉**：用 owner 自己的 Composio key 调 `backend.composio.dev/api/v3.1/toolkits`（`src/main/composio/composio-api.ts:30`、`:129-149`），另有 6 个精选（`src/shared/composio/composio-curated-apps.ts`）。
  - **Slack、Linear、GitHub 的工作区和安装状态**从 Orca Cloud 读（`src/shared/connectors/connector-cloud-paths.ts:12-26`）。
- **单个工具条目** `BotToolServerSchema`（`src/shared/bot-tools.ts:59-84`）分两种：
  - `{name, url, transport: 'http', headers?, credential?}`。只支持 streamable HTTP，没有 SSE。`credential` 是凭据 ID，header 不留在配置里。
  - `{name, command, args, env?}`，即 stdio。
- **生效层级**
  - **按 Bot**：`<bot home>/.orca/bot-tools.json`（`src/main/bots/bot-tools-path.ts:7`）。渠道链接是 Bot 记录的字段（`bot-record-schemas.ts:170-188`）。
  - **按主机**：同一种文件格式，放在 `<userData>/mcp-servers/.orca/bot-tools.json`。每个 server 还能单独设置：对哪些 Agent 关闭（`agentsOff`）、只在哪些工作区开或关（`workspaces`）、stdio server 是否全主机只跑一份（`sharedProcess`）（`src/shared/mcp-servers/mcp-servers.ts:15-46`、`:71-89`）。
  - **不写 owner 自己的 CLI 配置**：Claude 启动时作为额外 MCP 配置传入，Codex 作为 thread config 叠加（`src/main/bots/bot-tools-file.ts:1-2`、`bot-tools-codex.ts:19-48`）。

### 2.3 凭据与 OAuth

| 凭据                                          | 存哪                                                                                                                                                                                                                               | 刷新                                                                                                                                                                                                                                                                                  |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP 的 header 和 Orca 持有的 OAuth token      | `~/.orca/bot-tool-credentials/<hash>.json`，每条用 Electron safeStorage（系统钥匙串）加密，并绑定 folder 和 id。没有钥匙串时拒绝保存密钥（`src/main/bots/bot-tool-credentials.ts:47-56`、`bot-tool-credential-envelope.ts:42-72`） | MCP SDK 标准流程：发现 → 动态注册客户端 → PKCE（`tool-oauth/bot-tool-oauth-sign-in.ts:1-2`）。静默刷新，同一凭据同时只刷一次，refresh token 轮换（`tool-oauth/bot-tool-oauth-tokens.ts:52-60`）。遇到 `invalid_grant` 或 `invalid_client` 标为 `lost`，网络错误不算失效（`:100-123`） |
| 由 Agent CLI 自己登录的远程 MCP               | CLI 自己存。对 Claude，Orca 给每个 Bot 建一个「sign-in 文件夹」，用 `claude mcp add-json --scope local` 写进去，让 Claude 自己去登录（`src/main/bots/bot-tools-claude.ts:1-5`、`:162-178`）                                        | CLI 自己刷新                                                                                                                                                                                                                                                                          |
| Composio key                                  | `~/.orca/composio-api-key.enc`，加密（`composio-key-store.ts`）。各应用的 OAuth 由 Composio 托管                                                                                                                                   | Composio                                                                                                                                                                                                                                                                              |
| Linear 个人登录                               | 本机 `.login.enc`。云端转手时只拿到密文，用只有本机持有的 X25519 密钥封装（`cloud/packages/connector-contract/src/connect-login-seal.ts:14-15`）                                                                                   | 本机刷新，24 小时轮换（`src/main/linear/accounts/linear-login-refresh.ts`）                                                                                                                                                                                                           |
| Google                                        | 本机加密。**owner 要自己建 Google OAuth client**（自建引导约 10 分钟；「Orca hosted」标着 Soon）                                                                                                                                   | 本机                                                                                                                                                                                                                                                                                  |
| Slack bot token、GitHub App、Linear app token | Orca Cloud（推断：云端代码不在仓库里）                                                                                                                                                                                             | 云端                                                                                                                                                                                                                                                                                  |

机器身份：每个安装一把 Ed25519 主机密钥，权限 0600（`src/main/connector-cloud/connector-host-key.ts:18`、`:84-139`）。Orca 账号会话用它签名，换来一个 5 分钟有效的 connector token（`connector-token-mint.ts:29-46`），这样光拿到 install id 冒充不了这台机器。

### 2.4 怎么下发给 Agent

核心在 `src/main/mcp-servers/session-mcp-tools.ts`：

- 带 `credential` 的 HTTP server，地址被改写成本机 relay：`http://127.0.0.1:<port>/bot-tools/<credId>/mcp`，并带上 `Authorization: Bearer ${ORCA_BOT_TOOLS_TOKEN}`（`:86-110`）。配置文件里只写 `${VAR}` 引用，token 在环境变量里（`src/shared/agent-session/lifecycle/launch/agent-session-caller-env.ts:32-35`）。
- 如果 header 还以明文留在配置里，**直接拒绝启动**（`:66-71`）。
- relay（`tool-relay/bot-tool-relay.ts`）校验 token 和授权范围，注入保存的 header、Composio key 或 OAuth token（需要时先刷新），再流式转发到真实 server。工具一删除或登出，正在进行的调用立刻切断（`:132-140`）。
- token 失效时，relay **不回 401**，回 JSON-RPC `-32001 "Sign in to this app in Orca to use it."`，免得 Agent 自己对着 relay 发起登录（`tool-relay/bot-tool-relay-sign-in-answer.ts:1-8`）。
- Grok、Cursor、Droid 只认自己的 MCP 文件。经用户同意后，Orca 往这些文件里写一条 `orca mcp connect` 的 stdio 桥（`agent-files/mcp-agent-file-sync.ts:1-5`）。

### 2.5 状态与工具列表探测

- **问 CLI 自己**：
  - Claude：在 sign-in 文件夹里跑 `claude mcp list`，解析出 connected / needs auth / fail（`bot-tools-claude.ts:180-206`）。
  - Codex：起 app-server，轮询 `mcpServerStatus/list`，最多 30 秒（`bot-tools-host.ts:207-269`）。
  - Orca 自己持有 OAuth 的工具，直接从凭据库读状态。
  - 同一个检查有多个请求方时只跑一次（`bot-tool-health-checks.ts:1-30`）。
- Orca **不自己调 `tools/list` 数工具**，只判断有没有问题。这点我们反而更细：`hive mcp list --measure` 会数工具、估 token。
- Composio：key 状态 `none | ok | rejected | unreadable`，连接状态 `active | pending | expired | failed`。每 30 分钟巡检一次，过期就在 Bot 聊天里放一张 Reconnect 卡（`composio-upkeep.ts:6`、`:30-34`）。
- 云连接状态：`signed-out | needs-sign-in | unreachable | refused | ok`（`src/shared/bots/connector-cloud-status.ts:5-11`）。

### 2.6 云依赖与离线

- 必须依赖 Orca Cloud 的：Slack、Linear、GitHub 收事件和以 Bot 身份发帖，Webhook 地址托管，「一趟浏览器完成连接」（本机起回调监听，云端带浏览器走完 OAuth 和安装，再交回一次性码），分享和访问申请。
- 协议（`connector-cloud-paths.ts:4-9`、`connector-cloud-contract.ts:55-58`）：先发 `hello` 声明本机有哪些 Bot，再挂 70 秒的长轮询 `poll`；每个投递回两次 ack（received、done）。wake socket 只负责叫本机「去 poll」，断开就退回长轮询。回复和事件先写本机 outbox，重试按指数退避，上限 10 分钟。
- 离线或没登录 Orca 账号：渠道全部暂停，界面显示「Paused while signed out」。本机 MCP、relay、Google 不受影响。

## 3. 交互

### 3.1 入口

1. Bot 页右侧栏的 **Connectors** tab，图标是插头。有待处理项时角标写「N needs you」（`R/right-sidebar/activity-bar/right-sidebar-default-activity-items.ts:65-79`）。见附图右上角。
2. Bot 设置 › **Access › Connectors**，和 Who can ask、Tools、Skills 放在同一组（`R/bots/settings-view/BotSettingsRoot.tsx:198-204`）。
3. 全局 Settings › Bots：只做每台电脑的汇总和账号管理，不在这里加连接器。原文是 "Turn Google on for a bot from the bot's Connectors."
4. **聊天里 Agent 主动请人连接**：Agent 跑 `orca bot connectors --offer slack|linear|github|google`，聊天里就出现一张「Connect a service」卡，按钮写「Connect Slack」（`src/shared/bots/bot-connector-offer.ts`、`R/native-chat/NativeChatConnectorOfferCard.tsx:117-156`）。

### 3.2 添加

- **空状态**：一排品牌 logo，加一句「Let people reach {bot} in Slack, GitHub and Linear, and let it work in your Google and other apps.」，再加一个按钮「Add a connector」（`R/settings/bots/BotConnectorsSection.tsx:93-115`）。
- **目录弹窗**「Add apps to {bot}」，约 920×700（`R/bots/apps/BotAppsCatalog.tsx`）。
  - 顶部：搜索框、「+ Add by URL」、「N added」（只看已加的）。
  - 分类 chips：All / Coding / Chat / Monitoring / Docs and projects / Mail and meetings / Sales and support / Design / Composio / Custom。
  - 列表分三段：「Apps」（Orca 自家 4 个加厂商 MCP），「With Composio」（先给 6 个），「Custom」（Add by URL 和 Webhooks）。
  - 卡片：logo、名称、一句用途（如 Sentry「Look into errors and the events behind them」），右侧按钮「Add」或「Manage」。
  - 搜不到时给两个出口：「Clear search」和「Add by URL」。
- **点 Add 之后**：
  - 厂商 MCP：需要时先选站点 → 「Adding {app}…」→ 浏览器登录 → 「{app} is on {bot}」「{bot} can use its tools from its next turn.」→「Done」（`R/bots/apps/BotAppUrlStep.tsx:235-293`）。
  - Slack 最长，7 步：检查 → 复用本机已有的 Slack 登录，或者粘贴 App Configuration Token（界面给了三步说明）→「Create Slack app」→「Approve in Slack」→ 等管理员批准 →「{bot} is in Slack」，附 Try it 预览和 Post as 选择（`R/bots/slack/BotSlackSetupDialog.tsx`）。
  - GitHub、Linear：浏览器里登录并选仓库或工作区。弹窗可以最小化成底部的一个 pill。没装 Orca 的 Linear 工作区给「Copy admin link」，让管理员去装。
  - Composio：第一次先填 key（「Once, for all your bots」），之后在 Composio 的页面里登录。
  - Webhooks：点「Set up in chat」，由 Bot 在聊天里问清楚触发条件，再把地址给你。

### 3.3 登录

- 统一的等待页「Finish in your browser」，带转圈，按钮「Close」和「Open page again」。Close 的 tooltip 写着「Sign-in continues in your browser」（`R/bots/apps/BotAppStepParts.tsx:156-175`）。
- 在远程主机上登录时，回调页会打不开，这时让用户**把那个打不开的页面地址粘回来**：「Signing in on another computer? … copy the address of the page that didn't load.」（`R/bots/apps/BotAppToolSignIn.tsx:147`）。粘错了会报「That address isn't from this sign-in.」
- 登录失败页按原因写：「Access wasn't allowed.」「The sign-in expired.」「Can't reach {app}」，按钮「Try again」和「Remove {app}」（`BotAppToolSignIn.tsx:49-94`）。

### 3.4 管理、状态、Needs you

- 每个工作区、组织或应用占一行，标题形如「Slack · Acme」，右边一个「⋯」菜单。菜单顺序是：先放加权限类操作，再放连接器自己的设置页，最后才是「Remove」或「Disconnect」。
- 移除确认会写清后果，例如「Removing stops new work from Slack. It does not delete the app in Slack.」，以及 Google 的「Google stays connected on this computer.」
- **一切正常时不显示状态**（`R/bots/BotConnectorRow.tsx:137` 原注释："a row shows a status only when something needs the owner"）。出了问题才显示一个圆点加标签，例如「Needs sign-in」「Sign in again」「Can't reach」「Won't start」「Key not accepted」。
- 需要人处理的连接器会进 Bot 的 **Needs you** 分组：「{name} needs you to sign in again or fix it.」，按钮「Open {name}」直接跳到对应那一行（`R/bots/BotNeedsYouSection.tsx:245-257`、`R/bots/bot-connector-need.ts:7-18`）。同一个计数同步显示在 tab 角标、侧栏和悬浮卡上。
- **Who can ask**：每个渠道都有一份人员名单，最多 N 人。名单外的人会收到一条私下提示，引导他去找 owner 申请；owner 这边按申请逐条批准（`R/bots/BotWhoCanAskPicker.tsx`）。打开 Google 时，如果除了 owner 还有别人能问这个 Bot，会先弹一次风险确认。
- **Try it**：完成页放一段模拟对话，教用户怎么问 Bot，每句旁边有复制按钮。没有「发一条真实测试消息」的按钮。
- 主机级「MCP servers」页（还没发布）：按来源分「Yours / From plugins / In your agents」三组。「In your agents」那组提供「Move to Orca」，搬进来时会留一份备份。添加弹窗可以**粘贴 URL、启动命令或一整段配置**，自动识别出多条 server，一次加完。改动后弹 toast「Applies to new sessions」，并给出「Restart N sessions」。

## 4. 和 SuperHive 现在这版对比

我们对应 Orca 连接器的有两块：**MCP 快速安装**（3b7ef0f 和 2796d87，「MCP 与技能」大面板）和 **IM 连接**（飞书、微信，`apps/server/src/im/`）。

### 4.1 工具类：MCP

| 项                    | Orca 1.4.280                                                                       | SuperHive 2cccc50                                                                                                      | 谁更好                                                            |
| --------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 目录来源              | 写死约 20 个厂商远程 MCP，加运行时拉的 Composio 目录                               | 写死 12 个配方，版本固定（`apps/server/src/mcp-catalog.ts`），清单带版本号 `2026.11.27`                                | 平手：它偏 SaaS，我们偏开发工具                                   |
| stdio / npx 配方      | 目录里没有，只能自定义                                                             | 有：chrome-devtools、playwright 等，npm 版本写死                                                                       | **我们**                                                          |
| 远程 MCP OAuth        | 有：PKCE、动态注册、自动刷新，`lost` 时提示重新登录                                | **没有**，第一阶段明确不收需要 OAuth 的服务（`mcp-catalog.ts:11`）                                                     | **Orca**，这是最大差距                                            |
| 装到哪                | 按 Bot 或按主机，启动时注入，不碰 owner 的 CLI 配置                                | 写进各 CLI 自己的全局配置；在 Hive 外改了也以文件为准                                                                  | 各有道理：我们和 CLI 原生行为一致，人在终端里直接跑 claude 也能用 |
| 一次装进多个 CLI      | 不存在这个概念（注入当次会话）                                                     | 有：一次写进 Claude、Codex、opencode、omp、Copilot，用不了的说明原因                                                   | **我们**                                                          |
| 安装安全              | 只接受目录条目或用户粘贴的内容                                                     | 只接受配方 ID 和参数；预览后冻结计划，参数和目标文件都核对 HMAC 与哈希，10 分钟过期（`runtime-install.ts:25`、`:186`） | **我们**更严                                                      |
| 密钥存放              | 系统钥匙串加密，经 relay 注入，Agent 看不到；明文 header 拒绝启动                  | 写进 CLI 配置的 env 或请求头，**明文**（CLI 原生方式），文件权限私有                                                   | **Orca**                                                          |
| 装完验证              | 跑 `claude mcp list` 或 Codex `mcpServerStatus/list`，得到已连接 / 需要登录 / 失败 | 结果写「已写配置，未验证连接」；要另外点测量（`hive mcp list --measure`，`local-routes.ts:1215`）                      | **Orca**（自动）；我们的测量更细（工具数、token）                 |
| 状态展示              | 没问题不显示；有问题进 Needs you，带角标                                           | 统一管理表显示开关和来源，没有「需要处理」的汇总                                                                       | **Orca**                                                          |
| 按 Agent / 工作区开关 | 按 Agent 关、按工作区开、stdio 共享一个进程（主机级，未发布）                      | Claude、Codex 可以按 Agent 勾选加载哪些 MCP（`local-agents.ts:206`）                                                   | 接近，我们已经发布                                                |
| 手动添加              | 一个框，粘 URL、命令或整段配置，自动识别多条                                       | 有手动添加表单                                                                                                         | Orca 稍顺手                                                       |
| Agent 主动请人装      | `--offer` 在聊天里放卡片                                                           | 没有（Agent 只能用 hive_ask_human 打字说明）                                                                           | **Orca**                                                          |
| 目录巡检              | 每周跑 smoke 脚本检查 app 还活着                                                   | 只在测试里检查字段格式                                                                                                 | **Orca**                                                          |

### 4.2 渠道类：IM

| 项         | Orca（Slack、Linear、GitHub）                          | SuperHive（飞书、微信）                                            | 谁更好                    |
| ---------- | ------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------- |
| 链路       | 必须经 Orca 闭源云：长轮询加 wake socket               | 飞书官方 SDK 长连接，本机不需要公网，**不依赖第三方云**            | **我们**（自托管）        |
| 接入       | Slack 要粘 config token、建 app、等管理员批准，共 7 步 | 扫码一次，飞书 SDK 引导建应用或选已有应用                          | **我们**更省事            |
| 凭据       | 云端持有                                               | 本机 `SecretBox` 加密存进 SQLite（`im-store.ts:137`）              | **我们**                  |
| 投递可靠性 | outbox、两次 ack、指数退避                             | outbox、发送前复核、自动重试，界面显示「待发 N 条」                | 平手                      |
| 失效提示   | 原因细分，按钮「Reconnect」「Replace token」等         | 「登录已失效」「连接异常」，按钮「重新连接」「重新扫码」，设置保留 | 平手                      |
| 谁能找 Bot | 每个渠道一份名单，名单外的人走访问申请                 | 只有扫码人以房主身份进房间（`im-store.ts:11`）                     | **Orca** 更适合群里多人用 |
| 范围       | 按 Bot                                                 | 按房间（默认房间加「接收哪些房间」）                               | 模型不同，各自合理        |
| 连好之后   | Try it 模拟对话，加「How to ask」                      | 连接卡写「已连接」                                                 | Orca 稍好                 |

## 5. 建议

按「价值 ÷ 工作量」排序。工作量按一个 Agent 计。

| #   | 借鉴什么                            | 改什么（一句话）                                                                                                                                                                                                                                                                                                          | 约                       |
| --- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| 1   | **装完自动验证 + 有问题才显示状态** | 安装成功后自动对目标 CLI 跑一次现有的 `hive mcp list --measure`，抽屉里把「未验证」换成「能用 · N 个工具」「需要登录」「连不上」「起不来」；统一管理表平时不显示状态，出了问题才显示                                                                                                                                      | 2～3 天                  |
| 2   | **远程 MCP OAuth**                  | 清单加 `signIn: "browser"`，补上 Notion、Linear、Sentry、Atlassian 这类。第一步不自持 token：Claude 和 Codex 都支持远程 MCP 自己登录，我们写好配置后，像 Orca 的「remote」那样引导人在目标 CLI 里登录，再用 #1 读回「需要登录 / 已登录」。第二步再考虑由 Server 持有 token（PKCE 加动态注册，复用 IM 已有的 `SecretBox`） | 第一步 3 天，第二步 5 天 |
| 3   | **「需要你处理」汇总**              | #1 的问题状态、IM 的「登录已失效」，在状态栏「MCP · 技能」入口和 IM 入口上加计数角标，点了直接跳到出问题的那一行                                                                                                                                                                                                          | 1～2 天                  |
| 4   | **清单每周巡检**                    | 加一个定时 CI：远程条目探测 URL 能不能连上，npm 和 PyPI 包核对版本存在。失败就开 issue，免得清单悄悄坏掉                                                                                                                                                                                                                  | 1 天                     |
| 5   | **Agent 在聊天里请人装 MCP**        | 加 `hive mcp offer <配方 id>`。房间里渲染成一张卡（配方名、一句话说明、「安装」按钮），点了打开现成的安装抽屉并预选好这个配方；不在本机页面的人只看到一行文字                                                                                                                                                             | 2～3 天                  |
| 6   | **IM「谁能找 Agent」名单**          | 飞书群里除了扫码人，再允许 owner 加几个人。名单外的人 @ 时私下回一句「请找房主开通」，owner 在网页上一键批准                                                                                                                                                                                                              | 3～4 天                  |
| 7   | 粘贴即识别                          | 手动添加改成一个输入框：粘 URL、`npx …` 或 Claude / Codex 的 JSON / TOML 片段都能解析，自动识别多条，勾选后一次加完                                                                                                                                                                                                       | 1～2 天                  |
| 8   | IM 连好后的「怎么用」               | 连接成功页加两三句示例（「在群里 @机器人 说……」），每句可复制                                                                                                                                                                                                                                                             | 0.5 天                   |

**结合点**：#2 的第二步和 IM 共用 `SecretBox`。#1 和 #3 让 MCP 与 IM 用同一套「出问题才显示、汇总角标」规则。两个面板本身**不建议合并**：MCP 作用在 CLI 全局，IM 作用在房间，硬放进一个「Connectors」列表反而让人分不清改的是哪一层。Orca 能合并，是因为它所有东西都挂在 Bot 下面。

**不建议跟的**：

- **Orca 云中继这套**（connector cloud、wake socket、云托管 Webhook、每个 Bot 建一个 Slack app）：服务端闭源，要我们自己运营一个云。我们的卖点是本机自托管，飞书已经能靠官方长连接免公网。真要接 Slack，用 Socket Mode 的方式和飞书一样走本机长连接，不必学它的云。
- **Composio**：要用户另开第三方账号和 key，各应用的 OAuth 也托管在第三方，隐私边界变复杂。它解决的「上千个 SaaS」在 rd 的场景里不是刚需。
- **凭据 relay 全量改造**（所有 MCP 都改走本机 relay、Agent 看不到 token）：安全收益真实，但我们的设计前提是「写 CLI 原生配置，人在终端直接跑 CLI 也能用」，全改走 relay 会打破这一点。退一步的做法是，写配置时对支持 `${VAR}` 展开的 CLI（Claude）用变量引用、值放进私有 env 文件。这一条可以并进 #2 的第二步再评估。
- **Google 自建 OAuth client 引导**：Orca 自己都要 10 分钟手工配置，「Orca hosted」也还标着 Soon，投入产出比低。

## 6. 核对说明

- Orca 结论来自 v1.4.280 源码静态阅读。重点行号（`mcp-servers-feature.ts:1-7` 的开关、`bot-tool-relay-sign-in-answer.ts` 的 -32001、`bot-mcp-apps.ts` 的每周检查注释、`BotConnectorRow.tsx:137` 的「只在需要时显示状态」、`COMPOSIO_FIRST_LOOK = 6`）都逐条打开核过。云端行为只依据 `cloud/packages/connector-contract` 和客户端代码。
- 没有运行 Orca，界面文案来自 `src/renderer/src/i18n/locales/en.json` 和组件代码，不代表真机像素。
- SuperHive 一侧按 main `2cccc50` 的 `git show` 结果。
