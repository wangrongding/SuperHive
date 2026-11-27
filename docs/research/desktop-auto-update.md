# 桌面端自动更新调研

> 2026-11-25 · rd-claude4 · 关联 rd #5853「发新版安装包，用户能收到更新吗？能不能自动更新？」、#5870「实现不了端内直接更新吗？」

## 结论

|                | 现在（不签名）                                                                                                                                                                                 | 以后有签名时                                              |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| **提示有新版** | ✅ 启动后和之后每 6 小时查一次 GitHub Releases，侧栏底部提示「有新版本」，可以忽略这个版本                                                                                                     | —                                                         |
| **Windows**    | ✅ 应用内更新：Electron `autoUpdater`（Squirrel.Windows）后台下载 Release 里的 `RELEASES` 和 `-full.nupkg`，「重启以更新」或下次打开生效。**没在真机上跑过**，见下文                           | 不变；签名只是少一次 SmartScreen 提示                     |
| **macOS**      | ✅ 应用内更新：自己下载 Release 里的 `SuperHive-darwin-arm64-<版本>.zip`，校验 sha256、版本号、Bundle ID 和签名后暂存，退出时由独立脚本替换 .app，「重启以更新」或下次退出生效。本机完整走通过 | 有 Developer ID 后可以换成 Squirrel.Mac，也可以继续用这套 |

两个平台都是：下载只走本仓库 Release 的地址；任何一步失败都退回「下载安装包」，当前已安装的版本不受影响。**0.4.7 及更早的版本没有这套代码，用户要手动装一次新版本**；之后的版本就能在应用里直接更新，前提是发版时上传了下面列出的更新包。

## 已经做的：检查新版并提示（不需要签名）

- **查哪里**：`apps/desktop/src/update-check.ts` 查 `https://api.github.com/repos/wangrongding/SuperHive/releases/latest`。
  - 启动 20 秒后查一次，之后每 6 小时一次。
  - 距上次查到不足 6 小时直接用缓存，缓存在 Electron 用户目录的 `desktop-update.json`。
  - 带上次返回的 ETag 去查，没有变化时 GitHub 回 304，不算进匿名每小时 60 次的限额。
  - 断网、限流、返回格式不对时都安静跳过，不改缓存，也不打扰用户。
- **怎么算有更新**：
  - 跳过 draft、prerelease 和带预发布标识的 tag。
  - 版本号要比 `app.getVersion()` 新（按 semver 比较）。
  - Release 里要有本平台的安装包：mac arm64 认 `SuperHive-*-arm64.dmg`，Windows x64 认 `SuperHive-*-win-x64-Setup.exe`。Intel Mac、Windows ARM、Linux 目前没有安装包，所以不提示。
- **网页里的样子**：
  - 侧栏底部（头像上面）显示一行「有新版本 0.4.8」。
  - 点开后可以看到当前版本、发布日期、「本版改动」摘要。摘要按界面语言取 Release 说明里「中文 / English」的一半。
  - 能直接更新时主按钮是「下载并更新」（见下面「应用内更新」）；不能时是「下载」安装包，并说明原因。另有「忽略这个版本」「完整发布说明」。
  - 浏览器里打开网页时没有这个入口，老版本桌面端也没有。
- **菜单**：
  - Mac 在应用菜单，Windows 在「帮助」菜单，各有一项「检查新版本…」。
  - 点了会马上查一次，并且一定给一个答复：有新版、已是最新，或者没能连上 GitHub。
- **安全边界**：
  - 网页只拿到版本号、说明摘要、安装包文件名和大小，拿不到任何链接。
  - 点「下载」和「完整发布说明」时，网页只告诉主进程打开哪一个，地址由主进程从自己的检查结果里取。
  - 打开前还会按白名单检查一遍：只允许 `https://github.com/wangrongding/SuperHive/releases/` 下的地址，拒绝带账号密码、端口、编码斜杠的地址。
  - 新加的三个 IPC 和终端一样，只认主窗口里本机 Hive 页面的顶层框架。
  - 缓存文件被改过也一样：读回来时按同样的规则再校验一遍。
- **开关**：
  - 打包后的正式版默认会查，开发时默认不查。
  - `SUPERHIVE_DESKTOP_UPDATE_CHECK=0` 一律不查，`=1` 时开发时也查。

## 覆盖安装后数据还在吗

**还在。** 程序、数据和设置放在三个不同的地方，覆盖安装只会动程序目录。

| 内容                                                                   | 位置（Windows）                      | 位置（macOS）                             | 覆盖安装时 |
| ---------------------------------------------------------------------- | ------------------------------------ | ----------------------------------------- | ---------- |
| 程序本身                                                               | `%LOCALAPPDATA%\SuperHive\app-x.y.z` | `/Applications/SuperHive.app`             | 替换       |
| Hive 数据：房间、消息、附件、Agent 设置、密钥                          | `%USERPROFILE%\.superhive`           | `~/.superhive`                            | 不动       |
| 桌面端自己的状态：窗口位置、启动画面主题、网页本地存储、检查新版的缓存 | `%APPDATA%\SuperHive`                | `~/Library/Application Support/SuperHive` | 不动       |

**Windows 实测**：查了 rd 的 Windows 机器上 11-24 那几次真实安装的 Squirrel 日志（`%LOCALAPPDATA%\SquirrelTemp\Squirrel-Install.log`），只读，没有再装。

- 15:23:53 运行 0.4.6 的 Setup.exe，覆盖已经装好的 0.4.4。日志原文是 `Install path C:\Users\zphz\AppData\Local\SuperHive already exists, burning it to the ground`。
  - 也就是说，Setup.exe 覆盖安装时是先关掉正在运行的 SuperHive，**把整个程序目录删掉再重装**，不是增量更新。
- 装完后两类数据都还在：
  - `~/.superhive`：11-20 的 `attachments/`、`im-secret.key`，以及 13:47 的 `hive.sqlite`；
  - `%APPDATA%\SuperHive`：11:34 写的 `splash-theme.json`，以及 10:45 建的网页本地存储（`Local Storage/leveldb/CURRENT`）。
- 所以：
  1. 数据和设置在覆盖安装后保留；
  2. 以后**不能把任何要保留的东西放进 `%LOCALAPPDATA%\SuperHive`**，那里每次覆盖安装都会被清空；
  3. 装新版时，Setup.exe 会自动关掉正在运行的 SuperHive，它带起来的本机 Hive 也会跟着停。SQLite 用的是 WAL，进程被关掉不会丢已经提交的数据。

**为什么没有用临时目录再装一遍**：

- Squirrel.Windows 的安装位置固定为 `%LOCALAPPDATA%\<应用名>`，Setup.exe 没有参数可以改。
- 绕开 Setup.exe，把 `Update.exe` 放到临时目录里运行 `--install`，倒是能装到临时目录。但安装钩子还是会以应用名 SuperHive：
  - 改写真实的开始菜单快捷方式和桌面快捷方式（日志里能看到 `--createShortcut` 写的是 `Start Menu\Programs\SuperHive\SuperHive.lnk` 和 `Desktop\SuperHive.lnk`）；
  - 改写 HKCU 下的卸载登记。
- 清理时还会把真的快捷方式删掉。这违反「不动现有桌面端」的要求，所以改用上面的真实日志作为验证。

**macOS**：数据不在 .app 里面，把新的 SuperHive.app 拖进「应用程序」替换旧的，不会碰到 `~/.superhive` 和 `~/Library/Application Support/SuperHive`。替换前要先退出旧版，否则访达会提示应用正在使用。

## 应用内更新（已做）

网页弹窗里的流程：「下载并更新」→ 下载中（Mac 显示百分比，Windows 只显示在后台下载）→ 校验中 →「重启以更新」。下载时可以关掉弹窗继续用，侧栏入口也显示进度。不点重启的话：Mac 下次退出 SuperHive 时换上新版本，Windows 下次打开就是新版本。失败时弹窗写明原因，主按钮换成「下载安装包」，可以「重试」。「忽略这个版本」和菜单「检查新版本…」都保留，菜单里查到新版时也能直接「下载并更新」，已经下好时直接问要不要重启。

代码：`apps/desktop/src/update-install.ts`（状态和流程）、`mac-update.ts`、`win-update.ts`；挑更新包在 `update-check.ts` 的 `pickInstallPackage`。

**安全边界**（和检查新版一样，再加几条）：

- 网页只能说「下载并更新哪个版本号」和「重启」，下载什么、从哪下载由主进程从自己的检查结果里挑，地址必须在 `https://github.com/wangrongding/SuperHive/releases/` 下。
- 两个新 IPC（`superhive:update:install`、`superhive:update:restart`）和别的一样只认主窗口里本机 Hive 页面的顶层框架；版本号必须是当前正在提示的那个。
- 下载完要核对内容，不靠地址：Mac 核对 GitHub API 给的 asset digest（sha256）和大小；Windows 由 Update.exe 按 `RELEASES` 里的 sha1 核对 nupkg。GitHub 会跳转到下载服务器，跳转后的地址不限制，内容对不上就丢掉。
- 检查结果的缓存格式升到 2（asset 带 sha256）；老缓存只留「忽略的版本」，马上重查。
- 检查新版和下载都用 Electron 的 `net.fetch`（Chromium 网络栈），跟随系统代理设置；Node 自带的 `fetch` 不认代理，国内连 GitHub 不稳时差别很大。

### Windows：autoUpdater（Squirrel.Windows）

- **feed 用新版 Release 自己的下载目录**：`https://github.com/wangrongding/SuperHive/releases/download/<tag>`，由 Release 里 `RELEASES` 资源的地址去掉文件名得到，并要求 `SuperHive-<版本>-full.nupkg` 也在同一个目录下。Update.exe 读 `<feed>/RELEASES`（会带 `?id=…&localVersion=…` 查询参数，GitHub 忽略），再下载同目录下的 nupkg。
  - 没用 update.electronjs.org：多依赖一个第三方服务，它对 Windows 安装包文件名还有要求（要带 `-win32` 或不带平台标识），我们的 `-win-x64-Setup.exe` 能不能被认出来没验证过；自己给 feed 更直接，地址也落在现有白名单里。
- Release 里缺 `RELEASES` 或 nupkg、不是用安装包装的（旁边没有 `..\Update.exe`，比如解压版）：不显示「下载并更新」，只给「下载」。
- `autoUpdater` 在 Windows 上没有进度事件，网页显示「正在后台下载」。出错（`error`）按网络问题处理；`update-not-available`（RELEASES 里没有比当前新的包，说明 Release 传错了文件）按更新包不对处理。
- 「重启以更新」调 `quitAndInstall()`：它先起 `Update.exe --processStartAndWait SuperHive.exe`（等本进程退出再打开最新的 `app-x.y.z`），再走正常退出流程（先停本机 Hive 和终端）。不点也行：开始菜单和桌面快捷方式指向 Squirrel 的启动壳，下次打开就是最新版本。新版本第一次启动带 `--squirrel-updated`，`squirrel.ts` 照旧重建快捷方式。
- 和 Setup.exe 覆盖安装不同，这种方式不删整个 `%LOCALAPPDATA%\SuperHive`，也不经过浏览器下载，不会再弹 SmartScreen。Squirrel.Windows 不校验签名，不签名也能用。

**没在真机上验证过的**（这次按要求只做到单测和接口层，真跑会改动用户目录）：

1. Update.exe 能否跟随 GitHub 的 302 跳转下载 `RELEASES` 和 nupkg（update.electronjs.org 给的 RELEASES 里也是 GitHub 下载地址，所以预计可以）；
2. `quitAndInstall()` 和我们 `before-quit` 里先停 Hive 再退出的流程配合是否顺畅；
3. 下好后不重启、下次从快捷方式打开是否就是新版本；
4. 新版本第一次启动的 `--squirrel-updated` 是否正常重建快捷方式。

建议发 0.4.8 后，在那台 Windows 上先手动装 0.4.8，再发一个 0.4.9 测一遍这四项。

### macOS：自己下载 zip 替换 .app（不签名）

1. **能不能原地替换**：从 `process.execPath` 往上找到 `.app`。路径里有 `/AppTranslocation/`（从「下载」等位置直接打开，系统把它挂到只读的随机路径）→ 提示先拖进「应用程序」；所在目录不可写：`EROFS`（dmg 等只读卷）、`EACCES`/`EPERM`（没权限）各有说明。这几种都不显示「下载并更新」。
2. **下载**：用 Electron 的 `net.fetch`（跟系统代理，跟随 GitHub 跳转）下到 `<userData>/updates/work/<版本>/update.zip`，边下边算 sha256、报进度；比 Release 上写的大就提前停，下完大小和 sha256 都要对上。
3. **解压和核对**：`ditto -x -k` 解到临时目录（保留符号链接，和访达一样），里面必须只有一个 `.app`；用 `plutil` 读 `Info.plist`，`CFBundleIdentifier` 必须是 `dev.superhive.desktop`、`CFBundleShortVersionString` 必须就是要更新的版本，`CFBundleExecutable` 指向的文件要存在。
4. **quarantine**：我们用 Node 自己写的文件不会被打上 `com.apple.quarantine`（Electron 应用没有声明 `LSFileQuarantineEnabled`）；为防 zip 里自带，再 `xattr -r -d` 清一遍，并用 `find -xattrname com.apple.quarantine` 复查，有残留就放弃。
5. **签名**：`codesign --verify --deep --strict` 必须通过，见下面「发现的问题」。
6. **暂存**：挪到当前 `.app` 旁边的隐藏目录 `.SuperHive-update-<版本>`（不以 `.app` 结尾，访达和启动台不会当成应用；和 `.app` 在同一个卷，后面替换只是 rename；用户目录和应用不在同一个卷时用 `ditto` 复制）。
7. **替换**：应用退出时（`before-quit`，在停 Hive 之前）起一个脱离的 `/bin/sh`，参数按位置传进去、不拼进脚本：等主进程 PID 退出（最多 120 秒，等不到什么都不动）→ 把旧 `.app` 改名挪开 → 把暂存的新 `.app` 改名挪进来，挪不进来就把旧的挪回去 → 删旧的 → 点过「重启以更新」时再 `open` 新版本。输出写到 `<userData>/updates/install.log`。
8. **清理**：下次启动时删掉没用上的 `.SuperHive-update-*` 和下载目录（比如上次等主进程超时没换成）；版本没变，检查器会照样提示，可以重新下载。

**换上去之后的影响**：新旧版本都是 ad-hoc 签名，签名的 cdhash 每个版本都不一样，所以和手动拖进「应用程序」覆盖一样，macOS 可能会就文件夹访问等权限再问一次。0.4.9 及以前每次换版打开还会弹钥匙串框（「SuperHive Safe Storage」），之后的版本在 Mac 上用 Chromium 的 `use-mock-keychain`，不再读写钥匙串（见 `apps/desktop/src/keychain.ts`）。数据和设置不在 `.app` 里，不受影响。

本机 Agent 也是用 `.app` 里的 Electron 跑的（`--superhive-cli`）。桌面端自己起的 Hive 退出时会一起停掉；如果连的是外面已经在跑的 Hive，那边的 Agent 进程会继续用旧文件跑到它们重启为止（macOS 上改名、删除正在用的文件不影响已经打开的进程），重启 Agent 后就是新版本。

### 发现的问题：0.4.7 及以前的 Mac 包签名不完整

本机核对时发现，Release 上 0.4.7 的 dmg 里的 `SuperHive.app` 签名不完整：`codesign --verify` 报 `invalid Info.plist (plist or signature have been modified)`。原因是 Forge 的 fuses 插件在 arm64 上只用 `resetAdHocDarwinSignature` 重签了主程序，没有重签整个 bundle。

- 从网页下载的 dmg 带 quarantine，用户在「隐私与安全性」点「仍要打开」后能用，所以之前没发现；
- 但应用内更新换上去的新版本不带 quarantine，签名不完整时 LaunchServices 直接拒绝打开（`open` 报 `_LSOpenURLsWithCompletionHandler() failed with error -54`），用户会以为更新把应用弄坏了。

修法：

- `forge.config.cjs` 加 `postPackage` 钩子，Mac 上打包后对整个 `.app` 跑 `codesign --force --deep --sign -` 并 `--verify --deep --strict`，从 0.4.8 起的包签名完整；
- 更新时也核对签名，不完整就不换，退回「下载安装包」。

有了 Developer ID 后换成 `osxSign` / `osxNotarize`，这个钩子就可以去掉。

### 发版时要多上传的文件

在打包的那台机器上运行：

```bash
pnpm --filter @superhive/desktop make
pnpm --filter @superhive/desktop release-assets
```

`release-assets`（`apps/desktop/scripts/release-assets.mjs`）把本平台要上传的文件收到 `apps/desktop/out/release/<版本>/`，打印每个文件的 sha256 和一条 `gh release upload v<版本> … --clobber` 命令，**只打印、不上传**；缺了应用内更新要用的文件会报错退出。

| 平台    | 文件                                 | 用途                                                  |
| ------- | ------------------------------------ | ----------------------------------------------------- |
| Mac     | `SuperHive-<版本>-arm64.dmg`         | 第一次安装、手动更新                                  |
| Mac     | `SuperHive-darwin-arm64-<版本>.zip`  | **应用内更新**（Forge maker-zip 的产物，约 130 MB）   |
| Windows | `SuperHive-<版本>-win-x64-Setup.exe` | 第一次安装、手动更新                                  |
| Windows | `RELEASES`                           | **应用内更新**：一行一个包，内容是 sha1、文件名和大小 |
| Windows | `SuperHive-<版本>-full.nupkg`        | **应用内更新**：完整包（约 167 MB）                   |

注意：

- GitHub 会给每个 asset 算 sha256（API 里的 `digest`），Mac 更新靠它校验，不用另外传校验文件；
- 少传了应用内更新的文件不会出错，只是那个平台的用户只能点「下载」手动装；
- 差量包（`-delta.nupkg`）这次没配，Windows 每次下完整包。

### 本机验证记录（Mac，2026-11-25）

全部在临时目录里做，没有动 `/Applications` 里已安装的 SuperHive：

1. 用本分支代码打包（`pnpm --filter @superhive/desktop package`），确认 `postPackage` 之后 `codesign --verify --deep --strict` 通过；
2. 把打出来的 `.app` 复制到临时目录当「已安装的 0.4.7」；再复制一份，把 `Info.plist` 的版本改成 0.4.8，加上 `LSEnvironment`（让重新打开的那份用独立的数据目录和端口，不和正在用的 SuperHive 抢单实例锁），像 `postPackage` 一样重新 ad-hoc 签名，用 `zip -r -y`（和 maker-zip 一样）打成 `SuperHive-darwin-arm64-0.4.8.zip`；
3. 本机起一个 HTTP 服务提供这个 zip，用 `mac-update.ts` 真的走一遍：下载（进度 0→100%）、sha256 校验、`ditto` 解压、核对版本号和 Bundle ID、quarantine 复查、签名核对、暂存到 `.SuperHive-update-0.4.8`；
4. 用一个 `sleep` 进程冒充主进程，调用「重启以更新」：替换脚本等它退出后把 0.4.8 换上去、删掉旧的、`open` 重新打开，新版本正常启动（进程在跑、窗口打开），临时目录里只剩 `SuperHive.app`；
5. 对照：用签名不完整的包（和 0.4.7 一样）走同样流程，替换后 `open` 报 -54 打不开——这就是上面加签名核对的原因。

单测另外覆盖：sha256 / 大小不对、HTTP 出错、zip 里版本号或 Bundle ID 不对、不是 zip、签名不完整，都按失败处理且不留暂存；替换脚本等进程退出、新版本挪不进去时把旧的挪回来、暂存不见时什么都不动；状态机的进度节流、重试、换版本后旧状态作废；Windows 的 feed 地址、事件解绑、各种失败。

## 参考

- Electron `autoUpdater`：https://www.electronjs.org/docs/latest/api/auto-updater
- Electron 更新指南：https://www.electronjs.org/docs/latest/tutorial/updates
- update.electronjs.org 的要求和资产命名：https://github.com/electron/update.electronjs.org
- Electron Forge Squirrel.Windows maker：https://www.electronforge.io/config/makers/squirrel.windows
- Electron Forge macOS 签名和公证：https://www.electronforge.io/guides/code-signing/code-signing-macos
