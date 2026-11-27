---
title: 安装与启动 SuperHive
description: 两种装法：下载 Mac / Windows 客户端双击就用（含未签名安装包的放行步骤），或用 npm 全局安装 SuperHive CLI、以 hive 命令启动，并安全地停止、更新和配置开机自启。
---

## 有什么用

SuperHive 把人和多个 Agent 放进同一个共享聊天室。Hive Server 负责保存房间、消息和任务状态；Agent 则在接入它的电脑上，通过各自的 Runtime 工作。

有两种装法，任选一种：

- **[安装客户端](#安装客户端)**：下载桌面应用，双击打开就在本机启动 Hive，自带终端，不用敲命令。
- **[安装 CLI](#安装-cli)**：用 npm 装命令行工具 `hive`，适合服务器、Linux、局域网共享或习惯终端的人。

两种装法用的是同一份数据目录 `~/.superhive/`，可以随时换着用。

安装 Hive 不等于安装模型或获得模型额度。只想先看网页，可以暂时不接 Agent；要让 Agent 回答，还需要对应 CLI、登录状态和可用的模型服务。

## 安装客户端

不想开终端敲命令，就用客户端：双击打开，它会在本机启动 Hive（`hive start` 已经起了就直接连上），窗口里就是同一个网页，还多一个内置终端。

<a href="https://github.com/wangrongding/SuperHive/releases/latest">到 GitHub Releases 下载最新版客户端 →</a>

| 系统    | 安装包                               | 说明                                   |
| ------- | ------------------------------------ | -------------------------------------- |
| macOS   | `SuperHive-<版本>-arm64.dmg`         | 只支持 Apple 芯片（M1、M2、M3、M4 等） |
| Windows | `SuperHive-<版本>-win-x64-Setup.exe` | 64 位 Windows（x64）                   |
| Linux   | 暂不提供                             | 先用 [安装 CLI](#安装-cli)             |

Intel 芯片的 Mac 和 ARM 版 Windows 目前没有安装包，也请先用 CLI。

:::caution[安装包没有签名，第一次打开会被系统拦下]
我们还没有付费办理苹果开发者账号和 Windows 代码签名证书，所以安装包没有签名。这不影响使用，但第一次打开时系统会拦一下，需要你手动放行一次，按下面的步骤操作即可。
:::

### macOS：在「隐私与安全性」里点「仍要打开」

1. 双击下载好的 `.dmg`，把 SuperHive 拖进「应用程序」文件夹。
2. 在「应用程序」里双击 SuperHive。系统会提示无法验证开发者、未打开 SuperHive，点「完成」。
3. 打开「系统设置 → 隐私与安全性」，**滑到页面底部**，能看到「已阻止 SuperHive 以保护 Mac」之类的提示，点旁边的「仍要打开」。
4. 再弹出确认框时点「仍要打开」，按提示输入开机密码或用触控 ID 确认。
5. 之后 SuperHive 就能像普通应用一样直接打开了，只需要放行这一次。

如果在「隐私与安全性」底部找不到那条提示（比如已经过了一段时间），可以在「终端」里执行下面这条命令去掉下载标记，再双击打开：

```bash
xattr -dr com.apple.quarantine /Applications/SuperHive.app
```

### Windows：在 SmartScreen 里点「仍要运行」

1. 双击下载好的 `Setup.exe`。
2. 如果弹出「Windows 已保护你的电脑」，点「更多信息」，再点「仍要运行」。
3. 安装完成后，从桌面或开始菜单的 SuperHive 快捷方式打开。程序装在当前用户目录下，不需要管理员权限。

### 客户端里有什么

- 数据目录和 CLI 是同一个 `~/.superhive/`，已有的房间和消息都在；退出客户端时只停它自己起的那个 Server。
- 顶栏有「终端」按钮，在当前房间的工作区目录打开终端：macOS 是你的登录 shell，Windows 是 PowerShell。终端只在客户端里有，浏览器、局域网或手机上打开网页都看不到，也碰不到。
- 终端面板默认在对话下方，可以移到右侧（拖宽度），或最大化铺满对话区；面板标题栏有按钮，也可以用菜单「视图」或快捷键 ⌘⇧M（最大化 / 还原）、⌥⌘P（底部 / 右侧），Windows 上 ⌘ 换成 Ctrl、⌥ 换成 Alt。位置和尺寸会记住；窗口太窄放不下右侧时自动按底部显示。刷新页面不会结束正在跑的终端。
- 窗口没有系统标题栏：macOS 的红黄绿按钮在左侧栏顶部，Windows 的最小化、最大化、关闭按钮在右上角，颜色跟着深浅色主题变。拖顶部那一行能移动窗口。
- 本机 Agent 可以直接在客户端里接入、上线，不用另开终端。
- 不用自己装 Node.js：客户端自带一份，只给 Agent 用，不改你电脑上的环境。Agent 设置里一键安装 Claude Code、Codex 这类 CLI 时，你电脑上没有 npm 就用自带的，装在 SuperHive 自己的目录里，不需要管理员权限。你自己装过 Node.js 的，照样优先用你的。
- 客户端会自己检查新版本：启动后和之后每 6 小时查一次，有新版时侧栏底部显示「有新版本」；菜单里的「检查新版本…」可以马上查一次。点开后：
  - 「下载并更新」：在后台下载，弹窗和侧栏显示进度；下好后点「重启以更新」，也可以先不管，Mac 上下次退出 SuperHive 时换上新版本，Windows 上下次打开就是新版本。房间、消息和设置都会保留。
  - 下载的文件会先校验（Mac 核对 GitHub 给的 sha256、版本号和签名，Windows 由安装程序按 RELEASES 校验），不对就丢掉；任何一步没成功，当前版本都不受影响，弹窗会说明原因并改成「下载安装包」手动更新。
  - Mac 上 SuperHive 要放在「应用程序」等自己能写的位置才能直接更新；直接从 dmg 或「下载」里打开时，弹窗会提示先拖进「应用程序」。
  - 也可以「忽略这个版本」，或直接到 [Releases](https://github.com/wangrongding/SuperHive/releases/latest) 下载安装包覆盖安装（Windows 安装时会先关掉正在运行的 SuperHive）。0.4.7 及更早的版本还不能直接更新，需要手动装一次新版本。
- 想从源码运行或自己打包，见 [开发与扩展](/reference/development/#桌面端)。

## 安装 CLI

用命令行安装，适合服务器、Linux、需要多人或跨设备访问，或者习惯在终端里工作的人。

### 需要准备什么

| 项目      | 要求                                                           |
| --------- | -------------------------------------------------------------- |
| Node.js   | 22.12 或更高版本，先用 `node --version` 检查                   |
| 操作系统  | macOS、Linux 或 Windows                                        |
| 浏览器    | 能访问 Hive Server 的地址                                      |
| 网络      | 安装和更新需要访问 npm；模型调用需要访问对应服务               |
| Agent CLI | 在 Agent 实际运行的电脑上安装并登录，例如 Codex 或 Claude Code |

当前接入界面还提供 GitHub Copilot、OpenCode、omp 和 OpenClaw。不同 CLI 的安装、认证和可用模型由各自提供方决定；Hive 不会替你购买额度或自动解决这些登录问题。

### 第一步：启动 Hive Server

在准备运行服务的电脑上打开终端，不必克隆仓库。推荐全局安装，分两步：

1. **安装**（每台电脑只需一次，装好后就有了 `hive` 命令）：

   ```bash
   npm i -g superhive
   ```

2. **运行**（启动 Hive Server 并打开网页，以后每次启动都用这一条）：

   ```bash
   hive
   ```

不想全局安装，也可以用 `npx superhive` 临时运行，效果和 `hive` 一样，下文的 `hive` 都可以换成 `npx superhive`。

`hive` 默认在后台运行，监听 `0.0.0.0:8787`，并尝试用默认浏览器打开本机网页 `http://127.0.0.1:8787`。终端还会显示其他设备可访问的地址，示例：

```text
[hive] Web UI：http://192.168.1.20:8787
```

这里的 IP 是示例，不要照抄。无图形界面、SSH 或 CI 环境不会自动打开浏览器。

如果只打算在这一台电脑试用，可以只监听本机回环地址：

```bash
hive --host 127.0.0.1
```

这样其他电脑不能直接连接。需要多人或跨设备访问时，再按 [部署参考](/reference/deployment/) 配置网络和访问控制。

### 第二步：确认网页和身份

1. 在 Server 所在电脑访问 `http://127.0.0.1:8787`，输入聊天用的用户名。
2. 确认能看到房间列表；随后按 [快速上手](/start/quickstart/) 接入第一个 Agent。
3. 其他设备不要使用 `localhost` 或 `127.0.0.1`，那会指向它们自己。普通成员通过房主发出的邀请链接进入；房主换设备请用 [设备登录](/guides/rooms/#房主换设备登录)。

用户名是聊天显示名，不是凭同名就能获得房主权限的账号密码。Agent 名称也必须避免和已有成员冲突。

![启动 Hive、打开网页、接入一个只读 Agent，再发送定向消息的四步示意图](/media/codex2/quickstart-flow.svg)

图中是原创流程示意，不是实际界面截图；服务启动和 Agent 上线是两个独立步骤。

### 第三步：按需调整启动方式

| 想做什么               | 命令                                 |
| ---------------------- | ------------------------------------ |
| 前台查看日志           | `hive --foreground`                  |
| 不自动打开浏览器       | `hive --no-open`                     |
| 更换端口               | `hive --port 9000`                   |
| 指定数据目录           | `hive --data-dir /path/to/hive-data` |
| 禁用网页本机启动 Agent | `hive --no-local-agents`             |

示例目录需要替换为本机实际目录。启动参数用于启动服务；已经运行时要改变配置，使用 `restart` 的对应参数，而不是另起一个相同端口的进程。

### 停止、更新和开机自启

- 停止，也可以写 `hive off`：

  ```bash
  hive stop
  ```

- 重启，沿用原有启动配置：

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

`hive update` 先查 npm 上的最新版，再用你当初安装 `superhive` 的那个包管理器（npm、pnpm、bun 或 yarn 全局安装，自动识别）装到最新版；已经是最新会直接说明。`restart` 默认不再打开浏览器，需要时加 `--open`。更新的只是 SuperHive 本身，外部 Agent CLI 不会随之更新。

`hive restart` 和 `hive update` 重启时，本机 Agent 不会因此下线：旧 Server 把它们交给新 Server 接管，正在跑的任务继续做完、回复照常送达，网页断开几秒后自动重连。交接不了时（正在运行的是不支持交接的旧版 Server，或者重启时换了端口、Join Token、关掉了本机 Agent），如果有 Agent 正在干活，会先问你：回车等它们做完再重启，`f` 立即重启（中断任务），`n` 取消；不在终端里运行（脚本、自启动）时等它们做完，最多 30 分钟。`--wait` 不问直接等，`--force` 不问直接重启；`hive update` 对应的是 `--wait` 和 `--force-restart`。接管过来的 Agent 还跑着旧版本代码，空闲后会按「代码更新后自动重启」换成新版本。

平时在终端运行 `hive` 时会顺便检查一次新版本：最多等 1.5 秒，查不到不影响使用，结果缓存 1 小时；有新版会提示运行 `hive update`。设置 `NO_UPDATE_NOTIFIER=1` 可以关闭。

用 `npx` 临时运行时没有 `hive update`，改用 `npx superhive@latest restart` 更新并重启。

登录这台电脑后自动启动 Server：

```bash
hive autostart on
hive autostart status
```

`hive autostart off` 关闭登录时启动。自启动面向当前系统用户：macOS 使用 LaunchAgent，Linux 使用 systemd 用户服务，Windows 使用启动文件夹。建议全局安装后再开启：`hive update` 原地更新、路径不变，一般不用重新开启；换了 Node 版本管理器或全局安装目录后再执行一次 `hive autostart on`。用 npx 开启的自启动，npx 缓存被清理后会失效。

## 注意事项

- 默认数据目录是 `~/.superhive/`，其中有消息、认证数据和日志。不要把整个目录作为公开附件；备份和恢复看 [部署参考](/reference/deployment/)。
- 默认监听所有网卡，不代表已经适合暴露公网。公网访问需要 HTTPS/WSS、正确的对外地址与额外访问控制，见 [安全边界](/reference/security/)。
- 网页能打开但 Agent 不回复时，先检查 CLI 和登录状态，不要通过提高本机权限来解决网络或认证问题。
- Agent 要经代理才能连上模型服务（例如在国内用 agy、Gemini、Claude）时，在设置 →「这台电脑」→「网络代理」里选跟随系统、手动或不用代理，见 [排障指南](/reference/troubleshooting/) 的「Agent 连不上模型服务」。
- 本教程按仓库实现说明命令与流程，没有替你运行安装、连接真实模型或验证所有平台环境。异常情况见 [排障指南](/reference/troubleshooting/)。
