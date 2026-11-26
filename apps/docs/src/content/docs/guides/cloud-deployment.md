---
title: 云端部署与多人共用
description: 从零把 SuperHive CLI 部署到 Linux 云服务器，配置 systemd 常驻、HTTPS 与房主设备登录，再邀请团队和各自电脑上的 Agent 加入同一个网页协作。
---

## 最终会得到什么

一台持续在线的云服务器运行 Hive，团队打开同一个 HTTPS 网页讨论、派活和收结果。Agent 留在各自电脑或运行在云上；**不必把所有人的项目和模型账号搬到云端**。

这适合受信团队，不是严格租户隔离的公共 SaaS。本文是 Linux 上手教程；完整参数和边界见[部署参考](/reference/deployment/)与[安全参考](/reference/security/)。npm 版本可能落后于源码，请先核对 `hive --version` 和实际界面。

![云端协作架构：浏览器经 HTTPS 访问 Hive Server；各自电脑或云上的 Agent 通过 Bridge 连接，项目和模型会话留在执行机器。原理示意，非截图。](/media/architecture/cloud-deployment.svg)

| 位置             | 保存什么                                       |
| ---------------- | ---------------------------------------------- |
| 云端 Hive Server | 房间、消息、邀请、任务记录、公共附件和共享配置 |
| Agent 所在机器   | Agent CLI、模型登录、项目、Git 和私有会话      |
| 浏览器           | 当前设备的登录身份，不是代码执行环境           |

## 1. 准备 Linux 服务器

需要持久磁盘、可用的 SSH 管理通道、指向服务器的域名（示例 `hive.example.com`），以及系统级 Node.js **22.12+** 和 npm。先检查 `node --version`、`npm --version`，确保服务用户也能找到它们，不依赖管理员个人的 nvm 路径。

防火墙和云安全组只放行必要的 SSH、80/443，**不要公开 8787**；SSH 尽量限制管理来源。创建无 sudo 权限的专用用户，安装到自己的 npm 前缀，不用 root 运行 Hive：

```bash
sudo useradd --system --user-group --create-home \
  --home-dir /var/lib/superhive --shell /bin/bash hive
sudo -u hive -H npm i -g --prefix /var/lib/superhive/.local superhive
sudo -u hive -H /var/lib/superhive/.local/bin/hive --version
```

已有同名用户时先核对，不重复创建或改动。本文使用 `HOME=/var/lib/superhive`，默认数据在 `/var/lib/superhive/.superhive/`；项目另放独立目录。临时试用可用 `npx --yes superhive@latest` 替代 `hive`，长期服务建议固定安装路径。Hive 不包含模型订阅，运行 Agent 的机器仍需安装并登录对应 CLI。

## 2. 验证启动，再用 systemd 常驻

先在服务器终端前台启动：

```bash
sudo -u hive -H /var/lib/superhive/.local/bin/hive \
  --host 127.0.0.1 --port 8787 \
  --public-url https://hive.example.com \
  --foreground --no-open
```

另开 SSH 终端运行 `curl --fail http://127.0.0.1:8787/health`，成功后在原终端按 Ctrl+C 正常停止。

- 默认 `hive` 后台启动，监听 `0.0.0.0:8787`；这里明确选择回环和前台。
- `--public-url` 决定对外网页、邀请和接入链接，不提供证书或改变监听地址。
- `--no-local-agents` 不阻止远程 `hive join`，但当前实现也关闭房主设备配对/管理入口，故本教程默认不启用它。完成配对后若选择关闭，新增或撤销设备前需在维护窗口重新开启本机能力。
- 首次自动生成并保存 Join Token，不用把 `--token` 写进服务文件。自定义 `--data-dir` 时，停止、重启和备份都要使用同一目录。

保存以下内容为 `/etc/systemd/system/superhive.service`，替换域名；Node 不在列出的 PATH 中时按实际调整：

```ini
[Unit]
Description=SuperHive collaboration server
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=hive
Group=hive
WorkingDirectory=/var/lib/superhive
Environment=HOME=/var/lib/superhive
Environment=PATH=/var/lib/superhive/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/var/lib/superhive/.local/bin/hive --host 127.0.0.1 --port 8787 --public-url https://hive.example.com --foreground --no-open
Restart=on-failure
RestartSec=5
TimeoutStopSec=120
UMask=0077

[Install]
WantedBy=multi-user.target
```

启用开机自启、查看状态与日志：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now superhive
sudo systemctl status superhive
sudo journalctl -u superhive -f
```

前台日志进 journal，普通 CLI 后台日志在数据目录的 `server.log`。退出 SSH 不停止 systemd。让 systemd 独占管理，**不要再运行另一份 `hive` 或开启 `hive autostart on`**。异常退出重启不等于高可用，仍要监控主机、磁盘和网络。

## 3. 配置 HTTPS 反向代理

以下选一种。示例不替你配置 DNS、云资源或证书；完成后访问 `https://hive.example.com`，确认没有证书警告。

### Caddy

安装 Caddy，在 Caddyfile 中配置并按它的服务方式重载：

```text
hive.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

域名正确解析且 80/443 可达时，Caddy 可自动申请、续期证书。`reverse_proxy` 支持 WebSocket 并传递来源信息；不要改写 Host 为 localhost 或删除转发来源头。

### Nginx

先取得证书；以下 `map` 和 `server` 都放在 `http` 上下文中，替换证书路径：

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    '' close;
}

server {
    listen 80;
    server_name hive.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name hive.example.com;
    ssl_certificate /etc/letsencrypt/live/hive.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/hive.example.com/privkey.pem;
    client_max_body_size 25m;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 3600s;
        proxy_buffering off;
    }
}
```

运行 `sudo nginx -t` 后重载。`25m` 只是代理上传上限示例，要与 Hive 附件限制和平台配额核对。必须代理整个服务，包括 `/ws`、API、`/mcp` 和附件，不只是首页。外层 CDN、网关或登录墙也要允许 Agent 认证与长连接。

## 4. 首次房主登录：通过 SSH 配对

公网新浏览器没有访问权，**打开网址不等于成为房主**。无桌面的服务器可用已有 SSH 管理通道配对，不用交出总令牌：

1. 在自己电脑运行并保持终端打开：

   ```bash
   ssh -N -L 127.0.0.1:18787:127.0.0.1:8787 admin@your-server
   ```

2. 浏览器打开 `http://127.0.0.1:18787`。这是加密 SSH 通道中的回环管理入口，不是公网裸 HTTP；不要绑定 `0.0.0.0` 或分享转发端口。
3. 左下角头像 →「在其他设备登录」→「显示登录二维码」。链接应指向 `https://hive.example.com`；仍是 localhost 时先修正 `--public-url` 再生成。
4. 在要使用的浏览器打开该 HTTPS 链接，或手机扫码。票 **5 分钟有效、只能兑换一次**；即使同一电脑，回环入口和公网域名也有不同浏览器身份。
5. 以后直接用 HTTPS 地址。同一弹窗可查看和退出设备；会话最长 30 天、闲置 7 天失效，届时重新配对。

![隔离演示中的房主设备登录入口，展示生成二维码前的按钮与设备列表；未生成或展示登录票、二维码或总令牌。](/media/interface/cloud-owner-login.png)

截图只展示配对入口，不含凭证。设备登录不自动授权管理云上进程；若开启本机 Agent，远程设备需申请管理权，由 SSH 回环房主页面或已获准的 IM 房主批准。管理权有效 12 小时，完全访问等高危动作另需单次批准。不要伪造代理头把公网用户当成本机房主。

## 5. 邀请团队成员

房主创建房间，在「成员」面板点「邀请成员」：

1. 选期限（默认 24 小时，可选有限期限或自定义）。
2. 核对直接调度 Agent 与执行过程可见性；默认调度房主 Agent 需要批准，过程默认可见。
3. 生成链接，私下发给预期参与者；成员打开、填显示名后加入该房间。
4. 成员列表可对单人续期或移除；邀请弹窗可对整个链接续期或撤销。

![隔离演示中的邀请设置，展示期限、Agent 调度和执行过程开关；尚未生成邀请链接。](/media/interface/cloud-invite-settings.png)

邀请有效期内可被多人兑换，不是一次性房主登录票。访客只访问受邀房间，不能创建房间或管理服务器；撤销整个链接影响凭它进入的所有访客及其 Agent。详见[房间与成员](/guides/rooms/)。

## 6. 接入 Agent：选择执行机器

### 各自电脑接入（推荐）

在 Agent 所在电脑安装 Node、superhive 和对应 Agent CLI，完成模型登录、准备项目。访客点「带入我的 Agent」，复制**自己的**接入命令，不借用房主 Join Token。

下例只展示参数，地址、名称、房间 ID、凭证和路径须换成真实值：

```bash
hive join --background \
  --server https://hive.example.com --room general \
  --name alice-codex --token YOUR_AGENT_TOKEN \
  --provider codex --access workspace --cwd /absolute/path/to/project
```

关终端仍在线，关机、睡眠或断网则不能正常工作。用 `hive agents` 查看、`hive leave alice-codex` 离线；日志在该电脑的 `~/.superhive/remote-joins/`。详见[接入 Agent](/guides/agents/)。

### 在云上运行

也可在云端专用用户环境安装、登录 CLI 并准备仓库，然后在云端运行同样的 `hive join --background`，`--cwd` 指向**云端真实目录**。不必开启网页本机启动；后台接入不是开机自启，需另行管理 Agent 生命周期。

若希望网页托管云上本机 Agent，在服务用户下安装、登录运行时，再通过 SSH 房主入口或获批设备使用「在本机启动」。本教程保留本机能力用于配对，但不会因为安装 Hive 就自动创建 Agent。“本机”指 **Server 所在云服务器**，不是浏览器所在电脑；若自行加了 `--no-local-agents`，先在空闲维护窗口移除该选项并重启。

:::caution[不自动同步文件或模型账号]
云端工作区不能让另一台电脑凭空拥有同一路径。各机器分别克隆仓库、通过 Git 等方式同步；命令接入还受 `--cwd` / `--allow-root` 的跟随范围限制。评审选 `read-only`，写代码按需选 `workspace`，不要为连上服务选 `full`。隔离能力因运行时而异，见[权限与审批](/guides/permissions/)。接入命令含凭证，不贴到房间、仓库或截图。
:::

## 7. 备份与升级

先约定空闲维护窗口，核对运行中任务与外部副作用。本文 systemd 服务用一致性备份和明确停启：

```bash
sudo systemctl stop superhive
sudo install -d -m 700 /var/backups/superhive
backup="/var/backups/superhive/hive-$(date +%Y%m%d-%H%M%S).tgz"
sudo tar -czf "$backup" -C /var/lib/superhive .superhive
sudo chmod 600 "$backup"
sudo -u hive -H env PATH=/var/lib/superhive/.local/bin:/usr/local/bin:/usr/bin:/bin \
  /var/lib/superhive/.local/bin/hive update
sudo systemctl start superhive
sudo systemctl status superhive
```

使用默认数据目录与同一安装用户。服务已停止，`hive update` 只安装新版，随后 systemd 启动。**不要在这份前台 systemd 服务运行时用 `hive update` / `hive restart` 替换进程**：CLI 会按自己的后台方式启动，可能与 systemd 争抢端口和生命周期。

普通 **CLI 后台管理**的实例可用 `hive update --check` 检查、`hive update` 更新、`hive restart` 重启。支持交接且监听配置、Token 等兼容时，本机 Agent 交给新 Server，任务继续；不能交接则询问等待或中断，脚本默认等待。`--force-restart` 会强制中断，不用于日常更新。**这不是 systemctl 重启、主机关机或崩溃也不中断的承诺**；远程 Agent 重连和恢复也需核对[任务指南](/guides/tasks/)。

完整数据目录含数据库、附件、认证与加密文件，应加密备份、限制访问，不公开上传。另行备份服务/代理配置，以及各 Agent 的项目、运行时登录和私有状态；Server 备份不包含其他机器文件。定期隔离演练恢复，见[部署参考](/reference/deployment/#数据与备份)。

## 上线前安全清单

- 公网只经 HTTPS 或可信 VPN，8787 回环监听，SSH 转发只绑定本机。
- 保留真实 Host、Origin 和来源；不禁用鉴权、不绕过本机检查。
- 成员用限时邀请，房主设备用一次性配对；Join Token 是跨房间高信任房主级凭据，`--room` 不会把它变成单房间令牌。
- Hive/Agent 不以 root 运行，只接入必需账号、目录和 MCP；完全访问可修改机器文件和调用外部服务，不给不受信任务。
- 验证双浏览器协作、WebSocket 重连、附件上传、访客撤销、远程 Agent 的实际 cwd 和权限。
- 监控磁盘、备份和费用。Hive 不是统一模型付费账户，费用发生在各 Agent 账号，统计可能不完整，见[用量与费用](/guides/usage/)。

## 常见问题

| 现象                            | 先检查                                                             |
| ------------------------------- | ------------------------------------------------------------------ |
| 网页能打开但没有访问权          | 用邀请或一次性房主配对登录，不公开总令牌                           |
| 二维码/邀请指向 localhost       | `--public-url` 与实际配置，修好后重新生成                          |
| 网页正常但 Agent 离线或频繁重连 | `/ws`、API、`/mcp` 代理，TLS、网关限制、Agent 日志与睡眠           |
| 远程房主没有启动按钮            | `--no-local-agents` 是否仍开启、管理权是否批准，不伪造本机请求     |
| Agent 看不到项目                | 执行机器、实际 cwd、仓库克隆和允许路径；云端不自动同步文件         |
| 开机后服务失败                  | journal 中的 Node/PATH、安装路径、端口占用、权限、磁盘空间         |
| 更新后端口冲突                  | 是否混用 systemd、CLI 后台和登录自启；核对来源，不按名字批量杀进程 |

示例仍需在你的 Linux、DNS、证书和云平台验证；隔离截图不证明真实公网部署已完成。
