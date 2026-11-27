# SuperHive 桌面端（预览）

用 Electron 45 把 SuperHive 包成一个双击就能用的应用：打开后自动在本机起 Hive（或连上已经在跑的那个），窗口里就是现有的网页界面，另外多一个内置终端。

> 预览阶段：安装包作为未签名预览版发布在 [GitHub Releases](https://github.com/wangrongding/SuperHive/releases/latest)，还没有签名和公证；从 0.4.8 起可以在应用里直接更新（见下面「发版」和 [docs/research/desktop-auto-update.md](../../docs/research/desktop-auto-update.md)）。

## 它做了什么

- **本机 Hive**：读 `~/.superhive/server.json`，`hive start` 起的 Server 还在跑就直接连上，不再起第二个；没有就用 `utilityProcess` 起一个，写同样格式的 `server.json`，`hive stop` / `hive start` 都认得它。8787 被别的程序占了就往后找空端口。退出应用时只停自己起的那个，先请它正常退出（本机 Agent 下线、IM 断开），等不到再结束。数据目录、数据库和 CLI 是同一份，不迁移也不改写用户数据。Server 的 cwd 和 `HIVE_LAUNCH_DIR` 都设成用户主目录（`serverEnv`）：应用自己的 cwd 是安装目录（Windows `%LOCALAPPDATA%\SuperHive\app-<版本>`，升级后旧目录会被删）或 `/`（Mac 双击 .app），都不能当新建 Agent、房间工作区的默认目录。早先建的本机 Agent 工作目录指向安装目录时，Server 启动它前改成主目录并在 Agent 设置里提示（`checkCwd`）。
- **本机 Agent**：打包后的应用关了 RunAsNode，Electron 不能当 Node 用。Server 改由环境变量 `HIVE_LOCAL_AGENT_CLI` 得知怎么拉起 Agent：桌面端让它运行 `SuperHive --superhive-cli join …`，主进程看到这个参数就只运行包里自带的 superhive CLI，不开窗口、不占单实例锁。
- **PATH**：从访达、Dock 启动的程序拿不到 shell 配置里的 PATH，启动时用登录 shell 读一次再合并，本机 Agent 和终端才能找到 `claude`、`codex`、`node`。给 Server 的 PATH 末尾再追加自带的 Node 和 `agent-clis`（见「自带的 Node」）。
- **窗口**：加载 `http://127.0.0.1:<端口>` 的现有网页（在本机打开才是房主身份）；记住大小和位置（换了显示器会放回可见区域）；只允许一个实例；macOS 上关窗口不退出，点 Dock 图标再打开，⌘Q 才退出。
- **标题栏**：去掉系统标题栏，网页顶栏顶到窗口最上面。macOS 用 `titleBarStyle: "hidden"`，红黄绿按钮在左侧栏顶部那一行垂直居中（网页同步顶栏高度，界面密度变了按钮跟着挪），全屏时按钮隐藏、让出的位置收回；Windows / Linux 用 `titleBarOverlay` 保留系统按钮（Win11 贴靠布局照常可用），底色、图标颜色和高度跟网页主题实时同步，失焦时图标变淡，网页用 `env(titlebar-area-*)` 在右上角让位。侧栏顶部、聊天顶栏、右侧栏顶部可拖动，按钮、输入框、提示等都是 `no-drag`，模态弹窗打开时顶部不再拖动。所有贴着窗口顶边的面板和弹窗统一按 `--titlebar-safe-top / --titlebar-safe-left / --titlebar-safe-right` 让位（窗口最上面那一行始终露出顶栏和窗口按钮：「代码」「产物」大面板、居中弹窗、提及和任务等面板都从这一行下面开始排），新加弹层也用这三个变量；Windows / Linux 上弹窗遮罩盖住右上角时，网页把那一点叠出来的颜色发给主进程，系统按钮底色跟着变暗。窗口最小 960×640。preload 在 html 上打 `data-desktop`、`data-titlebar`、`data-fullscreen`，样式全在 `apps/web/src/styles/desktop-titlebar.css`，浏览器里一条都不生效。`SUPERHIVE_DESKTOP_TITLEBAR=native` 退回系统标题栏。
- **启动加载动画**：窗口一打开就按上次的位置大小显示，蜂巢 logo 动画铺在窗口里单独的一层 `WebContentsView` 上（`src/splash.ts`，纯 CSS + 内联 SVG）：描边画出、点亮中心、中心往外一圈圈扩散六边形信号。本机 Hive 起好后网页在这层下面加载，首屏画好时网页经 preload 的 `ready()` 通知主进程，logo 缩小淡出、底色变透明露出主界面；启动快时不硬等，没画完的入场动画加速播完。加载超过约 2 秒才淡入一行状态文字，超过 12 秒补一句提示。深浅色用上次网页的主题（记在用户目录的 `splash-theme.json`，和系统一致时跟随系统），`prefers-reduced-motion` 时换成静态 logo 加轻微明暗变化。起不来或 Hive 中途停了，停在出错画面上写明原因和日志位置，可「重试」「打开日志目录」「退出」。`SUPERHIVE_DESKTOP_SPLASH=comb` 换成「小六边形一格格拼出」的备选方案。preload 的本机 Hive 地址改为载入时同步问主进程（窗口比 Hive 先建出来），主进程只回答主窗口的顶层框架。
- **终端**：主进程里用 node-pty，网页里用 xterm 6（fit、web-links）。顶栏「终端」按钮或菜单「文件 → 新建终端」（Ctrl+\`）打开，默认在当前房间的工作区目录，没有工作区就在主目录；macOS / Linux 是用户的登录 shell，Windows 是 PowerShell。多标签；可以停在底部（拖高度）、右侧（拖宽度）或最大化铺满对话区，面板标题栏按钮、菜单「视图」、⌘⇧M / ⌥⌘P 切换，位置和尺寸记在 localStorage；对话区放不下右侧（对话至少留 360px）时按底部显示。收起面板不结束进程，关标签才结束；页面刷新时进程留在主进程（每个终端留最近 512K 字符输出），新页面 60 秒内 `list` + `attach` 接回并回放，没接回的才结束；窗口关闭时全部结束。

## 安全

对照 [Electron 安全清单](https://www.electronjs.org/docs/latest/tutorial/security)：

- 所有渲染进程开 `sandbox`、`contextIsolation`，关 `nodeIntegration`、`webviewTag`；
- preload 只经 `contextBridge` 暴露 `window.superhiveDesktop`（终端的创建、读写、调整大小、结束；标题栏外观同步，只收 `#rrggbb` 颜色（含可选的遮罩色）和 28–80 的高度；输入框「添加附件」的系统选文件窗口 `files.pick`），并且只在页面来源是本机 Hive 回环地址、且是顶层框架时才暴露；
- **选附件**（`src/file-picker.ts`）：网页只给房间 ID，对话框起始目录由主进程自己向本机 Hive 查（本机凭证 + `GET /api/local/rooms/:roomId/workspace`），必须是存在的目录，否则用用户主目录；起始目录只用来打开对话框，不读、不列。只读回用户在对话框里选中的文件，按上传上限读（单个 20 MB、10 个、合计 50 MB），超限的只回名字和大小；对话框关上时页面已经跳走就什么都不交；同一页面同时只开一个对话框；
- 每个 IPC 都在主进程再校验一次 `senderFrame`：必须是我们窗口的顶层框架、来源等于本机 Hive 地址，iframe、别的窗口、跳走后的页面一律拒绝；每个终端只归创建它的页面，别的页面读写不了；
- 不允许跳到别的站点，外部链接交给系统浏览器；同源新窗口不带 preload；禁止 webview；权限请求只放行剪贴板、通知、全屏，并且只给本机 Hive；
- Fuses：关 `RunAsNode`、`EnableNodeOptionsEnvironmentVariable`、`EnableNodeCliInspectArguments`，开 asar 完整性校验和 `OnlyLoadAppFromAsar`，开 Cookie 加密；
- **终端能力不经过网络**：只走 Electron IPC。局域网、远程或浏览器里打开的网页没有 preload，`window.superhiveDesktop` 不存在，网页也不会出现终端入口、不会加载 xterm。

## 本地开发

在仓库根目录先 `pnpm install`，然后：

```bash
pnpm --filter @superhive/desktop dev     # 组装 .stage/app 并启动
pnpm --filter @superhive/desktop test    # 单元测试（IPC 校验、终端会话、端口发现、窗口位置、标题栏）
pnpm --filter @superhive/desktop test:smoke   # 冒烟：真的启动应用、开终端执行命令、接入一个本机 Agent；所有面板和弹窗不压窗口按钮、Esc 和关闭按钮都能关、登录页不出滚动条
```

- `scripts/stage.mjs` 把应用组装到 `.stage/app`：主进程和 preload（esbuild 打包）、随包的 superhive（`packages/superhive` 的 dist、web、skills，和 npm 包同一份），以及用 npm 单独装的运行时依赖。网页或 Server 改了要带 `--rebuild` 重新构建 superhive 包。
- 运行时依赖不用仓库的 pnpm node_modules：仓库里的 better-sqlite3 12.x 在 Electron 45 的 V8 上编译不过，桌面端这一份换成走 N-API、自带预编译包的 13.2（见 `package.json` 的 `superhiveDesktop.dependencyOverrides`），改编译也不会影响 server 测试。node-pty 1.1 同样是 N-API 预编译包；Linux 上没有预编译包，stage 时按 Electron 编一次。
- 开发时不想碰自己的 `~/.superhive`，可以设 `SUPERHIVE_DESKTOP_DATA_DIR=/tmp/xxx` 和 `SUPERHIVE_DESKTOP_PORT=18787`。设了数据目录时 Electron 的用户目录也放到它下面，和正在用的桌面端互不影响（单实例锁、窗口位置分开），开发版、冒烟测试可以和安装版同时开。

## 打包

```bash
pnpm --filter @superhive/desktop make      # 重新构建并打出安装包
pnpm --filter @superhive/desktop package   # 只打 .app / 目录，不做安装包
```

产物在 `apps/desktop/out/`（已 gitignore）：macOS 是 `out/make/dmg/arm64/SuperHive-<版本>-arm64.dmg` 和 `out/make/zip/darwin/arm64/SuperHive-darwin-arm64-<版本>.zip`。Mac 上打包后 `forge.config.cjs` 的 `postPackage` 会把整个 `.app` 重新 ad-hoc 签名并校验（fuses 只重签了主程序，签名不完整的包在应用内更新后打不开）。Windows（Squirrel 安装包、zip）和 Linux（deb、rpm、zip）的 maker 已经配好，需要在对应系统上打。

打包时 `scripts/prune-natives.cjs`（Forge 的 `afterCopy` 钩子）把 node-pty、better-sqlite3 里非目标平台的预编译、`.pdb` 调试符号和 C++ 源码删掉，Windows 安装包因此从 191MB 降到 168MB。

Windows 上打包（Windows 11 x64 实测过）：

- 在 Windows 本机打，`node scripts\forge.mjs make --arch x64 --targets @electron-forge/maker-squirrel`（只要 zip 就换成 `maker-zip`）。
- 连不上 GitHub 时设 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 下载 Electron。
- 打包时重命名临时目录报 `EPERM`，多半是 Defender 正在扫刚解压的文件，重试或把构建目录加进排除项。
- Squirrel 最后用 rcedit 给 `Setup.exe` 写版本信息时可能报 `Unable to commit changes`，Forge 会把这当失败；这时 `out/make/squirrel.windows/x64/Setup.exe` 已经生成、可以正常安装，只是没有版本信息、也没改名成 `SuperHive-<版本>-win-x64-Setup.exe`（正常完成时 Forge 直接产出这个名字，和 Release 上的一致，不用手动改名）。
- 安装包装到 `%LOCALAPPDATA%\SuperHive`，安装时建开始菜单和桌面快捷方式，卸载时删掉，并撤掉正式包启动时登记的 `superhive://` 链接（主进程处理 `--squirrel-*` 事件，见 `src/squirrel.ts`）；Electron 自己的数据在 `%APPDATA%\SuperHive`，Hive 数据仍是 `%USERPROFILE%\.superhive`。

打包版的冒烟测试（fuses 开着，用 Chromium 远程调试端口连上窗口）：

```bash
SUPERHIVE_DESKTOP_APP=out/SuperHive-darwin-arm64/SuperHive.app/Contents/MacOS/SuperHive pnpm --filter @superhive/desktop exec playwright test test/packaged.smoke.ts
```

为什么用 Electron Forge：这是 Electron 官方维护和推荐的工具链，fuses、原生模块重编、各平台 maker 和发布器都是官方插件。pnpm 仓库的问题用「先组装到 `.stage/app`、在那里跑 Forge」解决。

应用图标的源文件是 `build/icon.svg`，改了之后运行 `pnpm --filter @superhive/desktop icons`（需要 macOS）重新生成 png / icns / ico。

## 发版：要上传的文件

每次发版在各自平台打包后运行 `pnpm --filter @superhive/desktop release-assets`：把要上传的文件收到 `out/release/<版本>/`，打印 sha256 和 `gh release upload` 命令（只打印，不上传）。缺了应用内更新要用的文件会报错退出。

- Mac：`SuperHive-<版本>-arm64.dmg`（安装）和 `SuperHive-darwin-arm64-<版本>.zip`（应用内更新）；
- Windows：`SuperHive-<版本>-win-x64-Setup.exe`（安装）、`RELEASES` 和 `SuperHive-<版本>-full.nupkg`（应用内更新）。

推送 `v*` 标签时，`Desktop release assets` GitHub Actions 工作流会在 Windows runner 上构建并保存上述 Windows 文件为 artifact；下载并核对校验和后，再上传到同版本 GitHub Release。本机下载大文件不便时，可手动运行此工作流并填写 `source_run_id`，让 CI 把该 run 的同版本 Windows artifact 上传到已经创建的 Release（不重新构建、不覆盖同名文件）；留空则只构建。macOS 文件仍按上面的本机打包流程生成。

没传更新包时那个平台只能手动下载安装包。客户端只认正式版（不是 draft、prerelease）里的这些文件名，Mac 的 zip 靠 GitHub 给的 sha256 校验。

## 发布前要准备的（这次没做）

| 事项                  | 要准备什么                                                                                   | 配置位置                                                                 |
| --------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| macOS 签名和公证      | Apple Developer 账号（年费）、Developer ID Application 证书、App 专用密码或 API Key、Team ID | `forge.config.cjs` 的 `packagerConfig.osxSign` / `osxNotarize`           |
| Windows 签名          | 代码签名证书（OV/EV），或 Azure Trusted Signing 账号                                         | `packagerConfig.windowsSign`、`maker-squirrel` 的签名参数                |
| 发布到 GitHub Release | 有发版权限的 GitHub token；在 CI 上按平台打包                                                | `forge.config.cjs` 的 `publishers`（`@electron-forge/publisher-github`） |

## 自带的 Node

桌面端自带一份官方 Node LTS（含 npm、npx），**只给本机 Agent 跑和安装 npm 装的 CLI 用**：不加进系统 PATH，不改用户的环境变量，也不影响内置终端。

- **为什么不用 Electron 当 Node**：那要打开 RunAsNode fuse，任何程序都能借 `SuperHive.exe` 跑任意脚本（安全软件很在意这种行为）；Electron 里也没有 npm，「帮用户装 CLI」做不了。
- **打包**：`scripts/stage.mjs` 调 `scripts/node-runtime.mjs` 下载固定版本的官方压缩包，放进 `.stage/node`，Forge 用 `extraResource` 带进安装包（Mac 在 `SuperHive.app/Contents/Resources/node`，Windows 在 `resources\node`）。每个平台压缩包的 SHA-256 写死在 `node-runtime.mjs` 里，下载后要和它、也要和当场从 nodejs.org 拉的 `SHASUMS256.txt` 都对得上，否则中止打包。头文件、文档、corepack 不带。压缩包缓存在 `apps/desktop/.cache/node`（CI 用 actions/cache 缓存）。
  - 升级 Node：改 `NODE_RUNTIME.version`，把新版 `SHASUMS256.txt` 里对应几行抄进 `sha256`。
  - 离线开发可以设 `SUPERHIVE_SKIP_BUNDLED_NODE=1` 跳过下载；这时 `forge package/make` 会拒绝打包（`prePackage` 钩子），免得发出一个不带 Node 的包。
- **怎么交给 Agent**：主进程起 Server 时设三个环境变量（`src/bundled-node.ts`），Server 再传给每个本机 Agent：
  - `SUPERHIVE_BUNDLED_NODE`：node 本体的绝对路径；
  - `SUPERHIVE_AGENT_CLIS_DIR`：`<userData>/agent-clis`，用自带 npm 装 CLI 时的全局前缀；
  - `PATH`：把 `agent-clis` 的命令目录和自带 Node 的目录**追加到末尾**。用户自己装的 node、CLI 排在前面照样优先；没装的时候，Mac / Linux 上 `#!/usr/bin/env node` 的 CLI 也能找到 node。
- **Windows 上跑 npm 的 `.cmd` 启动器**：CLI 和 Server 两份解析器（`windows-command.ts`）按这个顺序找 node：启动器旁边的 `node.exe`（nvm 的目录就是这样）→ 启动器在 `agent-clis` 里（SuperHive 用自带 npm 装的）就用自带的 node → `PATH` 里真正的 `node.exe`（用户自己装的 Node 优先：官方安装包把 node.exe 放在 Program Files，npm 全局命令却在 `%APPDATA%\npm`，启动器旁边没有 node.exe）→ 自带的 node → 报错。自带的 node 不见了（安装不完整）时提示重装桌面端；「请安装 Node.js 并重新打开桌面端」这句只在开发版、纯 npm 版（没有自带 Node）里出现。原生 `.exe` 照旧直接运行。
- **一键安装 CLI**（Agent 设置里的 CLI 列表，`apps/server/src/agent-clis.ts`）：
  - Mac / Linux：系统里有 npm 就照旧用用户自己的；没有时用自带的 npm，加 `--prefix <userData>/agent-clis` 装进 SuperHive 自己的目录，不需要管理员权限。Claude Code、OpenCode 仍先跑官方安装脚本，失败才退回 npm。
  - Windows：用自带的 `node.exe` 直接跑 `npm-cli.js`，装进 `%APPDATA%\SuperHive\agent-clis`；之后的一键升级也只针对装在这里的那份。omp（要 bun）、agy（不在 npm 上）和别处装的仍要手动。

## 已知限制

- 未签名的 macOS 应用第一次打开会被 Gatekeeper 拦下，要到「系统设置 → 隐私与安全性」底部点「仍要打开」（macOS 15 起右键「打开」已经不能放行），或者 `xattr -dr com.apple.quarantine /Applications/SuperHive.app`。
- 每个本机 Agent 是一个不带窗口的 Electron 主进程，比直接用 Node 多占几十 MB 内存。
- 用户不用自己装 Node.js：安装包里自带一份官方 Node（见下面「自带的 Node」）。Electron 的 RunAsNode 保持禁用，不把桌面端开放成执行任意外部脚本的 Node 运行时。
- Windows 上 Electron 遇到「像网址的参数后面还跟着 `--` 开关」会直接退出（防协议处理器注入），所以 Server 拉起 CLI 时字符串选项一律写成 `--key=value`（`apps/server/src/local-agents.ts` 的 `cliOption`）。
- 命令行模式（`--superhive-cli`）下除了常驻的 `join`，命令做完主动退出（Electron 的消息循环不会自己停）；Chromium 缓存按 Agent 分目录放在 `<userData>/cli/` 下，不和桌面端、别的 Agent 抢。
- Windows 安装包未签名，从网上下载后打开时 SmartScreen 一般会提示「已保护你的电脑」，需要点「更多信息 → 仍要运行」。
- Linux 只配好了 maker，没有实际打包和运行过。
