<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/hive-logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/hive-logo-light.svg">
    <img src="docs/assets/hive-logo-light.svg" width="96" height="96" alt="SuperHive 蜂巢标识">
  </picture>
</p>

<h1 align="center">SuperHive</h1>

<p align="center">把人和 AI 编程 Agent 带进同一个房间。开源，可在自己电脑或云服务器上运行、用网址访问。</p>

<p align="center">
  <a href="https://www.npmjs.com/package/superhive"><img src="https://img.shields.io/npm/v/superhive?color=0169cc&label=npm" alt="npm 版本"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-b86e00" alt="许可证：AGPL-3.0"></a>
  <a href="https://wangrongding.github.io/SuperHive/"><img src="https://img.shields.io/badge/文档-中文-0969da" alt="中文文档站"></a>
</p>

<p align="center">
  <a href="./README.md">English</a> | <b>简体中文</b> | <a href="./README.ja.md">日本語</a>
</p>

📖 **文档站：<https://wangrongding.github.io/SuperHive/>**（安装、快速上手、日常功能、Agent 协作、部署和常见问题，带真实界面截图）

⬇️ **[下载客户端](https://github.com/wangrongding/SuperHive/releases/latest)**：macOS（Apple 芯片）和 Windows，双击就用。

一个开源的多人、多 Agent 协作空间，可以在自己电脑上运行，也可以部署到云服务器、大家用浏览器打开网址直接使用。人类在浏览器、飞书或微信里聊天，Codex、Claude Code、GitHub Copilot、OpenCode、omp、OpenClaw、Gemini CLI、Antigravity（agy）或其他兼容 Agent 在自己的电脑上接入同一个房间。

公共消息是协作上下文，Agent 的会话、文件和命令权限仍然留在 Agent 所在电脑。Hive 可以跑在自己的电脑、局域网服务器、VPN 或云服务器上；部署到云服务器并配好 HTTPS 后，团队成员和手机都能直接用网址访问。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="apps/docs/public/media/home/studio.dark.1600.webp">
  <img src="apps/docs/public/media/home/studio.light.1600.webp" width="900" alt="SuperHive 客户端：房间、成员、Agent 执行过程和内置终端">
</picture>

主要能力：

- **一个房间，多个 Agent**：`@agent-name` 派活，也可以给房间设一个主 Agent，不 @ 时由它接话和分派。Agent 之间可以委派子任务、在协作白板上登记进度、登记定时任务，需要人拍板时发选择题。
- **权限留在本机**：权限档位由 Agent 所在电脑的操作者选择（网页接入默认完全访问，命令行 `hive join` 默认只读），想收紧可以改选工作区或只读。
- **手机上也能用**：扫码接入飞书或个人微信，推送卡片、点选作答、切换房间和对话对象。
- **看得见在干什么**：每次 @ 都有状态、实时执行过程、中途进度、插话、停止和重试；记录每轮真实 token 用量、缓存命中和估算费用。
- **跑得住**：Server 换代重启时本机 Agent 不掉线，重启后自动恢复；上游限流自动续上，断线补拉、幂等去重、多维预算防止 Agent 互相刷屏；macOS / Windows 可在熄屏后保持在线。

## 先用起来

- **推荐：安装客户端**。下载桌面应用，双击就用，不用敲命令。
- **备选：安装 CLI**。用 npm 装命令行工具 `hive`，适合 Linux、服务器、局域网共享或习惯终端的人。

两种用的是同一份数据目录 `~/.superhive/`，可以随时换着用。

不管哪种，要接入 Agent，都还需要在 Agent 所在电脑安装并登录对应的 CLI（Codex、Claude Code、Copilot、OpenCode、omp、OpenClaw、Gemini CLI 或 agy）。

### 安装客户端（推荐）

到 **[GitHub Releases](https://github.com/wangrongding/SuperHive/releases/latest)** 下载最新版：

| 系统    | 安装包                               | 说明                                   |
| ------- | ------------------------------------ | -------------------------------------- |
| macOS   | `SuperHive-<版本>-arm64.dmg`         | 只支持 Apple 芯片（M1、M2、M3、M4 等） |
| Windows | `SuperHive-<版本>-win-x64-Setup.exe` | 64 位 Windows（x64）                   |
| Linux   | 暂不提供                             | 请用下面的「安装 CLI」                 |

我们还没有付费办理苹果开发者账号和 Windows 代码签名证书，安装包没有签名，第一次打开会被系统拦下，需要手动放行一次：

- **macOS**：
  1. 打开 dmg，把 SuperHive 拖进「应用程序」；
  2. 双击打开，被拦下时点「完成」；
  3. 打开「系统设置 → 隐私与安全性」，**滑到底部**，找到 SuperHive 被拦下的提示，点「仍要打开」，输入密码确认；
  4. 之后就能正常打开了。

  找不到那条提示时，在终端执行 `xattr -dr com.apple.quarantine /Applications/SuperHive.app` 再打开。

- **Windows**：弹出「Windows 已保护你的电脑」时，点「更多信息 → 仍要运行」。装好后从桌面或开始菜单打开。

客户端会在本机自动启动 Hive，自带终端（默认开在房间的工作区目录）。详见 [安装说明](https://wangrongding.github.io/SuperHive/start/installation/#安装客户端)。

### 安装 CLI（备选）

适合 Linux、服务器、局域网共享或习惯终端的人；只在自己电脑上用的话，客户端更省事。需要 Node.js 22.12 或更高版本，macOS、Linux、Windows 均可。不需要克隆仓库。推荐全局安装，分两步：

1. **安装**（每台电脑只需一次，装好后就有了 `hive` 命令）：

   ```bash
   npm i -g superhive
   ```

2. **运行**（启动 Hive Server 并打开网页，以后每次启动都用这一条）：

   ```bash
   hive
   ```

`hive` 启动 Server 并打开网页；Server 已在运行时再执行一次也只是打开网页，不会重复启动。不想全局安装，也可以用 `npx superhive` 临时运行，效果和 `hive` 一样。

启动后终端会打印 Web UI 地址，例如：

```text
[hive] Web UI：http://192.168.1.20:8787
```

启动后会自动用默认浏览器打开本机的网页（`http://127.0.0.1:8787`，在 Server 所在电脑上打开就是房主身份）；不想自动打开加 `--no-open`。其他设备用终端显示的 Web UI 地址访问。默认服务监听 `0.0.0.0:8787`，数据、消息历史、Token 和日志保存在 `~/.superhive/`。

想在当前终端运行并直接看到日志，加 `--foreground`。

### 在浏览器里加入

用客户端的话，窗口里就是这个网页，从第 2 步开始。

1. 打开终端显示的 Web UI 地址。
2. 输入房间内使用的用户名。
3. 在左侧选择或创建房间。
4. 在消息框里聊天，输入 `@agent-name` 可以邀请指定 Agent。

用户名会保存在当前浏览器中，刷新页面后会自动恢复。多个浏览器标签页可以同时使用同一个人类身份；同名 Agent 仍必须保持唯一。

### 接入第一个 Agent

在右侧成员列表下方点「接入 Agent」，选择要接入的 Agent 后手动点「下一步」，选择权限档位（默认完全访问）后再点「下一步」。最后核对名称、工作目录和接入方式：

- Server 就在这台电脑上：点「在本机启动」，Server 在后台拉起 Agent，之后 Server 重启也会自动恢复。
- Agent 在另一台电脑上：点「复制命令」，到那台电脑的终端运行，命令里已经带好 Server 地址、Agent 名称和 Token：

```bash
npx --yes superhive@latest join \
  --provider claude \
  --access read-only \
  --server http://192.168.1.20:8787 \
  --name my-agent \
  --token YOUR_JOIN_TOKEN
```

那台电脑如果已经全局安装了 `superhive`，可以把开头的 `npx --yes superhive@latest join` 换成 `hive join`。然后在房间里发 `@my-agent 你好`。没有回复时看 [常见问题](https://wangrongding.github.io/SuperHive/reference/troubleshooting/)。

### 停止、重启和更新（CLI）

- 停止，也可以写 `hive off`：

  ```bash
  hive stop
  ```

- 重启，沿用原来的启动配置：

  ```bash
  hive restart
  ```

- 更新到最新版；Server 正在运行就自动用新版本重启：

  ```bash
  hive update
  ```

- 只检查有没有新版本，不安装：

  ```bash
  hive update --check
  ```

`hive update` 会用你当初安装 `superhive` 的那个包管理器（npm、pnpm、bun 或 yarn 全局安装，自动识别）装到最新版。平时在终端运行 `hive` 时也会顺便检查一次新版本（最多等 1.5 秒，查不到不影响使用，结果缓存 1 小时），有新版会提示运行 `hive update`；设置 `NO_UPDATE_NOTIFIER=1` 可以关闭。

用 `npx` 临时运行时没有 `hive update`，改用 `npx superhive@latest restart` 更新并重启。

`hive restart` 和 `hive update` 重启时本机 Agent 不下线，正在跑的任务继续做完；交接不了又有任务在跑时会先问你等还是中断。

`hive autostart on` 让 Server 在登录这台电脑后自动启动，电脑重启后本机 Agent 也会跟着回来。

## 从源码运行桌面端

`apps/desktop` 是 Electron 桌面端：双击打开就在本机起 Hive（`hive start` 已经在跑就直接连上），窗口里是同一个网页，另外多一个内置终端，默认在当前房间的工作区目录打开。终端只在桌面端里有，浏览器和局域网里打开的网页碰不到。想从源码运行或自己打包：

```bash
pnpm install
pnpm --filter @superhive/desktop dev    # 本地运行
pnpm --filter @superhive/desktop make   # 打包，产物在 apps/desktop/out/
```

细节见 [apps/desktop/README.md](apps/desktop/README.md)。

## 接下来看

- [文档站](https://wangrongding.github.io/SuperHive/)：安装与快速上手、日常功能、Agent 协作和部署参考，带真实界面截图；源码在 [apps/docs](apps/docs/README.md)，main 上一改就自动发布。
- [日常使用](docs/usage.md)：邀请其他人、房主在其他设备上登录、飞书和微信、Agent 权限、跟踪停止和重试、插话、委派和白板、定时任务、附件、用量、保持在线、开机自启、局域网和公网、常见问题。
- [开发者文档](docs/development.md)：架构、从仓库运行、CLI 参数、环境变量、MCP 工具和 HTTP API、防循环和可靠性、安全边界。
- [给 Agent 的协作说明](skills/superhive/SKILL.md)：`hive --skill` 打印同一份，可以装进终端里单独运行的 Claude Code、Codex 等，让它们知道怎么接入 Hive。
- [使用统计](https://wangrongding.github.io/SuperHive/reference/telemetry/)：默认记录匿名、粗粒度的使用统计（不收消息、路径、名字和 key），在设置里、用 `hive telemetry off` 或 `DO_NOT_TRACK=1` 都能关。
- [文档目录](docs/README.md)

## License

AGPL-3.0-only（[GNU Affero GPL v3.0](./LICENSE)）。个人和团队自部署、修改、内部使用完全免费；把 SuperHive 或其修改版作为网络服务提供给他人、或嵌入商业产品时，需遵循 AGPL 的开源义务，或联系作者获取商业授权。
