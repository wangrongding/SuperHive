# Orca：快速安装 MCP / skills 与可借鉴设计

调研日期：2026-11-26。对应 rd #6798、rd-claude #6799。只读研究，不实施安装、不修改项目代码。

## 结论

1. **SuperHive 应该补快速安装，但不是再做一套 cc-switch。** `main 98a425d` 已有跨运行时清单、开关、MCP 手工新增和已有 skill 的复制；缺的是「从可信来源选一个 → 查看内容/命令 → 填必要参数 → 选择运行时 → 安装并验证」。
2. **Orca 的 skills 安装比较完整，MCP 则要区分两个产品层。** skills 有随版本内置的目录、安装/更新、分享链接安装、安装包校验和多 agent 分发；MCP 有常用远程服务预设和 Bot 的连接/登录管理，但这不等于「从官方 MCP registry 挑任意包，一键下发所有 CLI 的全局配置」。
3. **最值得借的是安装计划与版本所有权，不只是安装按钮。** 预览后文件变了就拒绝旧计划；更新不覆盖本机改动；卸载只处理自己安装且未被修改的副本；部分失败明确列出。我们已有备份和单文件原子写入，不能因此假定跨运行时操作已经是一个原子事务。
4. 其余新增收益依次是：项目级环境自检、CI 完成事件加截止时间兜底、跨 CLI 的历史检索。不是再重复推荐常驻、上下文阈值、任务会话隔离或稳定投递 ID。

## 范围与证据约定

- **SuperHive 基线**：`98a425db0a52d96071cae2379613386246b3ce0d`。本文所有本项目代码均用 `git show 98a425d:<path>` / `git grep 98a425d` 核对，不以当前旧任务线的 HEAD `5984aa1` 代替 main，也没有切换分支。
- **Orca**：沿用上次讨论的 `stablyai/orca` 项目；本轮固定本机 `/Applications/Orca.app` **1.4.274** 的构建提交 **`0cd805faaa5ddaf7b605dea67039ac4e3e7428e1`**。先读安装包的静态构建代码，再通过 GitHub Git Trees / Blobs API 读回同提交的 TypeScript 源码。`Contents/Resources/orca-local-build.json` 明确记录了这个版本与提交。
- 公共历史 #5585 没记录上次浅克隆目录或 SHA，所以**不能保证与上次 checkout 逐字同一快照**；没有猜测目录或去读 Orca 的用户会话、账号和配置。这里的结论仅针对上述可复核版本，不宣称所有更新版本都相同。
- 下文 **Orca 路径相对于 Orca 仓库根目录**，本项目路径相对于 SuperHive 根目录，行号均是各自固定提交的原始源码行号。Orca 文件可在 `https://github.com/stablyai/orca/blob/0cd805faaa5ddaf7b605dea67039ac4e3e7428e1/<path>` 查看。
- 没启动 Orca、没点登录、没安装 MCP/skill、没跑第三方 npm 命令、没做性能测试。产品可用性不以静态代码代替真机验收。

## 1. Orca 实际有哪些快速安装能力

### 1.1 MCP：常用连接目录、粘贴入口、Bot 配置，不是全局包市场

**数据源。** `src/shared/bots/bot-mcp-apps.ts:118` 的 `BOT_MCP_APPS` 是随应用发布的静态清单，包含 Vercel、Sentry、Datadog、PostHog、Cloudflare、Supabase、Neon、Netlify、GitLab、Context7、Atlassian、Notion、Stripe。条目包含说明、URL、分类、是否需要浏览器登录，Datadog / GitLab 还有地区或自建站点参数。Context7 标为无需登录。这个设计很适合借成我们的「常用 MCP」，但清单内容和服务能力仍需自己维护。

**入口与流程。** Bot 的工具管理既可以选这些服务，也可以粘贴 HTTP(S) 地址或一个简单启动命令。构建源码 `out/main/chunks/orcad-retained-source-DFyWp_Ra.js:1` 中的 `N0t` / `bots.tools.add` 处理这条链：

1. URL 不能内嵌用户名/密码；命令被拆成 executable、args、env，不接受 shell 表达式。
2. 粘贴 JSON 配置会明确提示去「Edit details」填写，不是把任意配置文件直接导入。
3. 无 headers 的远程服务先探测是否需要 OAuth；需要时创建登录记录，由人从本机 Orca 登录。stdio 条目在添加时保存命令配置，不等于此刻完成 npm 下载。
4. 有工具列表、连接状态、编辑、移除以及登录错误状态。这里的工具 `update` 是配置编辑，不能把它当作 npm 包版本更新。

**装到哪、如何分发。** Bot 自己的配置放在 **`<bot home>/.orca/bot-tools.json`**，见 `src/main/bots/bot-tools-path.ts:7`。`src/main/bots/bot-tools-file.ts:1` / `:285` 明确说明这些是 Bot 自己的工具，在会话启动时交给运行时：Claude 使用启动配置，Codex 使用 thread 配置；还能继承所有者的全局 CLI 配置。另有 ACP / Pi 适配实现，但不能从「列了很多 agent 名」推断每个运行时都有同样的登录能力。专门的 CLI 登录分支限制于 Claude / Codex；Codex 注入示例在 `src/main/bots/bot-tools-host.ts:114`。

因此，这和 SuperHive 现在「读写各 CLI 自己的全局配置」不是同一层：**Orca 的 Bot 连接清单不是 cc-switch 式全局总表**，也没有在本轮核对的安装链里发现官方 MCP registry 的通用 npm/git 安装器。

**密钥和环境变量。**

- 远程 headers 从 Bot 文件移到主机凭据存储，Bot 配置只留 credential ID；通过 Orca relay 到达实际服务。保存前后都校验绑定的 URL / Bot 文件夹。`src/main/bots/bot-tools-file.ts:103`、`:139`、`:184`。
- 远程工具密钥使用系统加密存储；没有可用系统密钥环时拒绝保存带 secret 的内容，不悄悄改成明文。`src/main/bots/bot-tool-credential-envelope.ts:32`、`:56`。
- 编辑框不会回填密钥原值，而是用 `configured` / `keep` 保留。改目的地址后不能沿用旧密钥。构建源码 `out/shared/bots/bot-tool-draft.js:21`、`:53`。
- **stdio env 不应被混同于上述 vault**：它仍是启动配置里的 env，Bot 文件按 `0600` 写；不能据此宣称所有 env 都加密了。
- 移除工具会清理 Bot 配置与相应登录状态；没有证据证明它会卸载启动命令引用的 npm 包。更新远程服务本身或 npm 依赖版本，不属于这一工具编辑入口的职责。

**导入已有 CLI 配置。** `src/shared/mcp/configuration/mcp-config.ts` 对应构建文件 `out/shared/mcp/configuration/mcp-config.js:11` 会发现工作区 `.mcp.json`、Cursor、Claude 的候选配置并检查摘要。这证明有「读取/检查已有配置」，**不证明有跨全部 CLI 的一键迁移/分发向导**。

### 1.2 Skills：两条安装通道已经落地

| 通道              | 用户怎么做                                                                                                                            | 数据与安装位置                                                                                                                                                 | 更新 / 卸载边界                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Orca 内置 skills  | 界面提供安装/更新动作；CLI 支持 `orca skills list`、`install --skill <name>`、`--all`、`--agent claude,codex`、`--local`、`--dry-run` | 与当前应用版本一致的本地目录/内容。默认写 `~/.agents/skills/<name>`，按检测/选择的 agent 链接到其技能目录；项目模式写 `<project>/.agents/skills`               | `orca skills update` 只处理已经安装的位置。旧发行版原样副本可更新；本地改动或额外文件会跳过，`--force` 先备份到 `~/.agents/.orca-skill-backups` |
| 分享链接 / 技能包 | Skills 页面有 **Install from link**；选技能、目标主机/全局或项目范围、agent，再看预览、冲突与结果                                     | 链接限定 Orca 的分享域名/深链接，不是任意 URL。包有版本 ID、内容 digest、archive SHA-256、文件清单；后端支持 download grant、staged upload、local file ingress | 同安装服务检查版本和所有权；更新可以保留本地改动；托管卸载检查 receipt 和 digest，陌生副本/外部链接拒绝，部分卸载有独立结果                     |

证据：

- `src/cli/specs/skills.ts:77`、`:108`：内置安装与更新参数；`:83` 明确不需要网络、Git 或 npx。
- `src/main/skills/install/skill-install-paths.ts:4`：共享 canonical root；`src/main/skills/install/skill-install-destinations.ts:46`：目标由主机 authority / workspace ID 解析，WSL 与 SSH 有独立边界，不接受随便指定宿主机路径。
- `src/shared/skills/sharing/skill-share-link.ts:2`、`:5`：只接受 `app.orca.dev`、`share.orca.dev`、`share.onorca.dev` 的分享链接和相应 `orca://` 深链接。
- `out/renderer/assets/SkillsPage-b5-yf6Mk.js:1`：Install from link、脚本/二进制预览、来源信任提示、技能选择和安装结果页面的实际构建代码。
- `out/shared/skills/installation/skill-install-contract.js:19` / `skill-bundle-install-contract.js:47`：ingress、operation ID、版本/摘要、目标、provider 和冲突决策的强类型合同。
- `out/shared/skills/packages/skill-package-manifest.js:49`：路径穿越、Windows 保留名、大小/数量、大小写碰撞和摘要校验；它是内容校验，不是「来源一定安全」的证明。
- `src/main/skills/install/skill-install-preview.ts:93` / `skill-installation.ts:91`：每个 provider 的放置预览及安装后 discovery 验证。
- `src/main/skills/bundled-skill-install/bundled-skill-plan-execution.ts:252`：在目标锁内重建计划并比对 digest；旧预览不写入。
- `src/main/skills/managed-remove/skill-remove-transaction.ts:85`、`:106`、`:182`、`:205`：所有权/改动检查、卸载事务内先移入隐藏位置、记录 journal 并调用恢复/清理（不承诺永久备份），以及 partial / removed 结果。

### 1.3 从 git/npm 装、市场、更新：别把不同通道混在一起

- **确有 pinned npm/git 安装命令生成器**：`src/shared/skills/installation/agent-feature-install-commands.ts:2`、`:5`、`:24` 生成 `npx skills@1.7.2 add https://github.com/stablyai/orca/tree/<build commit> --skill ... --global`。这是 Orca 功能技能的安装辅助通道，固定安装器版本和该应用构建的源提交；不是 Skills 页面接受任意 git/npm 来源的证据。
- **内置技能的主要 CLI 安装通道已经本地化**，并不每次调用上面的外部命令。这两个实现同时存在，不能只看见 npx 就认为每次安装都会联网执行第三方代码。
- **存在插件 marketplace 实现**（构建文件 `out/main/chunks/plugin-marketplace-CM9usFnj.js`），但不能把「插件市场」直接说成「任意 MCP / skills 市场」。本轮可确认的 skills 第三方安装入口是受限分享链接和包合同。
- **分享是可选的对外发布**：`src/cli/specs/skills.ts:26` 的 `skills share` 要求设置中的默认关闭权限；非公开索引链接仍然是「持有链接即可查看/安装」。SuperHive 初版没必要同时建设云端分享市场。
- 没有发现通用 skills 市场的后台自动升级保证。内置 `update` / 自动更新实现与分享包的安装/版本机制要分别说明；第三方升级应保留人确认和本地改动检查。

## 2. 除了延迟，哪些值得借：按新增价值排序

估算为一位熟悉本仓库的开发者的工作日，含临时 HOME 测试与基本 UI 验证；各项存在复用，不能简单加总。不是已获准实施或交付承诺。

| 排名 | Orca 怎么做                                                                                                                                                                                                                       | SuperHive `98a425d` 已有 / 缺口                                                                                                                                                       | 建议怎么借                                                                                                                                                            | 粗估                                                    |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 1    | 内置技能目录、MCP 常用服务卡片、参数/登录引导、链接装技能包；证据见第 1 节                                                                                                                                                        | `runtime-overview.tsx:198` 仅在 MCP 页提供手工「添加」；`runtime-config-routes.ts:306` 的 skill sync 只复制已经发现的 skill。总览/开关已具备                                          | 在现有底部入口里补「安装」，复用原生配置适配器；先常用目录与选运行时，不重建全局主列表                                                                                | MCP 2–3 天；可维护的 skills 安装另 4–6 天               |
| 2    | 安装 receipt、内容 digest、目标锁、旧计划拒绝、modified/unowned/partial 状态；`bundled-skill-plan-execution.ts:252`、`skill-remove-transaction.ts:106`                                                                            | 已有备份、skill 临时目录改名、同步失败补偿（`runtime-skills.ts:728`）。MCP 批量新增是先全量检查再逐个 `putMcp`，**不是跨文件事务**（`runtime-config.ts:682`）                         | 新增安装操作 journal 和来源/版本所有权；保留本机改动，CAS 保护写入与补偿，明确每个目标结果                                                                            | 2–4 天，与 skills 阶段重叠                              |
| 3    | 项目级 environment doctor 按 manifest 找实际工具，检查 CLI 登录、Git、setup 和磁盘，返回 pass/warn/fail 与 remediation；`src/main/environment-doctor/environment-doctor.ts:36`、`:90`、`:156`                                     | 已有运行时发现、凭据入口、MCP 测量、任务目录依赖准备（`worktree-deps.ts:40`）、运行中错误观测（`runtime-observation.ts:3`），不是完全没有自检；缺少把一件任务的启动条件汇成可解释清单 | 做「这个项目能不能开工」的只读自检和可复制修复指引；缺 Node/Python/磁盘/Git/登录分开说。setup 执行、登录、付费或配置修复仍分别确认，不让 doctor 默认修改主机          | 2–3 天                                                  |
| 4    | 指定 GitHub run/repo ID 的 `workflow_finished` 事件 + `--by` 截止时间；云端不支持时只承诺时间提醒。`src/shared/automation-workflow-wait-recipe.ts:4`、`:8`、`:16`，构建中的触发器也有 capability gate                             | 已有持久化一次性/周期 schedule（`app.ts:2744`），但不是精确 CI 完成订阅；不能把本项写成「加定时任务」                                                                                 | 先做一个明确 run 的「完成后叫我」，事件去重、重跑 attempt 与 deadline 分开；没收到完成证据就说超时，不能推断成功。复用现有 schedule 与 IM 降噪；不扩成全套 DAG 工作流 | 有 provider 事件基础时 3–5 天；从零接 webhook 约 5–8 天 |
| 5    | AI Vault 汇总原生 CLI 会话；SQLite FTS 检索、repo/path 筛选、页内证据片段、截断/不完整状态、续接目标。`src/main/ai-vault-search/query/session-search-engine.ts:72`、`:256`；FTS/BM25 在 `out/main/session-search-worker-entry.js` | 已有房间消息搜索（`database.ts:2989`）、任务道和原生会话状态，但没有统一检索用户直接在 CLI 里产生的历史。不是再加聊天室搜索                                                           | 可选、只读地索引 Claude/Codex 历史；结果有来源/项目/会话/片段，再由人选是否注入当前任务。不要自动把所有历史搬进房间，不默认让访客/Agent 搜整台电脑                    | 先两种 CLI 约 5–10 天；完整多运行时/远程更大            |

**不重复推荐 / 不照搬：**本项目已经有的全局总览、开关、备份、worktree、插件批准、任务状态、定时任务、内置终端，以及上次已报的常驻、上下文计量、投递回执、任务隔离，均不作为新的成果。也不为了「更像 Orca」另造 IDE、云端商店、付费 VM 或强制 MCP relay。

## 3. SuperHive 快速安装的具体建议

### 3.1 来源：先内置精选，开放目录次之

| 类别      | 第一阶段来源                                                                                                                                                           | 扩展来源与约束                                                                                                                                                                                                                                          |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP       | 仓库维护的版本化清单，8–15 个高频条目；每条引用发布者的文档，声明 transport、固定命令/包版本或远程 URL、参数与 secret 字段、支持的运行时                               | 官方 **MCP Registry**：`https://registry.modelcontextprotocol.io`。本轮实际 GET `/v0.1/servers?limit=1` 成功，返回 server/version/remotes 和发布元数据。按其 schema 适配 packages/remotes；有些条目只能连接远程服务，不是 npm 包；不能硬套 `npx <name>` |
| skills    | 精选并固定 commit + skill 子目录 + license 的清单。可以从 `anthropics/skills`、`openai/skills` 中选适合已有运行时的项目；只读取/下载选中的文件，不克隆后执行任意 setup | GitHub 仓库/子目录安装。`skills.sh` 可作为第三方发现来源，`vercel-labs/skills` 可作为安装器参考，但**不是所有运行时共同的官方 registry**。初版不需要依赖其 CLI；若采用，固定版本并预览实际 argv                                                         |
| Hive 自带 | `superhive` 继续走现有托管方式，只读、不能从新目录任意覆盖                                                                                                             | 不与外部同名条目合并，升级沿用 Hive 的版本生命周期                                                                                                                                                                                                      |

目录只描述配方，不保存密钥，也不变成覆盖各 CLI 文件的第二套权威配置。外部配置依旧每次读回。官方目录的发布身份/命名空间核验不等于审计过执行代码；页面应该显示「来源/维护者/版本」，不要画成「绝对安全认证」。

### 3.2 一次安装流程

1. **选择来源与具体版本**：在现有「MCP · 技能」面板新增「安装」入口；MCP 和 skills 都能用。保留现有已安装清单和手工编辑。
2. **查看内容/命令**：MCP 展示将启动的 executable、逐项 args、transport、URL；skills 展示 SKILL.md 与 supporting files，单独标脚本、二进制、可执行位及 license。打开详情不执行任何代码。
3. **选择目标**：第一阶段仅本机全局安装，按现有 provider 适配器给出真实目标文件/目录与能力。不支持的格子说明原因；同名已有项不覆盖。多个 CLI 共读一个目录时，显示连带影响并按真实路径去重；不能假定勾两格就是两个互不影响的副本。
4. **填写参数与密钥**：非敏感字段和 secret 分开；secret 用私密输入框，仅存在必要的请求/内存中，读回只显示已配置。目标配置若需要明文，要明确告知并限制文件/备份权限。绝不把值拼进聊天、日志、安装 receipt 或命令行 args。
5. **预览冻结计划**：显示来源 commit/包版本/摘要、目标、文件改动、共享目录影响、将来运行 CLI 时会执行的代码以及需要重启的运行时。给出 plan ID/digest 和原文件摘要；确认后执行同一份计划，参数/版本/文件变了必须重看。
6. **安装并分发**：MCP 先写配置；skill 下载到隔离 staging、校验后放置。每个目标独立记结果，失败不能只报一个「成功」。初版不默认重启真实 Agent。
7. **可选验证**：配置写入、CLI 实际发现、MCP initialize/连接、工具可用是四种不同证据。首次 stdio 测量/启动可能下载或执行包，须在步骤 5 明确确认；没运行就显示「已写配置，未验证连接」。需要浏览器登录时停在等人授权，不静默等待或捏造授权成功。
8. **回到清单**：显示准确的安装/启用/待重启/连接状态。卸载、更新继续检查本机改动和所有权，不能把「取消开关」自动改成卸载。

### 3.3 和现有代码怎么接

- UI 复用 `apps/web/src/runtime-overview.tsx` / 状态栏入口，只补目录、详情、参数、计划确认和操作结果，不另开一套深层设置路径。
- 本地路由沿用 `apps/server/src/runtime-config-routes.ts` 的 **authorizeLocal**。可新增 `GET /api/local/runtime-install/catalog`、`POST .../preview`、`POST .../apply` 和操作状态接口；这些名称是方案，不是现成 API。服务端只接受已解析配方与冻结计划，不接收任意 shell 字符串让 Server 直接执行。
- MCP 写入复用 `RuntimeConfigStore.addMcp` / `putMcp`，但先补 typed input / 表单的 headers 支持：当前内部方法有 headers 参数，不能因此假定网页新增 API 已能表达所有远程鉴权。固定值按目标写 `headers` / `http_headers`；引用 env、bearer_token_env_var、cwd、timeout 等仍按现有可表达性边界逐目标检查，不能为了安装器放松 `syncMcp` 的拒绝规则。
- skill 放置复用 `RuntimeSkillStore` 的目录解析、清单发现、启停/删除边界和临时目录改名思路。现有 `sync` 只能复制本机已发现的 skill，**不能直接拿来下载并覆盖外部包**；需要新增经过校验的包/staging 接口，而不是让客户端提交任意宿主机路径。
- 增加来源/版本/content digest/目标/操作结果的安装 receipt 与 journal。它们是**所有权和恢复元数据，不是全局 MCP/skill 主列表**；手工改 CLI 文件仍会被读回来。
- 多目标批次先预检，再逐项写。单文件原子写入不保证整批原子性；失败补偿只撤回该操作创建且内容未被外部修改的项，CAS 失败就保留并报告冲突。崩溃重启后先查 journal 和实际文件，不盲目重放下载后的执行命令。

### 3.4 安全和权限必须写进验收

- **来源信任**：SKILL.md、README、registry 描述、安装日志都当数据，不能让其中的「忽略规则」「执行这条命令」变成安装器权限。没有脚本也不代表无 prompt-injection 风险。
- **明确执行边界**：配置一个 stdio MCP 意味着以后 CLI 会执行那个命令；确认发生在写入/启用之前，不是偷偷执行后才问。用 argv、`shell: false`，不给通用 `curl | sh` 或未经解析的 npm/git 命令入口；依赖安装可能跑生命周期脚本，风险要一并显示。
- **远程下载**：初版限定 HTTPS/受支持的仓库来源；禁止 userinfo、路径穿越、解压软/硬链接逃逸、解压炸弹和无限下载，限制重定向、文件数/大小、超时，固定版本和 hash。若以后允许任意来源，另做 SSRF、DNS/重定向到私网与元数据地址的防护，不能沿用 unrestricted Server fetch。
- **密钥**：敏感输入不进 CLI args、目录数据、分析埋点或 raw error；配置与备份按平台使用私有权限。MVP 按 CLI 原生私有文件存储，并如实说明明文；不要声称我们已经有 Orca 的加密 relay。OAuth 不复制别的 CLI 的 token 缓存，第一阶段需要时引导用户到目标 CLI 登录。
- **权限**：仅 Server 本机房主；访客、远程设备、Agent token 不能触发安装。权限检查既在 UI，也在每个读写/执行路由。
- **验证**：临时 HOME + fixture archive，覆盖越权、同名冲突、坏包/hash、目录重叠、本机改动、过期计划、第二目标写失败、失败补偿冲突、重启恢复、secret 脱敏、取消、只写配置未连接。浏览器补深浅色/窄屏/键盘；测试不碰真实运行时配置或 8787。

### 3.5 建议做法与排期

**建议做，拆两次交付，先把真实安装流程跑通再扩大目录。**

1. **MCP 精选目录 + 向导：2–3 个工作日。** 复用现有批量新增，支持可表达的 stdio 和远程固定 headers；明确登录未完成、未连接、待重启。初版不接任意 shell、OAuth 迁移或自动升级。
2. **skills 精选包 + 版本/冲突/卸载保护：4–6 个工作日。** 固定仓库 commit/子目录，staging 校验，provider 分发，receipt/journal、更新不覆盖本地改动；这也是后续 GitHub 来源的基础。
3. **后续再选：**官方 MCP Registry 搜索、用户粘 GitHub 子目录、原生 OAuth、团队分享链接。目录扩展约 3–5 天起，OAuth/分享需独立范围与权限设计，不算前两阶段已包含。

前两阶段合计约 **6–9 个工作日**，以单开发者、复用已有适配器为前提。先不建设自己的市场后端、不自动下载执行整目录、不默认全运行时安装。这样入口短、功能真实，也不会把今天刚合入的统一管理变成另一套易丢配置的接管系统。

## 调研验证记录

- 通过 Git 对照固定 SuperHive main；读取固定 Orca 构建元数据、静态构建文件及对应 GitHub TypeScript blobs，确认安装入口不只是文案。
- 实际读取官方 MCP Registry 公开列表 API；未以外部 registry 的运行结果验证任何 MCP 本身，也没有用其中的条目做安装。
- GitHub 整仓 recursive tree 与 raw 文件请求曾超时/重置；最终改用同提交的分层 Trees / Blobs API 成功取回本文引用的 TypeScript 文件。没有依据失败请求的残缺 JSON 推断文件内容。
- 本次唯一项目文件产出为本报告；不提交、不推送、不改权限、源码、真实 CLI 配置或 Agent 状态。
