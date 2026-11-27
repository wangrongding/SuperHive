# 各 Agent CLI 的全局 skills：放在哪、怎么启停

调研时间：2026-11-26。用的是这台 Mac 上装的版本：Claude Code 2.1.330、Codex CLI 0.171.0、opencode 1.19.6、omp 19.1.0、GitHub Copilot CLI 1.0.114。OpenClaw 没装，只按文档整理。

结论先放前面：**六个运行时都有原生的单个 skill 开关**，所以 Hive 不靠改目录名、挪目录来停用，只改各 CLI 自己的配置。只有 omp 的开关在它自己管理的文件里，所以网页上只读。

| 运行时      | 全局 skills 目录（按读取顺序）                                                                                                                                                        | 单个 skill 的开关                                                                                                  | Hive 怎么做                                                                                                                                      | 核对方式                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Claude Code | `~/.claude/skills/<名>/SKILL.md`（`$CLAUDE_CONFIG_DIR` 优先）；插件带的在 `plugins/installed_plugins.json` 里各插件 `installPath/skills/`                                             | `~/.claude/settings.json` → `skillOverrides.<名>`：`on` / `name-only` / `user-invocable-only` / `off`，不写就是 on | 停用写 `"off"`，启用删掉这一项；插件 skill 跟着 `enabledPlugins` 走，只读                                                                        | 二进制里的 settings schema 说明                                                       |
| Codex       | `$CODEX_HOME/skills`（默认 `~/.codex/skills`）、`~/.agents/skills`；系统 skill 在 `$CODEX_HOME/skills/.system/`；插件在 `plugins/cache`                                               | `config.toml` 的 `[[skills.config]]`，按 `name` 或 `path` 选中，写 `enabled = false`                               | 停用时追加 `name = "…"`、`enabled = false` 一段，启用时删掉所有认这个 skill 的段（按 name 或 path）；系统 skill 能停用不能删                     | 二进制里的配置项名和告警文案（`skills.config entry without a path or name selector`） |
| opencode    | `~/.config/opencode/skills`（旧名 `skill`）、`~/.claude/skills`、`~/.agents/skills`；项目里还有 `.opencode/skills` 等                                                                 | `opencode.json(c)` → `permission.skill`：字符串对全部生效，对象按 glob 匹配、最后命中的为准，`deny` 隐藏并拒绝加载 | 按**目录名**（opencode 的 skill ID 是目录名，不是 frontmatter 的 name）写 `"deny"`；整体是字符串时改成 `{"*": 原值, "<id>": …}`                  | 官方文档 Skills 页 + 1.19.6 二进制里的 PermissionConfig                               |
| omp         | `~/.omp/agent/skills`（`skills.enablePiUser`）、`~/.agents/skills`（`enableAgentsUser`）；`~/.claude/skills`、`~/.codex/skills` 默认不读，要开 `enableClaudeUser` / `enableCodexUser` | `config.yml` → `skills.ignoredSkills`（glob 列表），另有 `skills.includeSkills`、`skills.enabled`                  | **只读**：config.yml 由 omp 自己管理（带锁文件），网页按这几项显示是否启用，提示用 `omp config set skills.ignoredSkills` 或 omp 里的 `/settings` | `omp config list`                                                                     |
| Copilot CLI | `~/.copilot/skills`（`$COPILOT_HOME`）、`~/.agents/skills`；**不读** `~/.claude/skills`；`skillDirectories` 可加目录，`ignoredSkillsLocations` 可排除                                 | `~/.copilot/settings.json` → `disabledSkills`（名字不分大小写，插件的写 `plugin:skill`）                           | 名单里加上或去掉这个名字                                                                                                                         | `copilot help config`                                                                 |
| OpenClaw    | `~/.openclaw/skills`（`$OPENCLAW_STATE_DIR`）、工作区 `skills/`（`agents.defaults.workspace`，默认 `~/.openclaw/workspace`）；还有随包的 bundled skills                               | `openclaw.json` → `skills.entries.<名>.enabled: false`                                                             | 停用写 `enabled: false`，启用删掉这一项；面板上标「按文档实现，没在真机核对」                                                                    | 只看了文档，这台电脑没装                                                              |

共同点：

- 格式都是一个目录一个 skill，目录里放 `SKILL.md`，开头是 YAML frontmatter（`name`、`description`），旁边可以放脚本和参考文件。opencode 还接受根目录下的单个 `*.md`，Hive 不列这种。
- 多个运行时会共用同一个目录：`~/.agents/skills` 被 Codex、opencode、Copilot CLI、omp 读，`~/.claude/skills` 被 Claude Code 和 opencode 读。这台电脑上还有不少 skill 是从 `~/.claude/skills` 软链到 `~/.agents/skills` 的。

## Hive 的处理

- **列出**：按上表的目录扫一遍，有 `SKILL.md` 的子目录（含软链）算一个 skill。来源分成：用户目录、共用目录（标出还有哪些已装的运行时会读这个目录）、插件、CLI 自带、Hive 自带。
- **Hive 自带的 superhive**：`hive skill install` 装的 `SKILL.md` 末尾有托管标记 `id=superhive version=…`，按这个认。只能查看，不能停用、删除、同步，用 `hive skill install / uninstall` 管理。
- **启停**：只用上表的原生开关，写入前备份原文件、原子替换，和配置面板其它写入一样。认不出的写法（例如 Codex 的 `skills.config` 写成内联数组、opencode 的 `permission` 整个是字符串）只读，不硬改。
- **删除**：二次确认后把 skill 目录挪进同级的 `.superhive-skill-backups/<目录名>-<时间>-<随机>`，比如 `~/.claude/.superhive-skill-backups/`。软链只挪链接本身。不真删，要恢复就挪回去。共用目录删掉会影响别的运行时，确认时会列出来。
- **统一管理（参照 cc-switch）**：「Agent 运行时」顶上和底部状态栏的「MCP · 技能」进同一张表，一行一个 MCP / skill，每列一个 CLI。勾上写进那个 CLI 的全局配置，取消就停用；CLI 不支持停用时（Claude Code 的 MCP）取消就从它的配置里删掉，只剩最后一份时不让删，免得这一项彻底丢了。还没有的 CLI 勾上时从已有的复制：skill 复制整个目录到目标 CLI 自己的 skills 目录（软链展开成实际文件），MCP 连同环境变量的值写进目标的全局配置（复用 `putMcp`），远程 MCP 写死值的请求头按目标的写法转过去（Claude / Copilot / omp / opencode 是 `headers`，Codex 是 `http_headers`）。各家写法对不上的不硬转，整体拒绝并列出字段、提示到目标 CLI 里手动添加：Codex 的 `bearer_token_env_var`、`env_http_headers`、`cwd`、超时，Copilot 限定了的 `tools`，以及引用环境变量的值（`${X}`、`{env:X}`，各 CLI 展开规则不同，原样搬过去会变成字面量）；目标已有同名的就拒绝，不覆盖。新增 MCP 可以一次写进多个 CLI。插件、CLI 自带和 superhive 的 skill 不能复制。和 cc-switch 不同，**不另存一份主列表**：每次都从各 CLI 的配置文件读，在 Hive 外手改的也能读回来，不会被覆盖。
- **权限**：接口都在 `/api/local/…` 下，和运行时配置一样只给 Server 所在电脑上的本机房主；访客、房主的其他设备、Agent 的令牌都拒绝。审计日志只记哪个运行时、哪个 skill、做了什么，不记内容。

## 从网上装（借用 skills.sh）

「MCP 与技能 → 发现 / 安装 → 技能」和 `hive skill search` 借用 [vercel-labs/skills](https://github.com/vercel-labs/skills)（`npx skills`，对照 1.9.1）背后的 skills.sh，但不调用它的 CLI，实现见 `apps/server/src/skill-market.ts`：

- **搜索**：Server 代理 `GET https://skills.sh/api/search?q=…[&owner=…]`（不用认证，词少于 2 个字符它直接报错，一次最多回 100 条，字段 `id/source/skillId/name/installs`）。只认 GitHub 的 `owner/repo`，去掉控制字符，按安装量排序；anthropics、openai、vercel-labs、github 等知名机构的仓库标「常用来源」（`SKILL_POPULAR_OWNERS`），只是帮人挑，不代表审核过。
- **预览**：先问 GitHub 当前提交号（`commits/HEAD`），按提交号取整棵树，按目录名（不行再读各 SKILL.md 的 name）找到这个 skill 的目录；文件内容先用 skills.sh 的 `/api/download/<owner>/<repo>/<skillId>` 快照（一次请求），每个文件按树里的 Git blob sha 核对，缺的和对不上的（二进制、快照落后）再从 `raw.githubusercontent.com/<repo>/<提交号>/…` 单独取。可执行位从树里读；软链、子模块、`metadata.json` 不装。GitHub 接口匿名额度 60 次/小时，用完或连不上时只用快照，面板上标「没有和 GitHub 核对」。限 300 个文件、单个 2 MB、总共 10 MB；路径带 `..`、绝对路径、反斜杠、控制字符、大小写重名的整包拒绝；只去这四个域名，跳到别处当失败。下载的内容放在 Server 内存里 10 分钟，预览不写文件、不执行任何东西，SKILL.md 只当文本显示，脚本、可执行、二进制单独标出。
- **安装**：勾选要装给哪些 CLI，写的就是预览时那一份（计划用一次作废）。目录放进各 CLI 自己的主 skills 目录（上表第一个），目录名用仓库里的目录名；同名已有的不覆盖；先写临时目录再改名。同一批里前面装好的目录被后面的 CLI 共读到（例如 Claude Code 的目录 opencode 也读）时，后面那个报「已经能用」，不再装第二份；默认就不勾这种。装完靠上面的扫描读回来，每个 CLI 单独报结果。

为什么不直接调 `npx skills add … -g -y -a … --copy`：它的目录映射和 Hive 的扫描对不上（Codex 它装到 `~/.agents/skills`，Hive 以 `~/.codex/skills` 为主；omp 不在它支持的 agent 里；默认还会先建 `~/.agents` 规范目录再软链）；要 Node ≥ 22.20，首次还要从 npm 下载执行一个包；匿名统计要靠 `DISABLE_TELEMETRY` / `DO_NOT_TRACK` 关。自己下载能做到：写进 Hive 扫描的那些目录、同名不覆盖、按提交号逐个核对、预览和安装是同一份内容、不在这台电脑上执行任何第三方代码。

## 没做的

- 项目级 skills（`.claude/skills`、`.agents/skills`、`.opencode/skills` 等）：跟着仓库走，不在「全局」范围里。
- Codex 插件、Copilot 插件带的 skills：目录结构各家不同，先不列。Claude Code 插件只列出、只读。
- OpenClaw 的 bundled skills（`skills.allowBundled`）：在安装包里，不列。
- 从备份目录一键恢复：先靠手动挪回。
- 从网上装的 skill 记来源和提交号、检查更新：现在装完就和手动放进去的一样，不记来源。
